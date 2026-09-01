#!/usr/bin/env python3
"""Flatten the catalog seed into the JSON the label GUI reads.

The GUI runs on the Windows machine attached to the printer, which has no
access to D1 and should not need any. So the catalog is baked into a file at
build time and copied across with the rest of the tool. Re-run this whenever
the importers regenerate the seed:

    python3 build_catalog.py

Source of truth stays `worker/scripts/`. Nothing here decides anything; it
only reshapes what the importers already wrote. Answers the seed cannot give
-- allergens, product SKUs, pack sizes, the health mark -- live in
`label-data.json` beside it, which is maintained by hand.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "worker" / "scripts"
OUT = Path(__file__).resolve().parent / "catalog.json"

# Splitting an INSERT's VALUES list on commas that are not inside a quoted
# string. The seed is generated rather than hand-written, so its quoting is
# uniform and this is enough; it is not a general SQL parser.
FIELD_SPLIT = re.compile(r",(?=(?:[^']*'[^']*')*[^']*$)")


def values(sql, table):
    """Every VALUES tuple for `table`, as lists of Python scalars."""
    out = []
    for body in re.findall(
        rf"INSERT INTO {table} \([^)]*\)\s*VALUES \((.*?)\)\s*\n?\s*ON CONFLICT",
        sql, re.S,
    ):
        row = []
        for cell in FIELD_SPLIT.split(body):
            cell = cell.strip()
            if cell == "NULL":
                row.append(None)
            elif cell.startswith("'"):
                row.append(cell[1:-1].replace("''", "'"))
            elif re.fullmatch(r"-?\d+", cell):
                row.append(int(cell))
            else:
                row.append(float(cell))
        out.append(row)
    return out


def main():
    catalog_sql = (SCRIPTS / "catalog.sql").read_text()
    suppliers_sql = (SCRIPTS / "item-suppliers.sql").read_text()
    overrides = json.loads((SCRIPTS / "catalog-overrides.json").read_text())

    suppliers = {r[0]: r[1] for r in values(catalog_sql, "suppliers")}

    # item_suppliers is written as a one-line INSERT with a different shape
    # from the catalog's multi-line upserts, so it needs its own pattern.
    by_item = {}
    for m in re.finditer(
        r"INSERT INTO item_suppliers \([^)]*\) VALUES \('([^']+)', '([^']+)'",
        suppliers_sql,
    ):
        by_item.setdefault(m.group(1), []).append(suppliers.get(m.group(2), m.group(2)))

    # Pack sizes are keyed by name in the overrides file, which is how a person
    # wrote them; the GUI wants them keyed the same way it looks items up.
    packs = overrides.get("pack_sizes", {}).get("items", {})

    items = []
    for row in values(catalog_sql, "items"):
        (item_id, name, kind, base_unit, storage_unopened, storage_opened,
         opening_rule, days_after_opening, needs_health_mark, active, note) = row
        if not active:
            continue
        pack = packs.get(name)
        items.append({
            "id": item_id,
            "name": name,
            "kind": kind,
            "base_unit": base_unit,
            "storage_unopened": storage_unopened,
            "storage_opened": storage_opened,
            "opening_rule": opening_rule,
            "days_after_opening": (
                int(days_after_opening) if days_after_opening is not None else None),
            "needs_health_mark": needs_health_mark,
            "suppliers": by_item.get(item_id, []),
            "pack": (
                {"size": pack["size"], "unit": pack["unit"],
                 "per_case": pack.get("per_case"), "kind": pack.get("pack")}
                if pack else None),
        })

    items.sort(key=lambda i: i["name"])
    OUT.write_text(json.dumps({
        "generated_from": "worker/scripts/catalog.sql + item-suppliers.sql",
        "suppliers": sorted(suppliers.values()),
        "items": items,
    }, indent=1) + "\n")

    kinds = {}
    for i in items:
        kinds[i["kind"]] = kinds.get(i["kind"], 0) + 1
    print(f"wrote {OUT.name}: " + ", ".join(f"{n} {k}" for k, n in sorted(kinds.items())))


if __name__ == "__main__":
    main()
