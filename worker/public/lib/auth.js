// The sign-in half the forms share, kept apart from the DOM so it can be
// tested on its own (signin.js is the part that draws things).
//
// A person signs in with a PIN and the server hands back a token good for a
// shift. From then on the server takes who is recording from that token and
// ignores any name the page sends, so nothing on this side decides who
// somebody is; it only holds the token and shows whose it is.

export const SESSION_KEY = 'trace.auth';

export function makeSession(store, now = () => Date.now()) {
  return {
    // Only a sign-in that has not run out. An expired one is not a session:
    // the server would refuse a new record made with it.
    current() {
      const held = store.read(SESSION_KEY, null);
      return held && held.token && held.staff && held.expires_at > now() ? held : null;
    },
    save(login) {
      return store.write(SESSION_KEY, { token: login.token, expires_at: login.expires_at, staff: login.staff });
    },
    clear() {
      store.write(SESSION_KEY, null);
    },
  };
}

// Adds the token to a request unless the caller already chose one. A record
// waiting in the offline queue carries the token of the person who keyed it,
// and must go out with that one: sending it with whoever happens to be signed
// in when the wifi returns would be refused as somebody else's.
export function withAuth(options = {}, token = null) {
  const headers = { ...(options.headers || {}) };
  if (!token || Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) return options;
  return { ...options, headers: { ...headers, authorization: `Bearer ${token}` } };
}

export const bearer = (token) => ({ authorization: `Bearer ${token}` });

// One person hands the iPad to the next all day, so a session staying open
// after a write is submitted is what lets the wrong name sit there unnoticed
// (Dean, 2026-09-24). This is one write closing one recorded act, so the
// device signs itself out the moment that act is accepted, and the next
// person has to identify themselves before anything else can be recorded.
//
// This is a proactive local choice, not a server-side revocation: the token
// itself is still valid server-side until it naturally expires (TOKEN_TTL_S
// in src/auth.js). What this stops is the ordinary case this exists for — a
// name being left selected because nobody thought to switch it — not someone
// deliberately holding onto a bearer token outside the app.
//
// Not every successful POST is "a form closed": `/api/codes` is the device
// topping its own short-code pool up in the background, never something a
// person did; `/api/pin` is changing your own PIN, which is about signing in,
// not a record of anything trace tracks; and `/api/devices` is a device
// registering itself on first load, which can happen before anybody has even
// opened the sign-in screen and records nothing either.
const NOT_A_CLOSED_FORM = ['/api/codes', '/api/pin', '/api/devices'];

export function signsOutAfter(path, options, ok, chosen) {
  // A request that already carried its own token — a queued record going out
  // with the token of whoever keyed it, not the session live on the device
  // right now — says nothing about who is holding the device this moment.
  if (chosen) return false;
  // Refused: the person is still sat there fixing the form, not walking away.
  if (!ok) return false;
  if ((options?.method || 'GET').toUpperCase() !== 'POST') return false;
  const bare = String(path).split('?')[0];
  return !NOT_A_CLOSED_FORM.some((prefix) => bare.startsWith(prefix));
}

// "until 18:10", in the device's own time, so somebody can see a shift's
// sign-in is about to run out while they are still on wifi to renew it.
export function untilText(expiresAt) {
  return new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export const PIN_LENGTH = 4;
