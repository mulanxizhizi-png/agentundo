'use strict';
// Snapshot store: one shadow git repo per project, kept outside the project.
// GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE are always set explicitly, so the user's own
// .git (history, index, branches, stash) is never read or written.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { analyze, redact, touchesFiles, unrestorableLocalDb } = require('./danger');

const MB = 1024 * 1024;
const DEFAULTS = { maxFileMB: 50, maxTotalMB: 2048, keepMin: 20, includeEnv: false };
const DEFAULT_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', 'dist/', 'build/', 'target/', '.next/', '.nuxt/', '.cache/', 'coverage/', '.agentundo-tmp-*/', '.agentreceipt/receipts/', '.agentreceipt/state/', '.agentreceipt/logs/'];
const ENV_EXCLUDES = ['.env', '.env.*', '!.env.example', '!.env.sample'];
const DB_RE = /\.(sqlite3?|db)(-wal|-shm|-journal)?$/i;

function sameSet(a, b) { if (a.length !== b.length) return false; const s = new Set(a); return b.every((x) => s.has(x)); }
function homeDir(env = process.env) { return env.AGENTUNDO_HOME || path.join(os.homedir(), '.agentundo'); }
function realRoot(root) { try { return fs.realpathSync.native(root); } catch { return path.resolve(root); } }
function storeDirFor(key, env = process.env) {
  return path.join(homeDir(env), 'stores', crypto.createHash('sha1').update(key).digest('hex').slice(0, 16));
}
function storeDir(root, env = process.env) { return storeDirFor(realRoot(root), env); }

// ---- backward compatibility with pre-0.1.3 path keys ----
// Before 0.1.3 the key was fs.realpathSync (JS), which on macOS keeps the case the user typed and could
// differ from the native canonical path. Old store dirs / registry entries keyed that way are found here
// and migrated (rename, atomic on the same filesystem) to the canonical key. Nothing is ever deleted.
function legacyRoot(root) { try { return fs.realpathSync(root); } catch { return path.resolve(root); } }
function rawRegistry(env) {
  try { const r = JSON.parse(fs.readFileSync(path.join(homeDir(env), 'projects.json'), 'utf8')); return Array.isArray(r.projects) ? r.projects : []; } catch { return []; }
}
function sameDir(a, b) {
  if (a === b) return true;
  try { const x = fs.statSync(a); const y = fs.statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
}
function legacyKeys(root, env = process.env, extra = []) {
  const canon = realRoot(root);
  const keys = new Set([legacyRoot(root), path.resolve(root), ...extra]);
  for (const e of rawRegistry(env)) if (e !== canon && sameDir(e, canon)) keys.add(e);
  keys.delete(canon);
  return [...keys];
}
const warned = new Set();
function warnOnce(dir, msg) {
  const marker = path.join(dir, 'superseded-by-new-store.txt');
  if (warned.has(dir) || fs.existsSync(marker)) return;
  warned.add(dir);
  try { fs.writeFileSync(marker, msg + '\n'); } catch {}
  process.stderr.write(`agentundo: ${msg}\n`);
}
const moveWarned = new Set();
function moveFailedOnce(old, dir, e) {
  if (moveWarned.has(old)) return;
  moveWarned.add(old);
  process.stderr.write(`agentundo: note: could not move the older snapshot store ${old} to ${dir} (${(e && e.code) || 'error'}); still using it where it is, all snapshots stay available.\n`);
}
// Returns the store dir to use for `root`, migrating a legacy store dir if needed.
function migrateStore(root, env = process.env, extra = []) {
  const canon = realRoot(root);
  const dir = storeDirFor(canon, env);
  for (const k of legacyKeys(root, env, extra)) {
    const old = storeDirFor(k, env);
    if (old === dir || !fs.existsSync(old)) continue;
    if (fs.existsSync(path.join(old, 'superseded-by-new-store.txt')) && fs.existsSync(dir)) continue;
    if (!fs.existsSync(dir)) {
      try {
        fs.renameSync(old, dir);
        try { fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ root: canon, migratedFrom: k }, null, 2) + '\n'); } catch {}
      } catch (e) { // could not move it: keep using the old dir as-is, no data loss
        moveFailedOnce(old, dir, e);
        return old;
      }
    } else {
      warnOnce(old, `found an older snapshot store for ${canon} (keyed as ${k}) at ${old}; it was kept untouched and the newer store ${dir} is used.`);
    }
  }
  return dir;
}

