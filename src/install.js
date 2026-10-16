'use strict';
// Hook installation, adapted from agentreceipt: stable shim in ~/.agentundo/bin, versioned runtime,
// Codex hooks in ~/.codex/hooks.json, Claude hooks in .claude/settings.local.json, local git
// ignores inside a marked block in .git/info/exclude, a registry of projects.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { homeDir, realRoot } = require('./store');

const PKG_ROOT = path.resolve(__dirname, '..');
const VERSION = require('../package.json').version;
const STATUS_MESSAGE = 'agentundo: snapshot';
const EVENTS = ['PreToolUse', 'UserPromptSubmit'];
const HOOK_TIMEOUT = 60;

function shQuote(v) { return `'${String(v).replace(/'/g, `'\\''`)}'`; }
function shimPath(env = process.env) { return path.join(homeDir(env), 'bin', 'agentundo-hook'); }

function installRuntime(env = process.env) {
  const base = path.join(homeDir(env), 'runtime');
  const dest = path.join(base, VERSION);
  for (const d of ['bin', 'src']) {
    fs.mkdirSync(path.join(dest, d), { recursive: true });
    for (const f of fs.readdirSync(path.join(PKG_ROOT, d))) fs.copyFileSync(path.join(PKG_ROOT, d, f), path.join(dest, d, f));
  }
  fs.copyFileSync(path.join(PKG_ROOT, 'package.json'), path.join(dest, 'package.json'));
  for (const v of fs.readdirSync(base)) if (v !== VERSION) fs.rmSync(path.join(base, v), { recursive: true, force: true });
  const target = path.join(dest, 'bin', 'agentundo.js');
  const p = shimPath(env);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Fail open even if node or the runtime vanished: never block the agent.
  fs.writeFileSync(p, `#!/bin/sh\n# agentundo hook shim (rewritten by \`agentundo init\`)\n${shQuote(process.execPath)} ${shQuote(target)} hook --agent "\${1:-codex}" 2>>${shQuote(path.join(homeDir(env), 'hook-errors.log'))}\nexit 0\n`);
  fs.chmodSync(p, 0o755);
  // Convenience CLI next to the shim.
  const cli = path.join(homeDir(env), 'bin', 'agentundo');
  fs.writeFileSync(cli, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(target)} "$@"\n`);
  fs.chmodSync(cli, 0o755);
  return p;
}

function readJsonStrict(p) {
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  if (!text.trim()) return {};
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error(`${p} is not valid JSON (${e.message}). Fix or move it, then re-run; nothing was changed.`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${p} is not a JSON object; nothing was changed.`);
  if (doc.hooks !== undefined && (typeof doc.hooks !== 'object' || Array.isArray(doc.hooks) || doc.hooks === null)) throw new Error(`${p}: "hooks" is not an object; nothing was changed.`);
  for (const ev of EVENTS) if (doc.hooks && doc.hooks[ev] !== undefined && !Array.isArray(doc.hooks[ev])) throw new Error(`${p}: "hooks.${ev}" is not an array; nothing was changed.`);
  return doc;
}

const MANAGED = /^'(?:[^']|'\\'')*agentundo-hook' (codex|claude)$/;
function isManaged(h) { return !!h && h.type === 'command' && h.statusMessage === STATUS_MESSAGE && typeof h.command === 'string' && MANAGED.test(h.command); }
function hookCommand(shim, agent) { return `${shQuote(shim)} ${agent}`; }

function upsertHooks(doc, command) {
  doc.hooks = doc.hooks || {};
  for (const ev of EVENTS) {
    const groups = (doc.hooks[ev] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isManaged(h)) })).filter((g) => g.hooks.length);
    groups.push({ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT, statusMessage: STATUS_MESSAGE }] });
    doc.hooks[ev] = groups;
  }
  return doc;
}
function removeHooks(doc) {
  if (!doc.hooks) return doc;
  for (const ev of EVENTS) {
    if (!doc.hooks[ev]) continue;
    doc.hooks[ev] = doc.hooks[ev].map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isManaged(h)) })).filter((g) => g.hooks.length);
    if (!doc.hooks[ev].length) delete doc.hooks[ev];
  }
  if (!Object.keys(doc.hooks).length) delete doc.hooks;
  return doc;
}

