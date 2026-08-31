// Small shared response helpers. Everything the Worker returns is JSON.

export function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

export function error(status, message) {
  return json({ error: message }, { status });
}

// Thrown by handlers for a fault the caller can fix (an unknown action, a bad
// parameter). Anything else is a bug and is allowed to surface as a 500.
export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequest';
  }
}
