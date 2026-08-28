# QA — Manual pre-release checklist

Run this on the real Homebridge host before tagging a release. The automated test suite catches code regressions; this catches **wire-format drift** on the Warmup cloud side and HomeKit integration issues that mocks can't see.

Budget: ~15 minutes per release.

---

## 0. Pre-flight

- [ ] Working from a clean `git status` on the release branch
- [ ] `package.json` `version` matches the planned tag (e.g. `3.0.0` for tag `v3.0.0`)
- [ ] `CHANGELOG.md` has an entry for the new version with date
- [ ] `package.json` `repository.url` matches the GitHub repo URL exactly (sigstore provenance is strict — see CHANGELOG note for v2.1.0)
- [ ] `npm run lint` clean
- [ ] `npm test` all green (offline + integration)
- [ ] Live tests pass:
      `WARMUP_LIVE_TEST=1 WARMUP_USERNAME=… WARMUP_PASSWORD=… npm test`
- [ ] Working git SHA noted for rollback: `_______________`

## 1. Install on the Homebridge host

```bash
# Latest published from npm (preferred)
sudo npm install -g homebridge-warmup4ie-v2@<version>

# Or pin to a specific commit:
sudo npm install -g github:nookied/homebridge-warmup4ie-v2#<sha>

sudo systemctl restart homebridge   # or: hb-service restart
sudo journalctl -u homebridge -f --since '1 minute ago'
```

- [ ] No errors during plugin load (`Loaded plugin: homebridge-warmup4ie-v2@<version>`)
- [ ] `[WarmUP] Logging into warmup4ie...` followed by `[WarmUP] Found N room(s)` — N matches the Warmup / MyHeating app
- [ ] One `[WarmUP] Adding <name>` line per room — **only for accessories new to this host.** On an upgrade with a populated cache you get `Loaded N cached accessories` instead and no `Adding` lines; that is correct, not a failure
- [ ] No `Warmup API:`, `Warmup HTTP`, or `Warmup GraphQL:` errors in the first minute
- [ ] No `TypeError`, `ReferenceError`, unhandled promise rejection

## 2. Smoke (Home app)

Open the iOS Home app:

- [ ] All N thermostat tiles appear in the room they were assigned to
- [ ] Each tile shows current temperature within ±0.5 °C of the value on the physical thermostat display (that display shows **ambient temperature**; the *setpoint* is only visible in the Warmup app)
- [ ] Each tile shows the correct target temperature
- [ ] Tap a tile to open it: target/current temperatures, mode buttons all visible
- [ ] The paired `<name> Air` temperature sensor shows the air-temp probe value
- [ ] Accessory info (long-press tile → ⓘ): Manufacturer = "Warmup", Model = "Wi-Fi Thermostat", Serial = `warmup4ie-<roomId>`, Firmware = plugin version

## 3. Control — single room (do these for ONE room first)

> **Setpoints are not visible on the device.** The physical thermostat
> displays ambient room temperature; the target only appears in the Warmup
> app. Verify every setpoint change there, not on the wall unit.
>
> **Successful control actions log nothing.** `Set TargetTemperature` /
> `Set HeatingCoolingState` / `Set ChildLock` are emitted at `debug` level, so
> they are invisible unless Homebridge debug mode is on. Only *failures* log,
> at `error` level. So for this section the pass signal is **the Warmup app
> (or the device, for Off) reflecting the change + no new error lines** — do
> not go hunting for confirmation lines that were never going to appear.


- [ ] **Drag target temperature slider** → Warmup app shows "Override" active for `duration` minutes
- [ ] **Slider drag-and-drop is debounced** — drag fast across many values; only the *final* value is sent (one network call, not N) — check Homebridge log
- [ ] **Wait `duration` minutes** → override expires; physical thermostat returns to schedule
      *(or: shorten `duration` to 5 minutes in `config.json` for the test)*
