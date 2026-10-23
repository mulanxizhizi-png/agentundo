'use strict';
// allowPaths scope guard: warn (never block) when a tool would write outside the declared globs.
const path = require('path');
const os = require('os');
const { lex } = require('./danger');

const WRITE_MUTATORS = new Set([
  'rm', 'unlink', 'mv', 'cp', 'truncate', 'shred', 'dd', 'chmod', 'chown',
  'mkdir', 'touch', 'install', 'ln', 'tee', 'rmdir',
]);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const PATCH_FILE_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;

// Simple glob → RegExp: supports **, *, ? (no brace expansion). Patterns use /.
function globToRegExp(pattern) {
  const g = String(pattern || '').replace(/\\/g, '/').replace(/^\.\//, '');
  let s = '';
  let i = 0;
  while (i < g.length) {
    if (g.startsWith('**/', i)) { s += '(?:.*/)?'; i += 3; continue; }
    if (g.startsWith('**', i)) { s += '.*'; i += 2; continue; }
    if (g[i] === '*') { s += '[^/]*'; i++; continue; }
    if (g[i] === '?') { s += '[^/]'; i++; continue; }
    const ch = g[i++];
    if (/[|\\{}()[\]^$+.]/.test(ch)) s += '\\' + ch;
    else s += ch;
  }
  return new RegExp('^' + s + '$');
}

function matchGlob(relPath, pattern) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const pat = String(pattern || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!pat) return false;
  try { return globToRegExp(pat).test(rel); } catch { return false; }
}

function unwrap(words) {
  const WRAPPERS = new Set(['sudo', 'doas', 'env', 'time', 'nice', 'nohup', 'command', 'exec', 'builtin', 'stdbuf', 'ionice', 'timeout', 'xargs', 'unbuffer', 'npx', 'bunx']);
  let i = 0;
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    if (i >= words.length) return { prog: null, args: [] };
    const p = words[i].replace(/^.*\//, '');
    if (!WRAPPERS.has(p)) break;
    i++;
    while (i < words.length && words[i].startsWith('-')) i++;
    if (p === 'timeout' && i < words.length && /^\d/.test(words[i])) i++;
  }
  return { prog: words[i].replace(/^.*\//, ''), args: words.slice(i + 1) };
}

function pathsFromPatch(text) {
  const out = [];
  PATCH_FILE_RE.lastIndex = 0;
  let m;
  while ((m = PATCH_FILE_RE.exec(String(text || ''))) !== null) out.push(m[2].trim());
  return out;
}

function pathsFromBash(cmd, depth = 0) {
  if (depth > 4) return [];
  const paths = [];
  let toks;
  try { toks = lex(String(cmd || '')); } catch { return []; }
  let words = [];
  const flush = () => {
    if (!words.length) return;
    const { prog, args } = unwrap(words);
    words = [];
    if (!prog) return;
    if (SHELLS.has(prog)) {
      for (let i = 0; i < args.length; i++) {
        if (/^-l?c$/.test(args[i]) && args[i + 1]) {
          paths.push(...pathsFromBash(args[i + 1], depth + 1));
          return;
        }
      }
      return;
    }
    if (prog === 'dd') {
      for (const a of args) {
        const m = /^of=(.*)$/.exec(a);
        if (m) paths.push(m[1]);
      }
      return;
    }
    if (prog === 'tee') {
      for (const a of args) if (a !== '-' && !a.startsWith('-')) paths.push(a);
      return;
    }
    if (!WRITE_MUTATORS.has(prog)) return;
    for (const a of args) {
      if (a !== '-' && a.startsWith('-')) continue;
      paths.push(a);
    }
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.op) { flush(); continue; }
    if (t.redir) {
      if (words.length && /^\d+$/.test(words[words.length - 1])) words.pop();
      const target = (toks[i + 1] && toks[i + 1].w) || '';
      if (toks[i + 1] && toks[i + 1].w) i++;
      if (t.redir.includes('>') && !t.redir.includes('<')
          && target && target !== '/dev/null' && !/^&?\d+$/.test(target)) {
        paths.push(target);
      }
      continue;
    }
    if (t.w) words.push(t.w);
  }
  flush();
  return paths;
}

function isShellTool(tool) {
  return /^(Bash|bash|shell|exec_command)$/.test(tool || '');
}

function pathsFromTool(tool, input, command) {
  const paths = [];
  const add = (p) => { if (p && typeof p === 'string') paths.push(p); };
  const lookPatch = (v) => {
    if (typeof v === 'string' && /^\s*\*\*\* Begin Patch/.test(v)) paths.push(...pathsFromPatch(v));
  };
  const lookBash = (v) => {
    if (typeof v === 'string' && !/^\s*\*\*\* Begin Patch/.test(v)) paths.push(...pathsFromBash(v));
  };

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    add(input.file_path);
    add(input.notebook_path);
    for (const k of ['input', 'patch', 'command', 'cmd']) lookPatch(input[k]);
    if (isShellTool(tool) || tool === 'apply_patch') {
      /* patch already scanned; shell commands below */
    }
    if (isShellTool(tool)) {
      for (const k of ['command', 'cmd']) {
        const v = input[k];
        if (typeof v === 'string') lookBash(v);
        else if (Array.isArray(v)) {
          const a = v.map(String);
          if (a.length === 3 && /(^|\/)(ba|z|da)?sh$/.test(a[0]) && /^-l?c$/.test(a[1])) lookBash(a[2]);
          else if (a.length >= 2 && a[0] === 'apply_patch') lookPatch(a[a.length - 1]);
        }
      }
    }
  } else if (typeof input === 'string') {
    lookPatch(input);
    if (isShellTool(tool)) lookBash(input);
  }

  if (tool === 'apply_patch' && typeof command === 'string') lookPatch(command);
  if (isShellTool(tool) && typeof command === 'string' && !paths.length) lookBash(command);

  if (!paths.length && typeof command === 'string') {
    const m = /^(Write|Edit|NotebookEdit|MultiEdit|Delete)\s+(.+)$/.exec(command);
    if (m) add(m[2]);
  }
  return [...new Set(paths.filter(Boolean))];
}

