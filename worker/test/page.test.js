import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
