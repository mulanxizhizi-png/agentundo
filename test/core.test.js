'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { BIN, freshEnv, tmpProject, run, bash, prompt, fingerprint, gitOut } = require('./helpers');

function setup(files, opts) {
  const env = freshEnv();
  const d = tmpProject(files, opts);
  const r = run(env, d, ['init']);
  assert.strictEqual(r.code, 0, r.out);
  return { env, d };
}
const latestId = (env, d) => { const m = run(env, d, ['list', '--all']).out.trim().split('\n').filter((l) => /^\d+ /.test(l)); return Number(m[m.length - 1].split(/\s+/)[0]); };

test('item 3: delete, move, rename, untracked, empty-ish dirs, symlink, exec bit, unicode/space/$() paths', async () => {
  const { env, d } = setup({ 'src/a.js': 'a\n', 'src/sub/b.js': 'b\n', 'move.txt': 'm\n', '中文 文件 $(echo x).txt': 'zh\n' });
  fs.writeFileSync(path.join(d, 'untracked.txt'), 'u\n');
  fs.writeFileSync(path.join(d, 'run.sh'), '#!/bin/sh\necho hi\n'); fs.chmodSync(path.join(d, 'run.sh'), 0o755);
  fs.symlinkSync('src/a.js', path.join(d, 'link'));
  const before = fingerprint(d);
  const h = bash(env, d, 'rm -rf src && mv move.txt moved.txt');
  assert.strictEqual(h.code, 0);
  fs.rmSync(path.join(d, 'src'), { recursive: true }); fs.renameSync(path.join(d, 'move.txt'), path.join(d, 'moved.txt'));
  fs.rmSync(path.join(d, 'untracked.txt')); fs.rmSync(path.join(d, 'link')); fs.rmSync(path.join(d, 'run.sh')); fs.rmSync(path.join(d, '中文 文件 $(echo x).txt'));
  fs.writeFileSync(path.join(d, 'junk.txt'), 'junk');
  const r = run(env, d, ['restore', 't1.1', '--yes']);
  assert.strictEqual(r.code, 0, r.out);
  const after = fingerprint(d);
  delete before['.claude/settings.local.json']; delete after['.claude/settings.local.json'];
  assert.deepStrictEqual(after, before);
  assert.strictEqual(gitOut(d, 'status', '--porcelain', '--untracked-files=no'), '');
});

test('list shows turn, command and dangerous marker; Claude prompt_id and Codex turn_id make turns', () => {
  const { env, d } = setup({ 'a.txt': '1' });
  prompt(env, d, 'p1');
  fs.writeFileSync(path.join(d, 'a.txt'), '2');
  bash(env, d, 'rm -rf src', { prompt_id: 'p1' });
  fs.writeFileSync(path.join(d, 'a.txt'), '3');
  bash(env, d, 'git reset --hard');
  fs.writeFileSync(path.join(d, 'a.txt'), '4');
  prompt(env, d, null, { prompt_id: undefined, turn_id: 'turn-x' });
  fs.writeFileSync(path.join(d, 'a.txt'), '5');
  bash(env, d, 'ls -la', { turn_id: 'turn-x' });
  const out = run(env, d, ['list']).out;
  assert.match(out, /t1\.1 .*before rm -rf src ⚠ dangerous/);
  assert.match(out, /t1\.2 .*before git reset --hard ⚠ dangerous/);
  assert.match(out, /t2 .*turn start/);
  assert.match(out, /t2\.1 .*before ls -la$/m);
});

