'use strict';
// Backward compatibility: stores/registry entries keyed by the pre-0.1.3 path (case or symlink differs).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const os = require('os');
const { freshEnv, tmpProject, run, bash } = require('./helpers');
const { storeDirFor } = require('../src/store');

const reg = (env) => JSON.parse(fs.readFileSync(path.join(env.AGENTUNDO_HOME, 'projects.json'), 'utf8')).projects;
const ids = (env, d) => run(env, d, ['list', '--all']).out.split('\n').filter((l) => /^\d+ /.test(l)).map((l) => Number(l.split(/\s+/)[0]));

// Init + one snapshot normally, then rewrite the home dir to look like an old version keyed by `legacyKey`.
function legacySetup(d, legacyKey, env = freshEnv()) {
  assert.strictEqual(run(env, d, ['init']).code, 0);
  fs.writeFileSync(path.join(d, 'a.txt'), 'v1');
  bash(env, d, 'rm -rf a.txt');
  const before = ids(env, d);
  assert.ok(before.length >= 1);
  const nw = storeDirFor(fs.realpathSync.native(d), env); const old = storeDirFor(legacyKey, env);
  assert.notStrictEqual(nw, old);
  fs.renameSync(nw, old);
  fs.writeFileSync(path.join(old, 'project.json'), JSON.stringify({ root: legacyKey }));
  fs.writeFileSync(path.join(env.AGENTUNDO_HOME, 'projects.json'), JSON.stringify({ projects: [legacyKey] }));
  return { env, before, nw, old };
}
function symlinked() {
  const d = tmpProject({ 'a.txt': 'v0' });
  const l = path.join(fs.realpathSync(os.tmpdir()), 'au-link-' + process.pid + '-' + Math.random().toString(36).slice(2));
  fs.symlinkSync(d, l);
  return { d, l };
}

for (const cmd of ['list', 'status', 'hook', 'restore']) {
  test(`legacy symlink-keyed store is migrated and visible to ${cmd}`, () => {
    const { d, l } = symlinked();
    const { env, before, nw, old } = legacySetup(d, l);
    if (cmd === 'list') assert.deepStrictEqual(ids(env, d), before);
    if (cmd === 'status') assert.strictEqual(run(env, d, ['status']).code, 0);
    if (cmd === 'hook') { fs.writeFileSync(path.join(d, 'a.txt'), 'v2'); assert.strictEqual(bash(env, d, 'rm -rf b').code, 0); }
    if (cmd === 'restore') { const r = run(env, d, ['restore', String(before[before.length - 1]), '--yes']); assert.strictEqual(r.code, 0, r.out); assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'v1'); }
    assert.ok(fs.existsSync(path.join(nw, 'shadow.git', 'HEAD')), 'store moved to canonical dir');
    assert.ok(!fs.existsSync(old), 'legacy dir renamed, not copied');
    assert.deepStrictEqual(reg(env), [d]);
    const after = ids(env, d);
    for (const i of before) assert.ok(after.includes(i), `snapshot ${i} still listed`);
  });
}

test('legacy store: uninstall --purge sees and removes old snapshots', () => {
  const { d, l } = symlinked();
  const { env, before } = legacySetup(d, l);
  const r = run(env, d, ['uninstall', '--purge', '--yes']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`${before.length} snapshots`));
  assert.ok(!fs.existsSync(path.join(env.AGENTUNDO_HOME, 'stores')) || !fs.readdirSync(path.join(env.AGENTUNDO_HOME, 'stores')).length);
});

test('legacy and new store both exist: nothing merged or deleted, new preferred, warned once', () => {
  const { d, l } = symlinked();
  const { env, old, nw } = legacySetup(d, l);
  fs.cpSync(old, nw, { recursive: true }); // a canonical store already exists next to the legacy one
  fs.writeFileSync(path.join(old, 'legacy-only.txt'), 'keep me');
  fs.writeFileSync(path.join(d, 'a.txt'), 'new'); bash(env, d, 'rm -rf x');
  const r1 = run(env, d, ['list', '--all']);
  const r2 = run(env, d, ['list', '--all']);
  assert.ok(fs.existsSync(path.join(old, 'shadow.git', 'HEAD')), 'legacy store kept');
  assert.ok(fs.existsSync(path.join(nw, 'shadow.git', 'HEAD')), 'new store kept');
  assert.ok(fs.existsSync(path.join(old, 'superseded-by-new-store.txt')));
  assert.strictEqual(fs.readFileSync(path.join(old, 'legacy-only.txt'), 'utf8'), 'keep me');
  assert.ok(!fs.existsSync(path.join(nw, 'legacy-only.txt')), 'not merged');
  assert.ok(!/older snapshot store/.test(r2.out), 'warned only once');
  assert.ok(/older snapshot store/.test(r1.out) || fs.existsSync(path.join(old, 'superseded-by-new-store.txt')));
  assert.deepStrictEqual(reg(env), [d]);
});

