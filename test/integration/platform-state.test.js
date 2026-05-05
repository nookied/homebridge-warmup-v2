/* eslint-env jest */

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
    isPrimaryService: false
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

  function instantiatePlugin() {
    jest.resetModules();
    clients = [];
    historyServices = [];

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
    PlatformCtor = api.calls.register[0].ctor;
  }

  beforeEach(() => instantiatePlugin());
  afterEach(() => {
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
