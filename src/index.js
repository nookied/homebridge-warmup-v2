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
const { deriveFirmwareRevision, deriveTotalConsumption } = require('./lib/metadata');
const { resolveFormats, resolvePerms } = require('./lib/hap-compat');
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
// Captured at plugin init so the deferred fakegato load can still bind to the
// Homebridge instance's HAP types.
let homebridgeRef = null;
let fakeGatoLoadAttempted = false;
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

  // HAP Formats/Perms enums have moved around across HAP-NodeJS versions.
  // Resolve them through a small compat layer that falls back to the HAP
  // wire-format spec strings — see src/lib/hap-compat.js for the why.
  const Formats = resolveFormats(homebridge);
  const Perms = resolvePerms(homebridge);

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
        // FLOAT, not UINT32 — Eve.app and other Eve-aware HomeKit plugins
        // (homebridge-eve-thermo, homebridge-fakegato-history-eve, etc.) all
        // publish kWh as a fractional float so partial-kWh values render on
        // the long-term graph. UINT32 with `minStep: 1` would round 0.42 kWh
        // to 0 every poll, making the graph plateau until a full kWh ticks
        // over.
        this.setProps({
          format: Formats.FLOAT,
          unit: 'kWh',
          minValue: 0,
          maxValue: 1000000000,
          perms: [Perms.PAIRED_READ, Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
      }
    };
    EveTotalConsumption.UUID = EVE_TOTAL_CONSUMPTION_UUID;
  } catch (ex) {
    EveTotalConsumption = null;
    debug('Eve TotalConsumption characteristic unavailable: %s', ex.message);
  }

  // fakegato-history is NOT required here — see loadFakeGatoHistory() for
  // why the load is deferred until we know whether any platform actually
  // wants Eve history.
  homebridgeRef = homebridge;

  // Fourth arg `true` registers as a dynamic platform.
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, warmup4iePlatform, true);
};

// Load the Eve history service on first actual use, once per process.
//
// `fakegato-history` is vendored at src/vendor/fakegato-history rather than
// installed from npm: upstream declares `googleapis` as a hard dependency for
// a Google Drive backend this plugin never selects, and required it at module
// load — ~207 MB on disk, ~115 MB RSS and ~800 ms of startup for every user,
// typically on a Raspberry Pi. The vendored copy has that backend removed and
// pulls in nothing but Node builtins. See src/vendor/fakegato-history/README.md.
//
// The load stays deferred anyway, so `disableHistory` skips it entirely: the
// remaining cost is small but not nothing, and users who do not run Eve.app
// have no reason to pay it.
//
// The module export is `(homebridge) => FakeGatoHistoryService` — a class
// bound to the Homebridge instance's HAP types. Wrapped in try/catch so a
// breakage here degrades to "no graphs" rather than killing the plugin.
function loadFakeGatoHistory() {
  if (fakeGatoLoadAttempted) return FakeGatoHistoryService;
  fakeGatoLoadAttempted = true;
  try {
    FakeGatoHistoryService = require('./vendor/fakegato-history/fakegato-history')(homebridgeRef);
  } catch (ex) {
    FakeGatoHistoryService = null;
    debug('fakegato-history unavailable: %s', ex.message);
  }
  return FakeGatoHistoryService;
}

