// Smoke test: the plugin module exports a function that, when called with a
// homebridge-shaped argument, registers the platform as a *dynamic* platform
// with the right name + alias.

describe('plugin loadtime / registerPlatform', () => {
  test('module.exports is a function', () => {
    const plugin = require('../../src/index.js');
    expect(typeof plugin).toBe('function');
  });

  test('calling exports(homebridge) registers a dynamic platform with the right tuple', () => {
    const calls = [];
    const fakeHomebridge = {
      hap: {
        Service: {},
        Characteristic: {},
        HapStatusError: class {},
        HAPStatus: {},
        uuid: { generate: (s) => `uuid-${s}` }
      },
      platformAccessory: class {},
      registerPlatform: (pluginName, platformName, ctor, isDynamic) => {
        calls.push({ pluginName, platformName, ctor, isDynamic });
      }
    };

    jest.resetModules();
    const plugin = require('../../src/index.js');
    plugin(fakeHomebridge);

    expect(calls).toHaveLength(1);
    const { pluginName, platformName, ctor, isDynamic } = calls[0];
    expect(pluginName).toBe('homebridge-warmup4ie-v2');
    expect(platformName).toBe('warmup4ie');
    expect(typeof ctor).toBe('function');
    // 4th arg `true` is what makes Homebridge persist accessories across restarts.
    expect(isDynamic).toBe(true);
  });
});
