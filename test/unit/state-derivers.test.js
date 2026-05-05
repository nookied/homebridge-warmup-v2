/* eslint-env jest */

// Truth tables for the pure HomeKit state derivers. These power both the
// initial accessory build and every subsequent poll, so a regression here
// silently shows wrong heating/idle state in HomeKit.

const { deriveCurrentHeatingState, deriveTargetHeatingState } = require('../../src/lib/state');

describe('deriveCurrentHeatingState', () => {
  // HAP CurrentHeatingCoolingState: 0=OFF, 1=HEAT, 2=COOL (we only emit 0/1)
  const cases = [
    // [runMode, currentTemp, targetTemp, expected, why]
    ['off',      200, 200, 0, 'off mode → always 0'],
    ['off',      150, 200, 0, 'off mode → always 0 even when below target'],
    ['off',      250, 200, 0, 'off mode → always 0 even when above target'],
    ['schedule', 150, 200, 1, 'schedule + below target → heating (1)'],
    ['schedule', 200, 200, 0, 'schedule + at target → idle (0)'],
    ['schedule', 250, 200, 0, 'schedule + above target → idle (0)'],
    ['fixed',    150, 200, 1, 'fixed + below target → heating'],
    ['fixed',    250, 200, 0, 'fixed + above target → idle'],
    ['override', 150, 200, 1, 'override + below target → heating'],
    ['override', 250, 200, 0, 'override + above target → idle'],
    ['unknown-mode', 150, 200, 1, 'fallback: any non-off mode behaves like schedule'],
    ['unknown-mode', 250, 200, 0, 'fallback: any non-off mode, above target → idle']
  ];

  test.each(cases)('runMode=%s curr=%i target=%i → %i (%s)', (runMode, currentTemp, targetTemp, expected) => {
    expect(deriveCurrentHeatingState({ runMode, currentTemp, targetTemp })).toBe(expected);
  });
});

describe('deriveTargetHeatingState', () => {
  // HAP TargetHeatingCoolingState: 0=OFF, 1=HEAT, 2=COOL, 3=AUTO
  // The plugin restricts validValues to [0, 1, 3]; 2 (COOL) is never emitted.
  const cases = [
    // [runMode, expected, why]
    ['off',      0, 'off mode → OFF'],
    ['fixed',    1, 'fixed mode → HEAT (manual fixed temperature)'],
    ['override', 1, 'override mode → HEAT (temporary boost)'],
    ['schedule', 3, 'schedule mode → AUTO (running program)'],
    ['unknown-mode', 1, 'unknown mode → HEAT (safest default; never emit COOL)']
  ];

  test.each(cases)('runMode=%s → %i (%s)', (runMode, expected) => {
    expect(deriveTargetHeatingState({ runMode })).toBe(expected);
  });
});
