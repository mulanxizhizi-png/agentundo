'use strict';
// `agentundo changes` (pack 5): read-only per-turn summary, grouping, --md, --batches, edge cases.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');
const { classify, summarize } = require('../src/changes');
const { freshEnv, tmpProject, run, bash, prompt } = require('./helpers');

const write = (d, f, c) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };

// init -> turn 1 (one command so the turn has a snapshot) -> `edit()` -> turn 2 starts (snapshot of the end of turn 1).
function oneTurn(files, edit) {
  const env = freshEnv();
  const d = tmpProject(files);
  assert.strictEqual(run(env, d, ['init']).code, 0);
  assert.strictEqual(prompt(env, d, 'p1').code, 0);
  assert.strictEqual(bash(env, d, 'echo hi').code, 0);
  edit(d);
  assert.strictEqual(prompt(env, d, 'p2').code, 0);
  return { env, d };
}
const json = (env, d, ...a) => JSON.parse(run(env, d, ['changes', ...a, '--json']).stdout);
const gitState = (d) => {
  const out = [];
  const walk = (dir) => { for (const n of fs.readdirSync(dir).sort()) { const p = path.join(dir, n); const st = fs.lstatSync(p); if (st.isDirectory()) walk(p); else out.push(`${path.relative(d, p)}:${st.size}:${st.mtimeMs}`); } };
  walk(path.join(d, '.git'));
  return out.join('\n');
};

const BASE = { 'package.json': '{"name":"x"}\n', 'src/a.js': 'a\n', 'src/b.js': 'b\n', 'src/gone.js': 'x\ny\n', 'README.md': 'hello\n' };

test('turn with 4 added / 2 modified / 1 deleted: counts and line totals match', () => {
  const { env, d } = oneTurn(BASE, (d) => {
    write(d, 'src/n1.js', '1\n2\n3\n'); write(d, 'src/n2.js', 'x\n'); write(d, 'test/n3.test.js', 't\n'); write(d, 'docs/n4.md', '# d\n');
    write(d, 'src/a.js', 'a\naa\n'); write(d, 'src/b.js', 'B\n');
    fs.rmSync(path.join(d, 'src/gone.js'));
  });
  const r = run(env, d, ['changes', 't1']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.stdout, /4 个新增 · 2 个修改 · 1 个删除 · \+8\/−3 行/);
  const j = json(env, d, 't1');
  assert.deepStrictEqual(j.totals, { files: 7, added: 4, modified: 2, deleted: 1, add: 8, del: 3, binary: 0 });
  assert.strictEqual(j.files.find((f) => f.path === 'src/gone.js').kind, 'deleted');
  assert.strictEqual(j.files.find((f) => f.path === 'src/gone.js').del, 2);
  // the numbers agree with git itself (user's repo, untracked files included)
  const { gitOut } = require('./helpers');
  assert.strictEqual(gitOut(d, 'status', '--porcelain', '-uall').split('\n').filter((l) => /^\?\?/.test(l)).length, 4);
  // latest turn (t2) has no changes yet
  const e = run(env, d, ['changes']);
  assert.strictEqual(e.code, 0);
  assert.match(e.stdout, /没有文件变化/);
});

test('since a snapshot id: includes later changes up to now (working tree)', () => {
  const { env, d } = oneTurn(BASE, (d) => write(d, 'src/n1.js', 'n\n'));
  write(d, 'src/late.js', 'l\n'); // not snapshotted yet
  const j = json(env, d, '1');
  assert.deepStrictEqual(j.files.map((f) => f.path).sort(), ['src/late.js', 'src/n1.js']);
  const t2 = json(env, d); // default = latest turn (t2) -> current tree
  assert.deepStrictEqual(t2.files.map((f) => f.path), ['src/late.js']);
});