function codexHooksPath(env = process.env) { return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'); }
function claudeSettingsPath(root, scope = 'local', env = process.env) {
  if (scope === 'user') return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  return path.join(root, '.claude', 'settings.local.json');
}
function targetFile(agent, root, scope, env) { return agent === 'codex' ? codexHooksPath(env) : claudeSettingsPath(root, scope, env); }

function backupFile(file, env = process.env) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(homeDir(env), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${path.resolve(file).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '')}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
  fs.copyFileSync(file, dest);
  return dest;
}
function writeJson(file, doc, env) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backupFile(file, env);
  const tmp = `${file}.agentundo-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// ---- .git/info/exclude marked block ----
const BLOCK_START = '# >>> agentundo (managed; removed by `agentundo uninstall`)';
const BLOCK_END = '# <<< agentundo';
function cleanGitEnv() { const e = { ...process.env }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k]; return e; }
function excludePath(root) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], env: cleanGitEnv() }).toString().trim();
    return path.join(path.resolve(root, common), 'info', 'exclude');
  } catch { return null; }
}
function splitBlock(text) {
  const lines = text.split('\n');
  const i = lines.indexOf(BLOCK_START);
  const j = i >= 0 ? lines.indexOf(BLOCK_END, i + 1) : -1;
  if (i < 0 || j < 0) return [lines, null, []];
  return [lines.slice(0, i), lines.slice(i + 1, j), lines.slice(j + 1)];
}
function addExcludes(root, entries) {
  const ex = excludePath(root);
  if (!ex) return false;
  fs.mkdirSync(path.dirname(ex), { recursive: true });
  const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
  const [before, block, after] = splitBlock(cur);
  const merged = [...new Set([...(block || []), ...entries])];
  let head = before.join('\n');
  if (block === null) head = head.replace(/\n*$/, '');
  fs.writeFileSync(ex, [head ? head + '\n' : '', [BLOCK_START, ...merged, BLOCK_END].join('\n') + '\n', after.join('\n').replace(/^\n+/, '')].join(''));
  return true;
}
function removeExcludes(root) {
  const ex = excludePath(root);
  if (!ex || !fs.existsSync(ex)) return false;
  const [before, block, after] = splitBlock(fs.readFileSync(ex, 'utf8'));
  if (block === null) return false;
  const out = [...before, ...after].join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  fs.writeFileSync(ex, out === '\n' ? '' : out);
  return true;
}
const REPO_EXCLUDES = ['.agentundo-tmp-*/'];

// ---- registry ----
function registryPath(env = process.env) { return path.join(homeDir(env), 'projects.json'); }
function readRegistry(env = process.env) {
  try { const r = JSON.parse(fs.readFileSync(registryPath(env), 'utf8')); return Array.isArray(r.projects) ? r.projects : []; } catch { return []; }
}
function writeRegistry(list, env = process.env) {
  const p = [...new Set(list)].sort();
  if (!p.length) { fs.rmSync(registryPath(env), { force: true }); return; }
  fs.mkdirSync(homeDir(env), { recursive: true });
  const tmp = registryPath(env) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ projects: p }, null, 2) + '\n');
  fs.renameSync(tmp, registryPath(env));
}
function registerProject(root, env = process.env) { writeRegistry([...readRegistry(env), realRoot(root)], env); }
function unregisterProject(root, env = process.env) { const r = realRoot(root); const rest = readRegistry(env).filter((p) => p !== r); writeRegistry(rest, env); return rest; }
// The registered project that contains `cwd` (deepest match).
function findProject(cwd, env = process.env) {
  const c = realRoot(cwd);
  return readRegistry(env).filter((p) => c === p || c.startsWith(p.endsWith('/') ? p : p + '/')).sort((a, b) => b.length - a.length)[0] || null;
}

function install({ agent, root, scope = 'local', env = process.env }) {
  const file = targetFile(agent, root, scope, env);
  const doc = readJsonStrict(file);
  if (agent === 'claude' && scope === 'local') addExcludes(root, ['.claude/settings.local.json']);
  writeJson(file, upsertHooks(doc, hookCommand(shimPath(env), agent)), env);
  return file;
}
function uninstallHook({ agent, root, scope = 'local', env = process.env }) {
  const file = targetFile(agent, root, scope, env);
  if (!fs.existsSync(file)) return null;
  const original = readJsonStrict(file);
  const before = JSON.stringify(original);
  const doc = removeHooks(JSON.parse(before));
  if (JSON.stringify(doc) === before) return null;
  if (!Object.keys(doc).length) {
    backupFile(file, env); fs.unlinkSync(file);
    if (agent === 'claude' && scope !== 'user') { try { fs.rmdirSync(path.dirname(file)); } catch {} }
  } else writeJson(file, doc, env);
  return file;
}
function removeRuntime(env = process.env) {
  const home = homeDir(env);
  fs.rmSync(path.join(home, 'runtime'), { recursive: true, force: true });
  fs.rmSync(path.join(home, 'bin'), { recursive: true, force: true });
  fs.rmSync(path.join(home, 'hook-errors.log'), { force: true });
}

module.exports = { VERSION, STATUS_MESSAGE, EVENTS, shQuote, shimPath, installRuntime, readJsonStrict, isManaged, upsertHooks, removeHooks,
  codexHooksPath, claudeSettingsPath, targetFile, install, uninstallHook, removeRuntime, addExcludes, removeExcludes, excludePath,
  REPO_EXCLUDES, BLOCK_START, BLOCK_END, readRegistry, writeRegistry, registerProject, unregisterProject, findProject, registryPath };
