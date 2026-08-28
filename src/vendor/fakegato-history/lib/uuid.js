// ---------------------------------------------------------------------------
// VENDORED from fakegato-history v0.6.7 — https://github.com/simont77/fakegato-history
// MIT License, Copyright (c) 2017 simont77. Full text in ./LICENSE.
//
// Why this is here rather than an npm dependency: fakegato-history declares
// `googleapis` as a hard dependency for a Google Drive storage backend this
// plugin never selects, and required it at module load. That cost ~207 MB on
// disk, ~115 MB RSS and ~800 ms of startup for every user, on hardware that
// is usually a Raspberry Pi.
//
// Changes from upstream, kept deliberately minimal so this stays a faithful
// copy rather than a rewrite:
//   - fakegato-storage.js: the Google Drive backend is removed — the
//     top-level `require('./lib/googleDrive')` and the four
//     `case 'googleDrive':` branches. `storage: 'fs'` is the only mode.
//   - lib/googleDrive.js is not vendored at all.
//   - This header.
// Nothing else is edited. See CLAUDE.md for the full reasoning.
// ---------------------------------------------------------------------------

// https://github.com/homebridge/HAP-NodeJS/blob/master/src/lib/util/uuid.ts

const VALID_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValid(UUID) {
  return VALID_UUID_REGEX.test(UUID);
}
const VALID_SHORT_REGEX = /^[0-9a-f]{1,8}$/i;

function toLongFormUUID(uuid, base = '-0000-1000-8000-0026BB765291') {
  if (isValid(uuid)) return uuid.toUpperCase();
  if (!VALID_SHORT_REGEX.test(uuid)) throw new TypeError('uuid was not a valid UUID or short form UUID');
  if (!isValid('00000000' + base)) throw new TypeError('base was not a valid base UUID');

  return (('00000000' + uuid).substr(-8) + base).toUpperCase();
}

function toShortFormUUID(uuid, base = '-0000-1000-8000-0026BB765291') {
  uuid = toLongFormUUID(uuid, base);
  return (uuid.substr(0, 8));
}

exports.isValid = isValid;
exports.toLongFormUUID = toLongFormUUID;
exports.toShortFormUUID = toShortFormUUID;