test('package.json + lockfiles land in the deps group; config/docs/test grouped; highlights shown', () => {
  const { env, d } = oneTurn({ ...BASE, 'package-lock.json': '{}\n' }, (d) => {
    write(d, 'package.json', '{"name":"x","dependencies":{"a":"1"}}\n'); write(d, 'package-lock.json', '{"v":2}\n'); write(d, 'yarn.lock', 'y\n');
    write(d, 'requirements.txt', 'flask\n'); write(d, 'Dockerfile', 'FROM x\n'); write(d, '.github/workflows/ci.yml', 'on: push\n'); write(d, 'vite.config.ts', 'export {}\n');
    write(d, 'svc/server.js', 's\n'); write(d, 'CHANGELOG.md', 'c\n');
  });
  const j = json(env, d, 't1');
  const cat = (p) => j.files.find((f) => f.path === p).category;
  for (const p of ['package.json', 'package-lock.json', 'yarn.lock', 'requirements.txt']) assert.strictEqual(cat(p), 'deps', p);
  for (const p of ['Dockerfile', '.github/workflows/ci.yml', 'vite.config.ts']) assert.strictEqual(cat(p), 'config', p);
  assert.strictEqual(cat('CHANGELOG.md'), 'docs');
  const t = run(env, d, ['changes', 't1']).stdout;
  assert.match(t, /依赖与锁文件（4）/);
  assert.match(t, /新增顶层目录：.*svc/);
  assert.match(t, /新增入口文件：svc\/server\.js/);
  assert.match(t, /! 依赖与锁文件有变化：.*package\.json/);
  assert.match(t, /配置文件有变化：/);
});

