#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { Store, homeDir, MB } = require('../src/store');
const I = require('../src/install');
const { restore, planRestore } = require('../src/restore');

const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const args = dd >= 0 ? argv.slice(0, dd) : argv;
const pathsArg = dd >= 0 ? argv.slice(dd + 1) : [];
const cmd = args[0];
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const positional = args.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && ['--agent', '--limit', '--keep', '--claude-scope', '--only'].includes(arr[i - 1])));
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
const label = (m) => (m.event === 'turn' ? 'turn start' : m.event === 'restore' ? (m.note || 'before restore') : m.event === 'manual' ? (m.note || 'manual snapshot') : `before ${m.command || m.tool}`);
const ago = (ts) => { const s = (Date.now() - Date.parse(ts)) / 1000; return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };

async function main() {
  switch (cmd) {
    case 'hook': return require('../src/hook').main(opt('--agent', 'codex'));
    case 'init': return init();
    case 'list': case 'ls': return list();
    case 'diff': return diff();
    case 'restore': return doRestore();
    case 'status': return status();
    case 'snap': case 'snapshot': return snap();
    case 'prune': return prune();
    case 'uninstall': return uninstall();
    case '-v': case '--version': case 'version': return console.log(I.VERSION);
    default: return help();
  }
}

function help() {
  console.log(`agentundo ${I.VERSION} - an undo button for coding agents (Codex, Claude Code)

  agentundo init [--agent codex|claude] [--claude-scope local|user]
  agentundo list [--limit 20]            snapshots: id, turn, what it ran before
  agentundo diff <id> [--patch] [-- <paths>]   snapshot vs. working tree
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
  const all = s.meta();
  const lim = flag('--all') ? all.length : Number(opt('--limit', 20));
  const rows = all.slice(-lim);
  if (!rows.length) return console.log('no snapshots yet');
  console.log(c('2', `${'ID'.padEnd(5)} ${'TURN'.padEnd(7)} ${'WHEN'.padEnd(8)} ${'AGENT'.padEnd(7)} ${'FILES'.padEnd(5)}  SNAPSHOT TAKEN`));
  for (const m of rows) {
    const t = m.step ? `t${m.turn}.${m.step}` : `t${m.turn}`;
    const danger = m.dangerous ? c('31', ' ⚠ dangerous') : '';
    console.log(`${String(m.id).padEnd(5)} ${t.padEnd(7)} ${ago(m.ts).padEnd(8)} ${String(m.agent || '-').padEnd(7)} ${String(m.changed == null ? '-' : m.changed).padEnd(5)}  ${m.dangerous ? c('1', label(m)) : label(m)}${danger}${m.skipped && m.skipped.length ? c('33', ` (${m.skipped.length} big file(s) not saved)`) : ''}`);
  }
  if (all.length > rows.length) console.log(c('2', `(${all.length - rows.length} older; --all to show)`));
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
  if (!plan.write.length && !plan.remove.length && !fs.existsSync(s.journal)) return console.log('Nothing to do: the working tree already matches.');
  if (flag('--dry-run')) return console.log('(dry run, nothing changed)');
  if (!(await confirm('Proceed? Your current state is snapshotted first, so this can be undone. [y/N] '))) { console.log('Cancelled, nothing changed.'); return; }
  const r = await restore(s, m, { paths: pathsArg, log: (x) => console.log(x) });
  if (r.interrupted) {
    console.log(c('33', `Interrupted after ${r.done} change(s). Re-run \`agentundo restore ${m.id}\` to finish, or \`agentundo restore ${r.pre.id}\` to go back.`));
    process.exitCode = 130; return;
  }
  console.log(c('32', `Restored #${m.id}: wrote ${r.written}, removed ${r.removed}.`));
  console.log(`Undo this restore: agentundo restore ${r.pre.id}`);
}

function snap() {
  const s = new Store(projectRoot());
  const r = s.snapshot({ event: 'manual', note: positional.join(' ') || 'manual snapshot' });
  console.log(r.created ? `snapshot #${r.snap.id}` : `no changes since #${r.snap.id}`);
  for (const w of r.warnings) console.log(c('33', w));
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
  if (purge) {
    const stores = targets.map((p) => new Store(p)).filter((s) => s.exists());
    if (stores.length) {
      console.log('--purge will permanently delete the snapshots of:');
      for (const s of stores) console.log(`  ${s.root} (${s.meta().length} snapshots, ${(s.sizeBytes() / MB).toFixed(1)}MB)`);
      if (!(await confirm('Delete these snapshots? [y/N] '))) { console.log('Cancelled, nothing changed.'); return; }
    }
  }
  const summary = [];
  let remaining = reg;
  for (const root of targets) {
    const res = { root, deleted: [], kept: [] };
    for (const scope of ['local', 'user']) {
      try { const f = I.uninstallHook({ agent: 'claude', root, scope }); if (f) res.deleted.push(`Claude hooks in ${f}`); } catch (e) { res.kept.push(`${e.message}`); }
    }
    try { if (I.removeExcludes(root)) res.deleted.push('.git/info/exclude block'); } catch {}
    const s = new Store(root);
    if (s.exists() || fs.existsSync(s.dir)) {
      if (purge) { fs.rmSync(s.dir, { recursive: true, force: true }); res.deleted.push(`snapshots (${s.dir})`); }
      else res.kept.push(`snapshots in ${s.dir} (restore still works: agentundo restore <id>; delete with --purge)`);
    }
    remaining = I.unregisterProject(root);
    summary.push(res);
  }
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
}

main().catch((e) => die(e.message));
