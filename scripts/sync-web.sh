#!/usr/bin/env bash
# Re-vendor the Jarvis web front-end (read-only source) into vendor/web and write vendor/manifest.json.
# Usage: scripts/sync-web.sh [path/to/project-jarvis]   (default ~/Documents/Projects/project-jarvis)
set -euo pipefail
SRC_ROOT="${1:-$HOME/Documents/Projects/project-jarvis}"
SRC="$SRC_ROOT/clients/web"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DST="$HERE/vendor/web"
[ -f "$SRC/index.html" ] || { echo "no web client at $SRC" >&2; exit 1; }
rm -rf "$DST"; mkdir -p "$DST"
cp -a "$SRC/." "$DST/"                       # read-only on the source side
COMMIT="$(git -C "$SRC_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git -C "$SRC_ROOT" status --porcelain -- clients/web 2>/dev/null | wc -l | tr -d ' ')"
VER="$(grep -m1 '^VERSION' "$SRC_ROOT/server/jarvis/gateway/app.py" 2>/dev/null | sed 's/.*"\(.*\)".*/\1/' || true)"
node "$HERE/scripts/write-manifest.js" "$DST" "$HERE/vendor/manifest.json" "$COMMIT" "${VER:-unknown}" "$DIRTY"
# the desktop patch layer (cards, full screen): vendor/manifest.json above stays the PRISTINE source; patches/apply.js writes vendor/patched.json
node "$HERE/patches/apply.js" "$DST" || { echo "re-vendor done, but the desktop patch no longer applies: update patches/apply.js (see patches/README.md)" >&2; exit 1; }
echo "vendored $(find "$DST" -type f | wc -l) files from $SRC (commit $COMMIT, uncommitted changes under clients/web: $DIRTY)"
