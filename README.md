# homebridge-warmup4ie-v2

[![npm](https://img.shields.io/npm/v/homebridge-warmup4ie-v2.svg)](https://www.npmjs.com/package/homebridge-warmup4ie-v2)
[![Apache 2.0](https://img.shields.io/npm/l/homebridge-warmup4ie-v2.svg)](LICENSE)

Homebridge plugin for **[Warmup Wi-Fi underfloor-heating thermostats](https://www.warmup.com/thermostats)**.

Despite the legacy name (the original plugin was authored in 2019 when the 4iE was Warmup's only smart thermostat), this works with every Warmup Wi-Fi thermostat that connects to the `my.warmup.com` cloud / MyHeating app. See [Supported thermostats](#supported-thermostats) below.

This is a **maintained fork** of [`homebridge-warmup4ie`](https://github.com/NorthernMan54/homebridge-warmup4ie) (NorthernMan54), which became broken at version 0.1.0–0.1.1 in late 2024 and has not been updated since. The original silently rejected the `Off` HomeKit command (location turn-off API was sending the wrong body) and overrode temperatures in UTC instead of local time. This fork restores the working behaviour, replaces the deprecated `request` HTTP library with native `fetch`, and adds a real test suite.

If you have `homebridge-warmup4ie` installed, **uninstall it first** before installing this package — see [Migration](#migration) below.

## Supported thermostats

Anything that pairs with the **MyHeating app** (or signs into [my.warmup.com](https://my.warmup.com)) goes through the same cloud API and is supported:

| Model | Status | Notes |
|---|---|---|
| **[4iE Smart Wi-Fi](https://www.warmup.com/warmupedia/products/4ie-smart-wifi-thermostat)** | Discontinued (replaced by 6iE) | First Warmup Wi-Fi thermostat (~2014). Dual floor probes (`floor1Temp` + `floor2Temp`). |
| **[6iE Smart Wi-Fi](https://www.warmup.com/6ie-smart-wifi)** | Discontinued (replaced by 7iE) | Colour touch screen. Single floor probe. Existing installed units remain supported through MyHeating. |
| **[7iE Smart Matter Wi-Fi](https://www.warmup.com/7ie-smart-matter-wifi-thermostat)** | Active (flagship) | Latest model; supports Matter natively (you may not need this plugin if you pair via Matter). |
| **[Element Wi-Fi](https://www.warmup.co.uk/thermostats/smart/element-wifi-thermostat)** | Active | Touch-button entry-level smart thermostat. |
| **[Terra Wi-Fi](https://www.warmup.com/thermostats/terra-wifi-thermostat)** | Active | Eco-line smart thermostat. |
| Rebadged OEM units | Active | Laticrete, Rointe, Porcelanosa, Equus, Savant — same firmware, same API. |
| **Tempo** (programmable, non-Wi-Fi) | — | **Not supported** — no cloud connectivity. |

The Warmup cloud API uses a single thermostat shape internally (the GraphQL schema's type is named `Thermostat4iE` for legacy reasons). Model-specific features like the 4iE's second floor probe simply return null on single-probe units; the plugin treats them uniformly.

## Why this fork exists

The 0.1.0 rewrite of the original plugin (PR #7, "Beta 0.1.0 - HB 2.0 support") simplified two wire-format details that the Warmup cloud API silently rejects:

- The `setModes locMode: "off"` body lost five required filler keys (`holEnd`, `holStart`, `holTemp`, `fixedTemp`, `geoMode`). The API responds with `200 OK` + `{status:{result:"error"}}` — the plugin treated that as success, so HomeKit reported "Off" while the thermostats kept heating.
- The override `until` time switched from local-time `HH:MM` to UTC, making boost overrides expire at the wrong wall-clock time.

Both regressions were verified byte-for-byte against the [Python reference implementation](https://github.com/alex-0103/warmup4IE) and fixed in this fork's first release. See [CHANGELOG.md](CHANGELOG.md) for the full restoration story.

## Install

**Requires** Node.js 22, 24, or 26 and Homebridge 1.6+ or 2.x. Node 18 and 20
are past end-of-life and Homebridge 2.4 no longer runs on them; if you are
still on one, upgrade Node before installing.

```bash
sudo npm install -g homebridge-warmup4ie-v2
```

Or via the Homebridge UI: search for **homebridge-warmup4ie-v2** in the plugin browser. Works for any model in the [Supported thermostats](#supported-thermostats) table.

To install straight from git instead of npm (e.g. to pin a specific commit):

```bash
sudo npm install -g github:nookied/homebridge-warmup-v2#<sha>
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
| `disableChildLock` | no | `false` | Hide the per-thermostat **Lock** tile. Useful when the model doesn't honour the lock command (Warmup Element Wi-Fi appears to ignore it). Removes any cached lock services on next launch. |
| `disableVacationSwitch` | no | `false` | Hide the location-wide **Vacation Mode** switch. Removes the cached accessory on next launch. |
| `disableFrostSwitch` | no | `false` | Hide the location-wide **Frost Protection** switch. Removes the cached accessory on next launch. |
| `disableHistory` | no | `false` | Turn off the Eve.app history graphs. **Worth enabling if you don't use Eve** — see [Memory use](#memory-use) below; measured at roughly **65 MB of RAM** saved per Homebridge process. No HomeKit characteristic changes either way. |
| `disableAirSensor` | no | `false` | Hide the standalone **"Air"** temperature-sensor tile. See [Which temperature am I looking at?](#which-temperature-am-i-looking-at) — if your thermostat is in **air** mode the tile duplicates the Thermostat exactly and you can safely turn it off; in **floor** mode it is the only place to see air temperature. Removes any cached air-sensor services on next launch. |

### Which temperature am I looking at?

The Thermostat tile's **Current** reading is whatever your device *regulates
on* — which depends on how the thermostat was commissioned:

| Device sensor mode | Thermostat tile shows | The `Air` tile shows |
|---|---|---|
| **Air** | air temperature | the same value — redundant, safe to hide |
| **Floor** | floor temperature | air temperature — the only place to see it |

To find out which mode yours is in, check the thermostat's own settings or the
MyHeating app. The plugin does not currently label the reading — the Warmup
API does expose the answer (`heatingTarget`, and a `mainLabel` per room), so
this is a known gap rather than a limitation.

A device with **no floor probe fitted** reports a placeholder value for the
floor reading, not a real temperature. The plugin never surfaces that field,
so you will not see it.

### Energy graphs may show nothing

If you use Eve.app, the cumulative energy figure comes from Warmup's own
`total` field. On at least one real account that field returns **zero for
every room**, so the graph stays flat regardless of usage. It may require
tariff details to be configured in the MyHeating app first. Nothing in the
plugin can work around it — the number simply is not being reported.

### Memory use

By default this plugin records temperature and heating-state history for
Eve.app, using the standard `fakegato-history` library. That library declares
the **Google APIs client** as a hard dependency and loads it on every start —
for its Google Drive storage backend, which this plugin never uses (history is
always written to disk).

Measured on a Raspberry Pi 5 running the plugin in a child bridge, comparing
settled RSS with the option off and on:

| | history on | `disableHistory: true` |
|---|---|---|
| child-bridge RSS | 172–179 MB | **107–108 MB** |

So roughly **65 MB**, about 38% of the process. It also costs around 194 MB of
disk in `node_modules` and close to a second of startup either way.

There is no way to avoid that from inside this plugin while history is on, and
the library is no longer actively maintained. So if you don't use Eve.app, set:

```json
"disableHistory": true
```

Nothing else changes — every HomeKit control and reading behaves identically,
and any history already written to disk is left untouched, so you can turn it
back on later. On a Raspberry Pi running several plugins, this is usually the
single biggest saving available here.

**A config change only reaches a plugin running in a child bridge after a full
Homebridge restart.** Restarting just the child bridge respawns it from the
config the parent already holds in memory, so the edit appears to do nothing.

## Recommended: enable Child Bridge

The Warmup cloud API is occasionally slow (2–5 s for write operations). Running this plugin in a Homebridge **Child Bridge** isolates it from your other plugins, so a slow Warmup API call can't block the main bridge or affect other accessories.

In the Homebridge UI: **Plugins** tab → click the gear icon on `homebridge-warmup4ie-v2` → **Bridge Settings** → enable **Child Bridge**. Restart when prompted. Each Child Bridge appears as a separate accessory in the Home app and will need its own pairing pin (shown in the UI).

This is optional but recommended for any account with multiple thermostats.

## Behaviour

### Temperature changes
Any temperature change in HomeKit creates a Warmup **override** lasting `duration` minutes. After that, the room returns to whatever schedule was active before.

Slider drags in the Home app are debounced to 300 ms — the plugin sends one API call after you stop, not one per finger movement. As of v3.9 every HomeKit caller waiting on a slider drag resolves cleanly; earlier 3.x versions could leave a HomeKit caller hanging on the spinner if you nudged the slider mid-debounce.

### Modes
HomeKit thermostats expose four modes; this plugin only uses three:

| HomeKit | Action on Warmup |
|---|---|
| **Off** | `deviceOff(lid, rid)` GraphQL mutation — turns off **only that room**, matching the Warmup mobile app's per-room Off button. |
| **Heat** | Resumes the room's program. If the room is already in `fixed` or `override` state, no-op (preserves the override). |
| **Auto** | Resumes the room's program (same as Heat). |
| **Cool** | Not used — Warmup is a heating-only system. |

### Rooms sync without a restart (since v3.12)
Add or delete a room in the MyHeating app and it appears or disappears in
HomeKit within one polling interval — no Homebridge restart needed. Earlier
versions only discovered rooms at startup.

Renaming is the exception: a room renamed in the Warmup app still picks up its
new name on the next restart, not on the next poll. That's deliberate — the
plugin would otherwise overwrite any rename you make in the Home app every 60
seconds.

### Off is per-room (since v3.0)
Tapping Off on one HomeKit thermostat affects only that room. v2 (and the upstream original) used a REST endpoint that turned off the entire location regardless of which room you tapped — v3 switched to the GraphQL transport which exposes a real per-room `deviceOff` operation. If you want the old whole-house off behaviour, build a HomeKit Scene that sets every thermostat to Off at once.

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
This plugin uses the **first** Warmup location returned by the GraphQL `user.owned[]` query. If you have e.g. a primary residence + a holiday home on the same Warmup account, only the first one is exposed. Run a second Homebridge instance/child bridge with a different account to expose the other location.

If you switch the active Warmup account/location after the plugin has run, the Vacation Mode and Frost Protection switches that were created for the previous location are auto-removed at the next reconcile (since v3.9). Earlier versions would leave the old switches lingering in HomeKit until you removed them manually.

### "Wi-Fi Thermostat" shows as the model in Home app
We currently set `Model = "Wi-Fi Thermostat"` because Warmup's cloud payload is still legacy-shaped around `Thermostat4iE` and does not give this plugin a reliable marketing model name for every supported device. A future GraphQL metadata pass may use firmware/device fields where available. If you want the actual model badge today, you can edit the accessory in the Home app.

### `floor2Temp` is always 0 / null on my 6iE / Element / Terra
That's expected — only the 4iE has dual floor probes. Single-probe models return null/zero for the unused channel.

### Child lock tile in HomeKit doesn't actually lock my thermostat
Some models (notably the **Warmup Element Wi-Fi**) accept the `deviceAdvanced.lock` GraphQL mutation but don't actually disable the touch screen. Set `"disableChildLock": true` in your config to hide the lock tile — it'll be removed on next restart. There's no reliable per-model capability flag in the Warmup API yet, so the toggle is opt-out. If your model *does* honour the command, just leave the default.

### I don't want the Vacation Mode / Frost Protection switches in HomeKit
Set `"disableVacationSwitch": true` and/or `"disableFrostSwitch": true` in your config. The cached accessories are unregistered on the next reconcile and disappear from the Home app.

### Live API debugging
```bash
DEBUG=warmup4ie* sudo -E systemctl restart homebridge
sudo journalctl -u homebridge -f
```

## Privacy & data

- Your my.warmup.com **email and password** are kept locally in `config.json` and sent only to `api.warmup.com` (login) and `apil.warmup.com` (data). They never leave your Homebridge host except over TLS to Warmup.
- After login, a per-user **access token** is held in memory (not on disk) and refreshed on 401.
- The `app-token` header value baked into the source (`src/lib/warmup4ie.js`) is the **static token that ships with the Warmup mobile app** — extracted from public traffic captures. It identifies the client to Warmup's gateway; it is not a per-user secret and is the same value every Warmup app installation sends. Its presence in the public repository is intentional and not a credential leak.
- This plugin does not phone home to any third-party telemetry; the only network calls are to Warmup.

## Development

```bash
git clone https://github.com/nookied/homebridge-warmup-v2.git
cd homebridge-warmup-v2
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
