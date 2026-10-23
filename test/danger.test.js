'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { analyze, isDangerous, redact, cannotUndo } = require('../src/danger');
const { freshEnv, tmpProject, run, bash, prompt, hook } = require('./helpers');

const DANGEROUS = [
  'rm -rf src', 'rm -fr src', 'rm -r -f src', 'rm -Rf src', 'rm --recursive --force src', 'rm -r src', 'rm --recursive src',
  'sudo rm -rf /var/x', 'cd app && rm -rf build', 'ls; rm -rf node_modules', '/bin/rm -rf x', 'env FOO=1 rm -rf x', 'FOO=1 rm -rf x',
  'xargs rm -rf < list.txt', 'find . -name "*.log" | xargs rm -rf', 'bash -c "rm -rf src"', "sh -c 'cd x && rm -rf y'", 'echo hi && rm -rf "my dir"',
  'git reset --hard', 'git reset --hard HEAD~3', 'git -C sub reset --hard origin/main',
  'git clean -fd', 'git clean -fdx', 'git clean -xdf', 'git clean -f', 'git clean --force -d',
  'git checkout -- .', 'git checkout .', 'git checkout -- src/a.js', 'git restore .', 'git restore src/', 'git restore --worktree --staged .',
  'psql -c "DROP TABLE users"', 'psql -c "drop table users"', "mysql -e 'DROP DATABASE prod'", 'sqlite3 app.db "drop table t"',
  'psql mydb -c "TRUNCATE orders"', 'mysql -e "truncate table logs"', 'echo "DROP TABLE x;" | psql', 'sqlite3 app.db "DELETE FROM users"',
  'find . -name x -delete', 'find /tmp/x -type f -exec rm {} +', 'git push --force', 'git push -f origin main', 'git stash clear',
  'npx rimraf dist', 'mongosh --eval "db.dropDatabase()"', 'redis-cli FLUSHALL',
];
const SAFE = [
  'ls', 'rm a.txt', 'rm -f a.txt', 'git status', 'npm test', 'echo rm -rf src', 'echo "git reset --hard"', 'grep -r "rm -rf" .',
  'git commit -m "rm -rf old stuff; DROP TABLE mention"', 'git reset --soft HEAD~1', 'git reset HEAD a.txt', 'git restore --staged a.js',
  'git checkout main', 'git checkout -b feature', 'git clean -n', 'git clean -nd', 'cat notes.md | grep "drop table"', 'echo "drop table x"',
  'psql -c "select * from users"', 'mysql -e "show tables"', 'find . -name "*.js"', 'printf "rm -rf /"', 'git log --grep "reset --hard"',
  'npm run drop-table-docs', 'rmdir empty', 'docker rm -f c1', 'kubectl get pods', 'cargo clean',
];

test('dangerous detection: positives', () => { for (const c of DANGEROUS) assert.ok(isDangerous(c), c); });
test('dangerous detection: negatives (echo/grep/commit messages/quoted text are not commands)', () => { for (const c of SAFE) assert.ok(!isDangerous(c), c); });
test('reasons are human readable', () => {
  assert.deepStrictEqual(analyze('rm -rf src').reasons, ['rm -rf (recursive force delete)']);
  assert.deepStrictEqual(analyze('git clean -fdx').reasons, ['git clean -fdx (deletes untracked files)']);
  assert.deepStrictEqual(analyze('psql -c "Drop Database prod"').reasons, ['DROP DATABASE']);
});

