/* eslint-env jest */

// `_fetch` is the lone transport seam — it builds the HTTP request and
// classifies the response. These tests stub `globalThis.fetch` to verify
// every error/success path.

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { makeResponse, stubFetch } = require('../helpers');

function newClient() {
  // bypass the constructor's bootstrap (no callback → no network call)
  const c = Object.create(Warmup4IE.prototype);
  c._username = 'user@example.com';
  c._password = 'secret';
  c._duration = 60;
  c.room = [];
  return c;
}

describe('_fetch', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  test('success: 200 + status.result=success → resolves with parsed JSON', async () => {
    restoreFetch = stubFetch(async () => makeResponse({ status: { result: 'success' }, response: { ok: 1 } }));
    const json = await newClient()._fetch({ request: { method: 'getRooms' } });
    expect(json.response.ok).toBe(1);
  });

  test('API error: 200 + status.result=error → rejects with `Warmup API:` prefix', async () => {
    restoreFetch = stubFetch(async () => makeResponse({ status: { result: 'error', message: 'Bad creds' } }));
    await expect(newClient()._fetch({ request: { method: 'userLogin' } }))
      .rejects.toThrow(/Warmup API: .*Bad creds|^Warmup API: /);
  });

  test('HTTP 401 → rejects with `Warmup HTTP 401`', async () => {
    restoreFetch = stubFetch(async () => makeResponse({}, { ok: false, status: 401 }));
    await expect(newClient()._fetch({}))
      .rejects.toThrow('Warmup HTTP 401');
  });

  test('HTTP 500 → rejects with `Warmup HTTP 500`', async () => {
    restoreFetch = stubFetch(async () => makeResponse({}, { ok: false, status: 500 }));
    await expect(newClient()._fetch({}))
      .rejects.toThrow('Warmup HTTP 500');
  });

  test('network error → rejects with `Warmup network error:` prefix', async () => {
    restoreFetch = stubFetch(async () => { throw new Error('ECONNREFUSED 1.2.3.4:443'); });
    await expect(newClient()._fetch({}))
      .rejects.toThrow(/Warmup network error: ECONNREFUSED/);
  });

  test('invalid JSON → rejects with `Warmup JSON parse error:` prefix', async () => {
    restoreFetch = stubFetch(async () => ({ ok: true, status: 200, text: async () => 'not json {' }));
    await expect(newClient()._fetch({}))
      .rejects.toThrow(/Warmup JSON parse error/);
  });

  test('passes the body verbatim as POST JSON to TOKEN_URL', async () => {
    let capturedUrl, capturedInit;
    restoreFetch = stubFetch(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return makeResponse({ status: { result: 'success' }, response: {} });
    });
    await newClient()._fetch({ request: { method: 'getRooms', locId: 1 } });

    expect(capturedUrl).toBe('https://api.warmup.com/apps/app/v1');
    expect(capturedInit.method).toBe('POST');
    expect(JSON.parse(capturedInit.body)).toEqual({ request: { method: 'getRooms', locId: 1 } });
    expect(capturedInit.headers['app-token']).toBeDefined();
    expect(capturedInit.headers['user-agent']).toBe('WARMUP_APP');
  });

  test('sets a 10 s AbortSignal.timeout on the request', async () => {
    let capturedSignal;
    restoreFetch = stubFetch(async (url, init) => {
      capturedSignal = init.signal;
      return makeResponse({ status: { result: 'success' }, response: {} });
    });
    await newClient()._fetch({});
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('_sendRequest (callback wrapper around _fetch)', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  test('callback receives (null, json) on success', () => {
    restoreFetch = stubFetch(async () => makeResponse({ status: { result: 'success' }, response: { x: 1 } }));
    return new Promise((resolve) => {
      newClient()._sendRequest({}, (err, json) => {
        expect(err).toBeNull();
        expect(json.response.x).toBe(1);
        resolve();
      });
    });
  });

  test('callback receives (Error) on API rejection', () => {
    restoreFetch = stubFetch(async () => makeResponse({ status: { result: 'error', message: 'nope' } }));
    return new Promise((resolve) => {
      newClient()._sendRequest({}, (err) => {
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/Warmup API/);
        resolve();
      });
    });
  });
});
