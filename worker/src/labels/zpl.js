// Build the four label formats from field values.
//
// Ported from labels/gui/zpl.py, line for line where the logic allows it, so
// that the two stay easy to compare while both exist. See that file's own
// header for the reasoning behind the layouts; PLAN.md, "is it possible to
// host this on Cloudflare" covers why this copy exists in the Worker at all.
//
// Two deliberate differences from the hand-written labels in labels/:
//
//   * Goods In and Date Opened carry no lot code and no QR. Lots do not exist
//     yet in this tool's own record -- trace's ledger does, and its own
//     zpl.js (worker/public/lib/zpl.js) prints a real one. A QR encoding a
//     code that resolves to nothing is worse than no QR.
//   * The allergen box is sized from the length of its text rather than
//     fixed. A field block that overruns its width wraps and draws the
//     overflow on top of the line above -- ^FB does not truncate.
//
// Every format sets ^BY explicitly. It is persistent printer state, not a
// per-label setting, and a height left behind by a previous label silently
// displaces any QR that follows.

export const WIDTH = 812; // 4 inches at 203 dpi
export const HEIGHT = 406; // 2 inches
export const MARGIN = 40; // keep-out zone at every edge, 5 mm
export const INNER = WIDTH - 2 * MARGIN;

// Average advance of the resident condensed font, as a fraction of the
// character height, measured off real renders. Held a little wide so an
// estimate errs toward reporting a problem rather than missing one.
const CHAR_W = 0.47;

const NAME_HEIGHT = 44;

// Modules per side for QR versions 1-6, and how many alphanumeric characters
// each version holds at error-correction level H. Mirrors ../lint-zpl.py,
// including its one version of headroom: the printer's own encoder picks the
// version, and a symbol that comes out larger than predicted is the failure
// this guards against.
const QR_MODULES = { 1: 21, 2: 25, 3: 29, 4: 33, 5: 37, 6: 41 };
const QR_ALNUM_H = [10, 20, 35, 50, 64, 84];

// Level H, because these get read off a cold packet through condensation and
// through whatever the label has been dragged across. The magnification is
// chosen to fit rather than fixed; below 5 the symbol starts to struggle at
// 203 dpi, so dropping there is worth saying out loud.
const QR_ECC = 'H';
const QR_MAGNIFICATIONS = [6, 5, 4];
const QR_COMFORTABLE = 5;

const ALNUM_RE = /^[0-9A-Z $%*+\-./:]*$/;

function qrSide(data, magnification) {
  const alnum = ALNUM_RE.test(data);
  const caps = alnum ? QR_ALNUM_H : QR_ALNUM_H.map((c) => Math.floor((c * 2) / 3));
  for (let index = 0; index < caps.length; index++) {
    if (data.length <= caps[index]) return QR_MODULES[Math.min(index + 2, 6)] * magnification;
  }
  return QR_MODULES[6] * magnification;
}

function qrField(data, x, y, warnings) {
  const room = WIDTH - MARGIN - x;
  for (const magnification of QR_MAGNIFICATIONS) {
    if (qrSide(data, magnification) <= room) {
      if (magnification < QR_COMFORTABLE) {
        warnings.push(
          `The QR had to be printed at magnification ${magnification} to fit '${data}'. Below ` +
            `${QR_COMFORTABLE} it gets hard to read off a cold packet through condensation. A ` +
            'shorter code would be better than a smaller symbol.',
        );
      }
      return `^FO${x},${y}^BQN,2,${magnification}^FD${QR_ECC}A,${data}^FS`;
    }
  }
  warnings.push(`'${data}' is too long to fit a readable QR in the space beside the batch, so the label carries no QR.`);
  return '';
}

// An EAN-13 is 95 modules wide whatever it encodes, and ^BY2 makes a module
// two dots, so the bars are always 190 dots across. GS1 asks for a symbol at
// least 80% of nominal, which is about 146 dots tall; there is not that much
// room on a four-by-two label that also carries dates, a health mark and an
// allergen declaration, so the height here is what fits and the caller is
// told when that is short of the standard.
const EAN13_MIN_HEIGHT = 146;

function checkDigit(twelve) {
  let total = 0;
  for (let i = 0; i < twelve.length; i++) total += Number(twelve[i]) * (i % 2 ? 3 : 1);
  return (10 - (total % 10)) % 10;
}

