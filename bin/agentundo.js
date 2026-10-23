#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { Store, homeDir, MB, storesDir, allStoreDirs, storeInfo, relatedStoreDirs } = require('../src/store');
const I = require('../src/install');
const { restore, planRestore } = require('../src/restore');

const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
// Everything after `--` is a path, except the flags --yes/-y/--dry-run, which are accepted there too
// (nobody means a file literally named --yes); a note is printed when that happens.
const FLAGS_AFTER_DD = new Set(['--yes', '-y', '--dry-run']);
const afterDD = dd >= 0 ? argv.slice(dd + 1) : [];
const movedFlags = afterDD.filter((a) => FLAGS_AFTER_DD.has(a));
const args = [...(dd >= 0 ? argv.slice(0, dd) : argv), ...movedFlags];
const pathsArg = afterDD.filter((a) => !FLAGS_AFTER_DD.has(a));
const cmd = args[0];
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const positional = args.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && ['--agent', '--limit', '--keep', '--claude-scope', '--only', '--label', '--status', '--receipt'].includes(arr[i - 1])));
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const die = (msg, code = 1) => { console.error(c('31', `agentundo: ${msg}`)); process.exit(code); };

function ask(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); });
  });
}
// Destructive confirmations: interactive y/N; without a terminal, refuse unless --yes.
async function confirm(q) {
  if (flag('--yes') || flag('-y')) return true;
  if (!process.stdin.isTTY) die('no terminal to confirm; re-run with --yes to proceed. Nothing was changed.');
  return ask(q);
}

function projectRoot() {
  const cwd = process.cwd();
  const reg = I.findProject(cwd);
  if (reg) return reg;
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return cwd; }
}
function storeOrDie() {
  const s = new Store(projectRoot());
  if (!s.exists()) die(`no snapshots for ${s.root} yet. Run \`npx github:mulanxizhizi-png/agentundo init\` here first.`);
  return s;
}
function journalNotice(s) {
  if (fs.existsSync(s.journal)) {
    try { const j = JSON.parse(fs.readFileSync(s.journal, 'utf8')); console.log(c('33', `! A restore of #${j.target} was interrupted. Re-run \`agentundo restore ${j.target}\` to finish it, or \`agentundo restore ${j.pre}\` to go back to how things were before it.`)); } catch {}
  }
}
const label = (m) => (m.event === 'turn' ? 'turn start' : m.event === 'restore' ? (m.note || 'before restore') : m.event === 'manual' ? (m.note || 'manual snapshot') : m.event === 'receipt' ? (m.note || 'agentreceipt verification') : `before ${m.command || m.tool}`);
const ago = (ts) => { const s = (Date.now() - Date.parse(ts)) / 1000; return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };

async function main() {
  switch (cmd) {
    case 'hook': return require('../src/hook').main(opt('--agent', 'codex'));
    case 'init': return init();
    case 'list': case 'ls': return list();
    case 'diff': return diff();
    case 'changes': return changes();
    case 'restore': return doRestore();
    case 'status': return status();
    case 'snap': case 'snapshot': return snap();
    case 'receipt': return receipt();
    case 'prune': return prune();
    case 'uninstall': return uninstall();
    case '-v': case '--version': case 'version': return console.log(I.VERSION);
    default: return help();
  }
}

function help() {
  console.log(`agentundo ${I.VERSION} - an undo button for coding agents (Codex, Claude Code)

  agentundo init [--agent codex|claude] [--claude-scope local|user]
  agentundo list [--limit 20|--all] [--dangerous]   snapshots: id, turn, what it ran before (⚠ = dangerous / out-of-scope)
  agentundo diff <id> [--patch] [-- <paths>]   snapshot vs. working tree
  agentundo changes [tN | <id>] [--batches] [--md] [--json]   what a turn (or everything since a snapshot) added/changed/deleted; read-only
  agentundo restore <id> [--dry-run] [--yes] [-- <paths>]
  agentundo snap [note]                  take a snapshot now
  agentundo status
  agentundo prune --keep <n>
  agentundo uninstall [--global] [--purge] [--yes]

  <id>: 12 (snapshot #12), t3 (start of turn 3), t3.2 (turn 3, before its 2nd command)`);
  if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1;
}

