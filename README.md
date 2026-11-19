# Jarvis Desktop

A desktop client for your Jarvis server. It is the **real Jarvis web UI** (orb, agents, deck, reports, debriefs, cameras, terminals) vendored line for line into Electron, behind a small loopback gateway that handles pairing and the device token. The server is untouched and unchanged: this app is only a client. See `docs/ADAPTATIONS.md`, `docs/AUDIO.md`, `docs/OVERLAY.md`, and `docs/MAC.md`.

## Install
**Linux (x64)**
- AppImage: `chmod +x jarvis-desktop-0.1.0-linux-x86_64.AppImage && ./jarvis-desktop-0.1.0-linux-x86_64.AppImage`
- Debian/Ubuntu/Kali: `sudo apt install ./jarvis-desktop-0.1.0-linux-amd64.deb`, then start "Jarvis Desktop" from the menu.
- If an AppImage will not start with a sandbox error (user namespaces disabled): run it with `--no-sandbox`.

**macOS**: see `docs/MAC.md` (build on your Mac with `scripts/build-mac.sh`, or via GitHub Actions). First open = right-click > Open.
**Windows**: config + CI only (`npm run dist:win`), never run.

## First run: Base URL and pairing
1. Start Jarvis Desktop. The first-run screen asks for the **Base URL**, default `http://localhost:8000`. Press *Test connection*: it checks `/health` and `/api/session`.
2. On the server machine run `jarvis pair` and type the 8-character code into *Pair this device*. (Or just open Jarvis: the web pairing card works too.)
3. *Save and open Jarvis*. The device token is stored with Electron `safeStorage` (macOS Keychain / Windows DPAPI / Linux libsecret); without a keyring it falls back to an encrypted file. Settings shows which. *Forget this device* deletes it.
Reopen Settings any time: menu Jarvis > Settings (Ctrl/Cmd+,), tray > Settings, or click the red "server unreachable" bar.
Remote servers: use `https://...` (or an http address on localhost / LAN / Tailscale). The microphone needs a secure origin; the app always presents the page as `http://127.0.0.1` which Chromium treats as secure.

## Running the Jarvis server in parallel (localhost:8000)
The app does not start the server. In another terminal on the same machine:
```bash
jarvis serve      # or however you normally run it; default http://localhost:8000
```
It binds `127.0.0.1:8000` by default, so only this computer can reach it. For another computer set the server's `JARVIS_HOST` / use Tailscale, then enter that address in Settings. If the server is down, the app shows an "unreachable" state and reconnects automatically (health check every 5 s).

