#!/usr/bin/env python3
"""Fill the allergen declarations in label-data.json from the Allergen Matrix.

The matrix is the kitchen's own compliance document, maintained in the forms
repository and published at

    https://forms.deanops.uk/wiki/html/1.4 Allergen Management/1.4.1 Allergen Matrix

It is the only place an allergen declaration should come from. Nothing here
decides anything: it reads the matrix, maps its codes to the words the label
prints, and writes them in. Items the matrix does not cover stay absent, which
prints "Not recorded" rather than a guess.

    python3 import_allergens.py [path/to/1.4.1 Allergen Matrix.html]

Re-run it whenever the matrix changes. It rewrites only the `allergens` and
`may_contain` maps and leaves the rest of label-data.json alone.

This is the wrong long-term home for the data. Allergens belong in the trace
catalog beside storage and shelf life, so that the goods-in form and the
recipe explosion can see them too, and this file should become an import into
`items` when that column exists. Until then the label GUI is the only thing
that needs them and this keeps the dependency in one place.
"""
import html
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LABEL_DATA = HERE / "label-data.json"
REPORT = HERE / "allergen-import-report.txt"
DEFAULT_MATRIX = (Path.home() / "Repos" / "forms" / "apps" / "wiki" / "html"
                  / "1.4 Allergen Management" / "1.4.1 Allergen Matrix.html")

# The matrix's column codes, and the word each one prints as. These follow the
# names the regulations use rather than the ingredient that carries them: the
# existing artwork printed "Wheat" for GLU, which is narrower than the matrix
# states and would be wrong on a product whose gluten comes from barley.
CODES = {
    "CEL": "Celery", "GLU": "Gluten", "CRU": "Crustaceans", "EGG": "Egg",
    "FIS": "Fish", "LUP": "Lupin", "MLK": "Milk", "MOL": "Molluscs",
    "MUS": "Mustard", "TRN": "Nuts", "PEA": "Peanuts", "SES": "Sesame",
    "SOY": "Soya", "SO2": "Sulphites",
}

# Where the matrix and the catalog name the same thing differently. Each entry
# is a decision somebody made, not a string similarity: an allergen line
# attached to the wrong product is worse than one that says nothing.
#
# A matrix row may feed more than one catalog row. The soup and the frozen
# retail pack of a given ramen are the same recipe in two formats and carry
# the same declaration, so one matrix row covers both (Dean, 2026-09-01).
ALIASES = {
    "Ginger": ["Ginger Root"],
    "Tom Tum Tare": ["Tom Yum Tare"],
    "Green Curry": ["Green Curry Sauce"],
    "Hell Ramen": ["Hell Ramen (Soup)", "Frozen Ramen : Hell Ramen"],
    "Laksa Ramen": ["Laksa Ramen (Soup)", "Frozen Ramen : Laksa Ramen"],
    "Black Garlic Ramen": ["Black Garlic Tonkotsu (Soup)",
                           "Frozen Ramen : Black Garlic"],
    # The frozen line is named for the broth style rather than the soup, so
    # this pairing is the one to re-check if the retail range changes.
    "Chicken Ramen": ["Chicken Ramen (Soup)",
                      "Frozen Ramen : Chicken Tori Paitan"],
}

# Matrix rows for things the kitchen has stopped using (Dean, 2026-09-01).
# Recorded rather than deleted from the matrix, so that a row reappearing is
# visible as a change rather than as something that was always ignored.
RETIRED = {"Dark Soy Sauce", "Mapo Tare"}


def cells(row):
    return [html.unescape(re.sub(r"<[^>]+>", "", c)).strip()
            for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S | re.I)]


def read_matrix(path):
    source = Path(path).read_text(errors="replace")
    source = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", source, flags=re.S | re.I)
    rows = [cells(r) for r in re.findall(r"<tr[^>]*>(.*?)</tr>", source, re.S | re.I)]
    header = rows[0]
    if header[0] != "Item":
        raise SystemExit(f"{path}: first column is {header[0]!r}, expected 'Item'. "
                         f"The matrix layout has changed; check it before trusting this.")

    out = {}
    for row in rows[1:]:
        # The matrix repeats its header between the ingredient and product
        # sections, so the header row appears more than once.
        if len(row) != len(header) or row[0] == "Item":
            continue
        contains, may = [], []
        for code, value in zip(header[1:], row[1:]):
            if value == "Y":
                contains.append(CODES[code])
            elif value == "MC":
                may.append(CODES[code])
        out[row[0]] = (contains, may)
    return out


def main():
    matrix_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_MATRIX
    if not matrix_path.exists():
        raise SystemExit(
            f"Allergen Matrix not found at {matrix_path}.\n"
            f"Pass the path to it, or clone the forms repository beside this one.")

    matrix = read_matrix(matrix_path)
    catalog = json.loads((HERE / "catalog.json").read_text())
    names = {item["name"] for item in catalog["items"]}
    data = json.loads(LABEL_DATA.read_text())

    allergens, may_contain = {}, {}
    matched, unmatched = [], []
    retired = []
    for raw_name, (contains, may) in sorted(matrix.items()):
        if raw_name in RETIRED:
            retired.append(raw_name)
            continue
        targets = [n for n in ALIASES.get(raw_name, [raw_name]) if n in names]
        if not targets:
            unmatched.append(raw_name)
            continue
        for name in targets:
            matched.append(name)
            # An item with no allergens is a determination, not a gap: it is
            # recorded as "None declared" so the label says so, and so that a
            # blank matrix row and an item nobody has assessed stay
            # distinguishable.
            allergens[name] = ", ".join(contains) if contains else "None declared"
            if may:
                may_contain[name] = ", ".join(may)

    data["allergens"] = dict(sorted(allergens.items()))
    data["may_contain"] = dict(sorted(may_contain.items()))
    LABEL_DATA.write_text(json.dumps(data, indent=2) + "\n")

    uncovered = sorted(n for n in names if n not in set(matched))
    report = [
        f"Allergen import from {matrix_path}",
        f"",
        f"{len(matrix)} rows in the matrix, {len(matched)} matched to catalog items.",
        f"{len(may_contain)} carry a 'may contain'.",
        f"",
        f"-- Retired, skipped ({len(retired)})",
        f"   Still in the matrix, no longer used by the kitchen.",
        *(f"     {n}" for n in retired),
        f"",
        f"-- In the matrix, no catalog item ({len(unmatched)})",
        f"   Add an alias in ALIASES once it is decided what each one means.",
        *(f"     {n}" for n in unmatched),
        f"",
        f"-- In the catalog, no matrix row ({len(uncovered)})",
        f"   These print 'Not recorded' until the matrix covers them.",
        *(f"     {n}" for n in uncovered),
    ]
    REPORT.write_text("\n".join(report) + "\n")
    print("\n".join(report[:5]))
    print(f"\nwrote {LABEL_DATA.name} and {REPORT.name}")


if __name__ == "__main__":
    main()
