# macOS build and install (Intel + Apple Silicon, free Apple ID, no developer account)

**Status: configured, NOT built or run by the author (the build machine was Linux; macOS tooling `hdiutil`/`codesign`/`lipo` does not exist there).
The first build on your Mac or in GitHub Actions is the first test.**

## Option A: build on your own Mac
```bash
brew install node            # or install Node 22 from nodejs.org; also: xcode-select --install
git clone <wherever you keep this repo> jarvis-desktop && cd jarvis-desktop   # or copy the folder
./scripts/build-mac.sh
```
Output in `dist/`: `jarvis-desktop-0.1.0-mac-universal.dmg` and `.zip` (one universal binary for Intel and Apple Silicon). The script verifies the ad-hoc signature.

## Option B: GitHub Actions (no Mac needed)
Push this repo to a private GitHub repo, then Actions > build > Run workflow. Download the `jarvis-desktop-mac` artifact (dmg + zip). Runner: `macos-14`.

## Installing
1. Open the dmg, drag **Jarvis Desktop** to Applications.
2. First launch: right-click the app > **Open** > **Open**. (A double-click is blocked: the app is ad-hoc signed, not notarized.)
3. If macOS says the app is "damaged" (it adds a quarantine flag to downloads): `xattr -dr com.apple.quarantine "/Applications/Jarvis Desktop.app"`, then open it.
4. Allow the microphone when prompted (System Settings > Privacy & Security > Microphone). Because the signature is ad-hoc, a rebuilt/updated app may be asked again.
5. The global hotkey on macOS is Cmd+Shift+M. Global shortcuts need no Accessibility permission for `globalShortcut` registration.

## Why ad-hoc
`identity: "-"` in `electron-builder.yml`. Apple Silicon refuses to run code with no valid signature at all; an ad-hoc signature satisfies that without an account. Notarization (silent updates, no right-click) requires the paid Apple Developer Program.
