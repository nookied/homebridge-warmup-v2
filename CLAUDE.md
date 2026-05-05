# CLAUDE.md — homebridge-warmup4ie

This file is the canonical persistent memory for this project. Any assistant/agent should update this file only; `AGENTS.md` is intentionally just a pointer here to avoid maintaining duplicate project memory.

---

## Project Overview

**npm name:** `homebridge-warmup4ie-v2`
**Type:** Homebridge plugin (Node.js, CommonJS)
**Purpose:** Expose Warmup 4iE underfloor-heating thermostats as HomeKit Thermostat accessories
**Repo:** `https://github.com/nookied/homebridge-warmup4ie` — **maintained fork**, published to npm under a distinct name
**Original (abandoned reference):** [NorthernMan54/homebridge-warmup4ie](https://github.com/NorthernMan54/homebridge-warmup4ie) — broke at 0.1.0 in Dec 2024 and never fixed; do not pull from or push to it
**License:** Apache-2.0 (preserved from original; LICENSE file added in 2.0.0)
**Current version:** 2.0.0 (first release of the fork; tribute to the original v1 lineage)
**Engines:** Homebridge `^1.6.0 || ^2.0.0-beta.0`, Node `^18.20.4 || ^20.15.1 || ^22.0.0`

### Fork rules

- This is a **maintained fork published to npm under a distinct name** (`homebridge-warmup4ie-v2`). The original (`homebridge-warmup4ie`) is unaffected.
- The HomeKit *platform identifier* in users' `config.json` stays `"platform": "warmup4ie"` for migration compatibility — only the npm package name differs.
- The `upstream` git remote is **intentionally not configured**. Do not re-add it. Do not open PRs against `NorthernMan54/homebridge-warmup4ie`.
- CI runs lint + tests + smoke on Node 18/20/22 for every push (`.github/workflows/ci.yml`). Releases are tag-driven: `npm version patch|minor|major && git push --follow-tags` triggers `release.yml`, which publishes to npm with provenance and creates a GitHub Release.

The plugin authenticates against the my.warmup.com cloud (`https://api.warmup.com/apps/app/v1`), enumerates rooms in the first location on the account, and creates one HomeKit Thermostat (+ a paired air-temperature `TemperatureSensor`) per room. Transport is native Node ≥18 `fetch` (no third-party HTTP client).

## Architecture

```
homebridge-warmup4ie/
├── src/
│   ├── index.js              — Homebridge entry point; registerPlatform + accessory glue
│   │   ├── warmup4iePlatform        Static platform (legacy `accessories(callback)` pattern)
│   │   ├── updateStatus(room)        Pushes Current/TargetTemperature + heating state
│   │   ├── deriveCurrent/TargetHeatingState   Pure helpers, shared by build + poll
│   │   └── Warmup4ieAccessory        Per-room HomeKit accessory:
│   │                                   - Service.Thermostat (primary)
│   │                                   - Service.TemperatureSensor (`<name> Air`)
│   │                                   - Service.AccessoryInformation
│   │
│   └── lib/
│       ├── warmup4ie.js              API client (class Warmup4IE, native fetch)
│       │   ├── _generateAccessToken  POST userLogin → token
│       │   ├── _getLocations         POST getLocations → first location id
│       │   ├── _fetchRooms           POST getRooms → fills this.room[roomId]
│       │   ├── getStatus             Public callback wrapper around _fetchRooms
│       │   ├── setTargetTemperature  POST setOverride (type 3, until = now + duration, local HH:MM)
│       │   ├── setRoomAuto           POST setProgramme roomMode=prog
│       │   └── setRoomOff            POST setModes locMode=off (location-wide; matches Warmup mobile app)
│       │
│       └── warmup4ie.test.js         Offline regression tests + skipped live-API tests
│
├── test/hbConfig/                   Sandbox Homebridge config used by `npm run watch`
│   ├── config.json                  Mock platform config (creds redacted to XXX...)
│   └── auth.json                    homebridge-config-ui-x default auth
│
├── eslint.config.mjs                ESLint v9 flat config (commonjs, jest plugin)
├── package.json                     v0.1.2, scripts: lint / test / watch
├── CHANGELOG.md                     Release history (Keep a Changelog)
├── CLAUDE.md                        This file
├── AGENTS.md                        Pointer → CLAUDE.md
└── README.md                        Upstream usage README
```

## How it runs

1. Homebridge calls `module.exports(homebridge)` → `registerPlatform("homebridge-warmup4ie", "warmup4ie", warmup4iePlatform)`.
2. `warmup4iePlatform.accessories(callback)` constructs `new Warmup4IE(this, cb)`. The constructor's `_bootstrap` runs `_generateAccessToken → _getLocations → _fetchRooms` (chained `await`s), then resolves the callback with the room list.
3. For each room returned, a `Warmup4ieAccessory` is pushed to `myAccessories` and surfaced to Homebridge.
4. The platform schedules a single `setInterval` at `refresh` seconds. Each tick calls `thermostats.getStatus(...)` (which fetches fresh rooms from the API) and then `updateStatus(room)` for every room — pushing Current/Target temperatures and heating state to HomeKit, and refreshing the per-accessory `room` snapshot.
5. On HomeKit writes, `setTargetTemperature` / `setTargetHeatingCooling` invalidate `room[roomId]` and POST to the API. Errors (network or `{status:{result:"error"}}`) are surfaced to HomeKit, which then shows "Not Responding".

## API client cheat sheet

All requests are `POST https://api.warmup.com/apps/app/v1` with a single JSON body. The static `app-token` header (`M=;He<Xtg"$}4N%5k{$:PD+WA"]D<;#PriteY|VTuA>_iyhs+vA"4lic{6-LqNM:`) is hard-coded in `src/lib/warmup4ie.js` — same value the official Warmup app sends. After login the access token + first-location id are kept in module-scoped variables (`WarmupAccessToken`, `LocId`).

| Operation | Method field | Notes |
|---|---|---|
| Login | `userLogin` | `email`/`password`/`appId: "WARMUP-APP-V001"` |
| Locations | `getLocations` | First entry wins; multi-location accounts not supported |
| Rooms | `getRooms` | `locId` required; populates `this.room[roomId]` (sparse array) |
| Override temp | `setOverride` | `type: 3`, `temp: value*10`, `until: HH:MM` (UTC, now+duration) |
| Set mode | `setProgramme` | `roomMode: "prog" \| "override" \| "fixed"` |
| Off (whole loc) | `setModes` | `locMode: "off"` — turns off the entire location, not just the room |

Temperatures from the API are integers in tenths of °C (`195` = 19.5 °C). `index.js` divides by 10 before passing to HomeKit and multiplies by 10 on the way out.

## HomeKit mapping

| HomeKit characteristic | Source | Notes |
|---|---|---|
| `Thermostat.CurrentTemperature` | `room.currentTemp/10` | `minValue: -100, maxValue: 100` |
| `Thermostat.TargetTemperature` | `max(room.targetTemp, room.minTemp)/10` | Bounds set from `room.minTemp/maxTemp` |
| `Thermostat.CurrentHeatingCoolingState` | derived from `runMode` + temp delta | `off → OFF`, otherwise `currentTemp<targetTemp ? HEAT : OFF` |
| `Thermostat.TargetHeatingCoolingState` | derived from `runMode` | `off → OFF`, `fixed/override → HEAT`, `schedule → AUTO` |
| `TemperatureSensor.CurrentTemperature` | `room.airTemp/10` | Separate "<name> Air" service |

Allowed target states are restricted to `[OFF, HEAT, AUTO]` (no COOL).

### Mode write semantics (`setTargetHeatingCooling`)

| HomeKit value | Action |
|---|---|
| `0` (Off) | `setRoomOff` — `setModes locMode=off`, which is **location-wide** by API design. The Warmup mobile app does the same call. There is no per-room hard-off in the API. |
| `1` (Heat) | If already in `fixed`/`override`, no-op. Otherwise `setRoomAuto` (resumes program). README phrases this as "Heat = turns on the thermostat and resumes current program". |
| `3` (Auto) | `setRoomAuto` (resume program) |

Manual temperature changes go through `setTargetTemperature` → `setOverride` with `type: 3` and an `until` time of now + `duration` minutes. README phrases this as "all temperature changes are treated as an override".

## Configuration

```jsonc
{
  "platforms": [{
    "platform": "warmup4ie",
    "name": "WarmUP",
    "username": "you@example.com",   // my.warmup.com email
    "password": "...",                // my.warmup.com password
    "refresh": 60,                    // optional; polling interval, seconds (default 60)
    "duration": 60                    // optional; override duration, minutes (default 60)
  }]
}
```

Sandbox copy lives at `test/hbConfig/config.json` (creds blanked out).

Multi-location accounts: only the **first** location is exposed (`locations[0].id`). This is by design — see "Known issues → By design".

## Development workflow

```bash
npm install                  # install deps
npm run lint                 # ESLint v9 flat config; --max-warnings=0
npm run lint:fix             # ESLint with --fix
npm test                     # Jest, --detectOpenHandles
npm run watch                # nodemon: spawns local Homebridge against test/hbConfig with DEBUG=warmup4ie*
```

`npm run watch` runs:
```
DEBUG=HAP-NodeJS*,warmup4ie* ~/npm/bin/homebridge -U ./test/hbConfig -I -Q -T -D -P .
```

It expects a global `homebridge` install at `~/npm/bin/homebridge`. Edit `test/hbConfig/config.json` with real credentials before running (and don't commit them — `test/hbConfig/config.json` is in `.gitignore`, but the check-in copy at HEAD has placeholder values).

## Release / install

### Install (users)

```bash
# from npm (recommended)
sudo npm install -g homebridge-warmup4ie-v2
sudo systemctl restart homebridge

# or straight from git (pin to a specific SHA)
sudo npm install -g github:nookied/homebridge-warmup4ie#<sha>
```

### Release (maintainer)

1. Run `npm run lint && npm test` (offline + integration must be green).
2. Run live tests: `WARMUP_LIVE_TEST=1 WARMUP_USERNAME=… WARMUP_PASSWORD=… npm test`.
3. Walk through the manual checklist in `QA_TESTS.md` on a real Homebridge host.
4. Update `CHANGELOG.md` with the new version's entry (date, sections).
5. `npm version patch|minor|major` — bumps `package.json` and creates a `vX.Y.Z` git tag.
6. `git push --follow-tags` — pushes the commit + tag.
7. CI's `release.yml` (triggered by the tag) lints, tests, smokes, then `npm publish --provenance` using `NPM_TOKEN`, then creates a GitHub Release.

### CI / secrets

- `.github/workflows/ci.yml` — lint + test + smoke on Node 18.20 / 20.15 / 22, every push and PR.
- `.github/workflows/release.yml` — tag-driven (`v*`) publish + Release.
- Required GitHub secret: `NPM_TOKEN` (npm automation token tied to the maintainer's npm account, with publish access to `homebridge-warmup4ie-v2`).

## Versioning

This fork starts at **2.0.0** as a tribute to the original v1.x lineage. From there it follows [SemVer](https://semver.org/):

| Bump | When |
|------|------|
| **MAJOR** (`X.0.0`) | Breaking change to config keys or HomeKit accessory shape |
| **MINOR** (`X.Y.0`) | New feature (multi-location, new HomeKit service, etc.) |
| **PATCH** (`X.Y.Z`) | Bug fix, dependency bump, doc-only change |

## Known issues / tech debt

### Open
1. **Static platform pattern** — uses 3-arg `registerPlatform(...)` (no `dynamic = true`), so accessories are returned via the `accessories(callback)` legacy flow. Cached accessories aren't supported; restarts re-create everything. HB v2 still supports this fully — not a bug, just a pattern choice. Migrating to `api.registerPlatformAccessories` would let Homebridge persist accessories across restarts.
2. **Tests are minimal** — three offline regression tests (`until` format, `setRoomOff` body, `setRoomAuto` shape) plus a `describe.skip` block of live-API tests. Adding broader coverage would either need a fetch-level mock harness or a dedicated test account.

### Resolved in 0.1.2
- **Off button stopped working in 0.1.0–0.1.1** — `setRoomOff` lost its filler `values` keys in the 0.1.0 rewrite (PR #7). API silently rejected the simplified body. Restored byte-for-byte from the Python reference.
- **`setTargetTemperature` UTC vs local time** — also broken in the same rewrite. Restored to local time.
- **API-level errors were swallowed** — `_sendRequest` now fails the callback when the response is `{status:{result:"error"}}`.
- **Deprecated `request` dependency** — replaced with native `fetch` (Node ≥18). Drops a 12-year-old unmaintained transport with unfixed CVEs.
- **Duplicate polling loops** — consolidated to one platform-owned interval that fetches + pushes per tick.
- **Unused declared dependencies** — `fakegato-history`, `homebridge-lib`, `moment`, `semver` removed.
- **`storage` config option** — undocumented and unwired; removed from README and code.
- **Hostname-based `SerialNumber`** — replaced with `warmup4ie-<roomId>` (stable across host moves).
- **Stale per-accessory `runMode` cache** — `updateStatus()` now refreshes `accessory.room` per poll.
- **Test file absolute paths** — switched to relative `require('./warmup4ie')`.

### By design (won't fix)
- **`setRoomOff` is location-wide, not per-room.** The Warmup mobile app does the same call when you tap "Off" on a single thermostat — the cloud API has no per-room hard-off operation (confirmed against the Python reference impl). This is exactly how 0.0.14 behaved when control was working, and how 0.1.2 behaves again. With multiple rooms on one account, tapping Off on any one room takes the whole location off; that's the API contract, not a plugin bug.
- **First location only.** `_getLocations` takes `locations[0].id`. If you have multiple Warmup locations on one account (e.g. primary residence + holiday home), only the first one is exposed. To expose a second location, run a second Homebridge child bridge with another account, or fork and add a `location` config option to filter by name (the Python reference does this).

## Working rules (for this repo)

1. **Don't change the wire protocol without testing live.** The Warmup API is unofficial and returns errors as 200s with embedded error fields; offline mocks can't catch real-server drift. Run `WARMUP_LIVE_TEST=1 npm test` before tagging a release.
2. **Prefer minimum-diff fixes.** Most of the open tech debt has been there for years — don't refactor end-to-end while fixing a one-line bug.
3. **Touch the README and this file together** when adding/changing config keys.
4. **Walk `QA_TESTS.md` before tagging a release.** Offline tests + live tests catch code-side regressions; the manual checklist catches wire-format drift on the *Warmup* side and HomeKit-integration issues mocks can't see.
5. **Never re-add an `upstream` remote pointing at NorthernMan54.** This fork is intentionally isolated.
6. **Tag matches `package.json` version.** The release workflow asserts this; `npm version` does it for you.

## Quick reference

| Want to… | Look at |
|----------|---------|
| Add a new config option | `src/index.js` `warmup4iePlatform()` constructor + README + this file |
| Tweak HomeKit characteristic mapping | `src/index.js` `Warmup4ieAccessory.getServices()` + `updateStatus()` |
| Change wire-level API behaviour | `src/lib/warmup4ie.js` |
| Run locally with debug | `DEBUG=warmup4ie* npm run watch` |
| See what's been released | `CHANGELOG.md` |
| Cut a release | `npm version patch \|\| minor \|\| major && git push --follow-tags` |
| Pre-release manual QA | `QA_TESTS.md` |
| Run live API tests | `WARMUP_LIVE_TEST=1 WARMUP_USERNAME=… WARMUP_PASSWORD=… npm test` |
| Update the Homebridge host | `sudo npm install -g homebridge-warmup4ie-v2 && sudo systemctl restart homebridge` |

## File reference

| File | Purpose |
|------|---------|
| `src/index.js` | Homebridge platform + accessory |
| `src/lib/warmup4ie.js` | Warmup cloud API client (native fetch) |
| `src/lib/state.js` | Pure HeatingCoolingState derivers (testable in isolation) |
| `test/unit/*.test.js` | Wire-format builders, state derivers, until-format, _fetch error paths |
| `test/integration/*.test.js` | Bootstrap chain, polling, error recovery, plugin loadtime |
| `test/live/api.test.js` | Opt-in live API tests (gated by `WARMUP_LIVE_TEST=1`) |
| `test/fixtures/*.json` | Sanitized API response samples |
| `test/helpers.js` | Shared test utilities (fetch stub, response builder, fixture loader) |
| `test/hbConfig/config.json` | Sandbox Homebridge config for `npm run watch` |
| `.github/workflows/ci.yml` | Lint + test + smoke on Node 18/20/22, every push + PR |
| `.github/workflows/release.yml` | Tag-driven npm publish + GitHub Release |
| `eslint.config.mjs` | ESLint v9 flat config |
| `package.json` | Package metadata, scripts, deps |
| `LICENSE` | Apache-2.0 (added in 2.0.0) |
| `README.md` | User-facing docs (install, config, migration) |
| `QA_TESTS.md` | Manual pre-release checklist |
| `CHANGELOG.md` | Release history (Keep a Changelog) |
| `AGENTS.md` | Pointer to this file |
| `CLAUDE.md` | This file — project memory for Claude Code |
