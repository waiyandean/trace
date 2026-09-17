// The label GUI's catalog and form logic, ported from labels/gui/server.py.
//
// Two differences from that file, both forced by running in a Worker rather
// than on a machine with a filesystem to watch:
//
//   * catalog.json and label-data.json are bundled in at deploy time rather
//     than reloaded when their mtime changes. Editing label-data.json now
//     needs a deploy (`wrangler deploy`) to take effect, where the kitchen
//     laptop picked it up on the next request. See PLAN.md, "is it possible
//     to host this on Cloudflare" for the tradeoff.
//   * Whether an item has a photograph is decided in the browser (an <img>
//     falling back to an initial on error) rather than by statting
//     static/photos here, so this file does not need to know the photo
//     directory exists at all.
import catalog from './catalog.json' with { type: 'json' };
import extra from './label-data.json' with { type: 'json' };

export const TYPES = [
  { id: 'goods-in', name: 'Goods In', blurb: 'Stuck on a delivery as it comes through the door.', source: 'ingredient' },
  { id: 'date-opened', name: 'Date Opened', blurb: 'Stuck on a pack when it is opened or decanted.', source: 'opening' },
  { id: 'packet', name: 'Product Packet', blurb: 'The pouch or tub a finished product goes out in.', source: 'product' },
  { id: 'box', name: 'Product Box', blurb: 'The case the packets are shipped in.', source: 'product' },
  // No catalog behind this one, so it has no list to pick from and the tile
  // opens the label itself.
  { id: 'notice', name: 'Notice', blurb: 'Anything else: a warning, a note, a sign. Big words, centred.', source: 'free' },
];

const STORAGE_LABELS = { chill: 'Chilled', freezer: 'Frozen', ambient: 'Ambient' };

// An ISO date from a date input, as the dd/mm/yyyy the labels print. Anything
// that is not an ISO date is passed through untouched, so a field somebody
// has typed by hand still reaches the label.
export function uk(iso) {
  if (!iso) return '';
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!parts) return iso;
  const [, year, month, day] = parts;
  return `${day}/${month}/${year}`;
}

// An ISO date as the six digits a goods-in batch number uses.
function ddmmyy(iso) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!parts) return '';
  const [, year, month, day] = parts;
  return `${day}${month}${year.slice(2)}`;
}

// The suffix a production batch code carries after the day and month. It
// marks which line or run the batch came off, and GA is the one this
// kitchen uses.
const BATCH_SUFFIX = 'GA';

// A production batch code: the day and month, the run suffix, then the pot.
// The broths are cooked several batches to a day and each pot is its own
// batch, so the pot number is part of the code rather than a note beside it.
// A product cooked once a day carries no pot number and the code ends at the
// suffix.
function batchCode(iso, pot = '') {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!parts) return '';
  const [, , month, day] = parts;
  return `${day}${month}${BATCH_SUFFIX}${pot}`;
}

// `months` after `iso`, moved to the first of that month. Shelf life on a
// finished product is counted in whole months and always lands on a first: a
// batch packed on the 23rd of January with six months on it is used by the
// 1st of July, not the 23rd. Rounding down to the start of the month is the
// conservative direction -- it can only shorten the life, never extend it
// past what was intended.
function monthsOn(iso, months) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!parts) return '';
  const [, year, month] = parts;
  const total = Number(year) * 12 + (Number(month) - 1) + months;
  const onward = Math.floor(total / 12);
  const at = String((total % 12) + 1).padStart(2, '0');
  return `${onward}-${at}-01`;
}

// One row of the form. `missing` marks a value the catalog should hold but
// does not. Those fields are editable so a label can still be printed today,
// and are shown as a gap rather than as an ordinary blank, because the fix
// is to record the answer rather than to type it again every time.
function field(key, label, value = '', { kind = 'text', editable = true, options = [], hint = '', missing = false, derive = null } = {}) {
  return { key, label, value, kind, editable, options, hint, missing, derive };
}

export class Data {
  constructor() {
    this.catalog = catalog;
    this.extra = extra;
    this.items = Object.fromEntries(catalog.items.map((item) => [item.id, item]));
  }

