// End-to-end constructor bootstrap: REST userLogin → single GraphQL
// `user.owned[].rooms` query → callback with normalized rooms.
//
// (We use `user.owned[]` rather than `user.location(id: $lid)` because the
// real Warmup mobile app uses the former, and the latter — though present
// in the introspected schema — returns HTTP 409 in practice.)

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { deriveCurrentHeatingState } = require('../../src/lib/state');
const { loadFixture, sequencedFetch, REST_URL, GRAPHQL_URL } = require('../helpers');

describe('Warmup4IE constructor bootstrap (REST login + GraphQL owned[])', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  test('happy path: REST login → GraphQL owned[] → callback rooms[]', () => {
    restoreFetch = sequencedFetch([
      { url: REST_URL, body: loadFixture('userLogin.success.json') },
      { url: GRAPHQL_URL, body: loadFixture('graphql.owned.json') }
    ]);

    return new Promise((resolve) => {
      const client = new Warmup4IE(
        { username: 'u', password: 'p', refresh: 60, duration: 60 },
        (err, rooms) => {
          expect(err).toBeNull();
          expect(rooms).toHaveLength(3);
          // GraphQL Room.id → normalized as roomId
          expect(rooms[0].roomId).toBe(100001);
          expect(rooms[0].roomName).toBe('Living Room');
          expect(rooms[1].runMode).toBe('off');
          expect(rooms[2].runMode).toBe('override');
          // airTemp arrives as a String on Thermostat4iE ("215") and is
          // normalized to a Number of tenths, so every temperature field the
          // platform divides by 10 has one consistent type.
          expect(rooms[0].airTemp).toBe(215);
          // minTemp/maxTemp pulled from thermostat4ies[0]
          expect(rooms[0].minTemp).toBe(50);
          expect(rooms[0].maxTemp).toBe(300);
          // Fields added to the query in v3.4–v3.7 — the fixture carried none
          // of them until v3.12.0, so nothing exercised their wire path.
          expect(rooms[0].total).toBe('345.678');
          expect(rooms[0].appFw).toBe('29.175');
          expect(rooms[0].wifiFw).toBe('2.1.0');
          expect(rooms[0].outputStatus).toBe(1);
          // parameters.lock is an Int (0/1) on the wire, Boolean in our shape.
          expect(rooms[0].lock).toBe(false);
          expect(rooms[1].lock).toBe(true);
          // Bathroom: relay reports idle (outputStatus 0) even though
          // currentTemp (220) is below targetTemp (230). The old temp-delta
          // heuristic would say "heating"; the real relay signal wins.
          expect(rooms[2].outputStatus).toBe(0);
          expect(deriveCurrentHeatingState(rooms[2])).toBe(0);
          // appFw is null on this device — FirmwareRevision falls back.
          expect(rooms[2].appFw).toBeNull();
          // also verify cache populated by roomId, and locId set from owned[0]
          expect(client.room[100001].roomName).toBe('Living Room');
          expect(client.room[100002].runMode).toBe('off');
          expect(client._locId).toBe(12345);
          resolve();
        }
      );
    });
  });

  test('room with no paired thermostat → safe defaults, never NaN', () => {
    restoreFetch = sequencedFetch([
      { url: REST_URL, body: loadFixture('userLogin.success.json') },
      { url: GRAPHQL_URL, body: loadFixture('graphql.owned.unpaired.json') }
    ]);

    return new Promise((resolve) => {
      new Warmup4IE(
        { username: 'u', password: 'p', refresh: 60, duration: 60 },
        (err, rooms) => {
          expect(err).toBeNull();
          expect(rooms).toHaveLength(1);
          const r = rooms[0];
          // Every Thermostat4iE-level field is absent. minTemp/maxTemp feed
          // HomeKit's TargetTemperature bounds, so they must be usable
          // numbers — `undefined / 10` is NaN and HAP rejects that outright.
          expect(r.minTemp).toBe(50);
          expect(r.maxTemp).toBe(300);
          expect(Number.isFinite(r.minTemp / 10)).toBe(true);
          expect(Number.isFinite(r.maxTemp / 10)).toBe(true);
          // No air probe at all — null, so the platform can distinguish
          // "no reading" from a real 0 °C and skip the write entirely.
          expect(r.airTemp).toBeNull();
          // Thermostat-only metadata is absent rather than garbage.
          expect(r.outputStatus).toBeNull();
          expect(r.lock).toBeNull();
          // Room-level fields still come through normally.
          expect(r.roomId).toBe(100001);
          expect(r.currentTemp).toBe(205);
          resolve();
        }
      );
    });
  });

  test('login fails → callback receives Error, no GraphQL calls follow', () => {
    let calls = 0;
    restoreFetch = sequencedFetch([
      { url: REST_URL, body: loadFixture('userLogin.error.json') }
    ]);
    const orig = globalThis.fetch;
    globalThis.fetch = jest.fn(async (...args) => { calls++; return orig(...args); });

    return new Promise((resolve) => {
      new Warmup4IE(
        { username: 'u', password: 'wrong', refresh: 60, duration: 60 },
        (err) => {
          expect(err).toBeInstanceOf(Error);
          // The fixture is the exact payload the live API returns for a bad
          // email/password pair: no prose anywhere, just `errorCode: 101`.
          // Assert the decoded message, not merely the `Warmup API` prefix —
          // a loose match here is what let `Warmup API: {"result":"error"}`
          // ship as the log line users saw for the commonest failure.
          expect(err.message).toBe('Warmup API: invalid email or password (errorCode 101)');
          expect(calls).toBe(1);
          resolve();
        }
      );
    });
  });

  test('login without token → callback receives a clear error, no GraphQL calls follow', () => {
    let calls = 0;
    restoreFetch = sequencedFetch([
      { url: REST_URL, body: { status: { result: 'success' }, response: {} } }
    ]);
    const orig = globalThis.fetch;
    globalThis.fetch = jest.fn(async (...args) => { calls++; return orig(...args); });

    return new Promise((resolve) => {
      new Warmup4IE(
        { username: 'u', password: 'p', refresh: 60, duration: 60 },
        (err) => {
          expect(err).toBeInstanceOf(Error);
          expect(err.message).toMatch(/login response did not include a token/);
          expect(calls).toBe(1);
          resolve();
        }
      );
    });
  });

  test('owned[] empty → callback receives "No locations" error', () => {
    restoreFetch = sequencedFetch([
      { url: REST_URL, body: loadFixture('userLogin.success.json') },
      { url: GRAPHQL_URL, body: loadFixture('graphql.owned.empty.json') }
    ]);

    return new Promise((resolve) => {
      new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, (err) => {
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/No locations/);
        resolve();
      });
    });
  });

  test('owned[0] is selected — multi-location accounts use the first only', () => {
    restoreFetch = sequencedFetch([
      { url: REST_URL, body: loadFixture('userLogin.success.json') },
      { url: GRAPHQL_URL, body: loadFixture('graphql.owned.json') }
    ]);

    return new Promise((resolve) => {
      const client = new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => {
        // owned[0].id is 12345; owned[1].id is 67890. We use 12345.
        expect(client._locId).toBe(12345);
        // The 67890 location's rooms (empty) are NOT in our cache
        expect(client.room.filter((r) => r != null).map((r) => r.roomId).sort()).toEqual([100001, 100002, 100003]);
        resolve();
      });
    });
  });

  test('owned[0] with empty rooms → callback resolves with [], no error', () => {
    const fixture = JSON.parse(JSON.stringify(loadFixture('graphql.owned.json')));
    fixture.data.user.owned[0].rooms = [];
    restoreFetch = sequencedFetch([
      { url: REST_URL, body: loadFixture('userLogin.success.json') },
      { url: GRAPHQL_URL, body: fixture }
    ]);

    return new Promise((resolve) => {
      new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, (err, rooms) => {
        expect(err).toBeNull();
        expect(rooms).toEqual([]);
        resolve();
      });
    });
  });
});
