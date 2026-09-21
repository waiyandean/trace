"""The Brother QL-600 box-seal label for frozen ramen: name, an EAN-13
barcode, batch, best before, and the health-mark approval oval, small enough
it does not cover the box's own printed artwork -- see PLAN.md and the photo
Dean sent of the reference label this mirrors.

Why this exists rather than reusing labels/gui's printers.py or the ZPL
builders: the QL-600 is USB-only and does not speak ZPL. The ZT231 draws its
own text and barcode from short text commands (^A0N, ^BEN, ...); the QL-600
has no such thing to send commands to -- whatever reaches it has to already
be pixels. Rather than hand-roll Brother's own raster wire protocol (and a
font rasterizer to feed it, since the stdlib has none), this opens the
already-installed Brother Windows driver as an ordinary printer and draws the
label with GDI calls -- ctypes into gdi32.dll, the same stdlib-only approach
labels/gui/printers.py already uses for the Zebra's winspool backend.
Windows' own font rendering and the Brother driver do the actual
rasterizing; nothing here talks to the printer directly, and nothing opens
Brother's own P-touch application.

The one piece with nothing to reuse is the EAN-13 bar pattern itself: GDI has
no barcode primitive, and the ZPL builders never draw bars -- they hand the
digits to the ZT231's own ^BEN command and let the printer draw them. Chosen
digit-encoding tables below are the standard GS1 ones; check_digit() mirrors
worker/src/labels/zpl.js's checkDigit() so the two stay in agreement about
what a valid twelve digits looks like.

gdi32 is loaded lazily (see _gdi() below), not at import time: this keeps
ean13_bars()/check_digit() -- the part with real logic worth unit-testing --
importable and testable from any machine, not only from the Windows box this
otherwise only ever runs on.
"""
import ctypes
import struct


class PrintError(RuntimeError):
    pass


# --- EAN-13 -----------------------------------------------------------------

# Each entry is a 7-module bar/space pattern, '1' a bar, '0' a space.
_L = ["0001101", "0011001", "0010011", "0111101", "0100011",
      "0110001", "0101111", "0111011", "0110111", "0001011"]
_G = ["0100111", "0110011", "0011011", "0100001", "0011101",
      "0111001", "0000101", "0010001", "0001001", "0010111"]
_R = ["1110010", "1100110", "1101100", "1000010", "1011100",
      "1001110", "1010000", "1000100", "1001000", "1110100"]
# Which of L/G each of the first digit's left six digits uses, keyed by the
# thirteenth-digit-implying first digit (the digit EAN-13 prints but never
# encodes directly -- it comes out of this parity pattern instead).
_PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG",
           "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"]


def check_digit(twelve):
    total = 0
    for i, ch in enumerate(twelve):
        total += int(ch) * (1 if i % 2 == 0 else 3)
    return (10 - total % 10) % 10


def ean13_bars(digits):
    """`digits` is 12 or 13 characters. Returns (digits13, bar-pattern string
    of 95 '0'/'1' modules: start guard, six left digits, middle guard, six
    right digits, end guard)."""
    digits = "".join(ch for ch in str(digits) if ch.isdigit())
    if len(digits) not in (12, 13):
        raise PrintError(f"{digits!r} is not an EAN-13 -- {len(digits)} digits, not 12 or 13")
    if len(digits) == 12:
        digits = digits + str(check_digit(digits))
    elif int(digits[12]) != check_digit(digits[:12]):
        raise PrintError(
            f"{digits} has the wrong check digit: the first twelve give "
            f"{check_digit(digits[:12])}, not {digits[12]}")

    first, left, right = digits[0], digits[1:7], digits[7:13]
    parity = _PARITY[int(first)]
    bars = "101"
    for ch, p in zip(left, parity):
        bars += (_L if p == "L" else _G)[int(ch)]
    bars += "01010"
    for ch in right:
        bars += _R[int(ch)]
    bars += "101"
    return digits, bars


# --- GDI, loaded lazily -------------------------------------------------

LOGPIXELSX = 88
PHYSICALOFFSETX, PHYSICALOFFSETY = 112, 113

