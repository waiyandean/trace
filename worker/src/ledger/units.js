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

function graphFor(rows) {
  const edges = new Map();
  const add = (from, to, factor, via) => {
    if (!edges.has(from)) edges.set(from, []);
    edges.get(from).push({ to, factor, via });
  };
  for (const row of rows) {
    add(row.from_unit, row.to_unit, row.factor, row.id);
    add(row.to_unit, row.from_unit, 1 / row.factor, row.id);
  }
  return edges;
}

// Breadth-first, so the answer uses the fewest stated hops. Returns the
// multiplier and the path it went through, because a caller that records a
// converted quantity should be able to say how it got there.
export function resolveFactor(rows, fromUnit, toUnit) {
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

  if (unit === item.base_unit) {
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