function ean13(code, x, y, height, warnings) {
  const digits = String(code).replace(/\D/g, '');
  if (digits.length !== 12 && digits.length !== 13) {
    warnings.push(`'${code}' is not an EAN-13 -- it has ${digits.length} digits, not 13 -- so no barcode is printed.`);
    return '';
  }
  if (digits.length === 13 && Number(digits[12]) !== checkDigit(digits.slice(0, 12))) {
    warnings.push(
      `${digits} has the wrong check digit: the first twelve digits give ${checkDigit(digits.slice(0, 12))}, not ` +
        `${digits[12]}. No barcode is printed, because one that scans as another product is worse than none.`,
    );
    return '';
  }
  if (height < EAN13_MIN_HEIGHT) {
    warnings.push(
      `The barcode is ${height} dots tall (${Math.round(height / 8)} mm). GS1 asks for at least ` +
        `${EAN13_MIN_HEIGHT} (${Math.round(EAN13_MIN_HEIGHT / 8)} mm) at this width. A truncated symbol reads fine ` +
        'on most scanners and can be refused by a retailer, so check it against the till it has to pass.',
    );
  }
  return `^FO${x},${y}^BEN,${height},Y,N^FD${digits.slice(0, 12)}^FS`;
}

const STORAGE_BANNER = { ambient: 'AMBIENT', chill: 'CHILLED', freezer: 'FROZEN' };

// What the foot of a Date Opened label tells the person holding it. The
// instruction follows the item's after-opening storage requirement rather
// than being fixed, because printing "refrigerate after opening" on a bag of
// salt teaches staff to ignore the line.
const OPENED_FOOTER = {
  ambient: 'KEEP SEALED  -  STORE IN A COOL DRY PLACE',
  chill: 'REFRIGERATE AFTER OPENING  -  KEEP SEALED',
  freezer: 'KEEP FROZEN  -  DO NOT REFREEZE',
};

function textWidth(text, height) {
  return Math.floor(text.length * height * CHAR_W);
}

function fits(text, height, width = INNER) {
  return textWidth(text, height) <= width;
}

// Make a value safe to drop into a ^FD field. ^ and ~ are ZPL's command
// prefixes, so a value containing either would be read as markup and
// silently mangle the label. \ is the escape character within field data.
// null/undefined becomes an empty string rather than the word "null" or
// "undefined", which is the kind of thing that gets printed and stuck on a
// box.
function escape(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\\/g, ' ').replace(/\^/g, ' ').replace(/~/g, ' ').trim();
}

function head() {
  return ['^XA', `^PW${WIDTH}`, `^LL${HEIGHT}`, '^CI28', '^BY2,3,10', ''];
}

// The largest of `sizes` that fits `text` on one line, else the smallest. A
// field block that does not fit wraps and draws the overflow on top of the
// line above, so the choice is between a smaller size and an unreadable
// smear. Shrinking a declaration by two dots is the lesser harm, and the
// caller is told when even the smallest does not fit.
function shrinkToOneLine(text, width, sizes) {
  for (const size of sizes) {
    if (textWidth(text, size) <= width) return [size, 1];
  }
  return [sizes[sizes.length - 1], 2];
}

// The customer-facing allergen box: declaration and disclaimer, boxed.
// Geometry is held at the coordinates the printed artwork uses rather than
// floated, because everything below it -- the producer line, the case rule --
// is positioned against the foot of the label. Long declarations are
// absorbed by type size instead.
function allergenBlock(text, warnings, isCase = false, mayContain = '') {
  text = escape(text) || 'Not recorded';
  const body = `ALLERGENS: ${text}`;
  // The matrix records which allergens a product may carry from
  // cross-contact, so where it names them the label names them too. Naming
  // one does not narrow the statement: the line still ends "and other
  // allergens", because the matrix names the ones that are known about
  // rather than every one that is possible (Dean, 2026-09-01).
  const may = escape(mayContain);
  const disclaimer = may ? `May contain ${may} and other allergens` : 'May contain other allergens';
  // A case label gives up two dots of box to the rule and case line at its
  // foot, which is the only geometric difference between the two variants.
  let [top, boxH] = isCase ? [288, 50] : [292, 52];
  const boxW = INNER;
  const innerW = boxW - 32;
  const [size, lines] = shrinkToOneLine(body, innerW, [24, 22, 20, 18, 17]);
  if (lines > 1) {
    warnings.push(
      'The allergen declaration is too long for one line even at 17 dots, so it wraps to two and the box grows ' +
        'upward into the row above. Render the label before printing it.',
    );
    boxH = 66;
    top = (isCase ? 338 : 346) - boxH;
  }
  return [
    `^FO${MARGIN},${top}^GB${boxW},${boxH},2^FS`,
    `^FO${MARGIN + 16},${top + 6}^A0N,${size},0^FB${innerW},${lines},0,L^FD${body}^FS`,
    `^FO${MARGIN + 16},${top + 6 + lines * (size + 2)}^A0N,17^FB${innerW},1,0,L^FD${disclaimer}^FS`,
  ];
}

