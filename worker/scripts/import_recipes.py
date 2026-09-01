#!/usr/bin/env python3
"""Import what each product is made from, from the kitchen's batching system.

The recipes already exist and are maintained daily: twenty-four products with
ingredient targets and a shelf life. Retyping them here would introduce errors
into the one thing a batch is checked against, so they are imported.

Matching is by name, after normalising case and spacing only. A recipe line
naming something the catalog does not have is reported and the whole recipe is
skipped, never imported with a hole in it: a recipe missing an ingredient
would let a batch complete looking complete while an ingredient nobody
recorded went into the pot.

Usage:
    python3 scripts/import_recipes.py [--api http://localhost:8799]
                                      [--out scripts/recipes.sql]
                                      [--report scripts/recipe-import-report.txt]
"""

import argparse
import json
import pathlib
import sys
import urllib.request

SOURCE = "https://forms.deanops.uk/api/batching?action=getProducts"

# Names the batching system and the catalog spell differently. Only exact
# same-thing pairs belong here, and each is one somebody has checked — a
# fuzzy match would put the wrong ingredient in a recipe, which is worse than
# a recipe that will not import.
ALIASES = {
    "spring onions": "Spring Onion",
    # A brand, not a different product (Dean, 2026-09-01).
    "kikkoman": "Japanese Soy Sauce",
}

# The kitchen states shelf life in months. Thirty days a month is the kitchen's
# own arithmetic rather than a calendar month, and it is stated here so a
# use-by can be checked rather than trusted.
DAYS_PER_MONTH = 30

# The same two conversions the Worker applies without evidence, kept in step
# with src/ledger/units.js: one unit spelled two ways, and the metric
# prefixes. Anything else is a fact about the item and belongs in the
# conversions master.
SPELLINGS = {
    "l": "L", "litre": "L", "litres": "L", "liter": "L", "liters": "L",
    "kg": "kg", "kgs": "kg", "kilo": "kg", "kilos": "kg",
    "g": "g", "gram": "g", "grams": "g",
    "ml": "ml", "millilitre": "ml", "millilitres": "ml",
    "unit": "Units", "units": "Units",
    "case": "case", "cases": "case", "item": "item", "items": "item",
}
METRIC = {("g", "kg"), ("kg", "g"), ("ml", "L"), ("L", "ml")}


def canonical_unit(unit):
    return SPELLINGS.get(str(unit).strip().lower(), str(unit).strip())


def normalise(name):
    return " ".join(str(name).split()).strip().lower()


