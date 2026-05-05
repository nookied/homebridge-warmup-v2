# Roadmap — homebridge-warmup4ie-v2

Living development plan, derived from a structured audit (May 2026) of:
- **Homebridge / HAP-NodeJS docs** — plugin patterns, Verified requirements, modern characteristic APIs
- **Warmup cloud API** — full reverse-engineering trail across `alex-0103/warmup4IE` (Python REST), `ha-warmup/warmup` (richer GraphQL), `openhab/openhab-addons` warmup binding (Java GraphQL), and `jondarrer/warmup-api` (full introspected GraphQL schema, 3113 lines)

The audit unlocked a **major architectural finding**: the API endpoint we use (`api.warmup.com/apps/app/v1`, REST) is a thin legacy facade. The canonical Warmup API is **GraphQL** at `https://apil.warmup.com/graphql` — same `app-token` works, and it exposes everything (per-room off, holiday mode, energy/cost charts, schedule edit, sensor offsets, child lock) that the REST surface either fakes or omits entirely.

---

## TL;DR — three bets

1. **Switch transport to GraphQL** (`apil.warmup.com/graphql`). Keep REST only for `userLogin`. Unlocks per-room off, holiday mode, energy/cost charts, sensor faults, schedule introspection, multi-location iteration, override duration in minutes (not local-time HH:MM), and ~30 other endpoints. *Source of truth: [`jondarrer/warmup-api/warmup-schema.graphql`](https://github.com/jondarrer/warmup-api/blob/main/warmup-schema.graphql).*
2. **Migrate to Dynamic Platform.** Required for Homebridge Verified. Fixes "accessories rebuilt every restart" reset behaviour and unlocks fakegato-history.
3. **Ship `config.schema.json`** so users get a form-based config editor in the Homebridge UI. Required for Verified. ~30 minutes of work.

Everything else is incremental polish on top of those three.

---

## Where we are today (v2.0.0 baseline)

✅ Working hard-off (whole-location), correct local-time `until`, native fetch transport, surfaced API errors, full test suite (unit + integration + live), CI on Node 18/20/22, tag-driven npm publish with provenance, Apache-2.0 LICENSE, README + CHANGELOG + QA_TESTS, fork-isolated from upstream.

⚠️ Static accessory platform, no `config.schema.json`, REST-only transport, location-wide off only, no energy/cost, single-location, hostname-shaped log channel, plain `Error` to HAP setters (coarse "Service Communication Failure" in Home), legacy `.on('set', cb)` setters, no token refresh on expiry, no debounce on HomeKit writes.

---

## Verified-Plugin gap analysis

Source: [`homebridge/plugins` requirements](https://github.com/homebridge/plugins). 11 requirements; status:

| # | Requirement | Met? | Action |
|---|---|---|---|
| 1 | Dynamic platform plugin | ❌ | **Blocker** — see Milestone 4 |
| 2 | Doesn't duplicate an existing verified plugin | ✅ | None |
| 3 | Published to npm with source on GitHub, issues enabled | ✅ | None |
| 4 | A GitHub release per new version with notes | 🟡 | Auto-created by `release.yml` going forward |
| 5 | Runs on supported LTS Node versions (22 + 24 currently) | 🟡 | Add Node 24 to CI matrix; drop 18 once HB 2.0 is the floor |
| 6 | Installs successfully and doesn't start unless configured | ✅ | None |
| 7 | No TTY / non-standard startup parameters | ✅ | None |
| 8 | Implements Settings GUI via `config.schema.json` | ❌ | **Blocker** — see Milestone 1 |
| 9 | No analytics / user-tracking | ✅ | None |
| 10 | Files stored under HB storage dir | ✅ | None (no disk files yet) |
| 11 | Catches and logs own errors, no unhandled exceptions | 🟡 | Replace `console.error` in `_fetch` with injected `log.error` |

**Two blockers (#1, #8) and three minor items (#4, #5, #11).** Closing all five is the prerequisite for a Verified application — see milestones below.

---

## Milestones

Versioning policy: post-2.0, follow [SemVer](https://semver.org/). Breaking config / HomeKit changes bump major; new HomeKit-visible features bump minor; bug fixes bump patch. Each milestone below maps to one target version.

### ✅ Milestone 1 — v2.1.0 — Verified-prep + UX polish — SHIPPED

**Goal:** close the small-effort verification blockers and ship UX wins users will notice immediately. No transport changes, no breaking changes.

**Shipped 2026-05-05.** All items below complete. See `CHANGELOG.md` for detail.

| Item | Description | Effort | Doc |
|---|---|---|---|
| **`config.schema.json`** | Single static JSON file. Fields: `username` (text), `password` (`format:"password"` so HB UI masks), `refresh` (integer, default 60, min 30 max 600), `duration` (integer, default 60, min 5 max 1440). `pluginAlias: "warmup4ie"`, `pluginType: "platform"`, `singular: true`. | 30 min | [HB schema spec](https://developers.homebridge.io/#/config-schema) |
| **`displayName` in `package.json`** | E.g. `"Homebridge Warmup 4iE"`. Renders in HB UI plugin browser instead of the bare npm name. | 5 min | [npm `displayName`](https://github.com/homebridge/plugins) |
| **Manufacturer & Model accessory info** | `Manufacturer: "Warmup"` (was `warmup4ie`). Set `Model` from `room.thermostat4ies[0].deviceModel` if available, else `"4iE"`. | 10 min | — |
| **Stable per-instance `roomId`-based serial** | Already done in v2.0.0 — keep. | — | — |
| **Logging hygiene** | `this.log.info` for one-time events, `this.log.debug` for set-action chatter and per-poll updates. Replace `console.error` in `_fetch` with `log.error` via DI. Drop polling chatter from default verbosity. | 30 min | — |
| **`.onSet(async)` migration** | Replace legacy `.on('set', cb)` with `.onSet(async value => {...})`. Throw `HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)` instead of `cb(new Error(...))`. | 1 h | [HAPStatus enum](https://github.com/homebridge/HAP-NodeJS/blob/master/src/lib/HAPServer.ts) |
| **HAP error categorization** | Map `_fetch` rejection types: network → `OPERATION_TIMED_OUT`, `Warmup HTTP 4xx` → `INSUFFICIENT_AUTHORIZATION`, `Warmup API: ...` → `SERVICE_COMMUNICATION_FAILURE`. | 30 min | — |
| **Token refresh on 401** | Detect 401 / "invalid token" message → null cached token → re-call `userLogin` once → retry. | 1 h | [openHAB pattern](https://github.com/openhab/openhab-addons/blob/main/bundles/org.openhab.binding.warmup/src/main/java/org/openhab/binding/warmup/internal/api/MyWarmupApi.java) |
| **Debounce HomeKit writes** | Slider drag emits one `set` per tick. Coalesce 300–500ms before sending. | 30 min | — |
| **Drop module-level mutable state** | `WarmupAccessToken` and `LocId` are file-scope `let`s — collide across multiple instances. Move to `this.token` / `this.locId`. | 30 min | — |
| **Engines: bump for HB 2.0 path** | Either declare separate engines per HB version, or drop HB 1.6 support and require Node `^22.10.0 || ^24.0.0`. Add Node 24 to CI matrix. | 15 min | [HB 2.0 changelog](https://github.com/homebridge/homebridge/blob/master/CHANGELOG.md) |
| **README: Child Bridge recommendation** | One-paragraph "Recommended: enable Child Bridge for this plugin" section. Slow-API plugins benefit. | 10 min | — |

**Total effort:** ~5 hours. **No breaking changes.** Ships as `2.1.0`.

After this milestone: items #5, #8, #11 of the Verified checklist are closed; #1 (dynamic platform) is the only remaining blocker.

---

### Milestone 2 — v2.2.0 — Multi-location + per-room Off

**Goal:** Fix the two biggest user-visible behaviour limitations from v2.0. Still on REST.

| Item | Description | Effort | Source |
|---|---|---|---|
| **`location` config option** | Optional string: name match (case-insensitive). If omitted, fall back to `locations[0]` (current behaviour). Matches alex-0103's pattern. | 1 h | [alex-0103 `_getLocations`](https://github.com/alex-0103/warmup4IE/blob/master/warmup4ie/warmup4ie.py) |
| **Per-room "Off" via REST `setProgramme` + low fixed temp** | Send `setProgramme roomMode: "fixed"` followed by an override at frost setpoint (5–7 °C). HomeKit "Off" no longer kills the whole house. | 2–3 h incl. live QA | — |
| **`StatusFault` characteristic** | Map `room.sensorFault` (or per-thermostat `isFaultAir`/`isFaultFloor1`/`isFaultFloor2`) to HAP `StatusFault`. Shows a red badge in Home if the floor probe disconnects. | 30 min | [Thermostat4iE schema](https://github.com/jondarrer/warmup-api/blob/main/warmup-schema.graphql) |

**Note:** the REST per-room-off workaround is a bridge until Milestone 3's GraphQL `deviceOff(lid,rid)` lands. We could skip the REST workaround entirely and wait for GraphQL. **Recommend skipping** if Milestone 3 lands within ~2 weeks of Milestone 2 — the workaround is brittle (relies on the user not noticing the room is "Heat at 5°C" rather than truly Off) and replacing it with the canonical operation in M3 is cleaner. **Decision pending — flag for the next planning round.**

**Total effort if we ship the workaround:** ~4 hours. Ships as `2.2.0`.

---

### Milestone 3 — v3.0.0 — GraphQL transport (the big unlock)

**Goal:** Migrate from REST to GraphQL. Becomes the foundation for everything in milestones 4–6.

This is a major version bump because the wire format changes entirely. Externally invisible to users (HomeKit shape is unchanged), but the internal contract is different enough that it warrants a major.

#### Why

The REST API at `api.warmup.com/apps/app/v1` is a legacy compatibility layer. Every meaningful capability lives at `apil.warmup.com/graphql` (note the `l` — "apil"). Authentication is the same REST `userLogin` (cached token), but on GraphQL calls the token rides as the `warmup-authorization` header instead of in the body. The schema is fully introspectable; [jondarrer/warmup-api](https://github.com/jondarrer/warmup-api/blob/main/warmup-schema.graphql) has dumped the full thing (3113 lines, current).

#### What we gain

| Capability | Mutation | Replaces |
|---|---|---|
| **Per-room hard off** | `deviceOff(lid, rid)` | The REST `setModes locMode:"off"` whole-location hack |
| **Per-room frost protection** | `deviceFrost(lid, rid)` (locks at 7 °C) | None — wasn't possible in REST |
| **Resume schedule** | `deviceProgram(lid, rid)` | `setProgramme roomMode:"prog"` (functionally equivalent) |
| **Override with explicit minutes** | `deviceOverride(lid, rid, temp, minutes)` (0–1440) | REST `setOverride` with HH:MM `until` (DST + timezone fragile) |
| **Cancel override** | `cancelOverride(lid, rid)` / `cancelAllOverrides(lid)` | None — wasn't possible cleanly |
| **Holiday mode** | `deviceHoliday(lid, temp, days, start, end)` / `cancelHoliday(lid)` | None |
| **Schedule edit** | `deviceSchedule(lid, rid, schedule)` (per-day intervals JSON) | None |
| **Sleep override** | `updateSleep(lid, rid, ...)` | None |
| **Child lock + brightness + sensor offsets + advanced flags** | `deviceAdvanced(lid, rid, lock, brightness, offsetAir, offsetFloor1, ...)` | None |
| **Geofencing master** | `setGeo(lid, geo, mob)` | None |
| **Multi-location enumeration** | `query { user { allLocations { id name rooms { ... } } } }` | REST `getLocations` only returns the array; same outcome |
| **Energy/cost charts** | `query { user { location(id) { rooms { energyChart(year,month,day,hour) } } } }` | None — historical charts not in REST |
| **Server time** | `query { serverDateTime }` | None — lets us derive `until` against Warmup's clock, not ours |
| **Firmware versions per device** | `query { ... thermostat4ies { appFw wifiFw deviceSN deviceModel } }` | Returns `null` in REST `getRooms` |
| **Real "is heating now" signal** | `query { ... thermostat4ies { parameters { outputStatus } } }` (relay state) | Currently inferred from `currentTemp < targetTemp` — heuristic, sometimes wrong |
| **Sensor fault flags** | `... { isFaultAir, isFaultFloor1, isFaultFloor2 }` | Partial in REST `room.sensorFault` |

#### Migration plan

1. **Co-existence layer.** Add a `_graphql(query, variables)` method alongside `_fetch`. New methods (`fetchAllLocations`, `getRoomsViaGraphQL`, `roomOff`, `roomFrost`, `roomOverride`, etc.) use GraphQL exclusively. Existing REST methods stay during the transition.
2. **Migrate read path.** Replace `_fetchRooms` with a GraphQL query that joins `room` and `thermostat4ies` data in one round trip. Test against a fixture captured from a real account.
3. **Migrate write path.** Replace `setRoomAuto` → `deviceProgram`, `setRoomOff` → `deviceOff`, `setTargetTemperature` → `deviceOverride`. Each individually shippable behind a feature flag if needed.
4. **Drop REST.** Delete unused REST methods + their fixtures. Keep only `userLogin`.
5. **Update tests.** Wire-format tests change shape (now GraphQL POST bodies, not REST `{request:{method:...}}`). State-deriver tests stay as-is.
6. **Update QA_TESTS.md.** Add explicit verification of per-room off (the new sentinel) and override duration.

#### Effort

**Estimate: 1–2 weeks.** Touches every method in `lib/warmup4ie.js`, full test suite rewrite for the transport layer, fixture recapture. Ships as `3.0.0`.

#### Risks

- **Token migration**: token from `userLogin` REST works on GraphQL with the `warmup-authorization` header. Confirmed by ha-warmup, openHAB. Low risk.
- **Schema drift**: jondarrer's dump is from 2024. If Warmup has changed the schema since, our queries break. Mitigation: introspect at startup in dev mode; fall back to REST if introspection rejects.
- **Rate limits**: ha-warmup throttles to 60s, openHAB defaults to 300s. Our default is 60s. Document and possibly raise to 120s.

---

### Milestone 4 — v3.1.0 — Dynamic platform migration

**Goal:** Migrate from static `accessories(callback)` to `DynamicPlatformPlugin` with cached accessories. Closes the final Verified blocker.

#### Why

- **Verified-Plugin requirement** ([requirement #1](https://github.com/homebridge/plugins)).
- Accessories persist across Homebridge restarts via the cache, instead of being rebuilt each time. HomeKit treats them as the same accessory (same UUID), so user customisations (room assignment, automations, names) survive.
- Required prerequisite for re-enabling `fakegato-history` (history graphs need a stable accessory across restarts to accumulate data).

#### What changes

- `accessories(callback)` removed. Replace with `configureAccessory(accessory)` and `discoverDevices()`.
- Each accessory built from a stable UUID derived from `roomId` (`api.hap.uuid.generate('warmup4ie:' + roomId)`).
- `getServices()` becomes a method that mutates the cached `PlatformAccessory`'s services in place.
- `api.registerPlatformAccessories(pluginName, platformName, [acc])` to publish new ones; `api.unregisterPlatformAccessories(...)` to remove rooms that disappeared from the Warmup account.

#### Migration impact for users

- **Existing users will lose their accessory pairings once.** When v3.1 starts, no cached accessories will exist (we never wrote any), so `discoverDevices` runs against a clean cache and creates fresh accessories. HomeKit sees the new UUIDs and registers new accessories. The old static-platform accessories disappear.
- **Mitigation:** in the v3.1 release notes, instruct users to manually remove the old accessories from the Home app *after* the upgrade. Or generate the new UUIDs to *match* what the static platform would have generated — risky, depends on internal HB UUID derivation.
- **Mitigation alternative:** ship v3.1 as a clean break (encourage users to re-pair) — simpler, more honest. A deliberate major-version-style change with clear release notes.

#### Effort

**Estimate: 1–2 days.** Most of the change is in `src/index.js`; `src/lib/warmup4ie.js` is unaffected.

---

### Milestone 5 — v3.2.0 — Eve / fakegato-history integration

**Goal:** Energy graphs in the Eve app + temperature history.

#### What

- Add `homebridge-lib@^8.0` dep for `EveHomeKitTypes`.
- Add `fakegato-history@^0.6.7` dep (HAP-NodeJS v2 compatible — fixes the bug that broke `homebridge-warmup4ie@0.0.14` on HB 2.0).
- For each thermostat accessory, attach a `FakeGatoHistoryService("thermo", accessory, ...)` that records `currentTemp`, `setTemp`, and a synthetic `valvePosition` (100 when heating, 0 when not — Warmup doesn't expose actual valve %).
- Add Eve `Energy.TotalConsumption` characteristic mapping to `room.energy` (kWh accumulated). Optionally a custom Eve cost characteristic for `room.cost`.
- For users with the Eve app, this unlocks graphs of: temperature over time, target temperature changes, heating-on intervals, daily energy usage.
- For users on Apple Home only, this is invisible — no UI change.

#### Prerequisites

- Milestone 4 done. fakegato-history needs a stable accessory across restarts.
- Recommended: GraphQL transport (Milestone 3) so we can use the `energyChart` query for richer energy data than the per-poll `room.energy` snapshot.

#### Effort

**Estimate: ~3–4 hours.** Ships as `3.2.0`.

---

### Milestone 6 — v3.3.0+ — Optional polish

A grab bag of GraphQL-enabled features. Each independently shippable. Pick based on user demand.

| Feature | Effort | User benefit |
|---|---|---|
| **Holiday mode as a HomeKit Switch** | ~2 h | Toggle to set the whole location into vacation mode at a defined frost-low temp |
| **Per-location Frost mode as a HomeKit Switch** | ~1 h | One-tap "frost protection" (e.g. when leaving for the weekend) |
| **`StatusActive` characteristic from `lastPoll`** | ~30 min | Home app shows accessory as "offline" if the thermostat hasn't checked in for >20 min |
| **`outputStatus` for accurate heating state** | ~30 min | `CurrentHeatingCoolingState=HEAT` reflects actual relay state, not the `currentTemp<targetTemp` heuristic |
| **`RemainingDuration` characteristic** | ~30 min | Home shows "Override active for N minutes" with countdown |
| **Sensor offsets via Eve admin tab** | ~2 h | Calibrate the floor probe ±1°C without using the Warmup app |
| **Child lock toggle** | ~1 h | HomeKit Lock service mapped to `deviceAdvanced.lock` |
| **Display brightness control** | ~1 h | LightBulb-like service mapped to `deviceAdvanced.brightness` (0–10) |
| **Multi-thermostat firmware version reporting** | ~30 min | `FirmwareRevision` from `appFw` instead of plugin's own version |
| **Schedule introspection (read-only)** | ~1 h | Surface the week's schedule as a JSON attribute (not editable from HomeKit, but visible in Eve / HA) |

---

### Milestone 7 — Verified Plugin application

**Goal:** Open an issue at [`homebridge/plugins`](https://github.com/homebridge/plugins/issues/new/choose) using the verification template.

**Prerequisites:**
- ✅ Milestone 1 (config.schema.json + Node 24 in CI + cleanup logging)
- ✅ Milestone 4 (dynamic platform)
- ✅ A few weeks of stability with at least 5–10 unique installs (npm download stats)
- ✅ At least one issue resolved with response visible

**Process:**
- File the issue. Use the standard Verified template.
- Reviewer (Homebridge maintainer) leaves comments inline.
- Address each comment via PR.
- Once approved, the plugin gets a Verified badge in the HB UI plugin browser and ranks higher in search.

**Effort:** ~30 min for the initial application, plus iteration on reviewer feedback (typically 1–2 small PRs).

---

## Out of scope (won't fix)

- **`Service.HeaterCooler` migration** — `Thermostat` is the right service for a heating-only programmable device. `HeaterCooler` would force two threshold sliders (one of which doesn't apply) and break every existing pairing. Stay on `Thermostat`.
- **TypeScript migration** — overkill for ~400 lines of JS. Adds build complexity without fixing a real problem.
- **Provisioning operations** (`addLocation`, `addDevice`, `deleteDevice`) — out of plugin scope. Use the Warmup app.
- **Firmware updates** (`upgradeLatestFw`) — too risky to expose; users who want to update can use the Warmup app.
- **Schedule editing from HomeKit** — HomeKit has no native schedule UI for thermostats; surfacing read-only is fine but editing is a worse UX than the Warmup app.
- **Mobile-app analytics / telemetry** — Verified explicitly forbids it.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Warmup changes the GraphQL schema** | Medium (no public schema versioning) | Introspect at startup in debug mode; fall back to REST if a critical field is missing; pin the schema dump as a fixture and detect drift |
| **`app-token` rotates** | Low (hasn't changed since 2019) | Monitor; if rotated, update from the latest mobile app build |
| **Token expires more aggressively than we expect** | Medium | Re-login on 401 (Milestone 1) |
| **Rate limit clamps tighter than 60s polling** | Low–medium (anecdotal reports of throttling at <30s) | Default to 120s; document and recommend Child Bridge isolation |
| **GraphQL endpoint deprecated in favour of REST again** | Very low | Keep REST `userLogin` always functional; the rest of the codebase modular enough to swap back |
| **Warmup ships an official API and breaks the reverse-engineered one** | Very low | Reactive, not preventative |

---

## Cross-references

- Existing plugin overview / fork rules: [CLAUDE.md](CLAUDE.md)
- Manual QA pre-release checklist: [QA_TESTS.md](QA_TESTS.md)
- Release history: [CHANGELOG.md](CHANGELOG.md)
- User-facing docs: [README.md](README.md)

---

## Source material (for re-research / verification)

| Source | Why it matters |
|---|---|
| [`alex-0103/warmup4IE`](https://github.com/alex-0103/warmup4IE) | Original REST reverse-engineering (2018–2021). Stale but still the canonical REST reference. |
| [`ha-warmup/warmup`](https://github.com/ha-warmup/warmup) | Home Assistant integration; uses GraphQL; richer field coverage; multi-location iteration; 60s throttle. |
| [`openhab/openhab-addons` warmup binding](https://github.com/openhab/openhab-addons/tree/main/bundles/org.openhab.binding.warmup) | Java binding; 401 → re-login pattern; default 5-min refresh. |
| [`jondarrer/warmup-api`](https://github.com/jondarrer/warmup-api) | **Full GraphQL schema dump (introspected, ~3000 lines)**. Source of truth for available queries/mutations. |
| [`alyc100/SmartThingsPublic` warmup-4ie.groovy](https://github.com/alyc100/SmartThingsPublic/blob/master/devicetypes/alyc100/warmup-4ie.src/warmup-4ie.groovy) | Predecessor work, useful for older REST behaviour reference. |
| [Homebridge `developers.homebridge.io`](https://developers.homebridge.io/) | Plugin development reference, schema spec, HAP-NodeJS API. |
| [`homebridge/plugins`](https://github.com/homebridge/plugins) | Verified Plugin requirements + application process. |
| [`homebridge/homebridge-plugin-template`](https://github.com/homebridge/homebridge-plugin-template) | Dynamic-platform reference implementation in TypeScript. |
| [`simont77/fakegato-history`](https://github.com/simont77/fakegato-history) | History service for Eve graphs. v0.6.7 fixes HAP-NodeJS v2 compat. |
