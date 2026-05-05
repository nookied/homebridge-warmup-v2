/* eslint-env jest */

// A failed poll must not poison subsequent polls. Cache state must be
// preserved across failures, and the next successful poll must converge.

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { loadFixture, makeResponse, stubFetch } = require('../helpers');

describe('error recovery during polling', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  test('failed poll → cache preserved → next successful poll converges', async () => {
    const responses = [
      loadFixture('userLogin.success.json'),
      loadFixture('getLocations.success.json'),
      loadFixture('getRooms.success.json'),
      // poll 1: API error
      makeResponse(loadFixture('setOperation.error.json')),
      // poll 2: success
      makeResponse(loadFixture('getRooms.success.json'))
    ];
    let i = 0;
    restoreFetch = stubFetch(async () => i < 3 ? makeResponse(responses[i++]) : responses[i++]);

    const client = await new Promise((resolve) => {
      const c = new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => resolve(c));
    });

    const beforeFailure = client.room[100001].roomName;
    expect(beforeFailure).toBe('Living Room');

    await new Promise((resolve) => {
      client.getStatus((err) => {
        expect(err).toBeInstanceOf(Error);
        // cache survives the failed poll — old data stays so HomeKit doesn't blank
        expect(client.room[100001].roomName).toBe('Living Room');
        resolve();
      });
    });

    await new Promise((resolve) => {
      client.getStatus((err) => {
        expect(err).toBeNull();
        expect(client.room[100001].roomName).toBe('Living Room');
        resolve();
      });
    });
  });

  test('network failure during poll → callback receives Error', async () => {
    const responses = [
      loadFixture('userLogin.success.json'),
      loadFixture('getLocations.success.json'),
      loadFixture('getRooms.success.json')
    ];
    let i = 0;
    restoreFetch = stubFetch(async () => {
      if (i < 3) return makeResponse(responses[i++]);
      throw new Error('ECONNREFUSED');
    });

    const client = await new Promise((resolve) => {
      const c = new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => resolve(c));
    });

    return new Promise((resolve) => {
      client.getStatus((err) => {
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/Warmup network error/);
        resolve();
      });
    });
  });

  test('setRoomOff API error → callback surfaces it (no silent success)', async () => {
    const responses = [
      loadFixture('userLogin.success.json'),
      loadFixture('getLocations.success.json'),
      loadFixture('getRooms.success.json'),
      loadFixture('setOperation.error.json')
    ];
    let i = 0;
    restoreFetch = stubFetch(async () => makeResponse(responses[i++]));

    const client = await new Promise((resolve) => {
      const c = new Warmup4IE({ username: 'u', password: 'p', refresh: 60, duration: 60 }, () => resolve(c));
    });

    return new Promise((resolve) => {
      client.setRoomOff(100001, (err) => {
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/Warmup API/);
        resolve();
      });
    });
  });
});