const REMOTE = [
  ["psql postgres://u:p@db.example.com/x -c 'drop table t'", 'db.example.com'],
  ['psql "postgresql://admin:s3cr3t@prod.internal:5432/app" -c "update t set a=1"', 'prod.internal'],
  ['psql -h db.prod.io -U me -c "delete from users"', 'db.prod.io'],
  ['psql --host=10.1.2.3 -c "insert into t values (1)"', '10.1.2.3'],
  ['mysql -h mysql.example.com -u root -pS3cret -e "DROP DATABASE prod"', 'mysql.example.com'],
  ['mysql -hmysql.example.com -e "truncate t"', 'mysql.example.com'],
  ['mysql mysql://u:p@rds.amazonaws.com/db -e "alter table t add c int"', 'rds.amazonaws.com'],
  ['mongosh "mongodb+srv://u:p@cluster0.mongodb.net/db" --eval "db.users.deleteMany({})"', 'cluster0.mongodb.net'],
  ['mongosh mongodb://u:p@mongo.prod:27017/db --eval "db.dropDatabase()"', 'mongo.prod'],
  ['redis-cli -u redis://:pw@cache.prod:6379 FLUSHALL', 'cache.prod'],
  ['DATABASE_URL=postgres://a:b@prod.db:5432/x npx prisma migrate deploy', 'prod.db'],
  ['PGHOST=db.prod psql -c "drop table t"', 'db.prod'],
  ['psql -h db.prod -f migrate.sql', 'db.prod'],
  ['psql -h db.prod < dump.sql', 'db.prod'],
  ['bash -c "psql -h db.prod -c \'drop table t\'"', 'db.prod'],
];
const NOT_REMOTE = [
  "psql postgres://u:p@localhost/x -c 'drop table t'", 'psql postgres://u:p@127.0.0.1:5432/x -c "drop table t"', 'psql "postgres://u:p@[::1]/x" -c "drop table t"',
  'psql postgres:///x -c "drop table t"', 'psql "postgres://u@/x?host=/var/run/postgresql" -c "drop table t"', 'psql -h localhost -c "drop table t"', 'psql -h /tmp -c "drop table t"',
  'mysql -h 127.0.0.1 -e "drop database x"', 'redis-cli -h localhost flushall',
  'psql -h db.prod -c "select count(*) from users"', 'psql postgres://u:p@db.prod/x -c "\\dt"', // read-only remote: no warning
  'echo postgres://u:p@db.prod/x', 'sqlite3 app.db "drop table t"',
];
test('remote DB detection: positives', () => { for (const [c, h] of REMOTE) assert.deepStrictEqual(analyze(c).remote, [h], c); });
test('remote DB detection: local hosts, unix sockets and read-only queries do not warn', () => { for (const c of NOT_REMOTE) assert.deepStrictEqual(analyze(c).remote, [], c); });

test('redaction', () => {
  const cases = [
    ['psql postgres://u:hunter2@db.example.com/x', 'psql postgres://u:***@db.example.com/x'],
    ['mongodb+srv://admin:p%40ss@c.net/db', 'mongodb+srv://admin:***@c.net/db'],
    ['redis-cli -u redis://:pw@cache:6379', 'redis-cli -u redis://:***@cache:6379'],
    ['PGPASSWORD=hunter2 psql -h x', 'PGPASSWORD=*** psql -h x'],
    ['MYSQL_PWD="a b" mysql', 'MYSQL_PWD=*** mysql'],
    ['mysql -u root -phunter2 -h x', 'mysql -u root -p*** -h x'],
    ['mysql -u root -p -h x', 'mysql -u root -p -h x'],
    ['pg_dump --password=hunter2 db', 'pg_dump --password=*** db'],
    ['redis-cli -a hunter2 ping', 'redis-cli -a *** ping'],
    ['DEEPSEEK_API_KEY=sk-abc claude', 'DEEPSEEK_API_KEY=*** claude'],
    ['postgres://u@db/x', 'postgres://u@db/x'],
  ];
  for (const [i, o] of cases) assert.strictEqual(redact(i), o, i);
});

test('cannotUndo: generic heads-up still covers local DB writes and paths outside the project', () => {
  assert.ok(cannotUndo('rm -rf ~/Documents', '/p'));
  assert.ok(cannotUndo('psql -c "drop table x"', '/p'));
  assert.ok(!cannotUndo('rm -rf /p/src', '/p'));
  assert.ok(!cannotUndo('psql -c "select 1"', '/p'));
});