# The batching site refuses a request with no user agent, so one is set. It
# names what this is rather than impersonating a browser.
USER_AGENT = "trace-recipe-import (one-off copy into the trace catalog)"


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def sql_str(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def sql_num(value):
    return "NULL" if value is None else str(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default="http://localhost:8799")
    parser.add_argument("--out", default="scripts/recipes.sql")
    parser.add_argument("--report", default="scripts/recipe-import-report.txt")
    parser.add_argument("--overrides", default="scripts/recipe-overrides.json")
    args = parser.parse_args()

    try:
        items = fetch(f"{args.api}/api/catalog?action=items&active=all")["rows"]
    except Exception as error:  # noqa: BLE001
        sys.exit(f"could not read the trace catalog from {args.api}: {error}")

    by_name = {normalise(item["name"]): item for item in items}

    def find(name):
        return by_name.get(normalise(ALIASES.get(normalise(name), name)))

    products = fetch(SOURCE)["products"]

    # Recipes the batching system does not carry, stated by the kitchen
    # directly. Applied as though they had come from upstream, so a recipe is
    # imported whole or not at all whichever source it came from.
    overrides_path = pathlib.Path(args.overrides)
    stated = json.loads(overrides_path.read_text()) if overrides_path.exists() else {}
    provenance = f"{stated.get('recorded_by')}, {stated.get('recorded_on')}"
    for name, recipe in (stated.get("recipes") or {}).items():
        if name.startswith("_"):
            continue
        products.append({
            "name": name,
            "shelfLifeMonths": None,
            "shelf_life_days": recipe.get("shelf_life_days"),
            "note": f"{recipe.get('note')} (stated by {provenance})",
            "ingredientTargets": [
                {"name": line["item"], "qty": line["quantity"], "unit": line["unit"]}
                for line in recipe["lines"]
            ],
        })

    imported, skipped, no_recipe, missing_items = [], [], [], {}
    unconvertible = {}

    lines = [
        "-- What each product is made from.",
        "-- Generated by scripts/import_recipes.py from the kitchen's batching system.",
        "-- Do not edit: re-run the importer instead.",
        "",
    ]

    for product in sorted(products, key=lambda p: p["name"]):
        item = find(product["name"])
        targets = product.get("ingredientTargets") or []

        if not item:
            skipped.append(f"{product['name']} — no catalog item of that name")
            continue
        if not targets:
            no_recipe.append(product["name"])
            continue

        resolved, absent = [], []
        for target in targets:
            line_item = find(target["name"])
            if line_item:
                resolved.append((line_item, target))
            else:
                absent.append(target["name"])
                missing_items.setdefault(target["name"], []).append(product["name"])

        if absent:
            skipped.append(f"{product['name']} — needs {', '.join(sorted(set(absent)))}")
            continue

        months = product.get("shelfLifeMonths")
        days = product.get("shelf_life_days") or (months * DAYS_PER_MONTH if months else None)
        note = product.get("note") or (f"{months} months, as the kitchen states it" if months else None)
        recipe_id = f"recipe:{item['id']}"
        lines.append(
            f"INSERT INTO recipes (id, item_id, shelf_life_days, note) VALUES "
            f"({sql_str(recipe_id)}, {sql_str(item['id'])}, {sql_num(days)}, {sql_str(note)})\n"
            "  ON CONFLICT (item_id) DO UPDATE SET "
            "shelf_life_days = excluded.shelf_life_days, note = excluded.note, "
            "updated_at = datetime('now');"
        )
        # Replaced rather than merged: a line dropped from a recipe upstream
        # must disappear here too, or a batch would go on being checked
        # against an ingredient the recipe no longer calls for.
        lines.append(f"DELETE FROM recipe_lines WHERE recipe_id = {sql_str(recipe_id)};")
        for order, (line_item, target) in enumerate(resolved, 1):
            line_id = f"{recipe_id}:{line_item['id']}"
            lines.append(
                "INSERT INTO recipe_lines (id, recipe_id, item_id, quantity, unit, sort_order, note) "
                f"VALUES ({sql_str(line_id)}, {sql_str(recipe_id)}, {sql_str(line_item['id'])}, "
                f"{sql_num(float(target['qty']))}, {sql_str(target['unit'])}, {order}, "
                f"{sql_str(target.get('note'))});"
            )

            # A line stated in a unit the conversions master cannot reach from
            # the item's base unit cannot be checked against what was actually
            # used. Reported rather than converted by assumption: turning
            # grams of soy sauce into litres needs a density, and inventing
            # one is how a recipe quietly stops adding up.
            stated = canonical_unit(target["unit"])
            base = canonical_unit(line_item["base_unit"])
            if stated != base and (stated, base) not in METRIC and stated not in {"case", "item"}:
                unconvertible.setdefault(
                    f"{line_item['name']} — recipe says {target['unit']}, catalog counts {line_item['base_unit']}",
                    [],
                ).append(product["name"])
        imported.append(
            f"{product['name']} — {len(resolved)} ingredients, "
            + (f"{days} days" if days else "no shelf life stated")
        )

    pathlib.Path(args.out).write_text("\n".join(lines) + "\n")

    report = [f"{len(imported)} of {len(products)} recipes imported -> {args.out}", ""]
    if missing_items:
        report += [
            f"Ingredients a recipe names that the catalog does not have ({len(missing_items)})",
            "  Every recipe using one of these is skipped whole. A recipe imported without",
            "  an ingredient would let a batch look complete while something nobody",
            "  recorded went into the pot.",
            "",
        ] + [f"  - {name}  (in {', '.join(where)})" for name, where in sorted(missing_items.items())] + [""]
    if unconvertible:
        report += [
            f"Recipe lines stated in a unit the catalog cannot convert ({len(unconvertible)})",
            "  Imported as stated, because the recipe on the wall is what staff follow. But",
            "  until the conversions master can reach the item's base unit, what was used",
            "  cannot be checked against what the recipe asked for.",
            "",
        ] + [f"  - {name}  (in {', '.join(sorted(set(where)))})" for name, where in sorted(unconvertible.items())] + [""]
    if skipped:
        report += [f"Recipes not imported ({len(skipped)})"] + [f"  - {entry}" for entry in skipped] + [""]
    if no_recipe:
        report += [
            f"Products with no recipe in the batching system ({len(no_recipe)})",
            "  Nothing to import. They cannot be batched through a recipe until somebody",
            "  writes one.",
            "",
        ] + [f"  - {name}" for name in no_recipe] + [""]
    report += ["Imported"] + [f"  - {entry}" for entry in imported]

    text = "\n".join(report) + "\n"
    pathlib.Path(args.report).write_text(text)
    print(text)


if __name__ == "__main__":
    main()
