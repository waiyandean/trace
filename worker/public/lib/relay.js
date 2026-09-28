// The print relay's address, and whether it is answering — not a setting.
//
// This used to be a text field, backed by localStorage, on every form that
// prints (Goods In, Stock, Batches). There is exactly one relay for this
// domain, so that field was never a real choice, only a way to break
// printing for everybody by mistyping it, or a way it could quietly point
// somewhere stale after Drive synced a change nobody knew to update here
// too. `labels/app.js` hit the same problem first (2026-09-18) and this is
// the same fix, shared rather than copied three times: a fixed constant, and
// a read-only status pill showing whether it is answering right now.

// The tunnel in front of the relay on the kitchen laptop, fronted by
// Cloudflare (PLAN.md, "getting the browser to the printer needed its own
// small piece of infrastructure").
export const RELAY = 'https://print-relay.deanops.uk';

// Whether to print at all is still a real, staff-facing choice — "leave this
// blank" used to be how the old text field skipped printing and fell back to
// writing the short code on the case by hand, and that fallback is kept, as
// a plain on/off rather than an empty text box that happened to mean the
// same thing. One key, shared across every form the same way the old one
// was: set it on any page, it applies on all of them.
export const PRINT_ENABLED_KEY = 'trace.intake.printing';

// Mounts the status pill into `container` (an element already in the page)
// and starts checking. Same triggers throughout: on load, on focus and
// visibility change, and its own 30s interval, since the relay can drop
// between one print and the next with nothing else to notice it. A 4s
// timeout on the check itself, so a relay that is up but hung reads as
// offline rather than leaving the pill on "checking…" forever. Returns a
// function to call right after a print attempt, since that is the moment
// most worth an extra check outside the interval.
export function mountRelayStatus(container) {
  const dot = document.createElement('span');
  dot.className = 'dot';
  const text = document.createElement('span');
  text.textContent = 'Checking relay…';
  container.className = 'relay-status';
  container.append(dot, text);

  async function check() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`${RELAY}/health`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.json();
      container.dataset.state = 'ok';
      text.textContent = 'Relay online';
    } catch {
      container.dataset.state = 'bad';
      text.textContent = 'Relay offline';
    } finally {
      clearTimeout(timeout);
    }
  }

  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  setInterval(check, 30000);
  check();

  return check;
}
