#!/usr/bin/env python3
"""Copy the kitchen's ingredient photographs into the trace repo.

The old system already holds a photograph of every ingredient, taken by the
kitchen, and staff recognise their stock by those pictures far faster than by
reading a name off a list. There is no reason to make them take them again.

What this does NOT do is depend on the old system at run time. The photographs
are downloaded once, resized to a thumbnail and committed here, so the intake
form serves them from its own origin and works with no network. That keeps the
rule in PLAN.md intact: the old stack is a frozen archive, not a live
dependency.

Matching is by item id. The two catalogs share ids because both were built
from the same workbook, so a photograph lands on the item it was taken of and
nothing is matched by guessing at a name. An item with no photograph gets none
— the form shows its name on a plain tile rather than a stand-in picture of
something else.

Usage:
    python3 scripts/import_photos.py [--api http://localhost:8799]
                                     [--out public/photos]
                                     [--report scripts/photo-import-report.txt]

The trace API must be reachable (`npm run dev` is enough) so the script knows
which items exist.
"""

import argparse
import json
import pathlib
import subprocess
import sys
import urllib.request

# Where the old system keeps them. Two forms appear in its catalog: a path
# relative to the forms site, and an absolute URL that redirects to the
# original upload.
SOURCE_CATALOG = "https://batching-api.waiyandean.workers.dev/catalog?action=getIngredients"
FORMS_ORIGIN = "https://forms.deanops.uk"

# Big enough to recognise a bag of chicken feet on an iPad, small enough that
# sixty of them cache on the device without complaint.
THUMBNAIL_PX = 320

USER_AGENT = "trace-photo-import (one-off copy into the trace repo)"


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def fetch_json(url):
    return json.loads(fetch(url))


def absolute(photo):
    if photo.startswith("http://") or photo.startswith("https://"):
        return photo
    return FORMS_ORIGIN + photo


def thumbnail(path):
    """Resize in place. sips ships with macOS, so there is no dependency to add."""
    subprocess.run(
        ["sips", "--resampleHeightWidthMax", str(THUMBNAIL_PX), str(path)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default="http://localhost:8799", help="a running trace API")
    parser.add_argument("--out", default="public/photos", help="where the thumbnails are written")
    parser.add_argument("--report", default="scripts/photo-import-report.txt")
    args = parser.parse_args()

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    try:
        items = fetch_json(f"{args.api}/api/catalog?action=items&active=all")["rows"]
    except Exception as error:  # noqa: BLE001 — the message matters more than the type
        sys.exit(f"could not read the trace catalog from {args.api}: {error}")

    ingredients = [item for item in items if item["kind"] == "ingredient"]
    source = {row["id"]: row for row in fetch_json(SOURCE_CATALOG)["ingredients"]}

    copied, missing, failed = [], [], []

    for item in sorted(ingredients, key=lambda row: row["name"]):
        photo = source.get(item["id"], {}).get("photo")
        if not photo:
            missing.append(item["name"])
            continue

        target = out / f"{item['id']}.jpg"
        try:
            target.write_bytes(fetch(absolute(photo)))
            thumbnail(target)
        except Exception as error:  # noqa: BLE001
            target.unlink(missing_ok=True)
            failed.append(f"{item['name']} — {error}")
            continue

        copied.append(f"{item['name']} — {target.stat().st_size // 1024} kB")

    lines = [
        f"{len(copied)} of {len(ingredients)} ingredients have a photograph, "
        f"copied from the kitchen's existing catalog and resized to {THUMBNAIL_PX}px.",
        "",
    ]
    if missing:
        lines += [f"No photograph in the source catalog ({len(missing)})"]
        lines += [f"  - {name}" for name in sorted(missing)]
        lines += [
            "",
            "  These show as a plain named tile. A photograph is worth adding, but a",
            "  stand-in picture of something else would be worse than none.",
            "",
        ]
    if failed:
        lines += [f"Could not be copied ({len(failed)})"] + [f"  - {entry}" for entry in failed] + [""]
    lines += ["Copied"] + [f"  - {entry}" for entry in copied]

    report = "\n".join(lines) + "\n"
    pathlib.Path(args.report).write_text(report)
    print(report)


if __name__ == "__main__":
    main()
