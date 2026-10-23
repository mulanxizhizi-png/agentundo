'use strict';
const fs = require('fs');
// Hook entry for Codex and Claude Code (PreToolUse + UserPromptSubmit).
// Contract: always exit 0, never print anything that could be read as a decision; failures are
// logged and surfaced as a systemMessage so the user knows a snapshot was missed.
const path = require('path');
const { Store } = require('./store');
const { findProject } = require('./install');
const { cannotUndo, analyze, remoteWarning, redact } = require('./danger');
const { pathsFromTool, checkScope, scopeWarning, normalizeAllowPaths } = require('./scope');

const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'Task', 'Agent', 'ExitPlanMode', 'BashOutput', 'KillShell', 'NotebookRead', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'view_image', 'update_plan', 'web_search']);

const PATCH_RE = /^\s*\*\*\* Begin Patch/;
function describePatch(text) {
  const files = [...text.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((m) => `${m[1].toLowerCase()} ${path.basename(m[2].trim())}`);
  return `apply_patch: ${files.join(', ') || 'patch'}`;
}
function describeCommand(tool, cmd) {
  if (typeof cmd === 'string') return PATCH_RE.test(cmd) || tool === 'apply_patch' ? describePatch(cmd) : cmd;
  if (Array.isArray(cmd)) {
    const a = cmd.map(String);
    if (a.length === 3 && /(^|\/)(ba|z|da)?sh$/.test(a[0]) && /^-l?c$/.test(a[1])) return describeCommand(tool, a[2]); // ["bash","-lc","<script>"]
    if (a.length >= 2 && a[0] === 'apply_patch' && PATCH_RE.test(a[a.length - 1])) return describePatch(a[a.length - 1]);
    return a.join(' ');
  }
  return null;
}

// Turns a PreToolUse tool_input into the command text agentundo analyzes and stores. Accepts every
// shape seen from Claude Code and Codex: { command: "..." } (Claude Bash, Codex shell), { command: [argv] },
// { cmd: "..." } (Codex exec_command), { input: "*** Begin Patch..." } (Codex apply_patch), or a plain
// string (freeform/custom tools: a patch, a command, or JSON-encoded arguments).
function describe(tool, input) {
  if (typeof input === 'string') {
    const t = input.trim();
    if (t.startsWith('{')) { try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) return describe(tool, o); } catch {} }
    if (PATCH_RE.test(input) || tool === 'apply_patch') return describePatch(input);
    return t ? input : tool;
  }
  if (Array.isArray(input)) return describeCommand(tool, input) || tool;
  input = input && typeof input === 'object' ? input : {};
  for (const k of ['command', 'cmd']) {
    const d = describeCommand(tool, input[k]);
    if (d) return d;
  }
  for (const k of ['input', 'patch']) {
    const v = input[k];
    if (typeof v === 'string' && (tool === 'apply_patch' || PATCH_RE.test(v))) return describePatch(v);
  }
  if (input.file_path || input.notebook_path) return `${tool} ${input.file_path || input.notebook_path}`;
  return tool;
}

function handle(payload, agent, env = process.env) {
  const cwd = payload.cwd || process.cwd();
  const root = findProject(cwd, env);
  if (!root) return null; // Codex hooks are global; projects without agentundo are ignored
  // The registered project dir was deleted (agent ran from a stale cwd): nothing to snapshot. Stay calm, never block.
  if (!fs.existsSync(root)) return 'agentundo: project directory no longer exists, skipped snapshot';
  const event = payload.hook_event_name;
  const store = new Store(root, env);
  const turnKey = payload.turn_id || payload.prompt_id || null;
  let label;
  if (event === 'UserPromptSubmit') label = { event: 'turn', agent, session: payload.session_id, turnKey, command: null };
  else if (event === 'PreToolUse') {
    const tool = payload.tool_name || 'tool';
    if (READ_ONLY.has(tool)) return null;
    label = { event: 'tool', agent, session: payload.session_id, turnKey, tool, command: describe(tool, payload.tool_input) };
    // allowPaths scope guard (default off): mark out-of-scope writes for list + warn-only message.
    const allow = normalizeAllowPaths(store.cfg);
    if (allow.length) {
      try {
        const touched = pathsFromTool(tool, payload.tool_input, label.command);
        const scope = checkScope(touched, allow, store.root, cwd);
        if (scope.outOfScope) {
          label.outOfScope = true;
          label.outOfScopePaths = scope.outOfScopePaths;
          label.outOfScopeTotal = scope.outOfScopeTotal;
        }
      } catch {}
    }
  } else return null;
  const msgs = [];
  let a = { dangerous: false, reasons: [], remote: [] };
  try { if (label.command) a = analyze(label.command); } catch {}
  // Remote DB first: it is the one thing a local snapshot can never undo.
  if (a.remote.length) msgs.push(remoteWarning(a.remote));
  try {
    const r = store.snapshot(label);
    msgs.push(...r.warnings);
    if (a.dangerous && r.snap) msgs.push(`agentundo: ⚠ ${a.reasons.join(', ')} — saved snapshot #${r.snap.id} first. Undo: agentundo restore ${r.snap.id}`);
    if (label.outOfScope) msgs.push(scopeWarning(label.outOfScopePaths, r.snap && r.snap.id, label.outOfScopeTotal));
  } catch (e) {
    store.logError(`${event}: ${e.message}`);
    msgs.push(`agentundo: snapshot FAILED, this step is not undoable (${e.message.slice(0, 200)}). Details: agentundo status`);
  }
  if (label.command && !a.remote.length && cannotUndo(label.command, store.root, { cwd, maxFileMB: store.cfg.maxFileMB, excluded: (p) => store.defaultExcluded(p) })) msgs.push(`agentundo: heads-up, this command may change things outside the project (databases, remote, other folders); a local snapshot can't undo that.`);
  return msgs.length ? redact(msgs.join('\n')) : null;
}

async function main(agent) {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
    const payload = JSON.parse(raw || '{}');
    const msg = handle(payload, agent);
    if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
  } catch (e) {
    try { process.stderr.write(`agentundo hook error: ${e.message}\n`); } catch {}
  }
  process.exitCode = 0;
}

module.exports = { main, handle, describe };
