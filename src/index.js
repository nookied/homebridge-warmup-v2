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
let FakeGatoHistoryService;
// Eve custom characteristic: "Total Consumption" (cumulative kWh). Lives on
// the Thermostat service; Eve.app reads the well-known UUID for energy
// graphs. Class is defined at module init once HAP types are bound.
let EveTotalConsumption;
const EVE_TOTAL_CONSUMPTION_UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  HapStatusError = homebridge.hap.HapStatusError;
  HAPStatus = homebridge.hap.HAPStatus;
  PlatformAccessoryCtor = homebridge.platformAccessory;
  uuid = homebridge.hap.uuid;

  // Define the Eve.Energy.TotalConsumption custom characteristic. The UUID
  // is well-known and shared across Eve-aware Homebridge plugins; Eve.app
  // reads anything with this UUID as a "Total Consumption" series.
  // Wrapped in try/catch so a non-class `Characteristic` (e.g. a stripped
  // HAP shim in testing, or a hypothetical HAP-NodeJS API change) doesn't
  // kill the plugin — energy graphs are nice-to-have, not critical.
  try {
    EveTotalConsumption = class extends Characteristic {
      constructor() {
        super('Total Consumption', EVE_TOTAL_CONSUMPTION_UUID);
        this.setProps({
          format: Characteristic.Formats.UINT32,
          unit: 'kWh',
          minValue: 0,
          maxValue: 4294967295,
          minStep: 1,
          perms: [Characteristic.Perms.PAIRED_READ, Characteristic.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
      }
    };
    EveTotalConsumption.UUID = EVE_TOTAL_CONSUMPTION_UUID;
  } catch (ex) {
    EveTotalConsumption = null;
    debug('Eve TotalConsumption characteristic unavailable: %s', ex.message);
  }

  // fakegato-history is initialised once per Homebridge process — the
  // module export is `(homebridge) => FakeGatoHistoryService` (a class
  // bound to the homebridge instance's HAP types). Loading is wrapped
  // in try/catch so a hypothetical fakegato breakage doesn't kill the
  // plugin — temperature/heating-state graphs are nice-to-have.
  try {
    FakeGatoHistoryService = require('fakegato-history')(homebridge);
  } catch (ex) {
    FakeGatoHistoryService = null;
    debug('fakegato-history unavailable: %s', ex.message);
  }

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
    // Defensive: an empty rooms array is *probably* a transient Warmup
    // hiccup (the user didn't actually delete every thermostat). Skip
    // unregistering cached accessories — they'll show "Not Responding"
    // until the next poll, but we don't rip their HomeKit tiles out of
    // rooms / scenes / automations on a glitch.
    if (rooms.length === 0 && this.accessories.size > 0) {
      this.log.warn('Warmup returned 0 rooms but %s cached accessories exist — keeping cache untouched', this.accessories.size);
      return;
    }

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
    // Generic label — Warmup's GraphQL schema doesn't carry a reliable
    // marketing model name across all supported devices. The (i) info card
    // shows this; users with a 4iE/6iE/7iE/Element/Terra all see the same
    // generic label. Acceptable trade-off until we find a reliable source.
    .setCharacteristic(Characteristic.Model, 'Wi-Fi Thermostat')
    // Stable serial: roomId is unique per Warmup account, survives host moves
    // and matches the UUID derivation seed.
    .setCharacteristic(Characteristic.SerialNumber, `warmup4ie-${room.roomId}`)
    // Real device firmware from `appFw` when valid (HAP requires
    // `N{1,9}(.N{1,9}){0,2}` SemVer-ish); falls back to plugin version.
    .setCharacteristic(Characteristic.FirmwareRevision, deriveFirmwareRevision(room));

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

  // RemainingDuration default range is 0–3600 (1 h); Warmup overrides can
  // run up to 24 h (`MAX_DURATION_MINUTES`). Widen the range so HomeKit
  // doesn't clamp the value mid-override.
  thermo.getCharacteristic(Characteristic.RemainingDuration)
    .setProps({ minValue: 0, maxValue: MAX_DURATION_MINUTES * 60 });

  // Eve.Energy.TotalConsumption — cumulative kWh shown in Eve.app's
  // long-term energy graph. The custom characteristic is auto-added on
  // first updateValue, but adding it explicitly here makes it visible
  // even before the first poll.
  if (EveTotalConsumption && !thermo.testCharacteristic(EveTotalConsumption)) {
    thermo.addCharacteristic(EveTotalConsumption);
  }

  // Eve / fakegato history graphs (Roadmap M5).
  // The 'thermo' history type records currentTemp + setTemp + valvePosition
  // every poll; Eve.app renders the result. We disable fakegato's auto-timer
  // and call addEntry from pushRoomState ourselves, so history aligns with
  // actual data freshness rather than running on a separate clock.
  // The wrapper instance is in-memory only (re-created per restart) but
  // fakegato persists the history JSON to disk independently — see
  // `~/.homebridge/persist/history_*.json`.
  if (FakeGatoHistoryService && !accessory.historyService) {
    accessory.historyService = new FakeGatoHistoryService('thermo', accessory, {
      storage: 'fs',
      path: platform.api && platform.api.user && typeof platform.api.user.storagePath === 'function'
        ? platform.api.user.storagePath()
        : undefined,
      disableTimer: true
    });
  }

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

  const currentTempC = Number(room.currentTemp / 10);
  const setTempC = Number(effectiveTargetTemp(room) / 10);
  const heatingState = deriveCurrentHeatingState(room);

  thermo.getCharacteristic(Characteristic.TargetTemperature)
    .updateValue(setTempC);
  thermo.getCharacteristic(Characteristic.CurrentTemperature)
    .updateValue(currentTempC);
  thermo.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .updateValue(heatingState);
  thermo.getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .updateValue(deriveTargetHeatingState(room));
  // StatusFault: NO_FAULT (0) when sensors look fine, GENERAL_FAULT (1)
  // when any of the per-thermostat fault flags is set. Calling
  // .getCharacteristic on an optional characteristic auto-adds it.
  thermo.getCharacteristic(Characteristic.StatusFault)
    .updateValue(deriveStatusFault(room));
  // StatusActive: false ("Not Responding") if the device hasn't checked in
  // recently. Warmup's `lastPoll` is minutes since last contact.
  thermo.getCharacteristic(Characteristic.StatusActive)
    .updateValue(deriveStatusActive(room));
  // RemainingDuration: how long an override has left, in seconds. HomeKit
  // surfaces this as a countdown on the thermostat tile in some clients.
  thermo.getCharacteristic(Characteristic.RemainingDuration)
    .updateValue(deriveRemainingDuration(room));
  // Eve.Energy.TotalConsumption: cumulative kWh from Warmup's `total` field.
  if (EveTotalConsumption) {
    thermo.getCharacteristic(EveTotalConsumption)
      .updateValue(deriveTotalConsumption(room));
  }
  temp.getCharacteristic(Characteristic.CurrentTemperature)
    .updateValue(Number(room.airTemp / 10));

  // Record a history entry for Eve. valvePosition is synthesized — Warmup
  // doesn't expose actual valve % via the cloud API, so we use the heating
  // state as a proxy (100 = relay on, 0 = idle).
  if (accessory.historyService && typeof accessory.historyService.addEntry === 'function') {
    accessory.historyService.addEntry({
      time: Math.floor(Date.now() / 1000),
      currentTemp: currentTempC,
      setTemp: setTempC,
      valvePosition: heatingState === 1 ? 100 : 0
    });
  }
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

// HAP StatusFault: NO_FAULT (0) | GENERAL_FAULT (1). Surfaces sensor
// disconnects (air or floor probes) so the user gets a visible "fault" badge
// in HomeKit's accessory diagnostics rather than mysterious wrong readings.
function deriveStatusFault(room) {
  const anyFault = room.isFaultAir || room.isFaultFloor1 || room.isFaultFloor2;
  return anyFault ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT;
}

// HAP StatusActive: boolean. False = HomeKit shows "Not Responding". Warmup's
// `lastPoll` is minutes since the device last checked in; >20 min = stale.
// If the field is missing (older fork or partial response), we err on the
// side of "active" — better than a stale device showing as Not Responding
// when it's actually fine but the API didn't include lastPoll.
const STALE_LAST_POLL_MIN = 20;
function deriveStatusActive(room) {
  if (typeof room.lastPoll !== 'number') return true;
  return room.lastPoll <= STALE_LAST_POLL_MIN;
}

// HAP RemainingDuration: seconds (uint32). Warmup's `overrideDur` is in
// minutes; convert. Defaults to 0 when no override active.
function deriveRemainingDuration(room) {
  return Math.max(0, Math.round(((room.overrideDur || 0) * 60)));
}

// HAP requires FirmwareRevision to look like 1, 1.2, or 1.2.3 (each segment
// up to 9 digits) — anything else fails validation and the accessory may
// fail to publish. Warmup's `appFw` is "29.175"-ish in practice; validate
// before using, fall back to plugin version on anything weird.
const SEMVER_LIKE = /^\d{1,9}(\.\d{1,9}){0,2}$/;
function deriveFirmwareRevision(room) {
  const fw = room && room.appFw && String(room.appFw).trim();
  if (fw && SEMVER_LIKE.test(fw)) return fw;
  return PLUGIN_VERSION;
}

// Eve.Energy.TotalConsumption: cumulative kWh, monotonically increasing.
// Warmup's `total` is the closest match (`energy` is today-only and resets
// daily, which would make Eve's graph look bizarre). UINT32 expected;
// defensive cast in case the API ever returns a string.
function deriveTotalConsumption(room) {
  const total = Number(room && room.total);
  return Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0;
}

function uuidForRoom(roomId) {
  return uuid.generate(`warmup4ie:${roomId}`);
}
