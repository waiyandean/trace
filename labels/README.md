# Labels

Label artwork and the tooling that generates it. Printer is a Zebra ZT231
(203 dpi, ZPL). See `../PLAN.md` for the printing architecture and the open
questions around it.

## Files

| File | What |
| --- | --- |
| `png-to-zpl.py` | Converts an image into a ZPL `^GF` graphic field. |
| `logo-bowl.zpl` | The Maki & Ramen bowl mark, 180 x 76 dots (22.5 x 9.5 mm). |
| `tonkotsu-packet.zpl` | Product packet label, MR015 Tonkotsu Broth. |

## Printing one

Over USB from a Windows machine with the printer shared as `ZEBRA`:

```
copy /b tonkotsu-packet.zpl \\localhost\ZEBRA
```

Once the printer is on the network, from anywhere:

```
nc <printer-ip> 9100 < tonkotsu-packet.zpl
```

Paste the file into labelary.com (203 dpi, 4 x 2) to preview without printing.

## Converting an image

```
python3 png-to-zpl.py Logo.png --width 180 --crop 0,158,380,319
```

`--width` is the printed width in dots; 203 dots is one inch, so 8 dots is
roughly a millimetre. `--crop` takes `left,top,right,bottom` in source pixels.

Thermal printing is one bit per pixel — every dot is burned or not, with no
greyscale. Flat artwork with strong black and white areas converts cleanly
under the default threshold. Artwork whose shapes are distinguished only by
colour does not: the full Maki & Ramen logo loses the pig and the fish
entirely, because both are mid-tone fills with no outline, so they threshold
to white and leave their eyes floating in empty space. `--dither` keeps those
shapes as dot patterns, but the pattern is noisy at label size and thermal
printheads bleed, so it tends to fill in. Hence the bowl-only crop, which was
already pure black and white in the original.

## Sizing note

`^GF` does not scale. Convert at the exact printed size you want. `^XG` can
scale a stored graphic, but only by whole-number factors.
