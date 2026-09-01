#!/usr/bin/env python3
"""Build the four label formats from field values.

These are the same layouts as the hand-written files in the parent directory,
with the values lifted out. Two deliberate differences:

  * Goods In and Date Opened carry no lot code and no QR. Lots do not exist
    yet -- the trace system that mints them is still being built -- and a QR
    encoding a code that resolves to nothing is worse than no QR. The space
    they occupied is given back to the batch and the dates. When lots arrive,
    those two fields come back and the layout narrows again.
  * The allergen box is sized from the length of its text rather than fixed.
    A field block that overruns its width wraps and draws the overflow on top
    of the line above -- ^FB does not truncate -- so a long declaration on a
    fixed box is an unreadable smear rather than a visible failure. See
    ../README.md, "^FB overprints, it does not truncate".

Every format sets ^BY explicitly. It is persistent printer state, not a
per-label setting, and a height left behind by a previous label silently
displaces any QR that follows.
"""

WIDTH = 812           # 4 inches at 203 dpi
HEIGHT = 406          # 2 inches
MARGIN = 40           # keep-out zone at every edge, 5 mm
INNER = WIDTH - 2 * MARGIN

# Average advance of the resident condensed font, as a fraction of the
# character height, measured off real renders. Held a little wide so an
# estimate errs toward reporting a problem rather than missing one.
CHAR_W = 0.47

NAME_HEIGHT = 44
ALLERGEN_HEIGHT = 24

# Modules per side for QR versions 1-6, and how many alphanumeric characters
# each version holds at error-correction level H. Mirrors ../lint-zpl.py,
# including its one version of headroom: the printer's own encoder picks the
# version, and a symbol that comes out larger than predicted is the failure
# this guards against.
QR_MODULES = {1: 21, 2: 25, 3: 29, 4: 33, 5: 37, 6: 41}
QR_ALNUM_H = [10, 20, 35, 50, 64, 84]

# Level H, because these get read off a cold packet through condensation and
# through whatever the label has been dragged across. The magnification is
# chosen to fit rather than fixed; below 5 the symbol starts to struggle at
# 203 dpi, so dropping there is worth saying out loud.
QR_ECC = "H"
QR_MAGNIFICATIONS = (6, 5, 4)
QR_COMFORTABLE = 5


def qr_side(data, magnification):
    """How wide the printed symbol is likely to be, in dots."""
    alnum = all(c in "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"
                for c in data)
    caps = QR_ALNUM_H if alnum else [c * 2 // 3 for c in QR_ALNUM_H]
    for index, cap in enumerate(caps):
        if len(data) <= cap:
            return QR_MODULES[min(index + 2, 6)] * magnification
    return QR_MODULES[6] * magnification


def qr_field(data, x, y, warnings):
    """A QR at x,y sized so it cannot run past the keep-out margin.

    The symbol grows with what it encodes, so a fixed magnification that suits
    a seven-character batch code puts a fourteen-character SKU over the edge.
    Sizing it here means the payload can change without the layout being
    re-checked by hand.
    """
    room = WIDTH - MARGIN - x
    for magnification in QR_MAGNIFICATIONS:
        if qr_side(data, magnification) <= room:
            if magnification < QR_COMFORTABLE:
                warnings.append(
                    f"The QR had to be printed at magnification {magnification} "
                    f"to fit '{data}'. Below {QR_COMFORTABLE} it gets hard to "
                    f"read off a cold packet through condensation. A shorter "
                    f"code would be better than a smaller symbol.")
            return f"^FO{x},{y}^BQN,2,{magnification}^FD{QR_ECC}A,{data}^FS"
    warnings.append(
        f"'{data}' is too long to fit a readable QR in the space beside the "
        f"batch, so the label carries no QR.")
    return ""


# An EAN-13 is 95 modules wide whatever it encodes, and ^BY2 makes a module
# two dots, so the bars are always 190 dots across. GS1 asks for a symbol at
# least 80% of nominal, which is about 146 dots tall; there is not that much
# room on a four-by-two label that also carries dates, a health mark and an
# allergen declaration, so the height here is what fits and the caller is told
# when that is short of the standard.
EAN13_MODULES = 95
EAN13_MIN_HEIGHT = 146


def check_digit(twelve):
    total = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(twelve))
    return (10 - total % 10) % 10


