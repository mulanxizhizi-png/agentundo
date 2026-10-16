'use strict';
// Snapshot store: one shadow git repo per project, kept outside the project.
// GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE are always set explicitly, so the user's own
// .git (history, index, branches, stash) is never read or written.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { analyze, redact, touchesFiles } = require('./danger');

const MB = 1024 * 1024;
const DEFAULTS = { maxFileMB: 50, maxTotalMB: 2048, keepMin: 20, includeEnv: false };
const DEFAULT_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', 'dist/', 'build/', 'target/', '.next/', '.nuxt/', '.cache/', 'coverage/', '.agentundo-tmp-*/', '.agentreceipt/receipts/', '.agentreceipt/state/', '.agentreceipt/logs/'];
const ENV_EXCLUDES = ['.env', '.env.*', '!.env.example', '!.env.sample'];
const DB_RE = /\.(sqlite3?|db)(-wal|-shm|-journal)?$/i;

function homeDir(env = process.env) { return env.AGENTUNDO_HOME || path.join(os.homedir(), '.agentundo'); }
function realRoot(root) { try { return fs.realpathSync.native(root); } catch { return path.resolve(root); } }
function storeDir(root, env = process.env) {
  return path.join(homeDir(env), 'stores', crypto.createHash('sha1').update(realRoot(root)).digest('hex').slice(0, 16));
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
    this.dir = storeDir(this.root, env);
    this.gitDir = path.join(this.dir, 'shadow.git');
    this.index = path.join(this.dir, 'index');
    this.metaFile = path.join(this.dir, 'meta.jsonl');
    this.stateFile = path.join(this.dir, 'state.json');
    this.journal = path.join(this.dir, 'restore-journal.json');
    this.errorsFile = path.join(this.dir, 'errors.log');
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
  logError(msg) {
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.appendFileSync(this.errorsFile, `${new Date().toISOString()} ${redact(msg)}\n`); } catch {}
  }
  lastError() { try { const l = fs.readFileSync(this.errorsFile, 'utf8').trim().split('\n'); return l[l.length - 1] || null; } catch { return null; } }

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
    if (big.size) this.git(['rm', '-q', '--cached', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: [...big].join('\0') + '\0', allowFail: true });
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
      const danger = command0 ? analyze(command0) : { dangerous: false, reasons: [], remote: [] };
      // Also kept: the first command of every turn (even right after the turn-start snapshot — v0.1.1 merged
      // them, so Codex's first `rm a.txt` had no "before rm a.txt" entry) and any file-removing command.
      const firstStepOfTurn = !((s.steps && s.steps[turn]) > 0);
      const keepAnyway = !!last && label.event === 'tool' && (danger.dangerous || danger.remote.length > 0 || last.turn !== turn || firstStepOfTurn || touchesFiles(command0));
      if (!force && last && last.tree === tree && !keepAnyway) {
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
      const skippedThen = new Set(target.skipped || []);
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

module.exports = { Store, homeDir, storeDir, realRoot, DEFAULTS, DEFAULT_EXCLUDES, MB };
