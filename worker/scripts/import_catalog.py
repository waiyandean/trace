#!/usr/bin/env python3
"""Build the catalog seed SQL from the Weekly Stock Check Records workbook.

The workbook is the live catalog the kitchen already maintains. Three tabs
matter here:

    Ingredients       ID, Name, Storage, MinStock, TrackUnits, UnitLabel,
                      TrackLoose, LooseUnit, Photo
    FinishedProducts  ID, Name, PacketLabel, MinStock, Photo
    map               Sheets Name, Kobas Name, Case Size, Kobas Unit,
                      Items per Case

Nothing is invented. Where the workbook does not answer a question the row is
either left null or skipped, and every such case is listed in the report this
script prints. That report is the point of the script as much as the SQL is:
it is the list of decisions the workbook cannot make for us.

What is derived, and from what evidence:

    id                the workbook's own ID, so a re-import updates a row
                      rather than duplicating it, and ids stay comparable with
                      the old system's records.
    kind              which tab the row came from.
    base_unit         LooseUnit 'g' -> kg, 'ml' -> L; otherwise, where the
                      ingredient is counted in whole units, 'Units'. Finished
                      products are counted in packets, so 'Units'.
    storage_unopened  Dry Store -> ambient, Fridge -> chill, Freezer ->
                      freezer. Not present for products, so left null.
    storage_opened    never present. Always left null.
    needs_health_mark never present. Always left null for products.
    conversions       case -> item from Items per Case, and item -> base unit
                      from the second number of Case Size, which is in the
                      ingredient's loose unit.

Where the workbook cannot answer at all, `scripts/catalog-overrides.json`
carries what the kitchen answered instead, with the date and the person who
said it. Those are decisions, not derivations, which is why they live in a
file somebody can read rather than in this script's logic.

One workbook quirk is handled rather than reported. The Case Size column
sometimes reads `1 x <item size>` against an Items per Case of 6 to 48: the
`1 x` form was written for Kobas, which was set up differently, and it is the
case count that is wrong there, not the item size. Items per Case is therefore
the authority for how many items are in a case, and the Case Size string is
read only for the item size that follows the `x`.

Usage:

    python3 scripts/import_catalog.py <workbook.xlsx> [-o catalog.sql]

Then apply the SQL, local first:

    npx wrangler d1 execute trace --local --file scripts/catalog.sql
"""

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required: pip3 install openpyxl")

STORAGE_FROM_SHEET = {"Dry Store": "ambient", "Fridge": "chill", "Freezer": "freezer"}
BASE_UNIT_FROM_LOOSE = {"g": "kg", "ml": "L"}
# Both loose units are thousandths of their base unit.
PER_BASE_UNIT = 1000.0

CASE_SIZE = re.compile(r"^\s*([\d.]+)\s*x\s*([\d.]+)\s*$")

# Loose units, and how many of them make one base unit.
BASE_PER_LOOSE = {"g": ("kg", 1000.0), "ml": ("L", 1000.0)}

OVERRIDES_PATH = Path(__file__).parent / "catalog-overrides.json"


def load_overrides(path):
    """The kitchen's answers, keyed by item name. Missing file means none."""
    if not path.exists():
        return {}, None
    data = json.loads(path.read_text())
    provenance = f"{data.get('recorded_by', 'unknown')}, {data.get('recorded_on', 'undated')}"
    return data.get("items", {}), provenance


