import { BadRequest } from '../http.js';
import { validateEnvelope, payloadHash, alreadyAccepted, eventRow, lookupRow } from './envelope.js';
import { requireReading, COOKING_RANGE } from './temperature.js';

// The checks a batch is made under.
//
// A reading either passes a stated limit, fails it, or has no limit at all.
// The third is the common case — forty-four of the sixty checkpoints state
// none — and it is recorded as unjudged rather than as a pass. A reading kept
// without a limit is evidence; calling it a pass would be a claim nobody
// made.
//
// Twelve checkpoints have a clock. Those rows are created unanswered when the
// batch is made, carrying the moment they fall due, because a checkpoint
// nobody created a row for is invisible — and invisible is how the
// twelve-hour cooling check gets forgotten.

export async function checkpointsFor(db, recipeId) {
  const { results } = await db
    .prepare(
      `SELECT id, code, label, kind, is_ccp, required, min_celsius, max_celsius,
              anchor_code, due_minutes, min_duration_hours, sort_order
         FROM checkpoints WHERE recipe_id = ? ORDER BY sort_order`,
    )
    .bind(recipeId)
    .all();
  return results || [];
}

// Both bounds are optional and each is checked only if stated. Returning null
// rather than true for an unstated limit is the whole point.
export function judge(checkpoint, celsius) {
  const { min_celsius: min, max_celsius: max } = checkpoint;
  if (min === null && max === null) return null;
  if (min !== null && celsius < min) return false;
  if (max !== null && celsius > max) return false;
  return true;
}

function reading(checkpoint, given, where) {
  if (checkpoint.kind === 'check') {
    if (typeof given.confirmed !== 'boolean') {
      throw new BadRequest(`${where}: ${checkpoint.label} is confirmed or not, so it needs true or false`);
    }
    return { confirmed: given.confirmed ? 1 : 0, celsius: null, observedAt: null, withinLimit: null };
  }
  if (checkpoint.kind === 'time') {
    if (typeof given.observed_at !== 'string' || Number.isNaN(Date.parse(given.observed_at))) {
      throw new BadRequest(`${where}: ${checkpoint.label} records a moment, so it needs a timestamp`);
    }
    return { confirmed: null, celsius: null, observedAt: given.observed_at, withinLimit: null };
  }
  const celsius = requireReading(given.celsius, `${where}.celsius`, COOKING_RANGE);
  return { confirmed: null, celsius, observedAt: null, withinLimit: judge(checkpoint, celsius) };
}

// The rows a batch creates. All of them unanswered.
//
// A batch records what went into it at the moment the ingredients go in
// (Dean, 2026-09-02). The cooking temperature is taken while it cooks and the
// cooling ones hours later, so none of them can be asked for on the form that
// records the ingredients — they would have to be typed before they had
// happened, which is how a checkpoint becomes a number somebody invented.
//
// So every checkpoint becomes a row with the moment it falls due: now, for
// the ones taken during the batch, and later for the twelve with a clock.
// Something has to come back to all of them, and the list of what is
// outstanding is what makes that happen.
export function planReadings(checkpoints, given, lotId, eventId, envelope, where = 'checkpoints') {
  const byCode = new Map(checkpoints.map((checkpoint) => [checkpoint.code, checkpoint]));
  const answers = new Map(Object.entries(given || {}));
  const rows = [];
  const breaches = [];

  for (const checkpoint of checkpoints) {
    const answer = answers.get(checkpoint.code);

    // A clock runs from another checkpoint's own reading, so the anchor has
    // to have been answered before the due time can be known.
    let dueAt = null;
    if (checkpoint.due_minutes) {
      const anchor = answers.get(checkpoint.anchor_code);
      // The clock runs from the anchor's own reading where one has been
      // taken. At the moment the ingredients go in it has not been, so it
      // runs from the batch — and it is reset when the anchor is answered.
      const anchorAt = anchor?.observed_at || envelope.occurred_at;
      dueAt = new Date(new Date(anchorAt).getTime() + checkpoint.due_minutes * 60_000).toISOString();
    }

    if (answer === undefined) {
      // Unanswered on purpose. A checkpoint without a clock falls due
      // straight away — it is taken during the batch — and one with a clock
      // when its anchor says.
      rows.push({ checkpoint, dueAt: dueAt || envelope.occurred_at, answered: null });
      continue;
    }

    const value = reading(checkpoint, answer, `${where}.${checkpoint.code}`);
    if (value.withinLimit === false) breaches.push({ checkpoint, celsius: value.celsius });
    rows.push({ checkpoint, dueAt, answered: { ...value, note: answer.note ?? null } });
  }

  return { rows, breaches };
}