// ---- all store dirs inside agentundo's own data dir (used by `uninstall --purge`) ----
function storesDir(env = process.env) { return path.join(homeDir(env), 'stores'); }
const STORE_NAME = /^[0-9a-f]{16}(\.deleting-\d+)?$/; // .deleting-<pid>: an interrupted purge
// Every entry of <home>/stores that looks like a store dir (16 hex chars, or one a purge was deleting), as absolute paths.
// Never follows a symlinked entry out of the stores dir: callers lstat before deleting.
function allStoreDirs(env = process.env) {
  let names = [];
  try { names = fs.readdirSync(storesDir(env)); } catch { return []; }
  return names.filter((n) => STORE_NAME.test(n)).map((n) => path.join(storesDir(env), n));
}
function storeInfo(dir) {
  const info = { root: null, superseded: fs.existsSync(path.join(dir, 'superseded-by-new-store.txt')), snapshots: 0 };
  try { info.root = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).root || null; } catch {}
  try { info.snapshots = fs.readFileSync(path.join(dir, 'meta.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length; } catch {}
  return info;
}
// Other store dirs that belong to the project at `root` (legacy keys, superseded copies), excluding `except`.
function relatedStoreDirs(root, env = process.env, except = []) {
  const canon = realRoot(root);
  const keyed = new Set(legacyKeys(root, env).map((k) => storeDirFor(k, env)));
  return allStoreDirs(env).filter((d) => {
    if (except.includes(d) || d === storeDirFor(canon, env)) return false;
    if (keyed.has(d)) return true;
    const r = storeInfo(d).root;
    return !!r && (r === canon || (fs.existsSync(r) && realRoot(r) === canon));
  });
}

function readConfig(root) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(root, '.agentundo', 'config.json'), 'utf8')) || {}; } catch {}
  const env = process.env;
  const cfg = { ...DEFAULTS, ...c };
  if (env.AGENTUNDO_MAX_FILE_MB) cfg.maxFileMB = Number(env.AGENTUNDO_MAX_FILE_MB);
  if (env.AGENTUNDO_MAX_TOTAL_MB) cfg.maxTotalMB = Number(env.AGENTUNDO_MAX_TOTAL_MB);
  if (env.AGENTUNDO_KEEP_MIN) cfg.keepMin = Number(env.AGENTUNDO_KEEP_MIN);
  return cfg;
}

class Store {
  constructor(root, env = process.env) {
    this.root = realRoot(root);
    this.env = env;
    this.dir = migrateStore(root, env);
    this.gitDir = path.join(this.dir, 'shadow.git');
    this.index = path.join(this.dir, 'index');
    this.metaFile = path.join(this.dir, 'meta.jsonl');
    this.stateFile = path.join(this.dir, 'state.json');
    this.journal = path.join(this.dir, 'restore-journal.json');
    this.errorsFile = path.join(this.dir, 'errors.log');
    this.errorsFallback = path.join(homeDir(env), 'errors-fallback.log');
    this.cfg = readConfig(this.root);
  }

