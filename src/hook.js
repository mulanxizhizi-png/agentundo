'use strict';
// Hook entry for Codex and Claude Code (PreToolUse + UserPromptSubmit).
// Contract: always exit 0, never print anything that could be read as a decision; failures are
// logged and surfaced as a systemMessage so the user knows a snapshot was missed.
const path = require('path');
const { Store } = require('./store');
const { findProject } = require('./install');
const { cannotUndo, analyze, remoteWarning, redact } = require('./danger');

const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'Task', 'Agent', 'ExitPlanMode', 'BashOutput', 'KillShell', 'NotebookRead', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'view_image', 'update_plan', 'web_search']);

function describe(tool, input) {
  input = input || {};
  if (typeof input.command === 'string') {
    if (/^\*\*\* Begin Patch/.test(input.command) || tool === 'apply_patch') {
      const files = [...input.command.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((m) => `${m[1].toLowerCase()} ${path.basename(m[2].trim())}`);
      return `apply_patch: ${files.join(', ') || 'patch'}`;
    }
    return input.command;
  }
  if (Array.isArray(input.command)) {
    const a = input.command;
    if (a.length === 3 && /(^|\/)(ba|z|da)?sh$/.test(a[0]) && /^-l?c$/.test(a[1])) return a[2]; // ["bash","-lc","<script>"]
    return a.join(' ');
  }
  if (input.file_path || input.notebook_path) return `${tool} ${input.file_path || input.notebook_path}`;
  return tool;
}

function handle(payload, agent, env = process.env) {
  const cwd = payload.cwd || process.cwd();
  const root = findProject(cwd, env);
  if (!root) return null; // Codex hooks are global; projects without agentundo are ignored
  const event = payload.hook_event_name;
  const store = new Store(root, env);
  const turnKey = payload.turn_id || payload.prompt_id || null;
  let label;
  if (event === 'UserPromptSubmit') label = { event: 'turn', agent, session: payload.session_id, turnKey, command: null };
  else if (event === 'PreToolUse') {
    const tool = payload.tool_name || 'tool';
    if (READ_ONLY.has(tool)) return null;
    label = { event: 'tool', agent, session: payload.session_id, turnKey, tool, command: describe(tool, payload.tool_input) };
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
  } catch (e) {
    store.logError(`${event}: ${e.message}`);
    msgs.push(`agentundo: snapshot FAILED, this step is not undoable (${e.message.slice(0, 200)}). Details: agentundo status`);
  }
  if (label.command && !a.remote.length && cannotUndo(label.command, store.root)) msgs.push(`agentundo: heads-up, this command may change things outside the project (databases, remote, other folders); a local snapshot can't undo that.`);
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
