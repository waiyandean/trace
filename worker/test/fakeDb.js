// A minimal stand-in for a D1 binding: it records the SQL and bindings each
// call made and replays canned rows. Enough to test routing, parameter
// handling and row shaping without a database. Queries themselves are
// exercised against real D1 by the migration smoke check.

export function fakeDb(rowsFor = () => []) {
  const calls = [];
  const batches = [];
  return {
    calls,
    // Statements handed to batch(), flattened, so a test can assert what one
    // submission actually wrote without a database.
    batches,
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
    prepare(sql) {
      const call = { sql, params: [] };
      calls.push(call);
      const statement = {
        call,
        bind(...params) {
          call.params = params;
          return statement;
        },
        async all() {
          return { results: rowsFor(call) };
        },
        async first() {
          return rowsFor(call)[0] ?? null;
        },
      };
      return statement;
    },
  };
}
