#!/bin/sh
# Write a copy of a label with a given print quantity into the Drive folder,
# where the machine attached to the printer picks it up.
#
#   ./print-copies.sh goods-in.zpl 10
#
# Quantity is ^PQ, which is part of the label format rather than something
# that can be sent alongside it, so it has to be substituted into the file.
set -eu
SRC="${1:?usage: print-copies.sh LABEL.zpl QUANTITY}"
QTY="${2:?usage: print-copies.sh LABEL.zpl QUANTITY}"
case "$QTY" in ''|*[!0-9]*) echo "quantity must be a whole number" >&2; exit 1;; esac

DEST="$HOME/Library/CloudStorage/GoogleDrive-dean.8.waiyan@gmail.com/.shortcut-targets-by-id/1njVhpIHlKGJrFne-VF2NsZUrKZD_YRSm/Main/test labels"
[ -d "$DEST" ] || { echo "Drive folder not found: $DEST" >&2; exit 1; }

OUT="$DEST/$(basename "${SRC%.zpl}")-x$QTY.zpl"
sed "s/^\\^PQ[0-9][0-9]*/^PQ$QTY/" "$SRC" > "$OUT"
grep -q "\\^PQ$QTY" "$OUT" || { echo "no ^PQ line found in $SRC" >&2; exit 1; }
echo "wrote $(basename "$OUT")"
