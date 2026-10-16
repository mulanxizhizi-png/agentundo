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