test('cannotUndo: outsideProject ignores read-only ~/ paths and /dev/null redirects; still warns on real outside writes', () => {
  // Acceptance: read-only + 2>/dev/null must not false-positive (was v0.1.4 bug).
  assert.ok(!cannotUndo('ls ~/.pgpass; env | grep PG; command -v pip3 2>/dev/null', '/p'));
  assert.ok(!cannotUndo('ls ~/.pgpass', '/p'));
  assert.ok(!cannotUndo('ls ~/.pgpass >/dev/null', '/p'));
  assert.ok(!cannotUndo('cat ~/.pgpass 2>/dev/null', '/p'));
  // Real writes outside the project still warn.
  assert.ok(cannotUndo('echo x > ~/out', '/p'));
  assert.ok(cannotUndo('echo x >> ~/out', '/p'));
  assert.ok(cannotUndo('cp a ~/elsewhere', '/p'));
  assert.ok(cannotUndo('rm -rf ~/Documents', '/p'));
  assert.ok(cannotUndo('dd if=/dev/zero of=~/disk.img bs=1 count=1', '/p'));
  // In-project absolute path still quiet.
  assert.ok(!cannotUndo('echo x > /p/out', '/p'));
});

function setup(files) { const env = freshEnv(); const d = tmpProject(files); assert.strictEqual(run(env, d, ['init']).code, 0); return { env, d }; }
const ids = (out) => out.split('\n').filter((l) => /^\d+ /.test(l)).map((l) => Number(l.split(/\s+/)[0]));

test('dangerous command gets a dedicated snapshot even when nothing changed; list --dangerous; hook message', () => {
  const { env, d } = setup({ 'src/a.js': 'a' });
  prompt(env, d, 'p1');
  bash(env, d, 'echo hi', { prompt_id: 'p1' });
  const n0 = ids(run(env, d, ['list', '--all']).out).pop();
  bash(env, d, 'ls', { prompt_id: 'p1' }); // unchanged, same turn: deduped
  assert.strictEqual(ids(run(env, d, ['list', '--all']).out).pop(), n0);
  const h = bash(env, d, 'rm -rf src', { prompt_id: 'p1' });
  assert.strictEqual(h.code, 0);
  const msg = JSON.parse(h.stdout).systemMessage;
  assert.match(msg, new RegExp(`rm -rf \\(recursive force delete\\) — saved snapshot #${n0 + 1} first`));
  const h2 = bash(env, d, 'git reset --hard', { prompt_id: 'p1' }); // unchanged again, still a new snapshot
  assert.strictEqual(h2.code, 0);
  const all = run(env, d, ['list', '--all']).out;
  assert.deepStrictEqual(ids(all).slice(-2), [n0 + 1, n0 + 2]);
  assert.match(all, /before rm -rf src ⚠ dangerous \(rm -rf \(recursive force delete\)\)/);
  const dang = run(env, d, ['list', '--dangerous']).out;
  assert.deepStrictEqual(ids(dang), [n0 + 1, n0 + 2]);
  assert.doesNotMatch(dang, /echo hi/);
  const j = JSON.parse(run(env, d, ['list', '--json']).out);
  assert.deepStrictEqual(j.snapshots.find((s) => s.id === n0 + 1).reasons, ['rm -rf (recursive force delete)']);
});

test('list --dangerous with none recorded', () => {
  const { env, d } = setup({ 'a': '1' });
  assert.match(run(env, d, ['list', '--dangerous']).out, /no dangerous commands recorded/);
});

