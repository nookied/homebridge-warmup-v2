// Homebridge platform for Warmup Wi-Fi underfloor-heating thermostats.
// Supports the entire smart-thermostat range that pairs with my.warmup.com /
// the MyHeating app: 4iE, 6iE, 7iE Smart Matter, Element Wi-Fi, Terra Wi-Fi,
// plus rebadged OEM units (Laticrete, Rointe, Porcelanosa, Equus, Savant).
//
// Each Warmup "room" is exposed as a HomeKit Thermostat (primary) plus a
// paired TemperatureSensor for the air-temp probe.
//
// **Dynamic platform** (Homebridge persists accessories on disk; we register/
// unregister deltas at startup). The static `accessories(callback)` flow used
// up through v3.0.x is gone as of v3.1 (Roadmap M4) — required for Homebridge
// Verified Plugin status, plus it lets accessories survive a Warmup-cloud
// outage at boot and is the prerequisite for fakegato history (Roadmap M5).

'use strict';

const debug = require('debug')('warmup4ie');
const { Warmup4IE } = require('./lib/warmup4ie');
const { deriveCurrentHeatingState, deriveTargetHeatingState } = require('./lib/state');
const { version: PLUGIN_VERSION, name: PLUGIN_NAME } = require('../package.json');

const PLATFORM_NAME = 'warmup4ie';

const SLIDER_DEBOUNCE_MS = 300;
const DEFAULT_REFRESH_SECONDS = 60;
const MIN_REFRESH_SECONDS = 30;
const MAX_REFRESH_SECONDS = 600;
const DEFAULT_DURATION_MINUTES = 60;
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 1440;

let Service, Characteristic, HapStatusError, HAPStatus, PlatformAccessoryCtor, uuid;

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  HapStatusError = homebridge.hap.HapStatusError;
  HAPStatus = homebridge.hap.HAPStatus;
  PlatformAccessoryCtor = homebridge.platformAccessory;
  uuid = homebridge.hap.uuid;

  // Fourth arg `true` registers as a dynamic platform.
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, warmup4iePlatform, true);
};

function warmup4iePlatform(log, config = {}, api) {
  this.log = log;
  this.config = config;
  this.api = api;
  this.username = config.username;
  this.password = config.password;
  this.refresh = boundedInteger(config.refresh, DEFAULT_REFRESH_SECONDS, MIN_REFRESH_SECONDS, MAX_REFRESH_SECONDS);
  this.duration = boundedInteger(config.duration, DEFAULT_DURATION_MINUTES, MIN_DURATION_MINUTES, MAX_DURATION_MINUTES);

  // Runtime state — persists for the lifetime of this platform instance only.
  this.thermostats = null;
  // Map<UUID, PlatformAccessory> — populated by configureAccessory at startup
  // (cached) and by discoverDevices (live). Both old + new entries live here.
  this.accessories = new Map();
  // Map<UUID, Map<char-name, NodeJS.Timeout>> — per-accessory debounce timers.
  this._debouncers = new Map();
  this._pollTimer = null;

  if (api && typeof api.on === 'function') {
    // Wait for Homebridge to finish loading all cached accessories before
    // hitting the API to discover live ones — otherwise our register/
    // unregister deltas would fight Homebridge's restore step.
    api.on('didFinishLaunching', () => this.discoverDevices());
    api.on('shutdown', () => this.shutdown());
  }
}

