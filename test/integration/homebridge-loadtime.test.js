/* eslint-env jest */

// Smoke test: the plugin module exports a function that, when called with a
// homebridge-shaped argument, registers the platform with the right tuple.
// This catches require-time failures and `registerPlatform` arg mistakes.

describe('plugin loadtime / registerPlatform', () => {
  test('module.exports is a function', () => {
    const plugin = require('../../src/index.js');
    expect(typeof plugin).toBe('function');
  });

  test('calling exports(homebridge) calls registerPlatform with (PLUGIN_NAME, "warmup4ie", ctor)', () => {
    const calls = [];
    const fakeHomebridge = {
      hap: {
        Service: { Thermostat: jest.fn(), TemperatureSensor: jest.fn(), AccessoryInformation: jest.fn() },
        Characteristic: {
          Manufacturer: 'Manufacturer',
          SerialNumber: 'SerialNumber',
          FirmwareRevision: 'FirmwareRevision',
          CurrentTemperature: 'CurrentTemperature',
          TargetTemperature: 'TargetTemperature',
          CurrentHeatingCoolingState: 'CurrentHeatingCoolingState',
          TargetHeatingCoolingState: 'TargetHeatingCoolingState'
        }
      },
      registerPlatform: (pluginName, platformName, ctor) => {
        calls.push({ pluginName, platformName, ctor });
      }
    };

    // jest module cache may already have the module; force re-require so
    // the closure-scoped `Service`/`Characteristic` get re-bound from this
    // homebridge shim.
    jest.resetModules();
    const plugin = require('../../src/index.js');
    plugin(fakeHomebridge);

    expect(calls).toHaveLength(1);
    const { pluginName, platformName, ctor } = calls[0];
    expect(pluginName).toBe('homebridge-warmup4ie-v2');
    expect(platformName).toBe('warmup4ie');
    expect(typeof ctor).toBe('function');
  });
});