function warmup4iePlatform(log, config = {}, api) {
  this.log = log;
  this.config = config;
  this.api = api;
  this.username = config.username;
  this.password = config.password;
  this.refresh = boundedInteger(config.refresh, DEFAULT_REFRESH_SECONDS, MIN_REFRESH_SECONDS, MAX_REFRESH_SECONDS);
  this.duration = boundedInteger(config.duration, DEFAULT_DURATION_MINUTES, MIN_DURATION_MINUTES, MAX_DURATION_MINUTES);
  // Feature toggles. Each defaults to enabled (false). Setting any of
  // these to `true` in config.json hides the corresponding HomeKit
  // accessory and removes it from cached state on next launch — useful
  // when the device model doesn't actually honour the mutation (e.g. the
  // Warmup Element ignores `deviceAdvanced.lock`) or the user simply
  // doesn't want the extra tile.
  this.disableChildLock = Boolean(config.disableChildLock);
  this.disableVacationSwitch = Boolean(config.disableVacationSwitch);
  this.disableFrostSwitch = Boolean(config.disableFrostSwitch);
  // When enabled, the standalone `Service.TemperatureSensor` (the "<name>
  // Air" tile) is not created — the air-temp reading is still surfaced
  // via the Thermostat's `CurrentTemperature` characteristic, which is
  // what most users actually want. Recommended when the device runs in
  // air-sensor mode (Thermostat.CurrentTemperature already equals the
  // air reading); leave disabled if the device runs in floor-sensor
  // mode (Thermostat.CurrentTemperature is the floor reading then, and
  // the standalone air-temp tile is the only way to see air temp).
  this.disableAirSensor = Boolean(config.disableAirSensor);
  // Skips the per-thermostat Eve history service entirely — and, because the
  // load is deferred, avoids pulling `fakegato-history` (and the googleapis
  // client it drags in) into the Homebridge process at all. Worth roughly
  // 65 MB of RSS per Homebridge process, measured on a Pi 5; see
  // loadFakeGatoHistory(). Only affects Eve.app's temperature/heating graphs
  // — every HomeKit characteristic behaves identically either way.
  this.disableHistory = Boolean(config.disableHistory);

  // Runtime state — persists for the lifetime of this platform instance only.
  this.thermostats = null;
  // Map<UUID, PlatformAccessory> — populated by configureAccessory at startup
  // (cached) and by discoverDevices (live). Both old + new entries live here.
  this.accessories = new Map();
  // Map<UUID, Map<char-name, PendingDebounce>> — per-accessory debounce state.
  this._debouncers = new Map();
  // Map<UUID, Promise> — tail of the serialized cloud-write chain for each
  // accessory. See enqueueAccessoryWrite: without it two writes for the same
  // room can be in flight simultaneously and land out of order.
  this._writeChains = new Map();
  this._pollTimer = null;
  // Guards against setInterval stacking a second poll on top of a slow one.
  this._pollInFlight = false;

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
      logSensorModes(this, rooms);
      this.reconcileAccessories(rooms);
      this.reconcileLocationAccessories();
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
    // Skip location-mode switches — they're managed by reconcileLocationAccessories
    // and aren't tied to any individual room.
    const stale = [];
    for (const [accUuid, accessory] of this.accessories) {
      if (isLocationAccessory(accessory)) continue;
      if (!seen.has(accUuid)) {
        this.log.info('Removing stale accessory: %s', accessory.displayName);
        stale.push(accessory);
        this.accessories.delete(accUuid);
        this._debouncers.delete(accUuid);
        this._writeChains.delete(accUuid);
      }
    }
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  },

  // Add location-wide HomeKit Switches (Vacation Mode, Frost Protection)
  // for this account. Idempotent: refreshes services on cached versions,
  // registers new ones the first time we see this locId.
  reconcileLocationAccessories: function () {
    const locId = this.thermostats && this.thermostats._locId;
    if (locId == null) return;

    const enabled = activeLocationSwitches(this);
    removeStaleLocationAccessories(this, locId, enabled);
    enabled.forEach((spec) => {
      ensureLocationSwitch(this, locId, spec);
    });
  },

  startPolling: function () {
    this.shutdown();
    this._pollTimer = setInterval(async () => {
      // Skip this tick if the previous poll is still running. A poll can take
      // up to three requests (initial → re-auth → retry) at REQUEST_TIMEOUT_MS
      // each, which since the 20 s timeout can exceed
      // MIN_REFRESH_SECONDS. Without this, setInterval would stack a second
      // poll on top of a slow one: both would rewrite the room cache and push
      // characteristics, wasting requests against an API we already know to
      // be struggling at that moment.
      if (this._pollInFlight) {
        this.log.debug('Skipping poll — previous one still in flight');
        return;
      }
      this._pollInFlight = true;
      try {
        if (!this.thermostats) return;
        const rooms = await this.thermostats.getStatus();
        // Rooms can be added or removed in the MyHeating app while Homebridge
        // is running. Discovery used to run only at `didFinishLaunching`, so
        // neither reached HomeKit until a restart.
        //
        // Only reconcile when the room set actually differs: reconciling
        // re-attaches every service and calls `updatePlatformAccessories`,
        // which makes Homebridge rewrite its on-disk accessory cache. Doing
        // that on every tick would be constant disk churn on a Pi's SD card
        // for no benefit.
        if (roomSetChanged(this, rooms)) {
          this.log.info('Warmup room list changed — reconciling accessories');
          this.reconcileAccessories(rooms);
        }
        rooms.forEach((room) => updateAccessoryState(this, room));
        pushLocationSwitchStates(this);
      } catch (err) {
        this.log.error('Warmup poll failed:', err.message);
      } finally {
        // `finally`, not the end of `try` — the early `return` when
        // `thermostats` is null and any throw must both clear the flag, or
        // one failure would wedge polling permanently.
        this._pollInFlight = false;
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
      for (const pending of perAcc.values()) {
        const timer = pending && typeof pending === 'object' ? pending.timer : pending;
        if (timer) clearTimeout(timer);
        if (pending && typeof pending.reject === 'function') {
          pending.reject(notReadyError());
        }
      }
    }
    this._debouncers.clear();
    this._writeChains.clear();
    this._pollInFlight = false;
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
    .setCharacteristic(Characteristic.FirmwareRevision, deriveFirmwareRevision(room, PLUGIN_VERSION));

  // Thermostat (primary). Added before the TemperatureSensor so iOS Home
  // honours service insertion order in the accessory detail view — the
  // thermostat tile renders to the left of the air sensor instead of after it.
  let thermo = accessory.getService(Service.Thermostat);
  if (!thermo) {
    thermo = accessory.addService(Service.Thermostat, room.roomName);
  }
  if (typeof thermo.setPrimaryService === 'function') {
    thermo.setPrimaryService(true);
  } else {
    thermo.isPrimaryService = true;
  }

  // TemperatureSensor — the air-temp probe.
  // Skipped when `disableAirSensor` is set; the air reading is still on
  // the Thermostat's CurrentTemperature characteristic, so this only
  // hides the redundant "<name> Air" tile in HomeKit. Any previously-
  // attached TemperatureSensor on a cached accessory is removed so the
  // Home tile disappears on next reconcile.
  if (platform.disableAirSensor) {
    const existingTemp = accessory.getService(Service.TemperatureSensor);
    if (existingTemp) {
      // Unlink before removing in case a v3.10.3 accessory still has the
      // legacy link in its persisted state — leaves no dangling refs.
      unlinkTempFromThermo(thermo, existingTemp);
      accessory.removeService(existingTemp);
    }
  } else {
    // The tile shows whichever reading the Thermostat is NOT showing, named
    // from the device's own word for it — see secondaryReadingLabel().
    //
    // Backwards-compatible by construction. Where no second probe is fitted
    // (the common case) `secondaryTemp` is null, we fall back to `airTemp`
    // and the label stays "Air" — byte-for-byte the old behaviour, so no
    // existing tile changes or vanishes from a HomeKit scene. Only an
    // air-mode device that genuinely has a floor probe sees a difference:
    // a tile that used to duplicate the Thermostat now shows floor temp.
    const label = secondaryReadingLabel(room);
    let tempService = accessory.getService(Service.TemperatureSensor);
    // If the reading's meaning changed (Air → Floor), the persisted service
    // name is now a lie. Recreate so it picks up the new one. That costs any
    // manual rename the user made, which is the lesser evil against a tile
    // labelled "Air" reporting floor temperature.
    if (tempService && accessory.context.secondaryLabel && accessory.context.secondaryLabel !== label) {
      platform.log.info(
        '%s: temperature sensor now reports %s (was %s) — recreating the tile so its name matches',
        room.roomName, label, accessory.context.secondaryLabel
      );
      unlinkTempFromThermo(thermo, tempService);
      accessory.removeService(tempService);
      tempService = null;
    }
    accessory.context.secondaryLabel = label;
    // Set the service Name only on first add so we don't overwrite a user's
    // rename in Apple Home on subsequent restarts.
    if (!tempService) {
      tempService = accessory.addService(Service.TemperatureSensor, `${room.roomName} ${label}`);
    }
    tempService.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -100, maxValue: 100 });
    // v3.10.3 linked the air sensor under the thermostat via
    // `thermo.addLinkedService(tempService)` to nest it as a sub-component
    // in Apple Home. v3.10.4 reverts that — real-device testing showed iOS
    // Home then refused to rename the accessory ("Could not change
    // settings"), apparently because the link altered the accessory shape
    // post-pairing in a way the Home app dislikes. We actively unlink any
    // previously-added link so cached accessories from v3.10.3 get cleaned
    // up on next save, not just newly-attached ones.
    unlinkTempFromThermo(thermo, tempService);
  }

  thermo.getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .setProps({ validValues: [0, 1, 3] })
    .onSet((value) => handleTargetHeatingCoolingSet(platform, accessory, value));

  // Only narrow the bounds when the device actually reported a sane range.
  // `normalizeRoom` already defaults a missing range, so this is belt-and-
  // braces against an inverted or non-numeric one — HAP throws on NaN bounds
  // and on minValue >= maxValue, which would take the accessory down.
  const targetTempChar = thermo.getCharacteristic(Characteristic.TargetTemperature);
  const minC = room.minTemp / 10;
  const maxC = room.maxTemp / 10;
  if (Number.isFinite(minC) && Number.isFinite(maxC) && minC < maxC) {
    targetTempChar.setProps({ minValue: minC, maxValue: maxC });
  } else {
    platform.log.warn(
      '%s reported an unusable temperature range (min %s, max %s) — leaving HomeKit defaults in place',
      room.roomName, room.minTemp, room.maxTemp
    );
  }
  targetTempChar.onSet((value) => handleTargetTemperatureSet(platform, accessory, value));

  thermo.getCharacteristic(Characteristic.CurrentTemperature)
    .setProps({ minValue: -100, maxValue: 100 });

  // RemainingDuration default range is 0–3600 (1 h); Warmup overrides can
  // run up to 24 h (`MAX_DURATION_MINUTES`). Widen the range so HomeKit
  // doesn't clamp the value mid-override.
  thermo.getCharacteristic(Characteristic.RemainingDuration)
    .setProps({ minValue: 0, maxValue: MAX_DURATION_MINUTES * 60 });

  // Child lock: `Service.LockMechanism` paired with the Thermostat. UNLOCKED
  // = touch screen accepts input, LOCKED = display is read-only on the
  // device. Mapped to the `parameters.lock` boolean we get from GraphQL.
  // Skipped when `disableChildLock` is set — useful for models like the
  // Warmup Element that don't honour the `deviceAdvanced.lock` mutation.
  // If a previous launch attached the service, remove it on restart so the
  // tile disappears from HomeKit instead of lingering as a no-op.
  if (platform.disableChildLock) {
    const existingLock = accessory.getService(Service.LockMechanism);
    if (existingLock) accessory.removeService(existingLock);
  } else {
    let lockService = accessory.getService(Service.LockMechanism);
    if (!lockService) {
      lockService = accessory.addService(Service.LockMechanism, `${room.roomName} Lock`);
    }
    lockService.getCharacteristic(Characteristic.LockTargetState)
      .onSet((value) => handleChildLockSet(platform, accessory, value));
    // Group the lock under the thermostat in Apple Home (one tile, expandable
    // into "+ Lock"). Without this they show as two separate tiles in the room.
    // `addLinkedService` is idempotent — safe to call on cached accessories.
    if (typeof thermo.addLinkedService === 'function') {
      thermo.addLinkedService(lockService);
    }
  }

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
  // `disableHistory` is checked before loadFakeGatoHistory() so the module —
  // and the googleapis client it pulls in — is never required at all.
  if (!platform.disableHistory && !accessory.historyService) {
    const HistoryService = loadFakeGatoHistory();
    if (HistoryService) {
      accessory.historyService = new HistoryService('thermo', accessory, {
        storage: 'fs',
        path: platform.api && platform.api.user && typeof platform.api.user.storagePath === 'function'
          ? platform.api.user.storagePath()
          : undefined,
        disableTimer: true
      });
    }
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
  // `temp` is optional — when `disableAirSensor` is set, the standalone
  // TemperatureSensor service is intentionally absent. Treat its writes
  // as no-ops in that case rather than early-returning the whole push.
  const temp = accessory.getService(Service.TemperatureSensor);
  if (!thermo) return;

  const currentTempC = toCelsius(room.currentTemp);
  const setTempC = toCelsius(effectiveTargetTemp(room));
  const heatingState = deriveCurrentHeatingState(room);

  // Skip rather than push NaN: HAP rejects non-finite values outright, and a
  // substituted 0 °C would show in HomeKit as a genuine reading.
  updateIfFinite(thermo, Characteristic.TargetTemperature, setTempC);
  updateIfFinite(thermo, Characteristic.CurrentTemperature, currentTempC);
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
  // `null` means "not reported this poll" — skip so the cumulative series
  // keeps its last value instead of dropping to the origin.
  if (EveTotalConsumption) {
    updateIfFinite(thermo, EveTotalConsumption, deriveTotalConsumption(room));
  }

  // Child lock state: only update if the lock service exists (it may not
  // on cached accessories from older versions until the next reconcile).
  const lockService = accessory.getService(Service.LockMechanism);
  if (lockService && room.lock !== null && room.lock !== undefined) {
    const lockState = room.lock
      ? Characteristic.LockCurrentState.SECURED
      : Characteristic.LockCurrentState.UNSECURED;
    lockService.getCharacteristic(Characteristic.LockCurrentState).updateValue(lockState);
    lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(
      room.lock
        ? Characteristic.LockTargetState.SECURED
        : Characteristic.LockTargetState.UNSECURED
    );
  }

  // A room with no paired thermostat has no air probe at all — leave the
  // characteristic at its last known value rather than pushing NaN (HAP
  // rejects it) or a fabricated 0 °C (HomeKit would render it as real).
  if (temp) {
    updateIfFinite(temp, Characteristic.CurrentTemperature, toCelsius(secondaryReading(room)));
  }

  // Record a history entry for Eve. valvePosition is synthesized — Warmup
  // doesn't expose actual valve % via the cloud API, so we use the heating
  // state as a proxy (100 = relay on, 0 = idle).
  if (accessory.historyService && typeof accessory.historyService.addEntry === 'function' &&
      Number.isFinite(currentTempC) && Number.isFinite(setTempC)) {
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
  if (!platform.thermostats) throw notReadyError();
  try {
    switch (value) {
      case 0: // Off — per-room since v3 (was location-wide in v2 due to API limit)
        await enqueueAccessoryWrite(platform, accessory, () =>
          platform.thermostats.setRoomOff(accessory.context.roomId));
        break;
      case 1: // Heat — keep override/fixed if already set, otherwise resume schedule
        if (room.runMode === 'fixed' || room.runMode === 'override') return;
        await enqueueAccessoryWrite(platform, accessory, () =>
          platform.thermostats.setRoomAuto(accessory.context.roomId));
        break;
      case 3: // Auto
        await enqueueAccessoryWrite(platform, accessory, () =>
          platform.thermostats.setRoomAuto(accessory.context.roomId));
        break;
    }
  } catch (err) {
    platform.log.error('Set HeatingCoolingState for %s failed: %s', accessory.displayName, err.message);
    throw asHapStatusError(err);
  }
}

function handleTargetTemperatureSet(platform, accessory, value) {
  platform.log.debug('Set TargetTemperature for %s → %s°', accessory.displayName, value);
  if (!platform.thermostats) return Promise.reject(notReadyError());

  // Trailing-edge debounce per accessory + characteristic.
  const debouncers = getDebouncers(platform, accessory);
  const existing = debouncers.get('targetTemp');
  if (existing) {
    clearTimeout(existing.timer);
    existing.value = value;
    existing.timer = setTimeout(() => flushTargetTemperatureSet(platform, accessory, debouncers, existing), SLIDER_DEBOUNCE_MS);
    return existing.promise;
  }

  const pending = { value, timer: null, promise: null, resolve: null, reject: null };
  pending.promise = new Promise((resolve, reject) => {
    pending.resolve = resolve;
    pending.reject = reject;
  });
  pending.timer = setTimeout(() => flushTargetTemperatureSet(platform, accessory, debouncers, pending), SLIDER_DEBOUNCE_MS);
  debouncers.set('targetTemp', pending);
  return pending.promise;
}

async function flushTargetTemperatureSet(platform, accessory, debouncers, pending) {
  if (debouncers.get('targetTemp') !== pending) return;
  debouncers.delete('targetTemp');
  try {
    await enqueueAccessoryWrite(platform, accessory, () =>
      platform.thermostats.setTargetTemperature(accessory.context.roomId, pending.value));
    pending.resolve();
  } catch (err) {
    platform.log.error('Set TargetTemperature for %s failed: %s', accessory.displayName, err.message);
    pending.reject(asHapStatusError(err));
  }
}

async function handleChildLockSet(platform, accessory, value) {
  // HomeKit LockTargetState: UNSECURED=0, SECURED=1.
  const wantsLocked = value === Characteristic.LockTargetState.SECURED;
  platform.log.debug('Set ChildLock for %s → %s', accessory.displayName, wantsLocked ? 'locked' : 'unlocked');
  if (!platform.thermostats) throw notReadyError();
  try {
    await enqueueAccessoryWrite(platform, accessory, () =>
      platform.thermostats.setRoomChildLock(accessory.context.roomId, wantsLocked));
    // Optimistically update CurrentState to match Target — the next poll
    // will correct it if the device didn't actually accept.
    const lockService = accessory.getService(Service.LockMechanism);
    if (lockService) {
      lockService.getCharacteristic(Characteristic.LockCurrentState).updateValue(
        wantsLocked
          ? Characteristic.LockCurrentState.SECURED
          : Characteristic.LockCurrentState.UNSECURED
      );
    }
  } catch (err) {
    platform.log.error('Set ChildLock for %s failed: %s', accessory.displayName, err.message);
    throw asHapStatusError(err);
  }
}

// Has the set of rooms changed since the last reconcile? Compares live room
// UUIDs against the room accessories we hold, ignoring the location-mode
// switches (they are keyed by location, not room, and are managed separately).
//
// Deliberately compares identity only, not names: `reconcileAccessories`
// overwrites `displayName` from Warmup, so treating a rename as a change
// would let a poll-rate loop fight a user's rename in Apple Home every
// `refresh` seconds. A rename still lands on the next restart, as before.
function roomSetChanged(platform, rooms) {
  const live = new Set(rooms.map((room) => uuidForRoom(room.roomId)));
  let known = 0;
  for (const [accUuid, accessory] of platform.accessories) {
    if (isLocationAccessory(accessory)) continue;
    if (!live.has(accUuid)) return true;  // a room went away
    known++;
  }
  return known !== live.size;             // a room appeared
}

// Serialize the cloud writes belonging to one accessory.
//
// Two writes for the same room can otherwise be in flight at once — the
// debounce entry is deleted before its request is awaited, so a second slider
// adjustment made during the first round trip starts a second request, and a
// mode tap can race a slider drag freely. If the responses arrive out of
// order the device obeys the older one, the next poll reads that back, and
// the user's change is silently lost with no error anywhere.
function enqueueAccessoryWrite(platform, accessory, task) {
  const key = accessory.UUID;
  const previous = platform._writeChains.get(key) || Promise.resolve();
  // Run `task` whichever way the previous write settled — one failure must
  // not strand every subsequent write for that accessory.
  const result = previous.then(task, task);
  // The stored tail is only a sequencer, so swallow rejections on it; an
  // unhandled one would take Homebridge down. Callers still see the real
  // outcome through `result`.
  platform._writeChains.set(key, result.catch(() => {}));
  return result;
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

// Bootstrap failed (Warmup unreachable, bad credentials, etc.) — HAP throws a
// "Not Responding" pill rather than a silent no-op, which would let HomeKit
// believe a Set succeeded when it didn't even leave the host.
function notReadyError() {
  return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
}

// ---------------------------------------------------------------------------
// Location-wide modes (M6 batch 4 — v3.6.0)
//
// One synthetic Switch accessory per location-mode (Vacation, Frost). State
// is reflected from `room.runMode`: if any room reports `holiday` or
// `anti_frost`, the corresponding switch shows ON.
// ---------------------------------------------------------------------------

const LOCATION_SWITCHES = [
  {
    kind: 'vacation',
    displayName: 'Vacation Mode',
    runModeSignal: 'holiday',
    description: 'Holiday mode — frost-low setpoint for a year. Cancel via the switch or the Warmup app.',
    disabledBy: 'disableVacationSwitch',
    enable: (thermostats) => thermostats.setLocationHoliday(),
    disable: (thermostats) => thermostats.clearLocationHoliday()
  },
  {
    kind: 'frost',
    displayName: 'Frost Protection',
    runModeSignal: 'anti_frost',
    description: 'Frost protection — minimum heating to prevent freezing.',
    disabledBy: 'disableFrostSwitch',
    enable: (thermostats) => thermostats.setLocationFrost(),
    disable: (thermostats) => thermostats.clearLocationFrost()
  }
];

function activeLocationSwitches(platform) {
  return LOCATION_SWITCHES.filter((spec) => !platform[spec.disabledBy]);
}

function isLocationAccessory(accessory) {
  return accessory && accessory.context && LOCATION_SWITCHES.some((s) => s.kind === accessory.context.kind);
}

function ensureLocationSwitch(platform, locId, spec) {
  const accessoryUuid = uuid.generate(`warmup4ie:${spec.kind}:${locId}`);
  let accessory = platform.accessories.get(accessoryUuid);
  const isNew = !accessory;
  if (!accessory) {
    accessory = new PlatformAccessoryCtor(spec.displayName, accessoryUuid);
    platform.accessories.set(accessoryUuid, accessory);
  }

  const info = accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
  info
    .setCharacteristic(Characteristic.Manufacturer, 'Warmup')
    .setCharacteristic(Characteristic.Model, 'Location Mode')
    .setCharacteristic(Characteristic.SerialNumber, `warmup4ie-${spec.kind}-${locId}`)
    .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);

  let sw = accessory.getService(Service.Switch);
  if (!sw) {
    sw = accessory.addService(Service.Switch, spec.displayName);
  }
  sw.getCharacteristic(Characteristic.On)
    .onSet((value) => handleLocationSwitchSet(platform, spec, value));

  accessory.context.kind = spec.kind;
  accessory.context.locId = locId;

  if (isNew) {
    platform.log.info('Adding %s switch', spec.displayName);
    platform.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  } else {
    platform.api.updatePlatformAccessories([accessory]);
  }
}

function removeStaleLocationAccessories(platform, currentLocId, enabledSpecs) {
  const enabledKinds = new Set(enabledSpecs.map((s) => s.kind));
  const stale = [];
  for (const [accUuid, accessory] of platform.accessories) {
    if (!isLocationAccessory(accessory)) continue;
    const isWrongLocation = String(accessory.context.locId) !== String(currentLocId);
    const isDisabledKind = !enabledKinds.has(accessory.context.kind);
    if (!isWrongLocation && !isDisabledKind) continue;

    platform.log.info(
      'Removing %s location accessory: %s',
      isDisabledKind ? 'disabled' : 'stale',
      accessory.displayName
    );
    stale.push(accessory);
    platform.accessories.delete(accUuid);
    platform._debouncers.delete(accUuid);
    platform._writeChains.delete(accUuid);
  }

  if (stale.length) {
    platform.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
  }
}

async function handleLocationSwitchSet(platform, spec, value) {
  platform.log.debug('Set %s → %s', spec.displayName, value);
  if (!platform.thermostats) throw notReadyError();
  try {
    if (value) {
      await spec.enable(platform.thermostats);
    } else {
      await spec.disable(platform.thermostats);
    }
  } catch (err) {
    platform.log.error('Set %s failed: %s', spec.displayName, err.message);
    throw asHapStatusError(err);
  }
}

// Reflect actual location-mode state on the Switch characteristics. If any
// room is in `holiday`/`anti_frost`, the corresponding switch is ON.
function pushLocationSwitchStates(platform) {
  // Guard once, up front: the old code checked `platform.thermostats` on the
  // first line and then dereferenced `._locId` unguarded on the next.
  if (!platform.thermostats || platform.thermostats._locId == null) return;
  const locId = platform.thermostats._locId;
  const rooms = platform.thermostats.room || [];
  LOCATION_SWITCHES.forEach((spec) => {
    const accessoryUuid = uuid.generate(`warmup4ie:${spec.kind}:${locId}`);
    const accessory = platform.accessories.get(accessoryUuid);
    if (!accessory) return;
    const sw = accessory.getService(Service.Switch);
    if (!sw) return;
    const active = rooms.some((r) => r && r.runMode === spec.runModeSignal);
    sw.getCharacteristic(Characteristic.On).updateValue(active);
  });
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

// Push a numeric characteristic only when the value is actually a finite
// number. Warmup can omit temperature fields entirely (a Room with no paired
// thermostat has an empty `thermostat4ies`), and HAP rejects NaN/Infinity —
// a rejected write leaves the accessory unusable in HomeKit.
function updateIfFinite(service, characteristic, value) {
  if (!Number.isFinite(value)) return;
  service.getCharacteristic(characteristic).updateValue(value);
}

// Warmup's API can return targetTemp below the device's configured minimum
// (e.g. just after switching modes); HomeKit rejects values out of the
// characteristic's [minTemp, maxTemp] range, so clamp.
//
// Returns `null` when there is no target to show. Clamping an absent target
// up to minTemp would put a confident "5 °C" on the tile that the device
// never reported, and an inverted range (minTemp > maxTemp) would clamp a
// perfectly good 21 °C up to 30 °C — so only clamp against a sane floor.
function effectiveTargetTemp(room) {
  const target = room.targetTemp;
  if (target === null || target === undefined) return null;
  const min = room.minTemp;
  if (!Number.isFinite(min) || (Number.isFinite(room.maxTemp) && min > room.maxTemp)) return target;
  return target > min ? target : min;
}

// Say, once at startup, what each Thermostat's Current reading actually is.
//
// It is air temperature on air-configured devices and floor temperature on
// floor-configured ones, and HomeKit gives no way to label a characteristic's
// value — so before v3.13 users had to work out their own sensor mode from
// the device or the MyHeating app in order to set `disableAirSensor`
// sensibly. `heatingTarget` makes it knowable, so we simply tell them.
function logSensorModes(platform, rooms) {
  const known = rooms.filter((r) => r.heatingTarget);
  if (!known.length) return;  // older payloads: say nothing rather than guess

  const byMode = new Map();
  known.forEach((r) => {
    const list = byMode.get(r.heatingTarget) || [];
    list.push(r.roomName);
    byMode.set(r.heatingTarget, list);
  });
  for (const [mode, names] of byMode) {
    platform.log.info(
      'Thermostat temperature is the %s reading for: %s', mode, names.join(', ')
    );
  }

  // An air-mode device's air sensor duplicates its Thermostat exactly. Worth
  // one line, because the alternative is a user staring at two identical
  // numbers wondering which is which.
  const redundant = known.filter((r) => r.heatingTarget === 'air' && secondaryReadingLabel(r) === 'Air');
  if (!platform.disableAirSensor && redundant.length) {
    platform.log.info(
      'The separate Air tile duplicates the Thermostat reading for %s room(s) — set "disableAirSensor": true to hide it',
      redundant.length
    );
  }
}

// The reading the Thermostat is *not* showing, in tenths of °C.
//
// `secondaryTemp` is the device's own "other" reading and is already
// sentinel-filtered by the client, so it is null when no second probe is
// fitted. Falling back to `airTemp` preserves the pre-v3.13 behaviour exactly
// for the overwhelming majority of installs, which have one probe.
function secondaryReading(room) {
  return room.secondaryTemp !== null && room.secondaryTemp !== undefined
    ? room.secondaryTemp
    : room.airTemp;
}

// Presentation label for that reading, from the device's own word for it.
// Warmup sends lowercase `air` / `floor`; anything unrecognised falls back to
// "Air", which is what this tile has always been called.
function secondaryReadingLabel(room) {
  const raw = room.secondaryTemp !== null && room.secondaryTemp !== undefined
    ? room.secondaryLabel
    : null;
  if (typeof raw !== 'string' || !raw.trim()) return 'Air';
  const word = raw.trim().toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// Convert a Warmup temperature (tenths of °C) to °C for HomeKit, mapping a
// genuinely absent reading to NaN so `updateIfFinite` skips the write.
// Necessary because `Number(null)` is 0, not NaN — a nullable field coming
// back null would otherwise render in HomeKit as a real 0 °C.
function toCelsius(value) {
  if (value === null || value === undefined) return NaN;
  return Number(value) / 10;
}

// Remove a v3.10.3-era thermo→tempService link if the cached accessory
// still carries it, with a defensive fallback for HAP-NodeJS versions
// that don't expose `removeLinkedService`. Used both when keeping the
// air sensor (to drop the broken link) and when removing the air
// sensor entirely (to avoid dangling refs in `linkedServices`).
function unlinkTempFromThermo(thermo, tempService) {
  if (!thermo || !tempService) return;
  if (typeof thermo.removeLinkedService === 'function') {
    thermo.removeLinkedService(tempService);
  } else if (Array.isArray(thermo.linkedServices)) {
    const idx = thermo.linkedServices.indexOf(tempService);
    if (idx >= 0) thermo.linkedServices.splice(idx, 1);
  }
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
  // No thermostat paired to this Room: nothing can report in and nothing
  // will accept a write, so "inactive" is the honest answer. Without this
  // the accessory looks fully functional right up until a control silently
  // fails. Explicit `=== false` so rooms from before the flag existed
  // (cached, or synthetic in tests) keep the old behaviour.
  if (room.hasThermostat === false) return false;
  if (typeof room.lastPoll !== 'number') return true;
  return room.lastPoll <= STALE_LAST_POLL_MIN;
}

// HAP RemainingDuration: seconds (uint32). Warmup's `overrideDur` is in
// minutes; convert. Defaults to 0 when no override active.
function deriveRemainingDuration(room) {
  return Math.max(0, Math.round(((room.overrideDur || 0) * 60)));
}

function uuidForRoom(roomId) {
  return uuid.generate(`warmup4ie:${roomId}`);
}