- [ ] **Tap Off button** → physical thermostat display goes "OFF"; floor heating stops
- [ ] **Tap Heat button** → physical thermostat resumes program; runs the schedule
- [ ] **Tap Auto button** → same as Heat (both resume program)

## 4. Control — multi-room (skip if you only have one room)

**Behaviour change in v3.0:** Off is now **per-room** (was location-wide in v2 and earlier). Verify this works correctly.

- [ ] Tap **Off** on **one** room → only that room shows "Off" in HomeKit; **other rooms continue normally** (physical thermostats unaffected)
- [ ] Tap **Off** on a **second** room → both rooms now off; remaining rooms still operating
- [ ] Tap **Heat** on the first off-room → only that room resumes program; the second off-room stays off
- [ ] If you want the v2 "all rooms off" behaviour, build a HomeKit Scene that turns Off on every thermostat at once
- [ ] *(Side check)* In the Warmup mobile app, the same per-room off behaviour is observable — our v3 matches the app's default

## 5. Regression sentinels (must verify each release)

These are bugs that broke previous versions. Verify they stay fixed:

- [ ] **Off command actually stops heating** *(broken in upstream 0.1.0–0.1.1)* — confirm physical thermostat display goes "OFF" and floor stops heating
- [ ] **Override duration is correct in local time** *(UTC-shifted in upstream 0.1.0–0.1.1)* — set a 5-minute override, wait 5 minutes by your local clock, confirm it expires; v3 sends `minutes` directly (not HH:MM `until`), so this should be DST/timezone-immune
- [ ] **API errors surface to HomeKit** as "Not Responding" — to test, edit `config.json` to use bad credentials, restart, observe "Not Responding" tiles
- [ ] **Per-room Off works** *(v3.0 unlock; was location-wide in v2)* — see section 4

## 5b. New in v3.12.0 (verify once, then fold the keepers into section 5)

Everything here is new behaviour or a fix that offline tests cannot fully
prove. Each is written so a failure is unambiguous.

- [ ] **Bad-password error is readable** — set a deliberately wrong password in `config.json`, restart, and check the log. Expect `Warmup API: invalid email or password (errorCode 101)`. A bare `Warmup API: {"result":"error"}` means the decoding regressed. Restore the correct password afterwards.
- [ ] **Room added without a restart** — with Homebridge running, create a new room in the MyHeating app. Within one `refresh` interval (default 60 s) the log should show `Warmup room list changed — reconciling accessories` and `Adding <name>`, and the tile should appear in the Home app. **No restart.**
      *Needs a spare, unpaired thermostat: MyHeating will not create a room without pairing a device to it. Do **not** delete and re-add a real room to force this — that is live heating. If no spare hardware is available, skip and rely on the integration coverage noted in the release log.*
- [ ] **Room removed without a restart** — delete that room again in the MyHeating app. Within one interval: `Removing stale accessory: <name>`, and the tile disappears. *(Same hardware caveat as above.)*
- [ ] **No log/disk churn when nothing changes** — leave it idle for 5+ minutes. `Warmup room list changed` must appear **only** when you actually add or remove a room. Repeated occurrences mean the change detection is misfiring and Homebridge is rewriting its accessory cache every poll.
- [ ] **Renaming still behaves as before** — rename a room in the Home app. It must *not* be reverted on the next poll (only on restart, as in previous versions). Reversion within a minute means the change detection is wrongly treating names as identity.
- [ ] **Rapid successive setpoint changes land in order** — set 20 °C, wait ~2 s, set 24 °C, wait for the poll. **Read the setpoint in the Warmup app, not off the thermostat** (the device display shows ambient room temperature, not the target). It must end at **24 °C**; ending at 20 °C is the write-ordering race returning. Note this failure is *silent* — both writes succeed and nothing is logged — so the app reading is the only signal.
- [ ] **`disableHistory` saves memory** — note Homebridge's RSS (`systemctl status homebridge`, or the Homebridge UI status page). Set `"disableHistory": true`, restart, compare. Expect roughly **100 MB lower** for this plugin's process. Then confirm every thermostat tile still reads and controls normally — only Eve.app graphs should be gone.
- [ ] **Eve history still works with the default** — set `disableHistory` back to `false`, restart, open Eve.app, and confirm the temperature history graph is still populating. This is the path the lazy load could plausibly break.
- [ ] **Uncommissioned room** *(only if you can make one)* — create a room in the MyHeating app but pair no thermostat to it. The tile should appear as **not responding / inactive** rather than showing a plausible-looking idle thermostat, and must not log HAP "illegal value" warnings.

