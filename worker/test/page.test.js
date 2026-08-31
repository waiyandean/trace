import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// The form's JavaScript reaches for elements by id. A renamed or dropped id
// is a runtime failure on an iPad at the goods-in door rather than anything
// the module system catches, so the two files are checked against each other
// here instead.

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/goods-in.js', import.meta.url), 'utf8');

const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
const used = new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]));

test('every element the form reaches for exists in the page', () => {
  const missing = [...used].filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `goods-in.js asks for ids the page does not have: ${missing.join(', ')}`);
});

test('the page loads its script as a module, so imports work', () => {
  assert.match(html, /<script type="module" src="\/goods-in\.js"><\/script>/);
});

test('the form is sized for a thumb rather than a cursor', () => {
  // 44px is the smallest target a wet finger hits reliably; the whole point
  // of this form is that it is used standing up, holding a box.
  assert.match(html, /min-height: 44px/);
  assert.match(html, /viewport-fit=cover/);
});

test('no rule sets display on a dialog unless it is scoped to [open]', () => {
  // A closed <dialog> is hidden by the browser's own `display: none`. Any
  // rule that sets `display` on a dialog selector without `[open]` beats it,
  // and the sheet then sits in the page flow below the form, permanently
  // open. It cost a round trip to spot, so it is pinned here.
  const styles = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const rules = styles.split('}');

  const offenders = rules
    .filter((rule) => /(^|[\s,>+~])(dialog|#[\w-]*dialog)\b/.test(rule.split('{')[0] || ''))
    .filter((rule) => /display\s*:/.test(rule))
    .filter((rule) => !/\[open\]/.test(rule.split('{')[0]))
    .map((rule) => (rule.split('{')[0] || '').trim());

  assert.deepEqual(offenders, []);
});

// The service worker caches a fixed list of files by path. A renamed or moved
// file means install() rejects and the worker never activates, which shows up
// as "offline stopped working" long after the change that caused it.

const serviceWorker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

test('every file the service worker precaches exists', () => {
  const shell = serviceWorker.match(/const SHELL = \[([^\]]+)\]/)[1];
  const paths = [...shell.matchAll(/'([^']+)'/g)].map((match) => match[1]);

  const missing = paths.filter((path) => {
    if (path === '/') return false; // served from index.html
    return !existsSync(new URL(`../public${path}`, import.meta.url));
  });
  assert.deepEqual(missing, []);
});

test('the shell precaches / rather than /index.html', () => {
  // Workers' static assets answer /index.html with a 307 to /, and a cached
  // redirect cannot satisfy a navigation. Checked because the failure only
  // appears offline, which is the one time nobody can debug it.
  assert.doesNotMatch(serviceWorker.match(/const SHELL = \[([^\]]+)\]/)[1], /index\.html/);
});

test('the service worker leaves the API alone', () => {
  // The queue in lib/offline.js is the only retry mechanism. A second one
  // hiding in the cache layer would make a stuck submission impossible to
  // reason about.
  assert.match(serviceWorker, /url\.pathname\.startsWith\('\/api\/'\)\) return/);
});

test('the cache name carries a version, so a deploy cannot be outlived', () => {
  assert.match(serviceWorker, /const VERSION = '[\d.-]+'/);
  assert.match(serviceWorker, /trace-shell-\$\{VERSION\}/);
});

test('the page registers the service worker and shows its version', () => {
  assert.match(script, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
  assert.match(script, /App version/);
});

test('a checkbox keeps the tick the browser draws for it', () => {
  // `appearance: none` on a bare `input` selector strips a checkbox's tick
  // entirely: it goes on toggling while showing nothing, which reads as a
  // broken control. The generic field styling must exclude checkboxes.
  const styles = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const offenders = styles
    .split('}')
    .filter((rule) => /appearance\s*:\s*none/.test(rule))
    .map((rule) => (rule.split('{')[0] || '').trim())
    .filter((selector) => /(^|[\s,])input\b/.test(selector))
    .filter((selector) => !/not\(\[type="checkbox"\]\)/.test(selector));

  assert.deepEqual(offenders, []);
});

test('the attestations start unticked in the markup', () => {
  // A box that starts ticked records that the form was submitted, not that
  // anybody checked.
  for (const id of ['condition-ok', 'labels-applied', 'allergens-confirmed']) {
    const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))[0];
    assert.doesNotMatch(tag, /checked/, `${id} must not be pre-ticked`);
  }
});

test('the hidden attribute beats the classes that set display', () => {
  // `hidden` is only a `display: none` in the browser's own stylesheet, so a
  // class like `.row { display: flex }` overrides it. Two controls the form
  // hides — the device picker and the product temperature box — carry such a
  // class, and both were on screen because of it. The override is what makes
  // `el.hidden = true` mean anything here.
  const styles = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.match(styles, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});

test('everything the page hides is hidden by that attribute, not by a class', () => {
  // If a control were hidden some other way the rule above would not protect
  // it, so the two must stay in step.
  const hiddenInMarkup = [...html.matchAll(/id="([^"]+)"[^>]*\shidden/g)].map((m) => m[1]);
  const hiddenInScript = [...script.matchAll(/\$\('([^']+)'\)\.hidden\s*=/g)].map((m) => m[1]);
  const unmanaged = hiddenInMarkup.filter((id) => !hiddenInScript.includes(id));
  assert.deepEqual(unmanaged, [], 'these start hidden and nothing ever shows them');
});
