/* eslint-env jest */

// Polling cycle: state changes between polls must propagate into
// `this.room[roomId]` so the platform's per-accessory snapshot can refresh.

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { loadFixture, makeResponse, stubFetch } = require('../helpers');

describe('Warmup4IE polling', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  async function bootstrap(extraResponses = []) {
    const initial = loadFixture('getRooms.success.json');
    const responses = [
      loadFixture('userLogin.success.json'),
      loadFixture('getLocations.success.json'),
      initial,
      ...extraResponses
    ];
    let i = 0;
    restoreFetch = stubFetch(async () => makeResponse(responses[i++]));

    return new Promise((resolve) => {
      const c = new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => resolve(c));
    });
  }

  test('getStatus on a freshly bootstrapped client refreshes this.room', async () => {
    const updated = JSON.parse(JSON.stringify(loadFixture('getRooms.success.json')));
    updated.response.rooms[1].runMode = 'schedule';
    updated.response.rooms[1].currentTemp = 200;

    const client = await bootstrap([updated]);

    expect(client.room[100002].runMode).toBe('off');

    await client.getStatus();
    expect(client.room[100002].runMode).toBe('schedule');
    expect(client.room[100002].currentTemp).toBe(200);
  });

  test('multiple polls do not duplicate — each call fully replaces this.room[roomId]', async () => {
    const client = await bootstrap([
      loadFixture('getRooms.success.json'),
      loadFixture('getRooms.success.json')
    ]);

    await client.getStatus();
    await client.getStatus();

    // Sparse array — only the three roomIds we have should be populated
    const populated = client.room.filter((r) => r != null);
    expect(populated).toHaveLength(3);
  });
});
