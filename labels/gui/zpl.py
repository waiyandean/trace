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

# The three-line storage note in the top right of a Desserts label, matching
# the sample artwork's "Storage: / Keep Frozen / below -18C" (Dean,
# 2026-09-23). ^CI28 puts the printer in UTF-8, so the degree sign prints as
# itself rather than needing a workaround. Every dessert today is frozen; the
# other two entries exist so a chilled or ambient line does not have to
# invent a layout from scratch if one is ever added.
DESSERT_STORAGE_NOTE = {
    "freezer": ("Keep Frozen", "below -18°C"),
    "chill": ("Keep Chilled", "0-5°C"),
    "ambient": ("Keep Ambient", "Cool, dry place"),
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


def _warn_name(name, warnings, width=INNER):
    if not fits(escape(name), NAME_HEIGHT, width):
        warnings.append(
            f"'{name}' is about {text_width(escape(name), NAME_HEIGHT)} dots wide "
            f"at {NAME_HEIGHT}, over the {width} available. It will be clipped at "
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
        # Use by and batch take the big row, in the same places they occupy
        # on the Goods In label, so the two read the same way round. They are
        # what the label is consulted for: how long is this good, and which
        # batch does the production record point at. The date it was opened
        # matters less once the use-by has been worked out from it, so it
        # drops to the small row underneath.
        f"^FO{MARGIN},142^A0N,20^FDUSE BY^FS",
        f"^FO{MARGIN},166^A0N,42^FD{escape(use_by)}^FS",
        "",
        "^FO420,142^A0N,20^FDBATCH^FS",
        f"^FO420,166^A0N,42^FD{escape(batch)}^FS",
        "",
        f"^FT{MARGIN},244^A0N,20^FDOpened^FS",
        f"^FT190,244^A0N,28^FD{escape(opened)}^FS",
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


def _row(y, label, value, size, warnings, note=""):
    """One "Label: value" line, shrunk to fit rather than overprinting.

    Unlike the caption-over-big-value rows the other four formats use, the
    sample artwork this type replicates prints the label and its value at the
    same size on one line, so there is only one row shape here rather than
    two.
    """
    text = f"{label}: {escape(value) or 'Not recorded'}"
    fitted, lines = _shrink_to_one_line(text, INNER, [size, size - 2, size - 4,
                                                       size - 6, size - 8])
    if lines > 1:
        warnings.append(
            f"'{text}' does not fit on one line even at {size - 8} dots"
            f"{' (' + note + ')' if note else ''}, so it wraps and may draw "
            f"over the row below. Shorten it.")
    return f"^FO{MARGIN},{y}^A0N,{fitted}^FD{text}^FS"


def dessert(*, name, contents, produced, use_by, net_weight, allergens,
            storage="freezer", quantity=1):
    """The frozen dessert tub label: Brownie, Creme Brulee and whatever else

    follows them. Replaces the hand-written MR019/MR020 artwork (Dean,
    2026-09-23) -- the 'MR' code and the 'M&R' prefix are both dropped, the
    same decision already made for every other product on 2026-09-01.

    No batch code, SKU, QR or health mark: the sample artwork carries none of
    them, and this label prints Produced and Use By as a month and year
    rather than a day, which the other four formats never do -- the caller is
    responsible for that formatting (see server.py's month_year()), the same
    way it hands use_by/packed to the other builders already formatted as
    dd/mm/yyyy.
    """
    warnings = []
    note = DESSERT_STORAGE_NOTE.get(storage, DESSERT_STORAGE_NOTE["freezer"])
    if storage not in DESSERT_STORAGE_NOTE:
        warnings.append(
            f"No storage note recorded for '{storage}', so the label falls "
            f"back to the freezer instruction. Add it to "
            f"zpl.DESSERT_STORAGE_NOTE.")

    # The storage note sits top right and the name has to stay clear of it,
    # the same way a product's variant chip carves into the name's width.
    note_w = max(text_width("Storage:", 16),
                 text_width(note[0], 16), text_width(note[1], 16)) + 16
    _warn_name(name, warnings, INNER - note_w - 16)

    out = _head(quantity)
    out += [
        f"^FO{MARGIN},42^A0N,{NAME_HEIGHT}^FD{escape(name)}^FS",
        f"^FO{MARGIN},100^GB{INNER},0,4^FS",
        "",
        f"^FO{WIDTH - MARGIN - note_w},40^A0N,16^FB{note_w},1,0,R^FDStorage:\\&^FS",
        f"^FO{WIDTH - MARGIN - note_w},60^A0N,16^FB{note_w},1,0,R^FD{note[0]}\\&^FS",
        f"^FO{WIDTH - MARGIN - note_w},80^A0N,16^FB{note_w},1,0,R^FD{note[1]}\\&^FS",
        "",
        _row(116, "Contents", contents, 28, warnings),
        _row(154, "Produced", produced, 28, warnings),
        _row(192, "Use by", use_by, 28, warnings),
        "",
        _row(238, "Net Weight", net_weight, 28, warnings),
        _row(276, "Allergens", allergens, 28, warnings,
             note="the allergen declaration"),
        "",
        f"^PQ{int(quantity)}",
        "^XZ",
    ]
    return "\n".join(out) + "\n", warnings


def variant_tag(words, warnings):
    """A reversed chip naming a variant, for two products that look alike.

    Tonkotsu broth and the diluted version of it are the same colour in the
    same pouch, and serving one for the other is a mistake nobody catches by
    reading carefully -- so the distinction has to survive being glanced at
    from across a room, which a word in the product name does not.

    Reversed type in a solid band was tried for the four label types and
    dropped at 41-48% black. This is one chip of about 240 by 40 dots, under
    three per cent of the label, so it buys the loudest device available for
    almost none of the ink that made the earlier attempt untenable.
    """
    text = escape(words).upper()
    if not text:
        return []
    width = text_width(text, 30) + 40
    if width > 320:
        warnings.append(
            f"'{text}' is too long for the variant tag, which has to sit "
            f"beside the product name. One or two words.")
        return []
    x = WIDTH - MARGIN - width
    return [
        f"^FO{x},44^GB{width},40,40^FS",
        f"^FR^FO{x},49^A0N,30,0^FB{width},1,0,C^FD{text}^FS",
    ]


def name_bar(name, sub, warnings):
    """The whole name row as a solid black band, for a third look-alike.

    variant_tag is the right weight for one look-alike, but a second product
    carrying a second chip in the same corner reads as the same label from
    across a room: the chip's position and shape are the signal, not the word
    in it. A trial variant that must be told apart from both the standard broth
    and the diluted one therefore takes a different silhouette -- the name row
    goes to a black band, which cannot be confused with the plain label's open
    top or with a cornered chip.

    It is about 45,000 dots of black, an eighth of the label, against the
    41-48% that made a full reversed band untenable for the four base formats.
    The band stands in for the name and the divider rule beneath it; its lower
    edge is the divider.

    The variant text sits reversed against the right edge of the band, in the
    same place the diluted chip sits on that label, so the eye lands on the
    same spot to read which broth this is whichever of the three it has.
    """
    name = escape(name)
    sub = escape(sub).upper()
    top, height = 40, 62
    inset = MARGIN + 14
    out = [f"^FO{MARGIN},{top}^GB{INNER},{height},{height}^FS"]
    if not sub:
        out.append(f"^FR^FO{inset},{top + (height - 40) // 2}^A0N,40^FD{name}^FS")
        return out
    # The variant text is right-aligned in its own block against the band's
    # right edge, in the same place the diluted chip sits on that label, so
    # the eye lands on the same spot on all three broths. The name takes what
    # is left of the row beside it; where it will not fit there -- only ever a
    # name much longer than the "Tonkotsu Broth" the band is built for -- the
    # variant text drops to a second line so the two never collide.
    sub_w = text_width(sub, 30) + 24
    if fits(name, 40, INNER - 28 - sub_w - 24):
        out.append(
            f"^FR^FO{inset},{top + (height - 40) // 2}^A0N,40^FD{name}^FS")
        out.append(
            f"^FR^FO{WIDTH - MARGIN - 14 - sub_w},{top + (height - 30) // 2}"
            f"^A0N,30,0^FB{sub_w},1,0,C^FD{sub}^FS")
    else:
        warnings.append(
            f"'{name}' is too wide to sit beside the variant text on the band, "
            f"so the text drops to a second line. The band is built for the "
            f"'Tonkotsu Broth' name -- shorten it.")
        out.append(f"^FR^FO{inset},{top + 3}^A0N,34^FD{name}^FS")
        out.append(f"^FR^FO{inset},{top + height - 22}^A0N,15^FD{sub}^FS")
    return out


def product(*, name, use_by, batch, packed, qty, sku, allergens, producer,
            may_contain="", barcode="", tag="", bar="", health_mark=False,
            hm_country="GB", hm_code="", is_case=False, quantity=1):
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
    # The chip eats into the room the name has, so the name is measured
    # against what is left rather than the full width. The band takes the whole
    # row and does its own width check, so neither applies with `bar` set.
    if not bar:
        chip_width = (text_width(escape(tag).upper(), 30) + 60) if escape(tag) else 0
        _warn_name(name, warnings, INNER - chip_width)
    if health_mark and not hm_code:
        warnings.append(
            "The health mark oval is on but no approval number is set, so the "
            "oval would print empty. Set health_mark_code in label-data.json.")

    out = _head(quantity)
    if bar:
        out += name_bar(name, bar, warnings)
    else:
        out += variant_tag(tag, warnings)
        out += [
            f"^FO{MARGIN},42^A0N,{NAME_HEIGHT}^FD{escape(name)}^FS",
            f"^FO{MARGIN},96^GB{INNER},0,4^FS",
        ]
    out += [
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


# Sizes a free-text label is allowed to use, largest first. Below about 30
# dots the text stops being readable across a room, which is the only reason
# this label exists, so the smallest is a floor rather than a last resort.
NOTICE_SIZES = (150, 130, 110, 94, 80, 68, 58, 50, 44, 38, 32)


# How much of the line the wrap simulation is allowed to fill. The character
# width used here is an average, and at large sizes it ran about four per cent
# under -- enough for "DO NOT USE" to be predicted as one line, given one line
# to draw in, and printed as two on top of each other. ^FB does not truncate.
# Ten per cent held back costs a little size and makes that failure need a
# much worse estimate than any yet seen.
NOTICE_FIT = 0.90


def wrapped_lines(words, height, width=INNER):
    """How many lines ^FB will break this into, packing greedily as it does.

    Counting from the total width alone is not enough: a block that needs one
    more line than it is given draws the overflow on top of the line above,
    and it is what the text does at the end of each line that decides how many
    it needs. The character width used here is held wider than measured, so
    this errs toward predicting an extra line rather than one too few.
    """
    lines, current = 1, 0
    width = int(width * NOTICE_FIT)
    space = text_width(" ", height)
    for word in words.split():
        word_width = text_width(word, height)
        if current and current + space + word_width > width:
            lines += 1
            current = word_width
        else:
            current += (space if current else 0) + word_width
    return lines


def wrap_text(words, height, width=INNER):
    """The same greedy wrap as wrapped_lines(), returning the actual line
    strings rather than just how many there are."""
    width = int(width * NOTICE_FIT)
    space = text_width(" ", height)
    pieces = words.split()
    if not pieces:
        return [""]
    lines, current, current_width = [], [], 0
    for word in pieces:
        word_width = text_width(word, height)
        if current and current_width + space + word_width > width:
            lines.append(" ".join(current))
            current, current_width = [word], word_width
        else:
            current_width += (space if current else 0) + word_width
            current.append(word)
    lines.append(" ".join(current))
    return lines


def notice(*, text, quantity=1):
    """A label that is nothing but words, set as large as they will go.

    For the things that do not fit any of the other four: a warning on a
    container, a note on a shelf, a sign on a door. There is no catalog behind
    it and nothing derived -- somebody types what it should say.

    Deliberately no border, even though a warning is the obvious case for one.
    The border round the whole label is what tells Date Opened from Goods In
    across a room, and spending it on a second thing takes that distinction
    away from the pair that actually gets confused.

    A line break typed into the textarea prints as one. The obvious way to
    do that is ZPL's own \\& line-break escape inside a single multi-line
    ^FB -- but that left every line after the first centred around a
    different point than the first (measured, on identical text, a visible
    few dots off). Giving each visual line its own single-line ^FB instead
    means each one is centred with nothing before it to throw the
    justification off.
    """
    warnings = []
    raw = escape(text)
    if not raw:
        warnings.append("There is nothing to print on this label.")
    paragraphs = raw.split("\n")

    available = HEIGHT - 2 * MARGIN
    for height in NOTICE_SIZES:
        gap = max(2, height // 8)
        # ^FB wraps on whole words, so a long word can leave a line short and
        # push the count up. Estimating from the total width alone would then
        # under-count, and a block that needs one more line than it is allowed
        # draws the overflow on top of the line above rather than truncating.
        longest = max((text_width(word, height)
                       for p in paragraphs for word in p.split()), default=0)
        if longest > INNER:
            continue
        # Two counts, for two different jobs. The cautious one decides how
        # many lines are drawn, so an under-estimate cannot overprint. The
        # likely one decides where the block is centred, because centring on
        # a line that usually is not there leaves every notice sitting high
        # on the label. Each typed line is wrapped on its own, then summed,
        # so a forced break always costs at least one line even if short.
        visual_lines = [line for p in paragraphs for line in wrap_text(p, height)]
        lines = len(visual_lines)
        likely = sum(wrapped_lines(p, height, INNER / NOTICE_FIT) for p in paragraphs)
        block = lines * height + (lines - 1) * gap
        if block <= available:
            break
    else:
        height, gap = NOTICE_SIZES[-1], 4
        visual_lines = [line for p in paragraphs for line in wrap_text(p, height)]
        lines = likely = len(visual_lines)
        warnings.append(
            "That does not fit on a label even at the smallest size, so it "
            "will be cut off. Say it in fewer words.")
        block = lines * height + (lines - 1) * gap

    centred = likely * height + (likely - 1) * gap
    top = MARGIN + (available - centred) // 2
    # If it does take the cautious number of lines after all, it still has to
    # stay above the bottom margin.
    top = min(top, MARGIN + available - block)
    rows = [
        f"^FO{MARGIN},{top + i * (height + gap)}^A0N,{height},0"
        f"^FB{INNER},1,0,C^FD{line}^FS"
        for i, line in enumerate(visual_lines)
    ]
    return "\n".join(_head(quantity) + rows + [
        "",
        f"^PQ{int(quantity)}",
        "^XZ",
    ]) + "\n", warnings


BUILDERS = {
    "goods-in": goods_in,
    "date-opened": date_opened,
    "packet": product,
    "box": product,
    "notice": notice,
    "dessert": dessert,
}