function init() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { die('git is required (agentundo stores snapshots in a private git repo). Install git and re-run.'); }
  const root = (() => { try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return process.cwd(); } })();
  if (root === require('os').homedir() || root === '/') die(`refusing to snapshot ${root}; run init inside a project folder.`);
  const a = opt('--agent', 'both');
  const agents = a === 'both' ? ['codex', 'claude'] : [a];
  if (agents.some((x) => !['codex', 'claude'].includes(x))) die('--agent must be codex, claude or both');
  const scope = opt('--claude-scope', 'local');
  for (const ag of agents) I.readJsonStrict(I.targetFile(ag, root, scope)); // validate before writing anything
  I.installRuntime();
  const files = agents.map((ag) => I.install({ agent: ag, root, scope }));
  I.addExcludes(root, I.REPO_EXCLUDES);
  I.registerProject(root);
  const store = new Store(root);
  const t0 = Date.now();
  const r = store.snapshot({ event: 'manual', note: 'baseline (agentundo init)' });
  console.log(c('32', `agentundo ${I.VERSION} installed for ${store.root}`));
  for (const f of files) console.log(`  hooks: ${f}`);
  console.log(`  snapshots: ${store.dir} (outside your project; your .git is never touched)`);
  console.log(`  baseline snapshot #${r.snap.id} in ${Date.now() - t0}ms`);
  for (const w of r.warnings) console.log(c('33', `  ${w}`));
  if (agents.includes('codex')) console.log('Codex: open /hooks once in Codex and trust the two agentundo hooks (PreToolUse, UserPromptSubmit).');
  console.log('Then: `npx github:mulanxizhizi-png/agentundo#v' + I.VERSION + ' list` (or ~/.agentundo/bin/agentundo list).');
}

function list() {
  const s = storeOrDie();
  journalNotice(s);
  const all = s.metaWithMarks();
  if (flag('--json')) { const g = s.lastGreen(); return console.log(JSON.stringify({ schemaVersion: 1, root: s.root, lastGreen: g ? g.id : null, snapshots: all.map(({ tree, commit, ...m }) => ({ ...m, label: label(m) })) })); }
  const pool = flag('--dangerous') ? all.filter((m) => m.dangerous || (m.remoteDb && m.remoteDb.length) || m.outsideDb) : all;
  const lim = flag('--all') ? pool.length : Number(opt('--limit', 20));
  const rows = pool.slice(-lim);
  if (!rows.length) return console.log(flag('--dangerous') ? 'no dangerous commands recorded' : 'no snapshots yet');
  console.log(c('2', `${'ID'.padEnd(5)} ${'TURN'.padEnd(7)} ${'WHEN'.padEnd(8)} ${'AGENT'.padEnd(7)} ${'FILES'.padEnd(5)}  SNAPSHOT TAKEN`));
  for (const m of rows) {
    const t = m.step ? `t${m.turn}.${m.step}` : `t${m.turn}`;
    const why = [...(m.reasons || []),
      ...(m.remoteDb && m.remoteDb.length ? [`remote DB ${m.remoteDb.join(', ')}: not undoable`] : []),
      ...(m.outsideDb ? ['outside/local DB: not undoable'] : [])];
    const danger = m.dangerous || why.length ? c('31', ` ⚠ dangerous${why.length ? ` (${why.join('; ')})` : ''}`) : '';
    const scope = m.outOfScope ? c('33', ' ⚠ out-of-scope') : '';
    console.log(`${String(m.id).padEnd(5)} ${t.padEnd(7)} ${ago(m.ts).padEnd(8)} ${String(m.agent || '-').padEnd(7)} ${String(m.changed == null ? '-' : m.changed).padEnd(5)}  ${m.dangerous ? c('1', label(m)) : label(m)}${danger}${scope}${m.receipt ? (m.receipt.status === 'green' ? c('32', ' ✓ tests passed') : c('31', ` ✗ tests ${m.receipt.status === 'blocked' ? 'failed (agent sent back)' : 'failed'}`)) : ''}${m.skipped && m.skipped.length ? c('33', ` (${m.skipped.length} big file(s) not saved)`) : ''}`);
  }
  if (pool.length > rows.length) console.log(c('2', `(${pool.length - rows.length} older; --all to show)`));
  const g = s.lastGreen();
  if (g) console.log(c('32', `Last snapshot where tests passed (agentreceipt): #${g.id}  ->  agentundo restore ${g.id}`));
  console.log(c('2', 'FILES = files changed since the previous snapshot. Restore with: agentundo restore <id>'));
}

function diff() {
  const s = storeOrDie();
  if (!positional[0]) die('usage: agentundo diff <id> [--patch] [-- <paths>]');
  const m = s.resolve(positional[0]);
  const cur = s.currentTree();
  const spec = pathsArg.length ? ['--', ...pathsArg.map((p) => `:(literal)${p}`)] : [];
  const out = s.git(['diff', '--no-renames', flag('--patch') ? '-p' : '--stat=120', m.tree, cur.tree, ...spec]);
  console.log(`snapshot #${m.id} (${label(m)}) -> working tree now`);
  process.stdout.write(out || 'no differences\n');
}

