'use strict';

// HAP-NodeJS API-shape compatibility layer.
//
// `Formats` and `Perms` enums have moved around across HAP-NodeJS releases:
//   - Some versions: top-level on `homebridge.hap.Formats` / `.Perms`
//   - Other versions: static members on `Characteristic.Formats` / `.Perms`
//   - HAP-NodeJS 2.1.5 (Homebridge 2.0.1): neither — the static was a TS
//     `const enum` that gets erased at runtime, so reads return undefined
//
// String fallbacks come from the HAP wire-format spec — these values are
// stable contract bytes, not implementation details.

const FORMAT_STRINGS = Object.freeze({
  BOOL: 'bool',
  INT: 'int',
  FLOAT: 'float',
  STRING: 'string',
  UINT8: 'uint8',
  UINT16: 'uint16',
  UINT32: 'uint32',
  UINT64: 'uint64',
  DATA: 'data',
  TLV8: 'tlv8',
  ARRAY: 'array',
  DICTIONARY: 'dictionary'
});

const PERM_STRINGS = Object.freeze({
  PAIRED_READ: 'pr',
  PAIRED_WRITE: 'pw',
  NOTIFY: 'ev',
  HIDDEN: 'hd',
  ADDITIONAL_AUTHORIZATION: 'aa',
  WRITE_RESPONSE: 'wr'
});

function resolveFormats(homebridge) {
  return (homebridge && homebridge.hap && homebridge.hap.Formats)
    || (homebridge && homebridge.hap && homebridge.hap.Characteristic && homebridge.hap.Characteristic.Formats)
    || FORMAT_STRINGS;
}

function resolvePerms(homebridge) {
  return (homebridge && homebridge.hap && homebridge.hap.Perms)
    || (homebridge && homebridge.hap && homebridge.hap.Characteristic && homebridge.hap.Characteristic.Perms)
    || PERM_STRINGS;
}

module.exports = { resolveFormats, resolvePerms, FORMAT_STRINGS, PERM_STRINGS };