function resolvePath(p, root, cwd) {
  if (!p || p === '-') return null;
  if (p.startsWith('~/') || p === '~') {
    return path.resolve(os.homedir(), p === '~' ? '' : p.slice(2));
  }
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve(cwd || root, p);
}

function classifyPath(abs, root) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { outside: true, display: abs };
  }
  return { outside: false, rel: rel.split(path.sep).join('/'), display: rel.split(path.sep).join('/') };
}

function checkScope(rawPaths, allowPaths, root, cwd) {
  if (!Array.isArray(allowPaths) || allowPaths.length === 0) {
    return { outOfScope: false, outOfScopePaths: [] };
  }
  const patterns = allowPaths.filter((p) => typeof p === 'string' && p.length);
  if (!patterns.length) return { outOfScope: false, outOfScopePaths: [] };

  const bad = [];
  for (const raw of rawPaths || []) {
    const abs = resolvePath(raw, root, cwd);
    if (!abs) continue;
    const { outside, rel, display } = classifyPath(abs, root);
    if (outside || !patterns.some((pat) => matchGlob(rel, pat))) bad.push(display);
  }
  const uniq = [...new Set(bad)];
  return { outOfScope: uniq.length > 0, outOfScopePaths: uniq.slice(0, 5), outOfScopeTotal: uniq.length };
}

function scopeWarning(outOfScopePaths, snapId, total) {
  const list = (outOfScopePaths || []).slice(0, 5);
  const extra = (total && total > list.length) ? ` (and ${total - list.length} more)` : '';
  const paths = list.join(', ') + extra || '(unknown path)';
  const restore = snapId != null ? ` Saved snapshot #${snapId}. Undo: agentundo restore ${snapId}` : '';
  return `agentundo: ⚠ out-of-scope: ${paths} — not in allowPaths (warn only, not blocked).${restore}\n（越界路径，只提醒不拦）`;
}

function normalizeAllowPaths(cfg) {
  if (!cfg || !Array.isArray(cfg.allowPaths)) return [];
  return cfg.allowPaths.filter((p) => typeof p === 'string' && p.length);
}

module.exports = {
  matchGlob, globToRegExp, pathsFromPatch, pathsFromBash, pathsFromTool,
  checkScope, scopeWarning, normalizeAllowPaths, resolvePath,
};
