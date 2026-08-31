// A minimal stand-in for a D1 binding: it records the SQL and bindings each
// call made and replays canned rows. Enough to test routing, parameter
// handling and row shaping without a database. Queries themselves are
// exercised against real D1 by the migration smoke check.

export function fakeDb(rowsFor = () => []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, params: [] };
      calls.push(call);
      const statement = {
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
