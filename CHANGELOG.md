# Changelog

All notable changes to `homebridge-warmup4ie-v2` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This package is a maintained fork of [`homebridge-warmup4ie`](https://github.com/NorthernMan54/homebridge-warmup4ie). The fork begins at version 2.0.0 (a tribute to the original 1.x lineage) and is published to npm as `homebridge-warmup4ie-v2`. Pre-2.0.0 history below is the upstream history, kept for context.

---

## [3.12.1] — 2026-08-28

Reliability tuning driven by the v3.12.0 field logs. No config keys change,
no HomeKit accessory shape change.

### Changed

- **Request timeout raised from 10 s to 20 s.** The real-host logs behind the
  v3.12.0 QA showed seven `Warmup network error: The operation was aborted
  due to timeout` failures across three days — that is our own
  `AbortSignal.timeout` firing, because the Warmup cloud sometimes takes
  longer than 10 s from a domestic connection. Each one costs a whole poll
  cycle of stale data in HomeKit.

### Fixed

- **Polls can no longer stack on top of each other.** A single poll can issue
  up to three requests — initial, `_login`, retry — when a token error is
  hit. At the new 20 s timeout that worst case reaches 60 s, which exceeds
  `MIN_REFRESH_SECONDS` (30), so `setInterval` could fire a second poll over
  a still-running one: both would rewrite the room cache and push
  characteristics, doubling load on an API already known to be struggling at
  that moment. The poll now skips its tick while one is in flight.

  The flag is cleared in a `finally`, so neither a thrown error nor the early
  return when the client is absent can wedge polling permanently — a
  regression test covers exactly that, since getting it wrong would silently
  stop all updates until a restart.

---

### Internal

- **Dependency refresh.** `eslint` 9 → 10, `@eslint/js` 9 → 10,
  `eslint-plugin-jest` 28 → 29, `globals` 15 → 17, `jest` 29 → 30,
  `nodemon` 3.1.7 → 3.1.14, and the one runtime dependency `debug`
  4.4.0 → 4.4.3. `npm outdated` is now empty and `npm audit` still reports
  zero vulnerabilities. The production tree is unchanged apart from `debug`:
  still just `debug` and `fakegato-history`.
- **Removed `eslint-plugin-format`**, which was declared but never referenced
  by `eslint.config.mjs` — dead weight that pulled in prettier and the dprint
  formatters for nothing.
- **Attached `cause` to both wrapped transport errors.** ESLint 10's new
  `preserve-caught-error` rule caught this: `_fetch` rewrote network and JSON
  failures into a `Warmup …` message and discarded the original, so the
  underlying DNS failure, TLS error or abort reason was unrecoverable when
  debugging. The message string is deliberately unchanged, because
  `_isTokenError` and `asHapStatusError` pattern-match on it.
- The eslint 10 upgrade was only possible because v3.12.0 had already removed
  the `/* eslint-env jest */` directives — v10 promotes those from warning to
  hard error.

### Documentation

Findings from a full audit of every factual claim in the docs against the
code, rather than a read-through for plausibility.

- **CLAUDE.md's HomeKit mapping table was five releases stale.** It listed
  five characteristics; the plugin publishes twelve. Missing entirely:
  `StatusFault` (v3.3), `StatusActive` and `RemainingDuration` (v3.4), the Eve
  `TotalConsumption` characteristic (v3.5), the Vacation/Frost switches
  (v3.6), and the child-lock `LockMechanism` (v3.7). Three surviving rows were
  also wrong: `CurrentHeatingCoolingState` documented only the pre-v3.4
  temperature-delta heuristic and not the relay signal that supersedes it;
  `TemperatureSensor.CurrentTemperature` still said "parsed from string" after
  v3.12.0 made it a Number; and it claimed `validValues: [0, 1]` on
  `CurrentHeatingCoolingState`, which the code has never set — only the
  *Target* characteristic restricts validValues.
- **ROADMAP.md** still described the project as "v3.0.0 + unreleased polish",
  twelve releases behind, and its Verified-Plugin table asserted "no disk
  files yet" — untrue since v3.2, when fakegato began writing history under
  `api.user.storagePath()`. (The requirement still passes; the note was
  simply wrong.)
- **The CI Node matrix was corrected in one of four places** when it was first
  updated. The architecture tree, the CI/secrets section, and the file
  reference table all still said 18/20/22/24. All four now agree with
  `ci.yml`.
- README gained a note that rooms added or removed in MyHeating now sync
  without a restart — user-visible since v3.12.0 and previously undocumented
  — including why renames deliberately still wait for a restart.
- Two unit-test files (`firmware-and-energy`, `eve-characteristic`) existed
  but appeared in neither the architecture tree nor the file reference table.
- **`test/hbConfig/auth.json` untracked and gitignored.** It held the sandbox
  Homebridge-UI account used by `npm run watch` — username `test`, admin, with
  a salted 128-char password hash. Low severity (a hash, for a local sandbox),
  but a credential artifact in a public repo, absent from `.gitignore` unlike
  its sibling `config.json`, and regenerated by Homebridge UI on first run so
  nothing depended on it. Removed with `git rm --cached`, so local sandboxes
  keep working. **It remains in git history** — rewriting history over a
  sandbox `test` hash was judged disproportionate.
- Verified clean and left alone: all config keys agree across code,
  `config.schema.json`, README and CLAUDE.md; every one of the 33 functions
  named in the architecture tree exists; the tuning constants match the
  schema's min/max; zero broken internal links or anchors.

---

## [3.12.0] — 2026-08-28

Maintenance release out of a full repo health pass, followed by an
adversarial review of the result. MINOR rather than PATCH because the
supported Node range moves and one new config key is added.

Existing configs need no edits: the new `disableHistory` key is optional and
defaults to today's behaviour, and no HomeKit accessory shape changes. The
one thing to know before upgrading is the Node requirement — **Node 18 and
20 are no longer supported.**

Most of what follows was found by two review passes rather than by bug
reports, so the user-visible symptoms are ones you may never have noticed:
readings quietly invented from missing data, a setpoint change silently lost
to a write race, and rooms that needed a Homebridge restart to appear.

### Changed

- **Supported Node versions are now `^22 || ^24 || ^26`** (was
  `^18.20.4 || ^20.15.1 || ^22 || ^24`). Node 18 and 20 are both past
  end-of-life, and Homebridge 2.4 itself requires `^22 || ^24 || ^26`, so
  the old range advertised support for runtimes current Homebridge will
  not start on — while omitting Node 26, which is what Homebridge runs on
  today. Users on Node 26 were seeing a spurious engine-mismatch warning.
  The CI matrix moves to `22 / 24 / 26` to match.
- **Failed logins now say what went wrong.** Warmup's REST error payload
  carries its signal in `response.errorCode` and includes no prose at all
  — a wrong password returns
  `{"status":{"result":"error"},"response":{"errorCode":101}}`. The old
  code looked only for `message` / `status.message` and fell through to
  `JSON.stringify(status)`, so the Homebridge log showed
  `Warmup API: {"result":"error"}` for the single most common failure
  users hit. It now reads `Warmup API: invalid email or password
  (errorCode 101)`, with unmapped codes still reported by number. Only code
  101 gets prose, because it is the only one confirmed against the live API
  — a confidently wrong label ("access token expired" for something else)
  would send the user down the wrong path, and the raw number stays
  searchable either way. The legacy `status.code` location is read as well
  as the modern `response.errorCode`.

### Added

- **`disableHistory`** (default `false`) — turns off the Eve.app history
  graphs, and with them the single largest cost this plugin imposes.

  `fakegato-history` declares the Google APIs client as a hard dependency and
  requires its Google Drive backend at the *top level* of
  `fakegato-storage.js`, so merely requiring fakegato loads the whole thing —
  even though this plugin only ever passes `storage: 'fs'`. Measured by
  booting the real platform both ways in separate processes:

  | | history on | `disableHistory: true` |
  |---|---|---|
  | RSS | 110.5 MB | **5.9 MB** |
  | modules loaded | 1049 | **10** |
  | googleapis loaded | yes | **no** |

  That is per Homebridge process, on every start, plus ~194 MB in
  `node_modules`. The fakegato load is now deferred to first use, so setting
  the toggle means the module is never required at all rather than merely
  unused. No HomeKit characteristic behaves differently either way, and
  history already written to disk is left untouched, so it can be turned back
  on later.

  **This mitigates rather than solves the problem** — users who want Eve
  graphs still pay in full. It cannot be fixed properly from inside this
  package: `overrides` in a package's own manifest are ignored when it is
  installed as a dependency, and `patch-package` only patches the tree of the
  project that runs it, so neither reaches an end user's install. A
  postinstall rewriting another package's files on a user's machine would be
  fragile across hoisting layouts and inappropriate for a Verified plugin.
  Upstream is effectively unmaintained (0.6.7 is latest, published
  2025-03-24) and there is no maintained fork on npm. The remaining options —
  publishing our own patched fork, or reimplementing the slice of the Eve
  history format we use — are real commitments and are not scheduled.

- **Rooms added or removed in the MyHeating app now reach HomeKit without a
  Homebridge restart.** Discovery ran only at `didFinishLaunching`, and the
  poll loop's `updateAccessoryState` returns early for any room it has no
  accessory for — so a newly-created room stayed invisible, and a deleted one
  stayed on the tile grid, until the next restart. The poll tick now
  reconciles too.

  It reconciles *only when the room set actually differs*, via a cheap
  set-comparison: reconciling re-attaches every service and calls
  `updatePlatformAccessories`, which makes Homebridge rewrite its on-disk
  accessory cache — doing that every `refresh` seconds forever would be pure
  SD-card churn on the Raspberry Pis most Homebridge installs run on.

  The comparison is deliberately identity-only, never names. Reconciling
  overwrites `displayName` from Warmup, so treating a rename as a change
  would put the plugin in a poll-rate loop fighting any rename the user makes
  in Apple Home. Renames still land on restart, exactly as before.

  The existing "0 rooms is probably a Warmup hiccup, not a mass deletion"
  guard in `reconcileAccessories` still applies, and is now covered by a test
  that drives it through the polling path rather than only through bootstrap.

### Fixed

- **Nullable fields no longer surface as invented readings.** Every
  temperature in the GraphQL schema is nullable, and `Number(null)` is `0`,
  not `NaN` — so a null `currentTemp` sailed past every finite check and
  rendered in HomeKit as a genuine **0 °C**, while a null `targetTemp` was
  clamped up to the device minimum and shown as a confident **5 °C**.
  `normalizeRoom` now maps absent temperatures to `null` and the platform
  skips the characteristic write, leaving the last known value in place. A
  real `0` is still published — the point is to tell "zero" apart from
  "don't know", which the old coercion could not.
- **`effectiveTargetTemp` no longer clamps against a nonsense floor.** With
  an inverted range (`minTemp` above `maxTemp`) it raised a perfectly good
  21 °C setpoint to 30 °C; it now clamps only against a sane floor and
  returns `null` when there is no target to show.
- **Eve's energy graph no longer collapses to the origin.**
  `deriveTotalConsumption` returned `0` for an absent or unusable `total`.
  That feeds a *cumulative* counter, so one null poll (the field is
  nullable, and pre-v3.5 devices never send it) dropped the long-term graph
  to zero and jumped back on the next poll. It now returns `null` and the
  write is skipped. A genuine `0` is still reported as `0`.
- **A room with no paired thermostat no longer claims to be heating.** Such
  a Room still carries `currentTemp`/`targetTemp`, so the temperature-delta
  fallback confidently reported HEAT for a room with no relay to close, and
  `StatusActive` reported it as a healthy device. Both now key off a new
  `hasThermostat` flag: the accessory reports idle and inactive, which is
  what is actually true, instead of looking functional right up until a
  control silently fails.
- **Writes for one accessory are serialized.** The debounce entry was
  deleted *before* its request was awaited, so a second slider adjustment
  made during the first round trip started a second concurrent request — and
  a mode tap could race a slider drag freely. With an ordinary pair of
  latencies the responses land out of order, the device is left obeying the
  older setpoint, and the next poll reads that value back, so the user's
  change disappears with no error anywhere. Reproduced end-to-end (asked for
  22 °C, device ended at 20 °C) before fixing. All three per-accessory
  writes — setpoint, mode, child lock — now go through one ordered queue.
- `pushLocationSwitchStates` guarded `platform.thermostats` on one line and
  then dereferenced `._locId` unguarded on the next.
- **A room with no paired thermostat no longer pushes `NaN` into HomeKit.**
  A Room created in the MyHeating app but not yet commissioned (or mid-RMA)
  comes back with `thermostat4ies: []`, so every thermostat-level field is
  absent. `minTemp`/`maxTemp` feed `TargetTemperature`'s bounds, and
  `undefined / 10` is `NaN` — HAP rejects non-finite values, leaving the
  accessory broken in HomeKit. Confirmed by tracing the real platform code:
  four separate HAP calls received `NaN` (`setProps` min and max,
  `TargetTemperature.updateValue`, and the air sensor's
  `CurrentTemperature.updateValue`). `normalizeRoom` now falls back to the
  5–30 °C range Warmup's own devices ship with, and the platform skips any
  characteristic write whose value is not finite rather than substituting a
  fabricated `0 °C` that HomeKit would render as a real reading.
- Setpoint bounds are only narrowed when the device reports a usable range;
  an inverted or non-numeric range logs a warning and leaves HomeKit's
  defaults in place instead of throwing during accessory setup.
- No fakegato history entry is recorded when either temperature is
  non-finite, so a bad poll can't write `NaN` into the Eve graph data.

### Security

- `npm audit` is clean (was 4 advisories: 1 low, 1 moderate, 2 high). The
  only one that reached the production tree was `qs` (moderate DoS) via
  `fakegato-history → googleapis → googleapis-common`; it resolves to a
  patched `qs` with no change to our direct dependencies. The vulnerable
  path was never reachable here in any case — it needs fakegato's Google
  Drive backend, and the plugin hardcodes `storage: 'fs'`. The other three
  were dev-only (jest/eslint transitives).

### Internal

- `eslint` 8.57.1 → ^9. v8 is end-of-life and npm printed a deprecation on
  every install; `@eslint/js` was already declared at `^9`, so the two are
  now on the same major.
- Dropped the redundant `/* eslint-env jest */` directive from all 11 test
  files. Flat config already injects the jest globals, and ESLint 9 warns
  on the directive because it becomes a hard error in v10. `npm run lint`
  is now silent.
- **`test/fixtures/graphql.owned.json` refreshed to the current payload.**
  It had not been updated since v3.2 and was missing every field added
  since: `total` (v3.5, Eve energy), `appFw` / `wifiFw` (v3.5, firmware),
  and `parameters { outputStatus lock }` (v3.4 relay signal, v3.7 child
  lock). All four are in the production query, so three releases' worth of
  wire→normalize→HomeKit plumbing had no integration coverage — visible as
  the 81% branch coverage in `normalizeRoom`. The Bathroom room now reports
  `outputStatus: 0` while sitting below its setpoint, which pins the
  behaviour that the real relay signal beats the old temperature-delta
  heuristic; its `appFw` is `null` to exercise the FirmwareRevision
  fallback.
- New `test/fixtures/graphql.owned.unpaired.json` covering the empty
  `thermostat4ies` case, plus tests at both layers: `normalizeRoom` returns
  usable defaults, and the platform pushes no `NaN` to HAP. The latter
  fails against the pre-fix code, so it is a real regression test — the
  existing HAP shim stubs `setProps`/`updateValue` as no-op `jest.fn()`s,
  which is why nothing caught this before.
- `test/fixtures/userLogin.error.json` replaced with the exact body the
  live API returns for bad credentials. The old fixture invented a
  `status.message` the API never sends, which is what let the useless
  error message ship — the bootstrap test asserted only `/Warmup API/`
  and now asserts the full decoded string.
- `normalizeRoom` routes temperatures through a `tenths()` helper, so
  `airTemp` is a Number of tenths (was a String, since `Thermostat4iE`
  types it as `String` on the wire) and every temperature field the
  platform divides by 10 has one consistent type. `null` now means "no
  reading" and is distinguishable from a real `0`.
- Noted in-source that the REST `"code"` branch of `TOKEN_ERROR_PATTERN`
  is unreachable: since v3.0 the REST surface is login-only, and
  `_isTokenError` is consulted only for errors out of `_graphql`.
- Corrected a stale comment in `normalizeRoom` claiming
  `parameters { outputStatus }` was not yet in the GraphQL query — it has
  been since v3.4.
- New `_rest` error-decoding tests covering all five payload shapes the
  gateway can return.
- `normalizeRoom` gained a `hasThermostat` flag. The state derivers test it
  with `=== false`, so rooms cached from an earlier release (and the
  synthetic rooms in the test suite), which have no such field, keep their
  previous behaviour rather than silently flipping to "inactive".
- Live-test assertions rewritten as type-shape checks. The previous ones
  used `Number.isFinite(Number(v))`, which passes for `null` (`Number(null)`
  is 0), and `toHaveProperty`, which is vacuous because `normalizeRoom`
  always sets the key — so both claimed a drift-detection guarantee they did
  not provide. Field *removal* was already covered anyway: the query itself
  is rejected and bootstrap throws. What the new assertions actually catch
  is a field that still resolves but changes type.
- `platform-state.test.js` now tears every platform it builds down in
  `afterEach`. Tests called `platform.shutdown()` as their last statement,
  which a failing assertion skips — the leaked poll interval then kept jest
  alive until it was force-killed, turning a clear one-line assertion
  failure into a hung suite with no output. Hit while verifying the
  write-ordering fix.
- 144 offline tests pass (up from 127 in v3.11.0), including four that
  drive room addition, room removal, the no-op path, and the empty-response
  guard through the polling loop.  Branch coverage 74.5% → 80.5% overall;
  `src/lib/warmup4ie.js` 81.1% → 91.4%; `src/lib/state.js` and
  `src/lib/metadata.js` at 100%.

### Known, not addressed

- The `fakegato-history` → `googleapis` weight is mitigated by
  `disableHistory` (above) but not removed for users who want Eve graphs.
  See that entry for why it cannot be fixed from inside this package and
  what the remaining options are.
---

## [3.11.0] — 2026-05-06

Adds the **`disableAirSensor`** opt-out toggle, the actual fix for the
"thermostat-first tile" UX request that drove the v3.10.1–v3.10.4
churn. Each room exposes a paired `Service.TemperatureSensor` (the
"<name> Air" tile) on top of the Thermostat by default — useful for
devices in floor-sensor mode where the Thermostat's `CurrentTemperature`
reports floor temp and the standalone tile is the only way to see air
temp; redundant for devices in air-sensor mode where both readings are
the same. Setting `"disableAirSensor": true` hides the standalone tile,
which also gets the Apple Home accessory detail view down to a single
Thermostat tile (plus the optional Lock sub-component) instead of the
two-tile sibling layout that iOS Home renders for paired services.

The `addLinkedService` approach we attempted in v3.10.3 broke
accessory rename in iOS Home (see v3.10.3/v3.10.4 entries below), so
this is the path we settled on.

### Added

- **`disableAirSensor`** (default `false`) — hides the per-thermostat
  `Service.TemperatureSensor`. Cached air-sensor services are
  unlinked from the parent Thermostat and removed on next launch (the
  unlink prevents a dangling reference in `thermo.linkedServices` for
  v3.10.3-era accessories).
- Surfaced in `config.schema.json` so the toggle shows up in the
  Homebridge UI form-based config editor.

### Internal

- `attachAccessoryServices` gates the TemperatureSensor block on
  `platform.disableAirSensor` (mirroring the `disableChildLock`
  pattern from v3.10.0).
- `pushRoomState` no longer early-returns when `temp` is undefined —
  the Thermostat side is updated unconditionally and the
  TemperatureSensor write is now guarded behind an existence check.
- New `unlinkTempFromThermo(thermo, tempService)` helper at the
  bottom of `src/index.js` consolidates the v3.10.3-link cleanup
  logic (defensive `removeLinkedService` with a `linkedServices`
  array splice fallback) so the same cleanup runs on both the
  "keep the air sensor, just drop the link" and the "remove the
  air sensor entirely, drop the link too" paths.
- New tests in `platform-state.test.js` (+2): `disableAirSensor`
  skips creation; `disableAirSensor` removes a cached
  TemperatureSensor and unlinks any v3.10.3-era link before
  removal. 127 offline tests pass (up from 125 in v3.10.4).
- `config.schema.json` GitHub URLs updated to the renamed repo
  (`nookied/homebridge-warmup-v2`) — last few stragglers from the
  v3.10.2 rename.

---

## [3.10.4] — 2026-05-06

Regression rollback. v3.10.3 linked the `TemperatureSensor` as a child
of the `Thermostat` via `Service.addLinkedService` to get Apple Home
to render the air sensor as a nested sub-component of the thermostat
tile. Real-device testing surfaced a side effect: **iOS Home then
refused to rename the accessory** ("Could not change settings" alert
when editing the accessory's name field in Settings). Apparently
adding a linked service after pairing alters the accessory shape in a
way the Home app dislikes for rename writes. The lock service has
been linked the same way since v3.7 without this issue, so the
trigger is specifically the post-pairing addition of the link, not
linked services in general.

### Fixed

- `attachAccessoryServices` no longer calls
  `thermo.addLinkedService(tempService)`. Existing cached accessories
  carrying the link from v3.10.3 are actively unlinked at runtime via
  `thermo.removeLinkedService(tempService)` (with a defensive fallback
  that splices `thermo.linkedServices` directly if the older HAP-NodeJS
  doesn't expose `removeLinkedService`). Homebridge persists the
  cleaned state on next shutdown, so users don't need a second cache
  reset.

### Caveat (back to v3.10.2 behaviour)

iOS Home is back to rendering the `TemperatureSensor` as a sibling
tile next to the `Thermostat` in the accessory detail view. The
v3.10.2 service-insertion-order tweak is still in place but, as we
confirmed via testing, it has no visible effect — Apple Home
applies its own layout rules. The right path for a "thermostat-only"
look is a `disableAirSensor` opt-out toggle (next on the list); see
ROADMAP.

---

## [3.10.3] — 2026-05-06

Follow-up to v3.10.2 after real-device testing showed iOS Home doesn't
order accessory detail-view tiles by service insertion order — Apple's
Home app applies its own rendering rules, so the v3.10.2 swap was a
no-op visually. v3.10.3 takes a different approach: the
TemperatureSensor service is now linked as a child of the Thermostat
via `Service.addLinkedService`, the same pattern already used for the
child-lock service. Apple Home renders linked services as nested
sub-components of their parent rather than as independent siblings,
which is the actual behaviour users expect from a thermostat-with-air-
probe accessory.

### Changed

- `attachAccessoryServices` calls
  `thermo.addLinkedService(tempService)` after creating the
  TemperatureSensor so iOS Home groups it under the Thermostat tile.
  `addLinkedService` is idempotent, so cached accessories pick up the
  link on next restart without needing a cache reset (unlike v3.10.2).

---

## [3.10.2] — 2026-05-06

Republish of v3.10.1 under a new version after a sigstore-provenance
publish failure. The GitHub repo had been renamed
`homebridge-warmup4ie-v2` → `homebridge-warmup-v2` between the v3.10.0
release (May 5) and the v3.10.1 push, but `package.json#repository.url`
still pointed at the old URL — npm rejected the publish with HTTP 422
(`Failed to validate repository information`). Same code as v3.10.1
(see Changed/Caveat below); v3.10.1 exists as a git tag but never made
it onto npm. The npm package name (`homebridge-warmup4ie-v2`) is
unchanged.

### Fixed

- `package.json#repository.url`, `bugs.url`, and `homepage` updated to
  match the renamed GitHub repo (`homebridge-warmup-v2`).
- README + CLAUDE.md GitHub URL references updated for consistency.

### Changed (carried over from v3.10.1)

- `attachAccessoryServices` adds the Thermostat before the
  TemperatureSensor so iOS Home honours service insertion order in the
  accessory detail view — the thermostat tile renders to the left of
  the air sensor instead of after it. The Thermostat was already marked
  primary (and renders larger either way); this is purely a placement
  fix that matches what users expect from a thermostat-first accessory.

### Caveat for existing users

Cached accessories already have their services persisted in the
original order and `getService` retrieves them as-is — the swap only
affects newly-created accessories. To pick up the new order on an
existing setup, reset the plugin's cached accessory in the Homebridge
UI (Settings → Remove Single Cached Accessory) so the rooms get
re-discovered fresh. Fresh installs benefit automatically.

---

## [3.10.1] — 2026-05-06 (failed to publish)

Tagged but never published to npm — `package.json#repository.url`
mismatched the renamed GitHub repo, so npm's sigstore provenance check
returned HTTP 422. Content shipped under v3.10.2 instead.

---

## [3.10.0] — 2026-05-06

Three new opt-out feature toggles for the optional HomeKit accessories
the plugin creates, motivated by a real user report that the **Warmup
Element Wi-Fi** doesn't honour the `deviceAdvanced.lock` mutation —
tapping the child-lock tile in HomeKit succeeds at the API but the
device's touch screen stays unlocked. Until/unless we find a per-model
capability flag in the Warmup API, the disable flag is the right
escape hatch. The Vacation/Frost switches got the same treatment for
consistency: not everyone wants those tiles in their Home grid.

### Added

- **`disableChildLock`** (default `false`) — hides the per-thermostat
  `Service.LockMechanism` and removes it from any cached accessories on
  next launch. Recommended for **Warmup Element Wi-Fi** users; the
  device accepts the mutation but doesn't lock the touch screen.
- **`disableVacationSwitch`** (default `false`) — hides the location-wide
  Vacation Mode switch. Cached accessory is unregistered on next launch.
- **`disableFrostSwitch`** (default `false`) — hides the location-wide
  Frost Protection switch. Cached accessory is unregistered on next
  launch.

All three are exposed in the Homebridge UI form-based config editor
(`config.schema.json`).

### Internal

- `LOCATION_SWITCHES` specs now carry a `disabledBy` key (`'disableVacationSwitch'`
  / `'disableFrostSwitch'`) so the reconcile loop can filter them by
  reading `platform[spec.disabledBy]`.
- `removeStaleLocationAccessories(platform, locId, enabledSpecs)` now
  unregisters not only switches from old `locId`s but also switches
  whose kind is no longer in the enabled set — same code path handles
  both transitions cleanly.
- `attachAccessoryServices` honours `platform.disableChildLock` by
  removing any existing `Service.LockMechanism` from the accessory; the
  Apple Home tile disappears on the next reconcile.
- New tests in `platform-state.test.js` (+4): each disable flag verified
  end-to-end (creation skipped + cached accessory removed). 125 offline
  tests pass (up from 121 in v3.9.1).

---

## [3.9.1] — 2026-05-05

Hotfix for a v3.8.0 regression that surfaced once HAP-NodeJS 2.1.5
landed on user devices: the `Characteristic.Formats` static accessor
was removed in newer HAP-NodeJS, and v3.8.0+ referenced
`Characteristic.Formats.FLOAT` directly inside the
`EveTotalConsumption` constructor. The first time HAP instantiated the
class, the plugin crashed with `Cannot read properties of undefined
(reading 'FLOAT')` and the child bridge died on every restart.

### Fixed

- **`Characteristic.Formats.FLOAT` crash on HAP-NodeJS 2.1.5+** (e.g.
  Homebridge 2.0.1). New `src/lib/hap-compat.js` resolves Formats and
  Perms enums through a fallback chain: `homebridge.hap.Formats` (modern
  HAP-NodeJS top-level) → `Characteristic.Formats` (older static
  accessor) → HAP-spec string literals (stable wire-format values that
  never change). The Eve.Energy.TotalConsumption custom characteristic
  now constructs cleanly across every HAP-NodeJS version we support.

### Tests

- New `test/unit/eve-characteristic.test.js` (5 tests) covers the
  Formats/Perms resolution chain end-to-end, including the regression
  case where neither accessor is exposed. **121 offline tests now pass
  (up from 116 in v3.9.0).**

### Why we missed it in 3.9.0

The class definition was wrapped in try/catch — but the catch only fires
if the *definition* throws. The bug fires inside the *constructor* when
HAP later instantiates the class. The mock `Characteristic` in the
existing platform-state tests is a plain object (not a class), so
`class extends Characteristic` would throw at definition time, hit the
catch, set `EveTotalConsumption = null`, and the constructor was never
exercised in tests. CI was green; the manual QA step on a real
Homebridge would have caught it but was skipped during the rapid 3.7.1
→ 3.8.0 → 3.9.0 release lap.

---

## [3.9.0] — 2026-05-05

Post-release review pass (Codex). Three correctness fixes that surface
under specific HomeKit usage patterns, plus a small refactor that makes
the metadata helpers testable in isolation. **Recommended upgrade for
anyone running v3.8.0 or earlier** — the debounce-promise fix in
particular eliminates a class of "spinner that never resolves" issues
when sliding the temperature.

### Fixed

- **Debounced target-temperature writes now settle every HomeKit caller.**
  Previously, when multiple slider updates landed inside the 300 ms
  window, only the *last* call's promise was wired to the API result —
  earlier callers were left with a Promise that would never resolve and
  HomeKit would spin until HAP's own timeout fired. The debouncer now
  shares a single `{value, timer, promise, resolve, reject}` per
  accessory: the value is rolled forward to the latest slider position,
  the timer is reset, and *every* caller resolves/rejects from the one
  outgoing API call.
- **Pending debounces are flushed on shutdown.** The shutdown handler
  now rejects any in-flight debounced writes with
  `HAPStatus.SERVICE_COMMUNICATION_FAILURE` instead of leaving HomeKit
  callers hanging on a timer that will never fire.
- **Stale Vacation/Frost location switches are unregistered when the
  active Warmup location changes.** If you switched accounts or your
  account's `user.owned[0]` location changed, cached synthetic switches
  for the old `locId` previously lingered in HomeKit indefinitely. The
  reconcile pass now diffs them out alongside stale thermostats.
- **Live API tests accept the full Warmup `runMode` enum.** Was hard-coded
  to `off | fixed | override | schedule`; now matches the
  jondarrer/warmup-api schema (`not_set, off, schedule, override, fixed,
  anti_frost, holiday, fil_pilote, gradual, relay, previous`). Stops
  the live test from failing spuriously when a room reports e.g.
  `holiday`.

### Internal

- **Metadata derivation helpers extracted to `src/lib/metadata.js`**
  (`deriveFirmwareRevision`, `deriveTotalConsumption`). The unit tests in
  `firmware-and-energy.test.js` now require the shipped module directly
  instead of duplicating the helper logic — guarantees the tests catch
  production drift rather than just verifying themselves.
  `deriveFirmwareRevision` takes `fallback` as an explicit argument now,
  so the helper is pure (no closure over `PLUGIN_VERSION`).
- **`package-lock.json` root version refreshed** to match `package.json`.
- **+2 platform-state tests** covering the new debounce behaviour and
  stale-location-switch cleanup. 116 offline tests now pass (up from 114
  in v3.8.0).

### Verified

- `npm run lint` — clean.
- `npm test` — 116 offline tests pass (3 live tests skipped without
  credentials).
- `npm run smoke` — entry-point loads.

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

### Internal

- **Dependency refresh.** `eslint` 9 → 10, `@eslint/js` 9 → 10,
  `eslint-plugin-jest` 28 → 29, `globals` 15 → 17, `jest` 29 → 30,
  `nodemon` 3.1.7 → 3.1.14, and the one runtime dependency `debug`
  4.4.0 → 4.4.3. `npm outdated` is now empty and `npm audit` still reports
  zero vulnerabilities. The production tree is unchanged apart from `debug`:
  still just `debug` and `fakegato-history`.
- **Removed `eslint-plugin-format`**, which was declared but never referenced
  by `eslint.config.mjs` — dead weight that pulled in prettier and the dprint
  formatters for nothing.
- **Attached `cause` to both wrapped transport errors.** ESLint 10's new
  `preserve-caught-error` rule caught this: `_fetch` rewrote network and JSON
  failures into a `Warmup …` message and discarded the original, so the
  underlying DNS failure, TLS error or abort reason was unrecoverable when
  debugging. The message string is deliberately unchanged, because
  `_isTokenError` and `asHapStatusError` pattern-match on it.
- The eslint 10 upgrade was only possible because v3.12.0 had already removed
  the `/* eslint-env jest */` directives — v10 promotes those from warning to
  hard error.

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

### Internal

- **Dependency refresh.** `eslint` 9 → 10, `@eslint/js` 9 → 10,
  `eslint-plugin-jest` 28 → 29, `globals` 15 → 17, `jest` 29 → 30,
  `nodemon` 3.1.7 → 3.1.14, and the one runtime dependency `debug`
  4.4.0 → 4.4.3. `npm outdated` is now empty and `npm audit` still reports
  zero vulnerabilities. The production tree is unchanged apart from `debug`:
  still just `debug` and `fakegato-history`.
- **Removed `eslint-plugin-format`**, which was declared but never referenced
  by `eslint.config.mjs` — dead weight that pulled in prettier and the dprint
  formatters for nothing.
- **Attached `cause` to both wrapped transport errors.** ESLint 10's new
  `preserve-caught-error` rule caught this: `_fetch` rewrote network and JSON
  failures into a `Warmup …` message and discarded the original, so the
  underlying DNS failure, TLS error or abort reason was unrecoverable when
  debugging. The message string is deliberately unchanged, because
  `_isTokenError` and `asHapStatusError` pattern-match on it.
- The eslint 10 upgrade was only possible because v3.12.0 had already removed
  the `/* eslint-env jest */` directives — v10 promotes those from warning to
  hard error.

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

### Internal

- **Dependency refresh.** `eslint` 9 → 10, `@eslint/js` 9 → 10,
  `eslint-plugin-jest` 28 → 29, `globals` 15 → 17, `jest` 29 → 30,
  `nodemon` 3.1.7 → 3.1.14, and the one runtime dependency `debug`
  4.4.0 → 4.4.3. `npm outdated` is now empty and `npm audit` still reports
  zero vulnerabilities. The production tree is unchanged apart from `debug`:
  still just `debug` and `fakegato-history`.
- **Removed `eslint-plugin-format`**, which was declared but never referenced
  by `eslint.config.mjs` — dead weight that pulled in prettier and the dprint
  formatters for nothing.
- **Attached `cause` to both wrapped transport errors.** ESLint 10's new
  `preserve-caught-error` rule caught this: `_fetch` rewrote network and JSON
  failures into a `Warmup …` message and discarded the original, so the
  underlying DNS failure, TLS error or abort reason was unrecoverable when
  debugging. The message string is deliberately unchanged, because
  `_isTokenError` and `asHapStatusError` pattern-match on it.
- The eslint 10 upgrade was only possible because v3.12.0 had already removed
  the `/* eslint-env jest */` directives — v10 promotes those from warning to
  hard error.

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
