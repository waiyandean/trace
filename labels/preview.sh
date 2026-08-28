#!/bin/sh
# Render a label through Labelary's ZPL engine and save a PNG beside it.
# Labelary runs the real ZPL interpreter, so this catches what a hand-built
# layout checker cannot. Note it starts from clean printer state, so it will
# not reproduce anything caused by settings persisting on the printer itself.
set -eu
SRC="${1:?usage: preview.sh LABEL.zpl [OUT.png]}"
OUT="${2:-${SRC%.zpl}.png}"
DPMM="${DPMM:-8dpmm}"
SIZE="${SIZE:-4x2}"
code=$(curl -s --max-time 30 -X POST --data-binary "@$SRC" \
  "http://api.labelary.com/v1/printers/$DPMM/labels/$SIZE/0/" \
  -o "$OUT" -w "%{http_code}")
[ "$code" = "200" ] || { echo "labelary returned $code:" >&2; cat "$OUT" >&2; exit 1; }
echo "$OUT"
