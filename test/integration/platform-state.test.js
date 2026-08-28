// Platform-level regressions for the dynamic-platform wiring (v3.1+):
// - Cached accessories are honoured (`configureAccessory`)
// - Live discovery registers new + unregisters stale accessories
// - Multiple platform instances don't share state (no module-level singletons)
// - Missing config / failed bootstrap don't start polling or tear out cache

class FakePlatformAccessory {
  constructor(name, accessoryUuid) {
    this.displayName = name;
    this.UUID = accessoryUuid;
    this.context = {};
    this._services = new Map();
  }
  getService(type) { return this._services.get(typeKey(type)); }
  addService(type, name) {
    const svc = makeService(type, name);
    this._services.set(typeKey(type), svc);
    return svc;
  }
  removeService(svc) {
    for (const [key, candidate] of this._services) {
      if (candidate === svc) { this._services.delete(key); return; }
    }
  }
}

function typeKey(type) {
  // The fake hap "types" we plug in are just unique sentinel strings.
  return type && type.__sentinel;
}

function makeService(type, name) {
  const characteristics = new Map();
  return {
    type,
    name,
    setCharacteristic: function (charType) {
      // Chainable; ignore values for this test.
      const c = ensureCharacteristic(characteristics, charType);
      void c;
      return this;
    },
    getCharacteristic: function (charType) {
      return ensureCharacteristic(characteristics, charType);
    },
    setPrimaryService: jest.fn(),
    isPrimaryService: false,
    // Mirrors HAP-NodeJS's Service.linkedServices array so disable-flag
    // tests can verify the unlink-before-remove path.
    linkedServices: [],
    addLinkedService: function (svc) {
      if (!this.linkedServices.includes(svc)) this.linkedServices.push(svc);
    },
    removeLinkedService: function (svc) {
      const idx = this.linkedServices.indexOf(svc);
      if (idx >= 0) this.linkedServices.splice(idx, 1);
    }
  };
}

function ensureCharacteristic(map, charType) {
  let c = map.get(charType);
  if (!c) {
    let setHandler = null;
    c = {
      setProps: jest.fn(function () { return this; }),
      onSet: jest.fn(function (handler) { setHandler = handler; return this; }),
      updateValue: jest.fn(function () { return this; }),
      // Allow tests to invoke the bound onSet handler directly.
      _invokeSet: (value) => setHandler && setHandler(value)
    };
    map.set(charType, c);
  }
  return c;
}

function fakeHomebridge() {
  const calls = { register: [], unregister: [], update: [] };
  const sentinel = (n) => ({ __sentinel: n });
  return {
    calls,
    hap: {
      Service: {
        AccessoryInformation: sentinel('AccessoryInformation'),
        Thermostat: sentinel('Thermostat'),
        TemperatureSensor: sentinel('TemperatureSensor'),
        Switch: sentinel('Switch'),
        LockMechanism: sentinel('LockMechanism')
      },
      Characteristic: {
        Manufacturer: 'Manufacturer',
        Model: 'Model',
        SerialNumber: 'SerialNumber',
        FirmwareRevision: 'FirmwareRevision',
        Name: 'Name',
        CurrentTemperature: 'CurrentTemperature',
        TargetTemperature: 'TargetTemperature',
        CurrentHeatingCoolingState: 'CurrentHeatingCoolingState',
        TargetHeatingCoolingState: 'TargetHeatingCoolingState',
        StatusActive: 'StatusActive',
        RemainingDuration: 'RemainingDuration',
        On: 'On',  // Switch service's primary characteristic
        // LockMechanism characteristics — UNSECURED=0, SECURED=1
        LockCurrentState: { name: 'LockCurrentState', UNSECURED: 0, SECURED: 1, JAMMED: 2, UNKNOWN: 3 },
        LockTargetState: { name: 'LockTargetState', UNSECURED: 0, SECURED: 1 },
        // Object form because the source reads `.NO_FAULT` / `.GENERAL_FAULT`
        // sub-properties. Map.get() uses object identity for the lookup.
        StatusFault: { name: 'StatusFault', NO_FAULT: 0, GENERAL_FAULT: 1 }
      },
      HapStatusError: class HapStatusError extends Error {
        constructor(status) { super(String(status)); this.status = status; }
      },
      HAPStatus: {
        OPERATION_TIMED_OUT: -70408,
        INSUFFICIENT_AUTHORIZATION: -70411,
        SERVICE_COMMUNICATION_FAILURE: -70402
      },
      uuid: {
        generate: (seed) => `UUID(${seed})`
      }
    },
    platformAccessory: FakePlatformAccessory,
    _events: new Map(),
    on: function (name, handler) {
      const list = this._events.get(name) || [];
      list.push(handler);
      this._events.set(name, list);
    },
    emit: function (name) {
      (this._events.get(name) || []).forEach((h) => h());
    },
    registerPlatform: (pluginName, platformName, ctor) => {
      calls.register.push({ pluginName, platformName, ctor });
    },
    registerPlatformAccessories: (pluginName, platformName, accessories) => {
      calls.register.push({ kind: 'accessories', accessories });
    },
    unregisterPlatformAccessories: (pluginName, platformName, accessories) => {
      calls.unregister.push(...accessories);
    },
    updatePlatformAccessories: (accessories) => {
      calls.update.push(...accessories);
    }
  };
}

