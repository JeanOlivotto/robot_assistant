#!/usr/bin/env bash
# Tela de música do robô renderizada no computador → preview.png (4 quadros lado a lado).
set -euo pipefail
cd "$(dirname "$0")"
CORE=../../firmware/main/core
OUT=${OUT:-/tmp}
cc -O1 -std=c11 -Istubs -I"$CORE" -o "$OUT/robo-preview" preview.c "$CORE/gfx.c" "$CORE/face.c" "$CORE/font8x8.c" "$CORE/music_view.c" "$CORE/icons.c" -lm
"$OUT/robo-preview" "$@" > "$OUT/robo-preview.ppm"
python3 topng.py "$OUT/robo-preview.ppm" "${PNG:-preview.png}" 3
echo "${PNG:-preview.png}"
