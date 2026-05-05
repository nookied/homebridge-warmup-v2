'use strict';

// Shared test helpers — fetch stubbing, response builders, fixture loading.

const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');
const REST_URL = 'https://api.warmup.com/apps/app/v1';
const GRAPHQL_URL = 'https://apil.warmup.com/graphql';

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

// Build a Response-like object that the lib's `_fetch` will accept.
// We use plain objects (not real `Response` instances) because the lib only
// ever calls `response.ok`, `response.status`, and `await response.text()`.
function makeResponse(body, { ok = true, status = 200 } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok, status, text: async () => text };
}

// Stub `globalThis.fetch` per-test. Returns a `restore()` function.
function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = jest.fn(impl);
  return () => { globalThis.fetch = original; };
}

// Build a stubbed `Warmup4IE` instance whose `_graphql` is pre-replaced to
// capture `(query, variables)` instead of touching the network. Used for
// builder-shape assertions where we only care about the wire format.
//
// Returns `(client, captured)` — capture array contains
// `[{ query, variables }, ...]` in call order.
function stubGraphQLClient(Warmup4IE, { graphqlResponse = {}, captureInto = [] } = {}) {
  const c = Object.create(Warmup4IE.prototype);
  c._username = 'user@example.com';
  c._password = 'secret';
  c._duration = 60;
  c._token = 'mock-token';
  c._locId = 12345;
  c.room = [];
  c._graphql = async (query, variables) => {
    captureInto.push({ query, variables });
    return graphqlResponse;
  };
  c._login = async () => { c._token = 'refreshed-token'; };
  return { client: c, captured: captureInto };
}

// Sequenced URL-aware fetch stubber. Pass an array of responses keyed by
// URL pattern. Useful for full bootstrap tests that exercise REST `_login`
// then a series of GraphQL calls.
//
//   sequencer([
//     { url: REST_URL, body: { ... }},
//     { url: GRAPHQL_URL, body: { data: { ... } } }
//   ])
function sequencedFetch(responses) {
  let i = 0;
  return stubFetch(async (url) => {
    const next = responses[i++];
    if (!next) throw new Error(`sequencedFetch: ran out of responses at index ${i - 1}`);
    if (next.url && next.url !== url) {
      throw new Error(`sequencedFetch: expected URL ${next.url}, got ${url}`);
    }
    if (next.response) return next.response;
    return makeResponse(next.body, next.opts);
  });
}

module.exports = {
  loadFixture,
  makeResponse,
  stubFetch,
  stubGraphQLClient,
  sequencedFetch,
  REST_URL,
  GRAPHQL_URL
};