  // The items a given label type applies to, in the groups they are picked
  // from. Ingredients are grouped by supplier and then by storage, which is
  // the order the two facts are needed in. A delivery is one van from one
  // supplier, so that narrows sixty things to twenty-odd; within it, what
  // separates one row from the next is where the goods are going, because
  // that is what happens to them next and it is what a wrong answer costs.
  //
  // An ingredient bought from both suppliers appears under both, since at
  // the door it genuinely could be either. Storage sections do not overlap.
  listing(typeId) {
    const source = TYPES.find((t) => t.id === typeId)?.source;
    const rows = [];
    for (const item of this.catalog.items) {
      if (source === 'ingredient' && item.kind !== 'ingredient') continue;
      if (source === 'product' && item.kind !== 'product') continue;
      // Some catalog rows are real stock that simply never gets a label of
      // this kind printed. They stay active in the catalog -- this is a
      // statement about labelling, not about whether the kitchen holds the
      // item -- and are named in label-data.json rather than filtered by a
      // rule, so that adding one is a decision somebody recorded.
      if (this.extra.not_labelled?.[item.name]) continue;
      // Only the fifteen ingredients that are used a bit at a time get a
      // Date Opened label. A pack that is never partly used has nothing to
      // record, and offering one invites labelling that says nothing.
      if (source === 'opening' && (item.kind !== 'ingredient' || !item.opening_rule || item.opening_rule === 'whole_pack')) continue;
      rows.push({
        id: item.id,
        name: this.labelName(item),
        detail: this.detail(item, typeId),
        incomplete: this.gaps(item, typeId).length > 0,
        suppliers: item.suppliers,
      });
    }

    if (source === 'product') return this.byCategory(rows);

    const groups = [];
    // A trailing null stands for the ingredients nobody has recorded a
    // supplier for; they would otherwise vanish from a screen that only
    // draws the suppliers it knows about.
    for (const supplier of [...this.catalog.suppliers, null]) {
      let members = supplier ? rows.filter((r) => r.suppliers.includes(supplier)) : rows.filter((r) => !r.suppliers.length);
      if (!members.length) continue;
      if (typeId === 'goods-in') {
        // Inside a supplier's own group its name is on the heading, so
        // repeating it on every row says nothing. What is worth saying is
        // that an item also comes from the other supplier, which is why the
        // same row appears twice on the screen.
        members = members.map((row) => ({
          ...row,
          detail: row.suppliers.length > 1 ? `also ${row.suppliers.filter((s) => s !== supplier).join(', ')}` : '',
        }));
      }
      groups.push({ name: supplier || 'No supplier recorded', sections: this.byStorage(members, typeId) });
    }
    return groups;
  }

  // Products under the headings the kitchen thinks of them in. The catalog
  // has one flat kind, `product`, which covers a two-litre tub of sauce and
  // a frozen retail ramen alike. Twenty-five of those in one alphabetical
  // run is a list to search rather than a list to pick from.
  byCategory(rows) {
    const categories = this.extra.product_categories || [];
    const categoryOf = Object.fromEntries(
      rows.map((r) => [r.id, this.extra.products?.[this.items[r.id].name]?.category]),
    );
    const groups = [];
    for (const category of categories) {
      const members = rows.filter((r) => categoryOf[r.id] === category);
      if (members.length) groups.push({ name: category, sections: [{ name: '', items: members }] });
    }
    // A product nobody has placed yet gets its own heading at the end rather
    // than being folded into the largest category, where it would look
    // deliberate.
    const loose = rows.filter((r) => !categories.includes(categoryOf[r.id]));
    if (loose.length) groups.push({ name: 'Not categorised', sections: [{ name: '', items: loose }] });
    return groups;
  }

  // Split one supplier's rows by where the goods are kept. Goods In uses the
  // unopened requirement, which is where a delivery is put away. Date
  // Opened uses the after-opening one, which is the whole point of that
  // label: several things sit on an ambient shelf unopened and have to be
  // refrigerated once they are not.
  byStorage(rows, typeId) {
    const key = typeId === 'date-opened' ? 'storage_opened' : 'storage_unopened';
    const sections = [];
    for (const [value, label] of Object.entries(STORAGE_LABELS)) {
      const members = rows.filter((r) => this.items[r.id][key] === value);
      if (members.length) sections.push({ name: label, items: members });
    }
    // Null means nobody has determined it, not that there is no
    // requirement, so these are named rather than filed under Ambient.
    const loose = rows.filter((r) => !this.items[r.id][key]);
    if (loose.length) sections.push({ name: 'Storage not recorded', items: loose });
    return sections;
  }

  // What the picker calls this item. Always the catalog name, never the name
  // printed on the label. The diluted tonkotsu prints as "Tonkotsu Broth"
  // with a DILUTED chip beside it, and if the picker used that too there
  // would be two rows reading "Tonkotsu Broth" and no way to tell which was
  // which -- the exact confusion the variant exists to prevent, moved from
  // the shelf to the screen.
  labelName(item) {
    return item.name;
  }