test('read-only tools and unchanged trees do not create snapshots', () => {
  const { env, d } = setup({ 'a.txt': '1' });
  const n0 = latestId(env, d);
  require('./helpers').hook(env, d, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.txt' } });
  bash(env, d, 'echo hi'); // first command of a turn is always recorded
  assert.strictEqual(latestId(env, d), n0 + 1);
  bash(env, d, 'echo again'); // same turn, nothing changed -> no new snapshot
  assert.strictEqual(latestId(env, d), n0 + 1);
});

test('Write/Edit/apply_patch labels', () => {
  const { env, d } = setup({ 'a.txt': '1' });
  const H = require('./helpers').hook;
  fs.writeFileSync(path.join(d, 'a.txt'), '2');
  H(env, d, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(d, 'n.txt'), content: 'x' } });
  fs.writeFileSync(path.join(d, 'a.txt'), '3');
  H(env, d, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', turn_id: 't', tool_input: { command: '*** Begin Patch\n*** Delete File: /x/a.txt\n*** End Patch\n' } }, 'codex');
  const out = run(env, d, ['list']).out;
  assert.match(out, /before Write .*n\.txt/);
  assert.match(out, /codex .*before apply_patch: delete a\.txt ⚠ dangerous/);
});

test('item 4: SQLite (WAL) restored with same row count, even if .gitignore ignores *.db', () => {
  const { env, d } = setup({ '.gitignore': '*.db\n' });
  const py = (code) => execFileSync('python3', ['-c', code], { cwd: d, encoding: 'utf8' }).trim();
  // keep a connection open in WAL mode so -wal/-shm exist, like a running app
  py("import sqlite3;c=sqlite3.connect('app.db');c.execute('PRAGMA journal_mode=WAL');c.execute('create table t(x)');c.executemany('insert into t values(?)',[(i,) for i in range(1000)]);c.commit()");
  bash(env, d, 'sqlite3 app.db "drop table t"');
  py("import sqlite3;c=sqlite3.connect('app.db');c.execute('drop table t');c.commit()");
  const r = run(env, d, ['restore', 't1.1', '--yes']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(py("import sqlite3;print(sqlite3.connect('app.db').execute('select count(*) from t').fetchone()[0])"), '1000');
});

test('item 5: 20MB binary restored; file over the per-file cap skipped with a warning', () => {
  const { env, d } = setup({ 'a.txt': '1' });
  const big = require('crypto').randomBytes(20 * 1024 * 1024);
  fs.writeFileSync(path.join(d, 'big.bin'), big);
  const env2 = { ...env, AGENTUNDO_MAX_FILE_MB: '30' };
  fs.writeFileSync(path.join(d, 'huge.bin'), Buffer.alloc(31 * 1024 * 1024, 1));
  const h = bash(env2, d, 'rm big.bin huge.bin');
  assert.match(JSON.parse(h.stdout).systemMessage, /1 file\(s\) over 30MB not snapshotted: huge\.bin/);
  fs.rmSync(path.join(d, 'big.bin'));
  assert.match(run(env2, d, ['list']).out, /1 big file\(s\) not saved/);
  const r = run(env2, d, ['restore', 't1.1', '--yes']);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(fs.readFileSync(path.join(d, 'big.bin')).equals(big));
  assert.ok(fs.existsSync(path.join(d, 'huge.bin')), 'skipped file must not be deleted by restore');
});

test('item 7: undo a restore is byte-exact', () => {
  const { env, d } = setup({ 'a.txt': 'v1' });
  bash(env, d, 'echo change');
  fs.writeFileSync(path.join(d, 'a.txt'), 'v2'); fs.writeFileSync(path.join(d, 'new.txt'), 'new'); fs.symlinkSync('a.txt', path.join(d, 'l'));
  const mid = fingerprint(d);
  const r = run(env, d, ['restore', '1', '--yes']);
  assert.strictEqual(r.code, 0, r.out);
  const pre = Number(r.out.match(/Undo this restore: agentundo restore (\d+)/)[1]);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'v1');
  assert.ok(!fs.existsSync(path.join(d, 'new.txt')));
  assert.strictEqual(run(env, d, ['restore', String(pre), '--yes']).code, 0);
  assert.deepStrictEqual(fingerprint(d), mid);
});

