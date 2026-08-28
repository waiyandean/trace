# Labels

Label artwork and the tooling that generates it. Printer is a Zebra ZT231
(203 dpi, ZPL). See `../PLAN.md` for the printing architecture and the open
questions around it.

## Files

| File | What |
| --- | --- |
| `tonkotsu-packet.zpl` | Product packet label, MR015 Tonkotsu Broth. |
| `png-to-zpl.py` | Converts an image into a ZPL `^GF` graphic field. |
| `sync-to-drive.sh` | Copies the `.zpl` files to the shared Drive folder. |

## Where the files live

This directory is the source of truth. `sync-to-drive.sh` copies them into
the shared Drive folder (`Main/test labels`), which syncs to the Windows
machine the printer is attached to, so the label can be printed there without
transferring anything by hand.

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

## Label layout notes

Stock is 4 x 2 inches, confirmed 2026-08-28, so `^PW812 ^LL406` is correct
at 203 dpi.

`^LH0,24` shifts everything down 3 mm. Because the declared label length was
right all along, that shift is correcting print registration rather than a
wrong `^LL` — which means it belongs in the printer, not in every label
format. Run a media calibration first, and only set Menu > Print > Print
Position > Top Position by hand if calibration does not land it. Once the
printer holds the offset, delete the `^LH` line and the layout regains 24
dots of vertical space; it currently has only 8 dots of bottom margin.

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
