# Hologram overlay

The desktop app can float hologram portals, live execution panels and attention prompts **over your other applications** while its window is minimised, hidden to the tray, or behind another app. The orb and voice stage remain in the main window; the floating panels stay under voice control.

## How it works (one page, one call, one microphone)

There is **one** web page: the Jarvis client in a `WebContentsView` (`src/main/main.js`). Its WebSocket, the call, the microphone and the deck state all live in that page and never move.

While the main window is in front, the page sits inside it. When a portal, execution panel, or attention prompt is present **and** the main window is minimised, hidden, or not focused, `src/main/overlay.js` re-parents the same view into a transparent, frameless, always-on-top, non-focusable window that covers the display (the one under the cursor). Nothing is reloaded or recreated. When the floating content clears, the overlay waits about 1.1 s for closing effects to finish, then hides and gives the page back to the main window. Focusing the main window gives it back at once.

The look is the web client's own CSS and code (portal plates, edge light, arcs, fonts, and forming and dissolving effects). The shell injects `src/main/overlay.css` (via `insertCSS`, so the page CSP is untouched) while floating. It hides the voice stage, command console and stale pointer outline, then makes the page background transparent. The server and the web code in project-jarvis are **not** modified.

- `src/preload/app.js` watches the page (read only): whether portals, execution panels, or attention prompts are present, and their clickable rectangles. It reports these to the shell.
- Click-through: the overlay window ignores the mouse everywhere. The shell polls the cursor (33 ms) and lets the window take the mouse only while the cursor is over floating content (or a button pressed there is still down, so drags work). This is used instead of `setShape`, which would clip drawing outside those hit areas, and instead of `forward` because that only exists on macOS and Windows.
- No keyboard focus: the window is `focusable: false` and shown with `showInactive()`. It never takes focus from the app you are typing in. Consequence: Esc / F / typing do not reach portals in the overlay. Use voice, the mouse, or the hide hotkey. Terminals in the overlay show output but cannot be typed into until you bring the main window back.
- Browser full screen (`F`) is refused while floating; a portal fills the overlay page instead (see "Full screen" below).

## Only the floating windows, arranged per display

While floating, the injected CSS hides everything that is not a floating window: the orb and voice stage, sidebar / team panels, command console, the file rail, minimised-window chips, the pointer outline, link lines. Nothing but cards, portals and pop-ups is drawn.

The overlay window covers **all displays** (one page cannot live in two windows). `src/preload/overlay-page.js` (run inside the page, after `src/main/arrange.js`) gives every floating thing its own place, with no overlap:

- **One display**: tool / terminal-command cards stack in a column on the right (more columns to the left if needed); terminals, files, pictures, presentations, briefing / debrief cards and pop-ups fill the rest in rows, shrinking (down to a minimum) before anything would overlap. Only if even that fails are the leftovers cascaded (may overlap; reported as `overflow` in the pure layout).
- **Two or more displays**: tool cards and terminals on the **primary**; presentations, briefings, debriefs, pictures and files on the **other** display(s); what does not fit there spills to the primary. Displays added or removed while floating re-fit the window and re-arrange live (`display-added` / `display-removed` / `display-metrics-changed`).
- A window you drag by its title bar or resize stays where you put it. Leaving the overlay restores the page's own positions.

Finished cards dissolve by themselves (the web client's own timers, a few seconds after the result); the overlay hides about a second after the last floating thing is gone.

## Pictures, videos and cameras: one hologram card each

(Desktop patch layer, `patches/`, because the web client shows files in one gallery portal.) Every picture, video, sound, text / PDF file and every camera feed is its **own card**: a normal portal (`k-file`, `k-camera`) with the title, small buttons (pin, minimise, full screen, close), drag and resize. Cards are separate windows in the page, so everything above applies to them: in the main window the workspace arranges them (orbit / grid / ...), over other apps `overlay-page.js` places them without overlap (shrinking before overlapping, down to 320x200), pictures and videos on the second display when there is one (cameras too). A card tells the layout its natural shape (`data-jd-want`, from the picture / video size) so a wide picture gets a wide card. Pictures use `object-fit: contain` inside the card: nothing is cropped (the old viewer sized the picture with percentages inside an auto-height grid, which cut tall pictures such as the 4x2 jackets sheet at the bottom). **Pin** keeps a card where it is while others are arranged; moving or resizing by hand pins it too. Closing a card leaves the others. "next / previous" opens the neighbouring file as one more card; zoom commands address the card by its id (`file-<id>`; the old id `viewer` means the card in front). Camera cards each run their own live player.

## Full screen

A card's full screen (button, double click on the title bar, `F`, Jarvis's `full_screen`) is page-filling mode in the desktop app (the HTML Fullscreen API is not used: it needs a click and does not work over other apps). The page sets `data-jd-full` on `<html>` while any card is full and the shell follows:

- **Over other apps** (overlay): the card fills the *display it was on* (not the union of all displays), above everything. Before this fix the position the layout had written inline (with `!important`) beat the "full" CSS, so the card stayed ~900x600 while the command was reported done. The page script now gives a full card the display's rectangle and, when it leaves full screen, puts the old place back and the overlay returns to its layout.
- **Esc**: the overlay never has keyboard focus, so while a card is full over other apps the shell grabs `Esc` globally (and hands it to the page) and releases it the moment the card is not full. `exit_full_screen` (voice), the card's full-screen button and the close button also work.
- **In the window**: the Electron window itself goes full screen and returns to its previous state afterwards.

