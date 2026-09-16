// A minimal, standalone ZPL builder for the one label this form prints
// automatically: the Goods In case label, carrying the lot's real short
// code and a QR for it.
//
// Deliberately separate from labels/gui's zpl.py/server.py (Dean,
// 2026-09-16) rather than sharing it. Two honest reasons, not just a
// boundary drawn for its own sake:
//
//   - labels/gui is the hand-operated tool for all five label types,
//     including the ones this form has nothing to do with (Date Opened,
//     Product Packet/Box, Notice). Auto-printing from a line add should not
//     be able to affect that tool's own behaviour.
//   - This form's own data does not carry allergens or a health mark — the
//     trace catalog does not hold either yet (PLAN.md, open item 2:
//     "Allergens and the health mark belong in the trace catalog... which is
//     still label-data.json's job"). A label built from what trace actually
//     knows is therefore a case label with a code, not the compliance label
//     labels/gui prints. Building it separately keeps that honest instead of
//     silently omitting a field a shared template expects.
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

export function buildGoodsInLabel({
  name, shortCode, batch, useBy, delivered, supplier, quantity = 1,
}) {
  const safeName = escapeZpl(name);
  const safeCode = escapeZpl(shortCode).toUpperCase();
  const safeBatch = escapeZpl(batch);
  const safeSupplier = escapeZpl(supplier);
  const safeDelivered = escapeZpl(delivered);
  const useByText = useBy ? escapeZpl(useBy) : '';

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
    '',
    `^PQ${Math.max(1, Math.round(quantity))}`,
    '^XZ',
  );
  return lines.join('\n');
}
