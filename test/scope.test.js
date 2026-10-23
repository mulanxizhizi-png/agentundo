'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { matchGlob, pathsFromBash, pathsFromTool, checkScope } = require('../src/scope');
const { freshEnv, tmpProject, run, bash, hook } = require('./helpers');

function setup(files = {}) {
  const env = freshEnv();
  const d = tmpProject({ 'src/a.js': '1', 'docs/x.md': 'd', ...files });
  run(env, d, ['init', '--yes']);
  return { env, d };
}
function writeCfg(d, cfg) {
  fs.mkdirSync(path.join(d, '.agentundo'), { recursive: true });
  fs.writeFileSync(path.join(d, '.agentundo', 'config.json'), JSON.stringify(cfg));
}
function msgOf(h) {
  if (!h.stdout.trim()) return '';
  return JSON.parse(h.stdout).systemMessage || '';
}

test('matchGlob: **, *, ?', () => {
  assert.ok(matchGlob('src/a.js', 'src/**'));
  assert.ok(matchGlob('src/deep/b.js', 'src/**'));
  assert.ok(!matchGlob('docs/x.md', 'src/**'));
  assert.ok(matchGlob('README.md', '*.md'));
  assert.ok(!matchGlob('docs/x.md', '*.md'));
  assert.ok(matchGlob('docs/x.md', '**/*.md'));
  assert.ok(matchGlob('a.js', '?.js'));
  assert.ok(!matchGlob('ab.js', '?.js'));
});

test('pathsFromBash: redirects and mutators', () => {
  assert.deepStrictEqual(pathsFromBash('echo hi > docs/x.md'), ['docs/x.md']);
  assert.deepStrictEqual(pathsFromBash('cp src/a.js docs/b.js'), ['src/a.js', 'docs/b.js']);
  assert.deepStrictEqual(pathsFromBash('rm -rf docs/x.md'), ['docs/x.md']);
  assert.deepStrictEqual(pathsFromBash('ls docs'), []);
  assert.ok(pathsFromBash('bash -c "echo x > out.txt"').includes('out.txt'));
});

test('pathsFromTool: Write / patch', () => {
  assert.deepStrictEqual(
    pathsFromTool('Write', { file_path: '/p/docs/x.md', content: 'x' }, 'Write /p/docs/x.md'),
    ['/p/docs/x.md'],
  );
  const patch = '*** Begin Patch\n*** Add File: docs/n.md\n*** End Patch\n';
  assert.deepStrictEqual(pathsFromTool('apply_patch', { input: patch }, null), ['docs/n.md']);
});

test('allowPaths: unconfigured → no out-of-scope warning', () => {
  const { env, d } = setup();
  const h = hook(env, d, {
    hook_event_name: 'PreToolUse', tool_name: 'Write',
    tool_input: { file_path: path.join(d, 'docs/y.md'), content: 'x' },
  });
  assert.strictEqual(h.code, 0);
  assert.ok(!/out-of-scope/.test(msgOf(h)), msgOf(h));
  const j = JSON.parse(run(env, d, ['list', '--json']).stdout);
  assert.ok(!j.snapshots.some((s) => s.outOfScope));
});

test('allowPaths: Write inside glob → no warning', () => {
  const { env, d } = setup();
  writeCfg(d, { allowPaths: ['src/**'] });
  const h = hook(env, d, {
    hook_event_name: 'PreToolUse', tool_name: 'Write',
    tool_input: { file_path: path.join(d, 'src/b.js'), content: 'x' },
  });
  assert.strictEqual(h.code, 0);
  assert.ok(!/out-of-scope/.test(msgOf(h)), msgOf(h));
  const j = JSON.parse(run(env, d, ['list', '--json']).stdout);
  const last = j.snapshots[j.snapshots.length - 1];
  assert.ok(!last.outOfScope, JSON.stringify(last));
});

test('allowPaths: Write outside glob → warn + meta.outOfScope + list mark', () => {
  const { env, d } = setup();
  writeCfg(d, { allowPaths: ['src/**'] });
  const h = hook(env, d, {
    hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Write',
    tool_input: { file_path: path.join(d, 'docs/y.md'), content: 'x' },
  });
  assert.strictEqual(h.code, 0);
  const msg = msgOf(h);
  assert.match(msg, /out-of-scope/);
  assert.match(msg, /docs\/y\.md/);
  assert.match(msg, /agentundo restore \d+/);
  assert.match(msg, /只提醒不拦/);
  const j = JSON.parse(run(env, d, ['list', '--json']).stdout);
  const last = j.snapshots.filter((s) => s.outOfScope).pop();
  assert.ok(last, 'expected outOfScope snapshot');
  assert.ok(last.outOfScopePaths.some((p) => /docs\/y\.md$/.test(p)));
  const text = run(env, d, ['list']).out;
  assert.match(text, /⚠ out-of-scope/);
});

test('allowPaths: READ_ONLY tools skip (no warning, no new behaviour)', () => {
  const { env, d } = setup();
  writeCfg(d, { allowPaths: ['src/**'] });
  const before = JSON.parse(run(env, d, ['list', '--json']).stdout).snapshots.length;
  const h = hook(env, d, {
    hook_event_name: 'PreToolUse', tool_name: 'Read',
    tool_input: { file_path: path.join(d, 'docs/x.md') },
  });
  assert.strictEqual(h.code, 0);
  assert.strictEqual(h.stdout.trim(), '');
  const after = JSON.parse(run(env, d, ['list', '--json']).stdout).snapshots.length;
  assert.strictEqual(after, before);
});

test('allowPaths: Bash write outside → warn', () => {
  const { env, d } = setup();
  writeCfg(d, { allowPaths: ['src/**'] });
  const h = bash(env, d, 'echo x > docs/out.txt');
  assert.strictEqual(h.code, 0);
  const msg = msgOf(h);
  assert.match(msg, /out-of-scope/);
  assert.match(msg, /docs\/out\.txt/);
  const j = JSON.parse(run(env, d, ['list', '--json']).stdout);
  assert.ok(j.snapshots.some((s) => s.outOfScope));
});

test('allowPaths: Bash write inside → quiet', () => {
  const { env, d } = setup();
  writeCfg(d, { allowPaths: ['src/**'] });
  const h = bash(env, d, 'echo x > src/c.js');
  assert.ok(!/out-of-scope/.test(msgOf(h)), msgOf(h));
});

test('allowPaths: empty array = off', () => {
  const { env, d } = setup();
  writeCfg(d, { allowPaths: [] });
  const h = hook(env, d, {
    hook_event_name: 'PreToolUse', tool_name: 'Write',
    tool_input: { file_path: path.join(d, 'docs/y.md'), content: 'x' },
  });
  assert.ok(!/out-of-scope/.test(msgOf(h)));
});

test('checkScope: absolute path outside project is out-of-scope when configured', () => {
  const root = '/tmp/proj-scope-root';
  const r = checkScope(['/etc/passwd'], ['src/**'], root, root);
  assert.strictEqual(r.outOfScope, true);
});
