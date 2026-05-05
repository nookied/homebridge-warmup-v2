/* eslint-env jest */

// Platform-level regressions that are easiest to catch at the Homebridge
// wrapper layer: per-instance API clients, missing config, and bootstrap
// failure timer behaviour.

function fakeHomebridge() {
  const calls = [];
  return {
    calls,
    hap: {
      Service: {},
      Characteristic: {},
      HapStatusError: class HapStatusError extends Error {
        constructor(status) {
          super(String(status));
          this.status = status;
        }
      },
      HAPStatus: {
        OPERATION_TIMED_OUT: -70408,
        INSUFFICIENT_AUTHORIZATION: -70411,
        SERVICE_COMMUNICATION_FAILURE: -70402
      }
    },
    registerPlatform: (pluginName, platformName, ctor) => {
      calls.push({ pluginName, platformName, ctor });
    }
  };
}

function fakeLog() {
  return {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
}

function room(roomId, roomName) {
  return {
    roomId,
    roomName,
    runMode: 'schedule',
    roomMode: 'program',
    targetTemp: 210,
    currentTemp: 200,
    airTemp: '200',
    minTemp: 50,
    maxTemp: 300
  };
}

describe('warmup4ie platform state', () => {
  let Warmup4IE;
  let clients;
  let PlatformCtor;

  beforeEach(() => {
    jest.resetModules();
    clients = [];

    jest.doMock('../../src/lib/warmup4ie', () => {
      Warmup4IE = jest.fn(function MockWarmup4IE(options, callback) {
        this.options = options;
        this.room = [];
        this.getStatus = jest.fn(async () => this.room.filter(Boolean));
        this.setRoomAuto = jest.fn(async () => {});
        this.setRoomOff = jest.fn(async () => {});
        this.setTargetTemperature = jest.fn(async () => {});
        clients.push(this);

        if (options.username === 'fail@example.com') {
          queueMicrotask(() => callback(new Error('login failed')));
          return;
        }

        const id = options.username === 'one@example.com' ? 100001 : 200002;
        this.room[id] = room(id, options.username);
        queueMicrotask(() => callback(null, [this.room[id]]));
      });
      return { Warmup4IE };
    });

    const hb = fakeHomebridge();
    const plugin = require('../../src/index.js');
    plugin(hb);
    PlatformCtor = hb.calls[0].ctor;
  });

  afterEach(() => {
    jest.dontMock('../../src/lib/warmup4ie');
  });

  test('missing credentials do not create a Warmup client or poll timer', () => {
    const platform = new PlatformCtor(fakeLog(), { name: 'WarmUP' });
    let returned;

    platform.accessories((accessories) => { returned = accessories; });

    expect(returned).toEqual([]);
    expect(Warmup4IE).not.toHaveBeenCalled();
    expect(platform._pollTimer).toBeNull();
  });

  test('bootstrap failure returns no accessories and does not start polling', async () => {
    const platform = new PlatformCtor(fakeLog(), {
      username: 'fail@example.com',
      password: 'p'
    });

    const returned = await new Promise((resolve) => {
      platform.accessories(resolve);
    });

    expect(returned).toEqual([]);
    expect(platform.thermostats).toBeNull();
    expect(platform._pollTimer).toBeNull();
  });

  test('two platform instances keep write operations on their own Warmup clients', async () => {
    const platformOne = new PlatformCtor(fakeLog(), {
      username: 'one@example.com',
      password: 'p'
    });
    const platformTwo = new PlatformCtor(fakeLog(), {
      username: 'two@example.com',
      password: 'p'
    });
    const [accessoriesOne, accessoriesTwo] = await Promise.all([
      new Promise((resolve) => { platformOne.accessories(resolve); }),
      new Promise((resolve) => { platformTwo.accessories(resolve); })
    ]);

    await accessoriesOne[0].handleTargetHeatingCoolingSet(0);
    await accessoriesTwo[0].handleTargetHeatingCoolingSet(3);

    expect(clients[0].setRoomOff).toHaveBeenCalledWith(100001);
    expect(clients[0].setRoomAuto).not.toHaveBeenCalled();
    expect(clients[1].setRoomOff).not.toHaveBeenCalled();
    expect(clients[1].setRoomAuto).toHaveBeenCalledWith(200002);

    platformOne.shutdown();
    platformTwo.shutdown();
  });
});