// Read-only: lists added/modified/deleted files (with line counts) for a turn or since a snapshot.
// Never snapshots, never touches hooks or the user's .git; `--batches` only prints a suggested order.
function changes() {
  const C = require('../src/changes');
  const s = storeOrDie();
  let g;
  try { g = C.gather(s, positional[0]); } catch (e) { die(e.message); }
  const r = C.summarize(g.entries, g.stats, g.fromTops);
  const o = { title: g.title, batches: flag('--batches') };
  if (flag('--json')) return console.log(C.renderJson(r, { root: s.root, from: g.from.id, title: g.title }));
  process.stdout.write(flag('--md') ? C.renderMarkdown(r, o) : C.renderText(r, o));
}

async function doRestore() {
  const s = storeOrDie();
  if (!positional[0]) die('usage: agentundo restore <id> [--dry-run] [--yes] [-- <paths>]');
  const m = s.resolve(positional[0]);
  journalNotice(s);
  const plan = planRestore(s, m, pathsArg);
  console.log(`Restore snapshot #${m.id} (t${m.turn}${m.step ? '.' + m.step : ''}, ${label(m)}, ${ago(m.ts)})${pathsArg.length ? ' for ' + pathsArg.join(', ') : ''}`);
  const show = (list, tag) => { for (const p of list.slice(0, 15)) console.log(`  ${tag} ${p}`); if (list.length > 15) console.log(`  … ${list.length - 15} more`); };
  console.log(`  ${plan.write.length} file(s) to write back, ${plan.remove.length} file(s) to remove`);
  show(plan.write, c('32', '+/~')); show(plan.remove, c('31', '  -'));
  if (m.skipped && m.skipped.length) console.log(c('33', `  note: not in this snapshot (over size cap): ${m.skipped.join(', ')}`));
  if (plan.keptUncaptured.length) console.log(c('2', `  kept (not captured by that snapshot: ignored/excluded/too big): ${plan.keptUncaptured.slice(0, 5).join(', ')}${plan.keptUncaptured.length > 5 ? ', …' : ''}`));
  if (!plan.write.length && !plan.remove.length && !fs.existsSync(s.journal)) return console.log('Nothing to do: the working tree already matches.');
  if (flag('--dry-run')) return console.log('(dry run, nothing changed)');
  if (movedFlags.length) console.log(c('2', `  note: treating ${movedFlags.join(' ')} after -- as option(s), not paths`));
  if (!(await confirm('Proceed? Your current state is snapshotted first, so this can be undone. [y/N] '))) { console.log('Cancelled, nothing changed.'); process.exitCode = 1; return; }
  let r;
  try { r = await restore(s, m, { paths: pathsArg, log: (x) => console.log(x) }); } catch (e) {
    die(`restore failed: ${e.message}`);
  }
  if (r.interrupted) {
    console.log(c('33', `Interrupted after ${r.done} change(s). Re-run \`agentundo restore ${m.id}\` to finish, or \`agentundo restore ${r.pre.id}\` to go back.`));
    process.exitCode = 130; return;
  }
  console.log(c('32', `Restored #${m.id}: wrote ${r.written}, removed ${r.removed}.`));
  console.log(`Undo this restore: agentundo restore ${r.pre.id}`);
}

function snap() {
  const json = flag('--json');
  try {
    const s = new Store(projectRoot());
    const r = s.snapshot({ event: 'manual', note: opt('--label', positional.join(' ')) || 'manual snapshot' });
    if (json) return console.log(JSON.stringify({ ok: true, id: r.snap.id, created: r.created, turn: r.snap.turn, warnings: r.warnings }));
    console.log(r.created ? `snapshot #${r.snap.id}` : `no changes since #${r.snap.id}`);
    for (const w of r.warnings) console.log(c('33', w));
  } catch (e) { if (json) { console.log(JSON.stringify({ ok: false, error: e.message })); return; } throw e; }
}

