# QA — Manual pre-release checklist

Run this on the real Homebridge host before tagging a release. The automated test suite catches code regressions; this catches **wire-format drift** on the Warmup cloud side and HomeKit integration issues that mocks can't see.

Budget: ~15 minutes per release.

---

## 0. Pre-flight

- [ ] Working from a clean `git status` on the release branch
- [ ] `package.json` `version` matches the planned tag (e.g. `2.0.0` for tag `v2.0.0`)
- [ ] `CHANGELOG.md` has an entry for the new version with date
- [ ] `npm run lint` clean
- [ ] `npm test` all green (offline + integration)
- [ ] Live tests pass:
      `WARMUP_LIVE_TEST=1 WARMUP_USERNAME=… WARMUP_PASSWORD=… npm test`
- [ ] Working git SHA noted for rollback: `_______________`

## 1. Install on the Homebridge host

```bash
sudo npm install -g github:nookied/homebridge-warmup4ie#<sha>
sudo systemctl restart homebridge   # or: hb-service restart
sudo journalctl -u homebridge -f --since '1 minute ago'
```

- [ ] No errors during plugin load (`Loaded plugin: homebridge-warmup4ie-v2@<version>`)
- [ ] `[WarmUP] Logging into warmup4ie...` followed by `[WarmUP] Found N room(s)` — N matches the Warmup app
- [ ] One `[WarmUP] Adding <name>` line per room
- [ ] No `Warmup API:` or `Warmup HTTP` errors in the first minute
- [ ] No `TypeError`, `ReferenceError`, unhandled promise rejection

## 2. Smoke (Home app)

Open the iOS Home app:

- [ ] All N thermostat tiles appear in the room they were assigned to
- [ ] Each tile shows current temperature within ±0.5 °C of the physical thermostat display
- [ ] Each tile shows the correct target temperature
- [ ] Tap a tile to open it: target/current temperatures, mode buttons all visible
- [ ] The paired `<name> Air` temperature sensor shows the air-temp probe value

## 3. Control — single room (do these for ONE room first)

- [ ] **Drag target temperature slider** → Warmup mobile app shows "Override" active for `duration` minutes
- [ ] **Wait `duration` minutes** → override expires; physical thermostat returns to schedule
      *(or: shorten `duration` to 1 minute in `config.json` for the test, then restore)*
- [ ] **Tap Off button** → physical thermostat display goes "OFF"; floor heating stops
- [ ] **Tap Heat button** → physical thermostat resumes program; runs the schedule
- [ ] **Tap Auto button** → same as Heat (both resume program)

## 4. Control — multi-room (skip if you only have one room)

Documented behaviour: tapping Off on **any** room turns the whole location off. This is the Warmup API contract; not a plugin bug.

- [ ] Tap Off on any room → ALL rooms in HomeKit show "Off" within 1 polling cycle (`refresh` seconds)
- [ ] Physical thermostats in other rooms also show "OFF"
- [ ] Tap Heat on any one room → that room resumes program; others still off
- [ ] Tap Heat on each remaining room → schedule resumes for each

## 5. Regression sentinels (must verify each release)

These are the bugs that broke the original plugin at 0.1.0–0.1.1. Verify they stay fixed:

- [ ] **Off command actually stops heating** (was silently rejected by API in 0.1.0–0.1.1) — confirm physical thermostat display goes "OFF" and floor stops heating
- [ ] **60-minute override expires at 60 minutes wall-clock** (was UTC-shifted in 0.1.0–0.1.1) — set a 5-minute override, wait 5 minutes by your local clock, confirm it expires *(or: pick a smaller duration to verify quickly)*
- [ ] **API errors surface to HomeKit** as "Not Responding" — to test, edit `config.json` to use bad credentials, restart, observe "Not Responding" tiles instead of zombie ones

## 6. Edge cases

- [ ] **Internet drop**: disable internet on the Homebridge host for 2 minutes, observe `Warmup network error` log lines (no crash, no zombie callbacks). Re-enable; next poll succeeds, tiles update.
- [ ] **Homebridge restart**: `sudo systemctl restart homebridge`; all rooms re-appear in HomeKit without re-pairing.
- [ ] **Rapid taps**: tap Off → Heat → Off → Heat in rapid succession (< 2 sec); each call should succeed or fail gracefully (no double-callback / no orphaned override).
- [ ] **Stale warmup4ie-v1 install**: if upgrading from `homebridge-warmup4ie@0.1.x`, confirm there are no duplicate accessory tiles. If duplicated, clear via Homebridge UI → Settings → Remove Single Cached Accessory.

## 7. Rollback test (do once, not per release)

- [ ] Verify `sudo npm install -g github:nookied/homebridge-warmup4ie#<previous-sha>` works
- [ ] After rollback, confirm previous version's behaviour returns
- [ ] Document the previous-good SHA in the GitHub Release notes

---

## Sign-off

- [ ] All sections passed
- [ ] Date / tester / version: `_____________________________________________`
- [ ] Tag created: `git tag v<version>` and `git push --follow-tags` triggered the publish workflow
- [ ] npm package visible at https://www.npmjs.com/package/homebridge-warmup4ie-v2 with the new version
- [ ] GitHub Release published

If any item failed, do **not** tag. File an issue in the repo, fix on the branch, re-run the suite, and try again.
