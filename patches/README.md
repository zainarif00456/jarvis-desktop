# Desktop patch layer for the vendored web client

`vendor/web/` is a copy of `~/Documents/Projects/project-jarvis/clients/web`. Zain's decision (2026-11-20): the server and the web app stay unchanged for now ("we will fix the web app later"), so the two web-side fixes live here, in one place, ready to be carried back to `clients/web` as a single reviewed change and then deleted.

| Fix | Web files touched | Shell side |
|---|---|---|
| **Every picture / video / camera is its own hologram card** (no gallery) | `js/viewer.js` (replaced), `js/cards.js` + `css/cards.css` (new), `js/cameras.js`, `js/screen.js`, `js/deck.js`, `js/workspace/workspace.js` (small edits), `index.html` (css link) | `src/preload/overlay-page.js` reads `data-jd-want` (card shape) |
| **Full screen really fills the screen** | `js/holowin.js` (no HTML fullscreen in the desktop app; `data-jd-full` flag) | `src/preload/app.js`, `src/preload/overlay-page.js`, `src/main/main.js` (window full screen, global Esc while a card is full over other apps) |

## How it is applied
`node patches/apply.js [vendor/web]` copies `patches/web/**` over `vendor/web` and performs the anchored edits listed in `EDITS` (each is skipped when already applied, and the script exits 1 naming the anchor when the web client changed under it). `scripts/sync-web.sh` runs it after every re-vendor, so a sync cannot silently drop the patch. `vendor/manifest.json` stays the hashes of the pristine source; `vendor/patched.json` holds the hashes of the patched files (`scripts/check-drift.js` uses both). `test/patches.test.js` checks idempotence and that everything parses.

## Carrying it back to the web app
Diff `vendor/web` against `clients/web` (`diff -ru ~/Documents/Projects/project-jarvis/clients/web vendor/web`) - that diff IS the patch. Then delete `patches/`, `vendor/patched.json`, the `apply.js` line in `sync-web.sh`, and re-vendor.

## Known limits
- Report media (pictures inside reports) keeps the report's own lightbox; only files / `screen.show` / cameras open as cards.
- The camera card is the old "main screen" view (sound, snapshot, record, ask, remove); the multi-camera wall (strip / grid view) is no longer opened by the deck (the code is still in `cameras.js`).