# Layout, in points, read straight off MR024 Hell Ramen.lbx's object
# rectangles (x, y, width, height). Points, not mm: the .lbx is in points, and
# an earlier version of this file converted its y values to mm and treated
# them as running along the tape's *width*, which is the wrong axis and drew
# a label roughly twice the size of the real one.
#
# The .lbx is a landscape page (paper 62mm, autoLength, margins 4.4pt left and
# right and 8.4pt top and bottom). x runs along the feed and y runs across the
# 62mm tape, so the label is short: content spans only 8.4pt..117.5pt in x,
# about 39mm, while y uses nearly the full 62mm. That is the same orientation
# the Brother driver's saved settings already have (landscape, printable area
# starting 3mm along the feed and 1.5mm across, i.e. 8.4pt and 4.3pt), so
# these coordinates map onto the driver's page once GDI's origin is moved out
# from the printable area to the paper corner -- see _draw.
TAPE_WIDTH_MM = 62
PAGE_START_X_PT = 8.4      # the .lbx's leading margin, also the feed-axis printable offset
PAGE_END_X_PT = 117.5      # end of the .lbx's background rectangle (8.4 + 109.1)
# "Length Auto": the content plus the same margin at the trailing end.
LABEL_LENGTH_MM = (PAGE_END_X_PT + PAGE_START_X_PT) / 72 * 25.4

NAME_BOX = (49.8, 4.4, 26.3, 5.7)
NAME_PT = 5                # regular Arial, centred, in its box
BARCODE_BOX = (10.4, 10.4, 105.1, 72)   # bars and digit text bundled as one object
BAR_MODULE_PT = 0.8        # the .lbx's barWidth; the printer draws it as a whole number of dots
DIGIT_PT = 7
# Everything below the barcode sits this much lower than the .lbx has it,
# 3mm, to leave more room under the barcode.
DOWN_PT = 8.5
_LEFT, _WIDTH = 8.4, 109.1

# The Batch and Best before rows, as (text, box, align, pt, bold, font), each
# label stacked above its value and centred. `text` is formatted with the
# payload's batch and useBy, so "{batch}" is the value. This is a redesign of
# the .lbx's two right-aligned columns, chosen from printed trials; values are
# bold because Brother's renderer prints the .lbx's regular weight visibly
# heavier than GDI's regular does.
ROWS = [
    ("Batch", (_LEFT, 90 + DOWN_PT, _WIDTH, 8), "center", 7, False, "Calibri"),
    ("{batch}", (_LEFT, 98 + DOWN_PT, _WIDTH, 14), "center", 12, True, "Consolas"),
    ("Best Before", (_LEFT, 113 + DOWN_PT, _WIDTH, 8), "center", 7, False, "Calibri"),
    ("{useBy}", (_LEFT, 121 + DOWN_PT, _WIDTH, 14), "center", 12, True, "Consolas"),
]
# The .lbx's clipart box is 48 x 28pt at (38.9, 136.4), but the oval drawn
# inside it has padding around it; measured against the printed reference,
# the visible oval is about 36 x 21pt, on the same centre.
OVAL_BOX = (44.9, 139.9 + DOWN_PT, 36, 21)
OVAL_PEN_PT = 1.5
HM_BOX = (51.4, 142.4 + DOWN_PT, 23, 16.2)        # the two health-mark lines, centred
HM_PT = 7
BLACK_PEN, NULL_PEN = 7, 8
BLACK_BRUSH, NULL_BRUSH = 4, 5
TRANSPARENT = 1

_gdi_cache = None
_winspool_cache = None


def _winspool():
    """winspool.drv, for reading the printer's own current settings.

    Separate from _gdi() below: DocumentPropertiesW/OpenPrinterW live in
    winspool.drv, not gdi32.dll.
    """
    global _winspool_cache
    if _winspool_cache is not None:
        return _winspool_cache
    from ctypes import wintypes

    winspool = ctypes.WinDLL("winspool.drv")
    winspool.OpenPrinterW.restype = wintypes.BOOL
    winspool.OpenPrinterW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.HANDLE), ctypes.c_void_p]
    winspool.ClosePrinter.argtypes = [wintypes.HANDLE]
    winspool.DocumentPropertiesW.restype = ctypes.c_long
    winspool.DocumentPropertiesW.argtypes = [
        wintypes.HWND, wintypes.HANDLE, wintypes.LPCWSTR,
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD]
    _winspool_cache = (winspool, wintypes)
    return _winspool_cache


