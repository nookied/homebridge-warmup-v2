# Roadmap — homebridge-warmup4ie-v2

Living development plan for a Homebridge plugin that talks to **Warmup Wi-Fi underfloor-heating thermostats** — the entire range that pairs with my.warmup.com / the MyHeating app (4iE legacy, 6iE, 7iE Smart Matter, Element Wi-Fi, Terra Wi-Fi, plus rebadged OEMs). Despite the package's legacy `warmup4ie` name, all these models share one cloud API and the plugin treats them uniformly. Derived from a structured audit (May 2026) of:

- **Homebridge / HAP-NodeJS docs** — plugin patterns, Verified requirements, modern characteristic APIs
- **Warmup cloud API** — full reverse-engineering trail across `alex-0103/warmup4IE` (Python REST), `ha-warmup/warmup` (richer GraphQL), `openhab/openhab-addons` warmup binding (Java GraphQL), and `jondarrer/warmup-api` (full introspected GraphQL schema, 3113 lines)

The audit unlocked a **major architectural finding**: the REST API endpoint used by v2 (`api.warmup.com/apps/app/v1`) is a thin legacy facade. v3 now keeps REST only for `userLogin` and uses the canonical Warmup **GraphQL** API at `https://apil.warmup.com/graphql` for reads/writes — same `app-token`, with access-token auth moved to the `warmup-authorization` header.

---

## TL;DR — three bets

