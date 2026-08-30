// CI guard for the vendored copy of fakegato-history (added in v3.13.1).
//
// Everything else in this repository deliberately looks away from src/vendor/:
//
//   - `eslint.config.mjs` ignores the directory, so the copy stays diffable
//     against upstream.
//   - `platform-state.test.js` mocks the module, because the real one touches
//     disk.
//
// The effect was that ~900 lines of shipped runtime code had no automated
// coverage at all, and the runtime failure mode is silent:
// `loadFakeGatoHistory()` in src/index.js catches a failed require, sets the
// service to null, and logs only at debug level. A broken copy therefore
// produces a clean startup log and no Eve history — a regression nobody would
// notice for months, and one the vendoring itself made possible.
//
// These tests do the smallest thing that would catch it: load the factory
// exactly as src/index.js does, drive the fs storage path that the Google
// Drive removal actually touched, and assert that backend stays gone.

const fs = require('fs');
const os = require('os');
const path = require('path');

const VENDOR = path.join(__dirname, '..', '..', 'src', 'vendor', 'fakegato-history');

// What the factory reads off `homebridge` when it is called.
function homebridgeStub(storagePath) {
  return {
    hap: { Characteristic: function () {}, Service: function () {}, Formats: {}, Perms: {} },
    user: { storagePath: () => storagePath },
  };
}

describe('vendored fakegato-history — load path', () => {
  test('the factory loads and returns a history-service constructor', () => {
    const FakeGatoHistoryService = require(path.join(VENDOR, 'fakegato-history'))(homebridgeStub(os.tmpdir()));
    expect(typeof FakeGatoHistoryService).toBe('function');
    // src/index.js attaches one per accessory and calls addEntry every poll.
    expect(typeof FakeGatoHistoryService.prototype.addEntry).toBe('function');
  });
});

describe('vendored fakegato-history — fs storage round-trip', () => {
  const service = { accessoryName: 'guard-test' };
  let dir;
  let storage;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakegato-guard-'));
    const { FakeGatoStorage } = require(path.join(VENDOR, 'fakegato-storage'));
    // `log.debug` must exist: upstream hardcodes `const DEBUG = true` and
    // falls back to console.log, which would spray the test output.
    storage = new FakeGatoStorage({ log: { debug: () => {} } });
    storage.addWriter(service, { storage: 'fs', path: dir, filename: 'guard_persist.json' });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writes a persist file and reads back the same bytes', async () => {
    const payload = JSON.stringify({ history: [1, 2, 3] });

    // Upstream quirks, preserved verbatim: write() calls back with the fs
    // callback's `arguments` object, while read() calls back with (err, data).
    const writeErr = await new Promise((resolve) => {
      storage.write({ service, data: payload, callback: (args) => resolve(args[0]) });
    });
    expect(writeErr).toBeFalsy();
    expect(fs.readdirSync(dir)).toContain('guard_persist.json');

    const readBack = await new Promise((resolve, reject) => {
      storage.read({ service, callback: (err, data) => (err ? reject(err) : resolve(data)) });
    });
    expect(String(readBack)).toBe(payload);
  });
});

describe('vendored fakegato-history — the Google Drive backend stays gone', () => {
  // Removing it is the entire reason this copy exists: it was the only thing
  // pulling in googleapis (~207 MB installed, ~115 MB RSS at require time).
  // A careless re-sync with upstream would put it straight back.
  const sources = ['fakegato-history.js', 'fakegato-storage.js', 'fakegato-timer.js', path.join('lib', 'uuid.js')];

  test('lib/googleDrive.js is not vendored', () => {
    expect(fs.existsSync(path.join(VENDOR, 'lib', 'googleDrive.js'))).toBe(false);
  });

  // Strips block comments and whole-line `//` comments — which is where the
  // provenance headers describe the removal in prose. Matching raw source
  // would flag those descriptions as the thing they describe.
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('no vendored source requires it or branches to it', () => {
    for (const file of sources) {
      const src = code(fs.readFileSync(path.join(VENDOR, file), 'utf8'));
      expect(src).not.toMatch(/require\(['"]\.\/lib\/googleDrive['"]\)/);
      expect(src).not.toMatch(/case\s+['"]googleDrive['"]/);
    }
  });

  test('the googleDrive storage mode is unreachable at runtime', () => {
    // The behavioural half of the check above, immune to how the source is
    // worded: asking for the removed backend must not produce a writer.
    const { FakeGatoStorage } = require(path.join(VENDOR, 'fakegato-storage'));
    const storage = new FakeGatoStorage({ log: { debug: () => {} } });
    storage.addWriter({ accessoryName: 'drive' }, { storage: 'googleDrive', path: os.tmpdir() });
    expect(storage.getWriters()).toHaveLength(0);
  });

  test('googleapis is not a dependency of the plugin', () => {
    const pkg = require('../../package.json');
    expect(Object.keys(pkg.dependencies || {})).not.toContain('googleapis');
    expect(Object.keys(pkg.devDependencies || {})).not.toContain('googleapis');
  });

  test('loading the history module pulls in no Google modules', () => {
    require(path.join(VENDOR, 'fakegato-history'))(homebridgeStub(os.tmpdir()));
    expect(Object.keys(require.cache).filter((k) => /googleapis|googleDrive/.test(k))).toEqual([]);
  });
});
