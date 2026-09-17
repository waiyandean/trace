// A standalone ZPL builder for the labels the trace forms print
// automatically: Goods In's case label and P3's packet label, each carrying
// the lot's real short code and a QR for it.
//
// Deliberately separate code from labels/gui's zpl.py/server.py (Dean,
// 2026-09-16) rather than sharing it, even though buildPackingLabel is laid
// out to match labels/gui's product() field for field on Dean's request —
// looking the same and sharing the module that draws it are different
// questions. Two honest reasons for the separation, not just a boundary
// drawn for its own sake:
//
//   - labels/gui is the hand-operated tool for all five label types,
//     including the ones this form has nothing to do with (Date Opened,
//     Product Packet/Box, Notice). Auto-printing from a line add should not
//     be able to affect that tool's own behaviour.
//   - This form's own data does not carry allergens — the trace catalog does
//     not hold them yet (PLAN.md, open item 2: "Allergens and the health
//     mark belong in the trace catalog... which is still label-data.json's
//     job"). The catalog does carry needs_health_mark, though (it always
//     has — the earlier version of this comment was wrong to lump the two
//     together), so the oval below is real, not a placeholder. A label built
//     from what trace actually knows is a case label with a code and,
//     where the item calls for it, the mark — not the full compliance label
//     labels/gui prints, which also carries the allergen box this cannot.
//
// Physical stock is the same 100x50mm (812x406 dots at 203dpi) as every
// other label in the kitchen (HANDOFF.md, 2026-08-28).

const WIDTH = 812;
const HEIGHT = 406;
const MARGIN = 40;

// ^ and ~ are ZPL's command prefixes; a value containing either would be read
// as markup rather than data. \ is the field-data escape character. Mirrors
// zpl.py's escape() (labels/gui), which this file otherwise shares nothing
// with.
function escapeZpl(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\\/g, ' ').replace(/\^/g, ' ').replace(/~/g, ' ').trim();
}

// The short code is always six characters from a fixed alphabet with no
// ambiguous glyphs (PLAN.md, "Lot identity and short codes"), so unlike
// labels/gui's SKU/allergen QRs this payload's length never varies enough to
// need the fit-estimating logic that lives there — magnification 6 always
// has room.
const QR_MAGNIFICATION = 6;

// Every date on the label prints dd/mm/yyyy, not the yyyy-mm-dd every date
// arrives in from the ledger (Dean, 2026-09-16) — matches labels/gui's own
// existing compliance label exactly, checked side by side against a real
// printed Chicken Broth label. Anything that is not a plain YYYY-MM-DD (a
// typo, an empty string) is passed through rather than mangled — a
// wrong-looking date is a smaller failure than one silently dropped.
function ukDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return match ? `${match[3]}/${match[2]}/${match[1]}` : (iso || '');
}

// The oval health mark's approval number. Trace's catalog can say *whether*
// an item needs the mark (items.needs_health_mark), but nothing holds the
// number that goes inside the oval itself, so it is hardcoded here rather
// than threaded through from the ledger — editable in one place, deliberately,
// not buried in the drawing code below (Dean, 2026-09-16).
const HEALTH_MARK_COUNTRY = 'GB';
const HEALTH_MARK_CODE = 'GA 121';

// The address on every label, whoever made it — a genuinely global fact,
// unlike allergens below, so one hardcoded constant is honest rather than a
// stand-in (Dean, 2026-09-16, matching the printed label checked against).
const PRODUCER = 'AAHQ LTD, 90 Renfield Street, Glasgow';

// Allergens are per-product, not global, and trace's catalog does not carry
// them yet (PLAN.md, open item 2 — they live in labels/gui's Allergen Matrix
// import). Reusing one hardcoded string for every product the way PRODUCER
// and the health mark work would be actively wrong: a product with different
// allergens would print somebody else's. So this is a small, explicitly
// incomplete lookup by product name, filled in as each is checked against
// the matrix — anything absent from it prints "Not recorded" rather than a
// guess, the same fallback labels/gui's own allergen box uses.
const ALLERGENS = {
  'Chicken Broth': { declared: 'Gluten, Sesame, Soya', mayContain: 'Peanuts' },
};

function allergenInfo(name) {
  return ALLERGENS[name] || null;
}

