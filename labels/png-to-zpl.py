#!/usr/bin/env python3
"""Convert an image into a ZPL ^GF graphic field.

Thermal printers are one bit per pixel, so the image is reduced to pure
black and white. Flat-colour artwork should use the default threshold mode;
photographs or artwork whose shapes are distinguished only by colour need
--dither, which approximates tone with a dot pattern at the cost of looking
noisy at small sizes.

Usage:
    python3 png-to-zpl.py LOGO.png --width 180 > logo.zpl
    python3 png-to-zpl.py LOGO.png --width 180 --crop 0,158,380,319
"""
import argparse
import sys

from PIL import Image


def to_zpl(path, width, crop=None, dither=False, threshold=150):
    img = Image.open(path).convert("RGBA")
    # Flatten transparency onto white; an alpha channel would otherwise be
    # read as black and fill the background in.
    img = Image.alpha_composite(Image.new("RGBA", img.size, (255,) * 4), img)
    img = img.convert("L")

    if crop:
        img = img.crop(crop)

    height = max(1, round(img.height * width / img.width))
    img = img.resize((width, height), Image.LANCZOS)
    if dither:
        bitmap = img.convert("1")
    else:
        bitmap = img.point(lambda v: 0 if v < threshold else 255, "1")

    row_bytes = (width + 7) // 8
    out = []
    for y in range(height):
        bits = 0
        for x in range(row_bytes * 8):
            bits <<= 1
            # A set bit prints black; PIL uses 0 for black.
            if x < width and bitmap.getpixel((x, y)) == 0:
                bits |= 1
        out.append(f"{bits:0{row_bytes * 2}X}")

    data = "".join(out)
    total = row_bytes * height
    return f"^GFA,{total},{total},{row_bytes},{data}", width, height


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--width", type=int, required=True,
                    help="printed width in dots (203 dots = 1 inch)")
    ap.add_argument("--crop", help="left,top,right,bottom in source pixels")
    ap.add_argument("--dither", action="store_true")
    ap.add_argument("--threshold", type=int, default=150)
    args = ap.parse_args()

    crop = tuple(int(v) for v in args.crop.split(",")) if args.crop else None
    field, w, h = to_zpl(args.image, args.width, crop, args.dither, args.threshold)
    print(f"^FO0,0{field}^FS")
    print(f"; {w} x {h} dots  =  {w/8:.1f} x {h/8:.1f} mm at 203 dpi",
          file=sys.stderr)


if __name__ == "__main__":
    main()
