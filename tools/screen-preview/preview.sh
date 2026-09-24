#!/usr/bin/env bash
# Telas do robô renderizadas no computador, sem gravar firmware.
#   ./preview.sh [título] [artista]   → preview.png: modo música, 4 quadros da animação
#   ./preview.sh rosto                → preview.png: tela do rosto, layout antigo × novo
set -euo pipefail
cd "$(dirname "$0")"
CORE=../../firmware/main/core
OUT=${OUT:-/tmp}
LIBS=("$CORE/gfx.c" "$CORE/face.c" "$CORE/font8x8.c" "$CORE/icons.c")
if [[ "${1:-}" == rosto ]]; then
  cc -O1 -std=c11 -Istubs -I"$CORE" -o "$OUT/robo-preview" face_preview.c "${LIBS[@]}" -lm
  "$OUT/robo-preview" > "$OUT/robo-preview.ppm"
else
  cc -O1 -std=c11 -Istubs -I"$CORE" -o "$OUT/robo-preview" preview.c "${LIBS[@]}" "$CORE/music_view.c" -lm
  "$OUT/robo-preview" "$@" > "$OUT/robo-preview.ppm"
fi
python3 topng.py "$OUT/robo-preview.ppm" "${PNG:-preview.png}" 3
echo "${PNG:-preview.png}"