test('item 8: .gitignore changed after snapshot; ignored user files never deleted', () => {
  const { env, d } = setup({ 'keep.log': 'tracked-log', 'a.txt': '1' });
  bash(env, d, 'edit gitignore');
  fs.writeFileSync(path.join(d, '.gitignore'), '*.log\nsecret/\n');
  fs.rmSync(path.join(d, 'keep.log'));
  fs.mkdirSync(path.join(d, 'secret')); fs.writeFileSync(path.join(d, 'secret', 'x'), 'mine');
  fs.writeFileSync(path.join(d, 'other.log'), 'ignored, created later');
  assert.strictEqual(run(env, d, ['restore', 't1.1', '--yes']).code, 0);
  assert.strictEqual(fs.readFileSync(path.join(d, 'keep.log'), 'utf8'), 'tracked-log');
  assert.ok(!fs.existsSync(path.join(d, '.gitignore')));
  assert.strictEqual(fs.readFileSync(path.join(d, 'secret', 'x'), 'utf8'), 'mine');
  assert.ok(fs.existsSync(path.join(d, 'other.log')));
});

test('defaults: node_modules and .env are not snapshotted, restore leaves them alone', () => {
  const { env, d } = setup({ 'a.txt': '1' });
  fs.mkdirSync(path.join(d, 'node_modules/x'), { recursive: true }); fs.writeFileSync(path.join(d, 'node_modules/x/i.js'), 'x');
  fs.writeFileSync(path.join(d, '.env'), 'KEY=secret'); fs.writeFileSync(path.join(d, '.env.example'), 'KEY=');
  bash(env, d, 'touch');
  const out = run(env, d, ['diff', '1']).out;
  assert.match(out, /\.env\.example/);
  assert.doesNotMatch(out, /node_modules|\.env\s/);
  fs.writeFileSync(path.join(d, '.env'), 'KEY=new');
  run(env, d, ['restore', '1', '--yes']);
  assert.strictEqual(fs.readFileSync(path.join(d, '.env'), 'utf8'), 'KEY=new');
  assert.ok(fs.existsSync(path.join(d, 'node_modules/x/i.js')));
});

test('partial restore with -- <paths> only touches those paths', () => {
  const { env, d } = setup({ 'src/a.js': 'a', 'b.txt': 'b' });
  bash(env, d, 'rm -rf src');
  fs.rmSync(path.join(d, 'src'), { recursive: true }); fs.writeFileSync(path.join(d, 'b.txt'), 'good change');
  const r = run(env, d, ['restore', 't1.1', '--yes', '--', 'src']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(fs.readFileSync(path.join(d, 'src/a.js'), 'utf8'), 'a');
  assert.strictEqual(fs.readFileSync(path.join(d, 'b.txt'), 'utf8'), 'good change');
});

test('restore without a terminal and without --yes refuses and changes nothing; --dry-run changes nothing', () => {
  const { env, d } = setup({ 'a.txt': '1' });
  fs.writeFileSync(path.join(d, 'a.txt'), '2');
  const fp = fingerprint(d);
  const r = run(env, d, ['restore', '1']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /--yes/);
  assert.match(run(env, d, ['restore', '1', '--dry-run']).out, /dry run/);
  assert.deepStrictEqual(fingerprint(d), fp);
});

test('item 6: Ctrl+C mid-restore leaves a journal; re-running completes; undo point preserved', async () => {
  const files = {}; for (let i = 0; i < 60; i++) files[`f/${i}.txt`] = `v${i}`;
  const { env, d } = setup(files);
  const full = fingerprint(d);
  fs.rmSync(path.join(d, 'f'), { recursive: true });
  const child = spawn(process.execPath, [BIN, 'restore', '1', '--yes'], { cwd: d, env: { ...env, AGENTUNDO_TEST_DELAY_MS: '40' } });
  let out = ''; child.stdout.on('data', (b) => { out += b; if (/file\(s\) to write back/.test(out) && !child.sent) { child.sent = true; setTimeout(() => child.kill('SIGINT'), 600); } });
  const code = await new Promise((r) => child.on('close', r));
  assert.strictEqual(code, 130, out);
  assert.match(out, /Interrupted/);
  const n = fs.readdirSync(path.join(d, 'f')).length;
  assert.ok(n > 0 && n < 60, `partial: ${n}`);
  assert.ok(!fs.readdirSync(d).some((x) => x.startsWith('.agentundo-tmp')), 'temp dir cleaned');
  assert.match(run(env, d, ['status']).out, /was interrupted/);
  const r = run(env, d, ['restore', '1', '--yes']);
  assert.match(r.out, /resuming/);
  const pre = Number(r.out.match(/Undo this restore: agentundo restore (\d+)/)[1]);
  assert.deepStrictEqual(fingerprint(d), full);
  assert.doesNotMatch(run(env, d, ['status']).out, /interrupted/);
  run(env, d, ['restore', String(pre), '--yes']);
  assert.ok(!fs.existsSync(path.join(d, 'f')), 'undo goes back to the pre-restore state (f/ deleted)');
});

test('item 11: total cap prunes oldest, warns every time, keeps snapshotting', () => {
  const { env, d } = setup({ 'a.txt': '1' });
  const e = { ...env, AGENTUNDO_MAX_TOTAL_MB: '3', AGENTUNDO_KEEP_MIN: '2' };
  const msgs = [];
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(d, 'r.bin'), require('crypto').randomBytes(1024 * 1024));
    const h = bash(e, d, `step ${i}`);
    if (h.stdout) msgs.push(JSON.parse(h.stdout).systemMessage);
  }
  assert.ok(msgs.length >= 3, msgs.join('\n'));
  assert.ok(msgs.every((m) => /cap/.test(m)));
  const ids = run(e, d, ['list', '--all']).out.split('\n').filter((l) => /^\d+ /.test(l)).map((l) => Number(l.split(/\s+/)[0]));
  assert.strictEqual(ids[ids.length - 1], 7, 'still snapshotting');
  assert.ok(!ids.includes(1), 'oldest pruned');
  assert.ok(ids.length >= 2);
});

