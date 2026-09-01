# Labels

Label artwork and the tooling that generates it. Printer is a Zebra ZT231
(203 dpi, ZPL). See `../PLAN.md` for the printing architecture and the open
questions around it.

## Files

| File | What |
| --- | --- |
| `tonkotsu-packet.zpl` | Product packet label, MR015 Tonkotsu Broth. |
| `tonkotsu-box.zpl` | The case version of the same label. |
| `sauce-packet.zpl` | Product label without the health mark, for items that do not need one. |
| `goods-in.zpl` | Intake label. Replaces the handwritten Goods In form. |
| `date-opened.zpl` | Applied when a container is opened or decanted. |
| `png-to-zpl.py` | Converts an image into a ZPL `^GF` graphic field. |
| `lint-zpl.py` | Reports overlapping or off-label elements in a label. |
| `preview.sh` | Renders a label to PNG through Labelary's ZPL engine. |
| `sync-to-drive.sh` | Copies the `.zpl` files to the shared Drive folder. |
| `print-copies.sh` | Writes a copy with a given print quantity into that folder. |
| `gui/` | A local web app that fills these templates in from a form and prints them. |
| `gui/package.sh` | Copies that app to the Drive folder, ready to run on the Windows machine. |

## Filling them in from a form

`gui/` is a small web app that runs on the machine the printer is attached to.
It reads the catalog, builds the same four formats from a form, renders a
preview and sends the result to the printer directly, which removes the
hand-editing, the Drive round trip and the `copy /b` by hand. Its Goods In and
Date Opened labels carry no lot code or QR, because lots do not exist yet.
See `gui/README.md`.

Everything below still describes the labels themselves, which is what the app
generates and what has to be got right either way.

## Where the files live

This directory is the source of truth. `sync-to-drive.sh` copies them into
the shared Drive folder (`Main/test labels`), which syncs to the Windows
machine the printer is attached to, so the label can be printed there without
transferring anything by hand.

## Print quantity

`^PQ` sets how many labels come out, and it is part of the label format
rather than something that can be sent alongside it, so the number has to be
in the file. One delivery line is one lot but many physical boxes — ten cases
of chicken feet need ten labels, all naming the same lot — so this gets used
constantly on intake.

Rather than hand-editing:

```
./print-copies.sh goods-in.zpl 10      # writes goods-in-x10.zpl to Drive
```

The equivalent on the Windows machine, without this repository:

```
powershell -c "(gc label.zpl -Raw) -replace '\^PQ\d+','^PQ10' | sc out.zpl -NoNewline"
copy /b out.zpl \\localhost\ZEBRA
```

Everything else on these labels — ingredient, dates, batch, lot — still has to
be edited by hand until the Worker generates them. Quantity is only the most
frequently changed of those fields, not the only one.

## Printing one

Over USB from the Windows machine, with the printer shared as `ZEBRA`:

```
copy /b tonkotsu-packet.zpl \\localhost\ZEBRA
```

Once the printer is on the network, from anywhere:

```
nc <printer-ip> 9100 < tonkotsu-packet.zpl
```

Paste the file into labelary.com (203 dpi, 4 x 2) to preview without printing.

## Previewing a label

```
./preview.sh tonkotsu-packet.zpl        # writes tonkotsu-packet.png
```

Renders through Labelary's HTTP API, which runs the real ZPL interpreter, so
it shows what the printer will draw rather than an approximation. It starts
from clean printer state, so it will not reproduce anything caused by settings
persisting on the printer — see the `^BY` section below.

**Check the worst case as well as the label itself.** A label full of short
strings hides the failures that a long product name, a long product code, a
seven-allergen declaration or a multi-pack quantity produce. `gui/check_layouts.py`
builds every format at its worst case and lints them in one command; it
replaced a hand-written `stress-test.zpl`, which could only ever stress one of
the four formats and had to be edited to keep up with them.

## Telling the four types apart

They have to be identifiable at a glance. An earlier attempt did this with
reversed type in solid black bands, which worked but measured 41-48% black
against 9-15% for the current design — roughly four times the ribbon, print
time, head wear and smear risk on every label, forever. The heavy version also
did not look like the labels the kitchen already prints, which are clean black
on white. It was dropped.

What distinguishes them now:

| Type | Device |
| --- | --- |
| Goods In | type name top left, no border |
| Date Opened | type name top left, **border round the whole label** |
| Product packet | product code and name, no border |
| Product box | as packet, plus a **rule and case line** at the foot |

