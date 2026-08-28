// Transport seam tests: `_fetch` is the lone HTTP helper. `_rest` and
// `_graphql` wrap it with protocol-specific success-checking. These tests
// stub `globalThis.fetch` to verify every error/success path.

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { makeResponse, stubFetch, REST_URL, GRAPHQL_URL } = require('../helpers');

function newClient() {
  const c = Object.create(Warmup4IE.prototype);
  c._username = 'user@example.com';
  c._password = 'secret';
  c._token = 'mock-token';
  c._locId = 12345;
  c._duration = 60;
  c.room = [];
  return c;
}

describe('_fetch (generic HTTP)', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  test('success: 2xx + parseable JSON → resolves with parsed JSON', async () => {
    restoreFetch = stubFetch(async () => makeResponse({ foo: 'bar' }));
    const json = await newClient()._fetch('https://example.com', { x: 1 });
    expect(json.foo).toBe('bar');
  });

  test('HTTP 401 → rejects with `Warmup HTTP 401`', async () => {
    restoreFetch = stubFetch(async () => makeResponse({}, { ok: false, status: 401 }));
    await expect(newClient()._fetch('https://example.com', {})).rejects.toThrow('Warmup HTTP 401');
  });

  test('HTTP 500 → rejects with `Warmup HTTP 500`', async () => {
    restoreFetch = stubFetch(async () => makeResponse({}, { ok: false, status: 500 }));
    await expect(newClient()._fetch('https://example.com', {})).rejects.toThrow('Warmup HTTP 500');
  });

  test('network error → rejects with `Warmup network error:` prefix', async () => {
    restoreFetch = stubFetch(async () => { throw new Error('ECONNREFUSED'); });
    await expect(newClient()._fetch('https://example.com', {})).rejects.toThrow(/Warmup network error/);
  });

  test('invalid JSON → rejects with `Warmup JSON parse error:` prefix', async () => {
    restoreFetch = stubFetch(async () => ({ ok: true, status: 200, text: async () => 'not json {' }));
    await expect(newClient()._fetch('https://example.com', {})).rejects.toThrow(/Warmup JSON parse error/);
  });

  test('sets a 10 s AbortSignal.timeout on the request', async () => {
    let capturedSignal;
    restoreFetch = stubFetch(async (url, init) => {
      capturedSignal = init.signal;
      return makeResponse({ ok: true });
    });
    await newClient()._fetch('https://example.com', {});
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  test('merges extra headers (used for warmup-authorization on GraphQL)', async () => {
    let captured;
    restoreFetch = stubFetch(async (url, init) => {
      captured = init;
      return makeResponse({});
    });
    await newClient()._fetch('https://example.com', {}, { 'warmup-authorization': 'tok' });
    expect(captured.headers['warmup-authorization']).toBe('tok');
    expect(captured.headers['app-token']).toBeDefined(); // standard headers preserved
  });
});

describe('_rest (login transport)', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  test('posts to REST_URL with REST body shape', async () => {
    let url;
    restoreFetch = stubFetch(async (u) => {
      url = u;
      return makeResponse({ status: { result: 'success' }, response: { token: 'abc' } });
    });
    await newClient()._rest({ request: { method: 'userLogin' } });
    expect(url).toBe(REST_URL);
  });

  test('REST status.result=error → rejects with `Warmup API:` prefix', async () => {
    restoreFetch = stubFetch(async () => makeResponse({ status: { result: 'error', message: 'Bad creds' } }));
    await expect(newClient()._rest({ request: { method: 'userLogin' } }))
      .rejects.toThrow(/Warmup API: .*Bad creds/);
  });

  // Warmup puts the useful signal in `response.errorCode` and sends no prose
  // at all for the commonest failure. Each shape below is a real one the
  // gateway can return; none may degrade to `Warmup API: {"result":"error"}`.
  describe('error detail decoding', () => {
    // Stub the login response and hand back the rejected promise to assert on.
    const login = (body) => {
      restoreFetch = stubFetch(async () => makeResponse(body));
      return newClient()._rest({ request: { method: 'userLogin' } });
    };

    test('errorCode alone → mapped prose plus the raw code', async () => {
      // Captured verbatim from the live API on 2026-08-28.
      await expect(login({ status: { result: 'error' }, response: { errorCode: 101 } }))
        .rejects.toThrow('Warmup API: invalid email or password (errorCode 101)');
    });

    test('API prose wins over our mapping, code still appended', async () => {
      await expect(login({ status: { result: 'error' }, message: 'Account locked', response: { errorCode: 101 } }))
        .rejects.toThrow('Warmup API: Account locked (errorCode 101)');
    });

    test('prose with no code → prose alone', async () => {
      await expect(login({ status: { result: 'error', message: 'Service unavailable' } }))
        .rejects.toThrow('Warmup API: Service unavailable');
    });

    test('unmapped code → still reports the number, not a JSON blob', async () => {
      await expect(login({ status: { result: 'error' }, response: { errorCode: 999 } }))
        .rejects.toThrow('Warmup API: errorCode 999');
    });

    test('neither prose nor code → falls back to the status object', async () => {
      await expect(login({ status: { result: 'error' } }))
        .rejects.toThrow('Warmup API: {"result":"error"}');
    });
  });
});

