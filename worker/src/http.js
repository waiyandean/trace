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

// Thrown for a refusal that is about who is asking, not what they asked:
// 401 for not signed in or signed in for too long ago, 403 for signed in as
// somebody else, 429 for a person locked out after wrong PINs, 503 when the
// server has no secret to sign with. Kept apart from BadRequest so the
// status a caller sees says which of the two it was.
export class AuthError extends Error {
  constructor(status, message, { retryAfter = null } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