function caseInsensitive() {
  const t = fs.realpathSync(os.tmpdir()); const p = path.join(t, 'AuCaseProbe' + process.pid);
  fs.mkdirSync(p, { recursive: true });
  try { return fs.existsSync(p.toLowerCase().replace(t.toLowerCase(), t)); } finally { fs.rmSync(p, { recursive: true, force: true }); }
}
test('macOS: legacy store keyed by differently-cased path is migrated', { skip: !caseInsensitive() && 'needs a case-insensitive filesystem (macOS CI)' }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'au-case-')));
  const d = path.join(base, 'MyProj'); fs.mkdirSync(d);
  const alt = path.join(base, 'myproj');
  assert.strictEqual(fs.realpathSync(alt), alt, 'JS realpath keeps typed case (old algorithm)');
  assert.strictEqual(fs.realpathSync.native(alt), d);
  const { env, before, nw, old } = legacySetup(d, alt);
  assert.deepStrictEqual(ids(env, alt), before);
  assert.deepStrictEqual(ids(env, d), before);
  assert.ok(fs.existsSync(path.join(nw, 'shadow.git', 'HEAD')) && !fs.existsSync(old));
  assert.deepStrictEqual(reg(env), [d]);
});

// chmod-based tests: root ignores directory write permissions, so they would not reproduce anything there.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const noChmod = asRoot && 'running as root: root ignores permissions, so a read-only dir cannot be simulated';

test('legacy store: stores dir not writable -> registry entry kept, old store still used, snapshots reachable', { skip: noChmod }, () => {
  const { d, l } = symlinked();
  const { env, before, nw, old } = legacySetup(d, l);
  const stores = path.join(env.AGENTUNDO_HOME, 'stores');
  fs.chmodSync(stores, 0o555);
  try {
    const r = run(env, d, ['list', '--all']);
    assert.strictEqual(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /no snapshots/);
    assert.deepStrictEqual(ids(env, d), before, 'old snapshots still listed');
    assert.strictEqual((r.out.match(/could not move the older snapshot store/g) || []).length, 1, 'one-line note, once');
    assert.deepStrictEqual(reg(env), [l], 'registry entry NOT rewritten while the move is impossible');
    assert.ok(fs.existsSync(path.join(old, 'shadow.git', 'HEAD')) && !fs.existsSync(nw));
    // still works for status, new snapshots and restore, all inside the old dir
    assert.match(run(env, d, ['status']).out, /hooks active/);
    fs.writeFileSync(path.join(d, 'a.txt'), 'v2'); assert.strictEqual(bash(env, d, 'rm -rf a.txt').code, 0);
    const now = ids(env, d);
    assert.ok(now.length > before.length, 'new snapshot recorded in the old store');
    const rr = run(env, d, ['restore', String(before[before.length - 1]), '--yes']);
    assert.strictEqual(rr.code, 0, rr.out);
    assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'v1');
    assert.deepStrictEqual(reg(env), [l]);
  } finally { fs.chmodSync(stores, 0o755); }
  // once writable again, the next command migrates it and only then re-keys the registry
  assert.ok(ids(env, d).length > before.length);
  assert.ok(fs.existsSync(path.join(nw, 'shadow.git', 'HEAD')) && !fs.existsSync(old));
  assert.deepStrictEqual(reg(env), [d]);
});

test('uninstall --global --purge also removes orphaned legacy and superseded store dirs, nothing outside', () => {
  const { d, l } = symlinked();
  const { env, old, nw } = legacySetup(d, l);
  fs.cpSync(old, nw, { recursive: true }); // canonical store exists too -> legacy one gets marked superseded
  run(env, d, ['list']);
  assert.ok(fs.existsSync(path.join(old, 'superseded-by-new-store.txt')));
  const stores = path.join(env.AGENTUNDO_HOME, 'stores');
  const orphan = path.join(stores, 'abcdef0123456789'); // a store nobody references any more
  fs.mkdirSync(path.join(orphan, 'shadow.git'), { recursive: true });
  fs.writeFileSync(path.join(orphan, 'project.json'), JSON.stringify({ root: '/no/such/project' }));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'au-outside-'));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  const linked = path.join(stores, '0123456789abcdef'); fs.symlinkSync(outside, linked); // must be unlinked, not followed
  fs.writeFileSync(path.join(stores, 'not-a-store.txt'), 'x');
  const r = run(env, d, ['uninstall', '--global', '--purge', '--yes']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /older superseded store/);
  assert.match(r.out, /orphaned store/);
  for (const x of [old, nw, orphan, linked]) assert.ok(!fs.existsSync(x), `${x} removed`);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep', 'symlink target untouched');
  assert.ok(fs.existsSync(path.join(stores, 'not-a-store.txt')), 'unknown files left alone');
});

test('uninstall --purge: a store that cannot be deleted is reported and exits non-zero', { skip: noChmod }, () => {
  const { d, l } = symlinked();
  const { env, old, nw } = legacySetup(d, l);
  fs.cpSync(old, nw, { recursive: true });
  run(env, d, ['list']);
  const stores = path.join(env.AGENTUNDO_HOME, 'stores');
  fs.chmodSync(stores, 0o555);
  let r;
  try { r = run(env, d, ['uninstall', '--global', '--purge', '--yes']); } finally { fs.chmodSync(stores, 0o755); }
  assert.notStrictEqual(r.code, 0, r.out);
  assert.match(r.out, /could not delete 2 snapshot store/);
  assert.ok(r.out.includes(old) && r.out.includes(nw));
  for (const x of [old, nw]) assert.ok(fs.existsSync(path.join(x, 'shadow.git', 'HEAD')), `${x} left intact, not half-deleted`);
  // fixing permissions and re-running cleans up, even though the registry is already empty
  const r2 = run(env, os.tmpdir(), ['uninstall', '--global', '--purge', '--yes']);
  assert.strictEqual(r2.code, 0, r2.out);
  assert.ok(!fs.existsSync(old) && !fs.existsSync(nw));
});
