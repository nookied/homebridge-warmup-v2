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
- [ ] One `[WarmUP] Adding <name>` line per room
- [ ] No `Warmup API:`, `Warmup HTTP`, or `Warmup GraphQL:` errors in the first minute
- [ ] No `TypeError`, `ReferenceError`, unhandled promise rejection

## 2. Smoke (Home app)

Open the iOS Home app:

- [ ] All N thermostat tiles appear in the room they were assigned to
- [ ] Each tile shows current temperature within ±0.5 °C of the physical thermostat display
- [ ] Each tile shows the correct target temperature
- [ ] Tap a tile to open it: target/current temperatures, mode buttons all visible
- [ ] The paired `<name> Air` temperature sensor shows the air-temp probe value
- [ ] Accessory info (long-press tile → ⓘ): Manufacturer = "Warmup", Model = "Wi-Fi Thermostat", Serial = `warmup4ie-<roomId>`, Firmware = plugin version

## 3. Control — single room (do these for ONE room first)

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
- [ ] **Room removed without a restart** — delete that room again in the MyHeating app. Within one interval: `Removing stale accessory: <name>`, and the tile disappears.
- [ ] **No log/disk churn when nothing changes** — leave it idle for 5+ minutes. `Warmup room list changed` must appear **only** when you actually add or remove a room. Repeated occurrences mean the change detection is misfiring and Homebridge is rewriting its accessory cache every poll.
- [ ] **Renaming still behaves as before** — rename a room in the Home app. It must *not* be reverted on the next poll (only on restart, as in previous versions). Reversion within a minute means the change detection is wrongly treating names as identity.
- [ ] **Rapid successive setpoint changes land in order** — set 20 °C, wait ~2 s, set 24 °C, wait for the poll. The thermostat and the Warmup app must both end at **24 °C**. Ending at 20 °C is the write-ordering race returning.
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
