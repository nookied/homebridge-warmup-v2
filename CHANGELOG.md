# Changelog

All notable changes to `homebridge-warmup4ie-v2` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This package is a maintained fork of [`homebridge-warmup4ie`](https://github.com/NorthernMan54/homebridge-warmup4ie). The fork begins at version 2.0.0 (a tribute to the original 1.x lineage) and is published to npm as `homebridge-warmup4ie-v2`. Pre-2.0.0 history below is the upstream history, kept for context.

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