def ean13(code, x, y, height, warnings, module=2):
    """An EAN-13 at x,y, with the human-readable digits beneath it.

    ZPL wants the first twelve digits and works out the thirteenth itself, so
    a code whose own check digit disagrees would print as a different number
    than the one written down. That is checked here rather than trusted: a
    barcode with the wrong check digit either fails to scan or, worse, scans
    as somebody else's product.
    """
    digits = "".join(c for c in str(code) if c.isdigit())
    if len(digits) not in (12, 13):
        warnings.append(
            f"'{code}' is not an EAN-13 -- it has {len(digits)} digits, not 13 "
            f"-- so no barcode is printed.")
        return ""
    if len(digits) == 13 and int(digits[12]) != check_digit(digits[:12]):
        warnings.append(
            f"{digits} has the wrong check digit: the first twelve digits give "
            f"{check_digit(digits[:12])}, not {digits[12]}. No barcode is "
            f"printed, because one that scans as another product is worse "
            f"than none.")
        return ""
    if height < EAN13_MIN_HEIGHT:
        warnings.append(
            f"The barcode is {height} dots tall ({height / 8:.0f} mm). GS1 asks "
            f"for at least {EAN13_MIN_HEIGHT} ({EAN13_MIN_HEIGHT / 8:.0f} mm) "
            f"at this width. A truncated symbol reads fine on most scanners "
            f"and can be refused by a retailer, so check it against the till "
            f"it has to pass.")
    return f"^FO{x},{y}^BEN,{height},Y,N^FD{digits[:12]}^FS"


STORAGE_BANNER = {
    "ambient": "AMBIENT",
    "chill": "CHILLED",
    "freezer": "FROZEN",
}

# What the foot of a Date Opened label tells the person holding it. The
# instruction follows the item's after-opening storage requirement rather than
# being fixed, because printing "refrigerate after opening" on a bag of salt
# teaches staff to ignore the line.
OPENED_FOOTER = {
    "ambient": "KEEP SEALED  -  STORE IN A COOL DRY PLACE",
    "chill": "REFRIGERATE AFTER OPENING  -  KEEP SEALED",
    "freezer": "KEEP FROZEN  -  DO NOT REFREEZE",
}


def text_width(text, height):
    """Roughly how many dots a string occupies at a given character height."""
    return int(len(text) * height * CHAR_W)


def fits(text, height, width=INNER):
    return text_width(text, height) <= width


def escape(value):
    """Make a value safe to drop into a ^FD field.

    ^ and ~ are ZPL's command prefixes, so a value containing either would be
    read as markup and silently mangle the label. \\ is the escape character
    within field data. None becomes an empty string rather than the word
    "None", which is the kind of thing that gets printed and stuck on a box.
    """
    if value is None:
        return ""
    return (str(value).replace("\\", " ").replace("^", " ")
            .replace("~", " ").strip())


def _head(quantity):
    return [
        "^XA",
        f"^PW{WIDTH}",
        f"^LL{HEIGHT}",
        "^CI28",
        "^BY2,3,10",
        "",
    ]


def _shrink_to_one_line(text, width, sizes):
    """The largest of `sizes` that fits `text` on one line, else the smallest.

    A field block that does not fit wraps and draws the overflow on top of the
    line above, so the choice is between a smaller size and an unreadable
    smear. Shrinking a declaration by two dots is the lesser harm, and the
    caller is told when even the smallest does not fit.
    """
    for size in sizes:
        if text_width(text, size) <= width:
            return size, 1
    return sizes[-1], 2


