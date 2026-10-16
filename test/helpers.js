'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const BIN = path.join(__dirname, '..', 'bin', 'agentundo.js');

function freshEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'au-env-'));
  const env = { ...process.env, AGENTUNDO_HOME: path.join(base, 'home'), CODEX_HOME: path.join(base, 'codex'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), NO_COLOR: '1' };
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
  return env;
}
function tmpProject(files = {}, { git = true } = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'au-proj-')));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  if (git) {
    const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: d, stdio: 'ignore' });
    g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init', '--allow-empty');
  }
  return d;
}
function run(env, cwd, args, opts = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', input: opts.input ?? '', timeout: 120000 });
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
}
function hook(env, cwd, payload, agent = 'claude') {
  const r = spawnSync(process.execPath, [BIN, 'hook', '--agent', agent], { cwd, env, encoding: 'utf8', input: JSON.stringify({ cwd, ...payload }) });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const bash = (env, cwd, command, extra = {}) => hook(env, cwd, { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command }, ...extra });
const prompt = (env, cwd, id, extra = {}) => hook(env, cwd, { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt_id: id, prompt: 'x', ...extra });

// Map of relative path -> sha256/symlink target/mode, for byte-exact comparisons (skips .git).
function fingerprint(root) {
  const out = {};
  const walk = (dir) => {
    for (const n of fs.readdirSync(dir)) {
      if (n === '.git' && dir === root) continue;
      const p = path.join(dir, n); const rel = path.relative(root, p); const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = 'link:' + fs.readlinkSync(p);
      else if (st.isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') + ':' + (st.mode & 0o111 ? 'x' : '-');
    }
  };
  walk(root);
  return out;
}
const gitOut = (cwd, ...a) => { const e = { ...process.env }; delete e.GIT_DIR; delete e.GIT_INDEX_FILE; delete e.GIT_WORK_TREE; return execFileSync('git', a, { cwd, encoding: 'utf8', env: e }); };
module.exports = { BIN, freshEnv, tmpProject, run, hook, bash, prompt, fingerprint, gitOut };
