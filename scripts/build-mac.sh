#!/usr/bin/env bash
# Build Jarvis Desktop on a Mac: universal (Intel + Apple Silicon) .dmg and .zip, ad-hoc signed.
# No Apple Developer account needed. Run from anywhere:   ./scripts/build-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname)" = "Darwin" ] || { echo "This script must run on macOS (dmg/codesign only exist there)." >&2; exit 1; }
command -v node >/dev/null || { echo "Install Node 20+ first:  brew install node   (or https://nodejs.org)" >&2; exit 1; }
command -v codesign >/dev/null || { echo "Install Xcode command line tools:  xcode-select --install" >&2; exit 1; }
echo "node $(node -v), npm $(npm -v), arch $(uname -m)"
npm ci
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg zip --universal
APP="$(ls -d dist/mac-universal/*.app 2>/dev/null | head -1 || true)"
if [ -n "$APP" ]; then
  echo "--- signature check"; codesign --verify --deep --strict "$APP" && echo "ad-hoc signature valid"; codesign -dv "$APP" 2>&1 | grep -E "Signature|Identifier" || true
fi
echo; ls -lh dist/*.dmg dist/*.zip
cat <<MSG

Install:
  1. Open the .dmg, drag "Jarvis Desktop" to Applications.
  2. First launch only: right-click the app > Open > Open  (a normal double-click is blocked because the app is not notarized).
     If macOS says the app is "damaged":   xattr -dr com.apple.quarantine "/Applications/Jarvis Desktop.app"
  3. Allow the microphone when asked (System Settings > Privacy & Security > Microphone).
MSG
