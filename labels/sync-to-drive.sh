#!/bin/sh
# Copy the .zpl label files to the shared Drive folder, which is where the
# Windows machine attached to the printer picks them up.
set -eu
DEST="$HOME/Library/CloudStorage/GoogleDrive-dean.8.waiyan@gmail.com/.shortcut-targets-by-id/1njVhpIHlKGJrFne-VF2NsZUrKZD_YRSm/Main/test labels"
[ -d "$DEST" ] || { echo "Drive folder not found: $DEST" >&2; exit 1; }
for f in "$(dirname "$0")"/*.zpl; do
  cp "$f" "$DEST/"
  echo "copied $(basename "$f")"
done
