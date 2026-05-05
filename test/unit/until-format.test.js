/* eslint-env jest */

// Regression test for the 0.1.0–0.1.1 UTC bug. `until` must be local time
// HH:MM, computed as now + duration minutes.
//
// Note: Node doesn't honor mid-process `process.env.TZ` mutations reliably
// — V8's timezone is read at startup. So we use Jest's fake timers to fix
// `Date.now()` and assert that `until` matches what *local-time* math says.
// CI runs in UTC where local == UTC; the assertion shape is correct either
// way. The actual sentinel for the UTC regression is the QA_TESTS.md manual
// check on a non-UTC host.

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { stubClient } = require('../helpers');

async function callAndCapture(durationMin) {
  const captured = [];
  const client = stubClient(Warmup4IE, captured);
  client._duration = durationMin;
  await client.setTargetTemperature(1, 21);
  return captured[0].request.until;
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
  });

  test('30 min override at 23:50 local wraps to 00:20 next-day HH:MM', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    const localLate = new Date();
    localLate.setHours(23, 50, 0, 0);
    jest.setSystemTime(localLate);

    const until = await callAndCapture(30);
    const end = new Date(localLate.getTime() + 30 * 60000);
    expect(until).toBe(localHHMM(end));
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
