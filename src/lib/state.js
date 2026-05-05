'use strict';

// Pure mappings from Warmup `room` payloads to HAP HeatingCoolingState values.
// Extracted so unit tests can exercise the truth table without spinning up
// HAP-NodeJS. Numeric values are HAP characteristic values:
//   CurrentHeatingCoolingState: 0=OFF, 1=HEAT, 2=COOL  (we only emit 0 and 1)
//   TargetHeatingCoolingState:  0=OFF, 1=HEAT, 2=COOL, 3=AUTO  (we only emit 0, 1, 3)

function deriveCurrentHeatingState(room) {
  if (room.runMode === 'off') return 0;
  return room.currentTemp < room.targetTemp ? 1 : 0;
}

function deriveTargetHeatingState(room) {
  switch (room.runMode) {
    case 'off': return 0;
    case 'fixed':
    case 'override': return 1;
    case 'schedule': return 3;
    default: return 1;
  }
}

module.exports = { deriveCurrentHeatingState, deriveTargetHeatingState };
