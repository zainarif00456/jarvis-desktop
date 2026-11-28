# Development Mode: the native browser and panes in their own windows

Development Mode (server feature, see `docs/development-mode.md` in project-jarvis) tests a web frontend with a real browser. In this app that browser is a `WebContentsView` laid over the IDE's browser pane. The server fallback is a headless Playwright browser, used on the phone or when this shell is not the client.

## How it works
- `src/main/devbrowser/index.js` creates the view on first use, in an **isolated in-memory profile** (partition `devbrowser`, no `persist:`): none of your cookies or logins. No permissions, no downloads; popups open in the same view. Pages in it may navigate (it is a browser), unlike the Jarvis page itself.
- `src/main/devbrowser/driver.js` drives the page over the Chrome DevTools Protocol (`webContents.debugger`): open, snapshot (accessibility-style tree with refs, `snapshot.js`), click, type, press, scroll, reload, screenshot, settle, console, network (API bodies kept short), close. Same operations and result shapes as the server's headless backend, so the server's evidence-first QA loop does not care which one answers.
- The Jarvis page calls `window.jarvisBrowser.call(op, args)` (`src/preload/app.js`) after the server sends `browser_cmd`; the answer goes back over the socket as `browser_result`. `setBounds` places the view over the pane; with no pane, or while the hologram overlay floats, the view sits off screen (and keeps rendering). Only the Jarvis page may use the bridge; any other web contents is refused.
- The web client is vendored from the server's `main` branch (`scripts/sync-web.sh`, which re-applies `patches/`). Development Mode was merged into `main` in both repos on 2026-11-28.

## Panes in their own OS windows
Every Development Mode pane (files, code, changes, explain, agents, browser, QA, terminal, actions) can be a real window:
own title bar, minimise, maximise, close, resizable, movable, remembered position and size (`pane-windows.json` in the
app's data folder; a window whose display is gone opens centred on the primary one). The server's layout says which
panes are `window` (voice: "pop the terminal out into its own window", "dock it back"; or the pop-out button); the
Jarvis page asks the shell through `window.jarvisDev.openWindow(pane)` and the shell opens a `BrowserWindow` on
`/dev-window.html?pane=...` through the gateway (same session, so the device token and gateway secret apply).
- `src/main/devwindows/logic.js`: one window per pane, quiet closes (a close the layout asked for is not reported
  back; the owner's own close button is, and the pane is docked again), placement. Pure, tested without Electron.
- `src/main/devwindows/index.js`: the real windows, saved bounds, the IPC (only the Jarvis page may open windows; a pane
  window may only close or full-screen itself). `src/preload/pane.js` is their preload (no browser control).
- The native browser view follows whichever page shows the browser pane: in the main window, or in the browser's
  own window (`devbrowser/index.js`: `host`, `adopt`, `released`). A page that hides its pane does not hide the view
  another page is showing.
- Whole-window full screen: `window.jarvisDev.setFullScreen(on)` (voice "make Jarvis full screen", View menu,
  F11); the shell reports `enter/leave-full-screen` back so the layout flag follows the window's own controls.
- Quitting closes the windows quietly; the layout still says `window`, so they reopen with the app.

![the terminal in its own window](shots/devmode-terminal-window.png)
![the browser in its own window, the real page at full size](shots/devmode-browser-window.png)
The IDE itself (docks, splitters, five buttons on every pane): `shots/devmode-ide-default.png`, `shots/devmode-ide-swapped.png`.

## Verify
- `npm test` (48 tests; `test/devbrowser.test.js` runs the driver against a fake CDP, `test/devwindows.test.js` the pop-out logic).
- Real Electron against a local todo app: `xvfb-run -a npx electron --no-sandbox scripts/smoke-devbrowser.js` (headless) or `npx electron scripts/smoke-devbrowser.js` (a display). 15 checks: snapshot, typing, click with the POST and its response recorded, console errors, PNG screenshot, reload persistence, link navigation, stale ref and script-URL errors, profile isolation, bridge refusal for other pages.

- Real Electron, real server, real windows: `scripts/smoke-panewindow.sh` starts a Jarvis fixture (project-jarvis
  `tests/support/serve_dev_fixture.py`: temp state, scripted model, a git project, Development Mode on) and runs
  `scripts/smoke-panewindow.js` under a virtual display with xfwm4 (real title bars; without a window manager the
  minimise / maximise checks are skipped). It uses the vendored web client behind the real gateway and says the owner's
  own sentences: pops the terminal, files and browser out, clicks a file in the tree window (it opens in the main
  window's code pane), opens a page in the native view and checks the view moved into the browser window at full
  size, docks everything back by voice, closes a window with its own close button, full-screens the whole window.
  17 checks. Screenshots in `$SHOTS` (default `/tmp/panewindow-shots`).

## Known limits
- Minimised window: Chromium may stop painting, so a screenshot can time out (30 s) with a plain error; the server then reports the step `untested`, never `pass`.
- Phone/remote clients have no native view: the server's headless browser answers instead.
- Not verified here: macOS and Windows (Linux, Electron under Xvfb + xfwm4 only); several displays (placement logic is unit-tested, not seen on two real monitors).
- The window layout needs the server with the layout model (restart it once after updating).
