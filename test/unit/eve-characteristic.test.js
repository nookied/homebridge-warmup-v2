/* eslint-env jest */

// Regression test for v3.9.1.
//
// HAP-NodeJS 2.1.5 (shipped with Homebridge 2.0.1) does not expose
// `Characteristic.Formats` as a static accessor. v3.9.0 referenced
// `Characteristic.Formats.FLOAT` inside the EveTotalConsumption
// constructor, which crashed with `Cannot read properties of undefined
// (reading 'FLOAT')` the first time HAP instantiated the class.
//
// The fix moved the resolution into a small compat layer that:
//   1. tries `homebridge.hap.Formats` (modern HAP-NodeJS top-level)
//   2. falls back to `Characteristic.Formats` (older HAP-NodeJS statics)
//   3. final fallback to HAP-spec string literals (never change)
//
// We test all three resolution paths against the real shipped helper.

const { resolveFormats, resolvePerms, FORMAT_STRINGS, PERM_STRINGS } = require('../../src/lib/hap-compat');

describe('hap-compat — Formats/Perms resolution', () => {
  test('resolves to homebridge.hap.Formats when present (modern HAP-NodeJS)', () => {
    const Formats = { FLOAT: 'float', UINT32: 'uint32' };
    const Perms = { PAIRED_READ: 'pr', NOTIFY: 'ev' };
    const hb = { hap: { Formats, Perms, Characteristic: { Formats: { FLOAT: 'should-not-pick' } } } };
    expect(resolveFormats(hb)).toBe(Formats);
    expect(resolvePerms(hb)).toBe(Perms);
  });

  test('falls back to Characteristic.Formats statics when top-level missing (legacy HAP-NodeJS)', () => {
    const CharFormats = { FLOAT: 'float', UINT32: 'uint32' };
    const CharPerms = { PAIRED_READ: 'pr', NOTIFY: 'ev' };
    const hb = { hap: { Characteristic: { Formats: CharFormats, Perms: CharPerms } } };
    expect(resolveFormats(hb)).toBe(CharFormats);
    expect(resolvePerms(hb)).toBe(CharPerms);
  });

  test('falls back to spec string literals when neither is exposed (HAP 2.1.5 regression case)', () => {
    const hb = { hap: { Characteristic: function () {} } };
    const f = resolveFormats(hb);
    const p = resolvePerms(hb);
    expect(f.FLOAT).toBe('float');
    expect(f.UINT32).toBe('uint32');
    expect(p.PAIRED_READ).toBe('pr');
    expect(p.NOTIFY).toBe('ev');
  });

  test('resolves cleanly when homebridge.hap is missing entirely', () => {
    expect(resolveFormats({}).FLOAT).toBe('float');
    expect(resolveFormats(null).FLOAT).toBe('float');
    expect(resolveFormats(undefined).FLOAT).toBe('float');
    expect(resolvePerms({}).NOTIFY).toBe('ev');
  });

  test('exported FORMAT_STRINGS / PERM_STRINGS match HAP wire-format spec', () => {
    // The HAP-spec encoding for these is part of the protocol contract;
    // pinning the values here makes accidental rename-by-refactor visible.
    expect(FORMAT_STRINGS.FLOAT).toBe('float');
    expect(FORMAT_STRINGS.UINT32).toBe('uint32');
    expect(FORMAT_STRINGS.BOOL).toBe('bool');
    expect(FORMAT_STRINGS.INT).toBe('int');
    expect(PERM_STRINGS.PAIRED_READ).toBe('pr');
    expect(PERM_STRINGS.PAIRED_WRITE).toBe('pw');
    expect(PERM_STRINGS.NOTIFY).toBe('ev');
  });
});