## 6. Edge cases

- [ ] **Internet drop**: disable internet on the Homebridge host for 2 minutes, observe `Warmup network error` log lines (no crash, no zombie callbacks). Re-enable; next poll succeeds, tiles update.
- [ ] **Token expiry simulation** *(if testable)*: rotate your password in the Warmup app while Homebridge is running; the next poll should fail (`Warmup HTTP 401` or `Warmup API`); after restart, recovery works. *(Or trust the unit-test coverage of token-refresh logic.)*
- [ ] **Homebridge restart**: `sudo systemctl restart homebridge`; all rooms re-appear in HomeKit without re-pairing.
- [ ] **Rapid taps**: tap Off → Heat → Off → Heat in rapid succession (< 2 sec); each call should succeed or fail gracefully (no double-callback / no orphaned override).
- [ ] **Stale upstream install**: if upgrading from `homebridge-warmup4ie@0.1.x`, confirm there are no duplicate accessory tiles. If duplicated, clear via Homebridge UI → Settings → Remove Single Cached Accessory.

## 7. Rollback test (do once per major version, not per patch)

- [ ] Verify `sudo npm install -g homebridge-warmup4ie-v2@<previous-version>` works
- [ ] After rollback, confirm previous version's behaviour returns
- [ ] Document the previous-good version + SHA in the GitHub Release notes

---

## Sign-off

- [ ] All sections passed
- [ ] Date / tester / version: `_____________________________________________`
- [ ] Tag created: `git tag v<version>` and `git push --follow-tags` triggered the publish workflow
- [ ] npm package visible at https://www.npmjs.com/package/homebridge-warmup4ie-v2 with the new version
- [ ] GitHub Release published

If any item failed, do **not** tag. File an issue in the repo, fix on the branch, re-run the suite, and try again.

---

## Release log

Keep the checklist above blank and reusable; record each release's actual
result here, including what was *not* run.

### v3.12.1 — 2026-08-28

Reliability + hygiene patch. Staged on a clean tree; released SHA `2143764`.

**Passed**

- **Live API test — the first time it has run in this cycle.** 149 tests
  total: 147 offline plus the 2 live cases, against a real Warmup account.
  This is the only check capable of detecting wire drift in Warmup's
  unofficial, unversioned API; everything else only proves the plugin still
  agrees with itself.

  What it confirms on real data: login and room fetch succeed; every
  normalized temperature is a Number or `null` (asserted as a type check, not
  `Number.isFinite(Number(v))`, which would pass for `null` since
  `Number(null)` is `0` — precisely the trap that produced fabricated 0 °C
  readings before v3.12.0); `minTemp < maxTemp` holds on real device data;
  `lock` is boolean-or-null and `outputStatus` number-or-null; and
  `getStatus()` refreshes the cache without changing room IDs.

  It also retroactively validates the v3.12.0 wire changes, since the staging
  HEAD contains all of them.
- Pre-flight verified mechanically: clean tree, changelog dated,
  `repository.url` matching the remote, `main` in sync with origin, lint,
  tests, smoke, and `npm audit` at zero vulnerabilities.

**Not run**

