'use strict';
// Undo-debt pack (2026-10-23): AU-003 error-log fallback, outside local DB list/no-Undo,
// sqlite .shell/.backup danger dots.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { analyze, cannotUndo, unrestorableLocalDb } = require('../src/danger');
const { Store, homeDir } = require('../src/store');
const { freshEnv, tmpProject, run, bash, hook } = require('./helpers');

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const noChmod = asRoot && 'running as root: root ignores permissions, so a read-only dir cannot be simulated';

function setup(files) {
  const env = freshEnv();
  const d = tmpProject(files);
  assert.strictEqual(run(env, d, ['init']).code, 0);
  return { env, d };
}
function msgOf(h) {
  if (!h.stdout.trim()) return '';
  return JSON.parse(h.stdout).systemMessage || '';
}

// ---- 1) AU-003: readonly error log ----
test('AU-003: logError falls back when store dir is not writable; tip on stderr; hook stays exit 0', { skip: noChmod }, () => {
  const { env, d } = setup({ 'a.txt': '1' });
  const store = new Store(d, env);
  // Make the store dir itself read-only (errors.log can't be created/appended).
  fs.chmodSync(store.dir, 0o555);
  let tip = '';
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { tip += String(chunk); return orig.call(process.stderr, chunk, ...rest); };
  let result;
  try {
    result = store.logError('simulated snapshot failure');
  } finally {
    process.stderr.write = orig;
    fs.chmodSync(store.dir, 0o755);
  }
  assert.ok(result.fallback, 'used fallback');
  assert.strictEqual(result.wrote, store.errorsFallback);
  assert.match(tip, /could not write/);
  assert.match(tip, /errors-fallback\.log/);
  assert.ok(fs.existsSync(store.errorsFallback));
  assert.match(fs.readFileSync(store.errorsFallback, 'utf8'), /simulated snapshot failure/);
  assert.match(store.lastError(), /simulated snapshot failure/);
  // Hook must still exit 0 even if logging path is awkward (fail-open).
  const h = bash(env, d, 'echo ok');
  assert.strictEqual(h.code, 0);
});

test('AU-003: when both primary and fallback are unwritable, stderr still shows the error; no throw', { skip: noChmod }, () => {
  const { env, d } = setup({ 'a.txt': '1' });
  const store = new Store(d, env);
  fs.chmodSync(store.dir, 0o555);
  const home = homeDir(env);
  const prev = fs.statSync(home).mode;
  fs.chmodSync(home, 0o555);
  let tip = '';
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { tip += String(chunk); return orig.call(process.stderr, chunk, ...rest); };
  let result;
  try {
    result = store.logError('nowhere to write');
  } finally {
    process.stderr.write = orig;
    fs.chmodSync(home, prev);
    fs.chmodSync(store.dir, 0o755);
  }
  assert.strictEqual(result.wrote, null);
  assert.match(tip, /could not write error log/);
  assert.match(tip, /nowhere to write/);
});