def _allergen_block(text, warnings, is_case=False, may_contain=""):
    """The customer-facing allergen box: declaration and disclaimer, boxed.

    Geometry is held at the coordinates the printed artwork uses rather than
    floated, because everything below it -- the producer line, the case rule --
    is positioned against the foot of the label. Long declarations are absorbed
    by type size instead.
    """
    text = escape(text) or "Not recorded"
    body = f"ALLERGENS: {text}"
    # The matrix records which allergens a product may carry from
    # cross-contact, so where it names them the label names them too. Naming
    # one does not narrow the statement: the line still ends "and other
    # allergens", because the matrix names the ones that are known about
    # rather than every one that is possible (Dean, 2026-09-01).
    may = escape(may_contain)
    disclaimer = (f"May contain {may} and other allergens" if may
                  else "May contain other allergens")
    # A case label gives up two dots of box to the rule and case line at its
    # foot, which is the only geometric difference between the two variants.
    top, box_h = (288, 50) if is_case else (292, 52)
    box_w = INNER
    inner_w = box_w - 32
    size, lines = _shrink_to_one_line(body, inner_w, [24, 22, 20, 18, 17])
    if lines > 1:
        warnings.append(
            f"The allergen declaration is too long for one line even at 17 "
            f"dots, so it wraps to two and the box grows upward into the row "
            f"above. Render the label before printing it.")
        box_h = 66
        top = (338 if is_case else 346) - box_h
    out = [
        f"^FO{MARGIN},{top}^GB{box_w},{box_h},2^FS",
        f"^FO{MARGIN + 16},{top + 6}^A0N,{size},0"
        f"^FB{inner_w},{lines},0,L^FD{body}^FS",
        f"^FO{MARGIN + 16},{top + 6 + lines * (size + 2)}^A0N,17"
        f"^FB{inner_w},1,0,L^FD{disclaimer}^FS",
    ]
    return out


def _label_allergen_block(text, top, warnings):
    """The internal version: a heading and one line, in the compact type the
    handwritten forms these replace used."""
    text = escape(text) or "Not recorded"
    box_w = INNER
    inner_w = box_w - 32
    size, lines = _shrink_to_one_line(text, inner_w, [20, 18, 16])
    if lines > 1:
        warnings.append(
            "The allergen line does not fit at the smallest size and will "
            "wrap onto itself. Shorten it.")
        lines = 1
    box_h = 6 + 20 + size + 2 + 4
    out = [
        f"^FO{MARGIN},{top}^GB{box_w},{box_h},2^FS",
        f"^FO{MARGIN + 16},{top + 6}^A0N,20^FDALLERGENS^FS",
        f"^FO{MARGIN + 16},{top + 28}^A0N,{size}"
        f"^FB{inner_w},1,0,L^FD{text}^FS",
    ]
    return out


def _warn_name(name, warnings):
    if not fits(escape(name), NAME_HEIGHT):
        warnings.append(
            f"'{name}' is about {text_width(escape(name), NAME_HEIGHT)} dots wide "
            f"at {NAME_HEIGHT}, over the {INNER} available. It will be clipped at "
            f"the right-hand edge; shorten the name rather than the type size.")


