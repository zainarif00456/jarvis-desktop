#!/usr/bin/env bash
# Dev only: test pictures / video / two camera streams for scripts/fake-server.js, in $DEV_ASSETS (default /tmp/jd-assets).
set -euo pipefail
D="${DEV_ASSETS:-/tmp/jd-assets}"; mkdir -p "$D"; cd "$D"
convert -size 1200x800 gradient:'#0a4a6a-#8a2a5a' -gravity center -pointsize 90 -fill white -annotate 0 'IMAGE TWO' img2.png
convert -size 800x1000 plasma:fractal -gravity center -pointsize 80 -fill white -annotate 0 'PORTRAIT' img3.png
convert -size 1600x700 gradient:'#1a6a2a-#caa22a' -gravity center -pointsize 90 -fill white -annotate 0 'WIDE' img4.png
[ -f "$HOME/Pictures/Jarvis/jackets/jackets-all.png" ] && cp "$HOME/Pictures/Jarvis/jackets/jackets-all.png" sheet.png || convert -size 1920x1160 xc:'#223' -fill white -draw 'rectangle 0,1100 1920,1160' sheet.png   # the 4x2 contact sheet that used to be cut off
ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=640x360:rate=15 -t 12 -c:v libx264 -profile:v baseline -level 3.0 -pix_fmt yuv420p -movflags +faststart vid1.mp4
for n in 1 2; do s=testsrc2; [ $n = 2 ] && s=smptehdbars
  ffmpeg -loglevel error -y -f lavfi -i $s=size=640x360:rate=15 -t 60 -c:v libx264 -profile:v baseline -level 3.0 -pix_fmt yuv420p -g 15 -movflags frag_keyframe+empty_moov+default_base_moof cam$n.mp4
  ffmpeg -loglevel error -y -i cam$n.mp4 -frames:v 1 cam$n.jpg
done
echo "assets in $D"
