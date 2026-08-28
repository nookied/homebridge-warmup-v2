// LIVE API tests — opt-in. Real credentials, real `api.warmup.com` calls.
// Skipped unless WARMUP_LIVE_TEST=1 (and WARMUP_USERNAME/PASSWORD are set).
//
// Usage:
//   WARMUP_LIVE_TEST=1 \
//   WARMUP_USERNAME=you@example.com \
//   WARMUP_PASSWORD=... \
//     npm test
//
// Optional destructive cycle (toggles a real thermostat off → back to schedule):
//   ... add WARMUP_LIVE_DESTRUCTIVE=1 ...
// This will turn off the entire location for a few seconds. Don't run while
// the heating is needed.

const { Warmup4IE } = require('../../src/lib/warmup4ie');

const liveOn = process.env.WARMUP_LIVE_TEST === '1' &&
               process.env.WARMUP_USERNAME &&
               process.env.WARMUP_PASSWORD;
const liveDescribe = liveOn ? describe : describe.skip;
const WARMUP_RUN_MODES = [
  'not_set',
  'off',
  'schedule',
  'override',
  'fixed',
  'anti_frost',
  'holiday',
  'fil_pilote',
  'gradual',
  'relay',
  'previous'
];

liveDescribe('Warmup4IE — live API', () => {
  let client;

  test('userLogin succeeds with valid credentials and returns at least one room', async () => {
    client = await new Promise((resolve, reject) => {
      const c = new Warmup4IE({
        username: process.env.WARMUP_USERNAME,
        password: process.env.WARMUP_PASSWORD,
        refresh: 60,
        duration: 60
      }, (err, rooms) => {
        if (err) return reject(err);
        expect(Array.isArray(rooms)).toBe(true);
        expect(rooms.length).toBeGreaterThanOrEqual(1);
        rooms.forEach((room) => {
          expect(typeof room.roomId).toBe('number');
          expect(typeof room.roomName).toBe('string');
          expect(WARMUP_RUN_MODES).toContain(room.runMode);
          // Type-shape assertions against the live wire. Offline fixtures
          // only ever prove we still agree with ourselves; this is the one
          // place a change on Warmup's side shows up.
          //
          // Note on drift coverage: a field being *removed* from the schema
          // already fails loudly, because the query itself is rejected and
          // bootstrap throws before we get here. What these catch is a field
          // that still resolves but changes shape — the case that would
          // otherwise degrade a HomeKit feature silently.
          //
          // Every temperature must be a Number of tenths, or null when the
          // reading is genuinely absent. Note `Number.isFinite(Number(v))`
          // would NOT do: `Number(null)` is 0, so a null would pass.
          [room.currentTemp, room.targetTemp, room.airTemp,
            room.floor1Temp, room.floor2Temp]
            .forEach((v) => expect(v === null || typeof v === 'number').toBe(true));
          // Bounds are defaulted when absent, so they are always usable.
          expect(typeof room.minTemp).toBe('number');
          expect(typeof room.maxTemp).toBe('number');
          expect(room.minTemp).toBeLessThan(room.maxTemp);
          // Fields added to the query in v3.4–v3.7, normalized to a fixed
          // type. `lock`/`outputStatus` are legitimately null on devices
          // that don't report them, so null is accepted — a *type* change
          // (say, lock becoming a string) is what would break us.
          expect(room.lock === null || typeof room.lock === 'boolean').toBe(true);
          expect(room.outputStatus === null || typeof room.outputStatus === 'number').toBe(true);
          expect(room.hasThermostat).toBe(true);
        });
        resolve(c);
      });
    });
  }, 30000);

  test('getStatus refreshes the room cache without changing room IDs', async () => {
    const before = client.room
      .filter((r) => r != null)
      .map((r) => r.roomId)
      .sort();

    await client.getStatus();

    const after = client.room
      .filter((r) => r != null)
      .map((r) => r.roomId)
      .sort();

    expect(after).toEqual(before);
  }, 15000);

  // Destructive cycle: turns off the whole location, waits, restores schedule.
  // Gated separately because it briefly stops the heating.
  if (process.env.WARMUP_LIVE_DESTRUCTIVE === '1') {
    test('setRoomOff → setRoomAuto round-trip on first room', async () => {
      const firstRoom = client.room.find((r) => r != null);
      expect(firstRoom).toBeDefined();

      await client.setRoomOff(firstRoom.roomId);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await client.setRoomAuto(firstRoom.roomId);
    }, 30000);
  } else {
    // eslint-disable-next-line jest/no-disabled-tests, jest/expect-expect
    test.skip('setRoomOff → setRoomAuto round-trip (set WARMUP_LIVE_DESTRUCTIVE=1 to enable)', () => {});
  }
});