def goods_in(*, name, use_by, batch, supplier, delivered, allergens,
             storage, quantity=1):
    """The intake label. Replaces the handwritten Goods In form."""
    warnings = []
    _warn_name(name, warnings)
    banner = STORAGE_BANNER.get(storage, "")
    if not banner:
        warnings.append(
            "No storage requirement recorded for this item, so the label "
            "carries no storage banner. The catalog is where that gets fixed.")

    out = _head(quantity)
    out += [
        f"^FO{MARGIN},42^A0N,20^FDGOODS IN^FS",
        f"^FO500,42^A0N,20^FB272,1,0,R^FD{banner}\\&^FS",
        f"^FO{MARGIN},72^A0N,{NAME_HEIGHT}^FD{escape(name)}^FS",
        f"^FO{MARGIN},126^GB{INNER},0,4^FS",
        "",
        f"^FO{MARGIN},142^A0N,20^FDUSE BY^FS",
    ]
    # The use-by on a delivery belongs to the supplier's own box, and most
    # arrive with one printed on them. Where nobody has typed a date in, the
    # label says where to look rather than leaving a blank that reads as a
    # date somebody forgot. The words are set smaller than a date would be:
    # they are an instruction, not the answer, and at 42 dots they would run
    # into the batch beside them.
    if escape(use_by):
        out += [f"^FO{MARGIN},166^A0N,42^FD{escape(use_by)}^FS"]
    else:
        out += [f"^FO{MARGIN},174^A0N,28^FDSee product packaging^FS"]
    out += [
        "",
        "^FO420,142^A0N,20^FDBATCH^FS",
        f"^FO420,166^A0N,42^FD{escape(batch)}^FS",
        "",
        f"^FT{MARGIN},242^A0N,20^FDSupplier^FS",
        f"^FT190,242^A0N,26^FD{escape(supplier)}^FS",
        f"^FT{MARGIN},276^A0N,20^FDDelivered^FS",
        f"^FT190,276^A0N,26^FD{escape(delivered)}^FS",
        "",
    ]
    out += _label_allergen_block(allergens, 292, warnings)
    out += ["", f"^PQ{int(quantity)}", "^XZ"]
    return "\n".join(out) + "\n", warnings


def date_opened(*, name, opened, use_by, batch, allergens, storage_opened,
                quantity=1):
    """Applied when a container is opened or its contents decanted.

    The border round the whole label is what tells this apart from Goods In
    across a room; the two sit on the same shelves on the same containers and
    are the pair that actually gets confused.
    """
    warnings = []
    _warn_name(name, warnings)
    banner = STORAGE_BANNER.get(storage_opened, "")
    footer = OPENED_FOOTER.get(storage_opened)
    if not footer:
        footer = "KEEP SEALED"
        warnings.append(
            "No after-opening storage recorded for this item, so the label "
            "gives no storage instruction. Putting an opened pack back in the "
            "wrong place is what this label exists to prevent -- fill "
            "storage_opened in the catalog.")

    out = _head(quantity)
    out += [
        f"^FO0,0^GB{WIDTH},{HEIGHT},8^FS",
        "",
        f"^FO{MARGIN},42^A0N,20^FDOPENED^FS",
        f"^FO500,42^A0N,20^FB272,1,0,R^FD{banner}\\&^FS",
        f"^FO{MARGIN},72^A0N,{NAME_HEIGHT}^FD{escape(name)}^FS",
        f"^FO{MARGIN},126^GB{INNER},0,4^FS",
        "",
        f"^FO{MARGIN},142^A0N,20^FDOPENED^FS",
        f"^FO{MARGIN},166^A0N,42^FD{escape(opened)}^FS",
        "",
        "^FO420,142^A0N,20^FDUSE BY^FS",
        f"^FO420,166^A0N,42^FD{escape(use_by)}^FS",
        "",
        f"^FT{MARGIN},244^A0N,20^FDBatch^FS",
        f"^FT190,244^A0N,26^FD{escape(batch)}^FS",
        "",
    ]
    out += _label_allergen_block(allergens, 258, warnings)
    out += [
        "",
        f"^FO{MARGIN},344^A0N,20^FB{INNER},1,0,C^FD{escape(footer)}\\&^FS",
        "",
        f"^PQ{int(quantity)}",
        "^XZ",
    ]
    return "\n".join(out) + "\n", warnings


