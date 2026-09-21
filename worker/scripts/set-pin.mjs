#!/usr/bin/env node
// Sets each person's sign-in PIN (PLAN.md, open question 9).
//
//   PIN_PEPPER=… node scripts/set-pin.mjs --local  --all
//   PIN_PEPPER=… node scripts/set-pin.mjs --remote "Nikin"
//   node scripts/set-pin.mjs --remote --unlock "Nikin"
//
// Run it in a terminal window of your own, not through an agent or a pipe.
// The codes are typed with the input hidden and are never printed, logged or
// put on a command line: what reaches the database is a salted HMAC of each,
// keyed with PIN_PEPPER, which must be the same value the deployed Worker holds
// as its PIN_PEPPER secret or nobody will be able to sign in. For --local it is
// read from .dev.vars when not in the environment.
//
// An administrator may set any four digits, including a code somebody already
// uses elsewhere such as a clock-in code. A weak one is warned about and needs
// a yes; self-service changes in the app refuse weak ones outright.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import readline from 'node:readline';
import { makePinRow, weakness } from '../src/auth.js';

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const local = args.includes('--local');
const all = args.includes('--all');
const unlock = args.includes('--unlock');
const names = args.filter((a) => !a.startsWith('--'));

if (remote === local || (!all && names.length !== 1) || (all && names.length) || (all && unlock)) {
  console.error('usage: set-pin.mjs (--local | --remote) (--all | "<name>") [--unlock]');
  process.exit(2);
}

const where = remote ? '--remote' : '--local';

function d1(sql) {
  const run = spawnSync('npx', ['wrangler', 'd1', 'execute', 'trace', where, '--json', '--command', sql],
    { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
  if (run.status !== 0) {
    console.error(run.stderr || run.stdout);
    process.exit(1);
  }
  return JSON.parse(run.stdout)[0].results;
}

const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;

const staff = d1('SELECT id, name FROM staff WHERE active = 1 ORDER BY name');
const targets = all ? staff : staff.filter((s) => s.name.toLowerCase() === names[0].toLowerCase());
if (!targets.length) {
  console.error(`no active staff member called ${names[0]}. Active: ${staff.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

if (unlock) {
  for (const person of targets) {
    d1(`UPDATE staff_pins SET failed_count = 0, lock_level = 0, locked_until = NULL WHERE staff_id = ${quote(person.id)}`);
    console.log(`${person.name}: unlocked`);
  }
  process.exit(0);
}

let pepper = process.env.PIN_PEPPER;
if (!pepper && local) {
  try {
    pepper = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').match(/^PIN_PEPPER=(.+)$/m)?.[1]?.trim();
  } catch { /* falls through to the message below */ }
}
if (!pepper || pepper.length < 32) {
  console.error('PIN_PEPPER must be set (32+ characters) and match the value the Worker holds as a secret.');
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error('run this in a terminal window so the codes can be typed hidden, not piped or through an agent.');
  process.exit(1);
}

// Typed input is swallowed rather than echoed.
const sink = new Writable({
  write(chunk, encoding, done) {
    if (!sink.muted) process.stdout.write(chunk, encoding);
    done();
  },
});

function ask(prompt, { hidden = true } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: sink, terminal: true });
    process.stdout.write(prompt);
    sink.muted = hidden;
    rl.question('', (answer) => {
      sink.muted = false;
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

let done = 0;
for (const person of targets) {
  const first = await ask(`${person.name}: 4-digit code (Enter to skip): `);
  if (!first) {
    console.log('  skipped');
    continue;
  }
  if (!/^\d{4}$/.test(first)) {
    console.log('  not four digits, skipped');
    continue;
  }
  if ((await ask('  again to confirm: ')) !== first) {
    console.log('  the two did not match, skipped');
    continue;
  }
  const weak = weakness(first);
  if (weak && !/^y/i.test(await ask(`  that code is ${weak}. Use it anyway? [y/N] `, { hidden: false }))) {
    console.log('  skipped');
    continue;
  }

  const row = await makePinRow({ PIN_PEPPER: pepper }, first);
  d1(`INSERT INTO staff_pins (staff_id, pin_hash, salt) VALUES (${quote(person.id)}, ${quote(row.pin_hash)}, ${quote(row.salt)})
      ON CONFLICT (staff_id) DO UPDATE SET pin_hash = excluded.pin_hash, salt = excluded.salt,
        set_at = datetime('now'), failed_count = 0, lock_level = 0, locked_until = NULL`);
  console.log('  set');
  done += 1;
}
console.log(`${done} of ${targets.length} set.`);