  detail(item, typeId) {
    if (typeId === 'goods-in') return item.suppliers.join(', ') || 'no supplier recorded';
    if (typeId === 'date-opened') {
      const days = item.days_after_opening;
      return days ? `${days} days once opened` : 'no period recorded';
    }
    const product = this.extra.products?.[item.name] || {};
    const variant = product[typeId === 'box' ? 'box' : 'packet'] || {};
    if (variant.qty) return variant.qty;
    // A pack size nobody states is not a pack size nobody has got round to.
    return variant.no_qty ? '' : 'pack size not recorded';
  }

  // Which values this label needs that nothing has recorded yet.
  gaps(item, typeId) {
    const gaps = [];
    if (!this.extra.allergens?.[item.name]) gaps.push('allergens');
    if (typeId === 'packet' || typeId === 'box') {
      const product = this.extra.products?.[item.name] || {};
      const variant = product[typeId === 'box' ? 'box' : 'packet'] || {};
      // A variant that is sold without a SKU is a decision, not a gap.
      if (!variant.sku && !variant.no_sku) gaps.push('sku');
      // A variant with no pack size stated on its label is a decision, not
      // a gap, the same as one sold without a SKU.
      if (!variant.qty && !variant.no_qty) gaps.push('qty');
      if (product.health_mark === undefined || product.health_mark === null) gaps.push('health mark');
    } else {
      const key = typeId === 'date-opened' ? 'storage_opened' : 'storage_unopened';
      if (!item[key]) gaps.push('storage');
    }
    return gaps;
  }

