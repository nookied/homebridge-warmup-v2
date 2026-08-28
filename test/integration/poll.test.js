// Polling cycle: state changes between polls must propagate into
// `this.room[roomId]` so the platform's per-accessory snapshot can refresh.

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { loadFixture, sequencedFetch, REST_URL, GRAPHQL_URL } = require('../helpers');

describe('Warmup4IE polling', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  async function bootstrap(extraResponses = []) {
    restoreFetch = sequencedFetch([
      { url: REST_URL, body: loadFixture('userLogin.success.json') },
      { url: GRAPHQL_URL, body: loadFixture('graphql.owned.json') },
      ...extraResponses
    ]);
    return new Promise((resolve) => {
      const c = new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => resolve(c));
    });
  }

  test('getStatus on a freshly bootstrapped client refreshes this.room', async () => {
    const updated = JSON.parse(JSON.stringify(loadFixture('graphql.owned.json')));
    updated.data.user.owned[0].rooms[1].runMode = 'schedule';
    updated.data.user.owned[0].rooms[1].currentTemp = 200;

    const client = await bootstrap([{ url: GRAPHQL_URL, body: updated }]);

    expect(client.room[100002].runMode).toBe('off');

    await client.getStatus();
    expect(client.room[100002].runMode).toBe('schedule');
    expect(client.room[100002].currentTemp).toBe(200);
  });

  test('multiple polls do not duplicate — each call fully replaces this.room[roomId]', async () => {
    const client = await bootstrap([
      { url: GRAPHQL_URL, body: loadFixture('graphql.owned.json') },
      { url: GRAPHQL_URL, body: loadFixture('graphql.owned.json') }
    ]);

    await client.getStatus();
    await client.getStatus();

    const populated = client.room.filter((r) => r != null);
    expect(populated).toHaveLength(3);
  });

  test('rooms removed from Warmup disappear from the cache on the next poll', async () => {
    const updated = JSON.parse(JSON.stringify(loadFixture('graphql.owned.json')));
    updated.data.user.owned[0].rooms = updated.data.user.owned[0].rooms.filter((room) => room.id !== 100002);

    const client = await bootstrap([{ url: GRAPHQL_URL, body: updated }]);

    expect(client.room[100002].roomName).toBe('Bedroom');

    await client.getStatus();
    expect(client.room[100001].roomName).toBe('Living Room');
    expect(client.room[100002]).toBeUndefined();
    expect(client.room[100003].roomName).toBe('Bathroom');
  });
});