test('item 12: concurrent hooks do not corrupt the store', async () => {
  const { env, d } = setup({ 'a.txt': '1' });
  const runs = [];
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(path.join(d, `c${i}.txt`), String(i));
    runs.push(new Promise((res) => { const p = spawn(process.execPath, [BIN, 'hook', '--agent', 'claude'], { cwd: d, env }); p.stdin.end(JSON.stringify({ cwd: d, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `c${i}` } })); p.on('close', res); }));
  }
  assert.deepStrictEqual(await Promise.all(runs), Array(8).fill(0));
  const lines = run(env, d, ['list', '--all']).out.split('\n').filter((l) => /^\d+ /.test(l)).map((l) => Number(l.split(/\s+/)[0]));
  assert.deepStrictEqual(lines, [...new Set(lines)].sort((a, b) => a - b));
  assert.match(run(env, d, ['status']).out, /last failure: none/);
});

test('item 13: broken store -> hook exits 0 with a warning, error logged', () => {
  const { env, d } = setup({ 'a.txt': '1' });
  const { Store } = require('../src/store');
  const s = new Store(d, env);
  fs.rmSync(path.join(s.gitDir, 'objects'), { recursive: true });
  fs.writeFileSync(path.join(s.gitDir, 'objects'), 'not a dir');
  fs.writeFileSync(path.join(d, 'a.txt'), '2');
  const h = bash(env, d, 'rm a.txt');
  assert.strictEqual(h.code, 0);
  assert.match(JSON.parse(h.stdout).systemMessage, /snapshot FAILED/);
  assert.match(run(env, d, ['status']).out, /last failure: .*PreToolUse/);
  // garbage input is also fine
  const r = require('child_process').spawnSync(process.execPath, [BIN, 'hook', '--agent', 'codex'], { cwd: d, env, input: 'not json', encoding: 'utf8' });
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, '');
});