describe('_graphql (everything else)', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); });

  test('posts to GRAPHQL_URL with { query, variables } body', async () => {
    let capturedBody, capturedUrl;
    restoreFetch = stubFetch(async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return makeResponse({ data: { foo: 'bar' } });
    });
    await newClient()._graphql('query Foo { foo }', { x: 1 });
    expect(capturedUrl).toBe(GRAPHQL_URL);
    expect(capturedBody).toEqual({ query: 'query Foo { foo }', variables: { x: 1 } });
  });

  test('passes warmup-authorization header from the instance token', async () => {
    let captured;
    restoreFetch = stubFetch(async (url, init) => {
      captured = init.headers;
      return makeResponse({ data: {} });
    });
    const c = newClient();
    c._token = 'my-token';
    await c._graphql('query {}');
    expect(captured['warmup-authorization']).toBe('my-token');
  });

  test('GraphQL errors[] → rejects with `Warmup GraphQL:` prefix', async () => {
    restoreFetch = stubFetch(async () => makeResponse({ data: null, errors: [{ message: 'Not authorized' }] }));
    await expect(newClient()._graphql('query {}')).rejects.toThrow(/Warmup GraphQL: .*Not authorized/);
  });

  test('returns data only (not the full envelope)', async () => {
    restoreFetch = stubFetch(async () => makeResponse({ data: { user: { locations: [{ id: 1 }] } } }));
    const data = await newClient()._graphql('query {}');
    expect(data.user.locations[0].id).toBe(1);
  });
});

describe('_isTokenError', () => {
  test('Warmup HTTP 401 is a token error', () => {
    expect(newClient()._isTokenError(new Error('Warmup HTTP 401'))).toBe(true);
  });

  test('Warmup HTTP 500 is NOT a token error', () => {
    expect(newClient()._isTokenError(new Error('Warmup HTTP 500'))).toBe(false);
  });

  test('REST API error code 103 (token expired) is a token error', () => {
    expect(newClient()._isTokenError(new Error('Warmup API: {"result":"error","code":103}'))).toBe(true);
  });

  test('REST API error code 100 (bad creds) is a token error', () => {
    expect(newClient()._isTokenError(new Error('Warmup API: {"result":"error","code":100}'))).toBe(true);
  });

  test('REST API error code 500 is NOT a token error', () => {
    expect(newClient()._isTokenError(new Error('Warmup API: {"result":"error","code":500}'))).toBe(false);
  });

  test('GraphQL "token" message is a token error', () => {
    expect(newClient()._isTokenError(new Error('Warmup GraphQL: Invalid token'))).toBe(true);
  });

  test('GraphQL "Unauthorized" message is a token error', () => {
    expect(newClient()._isTokenError(new Error('Warmup GraphQL: Unauthorized request'))).toBe(true);
  });

  test('GraphQL "Operation failed" is NOT a token error', () => {
    expect(newClient()._isTokenError(new Error('Warmup GraphQL: Operation failed'))).toBe(false);
  });

  test('network error is NOT a token error', () => {
    expect(newClient()._isTokenError(new Error('Warmup network error: ECONNREFUSED'))).toBe(false);
  });
});