  git(args, { input, index = this.index, allowFail = false, maxBuffer = 512 * MB } = {}) {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], {
      // cwd must exist or spawn fails with ENOENT (e.g. project dir deleted); git uses GIT_DIR/GIT_WORK_TREE anyway.
      cwd: fs.existsSync(this.root) ? this.root : (fs.existsSync(this.dir) ? this.dir : require('os').tmpdir()), input, maxBuffer, timeout: 120000,
      env: { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.root, GIT_INDEX_FILE: index,
        GIT_AUTHOR_NAME: 'agentundo', GIT_AUTHOR_EMAIL: 'agentundo@localhost', GIT_COMMITTER_NAME: 'agentundo', GIT_COMMITTER_EMAIL: 'agentundo@localhost',
        GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    if (r.error) throw r.error;
    if (r.status !== 0 && !allowFail) {
      const why = String(r.stderr).trim().slice(0, 500) || (r.signal ? `killed by ${r.signal}` : `exit code ${r.status}`);
      throw new Error(`git ${args[0]} failed: ${why}${r.stderr && String(r.stderr).trim() && r.signal ? ` (${r.signal})` : ''}`);
    }
    return allowFail ? { ok: r.status === 0, out: String(r.stdout) } : String(r.stdout);
  }

  exists() { return fs.existsSync(path.join(this.gitDir, 'HEAD')); }

  ensure() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!this.exists()) {
      execFileSync('git', ['init', '-q', '--bare', this.gitDir], { stdio: 'ignore' });
      const set = (k, v) => execFileSync('git', ['--git-dir', this.gitDir, 'config', k, v], { stdio: 'ignore' });
      set('core.bigFileThreshold', '50m'); set('gc.auto', '0'); set('core.symlinks', 'true'); set('core.fileMode', 'true');
      fs.writeFileSync(path.join(this.dir, 'project.json'), JSON.stringify({ root: this.root }, null, 2) + '\n');
    }
    // Default excludes live in the shadow repo's info/exclude (rewritten each time so config changes apply).
    const ex = [...DEFAULT_EXCLUDES, ...(this.cfg.includeEnv ? [] : ENV_EXCLUDES), ...(this.cfg.exclude || [])];
    const exFile = path.join(this.gitDir, 'info', 'exclude');
    fs.mkdirSync(path.dirname(exFile), { recursive: true });
    const text = ex.join('\n') + '\n';
    if (!fs.existsSync(exFile) || fs.readFileSync(exFile, 'utf8') !== text) fs.writeFileSync(exFile, text);
  }

  // ---- locking (one writer per project; stale after 60s) ----
  lock(waitMs = 5000) {
    fs.mkdirSync(this.dir, { recursive: true });
    const p = path.join(this.dir, 'lock');
    const until = Date.now() + waitMs;
    for (;;) {
      try { const fd = fs.openSync(p, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return () => { try { fs.unlinkSync(p); } catch {} }; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(p).mtimeMs > 60000) { fs.unlinkSync(p); continue; } } catch {}
        if (Date.now() > until) throw new Error('timed out waiting for the agentundo lock (another snapshot is running)');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  // ---- metadata ----
  meta() {
    let text = '';
    try { text = fs.readFileSync(this.metaFile, 'utf8'); } catch { return []; }
    const out = [];
    for (const l of text.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} }
    return out;
  }
  metaWithMarks() {
    const marks = this.marks();
    return this.meta().map((m) => (marks[m.id] ? { ...m, receipt: marks[m.id] } : m));
  }
  // Receipt marks (from agentreceipt): { "<id>": { status, receipt, ts } }, joined into meta() as m.receipt.
  marks() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'marks.json'), 'utf8')) || {}; } catch { return {}; } }
  mark(id, info) {
    const unlock = this.lock();
    try {
      const all = this.marks(); all[id] = info;
      const live = new Set(this.meta().map((m) => String(m.id)));
      for (const k of Object.keys(all)) if (!live.has(k)) delete all[k];
      const f = path.join(this.dir, 'marks.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(all)); fs.renameSync(f + '.tmp', f);
    } finally { unlock(); }
  }
  // Newest snapshot with a green receipt, optionally strictly before snapshot id `beforeId`.
  lastGreen(beforeId = Infinity) {
    const marks = this.marks();
    return this.meta().filter((m) => m.id < beforeId && marks[m.id] && marks[m.id].status === 'green').pop() || null;
  }
  appendMeta(m) { fs.appendFileSync(this.metaFile, JSON.stringify(m) + '\n'); }
  rewriteMeta(list) { const tmp = this.metaFile + '.tmp'; fs.writeFileSync(tmp, list.map((m) => JSON.stringify(m) + '\n').join('')); fs.renameSync(tmp, this.metaFile); }
  state() { try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return { nextId: 1, turn: 0, turns: {} }; } }
  saveState(s) { const tmp = this.stateFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, this.stateFile); }
  // AU-003: never silently drop errors. Prefer the store dir; if that is not writable, fall back to
  // ~/.agentundo/errors-fallback.log and always tip on stderr (hook still exits 0).
  logError(msg) {
    const line = `${new Date().toISOString()} ${redact(msg)}\n`;
    const tryAppend = (file) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line);
      return true;
    };
    try {
      tryAppend(this.errorsFile);
      return { wrote: this.errorsFile, fallback: false };
    } catch (e1) {
      try {
        tryAppend(this.errorsFallback);
        try { process.stderr.write(`agentundo: could not write ${this.errorsFile} (${e1.code || e1.message}); wrote to ${this.errorsFallback} instead\n`); } catch {}
        return { wrote: this.errorsFallback, fallback: true };
      } catch (e2) {
        try { process.stderr.write(`agentundo: could not write error log (${e1.code || e1.message}; fallback ${e2.code || e2.message}): ${redact(msg)}\n`); } catch {}
        return { wrote: null, fallback: false };
      }
    }
  }
  lastError() {
    for (const f of [this.errorsFile, this.errorsFallback]) {
      try {
        const l = fs.readFileSync(f, 'utf8').trim().split('\n');
        if (l.length && l[l.length - 1]) return l[l.length - 1];
      } catch {}
    }
    return null;
  }

  // Turn number for a (session, turn key). New key => new turn.
  turnFor(s, session, key, isNewTurn) {
    const k = `${session || '-'}:${key || '-'}`;
    if (key && s.turns[k]) return s.turns[k];
    if (!key && !isNewTurn && s.turn) return s.turn;
    s.turn = (s.turn || 0) + 1;
    if (key) {
      s.turns[k] = s.turn;
      const keys = Object.keys(s.turns); // bound the map
      if (keys.length > 500) for (const old of keys.slice(0, keys.length - 500)) delete s.turns[old];
    }
    return s.turn;
  }

  // ---- building a tree from the working directory ----
  // Returns { tree, skipped: [{path,size}] } using our own index.
  buildTree() {
    const capBytes = this.cfg.maxFileMB * MB;
    // candidates: untracked (not ignored) + modified relative to our index
    const cand = this.git(['ls-files', '-z', '--others', '--modified', '--exclude-standard']).split('\0').filter(Boolean);
    // databases are kept even when the project .gitignore ignores them
    const ignoredDbs = this.git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ':(glob)**/*.db', ':(glob)**/*.db-*', ':(glob)**/*.sqlite', ':(glob)**/*.sqlite-*', ':(glob)**/*.sqlite3', ':(glob)**/*.sqlite3-*'])
      .split('\0').filter((p) => p && DB_RE.test(p) && !this.defaultExcluded(p));
    const skipped = [];
    const big = new Set();
    for (const p of [...new Set([...cand, ...ignoredDbs])]) {
      let st; try { st = fs.lstatSync(path.join(this.root, p)); } catch { continue; }
      if (st.isFile() && st.size > capBytes) { big.add(p); skipped.push({ path: p, size: st.size }); }
    }
    const lit = (p) => `:(exclude,literal)${p}`;
    const spec = ['.', ...[...big].map(lit)].join('\0') + '\0';
    this.git(['add', '-A', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: spec, allowFail: true });
    const dbs = ignoredDbs.filter((p) => !big.has(p));
    if (dbs.length) this.git(['add', '-f', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: dbs.join('\0') + '\0', allowFail: true });
    // -f: without it git refuses ("staged content different from both the file and the HEAD") whenever the
    // file was captured small before and has since grown, which silently left the stale small copy in the tree.
    if (big.size) this.git(['rm', '-q', '--cached', '-f', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: [...big].join('\0') + '\0', allowFail: true });
    const tree = this.git(['write-tree']).trim();
    return { tree, skipped };
  }
  defaultExcluded(p) {
    const parts = p.split('/');
    return parts.some((seg, i) => i < parts.length - 1 && DEFAULT_EXCLUDES.some((e) => e === seg + '/'));
  }

  // ---- snapshot ----
  // label: { agent, session, turnKey, event: 'turn'|'tool'|'restore'|'manual', tool, command }
  // Returns the meta record (or the previous one when nothing changed), plus warnings.
  snapshot(label = {}, { force = false } = {}) {
    const lost = !this.exists() && (fs.existsSync(this.metaFile) || fs.existsSync(this.stateFile));
    this.ensure();
    const unlock = this.lock();
    try {
      const warnings = [];
      if (lost) {
        // The shadow repo vanished (deleted by hand, disk cleanup...): old snapshots are gone. Start over
        // with a fresh baseline and say so loudly instead of pretending the old ids still work.
        for (const f of [this.metaFile, this.stateFile, this.journal, path.join(this.dir, 'marks.json'), this.index]) fs.rmSync(f, { force: true });
        const msg = 'agentundo WARNING: the snapshot store was missing (deleted?); all earlier snapshots are lost. Took a new baseline now.';
        this.logError(msg);
        warnings.push(msg);
        force = true;
      }
      const { tree, skipped } = this.buildTree();
      const all = this.meta();
      const last = all[all.length - 1];
      const s = this.state();
      const turn = ['restore', 'manual', 'receipt'].includes(label.event) ? (s.turn || 0) : this.turnFor(s, label.session, label.turnKey, label.event === 'turn');
      if (skipped.length) warnings.push(`agentundo: ${skipped.length} file(s) over ${this.cfg.maxFileMB}MB not snapshotted: ${skipped.slice(0, 3).map((x) => x.path).join(', ')}${skipped.length > 3 ? ', …' : ''}`);
      const command0 = label.command ? String(label.command) : '';
      // Unchanged tree: skip, except the first command of a new turn or a dangerous command, so
      // `list` always shows "before <that command>" (an extra entry costs only a tiny commit).
      // Dangerous commands always get their own dedicated snapshot, even when nothing changed.
      const danger = command0 ? analyze(command0) : { dangerous: false, reasons: [], remote: [], dbWrite: false };
      const dbOpts = { root: this.root, cwd: label.cwd || this.root, maxFileMB: this.cfg.maxFileMB, excluded: (p) => this.defaultExcluded(p) };
      // Outside-project / unrestorable local DB: always keep a list row so the user sees "snapshotted / may not restore".
      const outsideDb = !!(command0 && (label.outsideDb || unrestorableLocalDb(command0, this.root, dbOpts)));
      // Also kept: the first command of every turn (even right after the turn-start snapshot — v0.1.1 merged
      // them, so Codex's first `rm a.txt` had no "before rm a.txt" entry) and any file-removing command.
      const firstStepOfTurn = !((s.steps && s.steps[turn]) > 0);
      const keepAnyway = !!last && label.event === 'tool' && (danger.dangerous || danger.remote.length > 0 || outsideDb || last.turn !== turn || firstStepOfTurn || touchesFiles(command0) || !!label.outOfScope);
      // Same tree is only "nothing changed" if the same files were left out for size: a file that newly went
      // over the cap (or came back under it) changes what the snapshot covers, so it gets its own record and
      // restore knows the file existed. (0.1.3 and earlier reused the old record and lost that fact.)
      const sameSkipped = !!last && sameSet(last.skipped || [], skipped.map((x) => x.path));
      if (!force && last && last.tree === tree && sameSkipped && !keepAnyway) {
        this.saveState(s);
        return { snap: last, created: false, warnings };
      }
      const id = s.nextId || 1;
      s.nextId = id + 1;
      const step = (s.steps && s.steps[turn]) || 0;
      s.steps = { [turn]: label.event === 'tool' ? step + 1 : step };
      // Secrets (DB passwords, *_PASSWORD=..., tokens) are redacted before anything is stored.
      const command = label.command ? redact(String(label.command)).replace(/\s+/g, ' ').trim().slice(0, 200) : null;
      const m = {
        id, tree, ts: new Date().toISOString(), turn, step: label.event === 'tool' ? step + 1 : 0,
        event: label.event || 'manual', agent: label.agent || null, session: label.session || null,
        tool: label.tool || null, command, dangerous: danger.dangerous,
        reasons: danger.reasons.length ? danger.reasons : undefined, remoteDb: danger.remote.length ? danger.remote.map(redact) : undefined,
        outsideDb: outsideDb || undefined,
        outOfScope: label.outOfScope || undefined,
        outOfScopePaths: label.outOfScope && label.outOfScopePaths && label.outOfScopePaths.length
          ? label.outOfScopePaths.slice(0, 5) : undefined,
        skipped: skipped.map((x) => x.path), note: label.note || null,
      };
      const commit = this.git(['commit-tree', tree, '-m', `agentundo #${id}`]).trim();
      this.git(['update-ref', `refs/au/s/${id}`, commit]);
      m.commit = commit;
      if (last) {
        const r = this.git(['diff-tree', '-r', '--no-renames', '--name-only', '-z', last.tree, tree], { allowFail: true });
        m.changed = r.ok ? r.out.split('\0').filter(Boolean).length : null;
      } else m.changed = null;
      this.appendMeta(m);
      this.saveState(s);
      warnings.push(...this.enforceCap());
      return { snap: m, created: true, warnings };
    } finally { unlock(); }
  }

  sizeBytes() {
    const out = this.git(['count-objects', '-v'], { allowFail: true }).out || '';
    const kb = (k) => Number((out.match(new RegExp(`^${k}: (\\d+)`, 'm')) || [])[1] || 0);
    return (kb('size') + kb('size-pack')) * 1024;
  }

  // Over the total cap: drop oldest snapshots (keeping at least keepMin), gc, and say so every time.
  enforceCap() {
    const cap = this.cfg.maxTotalMB * MB;
    let size = this.sizeBytes();
    if (size <= cap) return [];
    const all = this.meta();
    const removable = Math.max(0, all.length - this.cfg.keepMin);
    let removed = 0;
    const dropped = new Set();
    if (removable > 0) {
      // first pass: gc can shrink loose objects a lot without deleting anything
      this.gc();
      size = this.sizeBytes();
      while (size > cap && removed < removable) {
        const batch = Math.max(1, Math.ceil((removable - removed) / 4));
        const green = this.lastGreen();
        const drop = all.slice(removed, removed + batch).filter((m) => !green || m.id !== green.id);
        for (const m of drop) { this.git(['update-ref', '-d', `refs/au/s/${m.id}`], { allowFail: true }); dropped.add(m.id); }
        removed += batch;
        this.gc();
        size = this.sizeBytes();
      }
      if (dropped.size) this.rewriteMeta(all.filter((m) => !dropped.has(m.id)));
    }
    const mb = (b) => (b / MB).toFixed(1);
    if (size > cap) return [`agentundo WARNING: snapshots use ${mb(size)}MB, over the ${this.cfg.maxTotalMB}MB cap even after keeping only the newest ${all.length - dropped.size}. Still snapshotting; raise maxTotalMB or exclude big folders in .agentundo/config.json.`];
    return [`agentundo: reached the ${this.cfg.maxTotalMB}MB cap; removed ${dropped.size} oldest snapshot(s) (now ${mb(size)}MB).`];
  }
  gc() {
    this.git(['reflog', 'expire', '--expire=now', '--all'], { allowFail: true });
    this.git(['gc', '-q', '--prune=now'], { allowFail: true });
  }

  prune({ keep }) {
    const unlock = this.lock();
    try {
      const all = this.meta();
      const drop = all.slice(0, Math.max(0, all.length - keep));
      for (const m of drop) this.git(['update-ref', '-d', `refs/au/s/${m.id}`], { allowFail: true });
      this.rewriteMeta(all.slice(drop.length));
      this.gc();
      return drop.length;
    } finally { unlock(); }
  }

  // id forms: "12" (snapshot #12), "t3" (first snapshot of turn 3), "t3.2" (turn 3, 2nd tool step)
  resolve(idStr) {
    const all = this.meta();
    const s = String(idStr || '').trim();
    let m = null;
    if (/^#?\d+$/.test(s)) m = all.find((x) => x.id === Number(s.replace('#', '')));
    else if (/^t\d+$/i.test(s)) {
      // start of turn N: its first snapshot, or (if the turn start was identical to the previous state) the last one before it
      const n = Number(s.slice(1));
      m = all.find((x) => x.turn === n && x.event === 'turn') || [...all].reverse().find((x) => x.turn < n) || all.find((x) => x.turn === n);
    }
    else if (/^t\d+\.\d+$/i.test(s)) { const [t, st] = s.slice(1).split('.').map(Number); m = all.find((x) => x.turn === t && x.step === st); }
    if (!m) throw new Error(`no snapshot "${s}" (see \`agentundo list\`)`);
    return m;
  }

  // Current working tree as a tree object (uses our index; does not create a snapshot).
  currentTree() { this.ensure(); const unlock = this.lock(); try { return this.buildTree(); } finally { unlock(); } }

  // Of `paths`, those the target snapshot would have captured: not ignored by the target's own
  // .gitignore files or agentundo's excludes, and not over the size cap now. Restore only deletes these.
  capturable(target, paths) {
    if (!paths.length) return [];
    const tmp = path.join(this.dir, `rules-${process.pid}`);
    const idx = path.join(this.dir, `rules-index-${process.pid}`);
    try {
      fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
      const ign = this.git(['ls-tree', '-r', '-z', '--name-only', target.tree]).split('\0').filter((p) => p === '.gitignore' || p.endsWith('/.gitignore'));
      if (ign.length) {
        this.git(['read-tree', target.tree], { index: idx });
        this.git(['checkout-index', '-f', '-z', '--stdin', `--prefix=${tmp}/`], { index: idx, input: ign.join('\0') + '\0' });
      }
      const r = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
        cwd: tmp, input: paths.join('\0') + '\0', maxBuffer: 512 * MB,
        env: { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: tmp, GIT_INDEX_FILE: idx, GIT_CONFIG_NOSYSTEM: '1' },
      });
      if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed: ${String(r.stderr).trim() || r.signal || r.status}`);
      const ignored = new Set(String(r.stdout).split('\0').filter(Boolean));
      const cap = this.cfg.maxFileMB * MB;
      // Never delete a path that was too big to save at the target or at any later snapshot: the store
      // never had its content, so it can't tell whether the file belongs in the target state.
      const skippedThen = new Set(target.skipped || []);
      for (const m of this.meta()) if (m.id >= target.id && Array.isArray(m.skipped)) for (const x of m.skipped) skippedThen.add(x);
      return paths.filter((p) => {
        if (skippedThen.has(p)) return false;
        if (ignored.has(p)) return DB_RE.test(p) && !this.defaultExcluded(p); // databases are force-included
        try { const st = fs.lstatSync(path.join(this.root, p)); if (st.isFile() && st.size > cap) return false; } catch {}
        return true;
      });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(idx, { force: true }); }
  }

  // Changes needed to go from `fromTree` to `toTree`: [{status, path}] limited to paths.
  changes(fromTree, toTree, paths = []) {
    const args = ['diff-tree', '-r', '--no-renames', '--name-status', '-z', fromTree, toTree];
    if (paths.length) args.push('--', ...paths.map((p) => `:(literal)${p}`));
    const parts = this.git(args).split('\0').filter((x) => x !== '');
    const out = [];
    for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], path: parts[i + 1] });
    return out;
  }
}

module.exports = { Store, homeDir, storeDir, storeDirFor, storesDir, allStoreDirs, storeInfo, relatedStoreDirs, realRoot, legacyRoot, migrateStore, sameDir, DEFAULTS, DEFAULT_EXCLUDES, MB };