test('item 14: non-git project works; user .git, index, stash, branches untouched', () => {
  const nd = setup({ 'x.txt': 'x' }, { git: false });
  bash(nd.env, nd.d, 'rm x.txt'); fs.rmSync(path.join(nd.d, 'x.txt'));
  assert.strictEqual(run(nd.env, nd.d, ['restore', 't1.1', '--yes']).code, 0);
  assert.strictEqual(fs.readFileSync(path.join(nd.d, 'x.txt'), 'utf8'), 'x');

  const env = freshEnv();
  const d = tmpProject({ 'a.txt': '1', 'b.txt': 'b' });
  fs.writeFileSync(path.join(d, 'a.txt'), 'stashed'); gitOut(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'stash', '-q');
  fs.writeFileSync(path.join(d, 'b.txt'), 'staged'); gitOut(d, 'add', 'b.txt');
  const snapGit = () => [gitOut(d, 'rev-parse', 'HEAD'), gitOut(d, 'stash', 'list'), gitOut(d, 'branch', '-a'), gitOut(d, 'diff', '--cached'), gitOut(d, 'for-each-ref'), fs.readFileSync(path.join(d, '.git/index')).toString('hex')].join('|');
  const before = snapGit();
  run(env, d, ['init']);
  bash(env, d, 'rm b.txt'); fs.rmSync(path.join(d, 'b.txt'));
  run(env, d, ['restore', 't1.1', '--yes']);
  assert.strictEqual(snapGit(), before);
});

test('item 15/16: init + uninstall: only our hooks/blocks removed, snapshots kept unless --purge; malformed hooks.json untouched', () => {
  const env = freshEnv();
  const d = tmpProject({ 'a.txt': '1' });
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  const userHook = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, other: 1 };
  fs.writeFileSync(path.join(env.CODEX_HOME, 'hooks.json'), JSON.stringify(userHook));
  fs.appendFileSync(path.join(d, '.git/info/exclude'), 'my-line\n');
  assert.strictEqual(run(env, d, ['init']).code, 0);
  const hj = JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME, 'hooks.json'), 'utf8'));
  assert.strictEqual(hj.hooks.PreToolUse.length, 2); assert.ok(hj.hooks.UserPromptSubmit);
  assert.strictEqual(gitOut(d, 'status', '--porcelain'), '', '.claude/settings.local.json is excluded');
  // second project shares the codex hook
  const d2 = tmpProject({ 'z': 'z' }); run(env, d2, ['init']);
  let u = run(env, d, ['uninstall']);
  assert.match(u.out, /kept: +snapshots/); assert.match(u.out, /kept: +Codex hook \+ runtime \(still used by 1/);
  assert.ok(!fs.existsSync(path.join(d, '.claude')));
  assert.match(fs.readFileSync(path.join(d, '.git/info/exclude'), 'utf8'), /my-line/);
  assert.doesNotMatch(fs.readFileSync(path.join(d, '.git/info/exclude'), 'utf8'), /agentundo/);
  // hook in an uninstalled project is a no-op
  fs.writeFileSync(path.join(d, 'a.txt'), 'x'); const h = bash(env, d, 'rm a.txt'); assert.strictEqual(h.stdout, '');
  u = run(env, d2, ['uninstall', '--purge']);
  assert.notStrictEqual(u.code, 0, 'purge without terminal/--yes refuses');
  u = run(env, d2, ['uninstall', '--purge', '--yes']);
  assert.strictEqual(u.code, 0, u.out); assert.match(u.out, /deleted: snapshots/); assert.match(u.out, /deleted: Codex hooks/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME, 'hooks.json'), 'utf8')), userHook);
  assert.ok(!fs.existsSync(path.join(env.AGENTUNDO_HOME, 'bin')));
  // malformed hooks.json: init refuses and leaves it alone
  fs.writeFileSync(path.join(env.CODEX_HOME, 'hooks.json'), '{broken');
  const r = run(env, d, ['init']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /not valid JSON/);
  assert.strictEqual(fs.readFileSync(path.join(env.CODEX_HOME, 'hooks.json'), 'utf8'), '{broken');
});

