'use strict';
// Dangerous-command detection, remote-database detection and secret redaction.
//
// Policy (documented in README):
// - Shell commands are split into simple commands (; && || | & newlines, $( ), backticks) and the
//   *program* of each is inspected after skipping wrappers (sudo, env, VAR=x, time, nice, nohup,
//   command, exec, xargs ...). `bash -c '...'`, `sh -c`, `eval` are analysed recursively.
//   So `echo rm -rf x`, `grep "git reset --hard" notes.md` or `git commit -m "rm -rf"` are NOT flagged.
// - SQL keywords (DROP TABLE/DATABASE/SCHEMA, TRUNCATE, DELETE FROM) are only flagged when the command
//   runs a database client (psql, mysql, sqlite3, ...); then the whole command text is scanned,
//   so `psql -c "..."`, `mysql -e '...'`, `sqlite3 db "..."` and `echo '...' | psql` all count.
// - Detection is a heuristic for a *notification*: it never blocks anything.

const fs = require('fs');
const path = require('path');

const DB_CLIENTS = new Set(['psql', 'pg_restore', 'mysql', 'mariadb', 'sqlite3', 'sqlite', 'sqlcmd', 'duckdb', 'clickhouse-client', 'cockroach', 'mongo', 'mongosh', 'redis-cli', 'pgcli', 'mycli', 'litecli', 'usql']);
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'time', 'nice', 'nohup', 'command', 'exec', 'builtin', 'stdbuf', 'ionice', 'timeout', 'xargs', 'unbuffer', 'npx', 'bunx']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

