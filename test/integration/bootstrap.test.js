/* eslint-env jest */

// End-to-end constructor bootstrap: REST userLogin → single GraphQL
// `user.owned[].rooms` query → callback with normalized rooms.
//
// (We use `user.owned[]` rather than `user.location(id: $lid)` because the
// real Warmup mobile app uses the former, and the latter — though present
// in the introspected schema — returns HTTP 409 in practice.)

const { Warmup4IE } = require('../../src/lib/warmup4ie');
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
          // airTemp pulled from thermostat4ies[0].airTemp (string in schema)
          expect(rooms[0].airTemp).toBe('215');
          // minTemp/maxTemp pulled from thermostat4ies[0]
          expect(rooms[0].minTemp).toBe(50);
          expect(rooms[0].maxTemp).toBe(300);
          // also verify cache populated by roomId, and locId set from owned[0]
          expect(client.room[100001].roomName).toBe('Living Room');
          expect(client.room[100002].runMode).toBe('off');
          expect(client._locId).toBe(12345);
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
          expect(err.message).toMatch(/Warmup API/);
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