- **Live room add/remove: blocked, not skipped.** MyHeating will not create a
  room without pairing a thermostat to it, and no spare device is available.
  Deleting and re-adding a real room was rejected as a test method — it is
  live heating in an occupied house, and the coverage is not worth it.

  Compensating coverage: four integration tests drive the same path through
  the real platform code — room appears, room disappears, unchanged set does
  *not* rewrite the accessory cache, and a transient empty response does not
  tear out cached rooms. The first two were confirmed to **fail** against the
  pre-fix code, so they are genuine regression tests rather than tautologies.

  What that coverage does *not* reach, and what stays unverified until spare
  hardware exists: that real Homebridge/HAP accepts the dynamic
  register/unregister at runtime, and that the Home app tile actually appears
  and disappears. The plugin-side logic is proven; the HAP-side integration
  is inferred.
- Still outstanding and *doable* without extra hardware: `disableHistory`
  memory saving, Eve history on the default path, the decoded bad-password
  message, and the §2 Home-app visual smoke.

---

### v3.12.0 — 2026-08-28

Host: Raspberry Pi 5, Homebridge 2.4.0 (HAP 2.2.2), Node 24.20.0, plugin
running in a child bridge. 6 rooms. Released SHA `3c5e97f`.

**Passed**

- Pre-flight: clean tree, tag/version match enforced by CI, `CHANGELOG.md`
  dated, `repository.url` matches the repo, `npm run lint` clean,
  145 offline tests green, `npm audit` 0 vulnerabilities.
- Startup (§1): `Registering platform 'homebridge-warmup4ie-v2.warmup4ie'`,
  `Child bridge started successfully (plugin v3.12.0)`, `Logging into
  warmup4ie...` → `Found 6 room(s)` in ~1 s. Zero occurrences of
  `Warmup API:`, `Warmup HTTP`, `Warmup GraphQL:`, `TypeError`,
  `ReferenceError`, unhandled rejection, or HAP `illegal value`.
- Control (§3): **Off/On** confirmed against the physical thermostat.
  **27 °C setpoint** applied and matched.
- **Write-ordering (§5b): passed.** 20 °C then 24 °C in quick succession
  ended at 24 °C, read from the Warmup app; no errors. This exercises
  `enqueueAccessoryWrite`, the serialization added in this release — the
  fix for a race that would otherwise have left the device on the older
  setpoint silently. Note the readout came from the Warmup app: the wall
  unit displays ambient temperature and never shows the target, so it
  cannot be used to verify a setpoint.
- Implicit confirmation of the v3.12.0 temperature-normalization rewrite:
  HomeKit rejects setpoints outside `TargetTemperature`'s
  `minValue`/`maxValue`, so 27 °C being accepted and applied proves
  `minTemp`/`maxTemp` normalized to a sane range from real device data.

**Weak evidence — do not treat as passed**

- No `Warmup room list changed` line appeared, which is what a stable 6-room
  account should produce. But the exported log ends ~1 s after startup, so
  almost no steady-state runtime was actually observed. Re-check the
  no-churn item in §5b over a window of at least 10 minutes before ticking
  it.

**Not run — carried forward**

- **Live API test** (`WARMUP_LIVE_TEST=1`). No credentials were available in
  the session that cut the release, so **v3.12.0 shipped to npm without it.**
  It was subsequently run against the v3.12.1 staging HEAD — which contains
  everything 3.12.0 shipped — and passed. See the v3.12.1 entry below. The
  gap was real at the time and is recorded here rather than erased.
- Live room add/remove, `disableHistory` memory saving, Eve history on the
  default path, the decoded bad-password message, §2 Home-app visual smoke.

**Observations (pre-existing, on v3.11.0 — not introduced by this release)**

- 7 × `Warmup network error: The operation was aborted due to timeout` across
  26–28 Aug — the client's 10 s `AbortSignal.timeout` firing. Each costs one
  poll cycle. **Addressed in v3.12.1:** timeout raised to 20 s, plus an
  in-flight guard so the longer timeout cannot let polls overlap.
- A 50-minute block of `fetch failed` on 26 Aug (15:30–16:20) ending in a
  restart. Unknown whether it would have self-recovered; if it recurs,
  determine that before assuming the poll loop recovers on its own.
