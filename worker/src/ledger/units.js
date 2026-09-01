import { BadRequest } from '../http.js';

// Converting what a person keyed into the item's base unit.
//
// The conversions master holds one row per hop — 'case' -> 'item',
// 'item' -> 'kg' — so a case of most ingredients reaches its base unit in two
// steps and a bulk case of bones in one. Every hop is a row somebody entered;
// nothing here invents a factor, and an item with no path from the unit
// offered is an error rather than an assumption. A wrong quantity at intake
// is a wrong balance for the life of the lot.
//
// Hops run in both directions. A row saying a case is 6 items also says an
// item is a sixth of a case, and that is arithmetic rather than a guess.

// The same unit written two ways, and the metric prefixes.
//
// These are the two conversions that need no evidence. "Litres" and "L" are
// one unit spelled differently, and a thousand grams is a kilogram by
// definition rather than by measurement. Everything else — how much a head of
// pak choi weighs, how many packs are in a case — is a fact about the item
// and belongs in the conversions master where somebody has to enter it.
//
// Grams and millilitres are deliberately not related to each other. That
// would need a density, and a density is exactly the kind of plausible
// invention this system exists to avoid.
const SPELLINGS = {
  l: 'L', litre: 'L', litres: 'L', liter: 'L', liters: 'L',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  g: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml',
  unit: 'Units', units: 'Units',
  case: 'case', cases: 'case', item: 'item', items: 'item',
};

const METRIC = [
  ['g', 'kg', 0.001],
  ['ml', 'L', 0.001],
];

export function canonicalUnit(unit) {
  if (typeof unit !== 'string') return unit;
  return SPELLINGS[unit.trim().toLowerCase()] ?? unit.trim();
}

function graphFor(rows) {
  const edges = new Map();
  const add = (from, to, factor, via) => {
    if (!edges.has(from)) edges.set(from, []);
    edges.get(from).push({ to, factor, via });
  };
  for (const row of rows) {
    add(canonicalUnit(row.from_unit), canonicalUnit(row.to_unit), row.factor, row.id);
    add(canonicalUnit(row.to_unit), canonicalUnit(row.from_unit), 1 / row.factor, row.id);
  }
  for (const [small, large, factor] of METRIC) {
    add(small, large, factor, 'metric');
    add(large, small, 1 / factor, 'metric');
  }
  return edges;
}

// Breadth-first, so the answer uses the fewest stated hops. Returns the
// multiplier and the path it went through, because a caller that records a
// converted quantity should be able to say how it got there.
export function resolveFactor(rows, from, to) {
  const fromUnit = canonicalUnit(from);
  const toUnit = canonicalUnit(to);
  if (fromUnit === toUnit) return { factor: 1, path: [] };

  const edges = graphFor(rows);
  const seen = new Set([fromUnit]);
  let frontier = [{ unit: fromUnit, factor: 1, path: [] }];

  while (frontier.length) {
    const next = [];
    for (const node of frontier) {
      for (const edge of edges.get(node.unit) || []) {
        if (seen.has(edge.to)) continue;
        const step = {
          unit: edge.to,
          factor: node.factor * edge.factor,
          path: [...node.path, `${node.unit}->${edge.to}`],
        };
        if (edge.to === toUnit) return { factor: step.factor, path: step.path };
        seen.add(edge.to);
        next.push(step);
      }
    }
    frontier = next;
  }
  return null;
}

// Loads the conversions for one item and applies them. Kept separate from
// resolveFactor so the arithmetic can be tested without a database.
export async function toBaseUnit(db, item, quantity, unit) {
  if (!(quantity > 0)) throw new BadRequest(`quantity must be greater than zero, got ${quantity}`);

  if (canonicalUnit(unit) === canonicalUnit(item.base_unit)) {
    return { quantity, factor: 1, path: [] };
  }

  const { results } = await db
    .prepare('SELECT id, from_unit, to_unit, factor FROM unit_conversions WHERE item_id = ?')
    .bind(item.id)
    .all();

  const resolved = resolveFactor(results || [], unit, item.base_unit);
  if (!resolved) {
    throw new BadRequest(
      `no recorded conversion from ${unit} to ${item.base_unit} for ${item.name}. ` +
        'Add the conversion to the catalog rather than converting by hand.',
    );
  }
  return { quantity: quantity * resolved.factor, factor: resolved.factor, path: resolved.path };
}