// ---- tiny shell lexer: words + operators, quotes respected ----
function lex(s) {
  const out = []; let cur = null; let i = 0;
  const push = () => { if (cur !== null) out.push({ w: cur }); cur = null; };
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") { const j = s.indexOf("'", i + 1); cur = (cur || '') + s.slice(i + 1, j < 0 ? s.length : j); i = j < 0 ? s.length : j + 1; continue; }
    if (ch === '"') {
      let j = i + 1; let v = '';
      while (j < s.length && s[j] !== '"') { if (s[j] === '\\' && j + 1 < s.length) { v += s[j + 1]; j += 2; } else v += s[j++]; }
      cur = (cur || '') + v; i = j + 1; continue;
    }
    if (ch === '\\' && i + 1 < s.length) { cur = (cur || '') + (s[i + 1] === '\n' ? '' : s[i + 1]); i += 2; continue; }
    if (/\s/.test(ch) && ch !== '\n') { push(); i++; continue; }
    const op = /^(\|\||&&|;;|\$\(|[;|&\n`()])/.exec(s.slice(i));
    if (op) { push(); out.push({ op: op[1] }); i += op[1].length; continue; }
    if (ch === '>' || ch === '<') { push(); let j = i; while (s[j] === '>' || s[j] === '<' || s[j] === '&') j++; out.push({ redir: s.slice(i, j) }); i = j; continue; }
    cur = (cur || '') + ch; i++;
  }
  push();
  return out;
}

// Simple commands: arrays of words (redirection targets dropped).
function simpleCommands(s) {
  const cmds = []; let cur = []; let skipNext = false;
  for (const t of lex(s)) {
    if (t.op) { if (cur.length) cmds.push(cur); cur = []; continue; }
    if (t.redir) { skipNext = true; continue; }
    if (skipNext) { skipNext = false; continue; }
    cur.push(t.w);
  }
  if (cur.length) cmds.push(cur);
  return cmds;
}

const base = (w) => w.replace(/^.*\//, '');
// Strip env assignments and wrappers; returns { prog, args, env }.
function unwrap(words) {
  let i = 0; const env = {};
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) { const k = words[i].indexOf('='); env[words[i].slice(0, k)] = words[i].slice(k + 1); i++; }
    if (i >= words.length) return { prog: null, args: [], env };
    const p = base(words[i]);
    if (!WRAPPERS.has(p)) break;
    i++;
    // skip the wrapper's own options (and timeout's duration)
    while (i < words.length && words[i].startsWith('-')) i++;
    if (p === 'timeout' && i < words.length && /^\d/.test(words[i])) i++;
  }
  return { prog: base(words[i]), args: words.slice(i + 1), env };
}

function shortFlags(args) {
  const f = new Set(); const long = new Set(); const rest = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && /^--[a-z]/.test(a)) long.add(a.split('=')[0]);
    else if (!ended && /^-[a-zA-Z]+$/.test(a)) for (const ch of a.slice(1)) f.add(ch);
    else rest.push(a);
  }
  return { f, long, rest };
}

const SQL_DESTRUCTIVE = [
  [/\bdrop\s+(table|database|schema|view|index|user|role)\b/i, (m) => `DROP ${m[1].toUpperCase()}`],
  [/\btruncate\s+(table\s+)?[\w"`.]/i, () => 'TRUNCATE'],
  [/\bdelete\s+from\b/i, () => 'DELETE FROM'],
  [/\bdropDatabase\s*\(|\.drop\s*\(\s*\)|\.deleteMany\s*\(/, () => 'MongoDB drop/delete'],
  [/\bflush(all|db)\b/i, (m) => `FLUSH${m[1].toUpperCase()}`],
];
const SQL_WRITE = /\b(insert\s+into|update\s+[\w"`.]+\s+set|delete\s+from|drop\s|truncate\s|alter\s|create\s|grant\s|revoke\s|replace\s+into|merge\s+into|copy\s+[\w"`.]+\s+from|vacuum\b|reindex\b)|\b(insert(One|Many)?|update(One|Many)?|delete(One|Many)?|replaceOne|dropDatabase|drop)\s*\(|\b(set|del|hset|lpush|rpush|sadd|zadd|expire|flushall|flushdb|rename)\s+\S/i;

const MIGRATOR = /\b(prisma\s+(migrate|db\s+push)|alembic\s+(upgrade|downgrade)|rails\s+db:|rake\s+db:|knex\s+migrate|sequelize\s+db:|typeorm\s+(migration|schema)|drizzle-kit\s+(push|migrate)|flyway|liquibase|manage\.py\s+(migrate|flush))\b/;

// ---- local, in-project SQLite files (snapshotted, so restore really undoes the write) ----
// Main database files only; same extensions as DB_RE in store.js (sidecars -wal/-shm/-journal follow the main file).
const SQLITE_FILE_RE = /\.(sqlite3?|db)$/i;
const SQLITE_PROGS = new Set(['sqlite3', 'sqlite']);
// sqlite3 options that take a value (sqlite3 accepts both -opt and --opt).
const SQLITE_VALUE_OPTS = new Set(['-cmd', '-separator', '-newline', '-nullvalue', '-vfs', '-maxsize', '-mmap', '-lookaside', '-pagecache', '-heap', '-escape']);
// SQL / dot-commands that can write somewhere other than the main database file, or run SQL/commands
// we can't see: ATTACH, VACUUM INTO, .open/.backup/.save/.output/.once/.clone/.shell/.system/.excel/.read,
// and sqlite3's -init/-A/-archive options.
const SQLITE_ESCAPES = /\battach\b|\bvacuum\b[^;]*\binto\b|(?:^|[\s;"'(])\.(open|backup|save|output|once|clone|shell|system|excel|read)\b/i;

// Analyse one command text. Returns { dangerous, reasons[], remote: [hosts], dbWrite }.
function analyze(cmd, depth = 0) {
  const text = String(cmd || '');
  const reasons = new Set();
  let usesDb = false; let dbFileInput = false; const hosts = new Set();
  // Non-shell labels produced by our hook (apply_patch summaries) and raw patches.
  if (/\*\*\* Delete File:/.test(text) || /^apply_patch: .*\bdelete\b/.test(text)) reasons.add('deletes files (apply_patch)');
  let cmds = [];
  try { cmds = simpleCommands(text); } catch { cmds = []; }
  for (const words of cmds) {
    const { prog, args, env } = unwrap(words);
    for (const [k, v] of Object.entries(env)) {
      if (/^(PGHOST|MYSQL_HOST|REDIS_HOST|DB_HOST)$/.test(k) && v && !isLocalHost(v)) hosts.add(v);
    }
    if (!prog) continue;
    const { f, long, rest } = shortFlags(args);
    if (SHELLS.has(prog)) {
      const ci = args.findIndex((a) => /^-[a-z]*c$/.test(a));
      if (ci >= 0 && args[ci + 1] && depth < 3) merge(analyze(args[ci + 1], depth + 1));
      continue;
    }
    if (prog === 'eval' && depth < 3) { merge(analyze(args.join(' '), depth + 1)); continue; }
    if (prog === 'rm') {
      const rec = f.has('r') || f.has('R') || long.has('--recursive');
      if (rec) reasons.add(f.has('f') || long.has('--force') ? 'rm -rf (recursive force delete)' : 'rm -r (recursive delete)');
    } else if (prog === 'rimraf' || prog === 'del-cli' || prog === 'trash') reasons.add(`${prog} (recursive delete)`);
    else if (prog === 'find') {
      if (args.includes('-delete')) reasons.add('find -delete');
      const ei = args.findIndex((a) => a === '-exec' || a === '-execdir');
      if (ei >= 0 && base(args[ei + 1] || '') === 'rm') reasons.add('find -exec rm');
    } else if (prog === 'git') {
      let k = 0; // skip git's global options: -C <dir>, -c <k=v>, --git-dir=..., --no-pager ...
      while (k < args.length && args[k].startsWith('-')) k += (args[k] === '-C' || args[k] === '-c' || args[k] === '--git-dir' || args[k] === '--work-tree') ? 2 : 1;
      const sub = args[k]; const sa = args.slice(k + 1);
      const g = shortFlags(sa);
      if (sub === 'reset' && g.long.has('--hard')) reasons.add('git reset --hard');
      else if (sub === 'reset' && (g.long.has('--merge') || g.long.has('--keep'))) { /* keeps local changes */ }
      else if (sub === 'clean' && (g.f.has('f') || g.long.has('--force'))) reasons.add(`git clean -${[...g.f].join('')} (deletes untracked files)`);
      else if (sub === 'checkout' && (sa.includes('--') || g.rest.some((p) => /^(\.|\.\/|:\/|\*)$/.test(p)) || g.f.has('f') || g.long.has('--force'))) reasons.add('git checkout (discards local changes)');
      else if (sub === 'restore' && !(g.long.has('--staged') && !g.long.has('--worktree')) && g.rest.length) reasons.add('git restore (discards local changes)');
      else if (sub === 'stash' && /^(drop|clear)$/.test(sa[0] || '')) reasons.add(`git stash ${sa[0]}`);
      else if (sub === 'push' && (g.f.has('f') || [...g.long].some((l) => l.startsWith('--force')) || g.rest.some((r) => r.startsWith('+')))) reasons.add('git push --force');
      else if (sub === 'branch' && g.f.has('D')) reasons.add('git branch -D');
    } else if (prog === 'mkfs' || prog.startsWith('mkfs.')) reasons.add('mkfs');
    else if (prog === 'dd' && args.some((a) => a.startsWith('of='))) reasons.add('dd of=');
    else if (prog === 'shred') reasons.add('shred');
    else if (prog === 'prisma' && args[0] === 'migrate' && args[1] === 'reset') reasons.add('prisma migrate reset');
    else if (prog === 'mv' && rest[rest.length - 1] === '/dev/null') reasons.add('mv to /dev/null');
    else if (prog === 'chmod' && (f.has('R') || long.has('--recursive'))) reasons.add('chmod -R');
    if (DB_CLIENTS.has(prog)) {
      usesDb = true;
      if (args.some((a) => /^(-f|--file(=.*)?)$/.test(a))) dbFileInput = true;
      // -h host / -hhost / --host host / --host=host
      for (let i = 0; i < args.length; i++) {
        let h = null;
        if (args[i] === '-h' || args[i] === '--host' || (prog === 'sqlcmd' && args[i] === '-S')) h = args[i + 1];
        else if (/^--host=/.test(args[i])) h = args[i].slice(7);
        else if (/^-h[^-]/.test(args[i]) && prog !== 'sqlite3') h = args[i].slice(2);
        if (h && !isLocalHost(h)) hosts.add(h);
      }
      // sqlite danger dot-commands (.shell/.backup/...): warn + dedicated snapshot, never block
      if (SQLITE_PROGS.has(prog)) {
        for (const m of String(text).matchAll(/(?:^|[\s;"'(])\.(shell|system|backup|save|clone|open|output|once|excel|read)\b/gi)) {
          reasons.add(`sqlite .${m[1].toLowerCase()}`);
        }
      }
    }
  }
  if (/[<]\s*\S+\.sql\b/.test(text) || /\|\s*(\S*\/)?(psql|mysql|mariadb|sqlite3|mongosh|redis-cli)\b/.test(text)) dbFileInput = true;
  if (usesDb) for (const [re, name] of SQL_DESTRUCTIVE) { const m = re.exec(text); if (m) reasons.add(name(m)); }
  for (const u of dbUris(text)) if (!u.local) hosts.add(u.host);
  // Migration tools / ORMs pointed at a DB URI also write.
  const migrator = MIGRATOR.test(text);
  const dbWrite = (usesDb && (SQL_WRITE.test(text) || dbFileInput)) || migrator || [...reasons].some((r) => /DROP|TRUNCATE|DELETE FROM|FLUSH|Mongo/.test(r));
  return { dangerous: reasons.size > 0, reasons: [...reasons], remote: dbWrite ? [...hosts] : [], dbWrite };

  function merge(r) { r.reasons.forEach((x) => reasons.add(x)); if (r.dbWrite) { usesDb = true; dbFileInput = true; } r.remote.forEach((h) => hosts.add(h)); }
}

function isLocalHost(h) {
  h = String(h).trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return true;
  if (h.startsWith('/') || h.startsWith('%2f') || h.startsWith('@')) return true; // unix socket
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

// Database URIs found in text: [{ scheme, host, local }] (host never includes credentials).
const URI_RE = /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|sqlserver|mssql|cockroachdb|clickhouse):\/\/([^\s'"`;|&()]*)/gi;
function dbUris(text) {
  const out = [];
  for (const m of String(text).matchAll(URI_RE)) {
    const rest = m[2];
    let authority = rest.split(/[/?]/)[0];
    const atA = authority.lastIndexOf('@'); if (atA >= 0) authority = authority.slice(atA + 1);
    // first host of a comma list, without port
    let host = authority.split(',')[0];
    host = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d*$/, '');
    const q = (rest.split('?')[1] || '');
    const qhost = (/(?:^|&)host=([^&]+)/.exec(q) || [])[1];
    if (!host && qhost) host = decodeURIComponent(qhost);
    out.push({ scheme: m[1].toLowerCase(), host: host || '(local socket)', local: isLocalHost(host) || (!!qhost && isLocalHost(decodeURIComponent(qhost)) && !host) });
  }
  return out;
}

// Redact secrets for display/logging: URI passwords, PGPASSWORD=..., --password=..., mysql -pSECRET.
function redact(s) {
  if (s == null) return s;
  return String(s)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/'"]*):([^\s@'"]*)@/gi, (m, sch, u) => `${sch}${u}:***@`)
    .replace(/\b([A-Z0-9_]*(PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_KEY|APIKEY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1=***')
    .replace(/(--password[= ])("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/((?:^|[\s;&|(])(?:\S*\/)?(?:mysql|mariadb|mysqldump|mysqladmin)\b[^\n;&|]*?\s-p)(?!\s|$)(\S+)/g, '$1***')
    .replace(/(redis-cli\b[^\n;&|]*?\s-a\s+)(\S+)/g, '$1***');
}

// Commands that remove/move/overwrite files (dangerous or not): always get their own snapshot.
function touchesFiles(cmd) {
  if (/^apply_patch: .*\bdelete\b/.test(cmd)) return true;
  let cmds = []; try { cmds = simpleCommands(String(cmd || '')); } catch {}
  return cmds.some((w) => ['rm', 'unlink', 'mv', 'truncate', 'shred', 'rmdir'].includes(unwrap(w).prog || '')) || analyze(cmd).dangerous;
}
function isDangerous(cmd) { return analyze(cmd).dangerous; }
function remoteDbHosts(cmd) { return analyze(cmd).remote; }
function remoteWarning(hosts) { return `⚠ agentundo: this step touches a remote database (${hosts.map(redact).join(', ')}) — local snapshots cannot undo it.`; }

// Paths a mutating command or a real write-redirect would change outside the project
// (and not system tool paths) => local snapshot can't help.
// Do not mix an unrelated home-path argument (e.g. `ls ~/.pgpass`) with a harmless
// redirect like `2>/dev/null` / `>/dev/null` — that was a false-positive source.
const OUTSIDE_MUTATORS = new Set(['rm', 'mv', 'cp', 'truncate', 'shred', 'dd', 'chmod', 'chown']);
function isOutsidePath(p, root) {
  if (!p) return false;
  if (p.startsWith('~')) return true;
  if (!p.startsWith('/')) return false;
  if (/^\/(dev|tmp|proc|usr\/bin|bin)\b/.test(p)) return false;
  return !(p === root || p.startsWith(root + '/'));
}
function mutatorTouchesOutside(words, root) {
  if (!words.length) return false;
  const { prog, args } = unwrap(words);
  if (!prog || !OUTSIDE_MUTATORS.has(prog)) return false;
  if (prog === 'dd') {
    for (const a of args) {
      const m = /^of=(.*)$/.exec(a);
      if (m && isOutsidePath(m[1], root)) return true;
    }
    return false;
  }
  for (const a of args) {
    if (a !== '-' && a.startsWith('-')) continue;
    if (isOutsidePath(a, root)) return true;
  }
  return false;
}
function outsideProject(cmd, root) {
  let toks;
  try { toks = lex(String(cmd || '')); } catch { return false; }
  let words = [];
  const flush = () => { const hit = mutatorTouchesOutside(words, root); words = []; return hit; };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.op) { if (flush()) return true; continue; }
    if (t.redir) {
      // Drop a trailing bare fd number left by forms like `2>/dev/null`.
      if (words.length && /^\d+$/.test(words[words.length - 1])) words.pop();
      const target = (toks[i + 1] && toks[i + 1].w) || '';
      if (toks[i + 1] && toks[i + 1].w) i++;
      // Output redirects only; skip /dev/null and fd duplicates (>&1, &1).
      if (t.redir.includes('>') && !t.redir.includes('<')
          && target && target !== '/dev/null' && !/^&?\d+$/.test(target)
          && isOutsidePath(target, root)) return true;
      continue;
    }
    if (t.w) words.push(t.w);
  }
  return flush();
}
const OUTSIDE = [/\bgit\s+push\b/, /\b(aws|gcloud|az|kubectl|terraform)\s/, /\bcurl\b.*-X\s*(DELETE|POST|PUT)/, /\bdiskutil\b/];



// True only when we are sure every database the command writes is a local SQLite file inside the project
// that the next snapshot captures (not in a default-excluded folder, not over maxFileMB). Anything we
// can't resolve (no file argument, $VAR/~ paths, unknown cwd after `cd`, SQL piped from a file, other
// DB clients, migration tools) returns false, so the generic heads-up stays on.
function localSqliteOnly(cmd, opts = {}) {
  const text = String(cmd || '');
  const root = opts.root ? path.resolve(opts.root) : null;
  if (!root) return false;
  if (MIGRATOR.test(text) || SQLITE_ESCAPES.test(text) || dbUris(text).length) return false;
  let realRootDir = root; try { realRootDir = fs.realpathSync.native(root); } catch {}
  const capBytes = (Number(opts.maxFileMB) > 0 ? Number(opts.maxFileMB) : 50) * 1024 * 1024;
  const excluded = typeof opts.excluded === 'function' ? opts.excluded : () => false;
  let sawSqlite = false;

  const inside = (abs) => [root, realRootDir].some((r) => { const rel = path.relative(r, abs); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
  function resolveReal(abs) {
    try { return fs.realpathSync.native(abs); } catch {}
    try { return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch {}
    return abs; // parent doesn't exist either: sqlite3 can't create it there; judge the plain path
  }
  function fileOk(file, cwd) {
    if (!file || !SQLITE_FILE_RE.test(file) || /[$`*?~{}]/.test(file)) return false;
    if (!path.isAbsolute(file) && !cwd) return false;
    const abs = path.resolve(cwd || '/', file);
    const real = resolveReal(abs);
    if (!inside(real)) return false;
    const rel = path.relative(realRootDir, real).split(path.sep).join('/');
    if (rel.startsWith('..') || excluded(rel)) return false;
    for (const f of [real, real + '-wal', real + '-journal', real + '-shm']) {
      try { const st = fs.statSync(f); if (st.isFile() && st.size > capBytes) return false; } catch {}
    }
    return true;
  }
  function sqliteTarget(args) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') return args[i + 1] || null;
      if (a.startsWith('-')) {
        const o = a.replace(/^--/, '-').split('=')[0];
        if (o === '-init' || o === '-A' || o === '-archive') return null;
        if (SQLITE_VALUE_OPTS.has(o) && !a.includes('=')) i++;
        continue;
      }
      return a;
    }
    return null; // no file: in-memory db, or something we don't understand
  }
  // Walk the token stream so we know the operator before each simple command (pipes) and track `cd`.
  function walk(s, cwd, depth) {
    let toks; try { toks = lex(s); } catch { return false; }
    const cmds = []; let cur = []; let prevOp = null; let skip = false; let curRedir = false;
    for (const t of toks) {
      if (t.op) { if (cur.length) cmds.push({ words: cur, prevOp, redirIn: curRedir }); cur = []; curRedir = false; prevOp = t.op; continue; }
      if (t.redir) { if (t.redir.includes('<')) curRedir = true; skip = true; continue; }
      if (skip) { skip = false; continue; }
      cur.push(t.w);
    }
    if (cur.length) cmds.push({ words: cur, prevOp, redirIn: curRedir });
    if (toks.some((t) => t.op === '(' || t.op === '$(' || t.op === '`') && cmds.some((c) => ['cd', 'pushd', 'popd'].includes(unwrap(c.words).prog))) cwd = null;
    let prevProg = null;
    for (const c of cmds) {
      const { prog, args } = unwrap(c.words);
      const pipedFrom = c.prevOp === '|' ? prevProg : null;
      prevProg = prog;
      if (!prog) continue;
      if (prog === 'cd' || prog === 'pushd') {
        const dest = args.filter((x) => !x.startsWith('-') || x === '-')[0];
        cwd = (!dest || dest === '-' || /[$`~*?{}]/.test(dest) || !cwd && !path.isAbsolute(dest)) ? null : path.resolve(cwd || '/', dest);
        continue;
      }
      if (prog === 'popd') { cwd = null; continue; }
      if (SHELLS.has(prog)) {
        const ci = args.findIndex((x) => /^-[a-z]*c$/.test(x));
        if (ci >= 0 && args[ci + 1] && depth < 3) { if (!walk(args[ci + 1], cwd, depth + 1)) return false; }
        else if (args.length) return false; // `bash script.sh`, `sh < file`: can't see what runs
        continue;
      }
      if (prog === 'eval') { if (depth >= 3 || !walk(args.join(' '), cwd, depth + 1)) return false; continue; }
      if (DB_CLIENTS.has(prog)) {
        if (!SQLITE_PROGS.has(prog)) return false;
        if (c.redirIn) return false; // `sqlite3 app.db < file.sql`: SQL we can't see
        if (pipedFrom && !['echo', 'printf'].includes(pipedFrom)) return false; // `cat x.sql | sqlite3 ...`
        if (!fileOk(sqliteTarget(args), cwd)) return false;
        sawSqlite = true;
      }
    }
    return true;
  }
  const cwd0 = opts.cwd ? path.resolve(opts.cwd) : root;
  return walk(text, cwd0, 0) && sawSqlite;
}

// Local DB write that a project snapshot cannot restore (outside-project sqlite, non-sqlite clients,
// over-cap / excluded / escaped sqlite). Remote hosts are handled separately via remoteWarning.
function unrestorableLocalDb(cmd, root, opts = {}) {
  const a = analyze(cmd);
  return !!(a.dbWrite && !a.remote.length && !localSqliteOnly(cmd, { ...opts, root }));
}

// Generic heads-up (not the remote-DB warning): local DB writes, pushes, cloud CLIs, paths outside.
// opts: { cwd, maxFileMB, excluded(relPath) } lets a write to an in-project SQLite file (which the snapshot
// captures and restore undoes) skip the heads-up. Without opts the old, stricter behaviour applies.
function cannotUndo(cmd, root, opts = {}) {
  return unrestorableLocalDb(cmd, root, opts) || OUTSIDE.some((re) => re.test(cmd)) || outsideProject(cmd, root);
}
module.exports = { touchesFiles, analyze, isDangerous, remoteDbHosts, remoteWarning, cannotUndo, unrestorableLocalDb, localSqliteOnly, redact, dbUris, isLocalHost, lex, simpleCommands };