test('binary files, paths with spaces, empty turn do not crash', () => {
  const { env, d } = oneTurn({ ...BASE, 'a b/c d.txt': '1\n' }, (d) => {
    fs.writeFileSync(path.join(d, 'img.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
    write(d, 'a b/c d.txt', '1\n2\n'); write(d, 'new dir/x y.js', 'z\n');
  });
  const r = run(env, d, ['changes', 't1']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.stdout, /二进制\s+img\.bin/);
  assert.match(r.stdout, /a b\/c d\.txt/);
  assert.match(r.stdout, /1 个二进制文件/);
  const j = json(env, d, 't1');
  assert.strictEqual(j.files.find((f) => f.path === 'img.bin').binary, true);
  assert.strictEqual(j.totals.binary, 1);
  assert.strictEqual(j.totals.add, 2); // +1 (c d.txt) +1 (x y.js); binary not counted
  const md = run(env, d, ['changes', 't1', '--md']).stdout;
  assert.match(md, /- `a b\/c d\.txt` — \+1\/−0/);
  // empty range, every output mode
  const env2 = freshEnv(); const d2 = tmpProject(BASE);
  assert.strictEqual(run(env2, d2, ['init']).code, 0);
  for (const a of [[], ['--md'], ['--batches'], ['--json'], ['1']]) {
    const e = run(env2, d2, ['changes', ...a]);
    assert.strictEqual(e.code, 0, `${a}: ${e.out}`);
    assert.doesNotMatch(e.out, /\n\s+at /);
  }
  assert.match(run(env2, d2, ['changes']).stdout, /没有文件变化/);
});

test('--md prints a pasteable Markdown checklist grouped by category', () => {
  const { env, d } = oneTurn(BASE, (d) => { write(d, 'src/n.js', 'n\n'); write(d, 'package.json', '{"a":1}\n'); fs.rmSync(path.join(d, 'src/gone.js')); });
  const md = run(env, d, ['changes', 't1', '--md']).stdout;
  assert.match(md, /^### 第 1 轮的变化/);
  assert.match(md, /\*\*1 个新增 · 1 个修改 · 1 个删除 · \+2\/−3 行\*\*/);
  assert.match(md, /#### 依赖与锁文件（1）\n\n- `package\.json` — \+1\/−1/);
  assert.match(md, /- `src\/gone\.js` — \+0\/−2（删除）/);
  assert.match(md, /- `src\/n\.js` — \+1\/−0（新增）/);
});

test('--batches: order config/deps -> source -> tests -> docs; union equals all changed files exactly', () => {
  const { env, d } = oneTurn(BASE, (d) => {
    write(d, 'docs/guide.md', 'g\n'); write(d, 'test/x.test.js', 't\n'); write(d, 'src/core.js', 'c\n'); write(d, 'package.json', '{"a":1}\n');
    write(d, 'tsconfig.json', '{}\n'); fs.rmSync(path.join(d, 'src/gone.js')); write(d, 'my file.py', 'p\n'); write(d, 'README.md', 'changed\n');
  });
  const j = json(env, d, 't1');
  assert.deepStrictEqual(j.batches.map((b) => b.title), ['配置 / 依赖', '核心源码', '测试', '文档']);
  const union = j.batches.flatMap((b) => b.files);
  assert.strictEqual(union.length, new Set(union).size, 'no file in two batches');
  assert.deepStrictEqual([...union].sort(), j.files.map((f) => f.path).sort());
  assert.strictEqual(union.length, j.totals.files);
  assert.ok(j.batches[0].files.includes('package.json') && j.batches[0].files.includes('tsconfig.json'));
  assert.ok(j.batches[1].files.includes('src/gone.js') && j.batches[1].files.includes('my file.py'));
  const t = run(env, d, ['changes', 't1', '--batches']);
  assert.match(t.stdout, /第 1 批 · 配置 \/ 依赖/);
  assert.match(t.stdout, /不多不漏/);
  assert.ok(t.stdout.indexOf('第 1 批') < t.stdout.indexOf('第 2 批') && t.stdout.indexOf('第 2 批') < t.stdout.indexOf('第 3 批'));
});

test('read-only: no new snapshots, user .git untouched, hooks/config untouched', () => {
  const { env, d } = oneTurn(BASE, (d) => write(d, 'src/n.js', 'n\n'));
  const s = new Store(d, env);
  const before = { meta: s.meta().length, git: gitState(d), hooks: fs.existsSync(path.join(d, '.claude')) ? fs.readFileSync(path.join(d, '.claude/settings.local.json'), 'utf8') : '' };
  for (const a of [['t1'], ['t1', '--md'], ['t1', '--batches'], ['1'], []]) assert.strictEqual(run(env, d, ['changes', ...a]).code, 0);
  assert.strictEqual(s.meta().length, before.meta);
  assert.strictEqual(gitState(d), before.git);
  assert.strictEqual(fs.existsSync(path.join(d, '.claude')) ? fs.readFileSync(path.join(d, '.claude/settings.local.json'), 'utf8') : '', before.hooks);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'changes.js'), 'utf8'), /^(?![\s\S]*(require\('(https?|net|dns|http2|tls)'\)|fetch\())/);
});

test('not initialised / bad id: clear message, exit 1, no stack', () => {
  const env = freshEnv(); const d = tmpProject(BASE);
  const r = run(env, d, ['changes']);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /no snapshots for .* yet\. Run .*init/);
  assert.doesNotMatch(r.out, /\n\s+at /);
  const { env: env2, d: d2 } = oneTurn(BASE, () => {});
  for (const bad of ['t99', 't0', '999', 'zzz']) {
    const e = run(env2, d2, ['changes', bad]);
    assert.strictEqual(e.code, 1, bad);
    assert.match(e.out, /agentundo: /);
    assert.doesNotMatch(e.out, /\n\s+at /);
  }
  assert.match(run(env2, d2, ['--help']).out + run(env2, d2, ['help']).out, /agentundo changes \[tN \| <id>\]/);
});

test('Store.numstat: read-only helper on the existing snapshot store (binary = -, spaces ok, deletes counted)', () => {
  const { env, d } = oneTurn(BASE, (d) => { write(d, 'a b.txt', '1\n2\n'); fs.writeFileSync(path.join(d, 'x.bin'), Buffer.from([0, 0, 1])); fs.rmSync(path.join(d, 'src/gone.js')); });
  const s = new Store(d, env);
  const m = s.meta();
  const ns = s.numstat(m[0].tree, m[m.length - 1].tree);
  assert.deepStrictEqual(ns['a b.txt'], { add: 2, del: 0, binary: false });
  assert.deepStrictEqual(ns['x.bin'], { add: 0, del: 0, binary: true });
  assert.deepStrictEqual(ns['src/gone.js'], { add: 0, del: 2, binary: false });
});

test('classify / summarize: pure path rules', () => {
  const cases = { 'src/index.ts': 'source', 'test/a.js': 'test', 'src/a.test.ts': 'test', 'tests/package.json': 'test', 'Cargo.lock': 'deps', 'sub/pnpm-lock.yaml': 'deps',
    'docs/api.md': 'docs', 'README.md': 'docs', '.env.example': 'config', 'jest.config.js': 'config', '.github/ci.yml': 'config', 'Makefile': 'config', 'lib/util.py': 'source', 'tests_helper.py': 'source' };
  for (const [p, c] of Object.entries(cases)) assert.strictEqual(classify(p), c, p);
  const r = summarize([{ status: 'A', path: 'x/y.js' }, { status: 'M', path: 'package.json' }, { status: 'T', path: 'link' }, { status: 'D', path: 'old.md' }], { 'x/y.js': { add: 3, del: 0, binary: false } }, new Set(['src']));
  assert.strictEqual(r.totals.added, 1); assert.strictEqual(r.totals.modified, 2); assert.strictEqual(r.totals.deleted, 1);
  assert.deepStrictEqual(r.newDirs, ['x']);
  assert.strictEqual(r.batches.reduce((n, b) => n + b.files.length, 0), 4);
});
