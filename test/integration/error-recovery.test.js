/* eslint-env jest */

// A failed poll must not poison subsequent polls. Cache state must be
// preserved across failures, and the next successful poll must converge.
// Also covers the 401 → re-login → retry path added in v2.1.

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { loadFixture, makeResponse, stubFetch } = require('../helpers');

describe('error recovery during polling', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  async function bootstrap(extraResponses = []) {
    const responses = [
      loadFixture('userLogin.success.json'),
      loadFixture('getLocations.success.json'),
      loadFixture('getRooms.success.json'),
      ...extraResponses
    ];
    let i = 0;
    restoreFetch = stubFetch(async () => {
      const next = responses[i++];
      // Allow callers to pre-build full Response-shaped objects (for non-200
      // status simulation) by passing the Response directly; otherwise wrap.
      if (next && typeof next.text === 'function') return next;
      return makeResponse(next);
    });
    return new Promise((resolve) => {
      const c = new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => resolve(c));
    });
  }

  test('failed poll → cache preserved → next successful poll converges', async () => {
    const client = await bootstrap([
      loadFixture('setOperation.error.json'),
      loadFixture('getRooms.success.json')
    ]);

    expect(client.room[100001].roomName).toBe('Living Room');

    await expect(client.getStatus()).rejects.toThrow(/Warmup API/);
    // cache survives the failed poll — old data stays so HomeKit doesn't blank
    expect(client.room[100001].roomName).toBe('Living Room');

    await client.getStatus();
    expect(client.room[100001].roomName).toBe('Living Room');
  });

  test('network failure during poll → throws Error with `Warmup network error:` prefix', async () => {
    const client = await bootstrap();

    // Replace fetch to throw network error
    if (restoreFetch) restoreFetch();
    restoreFetch = stubFetch(async () => { throw new Error('ECONNREFUSED'); });

    await expect(client.getStatus()).rejects.toThrow(/Warmup network error/);
  });

  test('setRoomOff API error → rejects (no silent success)', async () => {
    const client = await bootstrap([loadFixture('setOperation.error.json')]);
    await expect(client.setRoomOff(100001)).rejects.toThrow(/Warmup API/);
  });
});

describe('token refresh on 401', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  test('401 on a write → re-auth → retry once → succeed', async () => {
    // Sequence:
    //   0: userLogin (initial bootstrap)
    //   1: getLocations
    //   2: getRooms (initial bootstrap)
    //   3: setRoomAuto returns 401
    //   4: userLogin (re-auth) returns new token
    //   5: setRoomAuto retried successfully
    const responses = [
      loadFixture('userLogin.success.json'),
      loadFixture('getLocations.success.json'),
      loadFixture('getRooms.success.json'),
      makeResponse({}, { ok: false, status: 401 }),
      { status: { result: 'success' }, response: { token: 'new-token-after-refresh' } },
      { status: { result: 'success' }, response: {} }
    ];
    let i = 0;
    let bodiesSent = [];
    restoreFetch = stubFetch(async (url, init) => {
      bodiesSent.push(JSON.parse(init.body));
      const next = responses[i++];
      if (next && typeof next.text === 'function') return next;
      return makeResponse(next);
    });

    const client = await new Promise((resolve) => {
      const c = new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => resolve(c));
    });

    await client.setRoomAuto(100001);

    // We expect 6 calls: bootstrap (3) + setRoomAuto attempt 1 (1) + re-auth (1) + setRoomAuto retry (1)
    expect(bodiesSent).toHaveLength(6);
    expect(bodiesSent[3].request.method).toBe('setProgramme');
    expect(bodiesSent[4].request.method).toBe('userLogin');
    expect(bodiesSent[5].request.method).toBe('setProgramme');

    // The retry uses the new token (not the old one)
    expect(bodiesSent[5].account.token).toBe('new-token-after-refresh');
    expect(client._token).toBe('new-token-after-refresh');
  });

  test('persistent 401 → fails after one retry (no infinite loop)', async () => {
    const responses = [
      loadFixture('userLogin.success.json'),
      loadFixture('getLocations.success.json'),
      loadFixture('getRooms.success.json'),
      // setRoomAuto fails with 401, re-auth succeeds, retry STILL fails 401
      makeResponse({}, { ok: false, status: 401 }),
      { status: { result: 'success' }, response: { token: 'new-token' } },
      makeResponse({}, { ok: false, status: 401 })
    ];
    let i = 0;
    restoreFetch = stubFetch(async () => {
      const next = responses[i++];
      if (next && typeof next.text === 'function') return next;
      return makeResponse(next);
    });

    const client = await new Promise((resolve) => {
      const c = new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => resolve(c));
    });

    await expect(client.setRoomAuto(100001)).rejects.toThrow('Warmup HTTP 401');
  });
});
