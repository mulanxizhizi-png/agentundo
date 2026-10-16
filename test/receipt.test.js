'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { freshEnv, tmpProject, run } = require('./helpers');
const j = (r) => JSON.parse(r.stdout.trim().split('\n').pop());

test('receipt --json: not initialised -> ok:false, exit 0', () => {
  const env = freshEnv(); const d = tmpProject({ a: '1' });
  const r = run(env, d, ['receipt', '--status', 'green', '--json']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(j(r), { schemaVersion: 1, ok: false, reason: 'not-initialized' });
  assert.strictEqual(j(run(env, d, ['receipt', '--status', 'bogus', '--json'])).ok, false);
});

test('green marks last-known-good; red returns restore command; list shows marks; list --json', () => {
  const env = freshEnv(); const d = tmpProject({ 'a.js': 'good' });
  run(env, d, ['init']);
  const g = j(run(env, d, ['receipt', '--status', 'green', '--receipt', 'x-green.json', '--json']));
  assert.strictEqual(g.ok, true); assert.strictEqual(g.lastGreenSnapshotId, g.snapshotId); assert.strictEqual(g.restoreCommand, null);
  fs.writeFileSync(path.join(d, 'a.js'), 'broken');
  const r = j(run(env, d, ['receipt', '--status', 'red', '--json']));
  assert.ok(r.snapshotId > g.snapshotId);
  assert.strictEqual(r.lastGreenSnapshotId, g.snapshotId);
  assert.match(r.restoreCommand, new RegExp(`/bin/agentundo restore ${g.snapshotId}$`));
  const out = run(env, d, ['list']).out;
  assert.match(out, new RegExp(`^${g.snapshotId} .*tests passed`, 'm'));
  assert.match(out, new RegExp(`^${r.snapshotId} .*✗ tests failed`, 'm'));
  assert.match(out, /Last snapshot where tests passed \(agentreceipt\)/);
  const lj = JSON.parse(run(env, d, ['list', '--json']).stdout);
  assert.strictEqual(lj.lastGreen, g.snapshotId);
  assert.strictEqual(lj.snapshots.find((m) => m.id === g.snapshotId).receipt.receipt, 'x-green.json');
  // the restore command brings back the green state
  const cmd = r.restoreCommand.split(' ');
  assert.strictEqual(run(env, d, ['restore', cmd[cmd.length - 1], '--yes']).code, 0);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.js'), 'utf8'), 'good');
});

test('red with no green yet -> no restore command; snap --json', () => {
  const env = freshEnv(); const d = tmpProject({ 'a.js': '1' });
  run(env, d, ['init']);
  const r = j(run(env, d, ['receipt', '--status', 'blocked', '--json']));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.lastGreenSnapshotId, null); assert.strictEqual(r.restoreCommand, null);
  fs.writeFileSync(path.join(d, 'a.js'), '2');
  const s = j(run(env, d, ['snap', '--json', '--label', 'before deploy']));
  assert.strictEqual(s.ok, true); assert.strictEqual(s.created, true);
  assert.match(run(env, d, ['list']).out, /before deploy/);
});

test('cap pruning keeps the last green snapshot', () => {
  const env = freshEnv(); const d = tmpProject({ 'a.js': '1' });
  run(env, d, ['init']); run(env, d, ['snap']);
  fs.writeFileSync(path.join(d, 'a.js'), '2');
  const g = j(run(env, d, ['receipt', '--status', 'green', '--json'])).snapshotId;
  assert.ok(g > 1);
  const e = { ...env, AGENTUNDO_MAX_TOTAL_MB: '2', AGENTUNDO_KEEP_MIN: '1' };
  for (let i = 0; i < 5; i++) { fs.writeFileSync(path.join(d, 'r.bin'), require('crypto').randomBytes(1024 * 1024)); run(e, d, ['snap']); }
  const lj = JSON.parse(run(e, d, ['list', '--json']).stdout);
  assert.ok(lj.snapshots.some((m) => m.id === g), 'green kept');
  assert.ok(!lj.snapshots.some((m) => m.id === 1), 'older pruned');
  assert.strictEqual(lj.lastGreen, g);
});