function fakeLog() {
  return { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
}

// Mirrors SLIDER_DEBOUNCE_MS in src/index.js — the trailing-edge window that
// coalesces a slider drag into one API call.
const SLIDER_DEBOUNCE_MS = 300;

function room(roomId, roomName, overrides = {}) {
  return {
    roomId, roomName,
    runMode: 'schedule', roomMode: 'program',
    targetTemp: 210, currentTemp: 200, airTemp: '200',
    minTemp: 50, maxTemp: 300,
    isFaultAir: false, isFaultFloor1: false, isFaultFloor2: false,
    ...overrides
  };
}

describe('warmup4ie dynamic platform', () => {
  let PlatformCtor;
  let MockWarmup4IE;
  let MockFakeGato;
  let fakeGatoCtor;
  let clients;
  let historyServices;
  let api;
  let platforms;

  function instantiatePlugin() {
    jest.resetModules();
    clients = [];
    historyServices = [];
    platforms = [];

    jest.doMock('../../src/lib/warmup4ie', () => {
      MockWarmup4IE = jest.fn(function (options, callback) {
        this.options = options;
        this.room = [];
        this._locId = options.username === 'one@example.com' ? 12345 : 67890;
        this.getStatus = jest.fn(async () => this.room.filter(Boolean));
        this.setRoomAuto = jest.fn(async () => {});
        this.setRoomOff = jest.fn(async () => {});
        this.setTargetTemperature = jest.fn(async () => {});
        // Location-wide mode mutations (M6 batch 4)
        this.setLocationFrost = jest.fn(async () => {});
        this.clearLocationFrost = jest.fn(async () => {});
        this.setLocationHoliday = jest.fn(async () => {});
        this.clearLocationHoliday = jest.fn(async () => {});
        // Per-room child lock (M6 batch 5)
        this.setRoomChildLock = jest.fn(async () => {});
        clients.push(this);

        if (options.username === 'fail@example.com') {
          queueMicrotask(() => callback(new Error('login failed')));
          return;
        }

        const id = options.username === 'one@example.com' ? 100001 : 200002;
        this.room[id] = room(id, options.username);
        queueMicrotask(() => callback(null, [this.room[id]]));
      });
      return { Warmup4IE: MockWarmup4IE };
    });

    // Mock fakegato — its real implementation touches disk and bundles
    // EveHomeKitTypes. We only care that the constructor is called and
    // addEntry runs per pushRoomState.
    fakeGatoCtor = jest.fn(function FakeGatoHistoryService(type, accessory, options) {
      this.type = type;
      this.accessory = accessory;
      this.options = options;
      this.addEntry = jest.fn();
      historyServices.push(this);
    });
    MockFakeGato = jest.fn(() => fakeGatoCtor);
    jest.doMock('fakegato-history', () => MockFakeGato);

    api = fakeHomebridge();
    const plugin = require('../../src/index.js');
    plugin(api);
    // Wrap the real constructor so every platform a test builds is torn down
    // in afterEach. A failing assertion skips the test's own trailing
    // `platform.shutdown()`, and the leaked poll interval then keeps the
    // whole jest run alive until it is force-killed — turning one clear
    // assertion failure into a hung suite with no output.
    const RawPlatformCtor = api.calls.register[0].ctor;
    PlatformCtor = function (...args) {
      const platform = new RawPlatformCtor(...args);
      platforms.push(platform);
      return platform;
    };
    PlatformCtor.prototype = RawPlatformCtor.prototype;
  }

  beforeEach(() => instantiatePlugin());
  afterEach(() => {
    platforms.forEach((platform) => {
      try { platform.shutdown(); } catch { /* already shut down */ }
    });
    jest.dontMock('../../src/lib/warmup4ie');
    jest.dontMock('fakegato-history');
  });

  test('missing credentials: no Warmup client, no poll timer, cached accessories preserved', () => {
    const platform = new PlatformCtor(fakeLog(), { name: 'WarmUP' }, api);
    // Pre-populate a cached accessory (Homebridge restored it from disk).
    const cached = new FakePlatformAccessory('Cached Room', 'UUID(warmup4ie:999)');
    platform.configureAccessory(cached);

    api.emit('didFinishLaunching');

    expect(MockWarmup4IE).not.toHaveBeenCalled();
    expect(platform._pollTimer).toBeNull();
    // Cache untouched — we don't rip out cached accessories on a config typo.
    expect(platform.accessories.size).toBe(1);
    expect(api.calls.unregister).toHaveLength(0);
  });

  test('failed bootstrap: cached accessories preserved, no polling started', async () => {
    const platform = new PlatformCtor(
      fakeLog(),
      { username: 'fail@example.com', password: 'p' },
      api
    );
    const cached = new FakePlatformAccessory('Bedroom', 'UUID(warmup4ie:777)');
    platform.configureAccessory(cached);

    api.emit('didFinishLaunching');
    await new Promise((r) => queueMicrotask(r));

    expect(platform.thermostats).toBeNull();
    expect(platform._pollTimer).toBeNull();
    // Cache survives a failed bootstrap so HomeKit doesn't lose tiles
    // because the Warmup cloud was briefly down at boot.
    expect(platform.accessories.size).toBe(1);
    expect(api.calls.unregister).toHaveLength(0);
  });

  test('discovery: registers new accessories for live rooms not in the cache', async () => {
    const platform = new PlatformCtor(
      fakeLog(),
      { username: 'one@example.com', password: 'p' },
      api
    );

    api.emit('didFinishLaunching');
    await new Promise((r) => queueMicrotask(r));
    await new Promise((r) => queueMicrotask(r)); // second tick for the inner microtask

    // One room → one new room accessory registered. (Location-mode switches
    // are also registered separately; filter them out by context.kind.)
    const roomRegistrations = api.calls.register.filter((c) =>
      c.kind === 'accessories' && c.accessories.some((acc) => !acc.context.kind)
    );
    expect(roomRegistrations).toHaveLength(1);
    expect(roomRegistrations[0].accessories).toHaveLength(1);
    expect(roomRegistrations[0].accessories[0].displayName).toBe('one@example.com');

    platform.shutdown();
  });

  test('discovery: stale cached accessory not in live rooms is unregistered', async () => {
    const platform = new PlatformCtor(
      fakeLog(),
      { username: 'one@example.com', password: 'p' },
      api
    );
    // Cache an accessory for a room that's no longer in the Warmup account.
    const stale = new FakePlatformAccessory('Old Room', 'UUID(warmup4ie:999)');
    platform.configureAccessory(stale);

    api.emit('didFinishLaunching');
    await new Promise((r) => queueMicrotask(r));
    await new Promise((r) => queueMicrotask(r));

    expect(api.calls.unregister).toContain(stale);
    expect(platform.accessories.has('UUID(warmup4ie:999)')).toBe(false);

    platform.shutdown();
  });

  test('defensive: empty live rooms list does NOT unregister cached accessories', async () => {
    // Build a Warmup4IE mock that returns 0 rooms.
    jest.resetModules();
    jest.doMock('../../src/lib/warmup4ie', () => {
      const Mock = jest.fn(function (options, callback) {
        this.options = options;
        this.room = [];
        this.getStatus = jest.fn(async () => []);
        this.setRoomAuto = jest.fn(async () => {});
        this.setRoomOff = jest.fn(async () => {});
        this.setTargetTemperature = jest.fn(async () => {});
        queueMicrotask(() => callback(null, []));
      });
      return { Warmup4IE: Mock };
    });
    jest.doMock('fakegato-history', () => MockFakeGato);
    const localApi = fakeHomebridge();
    const plugin = require('../../src/index.js');
    plugin(localApi);
    const LocalPlatformCtor = localApi.calls.register[0].ctor;

    const platform = new LocalPlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, localApi
    );
    // Pre-populate the cache as Homebridge would on restart.
    const cached = new FakePlatformAccessory('Living Room', 'UUID(warmup4ie:111)');
    platform.configureAccessory(cached);

    localApi.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The cached accessory must still be there — no unregister calls.
    expect(localApi.calls.unregister).toHaveLength(0);
    expect(platform.accessories.has('UUID(warmup4ie:111)')).toBe(true);

    platform.shutdown();
  });

  test('discovery: cached accessory matching a live room is reused (not unregistered)', async () => {
    const platform = new PlatformCtor(
      fakeLog(),
      { username: 'one@example.com', password: 'p' },
      api
    );
    // Cache the very accessory the live discovery will return.
    const liveUuid = 'UUID(warmup4ie:100001)';
    const cached = new FakePlatformAccessory('Living Room', liveUuid);
    platform.configureAccessory(cached);

    api.emit('didFinishLaunching');
    await new Promise((r) => queueMicrotask(r));
    await new Promise((r) => queueMicrotask(r));

    expect(api.calls.unregister).not.toContain(cached);
    // No NEW *room* registration — cached one was reused. (Location-mode
    // switches do still get registered; filter them out.)
    const newRoomRegistrations = api.calls.register.filter((c) =>
      c.kind === 'accessories' && c.accessories.some((acc) => !acc.context.kind)
    );
    expect(newRoomRegistrations).toHaveLength(0);
    // It's still the same accessory in the platform map.
    expect(platform.accessories.get(liveUuid)).toBe(cached);

    platform.shutdown();
  });

  test('two platform instances keep write operations on their own Warmup clients', async () => {
    const platformOne = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    const platformTwo = new PlatformCtor(
      fakeLog(), { username: 'two@example.com', password: 'p' }, api
    );

    api.emit('didFinishLaunching');
    await new Promise((r) => queueMicrotask(r));
    await new Promise((r) => queueMicrotask(r));

    // Pull the registered accessories out so we can fire setters on them.
    const accessoryOne = platformOne.accessories.get('UUID(warmup4ie:100001)');
    const accessoryTwo = platformTwo.accessories.get('UUID(warmup4ie:200002)');
    expect(accessoryOne).toBeDefined();
    expect(accessoryTwo).toBeDefined();

    // Invoke the .onSet handler attached to TargetHeatingCoolingState directly.
    const thermoOne = accessoryOne.getService(api.hap.Service.Thermostat);
    const thermoTwo = accessoryTwo.getService(api.hap.Service.Thermostat);
    await thermoOne.getCharacteristic('TargetHeatingCoolingState')._invokeSet(0);
    await thermoTwo.getCharacteristic('TargetHeatingCoolingState')._invokeSet(3);

    expect(clients[0].setRoomOff).toHaveBeenCalledWith(100001);
    expect(clients[0].setRoomAuto).not.toHaveBeenCalled();
    expect(clients[1].setRoomOff).not.toHaveBeenCalled();
    expect(clients[1].setRoomAuto).toHaveBeenCalledWith(200002);

    platformOne.shutdown();
    platformTwo.shutdown();
  });

  test('target temperature debounce resolves every caller and sends only the latest value', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });

    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const accessory = platform.accessories.get('UUID(warmup4ie:100001)');
    const thermo = accessory.getService(api.hap.Service.Thermostat);
    const targetTemp = thermo.getCharacteristic('TargetTemperature');

    const first = targetTemp._invokeSet(20);
    const second = targetTemp._invokeSet(21.5);

    jest.advanceTimersByTime(300);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();

    expect(clients[0].setTargetTemperature).toHaveBeenCalledTimes(1);
    expect(clients[0].setTargetTemperature).toHaveBeenCalledWith(100001, 21.5);

    platform.shutdown();
    jest.useRealTimers();
  });

  test('StatusFault: NO_FAULT for a healthy room, GENERAL_FAULT when any sensor flag is set', async () => {
    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const accessory = platform.accessories.get('UUID(warmup4ie:100001)');
    const thermo = accessory.getService(api.hap.Service.Thermostat);
    const statusFault = thermo.getCharacteristic(api.hap.Characteristic.StatusFault);

    // Initial healthy push from attachAccessoryServices
    expect(statusFault.updateValue).toHaveBeenCalledWith(0); // NO_FAULT

    // Simulate a faulty floor probe on the next poll by mutating the cached
    // room and calling pushRoomState path indirectly via getStatus → poll.
    platform.thermostats.room[100001].isFaultFloor1 = true;
    statusFault.updateValue.mockClear();

    // Trigger a poll cycle manually
    await platform.thermostats.getStatus();
    platform.thermostats.room.forEach((r) => {
      if (r) {
        // updateAccessoryState is module-internal; trigger via the public
        // pushRoomState path by calling the attach helper which calls it.
        // Easier: just call getStatus() and let the polling loop fire — but
        // that needs fake timers. For a unit-test view, fire the attach
        // helper to re-push state.
      }
    });
    // Real polls go through updateAccessoryState → pushRoomState. Trigger
    // the polling loop and let it pick up the mutated room.
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    platform.startPolling();
    jest.advanceTimersByTime(platform.refresh * 1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(statusFault.updateValue).toHaveBeenCalledWith(1); // GENERAL_FAULT
    platform.shutdown();
    jest.useRealTimers();
  });

  test('fakegato history: a service is attached per accessory and addEntry fires per poll', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });

    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // One accessory → one history service constructed with type 'thermo'
    expect(historyServices).toHaveLength(1);
    expect(historyServices[0].type).toBe('thermo');
    expect(historyServices[0].options).toMatchObject({ disableTimer: true, storage: 'fs' });

    // Initial pushRoomState during attachAccessoryServices recorded one entry
    expect(historyServices[0].addEntry).toHaveBeenCalledTimes(1);
    const firstEntry = historyServices[0].addEntry.mock.calls[0][0];
    expect(firstEntry).toMatchObject({
      currentTemp: 20,    // 200/10
      setTemp: 21,        // 210/10
      valvePosition: 100  // currentTemp < targetTemp → heating, so 100
    });
    expect(typeof firstEntry.time).toBe('number');

    // Drive a poll cycle and verify another addEntry call
    jest.advanceTimersByTime(platform.refresh * 1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(historyServices[0].addEntry).toHaveBeenCalledTimes(2);

    platform.shutdown();
    jest.useRealTimers();
  });

  test('location-mode switches: Vacation + Frost accessories created with stable per-locId UUIDs', async () => {
    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // UUID seeds use the locId so multi-account installs don't collide.
    const vacationUuid = 'UUID(warmup4ie:vacation:12345)';
    const frostUuid = 'UUID(warmup4ie:frost:12345)';

    expect(platform.accessories.has(vacationUuid)).toBe(true);
    expect(platform.accessories.has(frostUuid)).toBe(true);

    const vacation = platform.accessories.get(vacationUuid);
    expect(vacation.context.kind).toBe('vacation');
    expect(vacation.context.locId).toBe(12345);

    const frost = platform.accessories.get(frostUuid);
    expect(frost.context.kind).toBe('frost');

    platform.shutdown();
  });

  test('location-mode switches: tap on/off invokes the right lib method', async () => {
    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const vacation = platform.accessories.get('UUID(warmup4ie:vacation:12345)');
    const frost = platform.accessories.get('UUID(warmup4ie:frost:12345)');

    const vacationSwitch = vacation.getService(api.hap.Service.Switch);
    const frostSwitch = frost.getService(api.hap.Service.Switch);

    // Tap Vacation ON → setLocationHoliday
    await vacationSwitch.getCharacteristic('On')._invokeSet(true);
    expect(clients[0].setLocationHoliday).toHaveBeenCalled();
    expect(clients[0].clearLocationHoliday).not.toHaveBeenCalled();

    // Tap Vacation OFF → clearLocationHoliday
    await vacationSwitch.getCharacteristic('On')._invokeSet(false);
    expect(clients[0].clearLocationHoliday).toHaveBeenCalled();

    // Tap Frost ON → setLocationFrost
    await frostSwitch.getCharacteristic('On')._invokeSet(true);
    expect(clients[0].setLocationFrost).toHaveBeenCalled();

    // Tap Frost OFF → clearLocationFrost (resume schedule)
    await frostSwitch.getCharacteristic('On')._invokeSet(false);
    expect(clients[0].clearLocationFrost).toHaveBeenCalled();

    platform.shutdown();
  });

  test('location-mode switches: state reflects room runMode on each poll', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });

    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const vacation = platform.accessories.get('UUID(warmup4ie:vacation:12345)');
    const frost = platform.accessories.get('UUID(warmup4ie:frost:12345)');
    const vacationOn = vacation.getService(api.hap.Service.Switch).getCharacteristic('On');
    const frostOn = frost.getService(api.hap.Service.Switch).getCharacteristic('On');

    // Initially neither active (room is in 'schedule' mode).
    vacationOn.updateValue.mockClear();
    frostOn.updateValue.mockClear();

    platform.thermostats.room[100001].runMode = 'holiday';
    jest.advanceTimersByTime(platform.refresh * 1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(vacationOn.updateValue).toHaveBeenCalledWith(true);
    expect(frostOn.updateValue).toHaveBeenCalledWith(false);

    platform.thermostats.room[100001].runMode = 'anti_frost';
    vacationOn.updateValue.mockClear();
    frostOn.updateValue.mockClear();
    jest.advanceTimersByTime(platform.refresh * 1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(vacationOn.updateValue).toHaveBeenCalledWith(false);
    expect(frostOn.updateValue).toHaveBeenCalledWith(true);

    platform.shutdown();
    jest.useRealTimers();
  });

  test('location-mode switches survive an unrelated room being unregistered (not nuked)', async () => {
    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    // Cache a stale room accessory that's not in the live response.
    const stale = new FakePlatformAccessory('Old Room', 'UUID(warmup4ie:99)');
    platform.configureAccessory(stale);

    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Stale room got unregistered; location switches did NOT.
    expect(api.calls.unregister).toContain(stale);
    expect(platform.accessories.has('UUID(warmup4ie:vacation:12345)')).toBe(true);
    expect(platform.accessories.has('UUID(warmup4ie:frost:12345)')).toBe(true);

    platform.shutdown();
  });

  test('location-mode switches from an old locId are unregistered', async () => {
    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    const oldVacation = new FakePlatformAccessory('Vacation Mode', 'UUID(warmup4ie:vacation:999)');
    oldVacation.context.kind = 'vacation';
    oldVacation.context.locId = 999;
    platform.configureAccessory(oldVacation);

    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.calls.unregister).toContain(oldVacation);
    expect(platform.accessories.has('UUID(warmup4ie:vacation:999)')).toBe(false);
    expect(platform.accessories.has('UUID(warmup4ie:vacation:12345)')).toBe(true);

    platform.shutdown();
  });

  test('child lock: LockMechanism service attached, tap toggles via setRoomChildLock', async () => {
    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const accessory = platform.accessories.get('UUID(warmup4ie:100001)');
    const lockService = accessory.getService(api.hap.Service.LockMechanism);
    expect(lockService).toBeDefined();

    const target = lockService.getCharacteristic(api.hap.Characteristic.LockTargetState);

    // Tap to lock
    await target._invokeSet(1);  // SECURED
    expect(clients[0].setRoomChildLock).toHaveBeenCalledWith(100001, true);

    // Tap to unlock
    await target._invokeSet(0);  // UNSECURED
    expect(clients[0].setRoomChildLock).toHaveBeenCalledWith(100001, false);

    platform.shutdown();
  });

  test('child lock: state reflects room.lock from polling', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const accessory = platform.accessories.get('UUID(warmup4ie:100001)');
    const lockService = accessory.getService(api.hap.Service.LockMechanism);
    const current = lockService.getCharacteristic(api.hap.Characteristic.LockCurrentState);

    // Simulate the device reporting locked
    platform.thermostats.room[100001].lock = true;
    current.updateValue.mockClear();
    jest.advanceTimersByTime(platform.refresh * 1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(current.updateValue).toHaveBeenCalledWith(1); // SECURED

    // And unlocked
    platform.thermostats.room[100001].lock = false;
    current.updateValue.mockClear();
    jest.advanceTimersByTime(platform.refresh * 1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(current.updateValue).toHaveBeenCalledWith(0); // UNSECURED

    platform.shutdown();
    jest.useRealTimers();
  });

  test('disableChildLock: skips LockMechanism creation', async () => {
    const platform = new PlatformCtor(
      fakeLog(),
      { username: 'one@example.com', password: 'p', disableChildLock: true },
      api
    );
    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const accessory = platform.accessories.get('UUID(warmup4ie:100001)');
    expect(accessory.getService(api.hap.Service.LockMechanism)).toBeUndefined();

    platform.shutdown();
  });

  test('disableChildLock: removes LockMechanism from a previously-cached accessory', async () => {
    const platform = new PlatformCtor(
      fakeLog(),
      { username: 'one@example.com', password: 'p', disableChildLock: true },
      api
    );
    // Pre-populate a cached accessory that already has a LockMechanism
    // service on it (i.e. a v3.7.0+ user upgrading and turning the option
    // on for the first time).
    const cached = new FakePlatformAccessory('User One', 'UUID(warmup4ie:100001)');
    cached.addService(api.hap.Service.LockMechanism, 'User One Lock');
    platform.configureAccessory(cached);

    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(cached.getService(api.hap.Service.LockMechanism)).toBeUndefined();

    platform.shutdown();
  });

  test('disableVacationSwitch: skips creation and unregisters cached vacation accessory', async () => {
    const platform = new PlatformCtor(
      fakeLog(),
      { username: 'one@example.com', password: 'p', disableVacationSwitch: true },
      api
    );
    // Cached vacation accessory from a previous launch (when the option
    // was off). Use the same locId that the mocked Warmup4IE will resolve
    // to, so the unregister path is "disabled kind" rather than "stale loc".
    const cachedVacation = new FakePlatformAccessory(
      'Vacation Mode', 'UUID(warmup4ie:vacation:12345)'
    );
    cachedVacation.context.kind = 'vacation';
    cachedVacation.context.locId = 12345;
    platform.configureAccessory(cachedVacation);

    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.calls.unregister).toContain(cachedVacation);
    expect(platform.accessories.has('UUID(warmup4ie:vacation:12345)')).toBe(false);
    // Frost switch is still allowed — verify it was created.
    expect(platform.accessories.has('UUID(warmup4ie:frost:12345)')).toBe(true);

    platform.shutdown();
  });

  test('disableFrostSwitch: skips creation and unregisters cached frost accessory', async () => {
    const platform = new PlatformCtor(
      fakeLog(),
      { username: 'one@example.com', password: 'p', disableFrostSwitch: true },
      api
    );
    const cachedFrost = new FakePlatformAccessory(
      'Frost Protection', 'UUID(warmup4ie:frost:12345)'
    );
    cachedFrost.context.kind = 'frost';
    cachedFrost.context.locId = 12345;
    platform.configureAccessory(cachedFrost);

    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.calls.unregister).toContain(cachedFrost);
    expect(platform.accessories.has('UUID(warmup4ie:frost:12345)')).toBe(false);
    expect(platform.accessories.has('UUID(warmup4ie:vacation:12345)')).toBe(true);

    platform.shutdown();
  });

  test('disableAirSensor: skips TemperatureSensor creation', async () => {
    const platform = new PlatformCtor(
      fakeLog(),
      { username: 'one@example.com', password: 'p', disableAirSensor: true },
      api
    );
    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const accessory = platform.accessories.get('UUID(warmup4ie:100001)');
    expect(accessory.getService(api.hap.Service.TemperatureSensor)).toBeUndefined();
    // Thermostat is still present — only the standalone air-sensor tile is hidden.
    expect(accessory.getService(api.hap.Service.Thermostat)).toBeDefined();

    platform.shutdown();
  });

  test('disableAirSensor: removes TemperatureSensor from a previously-cached accessory', async () => {
    const platform = new PlatformCtor(
      fakeLog(),
      { username: 'one@example.com', password: 'p', disableAirSensor: true },
      api
    );
    // Pre-populate a cached accessory that already has a TemperatureSensor
    // service (i.e. a v3.x user upgrading and turning the option on for
    // the first time). Also stash a v3.10.3-era link so we exercise the
    // unlink-before-remove path that prevents a dangling reference in
    // `thermo.linkedServices` after the service is gone.
    const cached = new FakePlatformAccessory('User One', 'UUID(warmup4ie:100001)');
    const cachedThermo = cached.addService(api.hap.Service.Thermostat, 'User One');
    const cachedTemp = cached.addService(api.hap.Service.TemperatureSensor, 'User One Air');
    cachedThermo.addLinkedService(cachedTemp);
    expect(cachedThermo.linkedServices).toContain(cachedTemp);
    platform.configureAccessory(cached);

    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(cached.getService(api.hap.Service.TemperatureSensor)).toBeUndefined();
    // No dangling link to the now-removed service.
    expect(cachedThermo.linkedServices).not.toContain(cachedTemp);

    platform.shutdown();
  });

  test('room missing every temperature field: no NaN reaches HAP', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const accessory = platform.accessories.get('UUID(warmup4ie:100001)');
    const thermo = accessory.getService(api.hap.Service.Thermostat);
    const air = accessory.getService(api.hap.Service.TemperatureSensor);
    const targetTemp = thermo.getCharacteristic(api.hap.Characteristic.TargetTemperature);
    const currentTemp = thermo.getCharacteristic(api.hap.Characteristic.CurrentTemperature);
    const airTemp = air.getCharacteristic(api.hap.Characteristic.CurrentTemperature);

    // `normalizeRoom` defaults these, so reaching the platform with them
    // still missing means either a cached room from an older release or a
    // future schema change. Either way HAP must not see NaN — it rejects
    // non-finite values and the accessory goes dead in HomeKit.
    platform.thermostats.room[100001] = room(100001, 'Unpaired', {
      minTemp: undefined, maxTemp: undefined,
      airTemp: null, currentTemp: undefined, targetTemp: undefined
    });
    [targetTemp, currentTemp, airTemp].forEach((c) => c.updateValue.mockClear());

    jest.advanceTimersByTime(platform.refresh * 1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const pushed = [targetTemp, currentTemp, airTemp]
      .flatMap((c) => c.updateValue.mock.calls.map(([v]) => v));
    expect(pushed.every((v) => typeof v !== 'number' || Number.isFinite(v))).toBe(true);
    expect(pushed).not.toContain(NaN);
    // The air probe reported nothing, so we leave the characteristic alone
    // rather than inventing a 0 °C reading HomeKit would render as real.
    expect(airTemp.updateValue).not.toHaveBeenCalled();

    platform.shutdown();
    jest.useRealTimers();
  });

  test('unusable temperature range: bounds left at HomeKit defaults, warning logged', async () => {
    const log = fakeLog();
    const platform = new PlatformCtor(
      log, { username: 'one@example.com', password: 'p' }, api
    );
    // Inverted range — HAP throws when minValue >= maxValue, which would
    // take the whole accessory down during setup.
    MockWarmup4IE.mockImplementationOnce(function (options, callback) {
      this.room = [];
      this._locId = 12345;
      this.getStatus = jest.fn(async () => this.room.filter(Boolean));
      this.room[100001] = room(100001, 'Inverted', { minTemp: 300, maxTemp: 50 });
      clients.push(this);
      queueMicrotask(() => callback(null, [this.room[100001]]));
    });

    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const accessory = platform.accessories.get('UUID(warmup4ie:100001)');
    const targetTemp = accessory
      .getService(api.hap.Service.Thermostat)
      .getCharacteristic(api.hap.Characteristic.TargetTemperature);

    expect(targetTemp.setProps).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('unusable temperature range'),
      'Inverted', 300, 50
    );

    platform.shutdown();
  });

  test('nullable temperature fields: absent readings are skipped, not shown as 0 °C', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const accessory = platform.accessories.get('UUID(warmup4ie:100001)');
    const thermo = accessory.getService(api.hap.Service.Thermostat);
    const current = thermo.getCharacteristic(api.hap.Characteristic.CurrentTemperature);
    const target = thermo.getCharacteristic(api.hap.Characteristic.TargetTemperature);

    // Every temperature in the GraphQL schema is nullable. `Number(null)` is
    // 0 — not NaN — so a null slips past a plain finite check and lands in
    // HomeKit as a genuine 0 °C reading. `normalizeRoom` maps it to null and
    // the platform skips the write.
    platform.thermostats.room[100001] = room(100001, 'Nulls', {
      currentTemp: null, targetTemp: null
    });
    current.updateValue.mockClear();
    target.updateValue.mockClear();

    jest.advanceTimersByTime(platform.refresh * 1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(current.updateValue).not.toHaveBeenCalled();
    expect(target.updateValue).not.toHaveBeenCalled();

    platform.shutdown();
    jest.useRealTimers();
  });

  test('writes for one accessory are serialized, so the last one wins', async () => {
    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );
    api.emit('didFinishLaunching');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const accessory = platform.accessories.get('UUID(warmup4ie:100001)');
    const target = accessory
      .getService(api.hap.Service.Thermostat)
      .getCharacteristic(api.hap.Characteristic.TargetTemperature);

    // The debounce entry is cleared before its request is awaited, so a
    // second adjustment during the first round trip starts a second request.
    // With an unlucky pair of latencies they land out of order and the device
    // is left obeying the older setpoint — silently, since the next poll then
    // reads that value back. Order must not depend on response timing.
    // The first round trip must still be in flight when the second one is
    // issued, and must finish after it — otherwise the two never overlap and
    // the test passes against the unfixed code too.
    //   t=0    set 20      t=300  flush → request A (400 ms) → would land t=700
    //   t=320  set 22      t=620  flush → request B (0 ms)   → would land t=620
    // Unserialized that lands [22, 20]; serialized, B waits for A.
    const landed = [];
    let call = 0;
    clients[0].setTargetTemperature = jest.fn((roomId, value) => {
      const delay = call++ === 0 ? 400 : 0;
      return new Promise((r) => setTimeout(() => { landed.push(value); r(); }, delay));
    });

    const first = target._invokeSet(20);
    await new Promise((r) => setTimeout(r, SLIDER_DEBOUNCE_MS + 20));
    const second = target._invokeSet(22);
    await Promise.allSettled([first, second]);
    await new Promise((r) => setTimeout(r, 900));

    expect(landed).toEqual([20, 22]);

    platform.shutdown();
  });

  test('shutdown: clears the poll timer and pending debouncers', async () => {
    const platform = new PlatformCtor(
      fakeLog(), { username: 'one@example.com', password: 'p' }, api
    );

    api.emit('didFinishLaunching');
    await new Promise((r) => queueMicrotask(r));
    await new Promise((r) => queueMicrotask(r));

    expect(platform._pollTimer).not.toBeNull();
    platform.shutdown();
    expect(platform._pollTimer).toBeNull();
  });
});
