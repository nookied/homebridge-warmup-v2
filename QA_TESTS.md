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
