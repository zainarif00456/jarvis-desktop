# Audio: microphone, speaker and Bluetooth earbuds

## What went wrong (2026-11-19, AIRBUD 550 earbuds)
Connected to the earbuds, Jarvis Desktop could not be heard and could not hear. Verified on the machine:

1. The web client opens the microphone with plain `getUserMedia({audio:true…})` and creates its `AudioContext`s on the default device
   (`vendor/web/js/voice.js`). It never reacts to devices coming or going.
2. When the earbuds connect they become the default source and sink. WirePlumber's `autoswitch-bluetooth-profile` script switches a
   Bluetooth card from A2DP to the call profile (HFP/HSP, `headset-head-unit`, mSBC, 16 kHz mono) as soon as a capture stream is
   linked to the Bluetooth source. The saved choice was `headset-head-unit` (`~/.local/state/wireplumber/bluetooth-autoswitch`).
3. On this computer the call profile carries no audio: the Intel 9460/9560 USB adapter logs `Bluetooth: hci0: urb … submission failed (2)`
   on every HFP connect, a 4 s recording of the Bluetooth source was exactly digital silence (rms 0.0, peak 0), and the HFP sink was
   never scheduled by PipeWire (quantum 0) while a tone was played to it. Both Jarvis streams still showed `[active]`.
4. With the card put into A2DP the same sink became scheduled at once and a 440 Hz tone pushed through the page showed up on the
   sink monitor (rms 0.15, 440 Hz component 0.25; silence before it).
5. After a profile change the page's capture stream stays linked to the old `capture_MONO` of a node that is gone, and nothing in the
   page re-opens it. (Also `wpctl inspect` of the card shows a stale `bluez5.profile = "off"` property while the real active profile
   parameter was `headset-head-unit`; the property is not the active profile.)

Not verified (needs a human): that sound physically comes out of the earbuds, and what the earbuds' own microphone hears in A2DP+laptop mic mode.

## What the desktop shell does now (the server and the vendored web client are unchanged)
`src/preload/audio-shim.js` is injected into the page before any page script runs and wraps two browser APIs:

* `getUserMedia` (audio only): opens the device chosen by the policy below and hands the page a stable stream that comes from a node
  the shim owns. If the real microphone ends, is unplugged or the setting changes, the shim opens a new one and plugs it in; the
  page's track, its mute (`track.enabled`) and its `AudioContext` graph keep working.
* `AudioContext`: every context gets `setSinkId(chosen output)`, re-applied on every `devicechange`.

Policy (Settings → Audio, stored as `audioInput` / `audioOutput`):

| value | microphone | speaker |
|---|---|---|
| `auto` (default) | a non-Bluetooth microphone (the system default one if it is not Bluetooth) | system default |
| `laptop` | non-Bluetooth only | non-Bluetooth only |
| `system` | system default (may flip earbuds into call mode) | system default |
| a device name | that device, or the system default if it is not there | same |

Keeping the microphone off Bluetooth means WirePlumber never switches the earbuds to the call profile, so they stay in A2DP for
listening. Which devices are Bluetooth comes from `pw-dump` (`src/main/audio.js`); without it everything is treated as non-Bluetooth.
The button "Use laptop speakers and mic" sets both to `laptop`.

## The overlay and audio
Moving the page between the window and the overlay does not reload it. Checked live: before, while floating and after returning, both
`AudioContext`s stayed `running`, the track stayed `live`/enabled, the mic frame counter kept rising and the mic level stayed non-zero.
The app's own code never mutes (mute only happens from the page's button, the hotkey or the tray); the log has no mute events.

## Known limit
If something else (another app, `wpctl`) puts the earbuds into the call profile while the system default output is the earbuds, that
output goes to a silent sink on this computer. Choose "Laptop speakers" or switch the card back to A2DP in that case.