def _current_devmode(printer_name, length_mm=None):
    """The DEVMODE Windows currently has saved for this printer -- the same
    settings a Print Test Page or P-touch Designer job uses.

    CreateDCW's last argument is meant to be exactly this. Leaving it NULL
    asks the driver to pick "some" default, which for the QL-600's
    continuous-length mode is evidently not the same thing as what Printing
    Preferences shows -- a job built on the NULL default reached the spooler
    fine but sat there paused, un-resumable, with no error, while a Test
    Page (which does read the current DEVMODE) printed normally. Fetching
    and passing the real thing removes that gap instead of guessing at
    which orientation/paper fields the driver actually wants set.

    With `length_mm`, the paper length is then overridden. The saved
    settings on the kitchen machine carried a fixed 89.8mm form, which
    printed the seal on more than twice the tape it needs. The label is
    landscape (x along the feed, y across the tape -- see the layout notes
    above), so the orientation is forced to that as well in case Printing
    Preferences was ever changed. The patched DEVMODE is passed back through
    the driver (DM_IN_BUFFER | DM_OUT_BUFFER) so it can validate and merge
    it rather than trusting hand-edited bytes.
    """
    winspool, wintypes = _winspool()
    handle = wintypes.HANDLE()
    if not winspool.OpenPrinterW(printer_name, ctypes.byref(handle), None):
        raise PrintError(f"Windows would not open the printer {printer_name!r}.")
    try:
        DM_OUT_BUFFER, DM_IN_BUFFER = 2, 8
        size = winspool.DocumentPropertiesW(None, handle, printer_name, None, None, 0)
        if size <= 0:
            raise PrintError(f"Could not read {printer_name!r}'s current print settings.")
        devmode = ctypes.create_string_buffer(size)
        if winspool.DocumentPropertiesW(
                None, handle, printer_name, devmode, None, DM_OUT_BUFFER) < 0:
            raise PrintError(f"Could not read {printer_name!r}'s current print settings.")
        if length_mm is not None:
            _patch_paper(devmode, TAPE_WIDTH_MM, length_mm)
            if winspool.DocumentPropertiesW(
                    None, handle, printer_name, devmode, devmode,
                    DM_IN_BUFFER | DM_OUT_BUFFER) < 0:
                raise PrintError(f"{printer_name!r} would not accept a {TAPE_WIDTH_MM}mm x {length_mm:.0f}mm page.")
        return devmode
    finally:
        winspool.ClosePrinter(handle)


def _patch_paper(devmode, width_mm, length_mm):
    """Landscape, custom width x length, in place. DEVMODEW keeps dmFields at
    byte 72 and the printer half of its union (orientation, paper size,
    length, width) from byte 76."""
    DM_ORIENTATION, DM_PAPERSIZE, DM_PAPERLENGTH, DM_PAPERWIDTH, DM_FORMNAME = 0x1, 0x2, 0x4, 0x8, 0x10000
    fields, = struct.unpack_from("<I", devmode, 72)
    # A named form or paper size takes precedence over an explicit
    # width/length, so both are dropped from the fields the driver reads.
    fields = (fields | DM_ORIENTATION | DM_PAPERLENGTH | DM_PAPERWIDTH) & ~(DM_PAPERSIZE | DM_FORMNAME)
    struct.pack_into("<I", devmode, 72, fields)
    struct.pack_into("<h", devmode, 76, 2)
    struct.pack_into("<h", devmode, 80, round(length_mm * 10))
    struct.pack_into("<h", devmode, 82, round(width_mm * 10))


def _gdi():
    """The gdi32 handle, with every call used below given a real prototype.

    GDI handles (HDC, HFONT, HGDIOBJ, ...) are pointer-sized. ctypes assumes
    a plain 32-bit int for any function it hasn't been told a signature for,
    which silently truncates every one of these on 64-bit Python -- a handle
    above 4 GB comes back mangled and every later call using it either fails
    or corrupts the wrong object. Declaring restype/argtypes as c_void_p (or
    the matching wintypes alias) is what keeps them intact.
    """
    global _gdi_cache
    if _gdi_cache is not None:
        return _gdi_cache
    from ctypes import wintypes

    gdi32 = ctypes.WinDLL("gdi32.dll")
    gdi32.CreateDCW.restype = wintypes.HDC
    gdi32.CreateDCW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p]
    gdi32.DeleteDC.argtypes = [wintypes.HDC]
    gdi32.StartDocW.restype = ctypes.c_int
    gdi32.StartDocW.argtypes = [wintypes.HDC, ctypes.c_void_p]
    gdi32.StartPage.argtypes = [wintypes.HDC]
    gdi32.EndPage.argtypes = [wintypes.HDC]
    gdi32.EndDoc.argtypes = [wintypes.HDC]
    gdi32.SetBkMode.argtypes = [wintypes.HDC, ctypes.c_int]
    gdi32.GetDeviceCaps.argtypes = [wintypes.HDC, ctypes.c_int]
    gdi32.CreatePen.restype = ctypes.c_void_p
    gdi32.CreatePen.argtypes = [ctypes.c_int, ctypes.c_int, wintypes.DWORD]
    gdi32.SetViewportOrgEx.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    gdi32.CreateFontW.restype = ctypes.c_void_p
    gdi32.CreateFontW.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                   ctypes.c_int, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.DWORD, wintypes.LPCWSTR]
    gdi32.SelectObject.restype = ctypes.c_void_p
    gdi32.SelectObject.argtypes = [wintypes.HDC, ctypes.c_void_p]
    gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
    gdi32.GetStockObject.restype = ctypes.c_void_p
    gdi32.GetStockObject.argtypes = [ctypes.c_int]
    gdi32.TextOutW.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.LPCWSTR, ctypes.c_int]
    gdi32.GetTextExtentPoint32W.argtypes = [wintypes.HDC, wintypes.LPCWSTR, ctypes.c_int, ctypes.c_void_p]
    gdi32.Rectangle.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]
    gdi32.Ellipse.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]
    _gdi_cache = (gdi32, wintypes)
    return _gdi_cache


class DOCINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_int),
                ("lpszDocName", ctypes.c_wchar_p),
                ("lpszOutput", ctypes.c_wchar_p),
                ("lpszDatatype", ctypes.c_wchar_p),
                ("fwType", ctypes.c_ulong)]


def _font(gdi32, dc, height, bold=False, name="Arial"):
    hfont = gdi32.CreateFontW(
        -abs(height), 0, 0, 0, 700 if bold else 400, 0, 0, 0,
        1, 0, 0, 0, 0, name)
    return gdi32.SelectObject(dc, hfont), hfont


def _text_box(gdi32, wintypes, dc, box, text, height, align="left", bold=False, font="Arial"):
    """`text` drawn in `box` (device pixels: x, y, w, h), vertically centred as
    the .lbx's CENTER alignment is, and left/center/right aligned within it."""
    x, y, w, h = box
    old, hfont = _font(gdi32, dc, height, bold, name=font)
    size = wintypes.SIZE()
    gdi32.GetTextExtentPoint32W(dc, text, len(text), ctypes.byref(size))
    if align == "center":
        x += (w - size.cx) // 2
    elif align == "right":
        x += w - size.cx
    gdi32.TextOutW(dc, x, y + (h - size.cy) // 2, text, len(text))
    gdi32.SelectObject(dc, old)
    gdi32.DeleteObject(hfont)


def render_and_print(printer_name, payload):
    """`payload` matches what batches.js's printSeal() sends: name, batch,
    useBy, barcode, healthMark, hmCountry, hmCode."""
    gdi32, _wintypes = _gdi()
    devmode = _current_devmode(printer_name, LABEL_LENGTH_MM)
    dc = gdi32.CreateDCW(None, printer_name, None, devmode)
    if not dc:
        raise PrintError(f"Windows would not open a device context for {printer_name!r}.")
    try:
        doc = DOCINFO(ctypes.sizeof(DOCINFO), "trace box seal", None, None, 0)
        if gdi32.StartDocW(dc, ctypes.byref(doc)) <= 0:
            raise PrintError(f"The driver for {printer_name!r} refused the job.")
        try:
            if gdi32.StartPage(dc) <= 0:
                raise PrintError("StartPage failed.")
            try:
                _draw(gdi32, _wintypes, dc, payload)
            finally:
                gdi32.EndPage(dc)
        finally:
            gdi32.EndDoc(dc)
    finally:
        gdi32.DeleteDC(dc)


def _draw(gdi32, wintypes, dc, payload):
    # Positions come from the device's own DPI rather than
    # GetDeviceCaps(dc, HORZRES)/VERTRES for a page size -- that was tried
    # first and came back wrong for this driver's continuous/auto-length
    # mode.
    dpi = gdi32.GetDeviceCaps(dc, LOGPIXELSX) or 300

    def pt(value):
        return round(value / 72 * dpi)

    def box(rect):
        return tuple(pt(v) for v in rect)

    # GDI's (0, 0) is the corner of the printable area, which the QL-600
    # starts a little in from the paper's edges (PHYSICALOFFSET, 3mm along the
    # feed and 1.5mm across). The layout is measured from the paper corner,
    # so move the origin out to it.
    gdi32.SetViewportOrgEx(
        dc, -gdi32.GetDeviceCaps(dc, PHYSICALOFFSETX),
        -gdi32.GetDeviceCaps(dc, PHYSICALOFFSETY), None)
    gdi32.SetBkMode(dc, TRANSPARENT)

    # The catalog's internal name is "Frozen Ramen : Hell Ramen"; the box
    # only carries the product's own name.
    name = str(payload.get("name") or "").rsplit(":", 1)[-1].strip()
    if name:
        _text_box(gdi32, wintypes, dc, box(NAME_BOX), name, pt(NAME_PT), align="center")

    barcode = payload.get("barcode")
    if barcode:
        _draw_barcode(gdi32, wintypes, dc, barcode, pt)

    values = {"batch": str(payload.get("batch") or ""), "useBy": str(payload.get("useBy") or "")}
    for text, rect, align, size, bold, font in ROWS:
        _text_box(gdi32, wintypes, dc, box(rect), text.format(**values), pt(size),
                  align=align, bold=bold, font=font)

    if payload.get("healthMark"):
        ox, oy, ow, oh = box(OVAL_BOX)
        old_pen = gdi32.SelectObject(dc, gdi32.CreatePen(0, pt(OVAL_PEN_PT), 0))
        old_brush = gdi32.SelectObject(dc, gdi32.GetStockObject(NULL_BRUSH))
        gdi32.Ellipse(dc, ox, oy, ox + ow, oy + oh)
        pen = gdi32.SelectObject(dc, old_pen)
        gdi32.DeleteObject(pen)
        gdi32.SelectObject(dc, old_brush)

        # The .lbx's health-mark text is one two-line object; each line is
        # half its box's height.
        hx, hy, hw, hh = box(HM_BOX)
        for i, line in enumerate((str(payload.get("hmCountry") or "GB"),
                                  str(payload.get("hmCode") or ""))):
            _text_box(gdi32, wintypes, dc, (hx, hy + i * hh // 2, hw, hh // 2), line,
                      pt(HM_PT), align="center", bold=True)


def _draw_barcode(gdi32, wintypes, dc, barcode, pt):
    digits, bars = ean13_bars(barcode)
    bx, by, bw, bh = (pt(v) for v in BARCODE_BOX)
    # 0.8pt is 3.33 dots at 300dpi, but the reference label -- printed by
    # Brother's own software -- draws every bar as exactly 3, so the barcode
    # is 285 dots wide rather than 316. Whole dots also keep every bar edge
    # on the printer's pixel grid.
    module = max(1, int(BAR_MODULE_PT * pt(72) / 72))
    bars_width = module * len(bars)
    x = bx + round((bw - bars_width) / 2)

    digit_h = pt(DIGIT_PT)
    text_h = round(digit_h * 1.15)
    bar_h = bh - text_h
    # Start, middle and end guards run down through the digit line; the
    # rest stop above it.
    guard = set(range(0, 3)) | set(range(45, 50)) | set(range(92, 95))

    old_pen = gdi32.SelectObject(dc, gdi32.GetStockObject(NULL_PEN))
    old_brush = gdi32.SelectObject(dc, gdi32.GetStockObject(BLACK_BRUSH))
    for i, bit in enumerate(bars):
        if bit == "1":
            # A NULL pen leaves the right and bottom edges out, so adjacent
            # bars' rounded edges meet exactly with no overlap.
            left = x + round(i * module)
            right = x + round((i + 1) * module)
            bottom = by + bh - text_h // 3 if i in guard else by + bar_h
            gdi32.Rectangle(dc, left, by, right, bottom)
    gdi32.SelectObject(dc, old_pen)
    gdi32.SelectObject(dc, old_brush)

    text_y = by + bar_h

    def at(modules):
        return x + round(modules * module)

    # Consolas, like the reference's monospaced-looking digits.
    # Standard EAN-13 human-readable placement: the first digit sits outside
    # the start guard, and each half's six digits are centred under their bars.
    _text_box(gdi32, wintypes, dc, (at(-8), text_y, round(7 * module), text_h),
              digits[0], digit_h, align="right", font="Consolas")
    _text_box(gdi32, wintypes, dc, (at(3), text_y, round(42 * module), text_h),
              digits[1:7], digit_h, align="center", font="Consolas")
    _text_box(gdi32, wintypes, dc, (at(50), text_y, round(42 * module), text_h),
              digits[7:13], digit_h, align="center", font="Consolas")