test('remote DB: user-visible warning (Claude + Codex), exit 0, password never printed or stored', () => {
  const { env, d } = setup({ 'a': '1' });
  for (const agent of ['claude', 'codex']) {
    const h = hook(env, d, { hook_event_name: 'PreToolUse', session_id: 's', turn_id: agent, tool_name: agent === 'claude' ? 'Bash' : 'shell', tool_input: { command: "psql postgres://u:hunter2@db.example.com/x -c 'drop table t'" } }, agent);
    assert.strictEqual(h.code, 0);
    assert.doesNotMatch(h.stdout + h.stderr, /hunter2/);
    const o = JSON.parse(h.stdout);
    assert.deepStrictEqual(Object.keys(o), ['systemMessage']); // no decision field: never blocks
    assert.match(o.systemMessage, /⚠ agentundo: this step touches a remote database \(db\.example\.com\) — local snapshots cannot undo it\./);
  }
  const h = bash(env, d, 'psql -h db.prod.io -c "update t set a=1"');
  assert.match(JSON.parse(h.stdout).systemMessage, /remote database \(db\.prod\.io\)/);
  const l = run(env, d, ['list', '--all']).out;
  assert.doesNotMatch(l, /hunter2/);
  assert.match(l, /postgres:\/\/u:\*\*\*@db\.example\.com/);
  assert.match(l, /remote DB db\.example\.com: not undoable/);
  const { storeDir } = require('../src/store');
  const sd = storeDir(d, env);
  for (const f of fs.readdirSync(sd)) { const p = path.join(sd, f); if (fs.statSync(p).isFile()) assert.doesNotMatch(fs.readFileSync(p, 'utf8'), /hunter2/, f); }
  // local DB: no remote warning, only the generic heads-up
  const loc = JSON.parse(bash(env, d, 'psql postgres://u:pw@localhost/x -c "drop table t"').stdout).systemMessage;
  assert.doesNotMatch(loc, /remote database/); assert.match(loc, /heads-up/);
});

test('deploy repro (Codex): first command of a turn gets its own entry right after the turn-start snapshot, e.g. `rm a.txt`', () => {
  const { env, d } = setup({ 'a.txt': '1' });
  const h = (ev) => hook(env, d, { hook_event_name: ev, session_id: 'cx', turn_id: 'T1', ...(ev === 'PreToolUse' ? { tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'rm a.txt'] } } : { prompt: 'x' }) }, 'codex');
  fs.writeFileSync(path.join(d, 'a.txt'), '2'); // change so the turn-start snapshot is new
  h('UserPromptSubmit');
  h('PreToolUse'); // nothing changed since turn start
  const out = run(env, d, ['list', '--all']).out;
  assert.match(out, /t1 .*turn start/);
  assert.match(out, /t1\.1 .*before rm a\.txt/);
  // later file-removing commands in the same turn also get their own entry even if nothing changed
  hook(env, d, { hook_event_name: 'PreToolUse', session_id: 'cx', turn_id: 'T1', tool_name: 'shell', tool_input: { command: 'rm b.txt' } }, 'codex');
  assert.match(run(env, d, ['list', '--all']).out, /t1\.2 .*before rm b\.txt/);
});

