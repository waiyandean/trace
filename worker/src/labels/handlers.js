// Routes for the label GUI, ported from labels/gui/server.py's do_GET/do_POST.
//
// Printing itself is not here. The Worker cannot reach the kitchen printer
// (PLAN.md, "the obstacle") any more than a browser can, so the page posts
// ZPL straight to the print relay at print-relay.deanops.uk, the same way
// goods-in.js, stock.js and batches.js already print — see static/app.js.
// This file only builds the ZPL and renders the preview.
import { BadRequest } from '../http.js';
import { Data, TYPES, uk } from './data.js';
import { BUILDERS } from './zpl.js';

const LABELARY = 'http://api.labelary.com/v1/printers/8dpmm/labels/4x2/0/';

const data = new Data();

// Turn form values into ZPL.
function build(typeId, itemId, values, quantity) {
  if (typeId === 'notice') return BUILDERS.notice({ text: values.text || '', quantity });
  const item = data.items[itemId];
  if (!item) throw new BadRequest('unknown item');

  if (typeId === 'goods-in') {
    return BUILDERS['goods-in']({
      name: values.name || item.name,
      useBy: uk(values.use_by),
      batch: values.batch || '',
      supplier: values.supplier || '',
      delivered: uk(values.delivered),
      allergens: values.allergens || '',
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
      allergens: values.allergens || '',
      storageOpened: values.storage_opened || item.storage_opened,
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
    allergens: values.allergens || '',
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

export async function form(typeId, itemId) {
  if (!TYPES.some((t) => t.id === typeId)) throw new BadRequest(`unknown label type: ${typeId}`);
  if (typeId !== 'notice' && !data.items[itemId]) throw new BadRequest('unknown item');
  return data.form(typeId, itemId);
}

export async function render(payload) {
  const quantity = Number(payload.quantity || 1) || 1;
  const [source, warnings] = build(payload.type, payload.item, payload.values || {}, quantity);

  let png = null;
  let previewError = '';
  try {
    png = await renderPng(source);
  } catch (err) {
    previewError = `No preview: ${err.message}. The label itself is unaffected -- rendering needs Labelary to be reachable, printing does not.`;
  }
  return { zpl: source, warnings, png, preview_error: previewError };
}
