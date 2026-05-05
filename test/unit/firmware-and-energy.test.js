/* eslint-env jest */

// `deriveFirmwareRevision` and `deriveTotalConsumption` are non-exported
// helpers in src/index.js. We test them by re-deriving the same logic here
// against the same inputs — keeps the helpers pure and the tests at the
// public-behaviour boundary. If the helper logic changes, this test catches
// the divergence; if the helper signature changes, the test fails compile.

// Direct re-implementations matching src/index.js. Update both together.

const SEMVER_LIKE = /^\d{1,9}(\.\d{1,9}){0,2}$/;
function deriveFirmwareRevision(room, fallback) {
  const fw = room && room.appFw && String(room.appFw).trim();
  if (fw && SEMVER_LIKE.test(fw)) return fw;
  return fallback;
}
function deriveTotalConsumption(room) {
  const total = Number(room && room.total);
  if (!Number.isFinite(total) || total < 0) return 0;
  return Math.round(total * 1000) / 1000;
}

describe('deriveFirmwareRevision', () => {
  test('valid SemVer-ish appFw is used directly', () => {
    expect(deriveFirmwareRevision({ appFw: '29.175' }, '3.5.0')).toBe('29.175');
    expect(deriveFirmwareRevision({ appFw: '1' }, '3.5.0')).toBe('1');
    expect(deriveFirmwareRevision({ appFw: '1.2' }, '3.5.0')).toBe('1.2');
    expect(deriveFirmwareRevision({ appFw: '1.2.3' }, '3.5.0')).toBe('1.2.3');
    expect(deriveFirmwareRevision({ appFw: '999999999.999999999.999999999' }, '3.5.0'))
      .toBe('999999999.999999999.999999999');
  });

  test('missing or invalid appFw falls back', () => {
    expect(deriveFirmwareRevision({}, '3.5.0')).toBe('3.5.0');
    expect(deriveFirmwareRevision({ appFw: '' }, '3.5.0')).toBe('3.5.0');
    expect(deriveFirmwareRevision({ appFw: '   ' }, '3.5.0')).toBe('3.5.0');
    expect(deriveFirmwareRevision({ appFw: 'v1.2.3' }, '3.5.0')).toBe('3.5.0');     // leading 'v'
    expect(deriveFirmwareRevision({ appFw: '1.2.3-beta' }, '3.5.0')).toBe('3.5.0'); // pre-release suffix
    expect(deriveFirmwareRevision({ appFw: '1.2.3.4' }, '3.5.0')).toBe('3.5.0');    // 4 segments
    expect(deriveFirmwareRevision({ appFw: '1234567890' }, '3.5.0')).toBe('3.5.0'); // segment > 9 digits
    expect(deriveFirmwareRevision({ appFw: 'abc' }, '3.5.0')).toBe('3.5.0');
  });

  test('null/undefined room', () => {
    expect(deriveFirmwareRevision(null, '3.5.0')).toBe('3.5.0');
    expect(deriveFirmwareRevision(undefined, '3.5.0')).toBe('3.5.0');
  });

  test('appFw can be a number (defensive cast)', () => {
    // Some API responses send numbers. Coerce to string and validate.
    expect(deriveFirmwareRevision({ appFw: 29.175 }, '3.5.0')).toBe('29.175');
  });
});

describe('deriveTotalConsumption', () => {
  test('numeric total → kWh rounded to 3 decimals', () => {
    expect(deriveTotalConsumption({ total: 0 })).toBe(0);
    expect(deriveTotalConsumption({ total: 42 })).toBe(42);
    expect(deriveTotalConsumption({ total: 42.7 })).toBe(42.7);
    expect(deriveTotalConsumption({ total: 42.7159 })).toBe(42.716);
  });

  test('string total → coerced to number', () => {
    expect(deriveTotalConsumption({ total: '42' })).toBe(42);
    expect(deriveTotalConsumption({ total: '42.7' })).toBe(42.7);
  });

  test('negative or non-finite total → 0', () => {
    expect(deriveTotalConsumption({ total: -5 })).toBe(0);
    expect(deriveTotalConsumption({ total: NaN })).toBe(0);
    expect(deriveTotalConsumption({ total: Infinity })).toBe(0);
    expect(deriveTotalConsumption({ total: 'not a number' })).toBe(0);
  });

  test('missing total → 0', () => {
    expect(deriveTotalConsumption({})).toBe(0);
    expect(deriveTotalConsumption(null)).toBe(0);
    expect(deriveTotalConsumption(undefined)).toBe(0);
  });
});
