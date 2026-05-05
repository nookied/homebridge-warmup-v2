# Changelog

All notable changes to `homebridge-warmup4ie-v2` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This package is a maintained fork of [`homebridge-warmup4ie`](https://github.com/NorthernMan54/homebridge-warmup4ie). The fork begins at version 2.0.0 (a tribute to the original 1.x lineage) and is published to npm as `homebridge-warmup4ie-v2`. Pre-2.0.0 history below is the upstream history, kept for context.

---

## [Unreleased]

### Fixed

- **Debounced target-temperature writes now settle every HomeKit caller.**
  Multiple slider updates inside the 300 ms debounce window share one pending
  promise and send only the latest temperature to Warmup, avoiding stale
  HomeKit writes hanging until HAP times out.
- **Stale Vacation/Frost location switches are removed when the active
  Warmup location changes.** Cached synthetic switches for an old `locId` no
  longer linger in HomeKit after an account/location change.
- **Live API tests now accept the full Warmup `runMode` enum**, including
  `holiday`, `anti_frost`, and `gradual`.

### Internal

- **Firmware/energy derivation helpers moved to `src/lib/metadata.js`** so
  tests exercise production code directly instead of duplicating helper logic.
- **`package-lock.json` root version refreshed to 3.8.0** to match
  `package.json`.

---

## [3.8.0] — 2026-05-05

Final validation pass before handoff — quality, robustness and
documentation polish. No regression to the happy path; defensive
hardening on the unhappy paths, a fix for the Eve energy graph, and an
Apple Home tile-grouping improvement for the child lock. Concludes the
post-M6 polish lap; **handoff release**.

### Fixed

- **Eve.Energy.TotalConsumption is now `FLOAT`** (was `UINT32` with
  `minStep: 1`). The integer-rounded form was silently losing fractional
  kWh — Eve.app's long-term graph would plateau until a full kWh ticked
  over. Matches the convention used by other Eve-aware Homebridge plugins.
  `deriveTotalConsumption` now rounds to 3 decimals (drops FP noise
  without losing useful precision).
- **Set handlers now throw a clean HAP error when bootstrap failed.** If
  the Warmup login or initial fetch errored at startup (`platform.thermostats
  === null`), tapping a HomeKit control would previously throw a generic
  `TypeError: Cannot read properties of null`. We now surface
  `HAPStatus.SERVICE_COMMUNICATION_FAILURE` so HomeKit shows
  "Not Responding" instead of a stack trace. Applies to thermostat
  on/off/heat/auto, target-temp slider, child-lock toggle, and the
  Vacation/Frost location switches.

### Changed

- **LockMechanism is linked to the Thermostat service.** Apple Home now
  groups the child-lock under the thermostat tile (one tile, expandable)
  instead of showing two unrelated tiles in the room. Idempotent on
  cached accessories.

### Internal

- **Request headers** now include `accept-language: en-gb` and
  `x-request-type: GraphQL` to match the official Warmup mobile app's
  request shape. The `accept-language` change avoids occasionally getting
  localized error messages back from the gateway in a non-English
  language.
- **`config.schema.json`** declares a top-level JSON-Schema `required`
  array (`["name", "username", "password"]`) in addition to the
  per-property `required: true` flags. Belt-and-braces — the Homebridge
  config UI honours both, but the array form is the standard.
- **README:** new "Privacy & data" section noting that the `app-token`
  baked into the source is the same static token shipped in the Warmup
  mobile app (extracted from public traffic captures), not a per-user
  secret. Pre-empts confusion when readers see the value in plain text.
- **Test parity:** `firmware-and-energy.test.js` updated to match the new
  `deriveTotalConsumption` (3-decimal rounding rather than `Math.floor`).

### Verified

- `npm run lint` — clean (0 warnings, 0 errors).
- `npm test` — 114 offline tests pass (3 live tests skipped without
  credentials).
- `npm run smoke` — entry-point loads and registers the platform.
- All v3.7.0 child-lock behaviour verified intact in the test mock and
  by re-reading the wire-format suite.

---

## [3.7.0] — 2026-05-05

Roadmap [Milestone 6](ROADMAP.md) batch 5 — **child lock** per thermostat
via `deviceAdvanced.lock`. **Marks M6 substantially complete** — see
roadmap for which items intentionally won't ship.

### Added

- **`Service.LockMechanism` per Thermostat accessory.** Disables the
  physical thermostat's touch screen while still letting the Warmup app
  + this plugin change settings. Useful for households with kids /
  curious cats / accidental tile-swiping.
- **`setRoomChildLock(roomId, locked)`** lib method → GraphQL
  `deviceAdvanced(lid, rid, lock: Boolean)`. Live-tested cleanly; the
  gateway accepts `Boolean!` for the `lock` arg.
- **`parameters { lock }`** added to the GraphQL query. Returns Int (0/1)
  in practice; `normalizeRoom` coerces to a boolean for HomeKit.
- **`LockCurrentState` / `LockTargetState`** characteristics on the new
  Lock service. Optimistic update on tap (Target → Current); polling
  reconciles from the device's actual state.
- **Tests:** 117 total, 114 offline + 2 live + 1 destructive (skipped).
  Up from 112 in v3.6.0. Five new tests:
  - 3 wire-format tests (true/false sends, Boolean coercion of
    truthy/falsy values)
  - 2 platform-state tests (LockMechanism service attached, lock state
    reflects `room.lock` from polling)

### M6 status

After this release, Roadmap M6 is substantially complete:
- ✅ StatusFault (sensor diagnostics) — v3.3.0
- ✅ runMode edge cases — v3.3.0
- ✅ outputStatus relay signal — v3.4.0
- ✅ StatusActive offline detection — v3.4.0
- ✅ RemainingDuration override countdown — v3.4.0
- ✅ Eve.Energy.TotalConsumption — v3.5.0
- ✅ Real FirmwareRevision — v3.5.0
- ✅ Vacation Mode Switch — v3.6.0
- ✅ Frost Protection Switch — v3.6.0
- ✅ Child lock — v3.7.0
- 🚫 **Display brightness** — won't ship. HomeKit's only "0–100 dim" service
  is `Lightbulb`, which would render the thermostat as a lightbulb tile in
  Apple Home. Semantically wrong; bad UX outweighs the marginal value of
  controlling display brightness from HomeKit (use the Warmup app).
- 🚫 **Sensor offsets** — won't ship from M6. Calibrating floor probes is
  a niche admin task; the path through Eve's admin tab + custom Eve
  characteristics adds dependencies for marginal user value. Use the
  Warmup app.
- 🚫 **Schedule introspection (read-only)** — won't ship. HomeKit has no
  thermostat-schedule UI; the data would only sit in `accessory.context`
  for power users to dig out via Eve / Home Assistant. Low ROI; the
  Warmup app's schedule editor is much better than anything we could
  surface here.

**Next:** Roadmap M7 — apply for [Homebridge Verified](https://github.com/homebridge/verified)
status. All 11 verified-plugin requirements were already met at v3.1.0;
M6's user-facing polish + a few weeks of stability is the final prep.

---

## [3.6.0] — 2026-05-05

Roadmap [Milestone 6](ROADMAP.md) batch 4 — location-wide modes as HomeKit
Switches. Tap to enter Vacation Mode (frost-low setpoint for a year) or
Frost Protection (passive minimum heat). Tap again to resume schedule.

### Added

- **"Vacation Mode" Switch** per platform. Maps to GraphQL
  `deviceHoliday(lid, temperature: 50, days: 365, start, end)` (5 °C frost-low,
  one year, today → today + 365). Off → `cancelHoliday(lid)`. State reflects
  the room cache: any room with `runMode === 'holiday'` flips the switch ON.
- **"Frost Protection" Switch** per platform. Maps to GraphQL
  `deviceFrost(lid)` (location-wide). Off → `deviceProgram(lid)` (resume
  schedule). State reflects `runMode === 'anti_frost'` on any room.
- **Synthetic per-location accessory** for each Switch. Stable UUID seeded
  with locId (`warmup4ie:vacation:<locId>` and `:frost:<locId>`) so
  multi-account installs don't collide. Skipped from `reconcileAccessories`'s
  unregister-stale loop (they aren't tied to any room).
- **`reconcileLocationAccessories()`** runs once after bootstrap; idempotent
  on subsequent restarts (cached accessories get refreshed via
  `api.updatePlatformAccessories`, new ones registered via
  `api.registerPlatformAccessories`).
- **`pushLocationSwitchStates()`** runs every poll alongside per-room state,
  syncing the Switch.On values from the latest `runMode` data.

### Why I picked one Switch each (not Holiday + Frost combined into "Vacation")

Both modes serve subtly different intents in the Warmup app:
- **Frost** = "passive minimum heat"; toggle on/off, no temperature config.
- **Holiday** = "I'm away for X days at temperature Y"; calendared.
For a HomeKit toggle, exposing both lets users pick the one that matches
their actual use case rather than collapsing both into a one-size-fits-all.

### Tests

- 112 total, 109 offline + 2 live + 1 destructive (skipped). Up from 103
  in v3.5.0. New:
  - 5 wire-format tests for the new GraphQL mutations
    (`setLocationFrost`/`clearLocationFrost`/`setLocationHoliday` with
    default + explicit args / `clearLocationHoliday`).
  - 4 platform-state tests for the location switches: stable UUIDs from
    locId, tap-on/tap-off invokes the right lib method, polling reflects
    `runMode` changes, and the switches survive an unrelated room being
    unregistered (didn't accidentally land in the unregister-stale loop).

---

## [3.5.0] — 2026-05-05

Roadmap [Milestone 6](ROADMAP.md) batch 3 — energy graphs in Eve and real
device firmware on the (i) info card.

### Added

- **`Eve.Energy.TotalConsumption` custom characteristic** on each
  Thermostat. Well-known UUID `E863F10C-079E-48FF-8F27-9C2605A29F52` —
  Eve.app reads this for its long-term energy graph. Populated from
  Warmup's `room.total` (cumulative kWh; the `room.energy` field is
  today-only and resets daily, which would make Eve's graph nonsensical).
  Range 0–4 294 967 295 kWh (UINT32). Class definition wrapped in
  try/catch so a hypothetical HAP-NodeJS API change doesn't kill the
  plugin — energy graphs degrade to "unavailable" rather than breaking
  the whole accessory.
- **Real `FirmwareRevision`** from Warmup's `appFw` (e.g. `"29.175"`).
  HAP requires `N{1,9}(.N{1,9}){0,2}` SemVer-ish format; we validate
  before applying and fall back to `PLUGIN_VERSION` for anything that
  doesn't parse (defensive against future API shape changes). Was
  always plugin version regardless of device.
- **GraphQL fields** `total`, `appFw`, `wifiFw` added to the query.
  All three accepted cleanly by the gateway (live-tested before commit).
  `wifiFw` is captured in `normalizeRoom` for future use but not yet
  surfaced — the Warmup API returns it as an empty string in practice.

### Tests

- 103 total, 100 offline + 2 live + 1 destructive (skipped). Up from
  95 in v3.4.0. New `firmware-and-energy.test.js` covers
  `deriveFirmwareRevision` (valid SemVer-ish formats, invalid formats
  with fallback, edge cases like leading `v`, pre-release suffixes,
  4 segments, 10-digit segments, numeric coercion) and
  `deriveTotalConsumption` (numeric, string, negative, NaN, missing).

### What this looks like for users

- **(i) info card** in Apple Home now shows the actual device firmware
  (e.g. `29.175`) instead of `3.5.0` (the plugin version).
- **Eve.app energy tab** now plots cumulative kWh per thermostat.
  Combined with v3.2.0's temperature/heating-state history, you get a
  complete picture of consumption over time.

---

## [3.4.0] — 2026-05-05

Roadmap [Milestone 6](ROADMAP.md) batch 2 — three additions, including the
real "is currently heating" relay signal that's been pending since v3.0.

### Added

- **`parameters { outputStatus }` in the GraphQL query.** The schema's
  relay-state field. Earlier in v3 development re-adding this caused
  HTTP 409 — but that was specific to the old `user.location(id:)` path.
  With the `user.owned[].rooms[].thermostat4ies[].parameters` shape we
  use today, the gateway accepts it cleanly. Verified live before tagging.
- **Real `CurrentHeatingCoolingState`.** `state.js` now prefers the
  `outputStatus` relay signal when present:
  - `outputStatus === 0` → idle (heating not active right now)
  - `outputStatus !== 0` → heating
  - field missing/null → falls through to the previous
    `currentTemp < targetTemp` heuristic (backward compat)
  Catches the cases the heuristic gets wrong: relay just turned off but
  currentTemp still below target ("approaching cycle end"), or relay
  active even though setpoint is already met (PID loop ramping down).
- **`StatusActive` characteristic** on each Thermostat. False ("Not
  Responding") if Warmup's `lastPoll` indicates the device hasn't
  checked in for >20 min. Useful when a thermostat physically loses
  power or Wi-Fi.
- **`RemainingDuration` characteristic** on each Thermostat — countdown
  in seconds for any active override. Some HomeKit clients render this
  on the tile; Eve uses it for trend tracking. Range widened to 0–86400 s
  (24 h, matches our `MAX_DURATION_MINUTES` limit) — HAP's default of
  3600 s would clamp longer overrides mid-flight.

### Tests

- 95 total, 92 offline + 2 live + 1 destructive (skipped). Up from 89
  in v3.3.0.
- New: 6 `outputStatus` test cases in `state-derivers.test.js` covering
  every combination of relay state / temp delta / runMode (relay
  takes precedence except when off, missing field falls through to
  heuristic).

### Why this is a minor bump (not patch)

`outputStatus` materially changes `CurrentHeatingCoolingState` semantics
for users — heating-state graphs in Eve and the heating indicator in
Apple Home will now reflect the actual relay rather than a heuristic.
That's a user-visible behaviour change, even if it's an improvement.

---

## [3.3.0] — 2026-05-05

Roadmap [Milestone 6](ROADMAP.md) batch 1 — incremental polish. No GraphQL
changes; everything uses data we already fetch. `config.json` unchanged.

### Added
- **`StatusFault` characteristic** on each Thermostat. Reads
  `room.isFaultAir | isFaultFloor1 | isFaultFloor2` (data already in the
  normalized room shape from v3.0). Surfaces sensor disconnects in
  HomeKit's accessory diagnostics — better than mysterious wrong
  readings. NO_FAULT (0) when clean, GENERAL_FAULT (1) when any flag set.
- **`runMode` edge-case handling** in `state.js` for the rare modes the
  GraphQL schema documents (`anti_frost`, `holiday`, `gradual`,
  `fil_pilote`, `relay`, `previous`, `not_set`):
  - `holiday` → `TargetHeatingCoolingState = OFF` (location-wide vacation
    mode; user expectation = "off"). `Current` still tracks `currentTemp <
    targetTemp` because heating to the holiday setpoint *is* heating.
  - `anti_frost` → `Target = OFF` (frost protection is passive).
    `Current` still tracks the temp delta.
  - `gradual` (early-start ramp-up) → `Target = AUTO`.
  - The four `not_set | fil_pilote | relay | previous` rare modes →
    `Target = HEAT` (safe fallback; better than OFF when heating may be
    happening).

### Fixed
- **Defensive guard against transient empty rooms.** If Warmup returns
  `owned[0].rooms = []` (a transient API hiccup; the user almost
  certainly didn't actually delete every thermostat in the seconds
  between polls), `reconcileAccessories` now logs a warning and skips
  the unregister-stale step. Without this guard, a single bad poll
  would rip every cached accessory out of the user's HomeKit rooms /
  scenes / automations.

### Documentation
- Per-thermostat metadata fields in `normalizeRoom` get inline comments
  explaining what each is for and which roadmap milestone surfaces it.

### Tests
- 89 total, 86 offline + 2 live + 1 destructive (skipped). Up from 75
  in 3.2.0. Notable additions:
  - `state-derivers.test.js`: 8 new test cases covering every documented
    `runMode` value (and a few unknown-mode fallbacks).
  - `platform-state.test.js`: `StatusFault` flow (NO_FAULT initially,
    GENERAL_FAULT after a sensor flag flips on the next poll); empty-rooms
    defensive guard (cached accessory survives a 0-room poll response).

---

## [3.2.0] — 2026-05-05

Roadmap [Milestone 5](ROADMAP.md) — **Eve / fakegato history graphs.**
Now that the dynamic platform (M4) makes accessories persistent, fakegato
can finally accumulate history across restarts. Eve.app users see
temperature, target-temperature, and heating-state graphs per thermostat;
Apple-Home-only users see no change.

### Added

- **`fakegato-history@^0.6.7`** dep (HAP-NodeJS v2-compatible — the version
  that fixes the `Formats.DATA` bug that originally killed `homebridge-warmup4ie@0.0.14`
  on Homebridge 2.0).
- **`FakeGatoHistoryService('thermo', accessory, ...)` per thermostat.**
  Constructed in `attachAccessoryServices`; the wrapper is in-memory only,
  but fakegato persists history JSON to `~/.homebridge/persist/history_*.json`
  independently of Homebridge's accessory cache.
- **Per-poll history entry** in `pushRoomState`: `{ time, currentTemp,
  setTemp, valvePosition }`. `time` is Unix seconds; temps are °C.
  `valvePosition` is synthesized as 100 when `deriveCurrentHeatingState`
  says heating, 0 when idle — Warmup's cloud doesn't expose actual valve
  percentage. Roadmap M6 may use `Thermostat4iE.parameters.outputStatus`
  (relay state) for a more accurate signal.
- **`disableTimer: true`** option on the history service. We control timing
  ourselves from the polling loop, so history aligns with actual data
  freshness instead of running on a separate clock.

### Changed

- Plugin module-init now requires `fakegato-history` once and binds the
  class to the homebridge instance. Wrapped in try/catch so a hypothetical
  fakegato breakage doesn't kill the plugin — graphs are nice-to-have.

### Tests

- **75 total**, 72 offline + 2 live + 1 destructive (skipped). Up from 73
  in 3.1.0.
- New: `fakegato history` test in `platform-state.test.js` — verifies the
  service is attached with correct type / options, an entry fires during
  the initial attach, and another entry fires per poll cycle.

### What this looks like for users

- **Apple Home only:** no visible change. The history service is invisible
  to default Home; thermostats look identical.
- **Eve app installed:** open the thermostat → swipe to the history tab →
  see graphs of current temp + set temp + heating state over the last
  10 days, week, month, year. Three-day default view.
- **Storage:** ~100 KB per thermostat per year, written to
  `~/.homebridge/persist/history_thermo_warmup4ie-<roomId>.json`.

### Why no Eve.Energy yet

The roadmap originally bundled Eve.Energy.TotalConsumption (mapped from
`room.energy`/`room.cost`) into M5. Punted to M6 to keep this release
focused — it requires defining custom Eve characteristic UUIDs (or
pulling in `homebridge-lib` for `EveHomeKitTypes`) and isn't essential
for the headline graphs.

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