test('dangerous / cannot-undo heads-up', () => {
  const { isDangerous, cannotUndo } = require('../src/danger');
  for (const c of ['rm -rf src', 'rm -fr .', 'git reset --hard HEAD~1', 'psql -c "DROP TABLE users"', 'git clean -fdx', 'find . -name x -delete']) assert.ok(isDangerous(c), c);
  for (const c of ['ls', 'rm a.txt', 'git status', 'npm test']) assert.ok(!isDangerous(c), c);
  assert.ok(cannotUndo('rm -rf ~/Documents', '/p'));
  assert.ok(cannotUndo('psql -c "drop table x"', '/p'));
  assert.ok(!cannotUndo('rm -rf /p/src', '/p'));
  assert.ok(!cannotUndo('rm -rf src', '/p'));
});

test('deploy repro: file ignored at snapshot time is never deleted after .gitignore is emptied', () => {
  const env = freshEnv();
  const d = tmpProject({ '.gitignore': 'secret/\n', 'a.txt': '1' });
  fs.mkdirSync(path.join(d, 'secret')); fs.writeFileSync(path.join(d, 'secret/s.txt'), 'v1');
  assert.strictEqual(run(env, d, ['init']).code, 0);
  fs.writeFileSync(path.join(d, '.gitignore'), '');
  fs.writeFileSync(path.join(d, 'secret/s.txt'), 'v2');
  const r = run(env, d, ['restore', '1', '--yes']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /kept \(not captured/);
  assert.strictEqual(fs.readFileSync(path.join(d, 'secret/s.txt'), 'utf8'), 'v2');
  assert.strictEqual(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), 'secret/\n');
});

test('restore never deletes excluded/oversized files that the target did not capture; does delete truly new files', () => {
  const env = { ...freshEnv(), AGENTUNDO_MAX_FILE_MB: '1' };
  const d = tmpProject({ 'a.txt': '1', '.gitignore': '' });
  fs.mkdirSync(path.join(d, 'node_modules/x'), { recursive: true });
  run(env, d, ['init']);
  // created after the snapshot, but would not have been captured anyway
  fs.writeFileSync(path.join(d, 'node_modules/x/i.js'), 'x');
  fs.writeFileSync(path.join(d, '.env'), 'K=1');
  fs.writeFileSync(path.join(d, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
  fs.writeFileSync(path.join(d, 'new.txt'), 'agent junk');
  fs.writeFileSync(path.join(d, 'app.db'), 'db created later'); // dbs ARE captured, so a new one is removed
  const r = run(env, d, ['restore', '1', '--yes']);
  assert.strictEqual(r.code, 0, r.out);
  for (const f of ['node_modules/x/i.js', '.env', 'big.bin']) assert.ok(fs.existsSync(path.join(d, f)), f);
  assert.ok(!fs.existsSync(path.join(d, 'new.txt')));
  assert.ok(!fs.existsSync(path.join(d, 'app.db')));
});

test('answering n at the confirm prompt exits 1 and changes nothing', { skip: !hasScript() }, () => {
  const { env, d } = setup({ 'a.txt': '1' });
  fs.writeFileSync(path.join(d, 'a.txt'), '2');
  const r = require('child_process').spawnSync('script', ['-qec', `printf 'n\\n' | true; ${process.execPath} ${BIN} restore 1`, '/dev/null'], { cwd: d, env, input: 'n\n', encoding: 'utf8', timeout: 20000 });
  assert.match(r.stdout, /Cancelled/);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), '2');
});
function hasScript() { try { execFileSync('script', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }

test('--yes / --dry-run after -- are options, not paths', () => {
  const { env, d } = setup({ 'src/a.js': 'a', 'b.txt': 'b' });
  fs.writeFileSync(path.join(d, 'src/a.js'), 'x'); fs.writeFileSync(path.join(d, 'b.txt'), 'y');
  const r = run(env, d, ['restore', '1', '--', 'src', '--yes']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /treating --yes after -- as option/);
  assert.strictEqual(fs.readFileSync(path.join(d, 'src/a.js'), 'utf8'), 'a');
  assert.strictEqual(fs.readFileSync(path.join(d, 'b.txt'), 'utf8'), 'y');
});

test('checkout failure: error names the cause and how to recover', async () => {
  const { env, d } = setup({ 'a.txt': '1' });
  const { Store } = require('../src/store');
  const s = new Store(d, env);
  fs.writeFileSync(path.join(d, 'a.txt'), '2');
  // corrupt the object of a.txt@snapshot1 so checkout-index fails
  const blob = execFileSync('git', ['--git-dir', s.gitDir, 'rev-parse', `${s.meta()[0].tree}:a.txt`], { encoding: 'utf8' }).trim();
  const obj = path.join(s.gitDir, 'objects', blob.slice(0, 2), blob.slice(2));
  fs.chmodSync(obj, 0o644); fs.writeFileSync(obj, 'garbage');
  const r = run(env, d, ['restore', '1', '--yes']);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /git (read-tree|checkout-index) failed: \S/);
  assert.match(r.out, /Re-run `agentundo restore 1`|restore failed/);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), '2');
});