warmup4iePlatform.prototype = {

  // Called by Homebridge for each accessory loaded from its on-disk cache.
  // We just stash the PlatformAccessory; service handlers get bound during
  // discoverDevices once we know what's still live on the Warmup side.
  configureAccessory: function (accessory) {
    debug('configureAccessory: restoring cached %s (%s)', accessory.displayName, accessory.UUID);
    this.accessories.set(accessory.UUID, accessory);
  },

  discoverDevices: function () {
    if (!hasRequiredConfig(this)) {
      this.log.error('Warmup4ie is not configured: username and password are required.');
      // Cached accessories stay registered (HomeKit shows them as "Not
      // Responding") — that's better than ripping them out of users' rooms
      // because of a transient config typo.
      return;
    }

    this.log.info('Logging into warmup4ie...');

    this.thermostats = new Warmup4IE(this, (err, rooms) => {
      if (err) {
        this.log.error('Warmup login/initial fetch failed:', err.message);
        // Keep cached accessories visible. We'll retry at next Homebridge
        // restart; in the meantime the polling loop is not started.
        this.thermostats = null;
        return;
      }

      this.log.info('Found %s room(s)', rooms.length);
      this.reconcileAccessories(rooms);
      this.startPolling();
    });
  },

  // Compute the desired set of accessories from `rooms`, then issue
  // register/unregister deltas to Homebridge so the on-disk cache + HomeKit
  // bridge match the Warmup account.
  reconcileAccessories: function (rooms) {
    const seen = new Set();
    const toRegister = [];

    rooms.forEach((room) => {
      const accessoryUuid = uuidForRoom(room.roomId);
      seen.add(accessoryUuid);

      let accessory = this.accessories.get(accessoryUuid);
      if (accessory) {
        debug('Restoring services on cached accessory: %s', room.roomName);
        // Display name might have changed in the Warmup app; refresh.
        accessory.displayName = room.roomName;
        attachAccessoryServices(this, accessory, room);
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info('Adding %s', room.roomName);
        accessory = new PlatformAccessoryCtor(room.roomName, accessoryUuid);
        attachAccessoryServices(this, accessory, room);
        this.accessories.set(accessoryUuid, accessory);
        toRegister.push(accessory);
      }
    });

    if (toRegister.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister);
    }

    // Unregister cached accessories that are no longer in the Warmup account.
    const stale = [];
    for (const [accUuid, accessory] of this.accessories) {
      if (!seen.has(accUuid)) {
        this.log.info('Removing stale accessory: %s', accessory.displayName);
        stale.push(accessory);
        this.accessories.delete(accUuid);
        this._debouncers.delete(accUuid);
      }
    }
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  },

  startPolling: function () {
    this.shutdown();
    this._pollTimer = setInterval(async () => {
      try {
        if (!this.thermostats) return;
        const rooms = await this.thermostats.getStatus();
        rooms.forEach((room) => updateAccessoryState(this, room));
      } catch (err) {
        this.log.error('Warmup poll failed:', err.message);
      }
    }, this.refresh * 1000);
  },

  shutdown: function () {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    // Cancel any pending debounce timers — they hold references to the
    // accessory and would otherwise fire after Homebridge has shut down.
    for (const perAcc of this._debouncers.values()) {
      for (const timer of perAcc.values()) clearTimeout(timer);
    }
    this._debouncers.clear();
  }
};

// ---------------------------------------------------------------------------
// Accessory shape — idempotent service setup that handles both fresh and
// cached PlatformAccessory objects.
// ---------------------------------------------------------------------------

function attachAccessoryServices(platform, accessory, room) {
  // AccessoryInformation
  const info = accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
  info
    .setCharacteristic(Characteristic.Manufacturer, 'Warmup')
    // Generic label that's accurate for any model in the supported range.
    // The Warmup GraphQL schema exposes per-device fields (`appFw`,
    // `wifiFw`, `deviceSN`) on `Thermostat4iE` — surfacing them as the
    // real Model/FirmwareRevision is queued for Roadmap M6.
    .setCharacteristic(Characteristic.Model, 'Wi-Fi Thermostat')
    // Stable serial: roomId is unique per Warmup account, survives host moves
    // and matches the UUID derivation seed.
    .setCharacteristic(Characteristic.SerialNumber, `warmup4ie-${room.roomId}`)
    .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);

  // TemperatureSensor — the air-temp probe.
  // Set the service Name only on first add so we don't overwrite a user's
  // rename in Apple Home on subsequent restarts.
  let tempService = accessory.getService(Service.TemperatureSensor);
  if (!tempService) {
    tempService = accessory.addService(Service.TemperatureSensor, `${room.roomName} Air`);
  }
  tempService.getCharacteristic(Characteristic.CurrentTemperature)
    .setProps({ minValue: -100, maxValue: 100 });

  // Thermostat (primary).
  let thermo = accessory.getService(Service.Thermostat);
  if (!thermo) {
    thermo = accessory.addService(Service.Thermostat, room.roomName);
  }
  if (typeof thermo.setPrimaryService === 'function') {
    thermo.setPrimaryService(true);
  } else {
    thermo.isPrimaryService = true;
  }

  thermo.getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .setProps({ validValues: [0, 1, 3] })
    .onSet((value) => handleTargetHeatingCoolingSet(platform, accessory, value));

  thermo.getCharacteristic(Characteristic.TargetTemperature)
    .setProps({ minValue: room.minTemp / 10, maxValue: room.maxTemp / 10 })
    .onSet((value) => handleTargetTemperatureSet(platform, accessory, value));

  thermo.getCharacteristic(Characteristic.CurrentTemperature)
    .setProps({ minValue: -100, maxValue: 100 });

  // Initial state push.
  accessory.context.roomId = room.roomId;
  accessory.context.room = room;
  pushRoomState(accessory, room);

  debug('attachAccessoryServices for %s done', room.roomName);
}

