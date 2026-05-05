# Changelog

All notable changes to `homebridge-warmup4ie-v2` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This package is a maintained fork of [`homebridge-warmup4ie`](https://github.com/NorthernMan54/homebridge-warmup4ie). The fork begins at version 2.0.0 (a tribute to the original 1.x lineage) and is published to npm as `homebridge-warmup4ie-v2`. Pre-2.0.0 history below is the upstream history, kept for context.

---

## [3.1.0] — 2026-05-05

Roadmap [Milestone 4](ROADMAP.md) — **Dynamic platform migration.** Closes
the last Verified-Plugin blocker and unlocks fakegato-history (queued for
M5). `config.json` is unchanged; behaviour is unchanged in steady state.

### One-time migration cost

Existing v3.0.x users will see their thermostat tiles **re-create as fresh
accessories on first restart after upgrading to 3.1**. The static-platform
versions never wrote anything to Homebridge's accessory cache, so the new
dynamic-platform startup runs against an empty cache and registers all
rooms as new. In Apple Home: room assignments, automation references, and
custom tile names will need re-doing once. Cosmetic, not data-loss.

This is a one-time event — every subsequent upgrade reuses the cache and
preserves your HomeKit setup.

### Why this is a minor version (not major)

No breaking change to `config.json` keys, plugin behaviour, or HomeKit
accessory shape. The accessory re-creation is an upgrade-time mechanic
of switching to a new Homebridge plugin pattern, not a deliberate breaking
change. SemVer guidance for Homebridge plugins treats it as a minor.

### What dynamic platform actually means for users

- **Resilience to Warmup outages at boot.** v3.0.x: if the Warmup cloud is
  down or your internet's out when Homebridge restarts, you get *zero*
  thermostat tiles. v3.1: cached accessories stay visible (HomeKit shows
  "Not Responding" until the API recovers).
- **No flicker on restart.** Static accessories briefly disappear and
  re-appear during Homebridge restarts. Dynamic ones don't.
- **Foundation for history graphs.** `fakegato-history` requires
  persistent accessories — Roadmap M5 is unblocked.
- **Eligible for [Homebridge Verified](https://github.com/homebridge/verified).**
  Application is queued as Roadmap M7 (after a few weeks of stability).

### Added

- **Dynamic platform registration.** `module.exports` now passes `true` as
  the 4th arg of `registerPlatform` and the platform implements the
  Homebridge `DynamicPlatformPlugin` contract.
- **`configureAccessory(cached)`.** Called by Homebridge for each cached
  accessory at startup; stored in `platform.accessories` Map keyed by UUID.
- **`discoverDevices()`** runs after Homebridge fires `didFinishLaunching`.
  Logs in, fetches rooms, and computes the register/unregister deltas
  against the cached set.
- **`reconcileAccessories(rooms)`** — diffs live rooms vs cached, registers
  new ones via `api.registerPlatformAccessories`, unregisters stale ones
  via `api.unregisterPlatformAccessories`, refreshes services on the
  matched ones via `api.updatePlatformAccessories`.
- **Stable per-accessory UUID.** `api.hap.uuid.generate('warmup4ie:' +
  roomId)` ensures every restart of the same Warmup room maps to the same
  HomeKit accessory.
- **`api.on('shutdown', ...)`** handler calls `platform.shutdown()`,
  clearing the poll timer and any pending debouncer timers (was leaving
  zombie callbacks in v3.0.x).
- **Five new platform-level integration tests** (`test/integration/platform-state.test.js`):
  cached-accessory-restoration, register-new, unregister-stale, reuse-matched,
  shutdown timer cleanup, plus the existing multi-instance isolation test
  rebuilt for the dynamic shape.

### Changed

- **`Warmup4ieAccessory` class is gone.** Replaced by free functions that
  mutate `PlatformAccessory` objects in place: `attachAccessoryServices`,
  `pushRoomState`, `updateAccessoryState`, `handleTargetHeatingCoolingSet`,
  `handleTargetTemperatureSet`. Closures capture `platform` + `accessory`
  at attach time, so the bound `.onSet` handlers don't need a wrapper class.
- **Per-accessory state on `accessory.context`.** `roomId` and the latest
  `room` snapshot live there (Homebridge persists context to disk between
  restarts). Debounce timers stay in-memory only via a per-platform
  `_debouncers: Map<UUID, Map<char, Timeout>>` registry.
- **Service `Name` is set only on first add.** Refreshing a cached
  accessory no longer overwrites a user's rename in Apple Home.

### Removed

- **`accessories(callback)` static-platform method.** Gone for good.
- **`Warmup4ieAccessory` class** (was just a getServices() factory plus
  some setter handlers). The dynamic platform builds services directly
  on `PlatformAccessory` objects; no wrapper needed.

### Tests

- 73 passing live (71 offline + 2 live API). Up from 69 in 3.0.1.
- New: `homebridge-loadtime.test.js` checks the 4th arg to `registerPlatform`
  is `true` (dynamic flag).
- Rewritten: `platform-state.test.js` exercises the dynamic flow end-to-end
  with a fake Homebridge API + fake `PlatformAccessory`. Covers every
  branch of `reconcileAccessories`.

### Sources of truth used

- [Homebridge Plugin Template (DynamicPlatformPlugin reference impl)](https://github.com/homebridge/homebridge-plugin-template)
- [Homebridge Verified Plugin requirements](https://github.com/homebridge/plugins) (for `dynamic = true`, `configureAccessory`)
- [HAP-NodeJS PlatformAccessory + UUID API](https://developers.homebridge.io/HAP-NodeJS/)

---

## [3.0.1] — 2026-05-05

Maintenance pass after the v3.0 GraphQL release. Bug fixes, cache
correctness improvements, dependency-lock cleanup, and documentation refresh.
No new features; no breaking changes; `config.json` is unchanged.

### Fixed
- **Platform instance isolation.** `src/index.js` no longer keeps
  `thermostats` and the accessory list at module scope, so multiple platform
  instances cannot route writes through the wrong Warmup client.
- **Failed bootstrap / missing config polling.** Missing credentials and
  login/initial-fetch failures now return no accessories without starting a
  poll timer.
- **Warmup room cache correctness.** `_fetchRooms()` now replaces the cache
  each poll so rooms removed from the Warmup account do not linger, and write
  methods preserve the last-known room snapshot when the API rejects a write.
- **Temperature tenths rounding.** `setTargetTemperature()` now uses
  `Math.round(value * 10)` so values like `19.9` become `199` instead of
  occasionally truncating due to floating-point precision.
- **Login token validation.** A successful-looking `userLogin` response
  without `response.token` now fails with a clear error before any GraphQL
  call.
- **Live-test socket cleanup.** Warmup HTTP requests now send
  `Connection: close`, which avoids native `fetch` leaving TLS handles open
  after the live Jest suite finishes.

### Changed
- **Doc + comment cleanup pass for handoff.** Stale comments referring to
  v2 behaviour (location-wide off, REST transport in API cheat sheet, etc.)
  rewritten for v3.0 reality. `CLAUDE.md` architecture diagram, file
  reference table, and known-issues sections fully refreshed. `QA_TESTS.md`
  Section 4 (multi-room) inverted to verify per-room Off (was: verify
  whole-location Off).
- **Code polish.** Extracted `effectiveTargetTemp(room)` helper for the
  `targetTemp > minTemp ? : minTemp` clamp (was inlined in two places).
  Removed dead `outputStatus` / `parameters` extraction from `normalizeRoom`
  — the GraphQL query no longer fetches `parameters` (was dropped during
  the v3 live-test 409 debugging), so the field would always be undefined
  in production. Roadmap M6 will re-add it deliberately.
- **Dependency lockfile refresh.** `package-lock.json` now matches the
  package name/version and resolves dev-tool transitive advisories reported
  by `npm audit`; production dependencies audit clean.

### Documentation
- `package.json` `repository.url` invariant added to working rules and
  pre-release checklist (sigstore provenance is strict — hit a 422 once
  during the GitHub repo rename to `-v2`; documented to prevent recurrence).
- `package.json`, `config.schema.json`, README install/development examples,
  and troubleshooting text now point at `nookied/homebridge-warmup4ie-v2`
  consistently.
- README supported-model notes updated against current Warmup docs:
  MyHeating/my.warmup.com remains the support boundary, 6iE is now
  discontinued/replaced by 7iE, and 7iE users can choose native Matter
  instead of this cloud plugin.
- Roadmap M4 (dynamic platform), M5 (Eve / fakegato), M6 (sensor metadata
  + outputStatus) cross-referenced from CLAUDE.md known-issues.

---

## [3.0.0] — 2026-05-05

Roadmap [Milestone 3](ROADMAP.md) — GraphQL transport rewrite. **The big v3
unlock: per-room "Off"**. Wire format changes entirely; HomeKit accessory
shape unchanged.

### Headline change: Off is now per-room

Previous versions (and the upstream original) used `setModes locMode:"off"`,
which turns off the **entire location** — tapping Off on any one HomeKit
thermostat killed heating across the whole account. This was an API
limitation (no per-room hard-off in REST), not a plugin choice.

GraphQL exposes `deviceOff(lid, rid)` which is genuinely per-room. v3.0
uses it. **Tapping Off on one HomeKit thermostat now affects only that
room** — matching the Warmup mobile app's per-room Off button.

### Why this is a major version

- **Behaviour change visible to users:** "Off" semantics change. Users with
  multiple rooms who relied on the side-effect (one Off → all off) will
  see different behaviour. The new behaviour is correct; the old was a
  workaround.
- **Wire format change:** REST `https://api.warmup.com/apps/app/v1` → GraphQL
  `https://apil.warmup.com/graphql` for everything except `userLogin`.
  Internal change, but big enough to mark.

### Migration

`config.json` is unchanged. `npm install -g homebridge-warmup4ie-v2@3` on
the host, restart, done.

If you have a single room you'll see no functional change. If you have
multiple rooms, **the Off button now stops only that room** — if you want
the old whole-house off behaviour, build a HomeKit Scene that turns Off
on every thermostat at once.

### Added (transport: GraphQL)

- **`user.owned[]` query** for room enumeration. Single round trip returns
  all locations + rooms (the path the real Warmup mobile app uses).
- **`deviceOff(lid, rid)`** mutation — per-room hard off. The v3 unlock.
- **`deviceProgram(lid, rid)`** mutation — resume schedule per room.
- **`deviceOverride(lid, rid, temperature, minutes)`** mutation — temperature
  override with explicit duration in minutes. No more HH:MM `until` parsing,
  no more local-vs-UTC pitfalls, no more day-wraparound edge cases.
- **`warmup-authorization`** header for authenticated GraphQL requests
  (token previously rode in the body).
- **Per-room metadata surfaced** for future M5/M6 use:
  `floor1Temp`, `floor2Temp`, `isFaultAir`, `isFaultFloor1`, `isFaultFloor2`,
  `deviceSN`, `lastPoll`. Not yet exposed as HomeKit characteristics —
  reserved for the energy/sensor-fault rollouts.

### Changed

- **REST is gone** for everything except `userLogin`. The legacy
  `setModes`/`setProgramme`/`setOverride`/`getRooms` calls are removed.
  `_rest()` and `_graphql()` are now the two protocol-specific transports
  on top of a generic `_fetch(url, body, headers)`.
- **`setRoomOff(roomId)`** now genuinely targets one room, not the location.
- **`setTargetTemperature(roomId, value)`** sends `temperature` and `minutes`
  variables directly — `until` HH:MM string formatting is dropped entirely
  (it was only ever needed to satisfy the REST `setOverride` shape).
- **Token-error detection** updated to also recognise GraphQL "Unauthorized" /
  "token" / "auth" / "forbidden" messages, in addition to HTTP 401 and the
  REST `code: 100/102/103` patterns from v2.1.

### Removed

- **REST methods:** `_loadLocations` (combined into `_fetchRooms`), all
  v2 REST helpers replaced by GraphQL equivalents.
- **`until` HH:MM time formatting** — the regression sentinel from v2 (UTC
  vs local) is permanently obsolete; we send minutes now.
- **Old fixtures** (`getLocations.success.json`, `getRooms.*.json`,
  `setOperation.error.json`) — replaced by `graphql.owned.json`,
  `graphql.error.json`, `graphql.mutation.success.json`.

### Tests

- 61 passing offline + 2 live (login + getStatus against real account).
- New: GraphQL wire-format tests (assert mutation strings + variables),
  `_rest`/`_graphql` transport tests with URL-aware sequenced fetch stub,
  GraphQL error response handling, token refresh routes through both
  REST `userLogin` and GraphQL retry.
- Removed: `until-format.test.js` (UTC regression no longer applicable).

### Source-of-truth references

- GraphQL schema dump: [jondarrer/warmup-api/warmup-schema.graphql](https://github.com/jondarrer/warmup-api/blob/main/warmup-schema.graphql)
- Real-world request shape: [jondarrer/warmup-api/http-requests.http](https://github.com/jondarrer/warmup-api/blob/main/http-requests.http)
- HA integration cross-check: [ha-warmup/warmup](https://github.com/ha-warmup/warmup)
- openHAB binding cross-check: [openhab/openhab-addons (warmup)](https://github.com/openhab/openhab-addons/tree/main/bundles/org.openhab.binding.warmup)

---

## [2.1.0] — 2026-05-05

Roadmap [Milestone 1](ROADMAP.md) — Verified-plugin prep and UX polish. No
breaking changes; existing `config.json` continues to work unchanged.

### Added
- **`config.schema.json`** — Homebridge UI now renders a proper form for all
  config options (email, password, polling interval, override duration) with
  validation, password masking, and inline help text. Required for the
  Homebridge Verified Plugin program.
- **`displayName` in `package.json`** (`"Homebridge Warmup 4iE"`) — clean
  label in the Homebridge UI plugin browser.
- **`Model` characteristic** on each accessory (`"4iE"`) — was missing,
  surfaced as "Default Model" in Home app before.
- **Token refresh on 401** — when the Warmup access token expires (e.g.
  HTTP 401 or API error code 100/102/103), the lib re-authenticates and
  retries the request once. No more silent failures after long uptimes.
- **HAP error categorization** — write failures now surface as the right
  HomeKit error: network/timeout → `OPERATION_TIMED_OUT`, HTTP 4xx →
  `INSUFFICIENT_AUTHORIZATION`, anything else → `SERVICE_COMMUNICATION_FAILURE`.
  Home app shows clearer "Not Responding" reasons.
- **Trailing-edge debounce** on the `TargetTemperature` setter (300 ms) —
  dragging the slider now produces one HTTP call after you stop, not N
  calls during the drag.
- **Recommended: Child Bridge** — README section explaining the slow-API
  rationale.

### Changed
- **Lib transport API: callbacks → Promises.** `getStatus()`,
  `setTargetTemperature()`, `setRoomAuto()`, `setRoomOff()` all return
  Promises. Internal change — public Homebridge plugin behaviour unchanged.
- **HAP setters: `.on('set', cb)` → `.onSet(async)`** — modern API style,
  cleaner error propagation via thrown `HapStatusError`.
- **Manufacturer string:** `warmup4ie` → `Warmup`.
- **Module-level mutable state** moved to instance fields. The lib's
  `WarmupAccessToken` and `LocId` were file-scope `let`s that would
  collide across multiple instances; now `this._token` and `this._locId`.
  Future-proofs multi-account scenarios.
- **Logging hygiene**: per-write events (`Setting system switch`,
  `Setting target temperature`) are now `log.debug` instead of `log.info`,
  significantly reducing noise in default Homebridge logs. Bootstrap
  events stay at `log.info`.
- **Engines:** `homebridge: "^1.6.0 || ^2.0.0"` (dropped beta marker now
  that HB 2.0 is GA). Node 24 added to the engines list and CI matrix.
- **`console.error` in transport replaced by errors propagating to
  caller** — HB log captures everything correctly now.

### Removed
- **`_sendRequest` callback wrapper** — internal; tests now stub `_fetch`
  directly. Test surface is cleaner.

### Tests
- 56 passing (+6 since 2.0.0). New: token-refresh integration tests,
  `_isTokenError` unit tests, async/await test patterns throughout.

### Documentation — model coverage correction
The original plugin (and our initial v2 docs) implied this only worked with
the **4iE** thermostat. In fact, every Warmup Wi-Fi thermostat that pairs
with the MyHeating app uses the same cloud API, so the plugin works with
the entire smart-thermostat lineup:

- **4iE Smart Wi-Fi** (legacy, ~2014, discontinued — replaced by 6iE)
- **6iE Smart Wi-Fi** (active)
- **7iE Smart Matter Wi-Fi** (active flagship; also supports native Matter)
- **Element Wi-Fi** (active, entry-level)
- **Terra Wi-Fi** (active, eco-line)
- Rebadged OEM units: Laticrete, Rointe, Porcelanosa, Equus, Savant
- ❌ **Tempo** is NOT supported (programmable only, no Wi-Fi)

Doc corrections in this release:
- README rewritten with a "Supported thermostats" table and a note on the
  legacy `4ie` package name
- `package.json`: `displayName` changed from `"Homebridge Warmup 4iE"` to
  `"Homebridge Warmup Wi-Fi Thermostats"`; `description` and `keywords`
  updated to mention 6iE/7iE/Element/Terra/MyHeating
- `config.schema.json`: `headerDisplay` lists all supported models
- Accessory `Model` characteristic: was `"4iE"` (incorrect for users on
  any other model), now `"Wi-Fi Thermostat"` (a generic accurate label).
  v3.0 will populate this with the real model name from GraphQL
  (`appFw` / `deviceModel`).
- Removed the broken link `https://www.warmup.com/thermostats/smart/4ie`
  (404); replaced with the correct overview URL.
- `CLAUDE.md` purpose section + `ROADMAP.md` introduction updated.

---

## [2.0.0] — 2026-05-05

**First release of the maintained fork.** Restores the working hard-off that broke in upstream 0.1.0–0.1.1, replaces the deprecated `request` HTTP library with native `fetch`, adds a real test suite, and ships under the new npm name `homebridge-warmup4ie-v2`.

### Migration from `homebridge-warmup4ie`

```bash
sudo npm uninstall -g homebridge-warmup4ie
sudo npm install -g homebridge-warmup4ie-v2
sudo systemctl restart homebridge
```

Your `config.json` does **not** need changes — the platform identifier (`"platform": "warmup4ie"`) is unchanged for compatibility.

### Why this fork exists

The upstream 0.1.0 PR ("Beta 0.1.0 - HB 2.0 support", Dec 2024) rewrote the API client from function-style to class-style. The rewrite quietly simplified two wire-format details that the Warmup cloud API silently rejects with `200 OK` + `{status:{result:"error"}}`:

- The `setModes locMode: "off"` body lost five required filler keys (`holEnd`, `holStart`, `holTemp`, `fixedTemp`, `geoMode`). HomeKit's "Off" command silently failed for ~5 months while users thought it worked.
- The `setOverride until` field switched from local time to UTC, breaking override durations by the local timezone offset.

Both regressions were verified byte-for-byte against the [Python reference impl](https://github.com/alex-0103/warmup4IE) and fixed in this release.

### Fixed
- **`setRoomOff`** — restored the full filler `values` dict. The hard-off that worked in 0.0.14 works again. (Reminder: this is a **location-wide** off — the Warmup mobile app does the same call. The cloud API has no per-room hard-off.)
- **`setTargetTemperature` `until`** — back to local time.
- **API errors are surfaced** — `_sendRequest` now fails the callback when the response is `{status:{result:"error"}}`. Both upstream 0.0.14 and 0.1.1 silently treated that as success.
- **Per-accessory `room` snapshot was frozen at startup.** `updateStatus()` now refreshes `accessory.room` per poll, so `setTargetHeatingCooling`'s `runMode`-based logic sees fresh state.

### Changed
- **Transport: `request` → native `fetch`.** Drops a 12-year-old deprecated dependency (`request` is unmaintained since 2020 and ships unfixed prototype-pollution / SSRF advisories). Native `fetch` is built into Node ≥18, so no new dep, no install-size cost. Behaviour preserved: same headers, same JSON body, same 10 s timeout (now via `AbortSignal.timeout`).
- **Polling consolidated.** Upstream had two timers running (`refresh` from the platform, `refresh/2` from the lib) — the API was being hit ~3× per refresh window. The lib timer was removed; the platform now fetches *and* pushes in a single tick at `refresh` seconds.
- **`SerialNumber` is now `warmup4ie-<roomId>`** instead of `<hostname>-<name>` — stable across host moves, matches HAP-NodeJS guidance on accessory identity.
- **`setPrimaryService(true)`** is used in place of direct `isPrimaryService = true` (per HAP-NodeJS v2 docs), with a property-assignment fallback for HB 1.x environments.
- **`updateStatus` refactored** — pure `deriveCurrentHeatingState` / `deriveTargetHeatingState` helpers extracted to `src/lib/state.js`, shared by the initial `getServices()` build and the polling path.
- **Multi-location accounts: first location only**, by design. Documented explicitly. The Python reference filters by name; we don't, because this plugin has no `location` config knob and adding one is out of scope here. If you need multiple locations on one account, run a second Homebridge child bridge.

### Removed
- **`request` dependency.** Replaced with native `fetch`.
- **Unused upstream dependencies:** `fakegato-history`, `homebridge-lib`, `moment`, `semver`. None had a live code path; `fakegato-history` was already commented out in upstream 0.1.1.
- **Dead code in `index.js`:** commented-out fakegato / CustomCharacteristics blocks; unused `storage` config option (was never wired up); unused `username` / `password` fields on the per-accessory object.
- **Dead public methods on `Warmup4IE`:** `setRoomOverride`, `setRoomFixed`, `_setRoomMode`, `pollDevices`, `destroy`. None had callers.
- **Unused constructor options** on `Warmup4IE` (`location`, `room`, `target_temp`, `setup_finished`).

### Added
- **`LICENSE` file** — Apache-2.0 boilerplate (the original repo declared the license but didn't include the file).
- **Full test suite** under `test/`:
  - **Unit** (`test/unit/`): wire-format builders, state derivers (truth tables), `until` time formatting (TZ + DST + wraparound), `_fetch` error paths.
  - **Integration** (`test/integration/`): full bootstrap chain, polling state propagation, error recovery, plugin loadtime / `registerPlatform` smoke.
  - **Live** (`test/live/api.test.js`): opt-in via `WARMUP_LIVE_TEST=1`, real `api.warmup.com` calls; plus a destructive `setRoomOff/setRoomAuto` cycle gated behind `WARMUP_LIVE_DESTRUCTIVE=1`.
  - **Fixtures** (`test/fixtures/`): sanitized JSON snapshots of API responses.
- **`QA_TESTS.md`** — manual pre-release checklist (~15 min) covering Home app smoke, single-room and multi-room control flows, regression sentinels, edge cases, and rollback.
- **CI** (`.github/workflows/ci.yml`) — lint + test + smoke on Node 18.20, 20.15, 22 for every push and PR.
- **Release** (`.github/workflows/release.yml`) — tag-driven (`v*`) publish to npm with provenance, plus a GitHub Release. Verifies the tag matches `package.json` version before publishing.

### Repository
- **npm name:** `homebridge-warmup4ie-v2` (new; original `homebridge-warmup4ie` is unaffected and still abandoned upstream).
- **GitHub:** `nookied/homebridge-warmup4ie` (this fork; `upstream` git remote intentionally not configured).
- **Author:** Karol Nowacki (this fork) + NorthernMan54 (original). Apache-2.0 preserved.

---

## Upstream history (pre-fork)

The entries below are the upstream `NorthernMan54/homebridge-warmup4ie` history, kept here for context. They do not correspond to versions of *this* package — only to versions of the upstream package on npm.

### upstream 0.1.1 — 2024-12-14

Final upstream `package.json` bump on top of 0.1.0 beta after merging HB 2.0 support to `main`. No source changes since the merge commit. **`Off` control silently broken** (see "Why this fork exists" above).

### upstream 0.1.0 — 2024-12-13 (the breaking rewrite)

Wholesale rewrite of `lib/warmup4ie.js` from function-style to class-style ("Beta 0.1.0 - HB 2.0 support", PR #7). Added Homebridge 2.0 support, ESLint v9, Jest test sketch, and a CI workflow. Quietly introduced the two wire-format regressions documented above; the resulting plugin loads under HB 2.0 but cannot turn thermostats off and cannot accurately time overrides.

### upstream 0.0.14 — 2021-11-23

Last known-good upstream version. `Off` worked correctly here (full `setModes` body with all filler keys); overrides used local time. Crashed on Homebridge 2.0 + HAP v2 because of a transitive `fakegato-history` incompatibility (`Formats.DATA` undefined), but on HB 1.x it ran cleanly.

### upstream pre-0.0.14 — 2019–2021

Initial development sprint (June 2019, "Day 1"–"Day 7 - Beta ready"), iOS 13 fixes (Sept 2019), small patches (2019–2021). See upstream `git log` for details — commit messages are sparse ("Ooops", "Fix").
