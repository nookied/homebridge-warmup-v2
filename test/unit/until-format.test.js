/* eslint-env jest */

// Regression test for the 0.1.0–0.1.1 UTC bug. `until` must be local time
// HH:MM, computed as now + duration minutes.
//
// Note: Node doesn't honor mid-process `process.env.TZ` mutations reliably
// — V8's timezone is read at startup. So instead we use Jest's fake timers
// to fix `Date.now()` and assert that `until` matches what *local-time*
// math says, not UTC. CI runs in UTC where the two collide; the parametrized
// "non-UTC" assertion is opportunistic — it only fires on hosts where the
// local zone differs from UTC, which in practice is your dev machine and
// the QA host.

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { stubClient } = require('../helpers');

function callAndCapture(durationMin) {
  const captured = [];
  const client = stubClient(Warmup4IE, captured);
  client._duration = durationMin;
  return new Promise((resolve) => {
    client.setTargetTemperature(1, 21, () => resolve(captured[0].request.until));
  });
}

function localHHMM(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

describe('setTargetTemperature `until` format', () => {
  afterEach(() => { jest.useRealTimers(); });

  test('formats as zero-padded HH:MM', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    jest.setSystemTime(new Date('2026-05-05T14:30:00Z'));

    const until = await callAndCapture(60);
    expect(until).toMatch(/^\d{2}:\d{2}$/);
  });

  test('uses LOCAL time (regression: 0.1.0–0.1.1 used UTC via toISOString)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    const fixed = new Date('2026-05-05T14:30:00Z');
    jest.setSystemTime(fixed);

    const until = await callAndCapture(60);
    const end = new Date(fixed.getTime() + 60 * 60000);
    expect(until).toBe(localHHMM(end));
    // Note: on UTC hosts (CI) localHHMM == end.toISOString().slice(11,16),
    // so this single assertion is the same shape either way. The actual
    // sentinel for the UTC regression is the QA_TESTS.md manual check on
    // a non-UTC host (your dev machine / Homebridge host in Lisbon).
  });

  test('30 min override at 23:50 local wraps to 00:20 next-day HH:MM (HH only, day implicit)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    // Pick a wall-clock-late time in local zone. We can't force the zone,
    // but we can compute what 23:50 local *is* in UTC for the current host.
    const localLate = new Date();
    localLate.setHours(23, 50, 0, 0);
    jest.setSystemTime(localLate);

    const until = await callAndCapture(30);
    const end = new Date(localLate.getTime() + 30 * 60000);
    expect(until).toBe(localHHMM(end));
    // Sanity: should start with "00:" since 23:50 + 30 min = 00:20
    expect(until).toBe('00:20');
  });

  test('zero-duration override → until equals current local HH:MM', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    const local = new Date();
    local.setHours(2, 5, 0, 0);
    jest.setSystemTime(local);

    const until = await callAndCapture(0);
    expect(until).toBe('02:05');
  });
});
