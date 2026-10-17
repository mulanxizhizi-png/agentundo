'use strict';
// Regressions from the Codex acceptance run of 0.1.3 (AU-001, AU-002).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { freshEnv, tmpProject, run, hook } = require('./helpers');
const { describe } = require('../src/hook');

function setup(files) {
  const env = { ...freshEnv(), AGENTUNDO_MAX_FILE_MB: '0.01' }; // 10KB cap keeps "big file" tests fast
  const d = tmpProject(files);
  const r = run(env, d, ['init']);
  assert.strictEqual(r.code, 0, r.out);
  return { env, d };
}
const snapJson = (env, d) => { const r = run(env, d, ['snap', '--json']); assert.strictEqual(r.code, 0, r.out); return JSON.parse(r.stdout); };
const list = (env, d) => JSON.parse(run(env, d, ['list', '--json']).stdout).snapshots;
const BIG = () => Buffer.alloc(20 * 1024, 7); // over the 10KB test cap

test('AU-001: a new file over the size cap gets its own snapshot record (not deduped into the old one)', () => {
  const { env, d } = setup({ 'a.txt': 'a\n' });
  const base = list(env, d).at(-1).id;
  fs.writeFileSync(path.join(d, 'large.bin'), BIG());
  const j = snapJson(env, d);
  assert.strictEqual(j.created, true, 'skipped set changed, so this is a new snapshot');
  assert.notStrictEqual(j.id, base);
  assert.match(String(j.warnings), /large\.bin/);
  assert.deepStrictEqual(list(env, d).at(-1).skipped, ['large.bin']);
  // nothing changed since: still deduped
  const again = snapJson(env, d);
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.id, j.id);
});

test('AU-001: shrinking a once-oversized file and restoring never deletes it', () => {
  const { env, d } = setup({ 'a.txt': 'a\n' });
  const base = list(env, d).at(-1).id;
  const p = path.join(d, 'large.bin');
  fs.writeFileSync(p, BIG());
  const j = snapJson(env, d);
  fs.writeFileSync(p, 'now-small-marker');
  // restore to the snapshot that skipped it
  let r = run(env, d, ['restore', String(j.id), '--yes']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'now-small-marker');
  // restore to the baseline taken before the file existed: the store never saw its content at any
  // later snapshot, so it must keep it (and say so) rather than delete it
  r = run(env, d, ['restore', String(base), '--yes']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'now-small-marker');
  const dry = run(env, d, ['restore', String(base), '--dry-run']);
  assert.match(dry.out, /kept .*large\.bin/);
});

test('AU-001: a file that drops back under the cap is a new snapshot too', () => {
  const { env, d } = setup({ 'a.txt': 'a\n' });
  const p = path.join(d, 'large.bin');
  fs.writeFileSync(p, BIG());
  const j1 = snapJson(env, d);
  fs.rmSync(p); // tree unchanged (it was never in it), skipped set now empty
  const j2 = snapJson(env, d);
  assert.strictEqual(j2.created, true);
  assert.notStrictEqual(j2.id, j1.id);
  assert.deepStrictEqual(list(env, d).at(-1).skipped, []);
});

test('AU-001: a captured file that grows over the cap is dropped from the snapshot, and restore never overwrites it with a stale copy', () => {
  const { env, d } = setup({ 'a.txt': 'a\n', 'grow.bin': 'v1-small' }); // v1 captured by the init baseline
  const p = path.join(d, 'grow.bin');
  const big4 = Buffer.alloc(30 * 1024, 4);
  fs.writeFileSync(p, Buffer.alloc(20 * 1024, 2));
  const x = snapJson(env, d);
  assert.strictEqual(x.created, true);
  assert.deepStrictEqual(list(env, d).at(-1).skipped, ['grow.bin']);
  fs.writeFileSync(p, 'v3-small'); snapJson(env, d); // captured small again
  fs.writeFileSync(p, big4); snapJson(env, d); // big again: v4 is never saved anywhere
  const r = run(env, d, ['restore', String(x.id), '--yes']);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(fs.readFileSync(p).equals(big4), 'restore must not write an old small copy over the uncaptured big file');
});