## Hotkeys, tray, extras
| What | How |
|---|---|
| Mute / unmute microphone, from anywhere | **Ctrl+Shift+M** (Cmd+Shift+M on Mac). Change it in Settings. Works only during a call (the web Mute button is disabled otherwise). |
| Same, in the app window | `M` (the web UI's own key) |
| Tray icon | click = show/hide; menu = Mute/Unmute (live state), Always on top, Settings, server status, Quit |
| Always on top | Jarvis menu or tray |
| Close button | hides to the tray, the call keeps running (Settings: turn off to quit instead) |
| Start on login | Settings (starts hidden in the tray) |
| Notifications | the web UI's own approval/briefing notifications fire when the window is hidden; the hotkey shows a small "Microphone muted/live" notice when the app is in the background |
| Settings / reload / devtools | Ctrl/Cmd+, / Ctrl/Cmd+R / Ctrl/Cmd+Shift+I |
Linux: global hotkeys work on **X11**. On Wayland the app asks the desktop portal for shortcuts (unverified); if that fails Settings says so and the tray menu does the same job.

## Troubleshooting
- **"Server unreachable"**: is `jarvis serve` running? `curl http://localhost:8000/health` should print `{"ok":true,...}`. Fix the address in Settings.
- **"answered, but not like a Jarvis server"**: wrong URL, or an ngrok/proxy page in front.
- **Pairing card keeps showing / "not paired"**: the code is one-use and expires after 10 minutes; make a new one with `jarvis pair`. Revoked device: *Forget this device* and pair again. Max 6 attempts per minute.
- **Microphone blocked**: Linux: check the system input device/PipeWire; macOS: System Settings > Privacy & Security > Microphone > enable Jarvis Desktop; then press Retry.
- **Hotkey does nothing**: you must be in a call; the key may be taken by another app (Settings shows an error); on Wayland use the tray.
- **Orb is slow or blank (VM / no GPU)**: launch with `JARVIS_DESKTOP_SWGL=1`, or the UI's own `?orb=classic` fallback. The web quality governor lowers effects automatically.
- **Logs**: `~/.config/Jarvis Desktop/logs/main.log` (Linux), `~/Library/Application Support/Jarvis Desktop/logs/` (Mac). `JARVIS_DESKTOP_DEBUG=1` also logs the page console.
- **Server and UI versions differ** (amber bar): re-vendor, below.

## Keeping the front-end in sync with Jarvis
The UI is a copy in `vendor/web/` plus ONE clearly named patch layer, `patches/` (hologram cards for pictures / videos / cameras, and full screen that really fills the screen; see `patches/README.md`). The web app itself is not changed: when it is fixed upstream, the patch is carried back and `patches/` is deleted. When you change the Jarvis web client:
```bash
scripts/sync-web.sh                  # copies ~/Documents/Projects/project-jarvis/clients/web (read-only), rewrites vendor/manifest.json (pristine hashes), then re-applies patches/apply.js (fails loudly if an anchor moved)
node scripts/check-drift.js          # reports files that differ between source, vendor and manifest (exit 1 on drift)
npm test && npm run dist:linux       # rebuild
git commit -am "re-vendor web UI"
```
Adaptations are never made by hand inside `vendor/web`: they live in `patches/` and `src/`, and `sync-web.sh` re-applies the patch layer, so a re-vendor cannot silently drop them (`check-drift.js` knows the patched files through `vendor/patched.json`). If the server adds a new top-level route family (today: `/api`, `/health`, `/ws`) add it to `PROXIED` in `src/main/gateway.js`.

## Pictures, videos and cameras are hologram cards
Every picture, video and camera feed Jarvis shows (shared files, `screen.show`, `camera.show`) opens as its **own floating card**, styled like the terminal cards (corner brackets, glow, header with pin / minimise / full screen / close), draggable and resizable. Several are open side by side, auto-arranged without overlap; closing one leaves the others; each video plays on its own and each camera card shows its live feed. There is no gallery or swiping. Pictures are always drawn whole (never cropped); wheel / pinch / double click zooms. *Full screen* (the card's button, double click on the title, or "full screen" by voice) fills the whole display, also over other apps; Esc, the button or "exit full screen" brings the card back. Details: `docs/OVERLAY.md`, `patches/README.md`.

## Develop / build
```bash
npm ci
npm start                 # run from source
npm test                  # gateway tests with a fake server (cookie injection, Origin strip, pairing capture, WebSocket)
npm run dist:linux        # dist/*.AppImage + dist/*.deb
node scripts/fake-server.js 8765   # stand-in paired server for UI checks without touching the real server
```
CI: `.github/workflows/build.yml` (Linux, macOS universal ad-hoc, Windows).

## Hologram overlay

Portals, live execution panels, and attention prompts float over other apps while the main window is minimised, hidden to the tray or behind another app. Only the floating windows are drawn (no orb, sidebar or panels); they are arranged without overlap, on a second display when there is one (tool/terminal cards on the primary, presentations/briefings/pictures on the other), and dissolve when the work is done; stuck "working" cards, the static pointer frame and cropped pictures are handled in the shell. Same page, same call, same microphone, no web or server change. Setting: *Hologram overlay*; hide/show hotkey `Ctrl+Shift+H`. How it works, platform limits and the dev command: [docs/OVERLAY.md](docs/OVERLAY.md). Screenshot: `docs/shots/overlay-over-app.png`; side by side with the browser deck: `docs/shots/compare-browser-vs-overlay.png`.

**Audio / Bluetooth earbuds.** Settings → Audio chooses the microphone and speaker (default: a non-Bluetooth microphone, so earbuds stay in their good listening mode; "Use laptop speakers and mic" button). The shell re-attaches the microphone when devices change. Root cause, evidence and limits: [docs/AUDIO.md](docs/AUDIO.md).

## Audit notes (2026-11-19)

Checked on Kali (GNOME, **X11** session, `XDG_SESSION_TYPE=x11`): launch, loopback gateway, global hotkey (Ctrl+Shift+M fired through xdotool under Xvfb and reached the page; outside a call the result is "not in a call"), tests (9 pass). Not verified: a real call, the tray icon in GNOME (needs the AppIndicator extension; without it "close to tray" hides the window with no visible icon, so relaunching the app brings it back), Wayland, macOS and Windows builds.

Hardening added in the audit: malformed URLs no longer crash the gateway, navigation is limited for every window (gateway origin or the settings page only), settings IPC only answers the settings page, the page CSP no longer allows connections to other hosts, "Start on login" now works on Linux (XDG autostart entry), a second launch during startup no longer crashes.

Known gaps: `safeStorage.isEncryptionAvailable` is deprecated in Electron 45 (still works); Electron fuses are not flipped; macOS build is ad-hoc signed and unverified until built on a Mac or by CI.