  // The editable form for one item and one label type. Batch, the dates,
  // and the quantity are always editable, because they change on every
  // print and no catalog will ever hold them. Everything else is editable
  // only where nothing has recorded it, so a field that is open is a signal
  // that something needs filling in rather than an invitation to retype
  // what is already known.
  form(typeId, itemId) {
    if (typeId === 'notice') {
      return {
        type: typeId,
        item: itemId,
        title: 'Notice',
        gaps: [],
        fields: [
          field('text', 'What it should say', '', {
            kind: 'lines',
            hint: 'Set as large as it will go and centred. Keep it short: a label read across a room is a few words, not a paragraph.',
          }),
        ],
      };
    }

    const item = this.items[itemId];
    const today = new Date().toISOString().slice(0, 10);
    const allergens = this.extra.allergens?.[item.name] || '';
    const fields = [];

    if (typeId === 'goods-in') {
      fields.push(
        field('name', 'Ingredient', item.name, { editable: false }),
        field('storage', 'Storage', item.storage_unopened || '', {
          kind: 'select',
          editable: !item.storage_unopened,
          options: ['ambient', 'chill', 'freezer'],
          missing: !item.storage_unopened,
          hint: 'Prints as the banner in the top right.',
        }),
        field('use_by', 'Use by', '', {
          kind: 'date',
          hint: 'Off the supplier\'s own box, where there is one. Left empty, the label says "See product packaging" rather than printing a blank.',
        }),
        // The kitchen's batch number for an intake is the delivery date as
        // six digits, so it follows the Delivered field rather than being
        // typed twice. Typing into it stops it following, because a
        // supplier's own batch code sometimes has to be used instead.
        field('batch', 'Batch number', ddmmyy(today), {
          derive: 'ddmmyy',
          hint: "The delivery date as ddmmyy. Type over it to use the supplier's own code instead.",
        }),
        // Always typed, never locked -- the catalog's supplier is the usual
        // one, but a delivery from a substitute or a new supplier still
        // needs a label, and the catalog is not the place to record a
        // one-off. Prefilled with what the catalog does say, so the common
        // case is still nothing to type.
        field('supplier', 'Supplier', item.suppliers[0] || '', {
          missing: !item.suppliers.length,
          hint: item.suppliers.length > 1
            ? `Also delivered by ${item.suppliers.slice(1).join(', ')}. Type over it for a different supplier entirely.`
            : item.suppliers.length
              ? 'Type over it if this delivery is from a different supplier.'
              : '',
        }),
        field('delivered', 'Delivered', today, { kind: 'date' }),
        field('allergens', 'Allergens', allergens, {
          editable: !allergens,
          missing: !allergens,
          hint: allergens ? '' : 'Nothing in the catalog records these yet. Fill label-data.json to stop retyping them.',
        }),
      );
    } else if (typeId === 'date-opened') {
      const days = item.days_after_opening;
      const useBy = days ? new Date(Date.now() + days * 86400000).toISOString().slice(0, 10) : '';
      fields.push(
        field('name', 'Ingredient', item.name, { editable: false }),
        field('storage_opened', 'Storage once opened', item.storage_opened || '', {
          kind: 'select',
          editable: !item.storage_opened,
          options: ['ambient', 'chill', 'freezer'],
          missing: !item.storage_opened,
          hint: 'Sets both the banner and the instruction at the foot.',
        }),
        field('opened', 'Opened', today, { kind: 'date' }),
        field('use_by', 'Use by', useBy, {
          kind: 'date',
          hint: days ? `${days} days from opening, the kitchen's rule for this item. The pack's own date wins if it is sooner.` : '',
        }),
        field('batch', 'Batch number', ''),
        field('allergens', 'Allergens', allergens, { editable: !allergens, missing: !allergens }),
      );
    } else {
      const product = this.extra.products?.[item.name] || {};
      const variant = product[typeId === 'box' ? 'box' : 'packet'] || {};
      const mark = product.health_mark;
      // Shelf life is counted in whole months from the day a batch is
      // packed. Twelve for the broths, six for everything else (Dean,
      // 2026-09-01); it is held per category rather than per product
      // because that is the level at which it was decided.
      const months = product.category === 'Broths' ? 12 : 6;
      const pots = this.extra.pot_numbers || {};
      const usesPots = (pots.categories || []).includes(product.category);
      const firstPot = usesPots ? '1' : '';
      fields.push(
        // The label prints the catalog name. Where a product is named
        // differently on its packaging, a label_name in label-data.json
        // says so; there is nothing to type here.
        field('name', 'Product', product.label_name || item.name, { editable: false }),
        field('packed', 'Packed', today, { kind: 'date', hint: 'The batch code and the use-by both follow this.' }),
        field('use_by', 'Use by', monthsOn(today, months), {
          kind: 'date',
          derive: `months:${months}`,
          hint: `${months} months from packing, on the first of that month. Type over it to set a different date.`,
        }),
        field('batch', 'Batch code', batchCode(today, firstPot), {
          derive: 'batch',
          hint: `The packing date as ddmm, then the run suffix ${BATCH_SUFFIX}${usesPots ? ', then the pot.' : '.'}`,
        }),
        field('qty', 'Quantity', variant.qty || '', {
          editable: !variant.qty && !variant.no_qty,
          missing: !variant.qty && !variant.no_qty,
          hint: variant.no_qty
            ? 'Not stated on this label.'
            : typeId === 'packet'
              ? 'What one pack holds, e.g. 1.8 Litres.'
              : 'What one case holds, e.g. 8 x 1.8 Litres.',
        }),
        field('sku', 'Customer SKU', variant.sku || '', {
          editable: !variant.sku && !variant.no_sku,
          missing: !variant.sku && !variant.no_sku,
          hint: variant.no_sku ? 'Sold without a SKU, so the label carries no QR.' : 'Also what the QR carries.',
        }),
        field('health_mark', 'Health mark', mark ? 'yes' : 'no', {
          kind: 'select',
          editable: mark === undefined || mark === null,
          options: ['yes', 'no'],
          missing: mark === undefined || mark === null,
          hint: mark === undefined || mark === null ? 'Follows animal origin. Nobody has decided this one yet.' : '',
        }),
        field('allergens', 'Allergens', allergens, { editable: !allergens, missing: !allergens }),
      );
      if (usesPots) {
        // These are cooked several times a day and every pot is its own
        // batch, so which pot this is has to be picked before printing. It
        // sits directly under the code it changes.
        fields.splice(
          4,
          0,
          field('pot', 'Pot', firstPot, {
            kind: 'choice',
            options: Array.from({ length: Number(pots.highest || 8) }, (_, i) => String(i + 1)),
            hint: 'Which pot this batch came out of. It is the last character of the batch code.',
          }),
        );
      }
      // Only shown where the matrix names a cross-contact allergen. With
      // nothing to name, the label falls back to the generic line and there
      // is no value here to show or to edit.
      if (product.tag) {
        fields.push(
          field('tag', 'Variant', product.tag, {
            editable: false,
            hint: 'Prints as a reversed chip beside the name. It is what tells this apart from the product it looks identical to.',
          }),
        );
      }
      if (product.bar) {
        fields.push(
          field('bar', 'Trial band', product.bar, {
            editable: false,
            hint: 'Prints as a solid black band carrying the name in reverse, with this text set against the right edge where the diluted chip sits. A different shape from the chip, so a third look-alike is not mistaken for the first two at a glance.',
          }),
        );
      }
      if (product.barcode) {
        fields.push(
          field('barcode', 'Barcode', product.barcode, {
            editable: false,
            hint: 'The product\'s registered EAN-13. It replaces the QR on this label -- two symbols on a small label invites scanning the wrong one.',
          }),
        );
      }
      const may = this.extra.may_contain?.[item.name] || '';
      if (may) {
        fields.push(
          field('may_contain', 'May contain', may, {
            editable: false,
            hint: 'From the allergen matrix. Replaces the generic line at the foot.',
          }),
        );
      }
    }
    return { type: typeId, item: itemId, title: this.labelName(item), gaps: this.gaps(item, typeId), fields };
  }
}