// Machine interface for agentreceipt (stable; schemaVersion 1). Always exits 0 with one JSON line.
//   agentundo receipt --status green|red|blocked [--receipt <file name>] --json
// Snapshots the verified state (no new snapshot if nothing changed), records the receipt status on
// it, and returns the newest green snapshot so a red receipt can offer "go back to when tests passed".
function receipt() {
  const out = (o) => console.log(JSON.stringify({ schemaVersion: 1, ...o }));
  try {
    const status = opt('--status');
    if (!['green', 'red', 'blocked'].includes(status)) return out({ ok: false, error: '--status must be green, red or blocked' });
    const root = I.findProject(process.cwd());
    if (!root) return out({ ok: false, reason: 'not-initialized' });
    const s = new Store(root);
    const r = s.snapshot({ event: 'receipt', note: `agentreceipt: tests ${status === 'green' ? 'passed' : 'failed'}` });
    s.mark(r.snap.id, { status, receipt: opt('--receipt') || null, ts: new Date().toISOString() });
    const g = status === 'green' ? r.snap : s.lastGreen(r.snap.id);
    const cli = path.join(homeDir(), 'bin', 'agentundo').replace(require('os').homedir(), '~');
    out({ ok: true, snapshotId: r.snap.id, created: r.created, lastGreenSnapshotId: g ? g.id : null,
      restoreCommand: status !== 'green' && g ? `${cli} restore ${g.id}` : null, warnings: r.warnings });
  } catch (e) { out({ ok: false, error: e.message }); }
}

