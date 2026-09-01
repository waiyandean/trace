#!/usr/bin/env python3
"""Build every label format at its worst case and check the layout holds.

This replaces `../stress-test.zpl`, which was one hand-written label carrying
the worst content anybody had thought of. A single file could only ever stress
one of the four formats, and it had to be edited by hand to keep up with them.
Now that the formats are generated, the worst case can be generated too, for
all four, and checked in one command:

    python3 check_layouts.py

Each case is built, then run through ../lint-zpl.py, which reports a bounding
box per element and fails anything that overlaps, runs off the label or breaks
the 40-dot keep-out margin. Warnings the builders raise -- a name too wide for
its line, an allergen declaration that has to wrap -- are shown as well; those
are not layout failures, they are the label telling you the content does not
fit and the catalog is where it gets fixed.

Run this after any change to zpl.py. Text widths are estimated, so a clean run
is a strong signal rather than a proof: render anything that changed shape.
"""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import zpl

_spec = importlib.util.spec_from_file_location("lint_zpl", HERE.parent / "lint-zpl.py")
lint = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lint)

PRODUCER = "AAHQ LTD, 90 Renfield Street, Glasgow"

# The worst content each format has to survive, and a typical one beside it so
# a change that only breaks the ordinary case is caught too. The long values
# are deliberately past anything currently in the catalog: the point is to find
# the edge before a new product does.
CASES = [
    ("goods-in typical", zpl.goods_in, dict(
        name="Chicken Feet", use_by="04/09/2026", batch="270826",
        supplier="Lynas", delivered="27/08/2026", allergens="None declared",
        storage="chill", quantity=10)),
    ("goods-in, no use-by printed", zpl.goods_in, dict(
        name="Toban Djan Chilli Bean Sauce", use_by="", batch="010926",
        supplier="Tazaki", delivered="01/09/2026",
        allergens="Gluten, Soya", storage="ambient", quantity=1)),
    ("goods-in worst", zpl.goods_in, dict(
        name="Sichuan Toban Chilli Bean Sauce", use_by="04/09/2026",
        batch="LOT-270826-A", supplier="Tazaki", delivered="27/08/2026",
        allergens="Gluten, Crustaceans, Sesame, Soya, Egg, Milk, Sulphites",
        storage="freezer", quantity=200)),
    ("date-opened typical", zpl.date_opened, dict(
        name="White Miso", opened="01/09/2026", use_by="13/10/2026",
        batch="270826", allergens="Soya", storage_opened="chill", quantity=1)),
    ("date-opened worst", zpl.date_opened, dict(
        name="Toban Djan Chilli Bean Sauce", opened="01/09/2026",
        use_by="13/10/2026", batch="LOT-270826-A",
        allergens="Gluten, Crustaceans, Sesame, Soya, Egg, Milk, Sulphites",
        storage_opened="freezer", quantity=1)),
    ("packet, no health mark", zpl.product, dict(
        name="Soba Sauce", use_by="28/01/2027", batch="2807GB1",
        packed="28/07/2026", qty="2.5 Litres", sku="BF-SOBA-2K",
        allergens="Celery, Gluten, Sesame, Soya", producer=PRODUCER,
        health_mark=False, quantity=1)),
    ("packet, health mark", zpl.product, dict(
        name="Tonkotsu Broth", use_by="01/07/2027", batch="3107GA1",
        packed="31/07/2026", qty="1.8 Litres", sku="BF-TKBR-2K",
        allergens="Gluten, Fish, Soya", producer=PRODUCER,
        health_mark=True, hm_code="GA 121", quantity=1)),
    ("packet worst", zpl.product, dict(
        name="Spicy Miso Tonkotsu Ramen", use_by="01/07/2027",
        batch="3107GA1", packed="31/07/2026", qty="12 x 1.8 Litres",
        sku="BF-SPMSTKR-12K",
        allergens="Gluten, Fish, Soya, Sesame, Egg, Milk, Crustaceans",
        may_contain="Peanuts", producer=PRODUCER, health_mark=True,
        hm_code="GA 121", quantity=1)),
    ("box worst", zpl.product, dict(
        name="Spicy Miso Tonkotsu Ramen", use_by="01/07/2027",
        batch="3107GA1", packed="31/07/2026", qty="12 x 1.8 Litres",
        sku="BF-SPMSTKR-12K",
        allergens="Gluten, Fish, Soya, Sesame, Egg, Milk, Crustaceans",
        may_contain="Peanuts", producer=PRODUCER, health_mark=True,
        hm_code="GA 121", is_case=True, quantity=1)),
    ("everything empty", zpl.goods_in, dict(
        name="", use_by="", batch="", supplier="", delivered="",
        allergens="", storage=None, quantity=1)),
]


def problems(source):
    """The linter's findings for one label, as a list of strings."""
    pw, ll, elements = lint.parse(source)
    found = []
    margin = lint.MARGIN
    for kind, x, y, w, h in elements:
        if x + w > pw or y + h > ll:
            found.append(f"{kind} at {x},{y} runs past the label")
        elif kind != "box" or (w < pw - 1 or h < ll - 1):
            if x < margin or y < margin or x + w > pw - margin or y + h > ll - margin:
                found.append(f"{kind} at {x},{y} breaks the {margin}-dot margin")
    for i, a in enumerate(elements):
        for b in elements[i + 1:]:
            if a[0] in ("box", "oval") or b[0] in ("box", "oval"):
                if lint._contains(a, b) or lint._contains(b, a):
                    continue
            ox = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
            oy = min(a[2] + a[4], b[2] + b[4]) - max(a[2], b[2])
            if ox > 0 and oy > 0:
                found.append(f"{a[0]} at {a[1]},{a[2]} overlaps "
                             f"{b[0]} at {b[1]},{b[2]} by {ox} x {oy} dots")
    return found


def main():
    failed = 0
    for name, builder, values in CASES:
        source, warnings = builder(**values)
        found = problems(source)
        status = "FAIL" if found else "ok  "
        print(f"  {status}  {name}")
        for line in found:
            print(f"          {line}")
        for line in warnings:
            print(f"          note: {line}")
        failed += bool(found)

    print()
    if failed:
        print(f"{failed} of {len(CASES)} layouts have a problem.")
        sys.exit(1)
    print(f"{len(CASES)} layouts clean. Text widths are estimated -- render "
          f"anything whose shape changed.")


if __name__ == "__main__":
    main()