// The internal version: a heading and one line, in the compact type the
// handwritten forms these replace used.
function labelAllergenBlock(text, top, warnings) {
  text = escape(text) || 'Not recorded';
  const boxW = INNER;
  const innerW = boxW - 32;
  let [size, lines] = shrinkToOneLine(text, innerW, [20, 18, 16]);
  if (lines > 1) {
    warnings.push('The allergen line does not fit at the smallest size and will wrap onto itself. Shorten it.');
    lines = 1;
  }
  const boxH = 6 + 20 + size + 2 + 4;
  return [
    `^FO${MARGIN},${top}^GB${boxW},${boxH},2^FS`,
    `^FO${MARGIN + 16},${top + 6}^A0N,20^FDALLERGENS^FS`,
    `^FO${MARGIN + 16},${top + 28}^A0N,${size}^FB${innerW},1,0,L^FD${text}^FS`,
  ];
}

function warnName(name, warnings, width = INNER) {
  const safe = escape(name);
  if (!fits(safe, NAME_HEIGHT, width)) {
    warnings.push(
      `'${name}' is about ${textWidth(safe, NAME_HEIGHT)} dots wide at ${NAME_HEIGHT}, over the ${width} ` +
        'available. It will be clipped at the right-hand edge; shorten the name rather than the type size.',
    );
  }
}

// The intake label. Replaces the handwritten Goods In form.
export function goodsIn({ name, useBy, batch, supplier, delivered, allergens, storage, quantity = 1 }) {
  const warnings = [];
  warnName(name, warnings);
  const banner = STORAGE_BANNER[storage] || '';
  if (!banner) {
    warnings.push('No storage requirement recorded for this item, so the label carries no storage banner. The catalog is where that gets fixed.');
  }

  const out = head();
  out.push(
    `^FO${MARGIN},42^A0N,20^FDGOODS IN^FS`,
    `^FO500,42^A0N,20^FB272,1,0,R^FD${banner}\\&^FS`,
    `^FO${MARGIN},72^A0N,${NAME_HEIGHT}^FD${escape(name)}^FS`,
    `^FO${MARGIN},126^GB${INNER},0,4^FS`,
    '',
    `^FO${MARGIN},142^A0N,20^FDUSE BY^FS`,
  );
  // The use-by on a delivery belongs to the supplier's own box, and most
  // arrive with one printed on them. Where nobody has typed a date in, the
  // label says where to look rather than leaving a blank that reads as a
  // date somebody forgot. The words are set smaller than a date would be:
  // they are an instruction, not the answer, and at 42 dots they would run
  // into the batch beside them.
  if (escape(useBy)) {
    out.push(`^FO${MARGIN},166^A0N,42^FD${escape(useBy)}^FS`);
  } else {
    out.push(`^FO${MARGIN},174^A0N,28^FDSee product packaging^FS`);
  }
  out.push(
    '',
    '^FO420,142^A0N,20^FDBATCH^FS',
    `^FO420,166^A0N,42^FD${escape(batch)}^FS`,
    '',
    `^FT${MARGIN},242^A0N,20^FDSupplier^FS`,
    `^FT190,242^A0N,26^FD${escape(supplier)}^FS`,
    `^FT${MARGIN},276^A0N,20^FDDelivered^FS`,
    `^FT190,276^A0N,26^FD${escape(delivered)}^FS`,
    '',
  );
  out.push(...labelAllergenBlock(allergens, 292, warnings));
  out.push('', `^PQ${Math.trunc(quantity)}`, '^XZ');
  return [`${out.join('\n')}\n`, warnings];
}

