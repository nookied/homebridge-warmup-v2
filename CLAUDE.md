# CLAUDE.md — homebridge-warmup4ie-v2

This file is the canonical persistent memory for this project. Any assistant/agent should update this file only; `AGENTS.md` is intentionally just a pointer here to avoid maintaining duplicate project memory.

---

## Project Overview

**npm name:** `homebridge-warmup4ie-v2`
**Type:** Homebridge plugin (Node.js, CommonJS)
**Purpose:** Expose Warmup Wi-Fi underfloor-heating thermostats as HomeKit Thermostat accessories. Supports the entire smart-thermostat range that pairs with my.warmup.com / the MyHeating app: 4iE (legacy), 6iE, 7iE Smart Matter, Element Wi-Fi, Terra Wi-Fi, and rebadged OEM units (Laticrete, Rointe, Porcelanosa, Equus, Savant). The "4ie" in the package name is historical — when the plugin was authored in 2019, the 4iE was Warmup's only smart thermostat.
**Repo:** [`https://github.com/nookied/homebridge-warmup4ie-v2`](https://github.com/nookied/homebridge-warmup4ie-v2) — **maintained fork**, published to npm under a distinct name
**Original (abandoned reference):** [NorthernMan54/homebridge-warmup4ie](https://github.com/NorthernMan54/homebridge-warmup4ie) — broke at 0.1.0 in Dec 2024 and never fixed; do not pull from or push to it
**License:** Apache-2.0 (preserved from original; LICENSE file added in 2.0.0)
**Current version:** **3.2.0** (Eve / fakegato history graphs; published 2026-05-05). Major v3 milestones: 3.0 GraphQL transport + per-room Off, 3.1 dynamic platform / Verified-eligible, 3.2 fakegato temperature history. Unreleased changes (if any) on `main` — check `git log v3.2.0..main`.
**Engines:** Homebridge `^1.6.0 || ^2.0.0`; Node `^18.20.4 || ^20.15.1 || ^22.0.0 || ^24.0.0`

### Fork rules

- This is a **maintained fork published to npm under a distinct name** (`homebridge-warmup4ie-v2`). The original (`homebridge-warmup4ie`) is unaffected and still on npm at 0.1.1.
- The HomeKit *platform identifier* in users' `config.json` stays `"platform": "warmup4ie"` for migration compatibility — only the npm package name differs.
- The `upstream` git remote is **intentionally not configured**. Do not re-add it. Do not open PRs against `NorthernMan54/homebridge-warmup4ie`.
- CI runs lint + tests + smoke on Node 18/20/22/24 for every push (`.github/workflows/ci.yml`). Releases are tag-driven: `npm version patch|minor|major && git push --follow-tags` triggers `release.yml`, which publishes to npm with provenance and creates a GitHub Release.
- **`package.json` `repository.url` MUST exactly match the GitHub repo URL** (`https://github.com/nookied/homebridge-warmup4ie-v2.git`). npm's sigstore provenance is strict — a mismatch causes `npm publish` to fail with HTTP 422.

### What it does

The plugin authenticates against the my.warmup.com cloud via REST `userLogin` (`https://api.warmup.com/apps/app/v1`), then uses the Warmup GraphQL endpoint (`https://apil.warmup.com/graphql`) for all subsequent operations — room enumeration, status polling, and per-room control. Each Warmup "room" becomes one HomeKit Thermostat (+ a paired air-temperature `TemperatureSensor`). Transport is native Node ≥18 `fetch` (no third-party HTTP client).

**Key v3 behaviour:** the `Off` HomeKit action targets a *single* room via the GraphQL `deviceOff(lid, rid)` mutation. v2 (and the upstream original) used a location-wide REST `setModes locMode:"off"` call that turned off all rooms — that's no longer what we do.

## Architecture

```
homebridge-warmup4ie-v2/
├── src/
│   ├── index.js                      Homebridge entry; registerPlatform + dynamic-platform glue
│   │   ├── module.exports(homebridge)        Captures hap.{Service,Characteristic,HapStatusError,HAPStatus,uuid} + platformAccessory
│   │   ├── warmup4iePlatform                 Dynamic platform — registerPlatform(.., true)
│   │   │   ├── configureAccessory(cached)        Stash cached PlatformAccessory in this.accessories Map
│   │   │   ├── discoverDevices()                 Login + fetch rooms → reconcileAccessories
│   │   │   ├── reconcileAccessories(rooms)       Diff live vs cached → register/unregister/update deltas
│   │   │   ├── startPolling()                    setInterval(getStatus + updateAccessoryState per room)
│   │   │   └── shutdown()                        Clear poll timer + pending debouncers (api 'shutdown' event)
│   │   ├── attachAccessoryServices(p, acc, room) Idempotent service setup (Information/Thermostat/TemperatureSensor)
│   │   ├── pushRoomState(acc, room)              Updates HAP characteristics from a room snapshot
│   │   ├── updateAccessoryState(p, room)         Looks up acc by UUID, refreshes context.room + pushRoomState
│   │   ├── handleTargetHeatingCoolingSet         .onSet handler — Off/Heat/Auto switching
│   │   ├── handleTargetTemperatureSet            .onSet handler — debounced (300 ms trailing edge)
│   │   ├── effectiveTargetTemp(room)             Clamps targetTemp to [minTemp, ∞)
│   │   ├── asHapStatusError(err)                 Maps Warmup errors → HAP status codes
│   │   └── uuidForRoom(roomId)                   api.hap.uuid.generate('warmup4ie:' + roomId)
│   │
│   └── lib/
│       ├── warmup4ie.js                      Warmup cloud API client (class Warmup4IE)
│       │   ├── _fetch(url, body, headers)            Generic POST helper, AbortSignal.timeout(10s)
│       │   ├── _rest(body)                            REST POST → status.result success-gate
│       │   ├── _graphql(query, variables)             GraphQL POST → errors[] gate
│       │   ├── _authenticatedGraphQL(q, v)            Re-auth + retry once on token errors
│       │   ├── _isTokenError(err)                     Pattern: HTTP 401, REST code 100/102/103, GraphQL "token"/"auth"
│       │   ├── _login()                               REST `userLogin` → token (only REST endpoint we use)
│       │   ├── _fetchRooms()                          GraphQL `user.owned[].rooms` → normalize → cache
│       │   ├── getStatus()                            Public alias for _fetchRooms
│       │   ├── setRoomAuto(roomId)                    GraphQL deviceProgram(lid, rid)
│       │   ├── setRoomOff(roomId)                     GraphQL deviceOff(lid, rid)  ← per-room hard off
│       │   ├── setTargetTemperature(id, value)        GraphQL deviceOverride(lid, rid, temp×10, minutes)
│       │   └── normalizeRoom(r)                       Flattens GraphQL Room+Thermostat4iE into platform shape
│       │
│       └── state.js                          Pure HeatingCoolingState derivers (no HAP types)
│           ├── deriveCurrentHeatingState(room)
│           └── deriveTargetHeatingState(room)
│
├── test/
│   ├── unit/
│   │   ├── _fetch.test.js                    Generic fetch + _rest + _graphql + _isTokenError
│   │   ├── wire-format.test.js               GraphQL mutation+variables byte-for-byte
│   │   └── state-derivers.test.js            Truth tables for both derivers
│   ├── integration/
│   │   ├── bootstrap.test.js                 REST login → GraphQL owned[] → callback
│   │   ├── poll.test.js                      getStatus refreshes/replaces cache
│   │   ├── error-recovery.test.js            Failed poll + 401 token-refresh sequence
│   │   ├── platform-state.test.js            Missing config, failed bootstrap, multi-instance isolation
│   │   └── homebridge-loadtime.test.js       registerPlatform smoke
│   ├── live/
│   │   └── api.test.js                       Opt-in: WARMUP_LIVE_TEST=1
│   ├── fixtures/
│   │   ├── userLogin.success.json
│   │   ├── userLogin.error.json
│   │   ├── graphql.owned.json                Three rooms, full Thermostat4iE payload
│   │   ├── graphql.owned.empty.json
│   │   ├── graphql.mutation.success.json
│   │   └── graphql.error.json
│   ├── helpers.js                            stubFetch, stubGraphQLClient, sequencedFetch, makeResponse, loadFixture
│   └── hbConfig/                             Sandbox Homebridge config for `npm run watch`
│
├── .github/workflows/
│   ├── ci.yml                                Lint + test + smoke on Node 18/20/22/24, every push + PR
│   └── release.yml                           Tag-driven (v*) npm publish + GitHub Release
│
├── eslint.config.mjs                         ESLint v9 flat config (commonjs, jest, node globals)
├── package.json                              v3.0.0; scripts: lint / test / smoke / watch
├── config.schema.json                        Homebridge UI form-based config editor
├── LICENSE                                   Apache-2.0
├── README.md                                 User docs (install, config, supported models, migration)
├── CHANGELOG.md                              Keep-a-Changelog format
├── ROADMAP.md                                Development plan (M1-M7, status per milestone)
├── QA_TESTS.md                               Manual pre-release checklist
├── CLAUDE.md                                 This file — project memory
└── AGENTS.md                                 Pointer → CLAUDE.md
```

## How it runs

1. Homebridge calls `module.exports(homebridge)` → captures HAP types + `platformAccessory` ctor + `uuid` → `registerPlatform("homebridge-warmup4ie-v2", "warmup4ie", warmup4iePlatform, true)` (4th arg = dynamic).
2. Homebridge instantiates `warmup4iePlatform(log, config, api)`. The constructor reads + clamps config, sets up `this.accessories: Map<UUID, PlatformAccessory>` and `this._debouncers: Map<UUID, Map<char, Timeout>>`, and registers `api.on('didFinishLaunching', () => discoverDevices())` plus `api.on('shutdown', () => shutdown())`.
3. For each accessory in Homebridge's on-disk cache, `configureAccessory(accessory)` is called synchronously — we stash it in `this.accessories` keyed by UUID. Service handlers are NOT bound here (we don't yet know if Warmup still has the room).
4. After all `configureAccessory` calls, `didFinishLaunching` fires → `discoverDevices()` constructs `new Warmup4IE(this, cb)`. The lib's `_bootstrap` runs `_login` (REST userLogin → token) → `_fetchRooms` (GraphQL `user.owned[].rooms` → normalize → fill `this.room[]`). The token is stored on the instance (`this._token`) and rides as the `warmup-authorization` header on every GraphQL request.
5. `reconcileAccessories(rooms)` diffs live rooms vs `this.accessories`:
   - Match by UUID (`api.hap.uuid.generate('warmup4ie:' + roomId)`) → reuse cached accessory; refresh services + handlers via `attachAccessoryServices`; `api.updatePlatformAccessories([acc])`.
   - Live but not cached → `new api.platformAccessory(name, uuid)`; attach services; `api.registerPlatformAccessories(plugin, alias, [acc])`.
   - Cached but not live → `api.unregisterPlatformAccessories(plugin, alias, [acc])` + drop from Map.
6. Polling: single `setInterval` at `refresh` seconds. Each tick: `await thermostats.getStatus()` (GraphQL fetch) → `rooms.forEach(updateAccessoryState)` looks up the accessory by UUID and pushes characteristics + refreshes `accessory.context.room`.
7. On HomeKit writes, `.onSet(async)` closures (bound at attach time) call into the lib (`setRoomAuto` / `setRoomOff` / `setTargetTemperature`). Errors are mapped to HAP status codes via `asHapStatusError` and re-thrown — HomeKit shows "Not Responding" with the appropriate reason. `handleTargetTemperatureSet` is debounced 300 ms trailing-edge to coalesce slider drags.
8. Token expiry (HTTP 401, REST code 100/102/103, GraphQL "token"/"auth"/"unauthorized"/"forbidden" message) triggers one re-auth + retry per request via `_authenticatedGraphQL`.
9. Shutdown: `api.on('shutdown', ...)` calls `platform.shutdown()` which clears the poll interval and any pending debouncer timers (avoids zombie callbacks firing after Homebridge has stopped).

## API client cheat sheet

Two endpoints. REST is used **only** for login; GraphQL handles everything else. Same `app-token` header value (`M=;He<Xtg"$}4N%5k{$:PD+WA"]D<;#PriteY|VTuA>_iyhs+vA"4lic{6-LqNM:` — the static token that the Warmup mobile app uses) is sent on both. After login, the per-user access token rides as `warmup-authorization` on GraphQL requests.

| Operation | Transport | Method | Notes |
|---|---|---|---|
| Login | REST `POST /apps/app/v1` | `userLogin` | `email`/`password`/`appId: "WARMUP-APP-V001"`. Body holds creds; response holds token. |
| Locations + rooms | GraphQL `query OwnedAndRooms` | `user.owned[]` | One round trip; we pick `[0]`. The schema's `user.location(id:)` returns HTTP 409 in practice — `owned[]` is the supported path (matches the real Warmup app). |
| Resume schedule | GraphQL `mutation deviceProgram` | `lid`, `rid` | Per-room |
| Off | GraphQL `mutation deviceOff` | `lid`, `rid` | Per-room hard off (the v3 unlock) |
| Override target temp | GraphQL `mutation deviceOverride` | `lid`, `rid`, `temperature: Int!` (×10), `minutes: Int!` (0–1440) | No HH:MM `until` parsing, no UTC-vs-local concerns |

Temperatures from the GraphQL API are integers in tenths of °C on `Room` (`195` = 19.5 °C); on `Thermostat4iE.airTemp/floor1Temp/floor2Temp` they are **strings** in tenths (`"195"`). `normalizeRoom` flattens both shapes; `index.js` divides by 10 before passing to HomeKit and multiplies by 10 on the way out.

`runMode` enum (per schema): `not_set | off | schedule | override | fixed | anti_frost | holiday | fil_pilote | gradual | relay | previous`. `state.js` handles `off | schedule | fixed | override` explicitly; everything else defaults to HEAT (1) for `TargetHeatingCoolingState`. Edge-case modes (`anti_frost`, `holiday`) are unsurfaced — see Roadmap M6.

## HomeKit mapping

| HomeKit characteristic | Source | Notes |
|---|---|---|
| `Thermostat.CurrentTemperature` | `room.currentTemp/10` | `minValue: -100, maxValue: 100` |
| `Thermostat.TargetTemperature` | `effectiveTargetTemp(room)/10` | Bounds set from `room.minTemp/maxTemp`. Helper clamps to ≥ minTemp because Warmup occasionally returns targets below the device floor. |
| `Thermostat.CurrentHeatingCoolingState` | `deriveCurrentHeatingState(room)` | `off → OFF`, otherwise `currentTemp<targetTemp ? HEAT : OFF`. validValues: `[0, 1]` (no COOL emitted) |
| `Thermostat.TargetHeatingCoolingState` | `deriveTargetHeatingState(room)` | `off → OFF`, `fixed/override → HEAT`, `schedule → AUTO`, default HEAT. validValues: `[0, 1, 3]` |
| `TemperatureSensor.CurrentTemperature` | `room.airTemp/10` (parsed from string) | Separate `<name> Air` service |

### Mode write semantics (`handleTargetHeatingCoolingSet`)

| HomeKit value | Action |
|---|---|
| `0` (Off) | `setRoomOff(roomId)` — GraphQL `deviceOff(lid, rid)`. Per-room since v3.0; was location-wide in v2. |
| `1` (Heat) | If already in `fixed`/`override`, no-op (preserves user override). Otherwise `setRoomAuto` (resume schedule). |
| `3` (Auto) | `setRoomAuto` (resume schedule). |

Manual temperature changes go through `setTargetTemperature` → GraphQL `deviceOverride` with `temperature: value*10` (Int) and `minutes: this._duration` (Int). The slider is debounced at 300 ms (`SLIDER_DEBOUNCE_MS` in `index.js`) — slider drag produces one HTTP call after you stop, not N during the drag.

## Configuration

```jsonc
{
  "platforms": [{
    "platform": "warmup4ie",            // identifier — never change for migration compat
    "name": "WarmUP",
    "username": "you@example.com",      // my.warmup.com / MyHeating email
    "password": "...",                  // my.warmup.com / MyHeating password
    "refresh": 60,                      // optional; polling interval, seconds (default 60, min 30, max 600)
    "duration": 60                      // optional; override duration, minutes (default 60, min 5, max 1440)
  }]
}
```

`config.schema.json` provides a form-based editor in the Homebridge UI. Sandbox copy at `test/hbConfig/config.json` (creds blanked).

Multi-location accounts: only the **first** location is exposed (`user.owned[0]`). This is by design — see "Known issues → By design".

## Development workflow

```bash
npm install                  # install deps (only runtime dep is `debug`)
npm run lint                 # ESLint v9 flat config; --max-warnings=0
npm run lint:fix             # ESLint with --fix
npm test                     # Jest, all offline + integration tests
npm run smoke                # `node -e "require('./src/index.js')"` — ensures it loads
npm run watch                # nodemon: spawns local Homebridge against test/hbConfig
WARMUP_LIVE_TEST=1 \
  WARMUP_USERNAME=you@example.com \
  WARMUP_PASSWORD=… \
    npm test                 # Adds 2 live API tests against real account
```

`npm run watch` runs:
```
DEBUG=HAP-NodeJS*,warmup4ie* ~/npm/bin/homebridge -U ./test/hbConfig -I -Q -T -D -P .
```

It expects a global `homebridge` install at `~/npm/bin/homebridge`. Edit `test/hbConfig/config.json` with real credentials before running (and don't commit them — `test/hbConfig/config.json` is in `.gitignore`; the check-in copy at HEAD has placeholder values).

## Release / install

### Install (users)

```bash
# from npm (recommended)
sudo npm install -g homebridge-warmup4ie-v2
sudo systemctl restart homebridge

# or straight from git (pin to a specific SHA)
sudo npm install -g github:nookied/homebridge-warmup4ie-v2#<sha>
```

Or via Homebridge UI: Plugins tab → search for `homebridge-warmup4ie-v2` → Install.

### Release (maintainer)

1. Run `npm run lint && npm test` (offline + integration must be green).
2. Run live tests: `WARMUP_LIVE_TEST=1 WARMUP_USERNAME=… WARMUP_PASSWORD=… npm test`.
3. Walk through the manual checklist in `QA_TESTS.md` on a real Homebridge host.
4. Update `CHANGELOG.md` with the new version's entry (date, sections).
5. `npm version patch|minor|major` — bumps `package.json` and creates a `vX.Y.Z` git tag.
6. `git push --follow-tags` — pushes the commit + tag.
7. CI's `release.yml` (triggered by the tag) lints, tests, smokes, then `npm publish --provenance` using `NPM_TOKEN`, then creates a GitHub Release.

### CI / secrets

- `.github/workflows/ci.yml` — lint + test + smoke on Node 18.20 / 20.15 / 22 / 24, every push and PR.
- `.github/workflows/release.yml` — tag-driven (`v*`) publish + Release. Verifies tag matches `package.json` version before publishing.
- Required GitHub secret: `NPM_TOKEN` (npm Granular Access Token with **Bypass two-factor authentication enabled** + read+write on `homebridge-warmup4ie-v2`). Classic Automation Tokens were phased out by npm for new accounts. If you regenerate the token, paste it directly into the GitHub secret UI — never anywhere else.

## Versioning

This fork starts at **2.0.0** as a tribute to the original v1.x lineage. From there it follows [SemVer](https://semver.org/):

| Bump | When | Examples |
|------|------|---|
| **MAJOR** (`X.0.0`) | Breaking change to config keys, HomeKit accessory shape, or user-visible behaviour | v3.0: per-room Off (was location-wide) |
| **MINOR** (`X.Y.0`) | New feature (multi-location, new HomeKit service, etc.) | v2.1: config.schema.json, HAP error categorization |
| **PATCH** (`X.Y.Z`) | Bug fix, dependency bump, doc-only change | (none yet on this fork) |

## Known issues / tech debt

### Open
1. **`runMode` edge cases unhandled** — `state.js` falls through to `HEAT` for `anti_frost`, `holiday`, `gradual`, `fil_pilote`, `relay`, `previous`. Roadmap **M6** has more accurate mappings; not blocking today.
2. **Per-thermostat `Model` is generic** — the GraphQL `Thermostat4iE` type carries `deviceSN` today, but the plugin does not yet fetch/use enough reliable per-model metadata for all supported devices. Set as `"Wi-Fi Thermostat"` for now. Roadmap **M6**.
3. **`outputStatus` for accurate "is heating now"** — schema has `Thermostat4iE.parameters.outputStatus` (relay state), which is more accurate than the current `currentTemp < targetTemp` heuristic. Not in the GraphQL query today (was removed during the v3 live-test 409 debugging). Roadmap **M6**.
4. **No `Eve.Energy.TotalConsumption` characteristic.** `room.energy` (kWh) and `room.cost` are surfaced in the normalized room shape but not exposed to Eve yet. Adding them needs Eve characteristic UUIDs (or `homebridge-lib`'s `EveHomeKitTypes`). Roadmap **M6**. Temperature/heating history graphs (the headline "Eve graphs" deliverable) shipped in v3.2.0.

### Resolved
- **v2.0:** restored `setRoomOff` body (regression in upstream 0.1.0); restored local-time `until` (regression in 0.1.0); native fetch (deprecated `request` removed); full test suite; CI; LICENSE; rebrand as `homebridge-warmup4ie-v2`.
- **v2.1:** `config.schema.json`; token refresh on 401; HAP error categorization; debounced TargetTemperature; `.onSet(async)` modern handlers; instance state (was module-level); model-coverage doc fix.
- **v3.0:** GraphQL transport (REST kept only for `userLogin`); per-room Off via `deviceOff(lid, rid)`; `deviceOverride` with explicit minutes (UTC-vs-local class of bugs eliminated forever); foundation for M5/M6 features.
- **v3.0.1:** platform-instance state isolation; failed bootstrap doesn't poll; write methods preserve cache on errors; `_fetchRooms` replaces cache (removed rooms don't linger); `Math.round(value * 10)` for tenths; login token validation; `connection: close` (kills TLSWRAP warning in tests).
- **v3.1:** dynamic platform (`registerPlatform(.., true)`, `configureAccessory`, `discoverDevices`, `reconcileAccessories`); cached-accessory restoration survives Warmup-cloud outages at boot; stable per-room UUIDs; `Warmup4ieAccessory` class replaced by free functions on `PlatformAccessory`. **All Verified-Plugin requirements now met** — application queued as Roadmap M7.
- **v3.2:** `fakegato-history@^0.6.7` re-introduced for Eve.app temperature/heating-state history graphs. Per-thermostat `'thermo'` history service; per-poll entry of `{currentTemp, setTemp, valvePosition}`; `valvePosition` synthesized from heating state. Energy characteristics deferred to M6.

### By design (won't fix)
- **First location only.** `_fetchRooms` takes `user.owned[0]`. If you have multiple Warmup locations on one account (e.g. primary residence + holiday home), only the first one is exposed. To expose a second location, run a second Homebridge child bridge with another account. A `location: "name"` config option to filter by name is feasible and would mirror the Python reference, but isn't planned.
- **`accept-language: de-de`** in REQUEST_HEADERS is a quirk of the original reverse-engineering. The real Warmup app sends `en-gb` (per `jondarrer/warmup-api/http-requests.http`). Both work — leave for now.

## Working rules (for this repo)

1. **Don't change the wire protocol without testing live.** The Warmup API is unofficial; GraphQL gateway 409s on certain query shapes (`user.location(id:)`) even when the schema says they're valid. Run `WARMUP_LIVE_TEST=1 npm test` before tagging a release.
2. **Prefer minimum-diff fixes.** Most of the open tech debt has been there for years — don't refactor end-to-end while fixing a one-line bug.
3. **Touch the README and this file together** when adding/changing config keys or behaviour.
4. **Walk `QA_TESTS.md` before tagging a release.** Offline tests + live tests catch code-side regressions; the manual checklist catches wire-format drift on the *Warmup* side and HomeKit-integration issues mocks can't see.
5. **Never re-add an `upstream` remote pointing at NorthernMan54.** This fork is intentionally isolated.
6. **Tag matches `package.json` version.** The release workflow asserts this; `npm version` does it for you.
7. **`package.json` `repository.url` must match the GitHub repo URL exactly.** Sigstore provenance is strict; a mismatch breaks `npm publish` with HTTP 422 (we hit this once during the GitHub repo rename — see CHANGELOG).

## Quick reference

| Want to… | Look at |
|----------|---------|
| Add a new config option | `src/index.js` `warmup4iePlatform()` constructor + `config.schema.json` + README + this file |
| Tweak HomeKit characteristic mapping | `src/index.js` `Warmup4ieAccessory.getServices()` + `updateStatus()` |
| Change the GraphQL transport / wire format | `src/lib/warmup4ie.js` (queries are constants near the top) |
| Run locally with debug | `DEBUG=warmup4ie* npm run watch` |
| See what's been released | `CHANGELOG.md` |
| See what's planned | `ROADMAP.md` |
| Cut a release | `npm version patch \|\| minor \|\| major && git push --follow-tags` |
| Pre-release manual QA | `QA_TESTS.md` |
| Run live API tests | `WARMUP_LIVE_TEST=1 WARMUP_USERNAME=… WARMUP_PASSWORD=… npm test` |
| Update the Homebridge host | `sudo npm install -g homebridge-warmup4ie-v2 && sudo systemctl restart homebridge` |
| Reference the GraphQL schema | [`jondarrer/warmup-api/warmup-schema.graphql`](https://github.com/jondarrer/warmup-api/blob/main/warmup-schema.graphql) (introspected, ~3000 lines) |
| Reference real-world request shapes | [`jondarrer/warmup-api/http-requests.http`](https://github.com/jondarrer/warmup-api/blob/main/http-requests.http) |
| Cross-check Python implementation | [`alex-0103/warmup4IE`](https://github.com/alex-0103/warmup4IE) (REST baseline) |
| Cross-check Java implementation | [`openhab/openhab-addons` warmup binding](https://github.com/openhab/openhab-addons/tree/main/bundles/org.openhab.binding.warmup) |
| Cross-check HA integration | [`ha-warmup/warmup`](https://github.com/ha-warmup/warmup) (GraphQL, multi-location) |

## File reference

| File | Purpose |
|------|---------|
| `src/index.js` | Homebridge platform + accessory class |
| `src/lib/warmup4ie.js` | Warmup cloud API client (REST login, GraphQL everything else) |
| `src/lib/state.js` | Pure HeatingCoolingState derivers (testable in isolation) |
| `test/unit/_fetch.test.js` | Generic fetch + REST + GraphQL transport + token-error pattern |
| `test/unit/wire-format.test.js` | GraphQL mutation + variables shape assertions |
| `test/unit/state-derivers.test.js` | Truth tables for the two heating-state derivers |
| `test/integration/bootstrap.test.js` | REST login → GraphQL owned[] → callback (full happy + error paths) |
| `test/integration/poll.test.js` | getStatus refreshes cache; multiple polls don't duplicate |
| `test/integration/error-recovery.test.js` | Failed poll cache preservation + 401 token-refresh sequence |
| `test/integration/homebridge-loadtime.test.js` | `registerPlatform` smoke with a fake homebridge shim |
| `test/live/api.test.js` | Opt-in live API tests (gated by `WARMUP_LIVE_TEST=1`) |
| `test/fixtures/*.json` | Sanitized API response samples (REST login + GraphQL owned/error/mutation) |
| `test/helpers.js` | Shared test utilities (fetch stubbing, response builder, fixture loader) |
| `test/hbConfig/config.json` | Sandbox Homebridge config for `npm run watch` |
| `.github/workflows/ci.yml` | Lint + test + smoke on Node 18/20/22/24, every push + PR |
| `.github/workflows/release.yml` | Tag-driven npm publish + GitHub Release |
| `eslint.config.mjs` | ESLint v9 flat config |
| `package.json` | Package metadata, scripts, deps |
| `config.schema.json` | Homebridge UI form-based config editor |
| `LICENSE` | Apache-2.0 |
| `README.md` | User-facing docs (install, config, supported models, migration) |
| `QA_TESTS.md` | Manual pre-release checklist |
| `CHANGELOG.md` | Release history (Keep a Changelog) |
| `ROADMAP.md` | Development plan (M1–M7, with shipped/open status per milestone) |
| `AGENTS.md` | Pointer to this file |
| `CLAUDE.md` | This file — project memory for Claude Code |