test('AU-001: a small new file created after the target is still removed on restore', () => {
  const { env, d } = setup({ 'a.txt': 'a\n' });
  const base = list(env, d).at(-1).id;
  fs.writeFileSync(path.join(d, 'new.txt'), 'x');
  const r = run(env, d, ['restore', String(base), '--yes']);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(d, 'new.txt')));
});

test('AU-002: describe() accepts every Codex / Claude tool_input shape', () => {
  const del = '*** Begin Patch\n*** Delete File: /p/notes.txt\n*** End Patch';
  const cases = [
    ['Bash', { command: 'rm -rf a' }, 'rm -rf a'],
    ['Bash', { command: ['bash', '-lc', 'rm -rf a'] }, 'rm -rf a'],
    ['shell', { command: ['ls', '-la'] }, 'ls -la'],
    ['exec_command', { cmd: 'rm -rf notes.txt' }, 'rm -rf notes.txt'],
    ['exec_command', { cmd: ['bash', '-lc', 'rm x'] }, 'rm x'],
    ['exec_command', '{"cmd":"rm y","workdir":"/p"}', 'rm y'],
    ['Bash', 'ls -la', 'ls -la'],
    ['apply_patch', { command: del }, 'apply_patch: delete notes.txt'],
    ['apply_patch', { input: del }, 'apply_patch: delete notes.txt'],
    ['apply_patch', del, 'apply_patch: delete notes.txt'],
    ['apply_patch', { command: ['apply_patch', del] }, 'apply_patch: delete notes.txt'],
    ['Write', { file_path: '/p/n.txt', content: 'x' }, 'Write /p/n.txt'],
    ['mcp__x__y', { input: 'hello' }, 'mcp__x__y'],
    ['Bash', null, 'Bash'],
    ['Bash', '', 'Bash'],
  ];
  for (const [tool, input, want] of cases) assert.strictEqual(describe(tool, input), want, `${tool} ${JSON.stringify(input)}`);
});

const fixture = (name, d) => {
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
  delete f._comment;
  return JSON.parse(JSON.stringify(f).split('/home/user/project').join(d));
};

test('AU-002: real Codex PreToolUse payloads (shell + apply_patch) are parsed and snapshotted', () => {
  const { env, d } = setup({ 'README.md': 'line a\n', 'notes.txt': 'n\n' });
  for (const [name, label] of [['codex-pretooluse-shell.json', 'before ls -la'], ['codex-pretooluse-apply-patch.json', 'before apply_patch: update README.md']]) {
    const p = fixture(name, d);
    fs.appendFileSync(path.join(d, 'notes.txt'), 'x\n'); // make the tree differ so each step is kept
    const h = hook(env, d, p, 'codex');
    assert.strictEqual(h.code, 0, h.stderr);
    assert.ok(!/decision/.test(h.stdout));
    const last = list(env, d).at(-1);
    assert.strictEqual(last.label, label);
    assert.strictEqual(last.agent, 'codex');
  }
});

test('AU-002: exec_command {cmd} and apply_patch {input} get the dangerous-command snapshot and warning', () => {
  const { env, d } = setup({ 'README.md': 'a\n', 'notes.txt': 'n\n' });
  const base = { hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't1' };
  hook(env, d, { hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't1' }, 'codex');
  hook(env, d, { ...base, tool_name: 'exec_command', tool_input: { cmd: 'echo inspecting' } }, 'codex');
  const before = list(env, d).at(-1).id;
  let h = hook(env, d, { ...base, tool_name: 'exec_command', tool_input: { cmd: 'rm -rf notes.txt' } }, 'codex');
  let last = list(env, d).at(-1);
  assert.notStrictEqual(last.id, before);
  assert.ok(last.dangerous);
  assert.strictEqual(last.command, 'rm -rf notes.txt');
  assert.match(JSON.parse(h.stdout).systemMessage, /saved snapshot #\d+ first/);
  h = hook(env, d, { ...base, tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch\n*** Delete File: notes.txt\n*** End Patch' } }, 'codex');
  last = list(env, d).at(-1);
  assert.ok(last.dangerous);
  assert.strictEqual(last.command, 'apply_patch: delete notes.txt');
  assert.match(JSON.parse(h.stdout).systemMessage, /saved snapshot #\d+ first/);
  assert.ok(fs.existsSync(path.join(d, 'notes.txt')), 'the hook never runs the command itself');
});
