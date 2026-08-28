#!/usr/bin/env python3
"""Report overlapping or out-of-bounds elements in a ZPL label.

Parses the subset of ZPL these labels use and computes a bounding box per
element, so collisions are caught before anything is printed. Text widths are
estimated from the resident condensed font, so they are approximate; boxes,
ellipses and QR codes are computed from their declared geometry.

    python3 lint-zpl.py tonkotsu-packet.zpl
"""
import re
import sys

# Modules per side for QR versions 1-6, and capacity in each mode.
QR_MODULES = {1: 21, 2: 25, 3: 29, 4: 33, 5: 37, 6: 41}
QR_ALNUM = {"L": [25, 47, 77, 114, 154, 195], "M": [20, 38, 61, 90, 122, 154],
            "Q": [16, 29, 47, 67, 85, 106], "H": [10, 20, 35, 50, 64, 84]}
QR_BYTE = {"L": [17, 32, 53, 78, 106, 134], "M": [14, 26, 42, 62, 84, 106],
           "Q": [11, 20, 32, 46, 60, 74], "H": [7, 14, 24, 34, 44, 58]}
# Condensed resident font: average advance is a little over half the height.
CHAR_W = 0.55


def qr_side(data, ecc, mag):
    alnum = all(c in "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:" for c in data)
    table = QR_ALNUM if alnum else QR_BYTE
    caps = table.get(ecc.upper(), table["Q"])
    for i, cap in enumerate(caps):
        if len(data) <= cap:
            # One version of headroom: printers pick a version from their own
            # encoder, and a QR that renders larger than predicted is the
            # failure this tool exists to catch.
            return QR_MODULES[min(i + 2, 6)] * mag
    return QR_MODULES[6] * mag


def parse(src):
    pw = int(m.group(1)) if (m := re.search(r"\^PW(\d+)", src)) else 812
    ll = int(m.group(1)) if (m := re.search(r"\^LL(\d+)", src)) else 406
    lhx, lhy = (int(m.group(1)), int(m.group(2))) if (
        m := re.search(r"\^LH(\d+),(\d+)", src)) else (0, 0)

    elements = []
    # Split on field origins; each chunk is one element up to its ^FS.
    for chunk in re.split(r"(?=\^F[OT]\d)", src):
        mo = re.match(r"\^(F[OT])(\d+),(\d+)(.*)", chunk, re.S)
        if not mo:
            continue
        kind, x, y, rest = mo.group(1), int(mo.group(2)), int(mo.group(3)), mo.group(4)
        rest = rest.split("^FS")[0]
        x, y = x + lhx, y + lhy

        if gb := re.search(r"\^GB(\d*),(\d*),(\d*)", rest):
            w = int(gb.group(1) or 0)
            h = int(gb.group(2) or 0)
            t = int(gb.group(3) or 1)
            elements.append(("box", x, y, max(w, t), max(h, t)))
            continue
        if ge := re.search(r"\^GE(\d*),(\d*),(\d*)", rest):
            elements.append(("oval", x, y, int(ge.group(1) or 0), int(ge.group(2) or 0)))
            continue
        if bq := re.search(r"\^BQ\w?,(\d+),(\d+)", rest):
            mag = int(bq.group(2))
            fd = re.search(r"\^FD(\w)(\w),(.*)", rest, re.S)
            ecc, data = (fd.group(1), fd.group(3)) if fd else ("Q", "")
            side = qr_side(data.strip(), ecc, mag)
            elements.append(("qr", x, y, side, side))
            continue
        if gf := re.search(r"\^GFA,\d+,\d+,(\d+),", rest):
            row = int(gf.group(1))
            total = int(re.search(r"\^GFA,(\d+)", rest).group(1))
            elements.append(("image", x, y, row * 8, total // row))
            continue
        if a := re.search(r"X", rest):
            h = int(a.group(1))
            fd = re.search(r"\^FD(.*)", rest, re.S)
            text = fd.group(1).replace("^FR", "").replace("\\&", "").strip() if fd else ""
            if fb := re.search(r"\^FB(\d+),(\d+)", rest):
                w, lines = int(fb.group(1)), int(fb.group(2))
                est = max(1, min(lines, int(len(text) * h * CHAR_W / max(w, 1)) + 1))
                elements.append(("text", x, y - (h if kind == "FT" else 0), w, h * est))
            else:
                w = int(len(text) * h * CHAR_W)
                elements.append(("text", x, y - (h if kind == "FT" else 0), w, h))
    return pw, ll, elements


def main():
    src = open(sys.argv[1]).read()
    pw, ll, els = parse(src)
    print(f"label {pw} x {ll} dots\n")
    for k, x, y, w, h in els:
        print(f"  {k:6} x {x:4}-{x + w:4}   y {y:4}-{y + h:4}")

    problems = []
    for k, x, y, w, h in els:
        if x + w > pw or y + h > ll:
            problems.append(f"{k} at {x},{y} runs past the label "
                            f"(ends {x + w},{y + h})")
    for i, a in enumerate(els):
        for b in els[i + 1:]:
            # A box or oval drawn around content is a container, not a clash.
            if a[0] in ("box", "oval") or b[0] in ("box", "oval"):
                if _contains(a, b) or _contains(b, a):
                    continue
            ox = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
            oy = min(a[2] + a[4], b[2] + b[4]) - max(a[2], b[2])
            if ox > 0 and oy > 0:
                problems.append(
                    f"{a[0]} at {a[1]},{a[2]} overlaps {b[0]} at {b[1]},{b[2]} "
                    f"by {ox} x {oy} dots")

    print()
    if problems:
        for p in problems:
            print(f"  PROBLEM  {p}")
        sys.exit(1)
    print("  no overlaps, nothing off the label")


def _contains(outer, inner):
    return (outer[1] <= inner[1] and outer[2] <= inner[2]
            and outer[1] + outer[3] >= inner[1] + inner[3]
            and outer[2] + outer[4] >= inner[2] + inner[4])


if __name__ == "__main__":
    main()
