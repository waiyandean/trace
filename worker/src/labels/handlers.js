// Routes for the label GUI, ported from labels/gui/server.py's do_GET/do_POST.
//
// Printing itself is not here. The Worker cannot reach the kitchen printer
// (PLAN.md, "the obstacle") any more than a browser can, so the page posts
// ZPL straight to the print relay at print-relay.deanops.uk, the same way
// goods-in.js, stock.js and batches.js already print — see static/app.js.
// This file only builds the ZPL and renders the preview.
import { BadRequest } from '../http.js';
import { Data, TYPES, uk, monthYear } from './data.js';
import { BUILDERS } from './zpl.js';

const LABELARY = 'http://api.labelary.com/v1/printers/8dpmm/labels/4x2/0/';

const data = new Data();

// Turn form values into ZPL.
export function build(typeId, itemId, values, quantity) {
  if (typeId === 'notice') return BUILDERS.notice({ text: values.text || '', quantity });
  const item = data.items[itemId];
  if (!item) throw new BadRequest('unknown item');
  const allergens = data.extra.allergens?.[item.name] || '';
  if (!allergens) {
    throw new BadRequest(`No allergen declaration is recorded for ${item.name}. Update label-data.json before printing this label.`);
  }

  if (typeId === 'goods-in') {
    return BUILDERS['goods-in']({
      name: values.name || item.name,
      useBy: uk(values.use_by),
      batch: values.batch || '',
      supplier: values.supplier || '',
      delivered: uk(values.delivered),
      allergens,
      storage: values.storage || item.storage_unopened,
      quantity,
    });
  }
  if (typeId === 'date-opened') {
    return BUILDERS['date-opened']({
      name: values.name || item.name,
      opened: uk(values.opened),
      useBy: uk(values.use_by),
      batch: values.batch || '',
      allergens,
      storageOpened: values.storage_opened || item.storage_opened,
      quantity,
    });
  }
  if (typeId === 'dessert') {
    const product = data.extra.products?.[item.name] || {};
    return BUILDERS.dessert({
      name: values.name || product.label_name || item.name,
      contents: values.contents || '',
      produced: monthYear(values.produced),
      useBy: monthYear(values.use_by),
      netWeight: values.net_weight || '',
      allergens,
      storage: item.storage_unopened || 'freezer',
      quantity,
    });
  }
  if (typeId !== 'packet' && typeId !== 'box') throw new BadRequest(`unknown label type: ${typeId}`);
  return BUILDERS.packet({
    name: values.name || item.name,
    useBy: uk(values.use_by),
    batch: values.batch || '',
    packed: uk(values.packed),
    qty: values.qty || '',
    sku: values.sku || '',
    allergens,
    mayContain: values.may_contain || '',
    barcode: values.barcode || '',
    tag: values.tag || '',
    bar: values.bar || '',
    producer: data.extra.producer || '',
    healthMark: values.health_mark === 'yes',
    hmCountry: data.extra.health_mark_country || 'GB',
    hmCode: data.extra.health_mark_code || '',
    isCase: typeId === 'box',
    quantity,
  });
}

// A real render of the label, through Labelary's ZPL interpreter. Labelary
// starts from clean printer state, so it will not reproduce anything caused
// by a setting left behind on the printer itself. It also needs the
// internet from wherever it runs from, which for a Worker is never a
// concern the way it was for the kitchen laptop offline — but Labelary
// itself can still be down or slow, so a failure here is reported rather
// than thrown: a preview is a convenience and printing does not depend on it.
async function renderPng(source) {
  const response = await fetch(LABELARY, {
    method: 'POST',
    headers: { Accept: 'image/png', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: source,
  });
  if (!response.ok) throw new Error(`Labelary returned ${response.status}`);
  const buffer = await response.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export async function bootstrap() {
  return { types: TYPES };
}

export async function items(typeId) {
  if (!TYPES.some((t) => t.id === typeId)) throw new BadRequest(`unknown label type: ${typeId}`);
  return { groups: data.listing(typeId) };
}

export async function form(typeId, itemId, supplier = null) {
  if (!TYPES.some((t) => t.id === typeId)) throw new BadRequest(`unknown label type: ${typeId}`);
  if (typeId !== 'notice' && !data.items[itemId]) throw new BadRequest('unknown item');
  try {
    return data.form(typeId, itemId, supplier);
  } catch (err) {
    throw new BadRequest(err.message);
  }
}

// What the Brother box-seal label needs for one product: the fields already
// live in label-data.json for the ZPL health-mark oval and EAN-13 (see
// build() above), keyed by product name rather than catalog id, so this
// reads data.extra.products directly instead of going through data.items.
export async function sealInfo(name) {
  if (!name) throw new BadRequest('item is required');
  const product = data.extra.products?.[name] || {};
  return {
    barcode: product.barcode || '',
    healthMark: product.health_mark === true,
    hmCountry: data.extra.health_mark_country || 'GB',
    hmCode: data.extra.health_mark_code || '',
    category: product.category || '',
  };
}

// The JSON brother_seal.render_and_print (or print-relay.py's /print-seal)
// expects, resolved server-side from the form's submitted values plus
// label-data.json. Barcode and health mark come from the catalog rather
// than the submitted values -- both are locked fields on the form, but a
// request forged straight against the API should still get the catalog's
// answer, not whatever it typed into a disabled input.
export async function sealRender(payload) {
  const item = data.items[payload.item];
  if (!item) throw new BadRequest('unknown item');
  const product = data.extra.products?.[item.name] || {};
  if (product.category !== 'Frozen Ramen') {
    throw new BadRequest(`${item.name} has no box seal -- Frozen Ramen only.`);
  }
  const values = payload.values || {};
  return {
    seal: {
      name: product.label_name || item.name,
      batch: values.batch || '',
      useBy: uk(values.use_by),
      barcode: product.barcode || '',
      healthMark: product.health_mark === true,
      hmCountry: data.extra.health_mark_country || 'GB',
      hmCode: data.extra.health_mark_code || '',
    },
  };
}

export async function render(payload) {
  const quantity = Number(payload.quantity);
  if (!Number.isInteger(quantity)) throw new BadRequest('Quantity has to be a whole number.');
  if (quantity < 1 || quantity > 200) throw new BadRequest('Quantity has to be between 1 and 200.');
  const [source, warnings] = build(payload.type, payload.item, payload.values || {}, quantity);

  let png = null;
  let previewError = '';
  if (payload.preview !== false) {
    try {
      png = await renderPng(source);
    } catch (err) {
      previewError = `No preview: ${err.message}. The label itself is unaffected -- rendering needs Labelary to be reachable, printing does not.`;
    }
  }
  return { zpl: source, warnings, png, preview_error: previewError };
}