function status() {
  const root = projectRoot();
  const s = new Store(root);
  const reg = I.readRegistry();
  console.log(`agentundo ${I.VERSION}`);
  console.log(`project: ${s.root} ${reg.includes(s.root) ? c('32', '(hooks active)') : c('33', '(not initialised; run init)')}`);
  if (!s.exists()) return;
  journalNotice(s);
  const all = s.meta();
  const size = s.sizeBytes();
  const over = size > s.cfg.maxTotalMB * MB;
  console.log(`snapshots: ${all.length}${all.length ? ` (#${all[0].id}..#${all[all.length - 1].id}, last ${ago(all[all.length - 1].ts)})` : ''}`);
  console.log(`storage: ${(size / MB).toFixed(1)}MB of ${s.cfg.maxTotalMB}MB cap${over ? c('31', '  OVER CAP') : ''} at ${s.dir}`);
  console.log(`per-file cap: ${s.cfg.maxFileMB}MB; .env files: ${s.cfg.includeEnv ? 'included' : 'not snapshotted'}`);
  const codex = (() => { try { return JSON.stringify(I.readJsonStrict(I.codexHooksPath())).includes('agentundo-hook'); } catch { return false; } })();
  const claude = (() => { try { return JSON.stringify(I.readJsonStrict(I.claudeSettingsPath(s.root))).includes('agentundo-hook') || JSON.stringify(I.readJsonStrict(I.claudeSettingsPath(s.root, 'user'))).includes('agentundo-hook'); } catch { return false; } })();
  console.log(`hooks: codex ${codex ? 'yes' : 'no'}, claude ${claude ? 'yes' : 'no'}`);
  const e = s.lastError();
  console.log(`last failure: ${e || 'none'}`);
}

function prune() {
  const s = storeOrDie();
  const keep = Number(opt('--keep', NaN));
  if (!(keep >= 1)) die('usage: agentundo prune --keep <n>');
  console.log(`removed ${s.prune({ keep })} snapshot(s)`);
}

async function uninstall() {
  const global = flag('--global');
  const purge = flag('--purge');
  const reg = I.readRegistry();
  const here = new Store(projectRoot()).root;
  const targets = global ? [...new Set([...reg, ...(reg.includes(here) ? [] : [])])] : [here];
  const missing = targets.filter((p) => !fs.existsSync(p));
  for (const p of missing) console.error(c('33', `warning: registered project ${p} no longer exists; skipping its project files (hooks/exclude), cleaning up agentundo's own data only`));
  // Extra store dirs --purge also removes: older/legacy copies of the targets' stores (e.g. marked superseded)
  // and, with --global, every other store dir left in agentundo's own stores dir (orphans). Only entries of
  // <home>/stores named like a store (16 hex chars) are ever considered; nothing outside it is touched.
  let extras = [];
  if (purge) {
    const own = targets.map((p) => new Store(p).dir);
    const set = new Set();
    for (const p of targets) for (const d of relatedStoreDirs(p, process.env, own)) set.add(d);
    if (global) for (const d of allStoreDirs()) if (!own.includes(d)) set.add(d);
    extras = [...set].sort();
    const stores = targets.map((p) => new Store(p)).filter((s) => s.exists());
    if (stores.length || extras.length) {
      console.log('--purge will permanently delete the snapshots of:');
      for (const s of stores) console.log(`  ${s.root} (${s.meta().length} snapshots, ${(s.sizeBytes() / MB).toFixed(1)}MB)`);
      for (const d of extras) { const i = storeInfo(d); console.log(`  ${i.superseded ? 'older superseded' : 'orphaned'} store ${d}${i.root ? ` (was ${i.root})` : ''} (${i.snapshots} snapshots)`); }
      if (!(await confirm('Delete these snapshots? [y/N] '))) { console.log('Cancelled, nothing changed.'); process.exitCode = 1; return; }
    }
  }
  const failed = [];
  // Removes a store dir that must sit directly inside <home>/stores. A symlinked entry is unlinked, never followed.
  const removeStoreDir = (d) => {
    if (path.dirname(d) !== storesDir()) { failed.push(`${d}: not inside ${storesDir()}, refusing to delete`); return false; }
    try {
      const st = fs.lstatSync(d);
      if (st.isSymbolicLink()) fs.unlinkSync(d);
      else {
        // Rename first: if the stores dir is not writable this fails before anything inside is deleted.
        const gone = /\.deleting-\d+$/.test(d) ? d : `${d}.deleting-${process.pid}`;
        if (gone !== d) fs.renameSync(d, gone);
        fs.rmSync(gone, { recursive: true, force: true });
      }
    } catch (e) { if (e.code !== 'ENOENT') { failed.push(`${d}: ${e.code || e.message}`); return false; } }
    if (fs.existsSync(d)) { failed.push(`${d}: still exists after delete`); return false; }
    return true;
  };
  const summary = [];
  let remaining = reg;
  for (const root of targets) {
    const res = { root, deleted: [], kept: [] };
    if (missing.includes(root)) res.kept.push('project directory is gone (skipped project files)');
    else for (const scope of ['local', 'user']) {
      try { const f = I.uninstallHook({ agent: 'claude', root, scope }); if (f) res.deleted.push(`Claude hooks in ${f}`); } catch (e) { res.kept.push(`${e.message}`); }
    }
    if (!missing.includes(root)) try { if (I.removeExcludes(root)) res.deleted.push('.git/info/exclude block'); } catch {}
    const s = new Store(root);
    if (s.exists() || fs.existsSync(s.dir)) {
      if (purge) { if (removeStoreDir(s.dir)) res.deleted.push(`snapshots (${s.dir})`); else res.kept.push(`snapshots in ${s.dir} (could not delete, see below)`); }
      else res.kept.push(`snapshots in ${s.dir} (restore still works: agentundo restore <id>; delete with --purge)`);
    }
    remaining = I.unregisterProject(root);
    summary.push(res);
  }
  if (extras.length) {
    const res = { root: '(older/orphaned snapshot stores)', deleted: [], kept: [] };
    for (const d of extras) { if (removeStoreDir(d)) res.deleted.push(d); else res.kept.push(`${d} (could not delete, see below)`); }
    summary.push(res);
  }
  if (purge) { try { fs.rmdirSync(storesDir()); } catch {} } // only if now empty
  if (!remaining.length) {
    try { const f = I.uninstallHook({ agent: 'codex', root: here }); if (f) summary.push({ root: '(global)', deleted: [`Codex hooks in ${f}`], kept: [] }); } catch (e) { summary.push({ root: '(global)', deleted: [], kept: [e.message] }); }
    I.removeRuntime();
    summary.push({ root: '(global)', deleted: [`hook runtime ${path.join(homeDir(), 'bin')}, ${path.join(homeDir(), 'runtime')}`], kept: [] });
    try { const h = homeDir(); const left = fs.readdirSync(h).filter((x) => x !== 'backups'); if (!left.length) fs.rmSync(h, { recursive: true, force: true }); } catch {}
  } else summary.push({ root: '(global)', deleted: [], kept: [`Codex hook + runtime (still used by ${remaining.length} other project(s))`] });
  for (const r of summary) {
    console.log(c('1', r.root));
    for (const d of r.deleted) console.log(`  deleted: ${d}`);
    for (const k of r.kept) console.log(`  kept:    ${k}`);
    if (!r.deleted.length && !r.kept.length) console.log('  nothing to remove');
  }
  if (missing.length) console.log(`done, with ${missing.length} missing project(s) skipped (see warnings above)`);
  if (failed.length) {
    console.error(c('31', `agentundo: --purge could not delete ${failed.length} snapshot store(s):`));
    for (const f of failed) console.error(`  ${f}`);
    console.error(`Fix the permissions (e.g. chmod u+w ${storesDir()}) and re-run \`agentundo uninstall${global ? ' --global' : ''} --purge\`.`);
    process.exitCode = 1;
  }
}

main().catch((e) => die(e.message));
