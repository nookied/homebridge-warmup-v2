# Changelog

All notable changes to `homebridge-warmup4ie` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Pre-0.1.0 history is reconstructed from the upstream git log — commit messages
were sparse ("Day 1", "Beta release", "Ooops"), so dates are accurate but
the per-version groupings are approximate.

---

## [0.1.2] — 2026-05-05

This release restores the **hard-off** that worked in 0.0.14 and got broken
in the 0.1.0 rewrite (PR #7, "Beta 0.1.0 - HB 2.0 support"), plus a transport
swap from the deprecated `request` library to native `fetch`, plus a cleanup
pass that drops four unused top-level deps.

### Where the regression came from

The 0.1.0 PR rewrote `lib/warmup4ie.js` from function-style to class-style.
Most of that diff was cosmetic, but two wire-format details were quietly
simplified in the rewrite, and that's what broke control:

- **`setRoomOff`** was simplified from the Python-reference body shape
  ```
  values: {holEnd:"-", fixedTemp:"", holStart:"-", geoMode:"0", holTemp:"-", locId, locMode:"off"}
  ```
  to just `{locId, locMode:"off"}`. The Warmup API silently rejects the
  short version with `200 OK` + `{status:{result:"error"}}`. HomeKit
  reported "Off" as successful while the thermostats kept heating.
- **`setTargetTemperature`'s `until`** switched from local-time `HH:MM`
  (computed with `getHours()` / `getMinutes()`) to UTC `HH:MM`
  (`toISOString().slice(11,16)`). The Warmup app sends local time; UTC
  here made overrides expire at the wrong wall-clock time, off by the
  local UTC offset.

Both have been verified byte-for-byte against the Python reference impl
([alex-0103/warmup4IE](https://github.com/alex-0103/warmup4IE/blob/master/warmup4ie/warmup4ie.py)).

### Fixed
- **`setRoomOff`** — restored the full filler `values` dict. The hard-off
  that worked in 0.0.14 works again. (Reminder, unchanged from 0.0.14:
  this is a **location-wide** off — the Warmup mobile app does the same
  call, and the API has no per-room hard-off operation.)
- **`setTargetTemperature` `until`** — back to local time.
- **`_sendRequest`** now fails when the API responds with
  `{status:{result:"error"}}`. Both 0.0.14 and 0.1.1 silently treated
  that as success; now it surfaces as an error and HomeKit shows "Not
  Responding" instead of pretending the command landed.
- **Per-accessory `room` snapshot was frozen at startup.** `updateStatus()`
  now refreshes `accessory.room` from each poll, so
  `setTargetHeatingCooling`'s `runMode`-based short-circuits see fresh
  state.

### Changed
- **Transport: `request` → native `fetch`.** Drops a 12-year-old
  deprecated dependency (request is unmaintained since 2020 and ships
  unfixed prototype-pollution / SSRF advisories). Native `fetch` is
  built into Node ≥18.0 — no new dep, no new install size. Behaviour is
  preserved: same headers, same JSON body, same 10 s timeout (now via
  `AbortSignal.timeout`).
- **Polling consolidated.** Previously the platform polled at `refresh`
  and the lib polled separately at `refresh / 2`, hitting the API ~3×
  per refresh window. The lib's interval was removed; the platform now
  fetches *and* pushes in a single tick at `refresh` seconds.
- **`SerialNumber` is now `warmup4ie-<roomId>`** instead of
  `<hostname>-<name>`. Stable across host moves and Homebridge
  reinstalls; matches HAP-NodeJS guidance on stable accessory identity.
- **`setPrimaryService(true)`** is used in place of direct
  `isPrimaryService = true` property assignment, per HAP-NodeJS v2 docs
  (with a property-assignment fallback for HB 1.x environments where
  the method may not exist).
- **`updateStatus` refactored** into pure `deriveCurrentHeatingState` /
  `deriveTargetHeatingState` helpers, shared between the initial
  `getServices()` build and the polling path.
- **Multi-location accounts: first location only**, by design. Documented
  explicitly. The Python reference filters by name; we don't, because
  this plugin has no `location` config knob and adding one is out of
  scope. If you need multiple locations on one account, run a second
  Homebridge child bridge.

### Removed
- **`request` dependency.** Replaced with native `fetch`.
- **Unused dependencies:** `fakegato-history`, `homebridge-lib`,
  `moment`, `semver`. None had a live code path; `fakegato-history` was
  already commented out in 0.1.1. If history graphs come back, re-add
  and bump to `^0.6.7` for HAP-NodeJS v2 compatibility.
- **Dead code in `index.js`:** commented-out fakegato /
  CustomCharacteristics blocks; unused `storage` config option (was
  never wired up); unused `username` / `password` fields on the
  per-accessory object.
- **Dead public methods on `Warmup4IE`:** `setRoomOverride`,
  `setRoomFixed`, `_setRoomMode`, `pollDevices`, `destroy`. None were
  called from `index.js` or anywhere else.
- **Unused constructor options** on `Warmup4IE` (`location`, `room`,
  `target_temp`, `setup_finished`).

### Tests
- `src/lib/warmup4ie.test.js` now actually loads (the absolute path to
  `/Users/sgracey/Code/...` was replaced with a relative require). Three
  offline regression tests added — `setTargetTemperature` `until`
  format, `setRoomOff` body shape, `setRoomAuto` shape — all stub
  `_sendRequest`, no network. Live-API tests are kept under
  `describe.skip` for documentation.

---

## [0.1.1] — 2024-12-14

### Changed
- Final `package.json` bump on top of the 0.1.0 beta after merging HB 2.0 support
  to `main`. No source changes since the merge commit.

---

## [0.1.0] — 2024-12-13

### Added
- **Homebridge 2.0 support** — `engines.homebridge` widened to `^1.6.0 || ^2.0.0-beta.0`,
  Node engines updated to `^18.20.4 || ^20.15.1 || ^22.0.0`.
- **API client rewrite** (`src/lib/warmup4ie.js`) — extracted into a `Warmup4IE`
  class with explicit `_generateAccessToken` → `_getLocations` → `getStatus`
  bootstrap chain, and `setTargetTemperature` / `setRoomAuto` / `setRoomOverride`
  / `setRoomFixed` / `setRoomOff` write paths.
- **ESLint v9 flat config** (`eslint.config.mjs`) with `eslint-plugin-jest`.
- **Jest test sketch** (`src/lib/warmup4ie.test.js`) — most cases are `test.skip`
  pending mocking; the live tests still reference the original author's absolute
  path and will not resolve in this fork (see `CLAUDE.md` → Known issues).
- **Sandbox Homebridge config** at `test/hbConfig/` for `npm run watch`.
- **CI workflow** `.github/workflows/Build and Publish.yml` — beta publish on
  push to `beta-*.*.*` / `beta`, prod publish + GitHub Release on
  `workflow_dispatch` from `main`. Reuses `homebridge/.github/.../npm-publish.yml`.
- `npm run lint` / `lint:fix` / `test` / `test-coverage` / `watch` scripts.

### Changed
- Wire format updates to match the current Warmup app — new `app-token` value,
  `app-version: 1.8.1`, `accept-language: de-de`.
- `setOverride` now sends `type: 3` and an `until: HH:MM` window calculated as
  now + `duration` minutes (UTC, `toISOString().slice(11,16)`).
- Accessory `SerialNumber` is now `<hostname>-<roomName>` and `FirmwareRevision`
  is read from `package.json`.
- Polling: `Warmup4IE` constructor now schedules its own `setInterval` at
  `refresh*1000/2`, in addition to the platform-level interval at `refresh*1000`.
  (Net effect: the API is polled ~3× per `refresh` window — see Known issues.)

### Removed (effectively — dependencies remain in `package.json`)
- `fakegato-history` integration is fully commented out; history graphing is
  disabled.
- `homebridge-lib`, `moment`, `semver` are still listed as dependencies but no
  live code path uses them.

---

## [pre-0.1.0] — historical context (2019–2021)

These entries reflect the upstream `NorthernMan54/homebridge-warmup4ie` git log
and predate any tagged release in this fork. Earlier versions did ship to npm
under `homebridge-warmup4ie`, but `package.json` versions for those points are
not preserved in current commit metadata.

### 2021-11-23 — debugging passes
Multiple "Added debugging" / "Test" commits within a single session. No
behaviour changes that survive in the current source.

### 2021-02-01 — `Custom characteristics bad pressure unit`
Single commit; details have not been carried forward into 0.1.0+.

### 2019-11-05 / 2019-11-07 — patch series
"Ooops" / "Fix" / "Fix my oops" — small fixes that landed shortly after the
2019 beta. Behaviour rolled into the rewrite at 0.1.0.

### 2019-09-23 — iOS 13
"iOS13" / "iOS13 Tweaks" — adjustments for the HomeKit changes shipped with
iOS 13 (most relevant: `TargetHeatingCoolingState` valid values, temperature
ranges).

### 2019-06-23 — Beta release
Five "Beta release" commits and "Day 7 - Beta ready" — first publishable
version of the plugin. At this point the platform exposed each Warmup room as
a HomeKit `Service.Thermostat` paired with a `Service.TemperatureSensor`,
backed by callback-style API calls against `https://api.warmup.com/apps/app/v1`.

### 2019-06-13 — Initial commit
Project scaffolded. Day 1–7 commits (June 13 → 23, 2019) were the original
build sprint.

---

## Reconstruction notes

- Dates are taken from `git log --pretty=format:'%ai'` on `main`.
- "0.1.0" / "0.1.1" version boundaries reflect the current `package.json`
  (`0.1.1`) and the merged PR title `Beta 0.1.0 - HB 2.0 support (#7)` —
  individual `package.json` bump commits aren't visible in the squashed history.
- For anything older than 2024-12, prefer `git log src/lib/warmup4ie.js` over
  this changelog — many of the "Added debugging" commits touched live code
  paths that have since been rewritten.
