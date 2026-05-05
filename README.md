# homebridge-warmup4ie-v2

[![npm](https://img.shields.io/npm/v/homebridge-warmup4ie-v2.svg)](https://www.npmjs.com/package/homebridge-warmup4ie-v2)
[![Apache 2.0](https://img.shields.io/npm/l/homebridge-warmup4ie-v2.svg)](LICENSE)

Homebridge plugin for **[Warmup 4iE](https://www.warmup.com/thermostats/smart/4ie)** underfloor-heating thermostats.

This is a **maintained fork** of [`homebridge-warmup4ie`](https://github.com/NorthernMan54/homebridge-warmup4ie) (NorthernMan54), which became broken at version 0.1.0–0.1.1 in late 2024 and has not been updated since. The original silently rejected the `Off` HomeKit command (location turn-off API was sending the wrong body) and overrode temperatures in UTC instead of local time. This fork restores the working behaviour, replaces the deprecated `request` HTTP library with native `fetch`, and adds a real test suite.

If you have `homebridge-warmup4ie` installed, **uninstall it first** before installing this package — see [Migration](#migration) below.

## Why this fork exists

The 0.1.0 rewrite of the original plugin (PR #7, "Beta 0.1.0 - HB 2.0 support") simplified two wire-format details that the Warmup cloud API silently rejects:

- The `setModes locMode: "off"` body lost five required filler keys (`holEnd`, `holStart`, `holTemp`, `fixedTemp`, `geoMode`). The API responds with `200 OK` + `{status:{result:"error"}}` — the plugin treated that as success, so HomeKit reported "Off" while the thermostats kept heating.
- The override `until` time switched from local-time `HH:MM` to UTC, making boost overrides expire at the wrong wall-clock time.

Both regressions were verified byte-for-byte against the [Python reference implementation](https://github.com/alex-0103/warmup4IE) and fixed in this fork's first release. See [CHANGELOG.md](CHANGELOG.md) for the full restoration story.

## Install

```bash
sudo npm install -g homebridge-warmup4ie-v2
```

Or via the Homebridge UI: search for **homebridge-warmup4ie-v2** in the plugin browser.

To install straight from git instead of npm (e.g. to pin a specific commit):

```bash
sudo npm install -g github:nookied/homebridge-warmup4ie
```

## Configuration

Add a platform entry to your Homebridge `config.json`:

```jsonc
{
  "platforms": [
    {
      "platform": "warmup4ie",
      "name": "WarmUP",
      "username": "you@example.com",
      "password": "your-my.warmup.com-password",
      "refresh": 60,
      "duration": 60
    }
  ]
}
```

| Key | Required | Default | Notes |
|---|---|---|---|
| `platform` | yes | — | Must be exactly `"warmup4ie"` (the platform identifier — same as the original plugin, so existing configs migrate without edits) |
| `name` | yes | — | Display name in Homebridge logs |
| `username` | yes | — | Your my.warmup.com email |
| `password` | yes | — | Your my.warmup.com password |
| `refresh` | no | `60` | API polling interval, seconds |
| `duration` | no | `60` | Override duration, minutes — how long a manual temperature change stays active before the schedule resumes |

## Recommended: enable Child Bridge

The Warmup cloud API is occasionally slow (2–5 s for write operations). Running this plugin in a Homebridge **Child Bridge** isolates it from your other plugins, so a slow Warmup API call can't block the main bridge or affect other accessories.

In the Homebridge UI: **Plugins** tab → click the gear icon on `homebridge-warmup4ie-v2` → **Bridge Settings** → enable **Child Bridge**. Restart when prompted. Each Child Bridge appears as a separate accessory in the Home app and will need its own pairing pin (shown in the UI).

This is optional but recommended for any account with multiple thermostats.

## Behaviour

### Temperature changes
Any temperature change in HomeKit creates a Warmup **override** lasting `duration` minutes. After that, the room returns to whatever schedule was active before.

### Modes
HomeKit thermostats expose four modes; this plugin only uses three:

| HomeKit | Action on Warmup |
|---|---|
| **Off** | Sends `setModes locMode=off` — turns off the **whole location** (see below). Same behaviour as the Warmup mobile app's "Off" button. |
| **Heat** | Resumes the room's program. If the room is already in `fixed` or `override` state, no-op (preserves the override). |
| **Auto** | Resumes the room's program (same as Heat). |
| **Cool** | Not used — Warmup is a heating-only system. |

### Off is location-wide, not per-room
The Warmup cloud API has no per-room hard-off operation — confirmed against the Python reference impl and the mobile app's wire traffic. If you have multiple rooms on one account, tapping "Off" on **any** room turns the whole location off. This is the API contract, not a plugin limitation. If you want a per-room "off" effect, set `Heat` mode and drop the temperature to a frost setpoint (~5°C); the room stops heating until you raise it again.

## Migration

If you're moving from the original `homebridge-warmup4ie`:

```bash
sudo npm uninstall -g homebridge-warmup4ie
sudo npm install -g homebridge-warmup4ie-v2
sudo systemctl restart homebridge   # or: hb-service restart
```

**Your `config.json` does not need changes.** The platform identifier (`"platform": "warmup4ie"`) is unchanged for compatibility — only the npm package name differs.

If accessories appear duplicated after migration, clear Homebridge's cached accessories from the UI (Settings → Remove Single Cached Accessory) for the orphaned ones from the old plugin.

## Troubleshooting

### Plugin won't start, error mentions `fakegato-history`
You're still on `homebridge-warmup4ie@0.0.14` or older. Uninstall it (`sudo npm uninstall -g homebridge-warmup4ie`) and install this fork.

### "Off" doesn't actually stop the heat
On `homebridge-warmup4ie@0.1.0` or `0.1.1`? That version has the broken `setRoomOff` body. Switch to this fork.

### "Not Responding" in Home app after a control action
The Warmup API rejected the call (e.g. invalid credentials, expired token, server error). Check the Homebridge log for `Warmup API: ...` errors. This plugin surfaces API-level errors instead of swallowing them; that's intentional — the original plugin would silently report success.

### Multi-location accounts
This plugin uses the **first** location only (`locations[0].id`). If you have e.g. a primary residence + a holiday home on the same Warmup account, only the first one is exposed. Run a second Homebridge instance/child bridge with a different account to expose the other location.

### Live API debugging
```bash
DEBUG=warmup4ie* sudo -E systemctl restart homebridge
sudo journalctl -u homebridge -f
```

## Development

```bash
git clone https://github.com/nookied/homebridge-warmup4ie.git
cd homebridge-warmup4ie
npm install
npm run lint                  # ESLint
npm test                      # Jest — unit + integration (no network)
npm run watch                 # Run plugin against test/hbConfig sandbox

WARMUP_LIVE_TEST=1 \
WARMUP_USERNAME=you@example.com \
WARMUP_PASSWORD=... \
  npm test                    # Adds the live-API test suite
```

See [QA_TESTS.md](QA_TESTS.md) for the manual pre-release checklist.

## Versioning

This fork starts at **2.0.0** as a tribute to the original v1 lineage. From here, the fork follows [Semantic Versioning](https://semver.org/):

| Bump | When |
|---|---|
| **MAJOR** (`X.0.0`) | Breaking change to config keys or HomeKit accessory shape |
| **MINOR** (`X.Y.0`) | New feature (e.g. multi-location config, new HomeKit service) |
| **PATCH** (`X.Y.Z`) | Bug fix, dependency bump, doc-only change |

Releases are tag-driven: `npm version patch && git push --follow-tags` triggers the publish workflow.

## License

[Apache 2.0](LICENSE). Copyright 2019–2024 NorthernMan54 (original) + 2026 Karol Nowacki (this fork). The Apache-2.0 license is preserved from the original.

## Credits

- **NorthernMan54** — original `homebridge-warmup4ie` (2019), the basis for this fork.
- **alex-0103** — [`warmup4IE`](https://github.com/alex-0103/warmup4IE) Python reference implementation, the source of truth for the Warmup cloud API wire format.