Goods In and Date Opened are the pair that actually gets confused, because they
sit on the same shelves on the same containers, so the border goes there. It is
an outline, so it costs almost no ink for a mark that reads across a room.
Product labels are customer-facing and stay plainest.

Packet against box is the weakest of the four distinctions, which is accepted:
they go on physically different objects, a pouch and a case, so context does
most of that work.

Render `preview/all-four-distance.png` after any change — it is the four labels
at a third scale, which is roughly what the eye gets from across a room.

## The label set

The existing printed labels fall into four templates, of which these carry lot
identity:

- **Product packet / box.** One template; the box variant differs only in its
  quantity and product code, so it is the same layout with different values.
- **Goods In.** Today this is a blank form staff fill in by hand: ingredient,
  supplier, date delivered, batch number, use by, allergens, with a rotated
  storage banner down each side. Being handwritten with no system identity is
  the traceability gap in physical form, and it is why the old ledger could not
  join a batch to the delivery it came from. The replacement is printed and
  carries the lot's short code and QR.
- **Date Opened.** Also a blank handwritten form today. It matters more than it
  looks: it is the re-label flow. When a container is opened or its contents
  decanted, the new label has to carry the *same* lot, otherwise the lot's
  identity dies at the moment the box is opened. Its "Ensure product is
  properly sealed" note is kept from the original.

**The oval health mark is conditional.** The broths carry it; most sauces and
oils do not. That is a compliance determination per product, held as a flag on
the item rather than inferred, so the same template serves both: with the mark
absent, the SKU moves up into the space it occupied. `sauce-packet.zpl` is the
worked example.

Frozen ramen retail labels are a separate template, printed on a Brother
printer because the Zebra stock does not fit the box, and are out of scope
here.

## Vertical rhythm and the top edge

Text starts 24 dots (3 mm) from the top edge. The header band itself bleeds to
the edge, so a print that shifts up loses a sliver of black rather than the top
of the product name.

The band is 122 dots tall, which is what a **two-line** name needs at 44 dots
plus that clearance. It has to accommodate two lines even though most names fit
on one, because a field block that overruns draws its overflow on top of the
first line rather than truncating, and a second line falling outside the band
would print white on white.

The item or product name is set at the same size as the use-by date. Those two
are what the label is for — what is this, and how long is it good — so neither
should dominate the other.

## The keep-out zone

**Nothing prints within 40 dots (5 mm) of any edge.** The print can shift
relative to the die-cut edge, and the amount is not yet trustworthy, so the
margin is sized for the worst observed drift rather than the best.

`lint-zpl.py` enforces this and fails anything that breaks it, so it does not
depend on being remembered.

The one exemption is a shape that deliberately bleeds to the edges, currently
the Date Opened border. A registration shift clips a little of that border,
which reads as a label trimmed slightly off rather than as missing
information. Text losing its top does not.

The zone costs real room: 5 mm on every side leaves 732 x 326 dots of usable
area out of 812 x 406, about a quarter of the label gone. That is what set the
current type sizes, and it is why the seven-allergen declaration is close to
its ceiling on one line.

## Names are one line, never two

Dean, 2026-08-28: a name that does not fit is shortened in the catalog rather
than wrapped or shrunk. So the name is a plain field with no field block, set
at 38 dots on every label, and the divider rule sits directly beneath it with
no space reserved for a second line.

That fixes the character budget at a single number. Measured off real renders,
the resident condensed font averages 0.44 of the character height per
character, so 44-dot type gives about **38 characters** in the 732 dots between
the keep-out margins.

The `MR0xx` product code was dropped from the name (Dean, 2026-08-28), which
freed roughly ten characters and let the name grow from 38 dots to 44. The
longest current product name, `Spicy Miso Tonkotsu Ramen`, is 25 characters
and ends around x=552 against a 772 limit, so there is room for longer names
than any currently in use. The `M&R` prefix the earlier artwork carried was
dropped (Dean, 2026-09-01), which returned another four characters.

Note the product code no longer appears anywhere on the product labels. The
supplier or customer SKU under the approval oval, `BF-TKBR-2K`, remains. If the
`MR0xx` code is needed on the label it has to be placed deliberately rather
than assumed to still be there.

Without a field block, an over-long name clips at the edge rather than
overprinting itself, so the failure is visible rather than a smear. It is
still a failure: the catalog is where it gets prevented.

## ^FB overprints, it does not truncate

