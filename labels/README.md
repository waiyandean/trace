# Labels

Label artwork and the tooling that generates it. Printer is a Zebra ZT231
(203 dpi, ZPL). See `../PLAN.md` for the printing architecture and the open
questions around it.

## Files

| File | What |
| --- | --- |
| `tonkotsu-packet.zpl` | Product packet label, MR015 Tonkotsu Broth. |
| `tonkotsu-box.zpl` | The case version of the same label. |
| `goods-in.zpl` | Intake label. Replaces the handwritten Goods In form. |
| `date-opened.zpl` | Applied when a container is opened or decanted. |
| `png-to-zpl.py` | Converts an image into a ZPL `^GF` graphic field. |
| `lint-zpl.py` | Reports overlapping or off-label elements in a label. |
| `preview.sh` | Renders a label to PNG through Labelary's ZPL engine. |
| `stress-test.zpl` | The same label with worst-case content, for checking layout changes. |
| `sync-to-drive.sh` | Copies the `.zpl` files to the shared Drive folder. |
| `print-copies.sh` | Writes a copy with a given print quantity into that folder. |

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

**Always render `stress-test.zpl` as well as the label itself.** It carries the
worst-case content — a long product name, a long product code, a seven-allergen
declaration, a multi-pack quantity — and it is what catches the failures a
label full of short strings hides.

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

## Margins

Content sits 24 dots (3 mm) from the left and right edges, matched on both
sides. The earlier 15 dots was under 2 mm, which is tight for a die-cut label
where the print can shift slightly relative to the die. The header band is the
one deliberate exception: it bleeds to both edges, so a small registration
shift shows as a thin white sliver rather than clipped text.

Widening the margins narrowed the allergen box, and the seven-allergen case
now reaches its right-hand edge with nothing to spare. That is the practical
ceiling for a single declaration line at this font size.

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
length of what it is placing, and every layout change needs the stress test
re-rendered.

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
