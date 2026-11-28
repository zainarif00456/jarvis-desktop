#!/usr/bin/env bash
# Real-Electron smoke test of Development Mode panes in their own windows: starts a real Jarvis fixture server
# (project-jarvis, temp state, scripted model) and runs scripts/smoke-panewindow.js under a virtual display.
# Needs xfwm4 for title bars (optional). Screenshots land in $SHOTS (default /tmp/panewindow-shots). Needs xvfb-run and ImageMagick's `import` for the screen shots.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="${JARVIS_REPO:-$HOME/Documents/Projects/project-jarvis}"
PY="${JARVIS_PYTHON:-$HOME/miniconda3/envs/jarvis/bin/python}"
LOG="$(mktemp)"
(cd "$SERVER" && "$PY" -m tests.support.serve_dev_fixture 300 >"$LOG" 2>&1) &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do grep -q '^{' "$LOG" && break; sleep 1; done
# a window manager gives the windows real title bars (and lets minimise / maximise happen); without one those two checks are skipped
if command -v xfwm4 >/dev/null; then WM='xfwm4 --compositor=off >/dev/null 2>&1 & sleep 2; export SMOKE_WM=1;'; else WM=''; fi
JARVIS_FIXTURE="$(grep '^{' "$LOG")" xvfb-run -a -s "-screen 0 1920x1080x24" bash -c "$WM exec npx --prefix '$HERE' electron --no-sandbox '$HERE/scripts/smoke-panewindow.js'"
