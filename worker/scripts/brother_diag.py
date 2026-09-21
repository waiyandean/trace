"""Prints what the Brother driver reports about its page, without printing.

Run on the Windows machine the QL-600 is attached to:

    python brother_diag.py "Brother QL-600"

Used to find out why brother_seal.py's output came out oversize: it computes
every position from LOGPIXELSX alone, which is only right if the driver's
horizontal and vertical resolutions match and its page is what the code
assumes. This shows the resolutions on both axes, the device's own idea of
the page size, and the paper fields of the saved DEVMODE.
"""
import ctypes
import struct
import sys

import brother_seal

CAPS = [
    ("HORZSIZE (mm)", 4), ("VERTSIZE (mm)", 6),
    ("HORZRES (px)", 8), ("VERTRES (px)", 10),
    ("LOGPIXELSX", 88), ("LOGPIXELSY", 90),
    ("PHYSICALWIDTH (px)", 110), ("PHYSICALHEIGHT (px)", 111),
    ("PHYSICALOFFSETX (px)", 112), ("PHYSICALOFFSETY (px)", 113),
]


def report(name, title, length_mm=None):
    gdi32, _wintypes = brother_seal._gdi()
    devmode = brother_seal._current_devmode(name, length_mm)
    raw = devmode.raw

    # DEVMODEW: dmFields at 72, then the printer half of the union from 76.
    fields, = struct.unpack_from("<I", raw, 72)
    orientation, paper_size, paper_length, paper_width, scale, copies = \
        struct.unpack_from("<6h", raw, 76)
    quality, = struct.unpack_from("<h", raw, 90)
    y_res, = struct.unpack_from("<h", raw, 96)
    form = raw[102:166].decode("utf-16-le", "ignore").split("\0")[0]

    print(f"{title} for {name!r} ({len(raw)} bytes)")
    print(f"  dmFields        0x{fields:08x}")
    print(f"  orientation     {orientation}   (1 portrait, 2 landscape)")
    print(f"  paper size      {paper_size}   form {form!r}")
    print(f"  paper W x L     {paper_width} x {paper_length}   (tenths of a mm; 0 = unset)")
    print(f"  print quality   {quality}   y resolution {y_res}")

    dc = gdi32.CreateDCW(None, name, None, devmode)
    if not dc:
        sys.exit("CreateDCW failed")
    try:
        print("  DC capabilities")
        for label, index in CAPS:
            print(f"    {label:<22}{gdi32.GetDeviceCaps(dc, index)}")
    finally:
        gdi32.DeleteDC(dc)


def main(name):
    report(name, "Saved DEVMODE")
    print()
    report(name, "DEVMODE as the seal now sends it", brother_seal.LABEL_LENGTH_MM)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
