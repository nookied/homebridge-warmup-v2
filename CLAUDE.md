# CLAUDE.md — homebridge-warmup4ie-v2

This file is the canonical persistent memory for this project. Any assistant/agent should update this file only; `AGENTS.md` is intentionally just a pointer here to avoid maintaining duplicate project memory.

---

## Project Overview

**npm name:** `homebridge-warmup4ie-v2`
**Type:** Homebridge plugin (Node.js, CommonJS)
**Purpose:** Expose Warmup Wi-Fi underfloor-heating thermostats as HomeKit Thermostat accessories. Supports the entire smart-thermostat range that pairs with my.warmup.com / the MyHeating app: 4iE (legacy), 6iE, 7iE Smart Matter, Element Wi-Fi, Terra Wi-Fi, and rebadged OEM units (Laticrete, Rointe, Porcelanosa, Equus, Savant). The "4ie" in the package name is historical — when the plugin was authored in 2019, the 4iE was Warmup's only smart thermostat.
**Repo:** [`https://github.com/nookied/homebridge-warmup-v2`](https://github.com/nookied/homebridge-warmup-v2) — **maintained fork**, published to npm under a distinct name (the GitHub repo was renamed from `homebridge-warmup4ie-v2` → `homebridge-warmup-v2` in v3.10.2; the npm package name is unchanged)
**Original (abandoned reference):** [NorthernMan54/homebridge-warmup4ie](https://github.com/NorthernMan54/homebridge-warmup4ie) — broke at 0.1.0 in Dec 2024 and never fixed; do not pull from or push to it
**License:** Apache-2.0 (preserved from original; LICENSE file added in 2.0.0)
**Status:** **Homebridge Verified** since 2026-08-30 ([homebridge/plugins#1195](https://github.com/homebridge/plugins/issues/1195)) — listed in that repo's `verified-plugins.json`, badge in the README. The 11 requirements in ROADMAP's gap-analysis table are now the standard this plugin is held to, not a checklist it once passed: dropping `config.schema.json`, adding analytics, or writing outside `api.user.storagePath()` would be a regression against the badge, not a preference.
**Current version:** **3.13.0** (ROADMAP M8 — the secondary temperature tile now shows the reading the Thermostat is *not* showing, named from the device's own `secondaryLabel`, so an air-mode device with a floor probe gets a "<room> Floor" tile. Backwards-compatible: with one probe `secondaryTemp` is null, the value falls back to `airTemp` and the label stays "Air". The `900` no-probe sentinel is filtered from probe fields but deliberately not from `currentTemp`, where 90 °C would be alarming but legitimate. `logSensorModes()` states each Thermostat's sensor mode at startup. Live-tested; 158 tests. Published 2026-08-28.) Major v3 milestones: 3.0 GraphQL + per-room Off, 3.1 dynamic platform / Verified-eligible, 3.2 fakegato history, 3.3 sensor faults + runMode polish, 3.4 real heating signal + offline detection + override countdown, 3.5 Eve energy graphs + device firmware, 3.6 Vacation/Frost switches, 3.7 child lock, 3.8 validation polish, 3.9 review-pass correctness fixes, 3.9.1 HAP version hotfix, 3.10 feature toggles, 3.10.1 service-order tweak (failed to publish), 3.10.2 GitHub-URL fix + service-order tweak (turned out to be a no-op visually), 3.10.3 link air sensor under thermostat (broke accessory rename), 3.10.4 unlink rollback, 3.11.0 disableAirSensor toggle, 3.12.0 maintenance + adversarial pass (Node range, login errors, null/NaN guards, write serialization, live room discovery, disableHistory), 3.12.1 reliability + docs audit, 3.13.0 labelled secondary reading (M8). Unreleased changes (if any) on `main` — check `git log v3.13.0..main`.
**Engines:** Homebridge `^1.6.0 || ^2.0.0`; Node `^22.0.0 || ^24.0.0 || ^26.0.0` (raised in 3.12.0 — Node 18/20 are EOL and Homebridge 2.4 itself requires `^22 || ^24 || ^26`; keep this range in step with Homebridge's own `engines`, and mirror it in `.github/workflows/ci.yml`)

### Fork rules

- This is a **maintained fork published to npm under a distinct name** (`homebridge-warmup4ie-v2`). The original (`homebridge-warmup4ie`) is unaffected and still on npm at 0.1.1.
- The HomeKit *platform identifier* in users' `config.json` stays `"platform": "warmup4ie"` for migration compatibility — only the npm package name differs.
- The `upstream` git remote is **intentionally not configured**. Do not re-add it. Do not open PRs against `NorthernMan54/homebridge-warmup4ie`.
- CI runs lint + tests + smoke on Node 22/24/26 for every push (`.github/workflows/ci.yml`). Releases are tag-driven: `npm version patch|minor|major && git push --follow-tags` triggers `release.yml`, which publishes to npm with provenance and creates a GitHub Release.
- **`package.json` `repository.url` MUST exactly match the GitHub repo URL** (`https://github.com/nookied/homebridge-warmup-v2.git`). npm's sigstore provenance is strict — a mismatch causes `npm publish` to fail with HTTP 422. We hit this twice during repo renames — see CHANGELOG entries for v2.0.x and v3.10.2.

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
│   │   │   ├── startPolling()                    setInterval(getStatus + reconcile-if-changed + push); skips while a poll is in flight
│   │   │   └── shutdown()                        Clear poll timer + pending debouncers (api 'shutdown' event)
│   │   ├── loadFakeGatoHistory()                Deferred fakegato require — skipped entirely by disableHistory
│   │   ├── attachAccessoryServices(p, acc, room) Idempotent service setup (Information/Thermostat/TemperatureSensor)
│   │   ├── pushRoomState(acc, room)              Updates HAP characteristics from a room snapshot
│   │   ├── updateAccessoryState(p, room)         Looks up acc by UUID, refreshes context.room + pushRoomState
│   │   ├── handleTargetHeatingCoolingSet         .onSet handler — Off/Heat/Auto switching
│   │   ├── handleTargetTemperatureSet            .onSet handler — debounced (300 ms trailing edge)
│   │   ├── roomSetChanged(p, rooms)             Cheap add/remove check that gates a poll-tick reconcile
│   │   ├── enqueueAccessoryWrite(p, acc, task)   Serializes cloud writes per accessory (ordering)
│   │   ├── updateIfFinite(svc, char, value)      Skips NaN/Infinity writes — HAP rejects them
│   │   ├── toCelsius(tenths)                     tenths → °C; null → NaN so the write is skipped
│   │   ├── secondaryReading(room)                The reading the Thermostat isn't showing
│   │   ├── secondaryReadingLabel(room)           "Floor"/"Air" from the device's own label
│   │   ├── logSensorModes(platform, rooms)       Startup: says which reading each Thermostat shows
│   │   ├── effectiveTargetTemp(room)             Clamps targetTemp to [minTemp, ∞)
│   │   ├── asHapStatusError(err)                 Maps Warmup errors → HAP status codes
│   │   └── uuidForRoom(roomId)                   api.hap.uuid.generate('warmup4ie:' + roomId)
│   │
│   └── lib/
│       ├── warmup4ie.js                      Warmup cloud API client (class Warmup4IE)
│       │   ├── _fetch(url, body, headers)            Generic POST helper, AbortSignal.timeout(20s)
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
│       ├── state.js                          Pure HeatingCoolingState derivers (no HAP types)
│       │   ├── deriveCurrentHeatingState(room)
│       │   └── deriveTargetHeatingState(room)
│       ├── metadata.js                       Pure HomeKit metadata/energy derivers
│       │   ├── deriveFirmwareRevision(room, fallback)
│       │   └── deriveTotalConsumption(room)
│       └── hap-compat.js                     HAP-NodeJS Formats/Perms resolution
│           ├── resolveFormats(homebridge)         → modern top-level | legacy static | spec strings
│           └── resolvePerms(homebridge)           → modern top-level | legacy static | spec strings
│
├── test/
│   ├── unit/
│   │   ├── _fetch.test.js                    Generic fetch + _rest + _graphql + _isTokenError
│   │   ├── wire-format.test.js               GraphQL mutation+variables byte-for-byte
│   │   ├── state-derivers.test.js            Truth tables for both derivers
│   │   ├── firmware-and-energy.test.js       deriveFirmwareRevision + deriveTotalConsumption
│   │   └── eve-characteristic.test.js        Eve TotalConsumption characteristic definition
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
│   │   ├── userLogin.error.json              Real bad-credentials body (errorCode 101)
│   │   ├── graphql.owned.json                Three rooms, full current Thermostat4iE payload
│   │   ├── graphql.owned.unpaired.json       Room with `thermostat4ies: []` (NaN-guard cases)
│   │   ├── graphql.owned.empty.json
│   │   ├── graphql.mutation.success.json
│   │   └── graphql.error.json
│   ├── helpers.js                            stubFetch, stubGraphQLClient, sequencedFetch, makeResponse, loadFixture
│   └── hbConfig/                             Sandbox Homebridge config for `npm run watch`
│
├── .github/workflows/
│   ├── ci.yml                                Lint + test + smoke on Node 22/24/26, every push + PR
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
2. Homebridge instantiates `warmup4iePlatform(log, config, api)`. The constructor reads + clamps config, sets up `this.accessories: Map<UUID, PlatformAccessory>` and `this._debouncers: Map<UUID, Map<char, PendingDebounce>>`, and registers `api.on('didFinishLaunching', () => discoverDevices())` plus `api.on('shutdown', () => shutdown())`.
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

Temperatures from the GraphQL API are integers in tenths of °C on `Room` (`195` = 19.5 °C); on `Thermostat4iE.airTemp/floor1Temp/floor2Temp` they are **strings** in tenths (`"195"`). `normalizeRoom` runs all of them through `tenths()`, which yields a **Number of tenths, or `null` when the field is absent**; `index.js` converts with `toCelsius()` (which maps `null` → `NaN`) and skips the HomeKit write when the result isn't finite, then multiplies by 10 on the way out.

> **Trap:** every temperature in the schema is nullable, and `Number(null) === 0` — *not* `NaN`. A plain `Number(x) / 10` therefore turns "no reading" into a confident 0 °C that HomeKit renders as real, and it slips past any `Number.isFinite` guard. This bit us in v3.12.0; keep new temperature fields going through `tenths()` / `toCelsius()` and never compare against a raw coercion.

`runMode` enum (per schema): `not_set | off | schedule | override | fixed | anti_frost | holiday | fil_pilote | gradual | relay | previous`. `src/lib/state.js` maps `off | holiday | anti_frost` to OFF (0), `fixed | override` to HEAT (1), `schedule | gradual` to AUTO (3), and falls back to HEAT for rare/unknown modes (`not_set`, `fil_pilote`, `relay`, `previous`). Current heating state uses Warmup's real relay/output signal when available, with the old temperature-delta inference only as a fallback.

## Live API field survey (2026-08-28)

Probed against a real 6-room account (Portugal, six Warmup devices, all
`type="rsw"`, firmware `29.175` / `28.166`) using
`scratchpad/probe-fields.js`, one field group per query so a gateway rejection
isolates itself. **Every group below was accepted** — unlike `user.location(id:)`,
which still 409s.

These are observations from one account. Treat them as strong evidence about
what the API returns in practice, not as guarantees.

### Sensor mode is knowable — stop asking users to guess

| Field | Location | Observed |
|---|---|---|
| `heatingTarget` | `Thermostat4iE` | `air` on all six (enum: `floor` \| `air`) |
| `mainTemp` / `mainLabel` | `Room` | `235` / `"air"` |
| `secondaryTemp` / `secondaryLabel` | `Room` | `900` / `"floor"` |

`Room.currentTemp` equalled `mainTemp` on every room, so **`currentTemp` is
whatever the device regulates on** — air here, and floor on a floor-configured
device. That is exactly what `disableAirSensor`'s README note currently asks
the user to work out for themselves. `heatingTarget` and `mainLabel` make it
knowable, and are the prerequisite for labelling the reading honestly rather
than hardcoding "Air".

### ⚠️ `900` is a "no probe fitted" sentinel, not a temperature

`secondaryTemp` read exactly `900` (= 90.0 °C) on all six rooms. Physically
impossible for underfloor heating and identical across devices: it means **no
floor probe is connected**. `floor1Temp` / `floor2Temp` almost certainly carry
the same sentinel on such devices.

**Any future floor-temperature sensor must suppress `900`**, or it will
publish 90 °C to every user without a floor probe — worse than not shipping
the feature. This was caught only because the field survey ran against real
hardware before anything was built.

### Energy data can be entirely absent

`energy="0.00"`, `cost="0.00"`, `total=0` on all six rooms. `total` is meant
to be cumulative since install, so zero is not "no usage today".

That means the **Eve `TotalConsumption` characteristic shipped in v3.5 has
been publishing nothing but `0` on this account since release** — a feature
that looks live in code and is inert in the field. Possibly because energy
tracking needs tariff configuration (`Parameters` carries `tariff1`,
`tariff2`, `currency`), possibly because these devices never report it.
Unresolved; worth checking against a second account before investing further
in energy features.

### Fields confirmed available but of limited use

- `Thermostat4iE.type` = `"rsw"` on all six. A model code, but not a
  marketing name — does **not** cleanly resolve the generic
  `"Wi-Fi Thermostat"` Model string (Known issue #1).
- `Parameters.rssi` = `""` — empty, useless for signal reporting.
- `Parameters.brightness` = `4`, except `10` on one device; `offsetAir` and
  `offsetFloor1` = `"0"`. So the display-brightness and sensor-offset work
  parked as Known issue #2 **is** reachable, with real varying values.
- `Room.floorType` = `tile_stone`, `roomType` = `bedroom` / `bathroom` /
  `living_room`. Room metadata with no obvious HomeKit home.
- `Thermostat4iE.systemType` varies within one account: `electric_relay` on
  one device, `electric` on the rest.

### Fields we already fetch and never read

`roomMode`, `overrideTemp`, `fixedTemp`, `energy`, `cost`, `floor1Temp`,
`floor2Temp`, `deviceSN`, `wifiFw`. Deliberately left in the query: removing
them is a wire-protocol change requiring a live test, for no measurable gain.

## HomeKit mapping

Every temperature below is normalized to tenths of °C by `tenths()` in
`normalizeRoom`, converted with `toCelsius()`, and **written only when the
result is finite** — an absent reading is skipped, not published as 0 °C.

| HomeKit characteristic | Source | Notes |
|---|---|---|
| `Thermostat.CurrentTemperature` | `toCelsius(room.currentTemp)` | `minValue: -100, maxValue: 100`. Skipped when absent. |
| `Thermostat.TargetTemperature` | `toCelsius(effectiveTargetTemp(room))` | Bounds from `room.minTemp/maxTemp`, but **only when the range is finite and min < max** — otherwise HomeKit's defaults are kept and a warning is logged. `effectiveTargetTemp` clamps up to `minTemp` (Warmup sometimes returns targets below the device floor) but returns `null` when there is no target, and refuses to clamp against an inverted range. |
| `Thermostat.CurrentHeatingCoolingState` | `deriveCurrentHeatingState(room)` | Precedence: `hasThermostat === false → OFF`; `runMode === 'off' → OFF`; `parameters.outputStatus` (the real relay signal, since v3.4) → non-zero = HEAT; else the legacy `currentTemp < targetTemp` heuristic. Only 0/1 are ever emitted, though `validValues` is left at the HAP default — only the *Target* characteristic restricts it. |
| `Thermostat.TargetHeatingCoolingState` | `deriveTargetHeatingState(room)` | `off/holiday/anti_frost → OFF`, `fixed/override → HEAT`, `schedule/gradual → AUTO`, default HEAT. `setProps({ validValues: [0, 1, 3] })` — no COOL. |
| `Thermostat.StatusFault` | `deriveStatusFault(room)` | `GENERAL_FAULT` when any of `isFaultAir` / `isFaultFloor1` / `isFaultFloor2` is set. (v3.3) |
| `Thermostat.StatusActive` | `deriveStatusActive(room)` | `false` when `hasThermostat === false` (no hardware paired) or `lastPoll > 20` minutes. Missing `lastPoll` errs toward `true`. (v3.4) |
| `Thermostat.RemainingDuration` | `deriveRemainingDuration(room)` | `overrideDur × 60` seconds. Range widened to `MAX_DURATION_MINUTES × 60` (24 h) because HAP's default caps at 1 h. (v3.4) |
| `Thermostat.<Eve TotalConsumption>` | `deriveTotalConsumption(room)` | Custom Eve characteristic, UUID `E863F10C-…`, from `room.total` (cumulative kWh). Returns `null` when unknown and the write is **skipped** — writing 0 would collapse Eve's cumulative graph. (v3.5) |
| `TemperatureSensor.CurrentTemperature` | `toCelsius(secondaryReading(room))` | The reading the Thermostat is *not* showing: `room.secondaryTemp` when a second probe exists, else `room.airTemp`. Service named `<name> <secondaryReadingLabel(room)>` — "Floor" or "Air", from the device's own `secondaryLabel`. `minValue: -100, maxValue: 100`. Hidden by `disableAirSensor`. Skipped when absent. The service is **recreated** if the reading changes meaning, so a tile named "Air" can never report floor temperature. (v3.13) |
| `LockMechanism.LockCurrentState` / `.LockTargetState` | `room.lock` | From `parameters.lock` (Int 0/1 on the wire, Boolean in our shape). Optimistic update on tap; the next poll reconciles. Hidden by `disableChildLock`. (v3.7) |
| `Switch.On` — *Vacation Mode* | any room `runMode === 'holiday'` | Synthetic per-location accessory. Hidden by `disableVacationSwitch`. (v3.6) |
| `Switch.On` — *Frost Protection* | any room `runMode === 'anti_frost'` | Synthetic per-location accessory. Hidden by `disableFrostSwitch`. (v3.6) |

`AccessoryInformation` carries Manufacturer `Warmup`, Model `Wi-Fi Thermostat`
(generic — see Known issues), SerialNumber `warmup4ie-<roomId>`, and
FirmwareRevision from `appFw` when it parses as SemVer-ish, else the plugin
version.

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
    "duration": 60,                     // optional; override duration, minutes (default 60, min 5, max 1440)
    "disableChildLock": false,          // optional; hide per-thermostat Lock tile (Element model doesn't honour the mutation)
    "disableVacationSwitch": false,     // optional; hide location-wide Vacation Mode switch
    "disableFrostSwitch": false,        // optional; hide location-wide Frost Protection switch
    "disableAirSensor": false,          // optional; hide standalone air-temp sensor tile (air reading still on Thermostat.CurrentTemperature)
    "disableHistory": false             // optional; skip Eve history — also avoids requiring fakegato/googleapis at all (~65 MB RSS, measured on a Pi 5)
  }]
}
```

`config.schema.json` provides a form-based editor in the Homebridge UI. Sandbox copy at `test/hbConfig/config.json` (creds blanked).

Multi-location accounts: only the **first** location is exposed (`user.owned[0]`). This is by design — see "Known issues → By design".

### Operational gotcha: child bridges and config reloads

A plugin running in a **child bridge** does not see a `config.json` change
until **all of Homebridge** restarts. Restarting just the child bridge — the
UI button, or `kill <child-pid>` — makes the parent respawn it from the config
the parent already holds in memory. The file is never re-read, so the edit
silently does nothing. Use `sudo systemctl restart homebridge` when testing
config-driven behaviour on a real host; this wasted a full round of
measurements during v3.12.1 QA.

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
7. CI's `release.yml` (triggered by the tag) lints, tests, smokes, then `npm publish` authenticated by **GitHub OIDC trusted publishing** (no token), then creates a GitHub Release. Provenance is generated automatically — do not re-add `--provenance`.

### CI / secrets

- `.github/workflows/ci.yml` — lint + test + smoke on Node 22 / 24 / 26, every push and PR.
- `.github/workflows/release.yml` — tag-driven (`v*`) publish + Release. Verifies tag matches `package.json` version before publishing.
- **No npm secret is required.** Publishing uses npm **trusted publishing** (GitHub OIDC), configured on npmjs.com under the package's *Trusted Publisher* settings: org `nookied`, repo `homebridge-warmup-v2`, workflow filename `release.yml`, environment blank. The workflow's `id-token: write` permission is the only credential in the path.
  - This replaced a long-lived Granular Access Token in v3.12.0. That token expired silently after 90 days and broke the release with a **`404 Not Found - PUT`** — npm reports a dead or unauthorized token as a missing package, so a 404 on publish means *auth*, not a missing package. Trusted publishing has no expiry, so this cannot recur.
  - **Two traps that both produce that same misleading 404:**
    1. **Never set `registry-url` on `actions/setup-node`.** It writes `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into `.npmrc`; with no token that expands to empty, npm decides auth is already configured, and never starts the OIDC exchange. (`actions/setup-node#1551`, `npm/documentation#1960`.) The workflow carries a comment saying so, plus a defensive step that strips any `_authToken` line.
    2. **Never rename `release.yml`.** npm matches the trusted publisher on the workflow *filename* alone; renaming it silently breaks publishing until the npmjs.com config is updated to match.
  - Requires npm >= 11.5.1 and Node >= 22.14 on the runner (Node 22 ships npm 10, so `lts/*` resolving to 22 would fail). The workflow asserts the npm version explicitly rather than letting it surface as a 404.

## Versioning

This fork starts at **2.0.0** as a tribute to the original v1.x lineage. From there it follows [SemVer](https://semver.org/):

| Bump | When | Examples |
|------|------|---|
| **MAJOR** (`X.0.0`) | Breaking change to config keys, HomeKit accessory shape, or user-visible behaviour | v3.0: per-room Off (was location-wide) |
| **MINOR** (`X.Y.0`) | New feature (multi-location, new HomeKit service, etc.) | v2.1: config.schema.json, HAP error categorization |
| **PATCH** (`X.Y.Z`) | Bug fix, dependency bump, doc-only change | (none yet on this fork) |

## Known issues / tech debt

### Open
1. **Per-thermostat `Model` is generic.** Set to `"Wi-Fi Thermostat"`. **Investigated 2026-08-28 and still unresolved:** `Thermostat4iE.type` *is* available and returns `"rsw"` — a model code, not a marketing name, and identical across six devices spanning two firmware versions. `deviceSN` is also available but is a serial, not a model. So there is no field that maps cleanly to "4iE" / "6iE" / "Element". Substituting `"rsw"` would be less informative than the current honest generic string. **Won't fix until Warmup exposes a real model name** — this is closer to "by design" than "to do".
2. **Partial `deviceAdvanced` integration only** — child lock is surfaced; display brightness and sensor offsets remain deferred. **Confirmed reachable 2026-08-28:** `Parameters.brightness` returns real, varying values (`4` on five devices, `10` on one), and `offsetAir` / `offsetFloor1` return `"0"`. So the data is there and the mutation exists. The open question is not feasibility but whether either belongs in HomeKit at all — there is no natural characteristic for "display brightness of a thermostat", and a Lightbulb service would be a lie. Deferred on design grounds, not technical ones.
3. **Eve energy may be inert.** `energy`, `cost` and `total` all returned zero across a real six-room account (2026-08-28), and `total` is meant to be cumulative-since-install. The Eve `TotalConsumption` characteristic shipped in v3.5 therefore publishes nothing but `0` there. Cause unknown — possibly tariff configuration is a prerequisite (`Parameters` carries `tariff1`, `tariff2`, `currency`), possibly these devices never report it. **Check against a second account before investing further in energy features.**
4. **`room.cost` not surfaced.** Available in `normalizeRoom`, no HomeKit/Eve home for it (Eve has no standard cost characteristic). Could add as a custom characteristic if a user asks.

### By design (won't fix)
- **First location only.** `_fetchRooms` takes `user.owned[0]`. If you have multiple Warmup locations on one account (e.g. primary residence + holiday home), only the first one is exposed. To expose a second location, run a second Homebridge child bridge with another account. A `location: "name"` config option to filter by name is feasible and would mirror the Python reference, but isn't planned.
- **`accept-language: de-de`** in REQUEST_HEADERS is a quirk of the original reverse-engineering. The real Warmup app sends `en-gb` (per `jondarrer/warmup-api/http-requests.http`). Both work — leave for now.

## Working rules (for this repo)

1. **Don't change the wire protocol without testing live.** The Warmup API is unofficial; GraphQL gateway 409s on certain query shapes (`user.location(id:)`) even when the schema says they're valid. Run `WARMUP_LIVE_TEST=1 npm test` before tagging a release.
2. **The introspected schema is not documentation — probe before you build.** `jondarrer/warmup-api/warmup-schema.graphql` says what the *types* allow, not what your devices *return*. A field can be present, accepted by the gateway, and still carry a sentinel or a constant zero. The 2026-08-28 survey found `secondaryTemp` returning `900` for "no probe fitted" and `total` returning `0` on every room; building on either without checking would have shipped 90 °C tiles and a permanently flat energy graph. Use `tools/probe-fields.js`.
3. **Prefer minimum-diff fixes.** Most of the open tech debt has been there for years — don't refactor end-to-end while fixing a one-line bug.
4. **Touch the README and this file together** when adding/changing config keys or behaviour.
5. **Walk `QA_TESTS.md` before tagging a release.** Offline tests + live tests catch code-side regressions; the manual checklist catches wire-format drift on the *Warmup* side and HomeKit-integration issues mocks can't see.
6. **Never re-add an `upstream` remote pointing at NorthernMan54.** This fork is intentionally isolated.
7. **Don't touch other people's repositories.** No pull requests, no issues, no comments on third-party projects — including projects we depend on, and including cases where their bug is one we are carrying. Report nothing, request nothing, contribute nothing.
   **Forking is fine.** Taking a permissively-licensed project, applying our own changes under our own account and publishing under our own name is our work in our space, and does not touch theirs. Honour the licence: keep the original copyright, licence text and attribution.
   **The Homebridge Verified application is the one sanctioned exception.** Filing at [`homebridge/plugins`](https://github.com/homebridge/plugins) and answering the reviewer there is a submission about *this* plugin through the maintainers' own intake process — it asks nothing of their codebase and contributes nothing to it. Replying in that thread is fine; opening issues or PRs against Homebridge itself is not.
   Note that `patch-package` and `overrides` are *not* a lighter-weight alternative to a fork — neither reaches an end user who installs this plugin from npm. They only patch the tree of the project that runs them, so for shipping a dependency fix to users, a fork is the only mechanism that works.
8. **Tag matches `package.json` version.** The release workflow asserts this; `npm version` does it for you.
9. **`package.json` `repository.url` must match the GitHub repo URL exactly.** Sigstore provenance is strict; a mismatch breaks `npm publish` with HTTP 422 (we hit this once during the GitHub repo rename — see CHANGELOG).

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
| Probe what a field actually returns | `WARMUP_USERNAME=… WARMUP_PASSWORD=… node tools/probe-fields.js` — never assume from the schema alone |
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
| `src/lib/metadata.js` | Pure firmware-revision and Eve total-consumption derivers |
| `src/lib/hap-compat.js` | HAP-NodeJS Formats/Perms resolution with version-tolerant fallbacks |
| `test/unit/_fetch.test.js` | Generic fetch + REST + GraphQL transport + token-error pattern |
| `test/unit/wire-format.test.js` | GraphQL mutation + variables shape assertions |
| `test/unit/state-derivers.test.js` | Truth tables for the two heating-state derivers |
| `test/unit/firmware-and-energy.test.js` | `deriveFirmwareRevision` + `deriveTotalConsumption` (incl. the null-vs-zero contract) |
| `test/unit/eve-characteristic.test.js` | Eve `TotalConsumption` custom-characteristic definition |
| `test/integration/bootstrap.test.js` | REST login → GraphQL owned[] → callback (full happy + error paths) |
| `test/integration/poll.test.js` | getStatus refreshes cache; multiple polls don't duplicate |
| `test/integration/error-recovery.test.js` | Failed poll cache preservation + 401 token-refresh sequence |
| `test/integration/homebridge-loadtime.test.js` | `registerPlatform` smoke with a fake homebridge shim |
| `test/live/api.test.js` | Opt-in live API tests (gated by `WARMUP_LIVE_TEST=1`) |
| `test/fixtures/*.json` | Sanitized API response samples (REST login + GraphQL owned/unpaired/error/mutation). **Keep `graphql.owned.json` in step with `GQL_OWNED_AND_ROOMS`** — it silently went three releases stale before v3.12.0, leaving the newer fields with no integration coverage. |
| `test/helpers.js` | Shared test utilities (fetch stubbing, response builder, fixture loader) |
| `tools/probe-fields.js` | Maintainer-only. Probes candidate GraphQL fields against a real account, one field group per query so a gateway rejection isolates itself. Produced the 2026-08-28 field survey. Excluded from the npm tarball. |
| `test/hbConfig/config.json` | Sandbox Homebridge config for `npm run watch` (gitignored; the copy at HEAD has placeholder credentials) |
| `test/hbConfig/auth.json` | Sandbox Homebridge-UI account for `npm run watch` — **gitignored since v3.12.1**; Homebridge UI regenerates it on first run |
| `.github/workflows/ci.yml` | Lint + test + smoke on Node 22/24/26, every push + PR |
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
