/* eslint-env jest */

// End-to-end constructor bootstrap: userLogin → getLocations → getRooms,
// with sequenced fetch responses. Verifies the full happy path resolves
// correctly into the constructor callback.

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { loadFixture, makeResponse, stubFetch } = require('../helpers');

describe('Warmup4IE constructor bootstrap', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  test('happy path: login → locations → rooms resolves with the rooms array', () => {
    const responses = [
      loadFixture('userLogin.success.json'),
      loadFixture('getLocations.success.json'),
      loadFixture('getRooms.success.json')
    ];
    let i = 0;
    restoreFetch = stubFetch(async () => makeResponse(responses[i++]));

    return new Promise((resolve) => {
      const client = new Warmup4IE(
        { username: 'u', password: 'p', refresh: 60, duration: 60 },
        (err, rooms) => {
          expect(err).toBeNull();
          expect(rooms).toHaveLength(3);
          expect(rooms[0].roomName).toBe('Living Room');
          expect(rooms[1].runMode).toBe('off');
          expect(rooms[2].runMode).toBe('override');
          // also verify cache was populated by roomId
          expect(client.room[100001].roomName).toBe('Living Room');
          expect(client.room[100002].runMode).toBe('off');
          resolve();
        }
      );
    });
  });

  test('login fails → constructor callback receives Error, no further requests', () => {
    let calls = 0;
    restoreFetch = stubFetch(async () => {
      calls++;
      return makeResponse(loadFixture('userLogin.error.json'));
    });

    return new Promise((resolve) => {
      new Warmup4IE(
        { username: 'u', password: 'wrong', refresh: 60, duration: 60 },
        (err) => {
          expect(err).toBeInstanceOf(Error);
          expect(err.message).toMatch(/Warmup API/);
          // login is the only call attempted
          expect(calls).toBe(1);
          resolve();
        }
      );
    });
  });

  test('locations empty → constructor callback receives "No locations" error', () => {
    const responses = [
      loadFixture('userLogin.success.json'),
      { status: { result: 'success' }, response: { locations: [] } }
    ];
    let i = 0;
    restoreFetch = stubFetch(async () => makeResponse(responses[i++]));

    return new Promise((resolve) => {
      new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, (err) => {
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/No locations/);
        resolve();
      });
    });
  });

  test('getLocations picks `locations[0]` (multi-location accounts use the first only — by design)', () => {
    const responses = [
      loadFixture('userLogin.success.json'),
      loadFixture('getLocations.success.json'),  // has [{id:12345}, {id:67890}]
      loadFixture('getRooms.success.json')
    ];
    let i = 0;
    let getRoomsBody;
    restoreFetch = stubFetch(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.request.method === 'getRooms') getRoomsBody = body;
      return makeResponse(responses[i++]);
    });

    return new Promise((resolve) => {
      new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => {
        expect(getRoomsBody.request.locId).toBe(12345); // first location id, not 67890
        resolve();
      });
    });
  });

  test('rooms empty → callback resolves with [], no error', () => {
    const responses = [
      loadFixture('userLogin.success.json'),
      loadFixture('getLocations.success.json'),
      loadFixture('getRooms.empty.json')
    ];
    let i = 0;
    restoreFetch = stubFetch(async () => makeResponse(responses[i++]));

    return new Promise((resolve) => {
      new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, (err, rooms) => {
        expect(err).toBeNull();
        expect(rooms).toEqual([]);
        resolve();
      });
    });
  });
});