1. **GraphQL transport is shipped** (`apil.warmup.com/graphql`), with REST kept only for `userLogin`. It unlocked per-room off and explicit override duration in minutes. More GraphQL-only features remain available for later milestones. *Source of truth: [`jondarrer/warmup-api/warmup-schema.graphql`](https://github.com/jondarrer/warmup-api/blob/main/warmup-schema.graphql).*
2. **Migrate to Dynamic Platform.** Still required for Homebridge Verified. Fixes "accessories rebuilt every restart" reset behaviour and unlocks fakegato-history.
3. **`config.schema.json` is shipped** so users get a form-based config editor in the Homebridge UI.

Everything else is incremental polish on top of those three.

---

## Where we are today (v3.0.0 + unreleased polish)

✅ GraphQL transport, per-room hard-off, explicit override duration in minutes, native fetch transport, token refresh, surfaced HAP errors, debounced HomeKit writes, config UI schema, full offline test suite, opt-in live tests, CI on Node 18/20/22/24, tag-driven npm publish with provenance, Apache-2.0 LICENSE, README + CHANGELOG + QA_TESTS, fork-isolated from upstream.

⚠️ Static accessory platform, no HomeKit energy/cost history, single-location, generic model metadata, and current-heating state still inferred from `currentTemp < targetTemp` instead of Warmup's relay/output signal.

---

## Verified-Plugin gap analysis

Source: [`homebridge/plugins` requirements](https://github.com/homebridge/plugins). 11 requirements; status:

| # | Requirement | Met? | Action |
|---|---|---|---|
| 1 | Dynamic platform plugin | ✅ | Shipped in v3.1.0 (Milestone 4). |
| 2 | Doesn't duplicate an existing verified plugin | ✅ | None |
| 3 | Published to npm with source on GitHub, issues enabled | ✅ | None |
| 4 | A GitHub release per new version with notes | 🟡 | Auto-created by `release.yml` going forward |
| 5 | Runs on supported LTS Node versions | ✅ | CI covers the package's declared Node range (18.20 / 20.15 / 22 / 24). Re-check Homebridge's current LTS policy before applying for Verified. |
| 6 | Installs successfully and doesn't start unless configured | ✅ | None |
| 7 | No TTY / non-standard startup parameters | ✅ | None |
| 8 | Implements Settings GUI via `config.schema.json` | ✅ | None |
| 9 | No analytics / user-tracking | ✅ | None |
| 10 | Files stored under HB storage dir | ✅ | None (no disk files yet) |
| 11 | Catches and logs own errors, no unhandled exceptions | ✅ | Missing config and bootstrap failure now return no accessories and do not start polling. |

**All requirements met as of v3.1.0.** Verified-Plugin application is queued as Milestone 7 — wait for a few weeks of stability + a couple of installs first, then file via the standard `homebridge/plugins` issue template.

---

## Milestones

Versioning policy: post-2.0, follow [SemVer](https://semver.org/). Breaking config / HomeKit changes bump major; new HomeKit-visible features bump minor; bug fixes bump patch. Each milestone below maps to one target version.

### ✅ Milestone 1 — v2.1.0 — Verified-prep + UX polish — SHIPPED

**Goal:** close the small-effort verification blockers and ship UX wins users will notice immediately. No transport changes, no breaking changes.

**Shipped 2026-05-05.** All items below complete. See `CHANGELOG.md` for detail.

| Item | Description | Effort | Doc |
|---|---|---|---|
| **`config.schema.json`** | Single static JSON file. Fields: `username` (text), `password` (`format:"password"` so HB UI masks), `refresh` (integer, default 60, min 30 max 600), `duration` (integer, default 60, min 5 max 1440). `pluginAlias: "warmup4ie"`, `pluginType: "platform"`, `singular: true`. | 30 min | [HB schema spec](https://developers.homebridge.io/#/config-schema) |
| **`displayName` in `package.json`** | `"Homebridge Warmup Wi-Fi Thermostats"`. Renders in HB UI plugin browser instead of the bare npm name. Avoids the model-specific "4iE" wording so users with 6iE/7iE/Element/Terra recognise the plugin. | 5 min | [npm `displayName`](https://github.com/homebridge/plugins) |
| **Manufacturer & Model accessory info** | `Manufacturer: "Warmup"` (was `warmup4ie`); `Model: "Wi-Fi Thermostat"` (was `4iE` — incorrect for users with 6iE/7iE/Element/Terra). A later metadata pass may use reliable GraphQL device/firmware fields where available. | 10 min | — |
| **Stable per-instance `roomId`-based serial** | Already done in v2.0.0 — keep. | — | — |
| **Logging hygiene** | `this.log.info` for one-time events, `this.log.debug` for set-action chatter and per-poll updates. Replace `console.error` in `_fetch` with `log.error` via DI. Drop polling chatter from default verbosity. | 30 min | — |
| **`.onSet(async)` migration** | Replace legacy `.on('set', cb)` with `.onSet(async value => {...})`. Throw `HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)` instead of `cb(new Error(...))`. | 1 h | [HAPStatus enum](https://github.com/homebridge/HAP-NodeJS/blob/master/src/lib/HAPServer.ts) |
| **HAP error categorization** | Map `_fetch` rejection types: network → `OPERATION_TIMED_OUT`, `Warmup HTTP 4xx` → `INSUFFICIENT_AUTHORIZATION`, `Warmup API: ...` → `SERVICE_COMMUNICATION_FAILURE`. | 30 min | — |
| **Token refresh on 401** | Detect 401 / "invalid token" message → null cached token → re-call `userLogin` once → retry. | 1 h | [openHAB pattern](https://github.com/openhab/openhab-addons/blob/main/bundles/org.openhab.binding.warmup/src/main/java/org/openhab/binding/warmup/internal/api/MyWarmupApi.java) |
| **Debounce HomeKit writes** | Slider drag emits one `set` per tick. Coalesce 300–500ms before sending. | 30 min | — |
| **Drop module-level mutable state** | `WarmupAccessToken` and `LocId` moved to `this._token` / `this._locId`; unreleased polish also moved platform accessory/client/timer state to instance fields. | 30 min | — |
| **Engines: bump for HB 2.0 path** | Either declare separate engines per HB version, or drop HB 1.6 support and require Node `^22.10.0 || ^24.0.0`. Add Node 24 to CI matrix. | 15 min | [HB 2.0 changelog](https://github.com/homebridge/homebridge/blob/master/CHANGELOG.md) |
| **README: Child Bridge recommendation** | One-paragraph "Recommended: enable Child Bridge for this plugin" section. Slow-API plugins benefit. | 10 min | — |

**Total effort:** ~5 hours. **No breaking changes.** Ships as `2.1.0`.

After this milestone: items #5, #8, #11 of the Verified checklist are closed; #1 (dynamic platform) is the only remaining blocker.

---

### ⏭️ Milestone 2 — v2.2.0 — Multi-location + REST per-room-off workaround — SUPERSEDED

**Status:** skipped. v3.0's GraphQL `deviceOff(lid, rid)` shipped real per-room hard-off, so the brittle REST low-fixed-temp workaround is intentionally not planned. Multi-location remains future work.

| Item | Description | Effort | Source |
|---|---|---|---|
| **`location` config option** | Optional string: name match (case-insensitive). If omitted, fall back to the first `user.owned[]` location (current behaviour). Matches alex-0103's pattern. | 1 h | [alex-0103 `_getLocations`](https://github.com/alex-0103/warmup4IE/blob/master/warmup4ie/warmup4ie.py) |
| ~~Per-room "Off" via REST `setProgramme` + low fixed temp~~ | Superseded by v3.0 GraphQL `deviceOff(lid, rid)`. | — | — |
| **`StatusFault` characteristic** | Map `room.sensorFault` (or per-thermostat `isFaultAir`/`isFaultFloor1`/`isFaultFloor2`) to HAP `StatusFault`. Shows a red badge in Home if the floor probe disconnects. | 30 min | [Thermostat4iE schema](https://github.com/jondarrer/warmup-api/blob/main/warmup-schema.graphql) |

**Result:** no `2.2.0` release was needed; v3.0 took the cleaner path.

---

### ✅ Milestone 3 — v3.0.0 — GraphQL transport (the big unlock) — SHIPPED

**Goal:** Migrate from REST to GraphQL. Becomes the foundation for everything in milestones 4–6.

This is a major version bump because the wire format changes entirely. **Per-room Off is now real** (was location-wide in v2 and earlier).

**Shipped 2026-05-05.** All items below complete. See `CHANGELOG.md` for detail.

**Implementation note from live testing:** the schema's `user.location(id: $lid)` field returns HTTP 409 in practice. The actual Warmup mobile app uses `user.owned[].rooms` instead — this is the path we ended up using. One GraphQL round trip returns all locations + their rooms; we pick `owned[0]`.

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

### ✅ Milestone 4 — v3.1.0 — Dynamic platform migration — SHIPPED

**Goal:** Migrate from static `accessories(callback)` to `DynamicPlatformPlugin` with cached accessories. Closes the final Verified blocker.

**Shipped 2026-05-05.** All items below complete. See `CHANGELOG.md` for detail.

**One-time migration cost (as predicted):** existing v3.0.x users see their thermostat tiles re-create as fresh accessories on first restart. Old static-platform versions never wrote to Homebridge's accessory cache, so the dynamic-platform startup runs against an empty cache. Future upgrades preserve the cache.

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

### ✅ Milestone 5 — v3.2.0 — Eve / fakegato-history integration — SHIPPED (partial)

**Goal:** Energy graphs in the Eve app + temperature history.

**Shipped 2026-05-05.** Temperature + heating-state history is live. Energy graphs (`Eve.Energy.TotalConsumption` mapped from `room.energy`) deferred to M6 to keep this release focused — would require defining Eve characteristic UUIDs or adding `homebridge-lib` for `EveHomeKitTypes`.

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

### Milestone 6 — v3.3.0+ — Optional polish (in progress)

A grab bag of features ranging from purely additive (no GraphQL changes) to "needs a careful query addition + live test". Each independently shippable. Pick based on user demand.

| Feature | Status | Effort | User benefit |
|---|---|---|---|
| **`StatusFault` from sensor fault flags** | ✅ shipped v3.3.0 | ~30 min | Sensor disconnects show as a fault badge in HomeKit accessory diagnostics. |
| **`runMode` edge cases** (`anti_frost`, `holiday`, `gradual`, etc.) | ✅ shipped v3.3.0 | ~30 min | `TargetHeatingCoolingState` is correct for vacation/frost-protection modes (was: always HEAT). |
| **Defensive: 0-room poll doesn't unregister cache** | ✅ shipped v3.3.0 | ~30 min | A transient Warmup API hiccup no longer rips users' HomeKit tiles out of rooms / scenes. |
| **Holiday mode as a HomeKit Switch** | open | ~2 h | Toggle to set the whole location into vacation mode at a defined frost-low temp. Needs new `deviceHoliday` GraphQL mutation. |
| **Per-location Frost mode as a HomeKit Switch** | open | ~1 h | One-tap "frost protection" (e.g. leaving for the weekend). Needs `setModes locMode:"frost"` REST or `deviceFrost` GraphQL. |
| **`StatusActive` characteristic from `lastPoll`** | open | ~30 min | Home app shows accessory as "offline" if the thermostat hasn't checked in for >20 min. Data already in `normalizeRoom`. |
| **`outputStatus` for accurate heating state** | open (risky) | ~30 min + live test | `CurrentHeatingCoolingState=HEAT` reflects actual relay state, not the `currentTemp<targetTemp` heuristic. **Requires re-adding `parameters { outputStatus }` to the GraphQL query — caused a 409 in v3 development; needs careful retry.** |
| **`RemainingDuration` characteristic** | open | ~30 min | Home shows "Override active for N minutes" with countdown. Data already in `normalizeRoom` (`overrideDur`). |
| **`Eve.Energy.TotalConsumption` from `room.energy`** | open | ~1 h | Eve graphs of energy use over time. Needs Eve characteristic UUIDs (or `homebridge-lib`). |
| **`FirmwareRevision` from `appFw`** | open | ~30 min + GraphQL change | Real device firmware version on the (i) info card. Needs `appFw` added to the GraphQL query. |
| **Sensor offsets via Eve admin tab** | open | ~2 h | Calibrate floor probe ±1°C without the Warmup app. Needs Eve characteristic UUIDs + `deviceAdvanced` mutation. |
| **Child lock toggle** | open | ~1 h | HomeKit Lock service mapped to `deviceAdvanced.lock`. |
| **Display brightness control** | open | ~1 h | LightBulb-like service mapped to `deviceAdvanced.brightness` (0–10). |
| **Schedule introspection (read-only)** | open | ~1 h | Surface the week's schedule as a JSON attribute (not editable from HomeKit, but visible in Eve / HA). |

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
