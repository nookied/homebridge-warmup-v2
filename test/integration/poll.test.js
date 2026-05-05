/* eslint-env jest */

// Polling cycle: state changes between polls must propagate into
// `this.room[roomId]` so the platform's per-accessory snapshot can refresh.

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { loadFixture, makeResponse, stubFetch } = require('../helpers');

describe('Warmup4IE polling', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  test('getStatus on a freshly bootstrapped client refreshes this.room', async () => {
    const initial = loadFixture('getRooms.success.json');
    const bootstrapResponses = [
      loadFixture('userLogin.success.json'),
      loadFixture('getLocations.success.json'),
      initial
    ];

    // Build a flipped second poll: room 100002 transitions off → schedule
    const updated = JSON.parse(JSON.stringify(initial));
    updated.response.rooms[1].runMode = 'schedule';
    updated.response.rooms[1].currentTemp = 200;

    const responses = [...bootstrapResponses, updated];
    let i = 0;
    restoreFetch = stubFetch(async () => makeResponse(responses[i++]));

    const client = await new Promise((resolve) => {
      const c = new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => resolve(c));
    });

    expect(client.room[100002].runMode).toBe('off');

    await new Promise((resolve) => {
      client.getStatus((err) => {
        expect(err).toBeNull();
        expect(client.room[100002].runMode).toBe('schedule');
        expect(client.room[100002].currentTemp).toBe(200);
        resolve();
      });
    });
  });

  test('multiple polls do not duplicate — each call fully replaces this.room[roomId]', async () => {
    const responses = [
      loadFixture('userLogin.success.json'),
      loadFixture('getLocations.success.json'),
      loadFixture('getRooms.success.json'),
      loadFixture('getRooms.success.json'),
      loadFixture('getRooms.success.json')
    ];
    let i = 0;
    restoreFetch = stubFetch(async () => makeResponse(responses[i++]));

    const client = await new Promise((resolve) => {
      const c = new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => resolve(c));
    });

    await new Promise((resolve) => client.getStatus(() => resolve()));
    await new Promise((resolve) => client.getStatus(() => resolve()));

    // Sparse array — only the three roomIds we have should be populated
    const populated = client.room.filter((r) => r != null);
    expect(populated).toHaveLength(3);
  });
});
