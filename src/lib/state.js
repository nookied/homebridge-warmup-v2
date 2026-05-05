'use strict';

// Pure mappings from Warmup `room` payloads to HAP HeatingCoolingState values.
// Extracted so unit tests can exercise the truth table without spinning up
// HAP-NodeJS. Numeric values are HAP characteristic values:
//   CurrentHeatingCoolingState: 0=OFF, 1=HEAT, 2=COOL  (we only emit 0 and 1)
//   TargetHeatingCoolingState:  0=OFF, 1=HEAT, 2=COOL, 3=AUTO  (we only emit 0, 1, 3)
//
// `runMode` enum (per the GraphQL schema): not_set | off | schedule | override
//                                          | fixed | anti_frost | holiday |
//                                          | fil_pilote | gradual | relay | previous

function deriveCurrentHeatingState(room) {
  // OFF only when the device is genuinely off. For every other mode (including
  // anti_frost and holiday — both still drive heating to a low setpoint) the
  // signal is whether currentTemp is below targetTemp. Roadmap M6 will swap
  // this for the more accurate `Thermostat4iE.parameters.outputStatus` relay
  // signal once we re-add `parameters` to the GraphQL query.
  if (room.runMode === 'off') return 0;
  return room.currentTemp < room.targetTemp ? 1 : 0;
}

function deriveTargetHeatingState(room) {
  switch (room.runMode) {
    case 'off':
    case 'holiday':       // Location-wide vacation mode — user expectation: "off"
    case 'anti_frost':    // Frost protection — passive, low setpoint
      return 0;           // OFF
    case 'fixed':
    case 'override':
      return 1;           // HEAT (user-set fixed temperature)
    case 'schedule':
    case 'gradual':       // Early-start ramp-up to the next scheduled slot
      return 3;           // AUTO
    default:
      // Includes `not_set`, `fil_pilote`, `relay`, `previous` — rare modes
      // we have no real signal on. HEAT is the safe fallback (better than
      // showing OFF when heating is actually happening).
      return 1;
  }
}

module.exports = { deriveCurrentHeatingState, deriveTargetHeatingState };