A field block whose text does not fit its width **wraps and draws the overflow
on top of the previous line**, even when the maximum line count is 1. The
result is an unreadable smear rather than a clipped string, and nothing warns
you.

This is why the header is `^FB772,2` rather than `^FB772,1`: a product name
too long for one line wraps to a second instead of destroying the first. The
seven-allergen declaration currently reaches the right-hand edge of its box, so
an eighth allergen would overprint.

For generated labels this means the Worker cannot simply drop content into a
fixed template. It has to size the header font and the allergen box from the
length of what it is placing, and every layout change needs the worst case
re-checked.

## Checking a layout

```
python3 lint-zpl.py tonkotsu-packet.zpl
```

Prints a bounding box per element and fails if any two overlap or anything
runs past the label edge. Text widths are estimated from the resident
condensed font so they are approximate; boxes and ellipses are exact. A box or
ellipse that fully contains another element is treated as a container rather
than a clash, which is what makes the allergen box and the approval oval pass.

QR size is an estimate: the printer's own encoder picks the symbol version, so
the tool deliberately assumes one version more than it calculates.

## Always set ^BY, even when the label has no linear barcode

`^BY` is **persistent printer state**, not a per-label setting. Its third
parameter is a default barcode height, and it survives from one label to the
next until something changes it or the printer is restarted. A leftover height
is then applied as a vertical offset to any QR code that follows.

This bit us: the QR printed about 110 dots below the y its `^FO` declared,
while its x was honoured and every other element landed correctly, and
Labelary rendered the same ZPL correctly because it starts from clean state.
The cause was a `^BY` height left in the printer by Zebra Designer, which
emits one for Code 128 — and the Code 128 on the old label was about 110 dots
tall.

So every label sets `^BY2,3,10` near the top, before any barcode field. Labels
generated by the Worker must do the same. Without it, whatever was printed
previously — possibly from an entirely different application — silently
changes how this label comes out.

Because a QR's position depends on printer state the linter cannot see, keep
its column clear from top to bottom rather than packing elements above and
below it. That is why the approval oval sits beside the data rows rather than
in the right-hand column.

## Label layout notes

Stock is 4 x 2 inches, confirmed 2026-08-28, so `^PW812 ^LL406` is correct
at 203 dpi.

Print registration is held in the printer, not in the label. The label
previously carried `^LH0,24` to push everything down 3 mm; that offset now
lives in the printer's own print position setting, so the format is clean and
carries no machine-specific fudge. Do not reintroduce `^LH` for alignment —
if a printer prints high or low, correct it on that printer, otherwise the
offset for one machine ends up baked into labels that any machine prints.

The allergen box is sized for a single declaration line, which covers
Tonkotsu Broth's three allergens. A product with enough allergens to wrap
needs the box taller and the disclaimer moved down:

```
^FO15,282^GB570,102,2^FS
^FO30,292^A0N,28,0^FB540,2,0,L^FDALLERGENS: ...^FS
^FO30,356^A0N,20,0^FB540,1,0,L^FDMay contain other allergens^FS
```

Once labels are generated rather than hand-written, the Worker should size
that box from the length of the allergen string instead of it being fixed.

The QR currently carries the batch code. Once the trace endpoint exists it
should carry a URL instead, so that any phone camera resolves it to the batch
record without an app. Do not switch to a URL before that page is live — a
dead link on a customer's packet is worse than no link.

## Images

Thermal printing is one bit per pixel: every dot is burned or not, with no
greyscale and therefore no opacity. Flat artwork with strong black and white
areas converts cleanly under the default threshold. Artwork whose shapes are
distinguished only by colour does not.

The Maki & Ramen logo was tried and dropped. Its pig and fish are mid-tone
fills with no outline, so they threshold to white and vanish, leaving their
eyes floating in empty space; the tree collapses into a shapeless blob.
Dithering preserves the shapes as dot patterns but is too noisy at label size,
and thermal printheads bleed enough to fill it in. A cropped bowl-only mark
did convert cleanly, but was dropped along with the rest.

Getting the full logo onto a label would need a line-art version drawn with
outlines rather than colour fills. That is a design job, not a conversion
setting.

To convert an image:

```
python3 png-to-zpl.py Logo.png --width 180 --crop 0,158,380,319
```

`--width` is the printed width in dots; 203 dots is one inch, so 8 dots is
roughly a millimetre. `--crop` takes `left,top,right,bottom` in source pixels.
`^GF` does not scale, so convert at the exact printed size wanted.