## Things that used to get stuck (fixed in the shell, web code untouched)

The page script has a janitor:

- **A card stuck "WORKING"** (a command interrupted, cancelled, or never reported back by the server: the web client only ends a card on `exec_end`): running cards are dismissed on `turn_interrupted`, `turn_failed`, `session_reset`, 4 s after the session socket closes, and after 3 minutes at the latest. Pinned or hovered cards are left alone. A finished card whose "hovered" flag was lost while the page moved between windows gets its pointer-leave after 25 s so it can dissolve.
- **The big static empty rectangle** ("the square"): Jarvis's pointer outline (`.pt-reticle`, drawn around "this" when it points at something) was never removed when the thing it framed closed. It is cleared when no window or card is left. A stale drag-ghost frame and a panel stuck in its forming effect are cleaned the same way.
- **Pictures in the file rail were cropped** (the pairing-code picture showed a few letters): the rail used `object-fit: cover`; the shell CSS now shows pictures whole (`contain`), in the main window too.

## Settings and hotkeys

- Settings > Desktop > **Hologram overlay** (on by default): off keeps everything inside the main window.
- **Hide / show overlay hotkey**, default `Ctrl+Shift+H` (`Cmd+Shift+H`): hides the overlay instantly and keeps it hidden (the page returns to the main window) until you press it again. Also in the tray menu ("Hologram overlay").
- Mute hotkey `Ctrl+Shift+M` is unchanged and works while the overlay shows.

## Trying it without the real server

```
npm run dev:fake                                   # stand-in server on 8765 (also serves the web client to a browser for comparison)
echo '{"configured":true,"baseUrl":"http://127.0.0.1:8765"}' > /tmp/jd-dev/config.json   # (mkdir /tmp/jd-dev first)
JARVIS_DESKTOP_DEV=1 JARVIS_DESKTOP_USERDATA=/tmp/jd-dev npm start
node scripts/dev-overlay.js /tmp/jd-dev            # minimises the window, then pushes a picture, a terminal and a briefing card
node scripts/dev-overlay.js /tmp/jd-dev clear      # dissolve them
node scripts/dev-overlay.js /tmp/jd-dev state      # overlay state (floating, rects, focus)
node scripts/dev-overlay.js /tmp/jd-dev hotkey     # same as the hide hotkey
```
```
node scripts/dev-overlay.js /tmp/jd-dev exec        # tool cards: a shell command, a Gmail check, a file read, a search (then they end and dissolve)
node scripts/dev-overlay.js /tmp/jd-dev stuck       # a card that never ends (gone after 3 min) ;  ... interrupt  ends it with turn_interrupted
node scripts/dev-overlay.js /tmp/jd-dev displays two|one|real   # pretend a second display (1280x1024 right of the primary), live
node scripts/dev-overlay.js /tmp/jd-dev capture /tmp/x.png      # PNG of the whole page, also the part beyond the real screen
scripts/dev-assets/make-assets.sh                           # test pictures / video / two camera streams for the fake server (/tmp/jd-assets)
FAKE_PORT=8765 node scripts/dev-overlay.js /tmp/jd-dev cards    # 4 pictures, a video, two camera cards (also: single | sheet | full <card id> | unfull <card id>)
```
`JARVIS_DESKTOP_DEV=1` opens a unix socket in the user-data directory (`dev.sock`) that can minimise the window and run JavaScript in the page. It is off in normal use. `MAIN_ACTION=hide|none` and `NO_APP=1` are described in the script header.

## Platform notes (what was and was not tested)

| Platform | Expected | Tested |
|---|---|---|
| Linux X11 (Kali, GNOME/mutter, compositor on) | Transparent, always on top, click-through by cursor polling | **Yes**, one display, over Chrome. A second display was **simulated** (dev `displays`, window 3200 px wide, captured with `capture`); a real second monitor was not attached. |
| Linux X11 without a compositing manager | Transparency shows as black. Turn the overlay off in Settings. | Not tested on a real desktop. |
| Wayland | Limited. A client cannot position itself or stay above other windows, and `screen-saver` level / `showInactive` are advisory. With Electron's XWayland mode (`--ozone-platform=x11`) it behaves like X11; native Wayland may show the overlay as an ordinary window that can take focus or sit behind others. Global hotkeys need the portal. **Fallback**: turn the overlay off; portals then stay in the main window as before (the tray menu and the mute hotkey still work). | **Not tested** (this laptop is X11). |
| Windows | Transparent frameless always-on-top windows are supported; `focusable:false` keeps focus. Same polling click-through. | **Not tested.** |
| macOS (Intel and Apple Silicon) | Window level `screen-saver`, visible on all workspaces and over full-screen apps are set. Transparent windows are supported. | **Not tested** (no Mac available). |

Other limits: a portal larger than its display is shrunk to a minimum size and then clipped; displays with different scale factors are not handled specially; GNOME may animate the overlay window's first appearance.