def product(*, name, use_by, batch, packed, qty, sku, allergens, producer,
            may_contain="", barcode="", health_mark=False, hm_country="GB",
            hm_code="", is_case=False, quantity=1):
    """The customer-facing product label, packet and case from one layout.

    The QR encodes the SKU. Once the trace endpoint exists it should carry a
    URL that resolves to the batch record, so any phone camera reaches it
    without an app -- but not before that page is live, because a dead link on
    a customer's packet is worse than no link.

    The oval health mark is conditional and follows animal origin, so with the
    mark absent the SKU moves up into the space it occupied. The case version
    adds a rule and a case line at the foot; that plus the quantity is the only
    difference between the two, which is accepted as the weakest of the four
    distinctions because a pouch and a case are not easily confused.
    """
    warnings = []
    _warn_name(name, warnings)
    if health_mark and not hm_code:
        warnings.append(
            "The health mark oval is on but no approval number is set, so the "
            "oval would print empty. Set health_mark_code in label-data.json.")

    out = _head(quantity)
    out += [
        f"^FO{MARGIN},42^A0N,{NAME_HEIGHT}^FD{escape(name)}^FS",
        f"^FO{MARGIN},96^GB{INNER},0,4^FS",
        "",
        f"^FO{MARGIN},112^A0N,20^FDUSE BY^FS",
        f"^FO{MARGIN},136^A0N,42^FD{escape(use_by)}^FS",
        "",
        "^FO450,112^A0N,20^FDBATCH^FS",
        f"^FO450,136^A0N,42^FD{escape(batch)}^FS",
        "",
        f"^FT{MARGIN},222^A0N,22^FDPacked^FS",
        f"^FT180,222^A0N,30^FD{escape(packed)}^FS",
    ]
    # A caption with nothing after it reads as a label that failed to print
    # rather than as a pack size nobody states, so the whole row goes.
    if escape(qty):
        out += [
            f"^FT{MARGIN},256^A0N,22^FDQty^FS",
            f"^FT180,256^A0N,30^FD{escape(qty)}^FS",
        ]
    out += [""]
    # A barcode needs the whole lower right of the label, so the health mark
    # moves up beside the batch, where a product without a barcode has its QR.
    # Nothing else shifts: the dates and the allergen box stay where they are
    # on every label, which is what lets the four be read as one family.
    oval_x, oval_y = (612, 112) if barcode else (450, 196)
    if health_mark:
        out += [
            f"^FO{oval_x},{oval_y}^GE150,58,3^FS",
            f"^FO{oval_x},{oval_y + 6}^A0N,19^FB150,1,0,C"
            f"^FD{escape(hm_country)}\\&^FS",
            f"^FO{oval_x},{oval_y + 28}^A0N,19^FB150,1,0,C"
            f"^FD{escape(hm_code)}\\&^FS",
        ]
        if not barcode:
            out += [f"^FO447,262^A0N,17^FB156,1,0,C^FD{escape(sku)}\\&^FS"]
    elif not barcode:
        # With no oval, the SKU rises into the space it would have occupied.
        out += [f"^FO450,192^A0N,20^FD{escape(sku)}^FS"]
    # The QR carries the SKU, which is the only thing on the label that
    # resolves to something today: there is no trace endpoint for a batch code
    # to point at yet, and a code that scans to nothing is worse than no code.
    # A product sold without a SKU therefore carries no QR at all rather than
    # one encoding a blank.
    # A registered retail barcode is what a till reads, so where there is one
    # it takes the place of the QR rather than sitting beside it. Two symbols
    # on a small label invites scanning the wrong one.
    if barcode:
        field = ean13(barcode, 470, 190, 76, warnings)
    else:
        field = qr_field(escape(sku), 622, 110, warnings) if escape(sku) else ""
    out += ["", field, ""] if field else [""]

    out += _allergen_block(allergens, warnings, is_case=is_case,
                           may_contain=may_contain)
    out += [""]

    if is_case:
        foot = (f"CASE  -  {escape(qty).upper()}   |   {escape(producer)}"
                if escape(qty) else f"CASE   |   {escape(producer)}")
        out += [
            f"^FO{MARGIN},338^GB{INNER},0,3^FS",
            f"^FO{MARGIN},346^A0N,16^FB{INNER},1,0,C^FD{foot}\\&^FS",
        ]
    else:
        out += [
            f"^FO{MARGIN},350^A0N,16^FB{INNER},1,0,C"
            f"^FDProduced by: {escape(producer)}\\&^FS",
        ]
    out += ["", f"^PQ{int(quantity)}", "^XZ"]
    return "\n".join(out) + "\n", warnings


BUILDERS = {
    "goods-in": goods_in,
    "date-opened": date_opened,
    "packet": product,
    "box": product,
}