// What one pack holds — a fixed property of the product, not something a
// batch's actual yield should be read backward into (a 40 L batch into 20
// packets averages 2.0 L, not the 1.8 L the pouch is actually specced to;
// printing the derived figure would drift batch to batch around a number
// that is not supposed to move at all). Same shape as ALLERGENS: a small,
// explicitly incomplete lookup, filled in as each is confirmed, with the
// whole row left out rather than shown empty for anything not yet in it —
// mirrors labels/gui's own rule that a caption with nothing after it reads
// as a label that failed to print.
const PACK_SIZES = {
  'Chicken Broth': '1.8 Litres',
};

function packSize(name) {
  return PACK_SIZES[name] || '';
}

// Wording for the Date Opened label's banner and footer, keyed by the
// item's after-opening storage requirement — the same two lookups
// labels/gui's own date_opened() uses (STORAGE_BANNER, OPENED_FOOTER in
// zpl.py). Plain vocabulary, not per-product data, so unlike ALLERGENS and
// PACK_SIZES these are complete rather than a lookup filled in over time.
const STORAGE_BANNER = { ambient: 'AMBIENT', chill: 'CHILLED', freezer: 'FROZEN' };
const OPENED_FOOTER = {
  ambient: 'KEEP SEALED — STORE IN A COOL DRY PLACE',
  chill: 'REFRIGERATE AFTER OPENING — KEEP SEALED',
  freezer: 'KEEP FROZEN — DO NOT REFREEZE',
};

// The ellipse and its two lines of text, mirroring labels/gui's product()
// (zpl.py) — same dimensions, same two-line layout, country above the
// approval number. Placed under the QR here rather than beside the batch,
// since this label's QR already occupies the same corner labels/gui's oval
// goes in; there is no barcode on this label competing for the space either.
function healthMarkOval(x, y) {
  return [
    `^FO${x},${y}^GE150,58,3^FS`,
    // More top padding than labels/gui's own y+6 — checked against a real
    // print, the country line was touching the oval's border there.
    `^FO${x},${y + 12}^A0N,19^FB150,1,0,C^FD${HEALTH_MARK_COUNTRY}\\&^FS`,
    `^FO${x},${y + 34}^A0N,19^FB150,1,0,C^FD${HEALTH_MARK_CODE}\\&^FS`,
  ];
}

// The bordered allergen box and disclaimer, at labels/gui's own coordinates
// (MARGIN,292, width INNER, height 52) so it sits directly under whatever
// this label already draws above it without measuring anything — everything
// on this label ends by y286, comfortably clear of y292.
//
// One fixed text size rather than labels/gui's shrink-to-fit search: the
// only declaration this file knows is short enough that the largest size
// always fits, and a second product added to ALLERGENS above should be
// checked against a real render (check_layouts.py-style) before trusting a
// longer one to fit unmeasured.
function allergenBox(declared, mayContain) {
  const top = 292;
  const boxWidth = WIDTH - 2 * MARGIN;
  const innerWidth = boxWidth - 32;
  const body = `ALLERGENS: ${escapeZpl(declared) || 'Not recorded'}`;
  const disclaimer = mayContain
    ? `May contain ${escapeZpl(mayContain)} and other allergens`
    : 'May contain other allergens';
  return [
    `^FO${MARGIN},${top}^GB${boxWidth},52,2^FS`,
    `^FO${MARGIN + 16},${top + 6}^A0N,24,0^FB${innerWidth},1,0,L^FD${body}^FS`,
    `^FO${MARGIN + 16},${top + 30}^A0N,17,0^FB${innerWidth},1,0,L^FD${disclaimer}^FS`,
  ];
}