def sql_str(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def sql_num(value):
    return "NULL" if value is None else repr(float(value))


def read_tab(book, name):
    """Rows of a tab as dicts, keyed by its header row, blank rows dropped."""
    sheet = book[name]
    rows = sheet.iter_rows(values_only=True)
    header = [str(cell).strip() if cell is not None else "" for cell in next(rows)]
    out = []
    for row in rows:
        if not any(cell not in (None, "") for cell in row):
            continue
        out.append(dict(zip(header, row)))
    return out


def clean(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


class Report:
    """Everything the workbook could not answer, grouped by question.

    Two kinds of entry. `add` itemises, and is for gaps that differ row by row
    — those are the ones somebody has to work through. `tally` only counts, and
    is for a column the workbook simply does not have, where naming all
    eighty-odd rows would bury the rest of the report.
    """

    def __init__(self, provenance="unrecorded"):
        self.sections = {}
        self.tallies = {}
        self.provenance = provenance

    def add(self, section, line):
        self.sections.setdefault(section, []).append(line)

    def tally(self, section):
        self.tallies[section] = self.tallies.get(section, 0) + 1

    def render(self):
        parts = []
        for section, lines in self.sections.items():
            parts.append(f"{section} ({len(lines)})")
            parts.extend(f"  - {line}" for line in sorted(lines))
            parts.append("")
        for section, count in self.tallies.items():
            parts.append(f"{section}: {count} rows")
        if not parts:
            return "Nothing needed a decision — every row imported complete.\n"
        return "\n".join(parts) + "\n"


def build_items(ingredients, products, overrides, report):
    """One items row per ingredient and per finished product."""
    items = {}

    for row in ingredients:
        name = clean(row.get("Name"))
        item_id = clean(row.get("ID"))
        if not name or not item_id:
            report.add("Rows skipped: no id or no name", f"Ingredients tab: {row!r}")
            continue

        override = overrides.get(name, {})
        loose_unit = clean(row.get("LooseUnit"))
        tracks_units = bool(row.get("TrackUnits"))
        if override.get("base_unit"):
            base_unit = override["base_unit"]
        elif loose_unit in BASE_PER_LOOSE:
            base_unit = BASE_PER_LOOSE[loose_unit][0]
        elif tracks_units:
            base_unit = "Units"
        else:
            report.add(
                "Skipped: no base unit, and no override says what it is",
                f"{name} — needs kg, L or Units in catalog-overrides.json",
            )
            continue
        if loose_unit and loose_unit not in BASE_PER_LOOSE and not override.get("base_unit"):
            report.add(
                "Unrecognised loose unit, treated as unit-counted",
                f"{name} — loose unit {loose_unit!r}",
            )

        storage_sheet = clean(row.get("Storage"))
        storage = STORAGE_FROM_SHEET.get(storage_sheet)
        if storage_sheet and not storage:
            report.add("Unrecognised storage area, left null", f"{name} — {storage_sheet!r}")
        if not storage:
            report.add("No unopened storage, left null", name)

        items[item_id] = {
            "id": item_id,
            "name": name,
            "kind": "ingredient",
            "base_unit": base_unit,
            "storage_unopened": storage,
            "storage_opened": None,
            "needs_health_mark": override.get("needs_health_mark"),
        }
        report.tally("After-opening storage is not in the workbook, left null")
        if override.get("needs_health_mark") is None:
            report.tally("Health mark not yet determined, left null")

    for row in products:
        name = clean(row.get("Name"))
        item_id = clean(row.get("ID"))
        if not name or not item_id:
            report.add("Rows skipped: no id or no name", f"FinishedProducts tab: {row!r}")
            continue
        items[item_id] = {
            "id": item_id,
            "name": name,
            "kind": "product",
            # Products are counted in packets, tubs, bowls or boxes — all whole
            # things, so the base unit is Units whichever label the tab uses.
            "base_unit": "Units",
            "storage_unopened": None,
            "storage_opened": None,
            "needs_health_mark": None,
        }
        override = overrides.get(name, {})
        items[item_id]["needs_health_mark"] = override.get("needs_health_mark")
        report.tally("Products have no storage in the workbook, both columns left null")
        if override.get("needs_health_mark") is None:
            report.tally("Health mark not yet determined, left null")

    return items


def conversion_rows(item, per_case, item_size, item_unit, source):
    """The two hops from a supplier's case down to the item's base unit.

    Returns the rows plus a description of what stopped the second hop, or
    None where nothing did.
    """
    rows = [(f"{item['id']}:case:item", item["id"], "case", "item", float(per_case),
             f"{per_case:g} items per case, from {source}")]

    base_unit = item["base_unit"]
    if base_unit == "Units":
        # One counted thing is one Unit. The item size is in grams or
        # millilitres, which this item is not measured in.
        rows.append((f"{item['id']}:item:Units", item["id"], "item", "Units", 1.0, None))
        return rows, None

    if item_size is None or item_unit not in BASE_PER_LOOSE:
        return rows, "the item size carries no unit the workbook recognises"
    unit_base, per_base = BASE_PER_LOOSE[item_unit]
    if unit_base != base_unit:
        return rows, f"item size is in {item_unit}, but the item is measured in {base_unit}"
    rows.append((
        f"{item['id']}:item:{base_unit}",
        item["id"],
        "item",
        base_unit,
        float(item_size) / per_base,
        f"{item_size:g} {item_unit} per item, from {source}",
    ))
    return rows, None


def build_conversions(mapping, ingredients, items, overrides, report):
    """Case -> item -> base unit, one row per hop.

    Items per Case is the authority for the case count; see the note at the top
    of this file about the workbook's `1 x <size>` Kobas rows.
    """
    by_name = {item["name"]: item for item in items.values()}
    loose_by_name = {clean(r.get("Name")): clean(r.get("LooseUnit")) for r in ingredients}
    conversions = []
    covered = set()

    # Overridden cases first: where the kitchen has stated the case, that is
    # the answer, and the workbook is not consulted for it at all.
    for name, override in overrides.items():
        case = override.get("case")
        item = by_name.get(name)
        if not case:
            continue
        if item is None:
            report.add("Override names an item that is not in the catalog", name)
            continue
        covered.add(name)
        source = f"catalog-overrides.json ({report.provenance})"

        if "case_size" in case:
            # Bulk: a case is a weight, with no countable item inside it.
            unit = case["case_unit"]
            if unit != item["base_unit"]:
                report.add("Override case unit is not the item's base unit", f"{name} — {unit}")
                continue
            conversions.append((
                f"{item['id']}:case:{unit}", item["id"], "case", unit,
                float(case["case_size"]), f"{case['case_size']:g} {unit} per case, from {source}",
            ))
            continue

        rows, problem = conversion_rows(
            item, case["per_case"], case.get("item_size"), case.get("item_unit"), source
        )
        if problem:
            report.add("Override case could not be converted to the base unit", f"{name} — {problem}")
        conversions.extend(rows)

    for row in mapping:
        name = clean(row.get("Sheets Name"))
        if not name or name in covered:
            continue
        item = by_name.get(name)
        if item is None:
            # The map tab also lists a few ingredients no longer in the catalog.
            continue

        case_size = clean(row.get("Case Size"))
        per_case = row.get("Items per Case")
        if not case_size:
            # Expected for finished products: they are made here, not bought
            # in a supplier's case, so there is no case to convert from.
            if item["kind"] == "product":
                report.tally("Products have no case size, so no conversion")
            else:
                report.add("No case size, no conversion written", name)
            continue
        match = CASE_SIZE.match(case_size)
        if not match:
            report.add("Case size not understood, no conversion written", f"{name} — {case_size!r}")
            continue
        if per_case is None:
            report.add("No Items per Case, no conversion written", name)
            continue

        stated_per_case, item_size = float(match.group(1)), float(match.group(2))
        if float(per_case) != stated_per_case:
            report.tally("Case count taken from Items per Case over the workbook's Kobas `1 x` form")

        rows, problem = conversion_rows(
            item, float(per_case), item_size, loose_by_name.get(name),
            f"the workbook's Items per Case and case size {case_size!r}",
        )
        if problem:
            report.add("No item-to-base conversion written", f"{name} — {problem}")
        conversions.extend(rows)

    return conversions


def render_sql(items, conversions, source):
    lines = [
        "-- Catalog seed, generated by scripts/import_catalog.py.",
        f"-- Source: {source}",
        "--",
        "-- Re-running is safe: every statement upserts on the workbook's own id,",
        "-- so a second import updates rows rather than duplicating them. Columns",
        "-- the workbook cannot answer are left null and are not overwritten here.",
        "",
    ]

    lines.append("-- Items")
    for item in sorted(items.values(), key=lambda i: (i["kind"], i["name"])):
        lines.append(
            "INSERT INTO items (id, name, kind, base_unit, storage_unopened, storage_opened, needs_health_mark)\n"
            f"VALUES ({sql_str(item['id'])}, {sql_str(item['name'])}, {sql_str(item['kind'])}, "
            f"{sql_str(item['base_unit'])}, {sql_str(item['storage_unopened'])}, "
            f"{sql_str(item['storage_opened'])}, {'NULL' if item['needs_health_mark'] is None else int(bool(item['needs_health_mark']))})\n"
            "ON CONFLICT (id) DO UPDATE SET\n"
            "  name = excluded.name,\n"
            "  kind = excluded.kind,\n"
            "  base_unit = excluded.base_unit,\n"
            "  storage_unopened = COALESCE(excluded.storage_unopened, items.storage_unopened),\n"
            "  needs_health_mark = COALESCE(excluded.needs_health_mark, items.needs_health_mark),\n"
            "  updated_at = datetime('now');"
        )

    lines.append("")
    lines.append("-- Unit conversions")
    for conv_id, item_id, from_unit, to_unit, factor, note in conversions:
        lines.append(
            "INSERT INTO unit_conversions (id, item_id, from_unit, to_unit, factor, note)\n"
            f"VALUES ({sql_str(conv_id)}, {sql_str(item_id)}, {sql_str(from_unit)}, "
            f"{sql_str(to_unit)}, {sql_num(factor)}, {sql_str(note)})\n"
            "ON CONFLICT (id) DO UPDATE SET\n"
            "  factor = excluded.factor,\n"
            "  note = excluded.note,\n"
            "  updated_at = datetime('now');"
        )

    lines.append("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("-o", "--out", type=Path, default=Path(__file__).parent / "catalog.sql")
    parser.add_argument("--report", type=Path, help="write the report here as well as to stdout")
    parser.add_argument("--overrides", type=Path, default=OVERRIDES_PATH,
                        help="the kitchen's answers to what the workbook cannot say")
    args = parser.parse_args()

    book = openpyxl.load_workbook(args.workbook, read_only=True, data_only=True)
    ingredients = read_tab(book, "Ingredients")
    products = read_tab(book, "FinishedProducts")
    mapping = read_tab(book, "map")

    overrides, provenance = load_overrides(args.overrides)
    report = Report(provenance or "unrecorded")
    items = build_items(ingredients, products, overrides, report)
    conversions = build_conversions(mapping, ingredients, items, overrides, report)

    for name in overrides:
        if name not in {item["name"] for item in items.values()}:
            report.add("Override names an item that is not in the catalog", name)

    args.out.write_text(render_sql(items, conversions, args.workbook.name))

    summary = (
        f"overrides: {args.overrides.name} ({provenance})\n" if provenance else ""
    ) + (
        f"{len(items)} items "
        f"({sum(1 for i in items.values() if i['kind'] == 'ingredient')} ingredients, "
        f"{sum(1 for i in items.values() if i['kind'] == 'product')} products), "
        f"{len(conversions)} conversions -> {args.out}"
    )
    text = report.render()
    print(summary)
    print()
    print(text, end="")
    if args.report:
        args.report.write_text(summary + "\n\n" + text)


if __name__ == "__main__":
    main()
