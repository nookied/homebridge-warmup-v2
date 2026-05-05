# CLAUDE.md — homebridge-warmup4ie

This file is the canonical persistent memory for this project. Any assistant/agent should update this file only; `AGENTS.md` is intentionally just a pointer here to avoid maintaining duplicate project memory.

---

## Project Overview

**Name:** homebridge-warmup4ie
**Type:** Homebridge plugin (Node.js, CommonJS)
**Purpose:** Expose Warmup 4iE underfloor-heating thermostats as HomeKit Thermostat accessories
**Upstream author:** NorthernMan54 (`https://github.com/NorthernMan54/homebridge-warmup4ie`)
**This fork:** `https://github.com/nookied/homebridge-warmup4ie` (origin), `NorthernMan54/...` (upstream)
**License:** Apache-2.0
**Current version:** 0.1.2 (npm `homebridge-warmup4ie`)
**Engines:** Homebridge `^1.6.0 || ^2.0.0-beta.0`, Node `^18.20.4 || ^20.15.1 || ^22.0.0`

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
├── .github/workflows/Build and Publish.yml
│                                    NPM publish on push to `beta-*.*.*`/`beta` (beta tag),
│                                    or manual workflow_dispatch from `main` (latest tag)
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

## CI / Release

`.github/workflows/Build and Publish.yml` runs on:
- `push` to branches matching `beta-*.*.*` or `beta` → publishes to npm with the branch-prefix tag (e.g. `beta`) and dynamically bumps the version (`pre` + `pre_id`)
- `workflow_dispatch` from `main` → publishes a production release using `homebridge/.github/.github/workflows/npm-publish.yml@latest`, then `softprops/action-gh-release@v1` creates the GitHub Release

Steps before publish:
1. `get_tags` — derive branch + npm dist-tag
2. `create_documentation` — runs `npm run-script document --if-present` (no `document` script today, so this is a no-op) and commits any TOC change as `github-actions[bot]`

Required GitHub secrets: `NPM_TOKEN`.

## Versioning

Pre-1.0 (current): `0.MINOR.PATCH`. The most recent prod release was 0.1.1 / "HB 2.0" (Dec 2024). Beta channel uses `homebridge/.github` reusable workflow with `dynamically_adjust_version: true` to suffix `-beta.N`.

| Bump | When |
|------|------|
| **0.X.0** (minor) | New API support, new HomeKit service, breaking change to config |
| **0.X.Y** (patch) | Bug fix, dependency bump, doc-only change |
| **1.0.0** | Reserved for the first release that addresses the "Known issues" below — duplicate polling, deprecated `request`, broken tests |

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

1. **Don't change the wire protocol without testing live.** The Warmup API is unofficial and returns errors as 200s with embedded error fields; mocked tests can't catch breaking changes.
2. **Prefer minimum-diff fixes.** Most of the open tech debt has been there for years — don't refactor end-to-end while fixing a one-line bug.
3. **Touch the README and this file together** when adding/changing config keys.
4. **Use the beta release channel** for anything that touches HomeKit characteristics or polling cadence — easier to revert via npm dist-tag than via Homebridge install paths.

## Quick reference

| Want to… | Look at |
|----------|---------|
| Add a new config option | `src/index.js` `warmup4iePlatform()` constructor + README + this file |
| Tweak HomeKit characteristic mapping | `src/index.js` `Warmup4ieAccessory.getServices()` + `updateStatus()` |
| Change wire-level API behaviour | `src/lib/warmup4ie.js` |
| Run locally with debug | `DEBUG=warmup4ie* npm run watch` |
| See what's been released | `CHANGELOG.md` |
| Trigger a beta release | Push to a branch named `beta` or `beta-X.Y.Z` |
| Trigger a prod release | `gh workflow run "Build, Publish and Release"` from `main` |

## File reference

| File | Purpose | Lines |
|------|---------|-------|
| `src/index.js` | Homebridge platform + accessory | 219 |
| `src/lib/warmup4ie.js` | Warmup cloud API client (native fetch) | 200 |
| `src/lib/warmup4ie.test.js` | Jest tests (3 offline + 2 skipped live) | 115 |
| `test/hbConfig/config.json` | Sandbox Homebridge config for `npm run watch` | — |
| `.github/workflows/Build and Publish.yml` | npm publish + GitHub release | — |
| `eslint.config.mjs` | ESLint v9 flat config | — |
| `package.json` | Package metadata, scripts, deps | — |
| `README.md` | Upstream usage README | — |
| `CHANGELOG.md` | Release history | — |
| `AGENTS.md` | Pointer to this file | — |
| `CLAUDE.md` | This file — project memory for Claude Code | — |