export function buildGoodsInLabel({
  name, shortCode, batch, useBy, delivered, supplier, quantity = 1, healthMark = false,
}) {
  const safeName = escapeZpl(name);
  const safeCode = escapeZpl(shortCode).toUpperCase();
  const safeBatch = escapeZpl(batch);
  const safeSupplier = escapeZpl(supplier);
  const safeDelivered = escapeZpl(ukDate(delivered));
  const useByText = useBy ? escapeZpl(ukDate(useBy)) : '';

  const lines = [
    '^XA',
    `^PW${WIDTH}`,
    `^LL${HEIGHT}`,
    '^CI28',
    // Persistent printer state, not per-label — set explicitly on every
    // label or a size left behind by a previous one silently displaces this
    // QR (labels/README.md, the same trap that cost a morning there).
    '^BY2,3,10',
    '',
    `^FO${MARGIN},30^A0N,46,46^FD${safeName}^FS`,
    `^FO${MARGIN},84^GB${WIDTH - 2 * MARGIN},0,4^FS`,
    '',
    `^FO${MARGIN},104^A0N,22^FDCODE^FS`,
    `^FO${MARGIN},130^A0N,72,72^FD${safeCode}^FS`,
    '',
    `^FO560,98^BQN,2,${QR_MAGNIFICATION}^FDQA,${safeCode}^FS`,
    '',
    `^FO${MARGIN},228^A0N,20^FDUSE BY^FS`,
  ];
  // Left blank rather than printing a date nobody typed, the same rule
  // labels/gui's Goods In label follows.
  if (useByText) {
    lines.push(`^FO${MARGIN},252^A0N,38^FD${useByText}^FS`);
  } else {
    lines.push(`^FO${MARGIN},258^A0N,26^FDSee product packaging^FS`);
  }
  lines.push(
    '',
    `^FO420,228^A0N,20^FDBATCH^FS`,
    `^FO420,252^A0N,38^FD${safeBatch}^FS`,
    '',
    `^FT${MARGIN},320^A0N,20^FD${safeSupplier}^FS`,
    `^FT${MARGIN},346^A0N,18^FDDelivered ${safeDelivered}^FS`,
  );
  if (healthMark) lines.push('', ...healthMarkOval(592, 300));
  lines.push(
    '',
    `^PQ${Math.max(1, Math.round(quantity))}`,
    '^XZ',
  );
  return lines.join('\n');
}

// The P3 packet label, printed the moment a batch is packed out. Laid out to
// match labels/gui's own product() label field for field — same name row,
// same USE BY/BATCH positions, same Packed/Qty row, same health-mark oval
// slot — checked side by side against a real printed Chicken Broth label
// (Dean, 2026-09-16: "I don't want it looking different"). CODE does not
// take either of those rows: with Qty added, both are labels/gui's own
// fields at labels/gui's own positions, untouched, and CODE moves to a small
// caption directly under the QR instead — smaller still than the already-
// shrunk version Dean first asked for, and the natural place to put a code
// that belongs to the symbol above it.
//
// The allergen box and producer line are drawn too now (Dean, 2026-09-16),
// but honestly: trace's catalog still carries no allergen data (PLAN.md,
// open item 2), so the declaration comes from the small hardcoded ALLERGENS
// lookup above, filled in product by product, not from anything the ledger
// actually knows. A product not yet in that lookup prints "Not recorded"
// rather than nothing, the same fallback labels/gui's own box uses.
export function buildPackingLabel({
  name, shortCode, batch, useBy, packed, quantity = 1, healthMark = false,
}) {
  const safeName = escapeZpl(name);
  const safeCode = escapeZpl(shortCode).toUpperCase();
  const safeBatch = escapeZpl(batch);
  const safePacked = escapeZpl(ukDate(packed));
  const useByText = useBy ? escapeZpl(ukDate(useBy)) : '';

  const lines = [
    '^XA',
    `^PW${WIDTH}`,
    `^LL${HEIGHT}`,
    '^CI28',
    '^BY2,3,10',
    '',
    `^FO${MARGIN},42^A0N,44^FD${safeName}^FS`,
    `^FO${MARGIN},96^GB${WIDTH - 2 * MARGIN},0,4^FS`,
    '',
    `^FO${MARGIN},112^A0N,20^FDUSE BY^FS`,
  ];
  if (useByText) {
    lines.push(`^FO${MARGIN},136^A0N,42^FD${useByText}^FS`);
  } else {
    lines.push(`^FO${MARGIN},142^A0N,24^FDNo shelf life recorded^FS`);
  }
  lines.push(
    '',
    '^FO450,112^A0N,20^FDBATCH^FS',
    `^FO450,136^A0N,42^FD${safeBatch}^FS`,
    '',
    `^FT${MARGIN},222^A0N,22^FDPacked^FS`,
    `^FT180,222^A0N,30^FD${safePacked}^FS`,
  );
  const qty = packSize(name);
  if (qty) {
    lines.push(
      '',
      `^FT${MARGIN},256^A0N,22^FDQty^FS`,
      `^FT180,256^A0N,30^FD${escapeZpl(qty)}^FS`,
    );
  }
  lines.push(
    '',
    // Same corner labels/gui's SKU QR sits in (622,110), sized for the QR
    // alone — a short code is always shorter than the SKUs that spot was
    // built for, so the same magnification that suits Goods In's QR fits
    // here too, with room to spare.
    `^FO622,110^BQN,2,${QR_MAGNIFICATION}^FDQA,${safeCode}^FS`,
    // The human-readable code, small, centred under its own QR rather than a
    // full row of its own — the same width as the symbol above it.
    `^FO622,264^A0N,20^FB150,1,0,C^FD${safeCode}^FS`,
  );
  // Same slot labels/gui's oval uses when the label carries no barcode
  // (450,196) — this label never carries one, so it is always that slot.
  if (healthMark) lines.push('', ...healthMarkOval(450, 196));

  const allergens = allergenInfo(name);
  lines.push('', ...allergenBox(allergens?.declared, allergens?.mayContain));
  lines.push(
    '',
    `^FO${MARGIN},350^A0N,16^FB${WIDTH - 2 * MARGIN},1,0,C^FDProduced by: ${escapeZpl(PRODUCER)}^FS`,
    '',
    `^PQ${Math.max(1, Math.round(quantity))}`,
    '^XZ',
  );
  return lines.join('\n');
}

