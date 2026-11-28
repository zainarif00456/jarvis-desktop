# Karen (Urdu agent) in the desktop app

Karen is a server feature (see `docs/karen-urdu.md` in project-jarvis). The desktop app needs no code of its own for her:

- **Audio.** Her words arrive exactly like everyone else's: 24 kHz 16-bit PCM from the server (the Urdu voice is
  synthesised there), and the microphone is the same 16 kHz stream (the server listens in Urdu while she holds the
  call). Nothing in `src/main/audio.js` or the preload changes.
- **Look.** Her colour (rose), the rosette shape of the neural core, the selector chip and the Settings rows come from the
  vendored web client (`vendor/web`, re-vendored with `scripts/sync-web.sh`).
- **Urdu text.** Urdu appears only on the admin timeline (right-to-left, rendered by Chromium); the orb screen shows
  no transcript. The overlay cards and viewer are unchanged; the patch layer only learned that files she owns show her name.
- **Not verified here:** a real call with her on this app (the server side was exercised with real Deepgram, Edge and
  Claude on a throwaway server; see handoff 60).
