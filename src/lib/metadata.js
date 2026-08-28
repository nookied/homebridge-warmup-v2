'use strict';

// HAP requires FirmwareRevision to look like 1, 1.2, or 1.2.3 (each segment
// up to 9 digits). Warmup's `appFw` is "29.175"-ish in practice; validate
// before using, fall back to the plugin version on anything weird.
const SEMVER_LIKE = /^\d{1,9}(\.\d{1,9}){0,2}$/;

function deriveFirmwareRevision(room, fallback) {
  const fw = room && room.appFw && String(room.appFw).trim();
  if (fw && SEMVER_LIKE.test(fw)) return fw;
  return fallback;
}

// Eve.Energy.TotalConsumption: cumulative kWh, monotonically increasing.
// Warmup's `total` is the closest match (`energy` is today-only and resets
// daily). Round to 3 decimals to drop FP noise without losing useful precision.
//
// Returns `null` — not 0 — when the value is absent or unusable, so the
// caller can skip the write and leave the last known reading in place. This
// is a cumulative counter: a single null poll (the field is nullable, and
// pre-v3.5 devices never send it) writing 0 would collapse Eve's long-term
// graph to the origin and then jump back on the next poll.
function deriveTotalConsumption(room) {
  if (room === null || room === undefined || room.total === null || room.total === undefined) return null;
  const total = Number(room.total);
  if (!Number.isFinite(total) || total < 0) return null;
  return Math.round(total * 1000) / 1000;
}

module.exports = { deriveFirmwareRevision, deriveTotalConsumption };