// v0.1.4: writes to a local SQLite file inside the project are snapshotted (restore undoes them), so they
// no longer get the "may change things outside the project" heads-up. Everything else still does.
test('cannotUndo: in-project SQLite files skip the heads-up; outside/over-cap/remote/mixed still warn', () => {
  const d = tmpProject({ 'app.db': 'x', 'sub/keep.txt': '', 'node_modules/pkg/cache.db': 'x' }, { git: false });
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'au-out-')));
  fs.writeFileSync(path.join(outside, 'other.db'), 'x');
  const o = { cwd: d, maxFileMB: 50, excluded: (p) => p.startsWith('node_modules/') };
  const del = '"DELETE FROM users; VACUUM;"';
  // local, in project: no heads-up
  for (const c of [`sqlite3 app.db ${del}`, `sqlite3 ./app.db ${del}`, `sqlite3 ${d}/app.db ${del}`, `sqlite3 new.sqlite3 "create table t(a)"`,
    `cd sub && sqlite3 ../app.db ${del}`, `cd ${d} && sqlite3 app.db ${del}`, `echo "delete from t;" | sqlite3 app.db`, `bash -c 'sqlite3 app.db "drop table t"'`]) {
    assert.ok(!cannotUndo(c, d, o), c);
  }
  assert.ok(!cannotUndo(`sqlite3 ../app.db ${del}`, d, { ...o, cwd: path.join(d, 'sub') }), 'relative to a sub-folder cwd');
  // still warn
  for (const c of [`sqlite3 ${outside}/other.db ${del}`, `sqlite3 ../${path.basename(outside)}/other.db ${del}`, `sqlite3 ~/app.db ${del}`, `sqlite3 $DB ${del}`,
    `sqlite3 node_modules/pkg/cache.db ${del}`, `cat dump.sql | sqlite3 app.db`, `sqlite3 app.db < dump.sql`, `sqlite3 -init x.sql app.db ${del}`,
    `sqlite3 app.db "ATTACH '${outside}/other.db' AS o; DELETE FROM o.t"`, `sqlite3 app.db "DELETE FROM t" ".backup /srv/x.db"`, `sqlite3 app.db "DELETE FROM t" ".shell touch /srv/x"`,
    `sqlite3 ${del}`, `psql -c "drop table x"`, `psql postgres://u@localhost/x -c "drop table t"`,
    `sqlite3 app.db ${del} && psql -c "delete from u"`, `sqlite3 app.db ${del}; sqlite3 ${outside}/other.db ${del}`, `sqlite3 app.db ${del} && rm -rf ~/Documents`,
    `(cd /elsewhere); sqlite3 app.db ${del}`, `DATABASE_URL=file:./app.db npx prisma migrate reset`]) {
    assert.ok(cannotUndo(c, d, o), c);
  }
  // over the per-file cap: not snapshotted, so the heads-up stays
  fs.writeFileSync(path.join(d, 'big.db'), Buffer.alloc(2 * 1024 * 1024));
  assert.ok(cannotUndo(`sqlite3 big.db ${del}`, d, { ...o, maxFileMB: 1 }));
  assert.ok(!cannotUndo(`sqlite3 big.db ${del}`, d, { ...o, maxFileMB: 50 }));
  // without opts (old callers) relative paths resolve against the root
  assert.ok(!cannotUndo(`sqlite3 app.db ${del}`, d));
});

test('hook: in-project SQLite DELETE gets the snapshot notice but no "outside the project" heads-up; remote/outside/over-cap still warned', () => {
  const { env, d } = setup({ 'app.db': 'sqlite' });
  const msg = (c) => { const out = bash(env, d, c).stdout; return out ? JSON.parse(out).systemMessage : ''; };
  const rel = msg('sqlite3 app.db "DELETE FROM users; VACUUM;"');
  assert.match(rel, /DELETE FROM — saved snapshot #\d+ first/); assert.doesNotMatch(rel, /heads-up/);
  const abs = msg(`sqlite3 ${d}/app.db "DELETE FROM users"`);
  assert.match(abs, /DELETE FROM/); assert.doesNotMatch(abs, /heads-up/);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'au-out-')));
  assert.match(msg(`sqlite3 ${outside}/app.db "DELETE FROM users"`), /heads-up/);
  assert.match(msg('sqlite3 app.db "DELETE FROM users" && sqlite3 /srv/other.db "DELETE FROM users"'), /heads-up/);
  const pg = msg('psql postgres://u:pw@db.example.com/app -c "DELETE FROM users"');
  assert.match(pg, /remote database \(db\.example\.com\)/); assert.doesNotMatch(pg, /pw@/);
  assert.match(msg('psql -h remotehost -U me -c "DELETE FROM users"'), /remote database \(remotehost\)/);
  // over the cap: file isn't snapshotted, so both the size warning and the heads-up appear
  fs.mkdirSync(path.join(d, '.agentundo'), { recursive: true }); fs.writeFileSync(path.join(d, '.agentundo', 'config.json'), JSON.stringify({ maxFileMB: 1 }));
  fs.writeFileSync(path.join(d, 'app.db'), Buffer.alloc(2 * 1024 * 1024));
  const big = msg('sqlite3 app.db "DELETE FROM users"');
  assert.match(big, /over 1MB not snapshotted: app\.db/); assert.match(big, /heads-up/);
});
