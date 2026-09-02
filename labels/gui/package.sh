#!/bin/sh
# Assemble a self-contained copy of the label GUI in the shared Drive folder,
# which syncs to the Windows machine the printer is attached to.
#
#   ./package.sh
#
# The bundle carries its own photographs, in `static/photos`, so the folder
# runs on a machine that has none of the rest of the repository. That is a
# distribution copy rather than a second source of truth: it is rebuilt from
# `worker/public/photos` every time this runs, and nothing edits it by hand.
#
# Files the tool writes at run time -- the printer settings, the print log --
# are deliberately not copied, in either direction. They belong to the machine
# they were made on, and overwriting the kitchen's printer settings from a
# development machine would be a good way to stop it printing.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
DEST="${1:-$HOME/Library/CloudStorage/GoogleDrive-dean.8.waiyan@gmail.com/.shortcut-targets-by-id/1njVhpIHlKGJrFne-VF2NsZUrKZD_YRSm/Main/test labels/label-gui}"

[ -d "$(dirname "$DEST")" ] || { echo "Drive folder not found: $(dirname "$DEST")" >&2; exit 1; }
mkdir -p "$DEST/static/photos"

# build_catalog.py and import_allergens.py are deliberately left out: they
# read worker/scripts/ and the forms repository, neither of which is on the
# machine at the printer. Shipping a script that can only fail there is worse
# than not shipping it.
for f in server.py zpl.py printers.py check_layouts.py catalog.json \
         label-data.json README.md start.bat update.bat; do
  cp "$HERE/$f" "$DEST/$f"
done
# Everything in static/ except the photographs, which are selected below.
for f in "$HERE"/static/*; do
  [ -d "$f" ] || cp "$f" "$DEST/static/"
done

# The linter lives one directory up and check_layouts.py imports it by path,
# so it travels with the bundle and sits where that import expects it.
cp "$HERE/../lint-zpl.py" "$DEST/lint-zpl.py"
sed 's|HERE.parent / "lint-zpl.py"|HERE / "lint-zpl.py"|' \
    "$HERE/check_layouts.py" > "$DEST/check_layouts.py"

# Photographs. Only the ones the catalog still refers to, so a bundle does not
# accumulate pictures of items that have been retired.
count=0
for id in $(python3 -c "
import json
for item in json.load(open('$HERE/catalog.json'))['items']:
    print(item['id'])
"); do
  if [ -f "$HERE/../../worker/public/photos/$id.jpg" ]; then
    cp "$HERE/../../worker/public/photos/$id.jpg" "$DEST/static/photos/$id.jpg"
    count=$((count + 1))
  fi
done

# Anything left behind by an older bundle. A file that is no longer shipped
# should not keep running at the printer, and a stale script that fails is
# harder to explain than a missing one.
for stale in "$DEST"/*.py "$DEST"/*.txt; do
  [ -e "$stale" ] || continue
  case " server.py zpl.py printers.py check_layouts.py lint-zpl.py " in
    *" $(basename "$stale") "*) ;;
    *) rm "$stale"; echo "  removed stale $(basename "$stale")" ;;
  esac
done

echo "packaged into $DEST"
echo "  $count photographs"
echo "  $(du -sh "$DEST" | cut -f1) total"
