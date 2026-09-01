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

A view can be linked to directly — `#goods-in` for the list, `#box/<item id>`
for one label — so the machine at the printer can sit on the list it uses, or
on the one label it prints all day, rather than starting from the tiles every
time.

## What it does

Three screens, one decision each.

1. **Which kind of label** — Goods In, Date Opened, Product Packet, Product Box.
2. **Which item** — the catalog, filtered to the items that type applies to.
   Goods In lists the sixty active ingredients; Date Opened lists only the
   fifteen that are used a bit at a time, because a pack that is never partly
   used has nothing to record; the two product types list twenty-five finished
   products.

   Products are grouped into **Broths, Frozen Ramen, Soups and Sauces**. The
   catalog has one flat kind, `product`, covering a two-litre tub of sauce and
   a frozen retail ramen alike, and twenty-five of those in one alphabetical
   run is a list to search rather than a list to pick from. The category is
   stated per product in `label-data.json`; anything uncategorised falls to
   the end under its own heading rather than into the largest group, so a new
   product is visible as one nobody has placed.

   Ingredients are grouped **by supplier, then by storage**, which is the
   order the two facts are needed in. A delivery is one van from one supplier,
   so that alone narrows sixty things to twenty-odd; within it, what separates
   one row from the next is where the goods are going, because that is what
   happens to them next and it is what a wrong answer costs.

   Storage sections run chilled, frozen, then ambient — the order a van gets
   unloaded in, coldest first.

   Seven ingredients are bought from both suppliers and appear under both,
   marked "also Tazaki": at the door it genuinely could be either. Storage
   sections do not overlap.

   Goods In sections on the unopened requirement; Date Opened sections on the
   after-opening one, which is the whole point of that label — several things
   sit on an ambient shelf unopened and must be refrigerated once they are
   not. Sectioning that label by the unopened requirement would file exactly
   the items that change under the wrong heading.

   `Storage not recorded` gets its own section rather than being folded into
   Ambient. Null means nobody has determined it, and quietly defaulting it is
   what puts an opened jar back on a dry shelf.

   Each row carries the item's **photograph** from the kitchen's own catalog —
   50 of the 60 ingredients and 18 of the 25 products. Catalog names are not
   what is written on the box, and a jar is quicker to match by sight than by
   reading "Toban Djan Chilli Bean Sauce". Anything without one shows an
   initial instead, which keeps the rows the same height.

   Photographs are served from `worker/public/photos` rather than copied in
   here: two copies of the same two megabytes would drift apart the first time
   one was re-imported. `worker/scripts/import_photos.py` puts them there,
   taking ingredients from the old batching API and products from the forms
   Worker's catalog, matched by item id because both catalogs were built from
   the same workbook. Drop a `static/photos` directory in and it wins, for a
   machine that has this tool without the rest of the repository.
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

Several fields fill themselves in from a date and keep following it. Typing
into one stops it following: after that it is yours, and it must not be undone
by touching the date afterwards.

| Field | Follows | Rule |
| --- | --- | --- |
| Goods In, batch number | Delivered | `ddmmyy` — a delivery on 01/09/2026 is batch `010926` |
| Product, batch code | Packed, Pot | `ddmm`, the run suffix `GA`, then the pot — `0109GA3` |
| Product, use by | Packed | Whole months on, landing on the **first** of that month |

Shelf life is twelve months for the two broths and six for everything else
(Dean, 2026-09-01), held per category rather than per product because that is
the level at which it was decided. A batch packed on 23/01/2026 with six
months on it is used by 01/07/2026, not the 23rd. Rounding to the start of the
month can only shorten the life, never extend it past what was intended, and
counting in whole months means there is no 31st to fall off the end of a short
month.

The broths are cooked several times a day and **each pot is its own batch**,
so the pot number is part of the code rather than a note beside it. It is
picked from a row of buttons under the batch, not a dropdown: it is chosen on
every print, often several in a row, and a row of targets costs one click and
a glance where a dropdown costs two clicks and a read. Which products get a
pot, and how many the picker offers, is `pot_numbers` in `label-data.json`.

The result is that a product label needs **nothing typed** on the day it is
packed: pick the product, pick the pot if it has one, press Print.

## The QR

It encodes the **SKU**, and nothing else for now. That is the only thing on a
product label that resolves to something today: there is no trace endpoint for
a batch code to point at yet, and a code that scans to nothing is worse than
no code. A product sold without a SKU carries no QR at all rather than one
encoding a blank.

Once the trace endpoint is live the QR should carry a URL to the batch record,
so any phone camera reaches it without an app — but not before that page
exists, for the same reason.

The symbol is **sized to fit** rather than printed at a fixed magnification. A
seven-character batch code and a fourteen-character SKU are different-sized
symbols, and the fixed magnification that suited the first put the second over
the keep-out margin. `zpl.py` picks the largest magnification from 6 down to 4
that stays inside the margin, and says so if it has to drop below 5, where a
symbol starts to struggle being read off a cold packet through condensation.
Error correction is level H throughout, for the same reason.

Everything else is filled from the catalog and locked. Where the catalog has
no answer, the field is unlocked and outlined, and the item is flagged
**needs filling** in the list. That is a gap to close in the data, not a field
to retype every time; typing into it prints a correct label today without
recording anything.

There are no gaps. Every label the tool prints is filled in from the catalog,
the Allergen Matrix and `label-data.json`, and nothing has to be typed except
the batch and the dates.

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

Five things worth knowing about the result:

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
- **Five items are stated directly.** Chicken Fillet, Coconut Milk, Pork
  Belly, Ramen Noodles and Wakame Seaweed are not in the matrix and their
  declarations were given by Dean, so they sit in the importer's `DECIDED` map in the matrix's
  own column codes. They belong in the matrix itself, which is the document an
  auditor reads; every one should disappear from that map as it is added
  there.
- **One item borrows another's row.** Pork Chasiu is not in the matrix; it is
  cooked in the soy sauce and declares what the soy sauce declares, so the
  importer's `SAME_AS` points it at Japanese Soy Sauce. Recorded there rather
  than typed into `label-data.json`, so a re-import cannot quietly drop it and
  so it follows the source item if the matrix changes.
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
| `package.sh` | Assembles a self-contained copy in the shared Drive folder. |

`config.json`, `print-log.jsonl` and `printed/` are written at runtime and are
not in the repository.

## Products that get no label

`not_labelled` in `label-data.json` names catalog rows that never get a label
printed, with the reason and who decided. They stay active in the catalog:
this says nothing about whether the kitchen holds the item, only that no label
of ours goes on it. Naming them one at a time is deliberate — a rule that
filtered them automatically would quietly drop a product nobody had looked at.

## Getting it onto the machine at the printer

```
./package.sh
```

writes a self-contained copy into the shared Drive folder, which syncs to the
Windows machine. The bundle carries its own photographs in `static/photos` and
its own copy of the linter, so it runs with none of the rest of the repository
present. That is a distribution copy rather than a second source of truth: it
is rebuilt every time the script runs, and nothing edits it by hand.

`config.json`, `print-log.jsonl` and `printed/` are deliberately not copied, in
either direction. They belong to the machine they were made on, and
overwriting the kitchen's printer settings from a development machine is a
good way to stop it printing.

Cloning the repository on that machine works too and makes updates a `git
pull`. The Drive route exists because it needs nothing installed but Python.

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