// Applied when a container is opened or its contents decanted. The border
// round the whole label is what tells this apart from Goods In across a
// room; the two sit on the same shelves on the same containers and are the
// pair that actually gets confused.
export function dateOpened({ name, opened, useBy, batch, allergens, storageOpened, quantity = 1 }) {
  const warnings = [];
  warnName(name, warnings);
  const banner = STORAGE_BANNER[storageOpened] || '';
  let footer = OPENED_FOOTER[storageOpened];
  if (!footer) {
    footer = 'KEEP SEALED';
    warnings.push(
      'No after-opening storage recorded for this item, so the label gives no storage instruction. Putting an ' +
        'opened pack back in the wrong place is what this label exists to prevent -- fill storage_opened in the catalog.',
    );
  }

  const out = head();
  out.push(
    `^FO0,0^GB${WIDTH},${HEIGHT},8^FS`,
    '',
    `^FO${MARGIN},42^A0N,20^FDOPENED^FS`,
    `^FO500,42^A0N,20^FB272,1,0,R^FD${banner}\\&^FS`,
    `^FO${MARGIN},72^A0N,${NAME_HEIGHT}^FD${escape(name)}^FS`,
    `^FO${MARGIN},126^GB${INNER},0,4^FS`,
    '',
    // Use by and batch take the big row, in the same places they occupy on
    // the Goods In label, so the two read the same way round. They are what
    // the label is consulted for: how long is this good, and which batch
    // does the production record point at. The date it was opened matters
    // less once the use-by has been worked out from it, so it drops to the
    // small row underneath.
    `^FO${MARGIN},142^A0N,20^FDUSE BY^FS`,
    `^FO${MARGIN},166^A0N,42^FD${escape(useBy)}^FS`,
    '',
    '^FO420,142^A0N,20^FDBATCH^FS',
    `^FO420,166^A0N,42^FD${escape(batch)}^FS`,
    '',
    `^FT${MARGIN},244^A0N,20^FDOpened^FS`,
    `^FT190,244^A0N,28^FD${escape(opened)}^FS`,
    '',
  );
  out.push(...labelAllergenBlock(allergens, 258, warnings));
  out.push(
    '',
    `^FO${MARGIN},344^A0N,20^FB${INNER},1,0,C^FD${escape(footer)}\\&^FS`,
    '',
    `^PQ${Math.trunc(quantity)}`,
    '^XZ',
  );
  return [`${out.join('\n')}\n`, warnings];
}

// A reversed chip naming a variant, for two products that look alike.
// Tonkotsu broth and the diluted version of it are the same colour in the
// same pouch, and serving one for the other is a mistake nobody catches by
// reading carefully -- so the distinction has to survive being glanced at
// from across a room, which a word in the product name does not.
function variantTag(words, warnings) {
  const text = escape(words).toUpperCase();
  if (!text) return [];
  const width = textWidth(text, 30) + 40;
  if (width > 320) {
    warnings.push(`'${text}' is too long for the variant tag, which has to sit beside the product name. One or two words.`);
    return [];
  }
  const x = WIDTH - MARGIN - width;
  return [`^FO${x},44^GB${width},40,40^FS`, `^FR^FO${x},49^A0N,30,0^FB${width},1,0,C^FD${text}^FS`];
}

// The whole name row as a solid black band, for a third look-alike. See
// zpl.py for the full reasoning: it is the same weight class as variant_tag
// but with a different silhouette, so a trial variant cannot be mistaken for
// the standard or the diluted broth by shape alone.
function nameBar(name, sub, warnings) {
  name = escape(name);
  sub = escape(sub).toUpperCase();
  const top = 40;
  const height = 62;
  const inset = MARGIN + 14;
  const out = [`^FO${MARGIN},${top}^GB${INNER},${height},${height}^FS`];
  if (!sub) {
    out.push(`^FR^FO${inset},${top + Math.floor((height - 40) / 2)}^A0N,40^FD${name}^FS`);
    return out;
  }
  const subW = textWidth(sub, 30) + 24;
  if (fits(name, 40, INNER - 28 - subW - 24)) {
    out.push(`^FR^FO${inset},${top + Math.floor((height - 40) / 2)}^A0N,40^FD${name}^FS`);
    out.push(
      `^FR^FO${WIDTH - MARGIN - 14 - subW},${top + Math.floor((height - 30) / 2)}^A0N,30,0^FB${subW},1,0,C^FD${sub}^FS`,
    );
  } else {
    warnings.push(
      `'${name}' is too wide to sit beside the variant text on the band, so the text drops to a second line. The ` +
        "band is built for the 'Tonkotsu Broth' name -- shorten it.",
    );
    out.push(`^FR^FO${inset},${top + 3}^A0N,34^FD${name}^FS`);
    out.push(`^FR^FO${inset},${top + height - 22}^A0N,15^FD${sub}^FS`);
  }
  return out;
}

