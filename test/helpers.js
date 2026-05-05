'use strict';

// Shared test helpers — fetch stubbing, response builders, fixture loading.

const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');

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

// Build a stubbed `Warmup4IE` instance whose `_sendRequest` captures bodies
// instead of touching the network. Used for builder-shape assertions.
function stubClient(Warmup4IE, captureInto, response = { status: { result: 'success' }, response: {} }) {
  const fakeClient = Object.create(Warmup4IE.prototype);
  fakeClient._username = 'user@example.com';
  fakeClient._duration = 60;
  fakeClient.room = [];
  fakeClient._sendRequest = (body, cb) => {
    captureInto.push(body);
    cb(null, response);
  };
  return fakeClient;
}

module.exports = { loadFixture, makeResponse, stubFetch, stubClient };
