// A failed poll/write must not poison subsequent calls. Cache state must be
// preserved across failures, and the next successful call must converge.
// Also covers the 401 / token-expired → re-login → retry path.

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { loadFixture, sequencedFetch, makeResponse, REST_URL, GRAPHQL_URL } = require('../helpers');

describe('error recovery', () => {
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

  test('failed poll → cache preserved → next successful poll converges', async () => {
    const client = await bootstrap([
      { url: GRAPHQL_URL, body: loadFixture('graphql.error.json') },
      { url: GRAPHQL_URL, body: loadFixture('graphql.owned.json') }
    ]);

    expect(client.room[100001].roomName).toBe('Living Room');

    await expect(client.getStatus()).rejects.toThrow(/Warmup GraphQL/);
    // cache survives the failed poll
    expect(client.room[100001].roomName).toBe('Living Room');

    await client.getStatus();
    expect(client.room[100001].roomName).toBe('Living Room');
  });

  test('setRoomOff API error → rejects (no silent success)', async () => {
    const client = await bootstrap([{ url: GRAPHQL_URL, body: loadFixture('graphql.error.json') }]);
    const before = { ...client.room[100001] };

    await expect(client.setRoomOff(100001)).rejects.toThrow(/Warmup GraphQL/);
    expect(client.room[100001]).toEqual(before);
  });
});

describe('token refresh on 401', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  test('401 on a write → re-auth → retry once → succeed', async () => {
    // Sequence:
    //   0: REST userLogin (initial bootstrap)
    //   1: GraphQL owned[] (bootstrap)
    //   2: GraphQL setRoomAuto returns 401
    //   3: REST userLogin (re-auth) — new token
    //   4: GraphQL setRoomAuto retried successfully
    let bodiesSent = [];
    restoreFetch = sequencedFetch([
      { url: REST_URL, body: loadFixture('userLogin.success.json') },
      { url: GRAPHQL_URL, body: loadFixture('graphql.owned.json') },
      { url: GRAPHQL_URL, response: makeResponse({}, { ok: false, status: 401 }) },
      { url: REST_URL, body: { status: { result: 'success' }, response: { token: 'new-token' } } },
      { url: GRAPHQL_URL, body: loadFixture('graphql.mutation.success.json') }
    ]);

    const orig = globalThis.fetch;
    globalThis.fetch = jest.fn(async (url, init) => {
      bodiesSent.push({ url, body: JSON.parse(init.body), authHeader: init.headers['warmup-authorization'] });
      return orig(url, init);
    });

    const client = await new Promise((resolve) => {
      const c = new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => resolve(c));
    });

    await client.setRoomAuto(100001);

    // 5 calls: bootstrap(2) + setRoomAuto attempt(1) + re-auth(1) + retry(1)
    expect(bodiesSent).toHaveLength(5);
    expect(bodiesSent[2].body.query).toMatch(/DeviceProgram/);
    expect(bodiesSent[3].body.request.method).toBe('userLogin');
    expect(bodiesSent[4].body.query).toMatch(/DeviceProgram/);

    // Retry uses new token via warmup-authorization header
    expect(bodiesSent[4].authHeader).toBe('new-token');
    expect(client._token).toBe('new-token');
  });

  test('persistent 401 → fails after one retry (no infinite loop)', async () => {
    restoreFetch = sequencedFetch([
      { url: REST_URL, body: loadFixture('userLogin.success.json') },
      { url: GRAPHQL_URL, body: loadFixture('graphql.owned.json') },
      // setRoomAuto fails with 401, re-auth succeeds, retry STILL fails 401
      { url: GRAPHQL_URL, response: makeResponse({}, { ok: false, status: 401 }) },
      { url: REST_URL, body: { status: { result: 'success' }, response: { token: 'new-token' } } },
      { url: GRAPHQL_URL, response: makeResponse({}, { ok: false, status: 401 }) }
    ]);

    const client = await new Promise((resolve) => {
      const c = new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => resolve(c));
    });

    await expect(client.setRoomAuto(100001)).rejects.toThrow('Warmup HTTP 401');
  });
});