// ---- 2) outside local DB: list visible, no Undo restore hint ----
test('outside local DB: list shows reminder row; hook message has no Undo restore; in-project still has Undo', () => {
  const { env, d } = setup({ 'app.db': 'sqlite' });
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'au-outdb-')));
  fs.writeFileSync(path.join(outside, 'other.db'), 'x');

  const inMsg = msgOf(bash(env, d, 'sqlite3 app.db "DELETE FROM users"'));
  assert.match(inMsg, /DELETE FROM — saved snapshot #\d+ first\. Undo: agentundo restore \d+/);
  assert.doesNotMatch(inMsg, /can't restore that database/);

  const outMsg = msgOf(bash(env, d, `sqlite3 ${outside}/other.db "DELETE FROM users"`));
  assert.match(outMsg, /⚠/);
  assert.match(outMsg, /saved snapshot #\d+ first/);
  assert.match(outMsg, /can't restore that database/);
  assert.doesNotMatch(outMsg, /Undo: agentundo restore/);
  assert.match(outMsg, /heads-up/);
  assert.strictEqual(bash(env, d, `sqlite3 ${outside}/other.db "DELETE FROM users"`).code, 0);

  const list = run(env, d, ['list', '--all']).out;
  assert.match(list, new RegExp(`before sqlite3 ${outside}/other\\.db`));
  assert.match(list, /outside\/local DB: not undoable/);
  const j = JSON.parse(run(env, d, ['list', '--json']).out);
  const outs = j.snapshots.filter((s) => s.outsideDb);
  assert.ok(outs.length >= 1);
  assert.ok(outs.every((s) => s.command && s.command.includes('other.db')));
});

test('unrestorableLocalDb: outside sqlite true; in-project sqlite false; remote not local-unrestorable', () => {
  const d = tmpProject({ 'app.db': 'x' }, { git: false });
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'au-u-')));
  fs.writeFileSync(path.join(outside, 'x.db'), 'x');
  const o = { cwd: d, maxFileMB: 50, excluded: () => false };
  assert.ok(unrestorableLocalDb(`sqlite3 ${outside}/x.db "DELETE FROM t"`, d, o));
  assert.ok(!unrestorableLocalDb('sqlite3 app.db "DELETE FROM t"', d, o));
  assert.ok(!unrestorableLocalDb('psql -h db.example.com -c "DELETE FROM t"', d, o)); // remote path
  assert.ok(cannotUndo(`sqlite3 ${outside}/x.db "DELETE FROM t"`, d, o));
});

// ---- 3) sqlite danger dots ----
test('sqlite .shell / .backup: dangerous + dedicated snapshot; plain SQL write is not a false positive', () => {
  for (const [cmd, reason] of [
    ['sqlite3 app.db ".shell touch /tmp/x"', 'sqlite .shell'],
    ['sqlite3 app.db ".backup /tmp/x.db"', 'sqlite .backup'],
    ['sqlite3 app.db ".system ls"', 'sqlite .system'],
    ['sqlite3 app.db "DELETE FROM t" ".shell id"', 'sqlite .shell'],
  ]) {
    const a = analyze(cmd);
    assert.ok(a.dangerous, cmd);
    assert.ok(a.reasons.includes(reason), `${cmd} => ${a.reasons}`);
  }
  // Counter-examples: ordinary SQL / text mentioning dots must not flag.
  for (const cmd of [
    'sqlite3 app.db "INSERT INTO t VALUES (1)"',
    'sqlite3 app.db "UPDATE t SET a=1"',
    'sqlite3 app.db "SELECT * FROM t"',
    'echo ".shell touch x"',
    'grep ".backup" notes.md',
    'sqlite3 app.db "CREATE TABLE t(a)"',
  ]) {
    const a = analyze(cmd);
    assert.ok(!a.reasons.some((r) => r.startsWith('sqlite .')), cmd);
  }

  const { env, d } = setup({ 'app.db': 'x', 'keep.txt': '1' });
  bash(env, d, 'echo hi'); // establish a turn/tool snap
  const before = JSON.parse(run(env, d, ['list', '--json']).out).snapshots.at(-1).id;
  // Unchanged tree: .shell alone must still create a dedicated snap.
  const h = bash(env, d, 'sqlite3 app.db ".shell true"');
  assert.strictEqual(h.code, 0);
  const msg = msgOf(h);
  assert.match(msg, /sqlite \.shell/);
  assert.match(msg, /saved snapshot #/);
  const after = JSON.parse(run(env, d, ['list', '--json']).out).snapshots;
  assert.ok(after.at(-1).id > before);
  assert.ok(after.at(-1).dangerous);
  assert.deepStrictEqual(after.at(-1).reasons, ['sqlite .shell']);
  const list = run(env, d, ['list', '--dangerous']).out;
  assert.match(list, /sqlite \.shell/);
});