// The Date Opened label — applied when a container is opened or its
// contents decanted, so a part-used pack on the shelf carries its own
// use-by rather than relying on someone remembering when it was opened.
// PLAN.md's open item 4 settled the rule in P0 (items.opening_rule,
// days_after_opening) and named the event itself — recording that a pack
// was opened, and printing something to put on it — as the piece still
// missing; nothing had built it (Dean, 2026-09-17).
//
// Laid out to match labels/gui's own date_opened(), the same way the P3
// packet label matches product(): the border around the whole label, USE
// BY/BATCH in the big row, the opened date underneath, the storage banner
// and footer instruction. Code and QR are new — labels/gui's version
// carries neither, from before lots existed to carry a QR to — placed in
// the same corner Goods In and the packet label use, for the same family
// resemblance the border already gives this pair across a room.
export function buildDateOpenedLabel({
  name, shortCode, batch, opened, useBy, storageOpened, quantity = 1,
}) {
  const safeName = escapeZpl(name);
  const safeCode = escapeZpl(shortCode).toUpperCase();
  const safeBatch = escapeZpl(batch);
  const safeOpened = escapeZpl(ukDate(opened));
  const useByText = useBy ? escapeZpl(ukDate(useBy)) : '';
  const banner = STORAGE_BANNER[storageOpened] || '';
  const footer = OPENED_FOOTER[storageOpened] || 'KEEP SEALED';

  const lines = [
    '^XA',
    `^PW${WIDTH}`,
    `^LL${HEIGHT}`,
    '^CI28',
    '^BY2,3,10',
    '',
    // The border is what tells this apart from Goods In across a room — the
    // two sit on the same shelves on the same containers and are the pair
    // that actually gets confused (labels/gui's own reasoning, unchanged).
    `^FO0,0^GB${WIDTH},${HEIGHT},8^FS`,
    '',
    `^FO${MARGIN},42^A0N,20^FDOPENED^FS`,
    `^FO500,42^A0N,20^FB272,1,0,R^FD${banner}^FS`,
    `^FO${MARGIN},72^A0N,44^FD${safeName}^FS`,
    `^FO${MARGIN},126^GB${WIDTH - 2 * MARGIN},0,4^FS`,
    '',
    `^FO${MARGIN},142^A0N,20^FDUSE BY^FS`,
  ];
  if (useByText) {
    lines.push(`^FO${MARGIN},166^A0N,42^FD${useByText}^FS`);
  } else {
    lines.push(`^FO${MARGIN},172^A0N,24^FDNo shelf life recorded^FS`);
  }
  lines.push(
    '',
    '^FO420,142^A0N,20^FDBATCH^FS',
    `^FO420,166^A0N,42^FD${safeBatch}^FS`,
    '',
    `^FT${MARGIN},244^A0N,20^FDOpened^FS`,
    `^FT190,244^A0N,28^FD${safeOpened}^FS`,
    '',
    // Shifted right of where the packet label's QR sits (622 vs 600): a
    // ddmmyy ingredient batch code at this font size runs close enough to
    // x560 that labels/gui's own QR corner would overlap it, checked by
    // measuring the widest real batch code this label prints.
    //
    // Below the divider (y126) rather than above it, at y140 to match where
    // the USE BY row starts — the first print put the QR at y98, which the
    // divider line at y96-126 cut straight through (Dean, 2026-09-17).
    `^FO600,140^BQN,2,${QR_MAGNIFICATION}^FDQA,${safeCode}^FS`,
    `^FO600,296^A0N,20^FB172,1,0,C^FD${safeCode}^FS`,
    '',
    `^FO${MARGIN},344^A0N,20^FB${WIDTH - 2 * MARGIN},1,0,C^FD${footer}^FS`,
    '',
    `^PQ${Math.max(1, Math.round(quantity))}`,
    '^XZ',
  );
  return lines.join('\n');
}