// ---------------------------------------------------------------------------
// Polling — refresh characteristic values and per-accessory snapshot.
// ---------------------------------------------------------------------------

function updateAccessoryState(platform, room) {
  const accessory = platform.accessories.get(uuidForRoom(room.roomId));
  if (!accessory) return;
  accessory.context.room = room;
  pushRoomState(accessory, room);
}

function pushRoomState(accessory, room) {
  const thermo = accessory.getService(Service.Thermostat);
  const temp = accessory.getService(Service.TemperatureSensor);
  if (!thermo || !temp) return;

  thermo.getCharacteristic(Characteristic.TargetTemperature)
    .updateValue(Number(effectiveTargetTemp(room) / 10));
  thermo.getCharacteristic(Characteristic.CurrentTemperature)
    .updateValue(Number(room.currentTemp / 10));
  thermo.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .updateValue(deriveCurrentHeatingState(room));
  thermo.getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .updateValue(deriveTargetHeatingState(room));
  temp.getCharacteristic(Characteristic.CurrentTemperature)
    .updateValue(Number(room.airTemp / 10));
}

// ---------------------------------------------------------------------------
// Set handlers — closures bound at attach time so they have access to the
// platform (for thermostats client + debouncer registry) and accessory.
// ---------------------------------------------------------------------------

async function handleTargetHeatingCoolingSet(platform, accessory, value) {
  const room = accessory.context.room || {};
  platform.log.debug('Set HeatingCoolingState for %s → %s', accessory.displayName, value);
  try {
    switch (value) {
      case 0: // Off — per-room since v3 (was location-wide in v2 due to API limit)
        await platform.thermostats.setRoomOff(accessory.context.roomId);
        break;
      case 1: // Heat — keep override/fixed if already set, otherwise resume schedule
        if (room.runMode === 'fixed' || room.runMode === 'override') return;
        await platform.thermostats.setRoomAuto(accessory.context.roomId);
        break;
      case 3: // Auto
        await platform.thermostats.setRoomAuto(accessory.context.roomId);
        break;
    }
  } catch (err) {
    platform.log.error('Set HeatingCoolingState for %s failed: %s', accessory.displayName, err.message);
    throw asHapStatusError(err);
  }
}

function handleTargetTemperatureSet(platform, accessory, value) {
  platform.log.debug('Set TargetTemperature for %s → %s°', accessory.displayName, value);

  // Trailing-edge debounce per accessory + characteristic.
  const debouncers = getDebouncers(platform, accessory);
  const existing = debouncers.get('targetTemp');
  if (existing) clearTimeout(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      debouncers.delete('targetTemp');
      try {
        await platform.thermostats.setTargetTemperature(accessory.context.roomId, value);
        resolve();
      } catch (err) {
        platform.log.error('Set TargetTemperature for %s failed: %s', accessory.displayName, err.message);
        reject(asHapStatusError(err));
      }
    }, SLIDER_DEBOUNCE_MS);
    debouncers.set('targetTemp', timer);
  });
}

function getDebouncers(platform, accessory) {
  let perAcc = platform._debouncers.get(accessory.UUID);
  if (!perAcc) {
    perAcc = new Map();
    platform._debouncers.set(accessory.UUID, perAcc);
  }
  return perAcc;
}

// Map a Warmup error to an HAP status code. Coarse but better than the
// generic "Service Communication Failure" that a plain Error produces.
function asHapStatusError(err) {
  const msg = err && err.message ? err.message : '';
  if (msg.startsWith('Warmup network error') || msg.includes('aborted') || msg.includes('timeout')) {
    return new HapStatusError(HAPStatus.OPERATION_TIMED_OUT);
  }
  if (msg.startsWith('Warmup HTTP 4')) {
    return new HapStatusError(HAPStatus.INSUFFICIENT_AUTHORIZATION);
  }
  return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function hasRequiredConfig(platform) {
  return typeof platform.username === 'string' &&
    platform.username.trim().length > 0 &&
    typeof platform.password === 'string' &&
    platform.password.length > 0;
}

// Warmup's API can return targetTemp below the device's configured minimum
// (e.g. just after switching modes); HomeKit rejects values out of the
// characteristic's [minTemp, maxTemp] range, so clamp.
function effectiveTargetTemp(room) {
  return room.targetTemp > room.minTemp ? room.targetTemp : room.minTemp;
}

function uuidForRoom(roomId) {
  return uuid.generate(`warmup4ie:${roomId}`);
}