// The customer-facing product label, packet and case from one layout. The QR
// encodes the SKU -- see the top-of-file note on why it does not encode the
// batch code yet.
export function product({
  name,
  useBy,
  batch,
  packed,
  qty,
  sku,
  allergens,
  producer,
  mayContain = '',
  barcode = '',
  tag = '',
  bar = '',
  healthMark = false,
  hmCountry = 'GB',
  hmCode = '',
  isCase = false,
  quantity = 1,
}) {
  const warnings = [];
  // The chip eats into the room the name has, so the name is measured
  // against what is left rather than the full width. The band takes the
  // whole row and does its own width check, so neither applies with `bar` set.
  if (!bar) {
    const chipWidth = escape(tag) ? textWidth(escape(tag).toUpperCase(), 30) + 60 : 0;
    warnName(name, warnings, INNER - chipWidth);
  }
  if (healthMark && !hmCode) {
    warnings.push('The health mark oval is on but no approval number is set, so the oval would print empty. Set health_mark_code in label-data.json.');
  }

  const out = head();
  if (bar) {
    out.push(...nameBar(name, bar, warnings));
  } else {
    out.push(...variantTag(tag, warnings));
    out.push(`^FO${MARGIN},42^A0N,${NAME_HEIGHT}^FD${escape(name)}^FS`, `^FO${MARGIN},96^GB${INNER},0,4^FS`);
  }
  out.push(
    '',
    `^FO${MARGIN},112^A0N,20^FDUSE BY^FS`,
    `^FO${MARGIN},136^A0N,42^FD${escape(useBy)}^FS`,
    '',
    '^FO450,112^A0N,20^FDBATCH^FS',
    `^FO450,136^A0N,42^FD${escape(batch)}^FS`,
    '',
    `^FT${MARGIN},222^A0N,22^FDPacked^FS`,
    `^FT180,222^A0N,30^FD${escape(packed)}^FS`,
  );
  // A caption with nothing after it reads as a label that failed to print
  // rather than as a pack size nobody states, so the whole row goes.
  if (escape(qty)) {
    out.push(`^FT${MARGIN},256^A0N,22^FDQty^FS`, `^FT180,256^A0N,30^FD${escape(qty)}^FS`);
  }
  out.push('');
  // A barcode needs the whole lower right of the label, so the health mark
  // moves up beside the batch, where a product without a barcode has its QR.
  // Nothing else shifts: the dates and the allergen box stay where they are
  // on every label, which is what lets the four be read as one family.
  const [ovalX, ovalY] = barcode ? [612, 112] : [450, 196];
  if (healthMark) {
    out.push(
      `^FO${ovalX},${ovalY}^GE150,58,3^FS`,
      `^FO${ovalX},${ovalY + 6}^A0N,19^FB150,1,0,C^FD${escape(hmCountry)}\\&^FS`,
      `^FO${ovalX},${ovalY + 28}^A0N,19^FB150,1,0,C^FD${escape(hmCode)}\\&^FS`,
    );
    if (!barcode) out.push(`^FO447,262^A0N,17^FB156,1,0,C^FD${escape(sku)}\\&^FS`);
  } else if (!barcode) {
    // With no oval, the SKU rises into the space it would have occupied.
    out.push(`^FO450,192^A0N,20^FD${escape(sku)}^FS`);
  }
  // The QR carries the SKU, which is the only thing on the label that
  // resolves to something today. A product sold without a SKU therefore
  // carries no QR at all rather than one encoding a blank. A registered
  // retail barcode is what a till reads, so where there is one it takes the
  // place of the QR rather than sitting beside it.
  let field;
  if (barcode) {
    field = ean13(barcode, 470, 190, 76, warnings);
  } else {
    field = escape(sku) ? qrField(escape(sku), 622, 110, warnings) : '';
  }
  out.push(...(field ? ['', field, ''] : ['']));

  out.push(...allergenBlock(allergens, warnings, isCase, mayContain));
  out.push('');

  if (isCase) {
    const foot = escape(qty) ? `CASE  -  ${escape(qty).toUpperCase()}   |   ${escape(producer)}` : `CASE   |   ${escape(producer)}`;
    out.push(`^FO${MARGIN},338^GB${INNER},0,3^FS`, `^FO${MARGIN},346^A0N,16^FB${INNER},1,0,C^FD${foot}\\&^FS`);
  } else {
    out.push(`^FO${MARGIN},350^A0N,16^FB${INNER},1,0,C^FDProduced by: ${escape(producer)}\\&^FS`);
  }
  out.push('', `^PQ${Math.trunc(quantity)}`, '^XZ');
  return [`${out.join('\n')}\n`, warnings];
}