export function readingRow(db, row, lotId, eventId, envelope) {
  const { checkpoint, dueAt, answered } = row;
  return db
    .prepare(
      `INSERT INTO checkpoint_readings (id, lot_id, checkpoint_id, event_id, due_at,
                                        recorded_at, staff_id, celsius, observed_at,
                                        confirmed, within_limit, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `${lotId}:${checkpoint.code}`,
      lotId,
      checkpoint.id,
      eventId,
      dueAt,
      answered ? envelope.occurred_at : null,
      answered ? envelope.staff_id : null,
      answered ? answered.celsius : null,
      answered ? answered.observedAt : null,
      answered ? answered.confirmed : null,
      answered ? answered.withinLimit : null,
      answered ? answered.note : null,
    );
}

// Readings that are due and nobody has taken. The overdue ones are the point:
// a cooling check that never happened is a batch nobody can vouch for.
export async function pendingReadings(db) {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.lot_id, r.due_at, c.label, c.kind, c.is_ccp, c.min_celsius, c.max_celsius,
              i.name AS product_name, l.short_code, l.status
         FROM checkpoint_readings r
         JOIN checkpoints c ON c.id = r.checkpoint_id
         JOIN lots l ON l.id = r.lot_id
         JOIN items i ON i.id = l.item_id
        WHERE r.recorded_at IS NULL
        ORDER BY r.due_at`,
    )
    .all();
  return results || [];
}

// Answering one of them later. A separate submission from the batch, because
// it happens hours afterwards and by whoever is on shift then.
export async function recordReading(db, payload) {
  const envelope = await validateEnvelope(db, payload, { requireDevice: false });
  const hash = await payloadHash(payload);
  const existing = await alreadyAccepted(db, envelope.idempotency_key, hash);
  if (existing) return { duplicate: true, event_id: existing.id };

  const row = await db
    .prepare(
      `SELECT r.id, r.lot_id, r.recorded_at, r.checkpoint_id, c.label, c.kind,
              c.min_celsius, c.max_celsius, c.is_ccp
         FROM checkpoint_readings r JOIN checkpoints c ON c.id = r.checkpoint_id
        WHERE r.id = ?`,
    )
    .bind(payload.reading_id)
    .first();
  if (!row) throw new BadRequest(`unknown checkpoint reading ${JSON.stringify(payload.reading_id)}`);
  if (row.recorded_at) throw new BadRequest('that checkpoint has already been recorded');

  const value = reading(row, payload, 'reading');

  const statements = [
    eventRow(db, envelope, 'adjust', hash, payload),
    db
      .prepare(
        `UPDATE checkpoint_readings
            SET recorded_at = ?, staff_id = ?, celsius = ?, observed_at = ?, confirmed = ?,
                within_limit = ?, note = ?, answered_by_event = ?
          WHERE id = ? AND recorded_at IS NULL`,
      )
      .bind(
        envelope.occurred_at,
        envelope.staff_id,
        value.celsius,
        value.observedAt,
        value.confirmed,
        value.withinLimit,
        payload.note ?? null,
        envelope.event_id,
        row.id,
      ),
  ];

  // Anything timed from this one now has a real anchor, so its due time is
  // recomputed from the reading rather than from the batch. Cooling that
  // started at two o'clock is due at three, whenever the batch began.
  statements.push(
    db
      .prepare(
        `UPDATE checkpoint_readings
            SET due_at = datetime(?, '+' || (
                  SELECT due_minutes FROM checkpoints WHERE id = checkpoint_readings.checkpoint_id
                ) || ' minutes')
          WHERE lot_id = ? AND recorded_at IS NULL
            AND checkpoint_id IN (
              SELECT c.id FROM checkpoints c
               WHERE c.recipe_id = (SELECT recipe_id FROM checkpoints WHERE id = ?)
                 AND c.anchor_code = (SELECT code FROM checkpoints WHERE id = ?)
                 AND c.due_minutes IS NOT NULL
            )`,
      )
      .bind(envelope.occurred_at, row.lot_id, row.checkpoint_id, row.checkpoint_id),
  );

  if (value.withinLimit === false) {
    statements.push(holdFor(db, envelope, row.lot_id, row.label, value.celsius, row));
    statements.push(
      db
        .prepare("UPDATE lots SET status = 'held', updated_at = datetime('now') WHERE id = ? AND status = 'open'")
        .bind(row.lot_id),
    );
  }

  await db.batch(statements);
  return { duplicate: false, event_id: envelope.event_id, within_limit: value.withinLimit, lot_id: row.lot_id };
}

// A failed checkpoint holds the batch, using the same hold as everything else
// rather than a second kind nobody would think to check.
export function holdFor(db, envelope, lotId, label, celsius, checkpoint) {
  const limit = checkpoint.max_celsius !== null
    ? `a maximum of ${checkpoint.max_celsius}°C`
    : `a minimum of ${checkpoint.min_celsius}°C`;
  return db
    .prepare(
      `INSERT INTO holds (id, lot_id, reason, opened_at, opened_by, event_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `${envelope.event_id}-CP-${lotId}`,
      lotId,
      `${checkpoint.is_ccp ? 'CCP' : 'Checkpoint'} failed: ${label} read ${celsius}°C against ${limit}`,
      envelope.occurred_at,
      envelope.staff_id,
      envelope.event_id,
    );
}
