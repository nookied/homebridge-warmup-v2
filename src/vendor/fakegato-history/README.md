# Vendored: `fakegato-history`

Upstream: <https://github.com/simont77/fakegato-history> v0.6.7
Licence: MIT, © 2017 simont77 — see [`LICENSE`](./LICENSE)

This is a copy, not a rewrite. It provides the Eve.app history graphs for each
thermostat.

## Why it is vendored

`fakegato-history` declares `googleapis` as a hard dependency for a Google
Drive storage backend, and required it at module load. This plugin only ever
uses `storage: 'fs'`, so that cost was pure overhead:

| | as an npm dependency | vendored |
|---|---|---|
| `node_modules` | ~207 MB of `googleapis` | none |
| RSS on require | ~115 MB | ~4 MB |
| startup | ~800 ms | ~3 ms |
| runtime deps pulled in | `googleapis`, `debug` | none — Node builtins only |

The fix upstream is about five lines, but there is no way to deliver a
dependency fix to end users without either changing someone else's package or
publishing our own. Vendoring keeps everything in this repository.

## Changes from upstream

Kept minimal on purpose, so this remains auditable against the original:

1. `fakegato-storage.js` — Google Drive backend removed: the top-level
   `require('./lib/googleDrive')` and the four `case 'googleDrive':` branches
   in `addWriter`, `write`, `read` and `remove`. `storage: 'fs'` is the only
   supported mode, which is all this plugin ever passes.
2. `lib/googleDrive.js` is not vendored.
3. A provenance header at the top of each file.
4. One stale comment corrected to say `'fs' only`.

Nothing else is edited.

## If you need to re-sync with upstream

Upstream last published 0.6.7 on 2025-03-24 and its only open PR has sat since
2025-07-20, so this is unlikely to be needed. If it ever is: diff against the
published tarball, reapply the four changes above, and check nothing new
requires `googleapis`.

`npm run lint` skips this directory — it is third-party code kept close to the
original, and reformatting it to our rules would defeat the point.