// Sizes a free-text label is allowed to use, largest first. Below about 30
// dots the text stops being readable across a room, which is the only reason
// this label exists, so the smallest is a floor rather than a last resort.
const NOTICE_SIZES = [150, 130, 110, 94, 80, 68, 58, 50, 44, 38, 32];

// How much of the line the wrap simulation is allowed to fill. The character
// width used here is an average, and at large sizes it ran about four per
// cent under -- enough for "DO NOT USE" to be predicted as one line, given
// one line to draw in, and printed as two on top of each other. ^FB does not
// truncate. Ten per cent held back costs a little size and makes that
// failure need a much worse estimate than any yet seen.
const NOTICE_FIT = 0.9;

// How many lines ^FB will break this into, packing greedily as it does.
// Counting from the total width alone is not enough: a block that needs one
// more line than it is given draws the overflow on top of the line above,
// and it is what the text does at the end of each line that decides how many
// it needs.
function wrappedLines(words, height, width = INNER) {
  let lines = 1;
  let current = 0;
  const wrapWidth = Math.floor(width * NOTICE_FIT);
  const space = textWidth(' ', height);
  for (const word of words.split(/\s+/).filter(Boolean)) {
    const wordWidth = textWidth(word, height);
    if (current && current + space + wordWidth > wrapWidth) {
      lines += 1;
      current = wordWidth;
    } else {
      current += (current ? space : 0) + wordWidth;
    }
  }
  return lines;
}

// A label that is nothing but words, set as large as they will go. There is
// no catalog behind it and nothing derived -- somebody types what it should
// say. Deliberately no border, even though a warning is the obvious case for
// one -- see zpl.py.
//
// A line break typed into the textarea is kept as a forced break rather than
// being folded into ^FB's own word-wrap: `\&` inside a ^FB field is ZPL's own
// escape for a manual line break, so "one line, then another" prints as two
// lines even when the first would otherwise have room for more words.
export function notice({ text, quantity = 1 }) {
  const warnings = [];
  const raw = escape(text);
  if (!raw) warnings.push('There is nothing to print on this label.');
  const paragraphs = raw.split('\n');

  const available = HEIGHT - 2 * MARGIN;
  let height;
  let gap;
  let lines;
  let likely;
  let block;
  let found = false;
  for (height of NOTICE_SIZES) {
    gap = Math.max(2, Math.floor(height / 8));
    // ^FB wraps on whole words, so a long word can leave a line short and
    // push the count up.
    const wordWidths = paragraphs.flatMap((p) => p.split(/\s+/).filter(Boolean))
      .map((word) => textWidth(word, height));
    const longest = wordWidths.length ? Math.max(...wordWidths) : 0;
    if (longest > INNER) continue;
    // Two counts, for two different jobs. The cautious one decides how many
    // lines ^FB is allowed, so an under-estimate cannot overprint. The
    // likely one decides where the block is centred, because centring on a
    // line that usually is not there leaves every notice sitting high. Each
    // typed line is wrapped and counted on its own, then summed, so a forced
    // break always costs at least one line even if it is short.
    lines = paragraphs.reduce((sum, p) => sum + wrappedLines(p, height), 0);
    likely = paragraphs.reduce((sum, p) => sum + wrappedLines(p, height, INNER / NOTICE_FIT), 0);
    block = lines * height + (lines - 1) * gap;
    if (block <= available) {
      found = true;
      break;
    }
  }
  if (!found) {
    height = NOTICE_SIZES[NOTICE_SIZES.length - 1];
    gap = 4;
    lines = paragraphs.length;
    likely = paragraphs.length;
    warnings.push('That does not fit on a label even at the smallest size, so it will be cut off. Say it in fewer words.');
    block = height;
  }

  const centred = likely * height + (likely - 1) * gap;
  let top = MARGIN + Math.floor((available - centred) / 2);
  // If it does take the cautious number of lines after all, it still has to
  // stay above the bottom margin.
  top = Math.min(top, MARGIN + available - block);
  const words = paragraphs.join('\\&');
  const out = [
    ...head(),
    `^FO${MARGIN},${top}^A0N,${height},0^FB${INNER},${lines},${gap},C^FD${words}^FS`,
    '',
    `^PQ${Math.trunc(quantity)}`,
    '^XZ',
  ];
  return [`${out.join('\n')}\n`, warnings];
}

export const BUILDERS = {
  'goods-in': goodsIn,
  'date-opened': dateOpened,
  packet: product,
  box: product,
  notice,
};
