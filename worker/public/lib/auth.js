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

// "until 18:10", in the device's own time, so somebody can see a shift's
// sign-in is about to run out while they are still on wifi to renew it.
export function untilText(expiresAt) {
  return new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export const PIN_LENGTH = 4;