test('deleted shadow repo: hook recreates it, warns that history was lost, takes a new baseline', () => {
  const { env, d } = setup({ 'a.txt': '1' });
  bash(env, d, 'rm -rf x');
  const { Store } = require('../src/store');
  fs.rmSync(new Store(d, env).gitDir, { recursive: true });
  fs.writeFileSync(path.join(d, 'a.txt'), '2');
  const h = bash(env, d, 'rm a.txt');
  assert.strictEqual(h.code, 0);
  assert.match(JSON.parse(h.stdout).systemMessage, /earlier snapshots are lost/);
  assert.match(run(env, d, ['status']).out, /last failure: .*snapshot store was missing/);
  const out = run(env, d, ['list']).out;
  assert.match(out, /^1 /m); assert.doesNotMatch(out, /^2 /m);
  fs.writeFileSync(path.join(d, 'a.txt'), '3');
  assert.strictEqual(run(env, d, ['restore', '1', '--yes']).code, 0);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), '2');
});

test('uninstall --global --purge --yes survives a deleted registered project (was: spawnSync git ENOENT)', () => {
  const env = freshEnv();
  const gone = tmpProject({ 'a.txt': '1' }); const keep = tmpProject({ 'b.txt': '2' });
  for (const d of [gone, keep]) { assert.strictEqual(run(env, d, ['init', '--agent', 'codex']).code, 0); run(env, d, ['init', '--agent', 'claude']); run(env, d, ['snap']); }
  fs.rmSync(gone, { recursive: true, force: true });
  const st = run(env, keep, ['status']); assert.strictEqual(st.code, 0, st.out);
  const l = run(env, keep, ['list']); assert.strictEqual(l.code, 0, l.out);
  const u = run(env, os.tmpdir(), ['uninstall', '--global', '--purge', '--yes']);
  assert.strictEqual(u.code, 0, u.out);
  assert.doesNotMatch(u.out, /ENOENT/);
  assert.match(u.out, /warning: registered project .* no longer exists/);
  assert.match(u.out, /missing project\(s\) skipped/);
  assert.match(u.out, /deleted: Codex hooks/);
  const hj = path.join(env.CODEX_HOME, 'hooks.json');
  assert.ok(!fs.existsSync(hj) || !/agentundo/.test(fs.readFileSync(hj, 'utf8')));
  assert.ok(!fs.existsSync(path.join(keep, '.claude', 'settings.local.json')) || !/agentundo/.test(fs.readFileSync(path.join(keep, '.claude', 'settings.local.json'), 'utf8')));
  assert.ok(!fs.existsSync(path.join(env.AGENTUNDO_HOME, 'stores')) || fs.readdirSync(path.join(env.AGENTUNDO_HOME, 'stores')).length === 0);
  assert.ok(!fs.existsSync(path.join(env.AGENTUNDO_HOME, 'projects.json')) || JSON.parse(fs.readFileSync(path.join(env.AGENTUNDO_HOME, 'projects.json'), 'utf8')).projects.length === 0);
});
