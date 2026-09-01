# Label GUI

A small web app for printing the labels in the parent directory, run on the
machine the printer is attached to. It exists because trace does not generate
labels yet: today every value on a label is typed into the ZPL by hand, the
file is copied to Drive, downloaded on the Windows machine and sent to the
printer. This replaces that with a form.

It is deliberately an interim tool. When the Worker generates labels from lot
records, this goes away.

```
python server.py          # then http://localhost:8642
```

or double-click `start.bat` on Windows.

A view can be linked to directly — `http://localhost:8642/#goods-in/storage`
is the Goods In list grouped by storage — so the machine at the printer can
sit on the list it actually uses rather than starting from the tiles every
time.

## What it does

Three screens, one decision each.

1. **Which kind of label** — Goods In, Date Opened, Product Packet, Product Box.
2. **Which item** — the catalog, filtered to the items that type applies to.
   Goods In lists the sixty active ingredients; Date Opened lists only the
   fifteen that are used a bit at a time, because a pack that is never partly
   used has nothing to record; the two product types list twenty-five finished
   products.

   Ingredients group two ways, switched with the toggle beside the search box
   and remembered per browser, because the list gets read for two different
   reasons:

   - **By supplier** — how a delivery arrives. One van from one supplier, and
     the twenty-odd things it might be carrying rather than sixty in one
     alphabetical run. Seven ingredients are bought from both and appear under
     both, marked "also Tazaki": at the door it genuinely could be either.
   - **By storage** — how the goods are put away, and the more useful of the
     two when labels are being printed for a shelf rather than at the door.
     Goods In groups on the unopened requirement; Date Opened groups on the
     after-opening one, which is the whole point of that label — several
     things sit on an ambient shelf unopened and must be refrigerated once
     they are not. Storage groups do not overlap.

   Whichever grouping is off duty becomes the line under the name, so the
   other fact is still on the row rather than lost.

   Each row carries the ingredient's **photograph** from the kitchen's own
   catalog. Catalog names are not what is written on the box, and a jar is
   quicker to match by sight than by reading "Toban Djan Chilli Bean Sauce".
   Ten ingredients have no photograph and show an initial instead, which keeps
   the rows the same height. Photographs are served from
   `worker/public/photos`, not copied in here: two copies of the same two
   megabytes would drift apart the first time one was re-imported. Drop a
   `static/photos` directory in and it wins, for a machine that has this tool
   without the rest of the repository.
3. **The label** — a live render of what will print, the fields, how many
   copies, and a Print button.

## No lot codes

Goods In and Date Opened carry no lot short code and no QR, which the
hand-written versions in the parent directory do.

Lots belong to the trace ledger, which is not built yet. A printed code that
resolves to nothing is worse than no code: it looks like traceability and is
not, and it teaches staff that scanning a label achieves nothing. The space
those two fields occupied has gone to the batch number and the dates.

The product labels keep their QR, because it encodes the batch code, which is
real today.

## What can be edited

Batch, the dates and the number of copies are always editable — they change on
every print and no catalog will ever hold them.

Everything else is filled from the catalog and locked. Where the catalog has
no answer, the field is unlocked and outlined, and the item is flagged
**needs filling** in the list. That is a gap to close in the data, not a field
to retype every time; typing into it prints a correct label today without
recording anything.

The gaps as things stand:

| Gap | Where it gets fixed |
| --- | --- |
| Allergens, 13 items the matrix does not cover | the Allergen Matrix |
| Pack size for the four ramen soups | `label-data.json` |
| Case size for Pork Chasiu | `label-data.json` |

## Allergens

They come from the kitchen's own Allergen Matrix, maintained in the `forms`
repository and published at `/wiki/html/1.4 Allergen Management/1.4.1 Allergen
Matrix`. It is the only place a declaration should come from, and nothing here
derives one from an ingredient's name: an allergen line is a compliance
statement, not a naming pattern.

```
python3 import_allergens.py
```

reads the matrix, maps its column codes to the words the label prints, and
fills in `label-data.json`. `allergen-import-report.txt` records what matched
and what did not. Re-run it whenever the matrix changes.

Three things worth knowing about the result:

- **`GLU` prints as "Gluten", not "Wheat".** The hand-written artwork says
  Wheat, which is narrower than the matrix states and would be wrong on a
  product whose gluten comes from barley.
- **Where the matrix names a cross-contact allergen, the label names it** —
  "May contain Peanuts and other allergens". Naming one does not narrow the
  statement: the matrix names the allergens that are known about rather than
  every one that is possible, so the line still ends "and other allergens"
  (Dean, 2026-09-01).
- **A matrix row can feed more than one catalog row.** The soup and the frozen
  retail pack of a given ramen are the same recipe in two formats and carry
  the same declaration, so `Hell Ramen` in the matrix fills in both
  `Hell Ramen (Soup)` and `Frozen Ramen : Hell Ramen`. The pairings are listed
  in the importer's `ALIASES`, each one a decision rather than a string match.
- **Retired rows are named, not ignored.** `Dark Soy Sauce` and `Mapo Tare`
  are still in the matrix and no longer used by the kitchen. They are skipped
  by name, so one of them reappearing in use shows up as a change rather than
  as something that was always being dropped.

The right long-term home for this is the trace catalog, beside storage and
shelf life, where the goods-in form and the recipe explosion can see it too.
`label-data.json` holds it because the label GUI is the only thing that needs
it today.

## Files

| File | What |
| --- | --- |
| `server.py` | The web server and the routes. Standard library only. |
| `zpl.py` | Builds each label format from field values. |
| `printers.py` | Four ways of getting ZPL to a printer. |
| `build_catalog.py` | Regenerates `catalog.json` from `worker/scripts/`. |
| `import_allergens.py` | Fills the allergen declarations in from the Allergen Matrix. |
| `check_layouts.py` | Builds every format at its worst case and lints them. |
| `catalog.json` | The catalog, baked in. Generated — do not edit. |
| `label-data.json` | The answers the catalog cannot give. Edited by hand. |
| `static/` | The page. |
| `start.bat` | Windows launcher. |

`config.json`, `print-log.jsonl` and `printed/` are written at runtime and are
not in the repository.

## Products that get no label

`not_labelled` in `label-data.json` names catalog rows that never get a label
printed, with the reason and who decided. They stay active in the catalog:
this says nothing about whether the kitchen holds the item, only that no label
of ours goes on it. Naming them one at a time is deliberate — a rule that
filtered them automatically would quietly drop a product nobody had looked at.

## Printing

Four routes, chosen on the settings screen.

**`winspool`** is the one to use on Windows. It hands the ZPL to the spooler
by printer name with the datatype set to `RAW`, so the driver passes the bytes
through untouched instead of rendering them as a page of text. It needs no
share, no `\\localhost`, and neither the Server nor the Workstation service —
all of which the `copy /b` route depends on, and one of which has already
failed once on this machine with nothing obviously wrong.

**`share`** is the old route, `copy /b label.zpl \\localhost\ZEBRA`, kept as a
fallback.

**`tcp`** sends to port 9100 and is what everything moves to once the printer
is on the network.

**`folder`** writes the `.zpl` to a directory and prints nothing. It is what
runs on a development machine.

## Preview

The preview is a real render, through Labelary's ZPL interpreter, so it shows
what the printer will draw rather than an approximation. Two things it cannot
show:

- Anything caused by a setting left behind on the printer. Labelary starts
  from clean state. This is why every format here sets `^BY` explicitly — see
  the parent README.
- Anything at all, without the internet. Printing does not depend on it; if
  the render fails, the label is unaffected and the ZPL is shown instead.

## Keeping the catalog current

`catalog.json` is generated. When the importers in `worker/scripts/` are
re-run:

```
python3 build_catalog.py
```

Nothing in this directory decides anything about the catalog. It reshapes what
the importers wrote so the tool can work with no network, which is the
condition it most needs to work in.

## Checking a layout change

```
python3 check_layouts.py
```

Builds all four formats at their worst case — the longest name, the longest
product code, a seven-allergen declaration, a multi-pack quantity, and one
label with every field empty — and runs each through `../lint-zpl.py`. Run it
after any change to `zpl.py`.

Text widths are estimated from the resident condensed font, so a clean run is a
strong signal rather than a proof. Render anything whose shape changed: the
preview in the app is a real ZPL render and is the last word.
