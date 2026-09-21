import { makeStore } from './offline.js';
import { makeSession, withAuth, untilText, PIN_LENGTH } from './auth.js';

// The sign-in screen and the fetch every form's `api()` goes through.
// The pure half, and the reasoning, is in auth.js.

const store = makeStore(window.localStorage);
export const session = makeSession(store);

const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

// A request with the current sign-in attached. If the server refuses the
// sign-in itself, it has run out or was never valid, so it is dropped and the
// screen comes back. A request that carried its own token, as a queued record
// does, says nothing about the current session and leaves it alone.
export async function authedFetch(path, options = {}) {
  const chosen = Boolean(Object.keys(options.headers || {}).some((n) => n.toLowerCase() === 'authorization'));
  const response = await fetch(path, withAuth(options, session.current()?.token));
  if (response.status === 401 && !chosen && path !== '/api/login') {
    session.clear();
    changed();
  }
  return response;
}

// ------------------------------------------------------------------ screen

let overlay = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function login(staffId, pin) {
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staff_id: staffId, pin }),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: 'No connection. Signing in needs one, so connect and try again.' } };
  }
}

function openSignIn(staff) {
  if (overlay) return;
  overlay = el('div', 'signin');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Sign in');
  const card = el('div', 'signin-card');
  overlay.append(card);
  document.body.append(overlay);

  let chosen = null;
  let digits = '';
  let busy = false;

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    overlay = null;
  }

  function showNames(message = '') {
    chosen = null;
    digits = '';
    card.replaceChildren(el('h2', null, 'Who is this?'));
    if (message) card.append(el('p', 'signin-msg', message));
    const grid = el('div', 'signin-names');
    for (const person of staff) {
      const button = el('button', 'secondary', person.name);
      button.type = 'button';
      button.addEventListener('click', () => showPin(person));
      grid.append(button);
    }
    card.append(grid);
  }

  function showPin(person, message = '') {
    chosen = person;
    digits = '';
    card.replaceChildren(el('h2', null, person.name), el('p', 'signin-hint', 'Enter your PIN'));
    const dots = el('div', 'signin-dots');
    dots.setAttribute('aria-live', 'polite');
    const note = el('p', 'signin-msg', message);
    const paint = () => {
      dots.textContent = Array.from({ length: PIN_LENGTH }, (_, i) => (i < digits.length ? '●' : '○')).join(' ');
      dots.setAttribute('aria-label', `${digits.length} of ${PIN_LENGTH} digits entered`);
    };
    paint();
    card.append(dots, note);

    const pad = el('div', 'signin-pad');
    const press = async (digit) => {
      if (busy || digits.length >= PIN_LENGTH) return;
      digits += digit;
      paint();
      if (digits.length < PIN_LENGTH) return;
      busy = true;
      note.textContent = 'Checking…';
      const result = await login(person.id, digits);
      busy = false;
      if (result.ok) {
        session.save(result.body);
        close();
        changed();
        return;
      }
      digits = '';
      paint();
      note.textContent = result.body.error || `Refused with ${result.status}`;
    };
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      const button = el('button', 'secondary', key);
      button.type = 'button';
      button.addEventListener('click', () => press(key));
      pad.append(button);
    }
    const back = el('button', 'secondary', 'Not me');
    back.type = 'button';
    back.addEventListener('click', () => showNames());
    const zero = el('button', 'secondary', '0');
    zero.type = 'button';
    zero.addEventListener('click', () => press('0'));
    const erase = el('button', 'secondary', '⌫');
    erase.type = 'button';
    erase.setAttribute('aria-label', 'Delete the last digit');
    erase.addEventListener('click', () => { digits = digits.slice(0, -1); paint(); });
    pad.append(back, zero, erase);
    card.append(pad);
  }

  // A hardware keyboard works as well as the pad.
  function onKey(event) {
    if (!chosen) return;
    if (/^\d$/.test(event.key)) card.querySelectorAll('.signin-pad button')[event.key === '0' ? 10 : Number(event.key) - 1]?.click();
    else if (event.key === 'Backspace') card.querySelector('.signin-pad button[aria-label]')?.click();
    else if (event.key === 'Escape') showNames();
  }
  document.addEventListener('keydown', onKey);

  showNames();
}

// ------------------------------------------------------------ a form's name

// Turns a form's name dropdown into "signed in as": the select stays, hidden,
// holding only the person who is signed in, so the form code that reads
// `$('staff').value` when it builds a submission keeps working unchanged. The
// server takes the person from the token regardless, so this value is only ever
// the same name, never the source of it.
export function mountStaff(select, staff) {
  if (select.dataset.signin) return;
  select.dataset.signin = '1';
  select.replaceChildren();
  const blank = new Option('Signed out', '');
  select.append(blank, ...staff.map((person) => new Option(person.name, person.id)));
  select.hidden = true;

  const field = select.closest('.field') || select.parentElement;
  const chip = el('div', 'signed-in');
  const who = el('span', 'who');
  const until = el('span', 'until');
  const swap = el('button', 'secondary', 'Not you?');
  swap.type = 'button';
  swap.addEventListener('click', () => {
    session.clear();
    changed();
  });
  chip.append(who, until, swap);
  field.append(chip);

  function apply() {
    const held = session.current();
    select.value = held ? held.staff.id : '';
    who.textContent = held ? held.staff.name : 'Not signed in';
    until.textContent = held ? ` · until ${untilText(held.expires_at)}` : '';
    swap.textContent = held ? 'Not you?' : 'Sign in';
    select.dispatchEvent(new Event('change'));
    if (!held) openSignIn(staff);
  }
  listeners.add(apply);

  // A shift's sign-in runs out while the page is still open. Noticed here, not
  // when the next submission is refused, and the form underneath is untouched.
  setInterval(() => { if (!session.current() && select.value) changed(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) apply(); });

  apply();
}
