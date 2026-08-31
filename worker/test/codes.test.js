import test from 'node:test';
import assert from 'node:assert/strict';
import { mintCode, isCode, issueCodes } from '../src/ledger/codes.js';

// A fixed byte source, so the alphabet mapping can be asserted rather than
// sampled.
const bytes = (values) => ({ getRandomValues: (target) => target.set(values) && target });

test('a code is six characters from the unambiguous alphabet', () => {
  const code = mintCode();
  assert.equal(code.length, 6);
  assert.ok(isCode(code));
});

test('the ambiguous glyphs never appear', () => {
  // Every byte value maps through the alphabet, so 256 codes cover it.
  for (let i = 0; i < 256; i += 1) {
    const code = mintCode(bytes([i, i, i, i, i, i]));
    assert.doesNotMatch(code, /[ILOU]/, `byte ${i} produced ${code}`);
  }
});

test('the low five bits pick the symbol', () => {
  // 32 and 33 wrap back onto the first two symbols, which is what keeps every
  // symbol equally likely without rejecting any byte.
  assert.equal(mintCode(bytes([0, 1, 2, 31, 32, 33])), '012Z01');
});

test('a malformed code is not accepted as one', () => {
  assert.equal(isCode('ABC'), false);
  assert.equal(isCode('ABCDEFG'), false);
  assert.equal(isCode('ABCDEI'), false, 'I is not in the alphabet');
  assert.equal(isCode(null), false);
});

// Enough of a database to follow the issue loop: it holds a device and a set
// of codes, and grows as codes are inserted.
function poolDb({ device = { id: 'd1', name: 'Goods In iPad', active: 1 }, held = [] } = {}) {
  const codes = [...held];
  return {
    codes,
    async batch(statements) {
      for (const statement of statements) codes.push({ code: statement.code, issued_at: 'now' });
      return statements.map(() => ({ success: true }));
    },
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              return sql.includes('FROM devices') && params[0] === device?.id ? device : null;
            },
            async all() {
              return { results: codes };
            },
            code: params[0],
          };
        },
      };
    },
  };
}

test('issuing tops the pool up to what was asked for', async () => {
  const db = poolDb();
  const pool = await issueCodes(db, 'd1', 4);
  assert.equal(pool.held, 4);
});

test('a pool that is already full issues nothing new', async () => {
  const held = [{ code: 'AAAAAA' }, { code: 'BBBBBB' }, { code: 'CCCCCC' }];
  const db = poolDb({ held });
  const pool = await issueCodes(db, 'd1', 3);
  assert.equal(pool.held, 3);
  assert.equal(db.codes.length, 3, 'no codes were minted');
});

test('an unregistered device gets no codes', async () => {
  const db = poolDb();
  await assert.rejects(() => issueCodes(db, 'typo', 4), /unknown device: typo/);
});

test('an unreasonable request is refused rather than served', async () => {
  const db = poolDb();
  await assert.rejects(() => issueCodes(db, 'd1', 5000), /between 1 and 500/);
  await assert.rejects(() => issueCodes(db, 'd1', 0), /between 1 and 500/);
});
