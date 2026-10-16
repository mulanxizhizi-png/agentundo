'use strict';
// Commands worth flagging in `list`, and commands whose damage a local snapshot can't undo.
const DANGEROUS = [
  /\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+/, /\brm\s+--recursive\b/, /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bgit\s+checkout\s+(--\s+)?\.(\s|$)/, /\bgit\s+restore\s+(--\s+)?\./, /\bgit\s+push\s+.*(--force|-f\b)/, /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+(table\s+)?\w/i, /\bdelete\s+from\b/i, /\bfind\b.*\s-delete\b/, /\bmkfs\b/, /\bdd\s+.*\bof=/, /\bshred\b/,
  /\bprisma\s+migrate\s+reset\b/, /\bmv\s+.*\s\/dev\/null\b/, /\bchmod\s+-R\b/, /\b(rimraf|del-cli)\b/, /\*\*\* Delete File:/, /^apply_patch: .*\bdelete\b/,
];
const UNDOABLE_OUTSIDE = [
  /\b(psql|mysql|mongo(sh)?|redis-cli|sqlcmd)\b/, /\bdrop\s+(table|database|schema)\b/i, /\btruncate\s+(table\s+)?\w/i,
  /\bprisma\s+migrate\s+reset\b/, /\bdiskutil\b/, /\bgit\s+push\b/, /\b(aws|gcloud|az|kubectl|terraform)\s/, /\bcurl\b.*-X\s*(DELETE|POST|PUT)/,
];
function isDangerous(cmd) { return DANGEROUS.some((re) => re.test(cmd)); }
// Absolute paths outside the project (and not system tool paths) => local snapshot can't help.
function outsideProject(cmd, root) {
  if (!/\b(rm|mv|cp|truncate|shred|dd|chmod|chown|>)\b|>/.test(cmd)) return false;
  const paths = cmd.match(/(?:^|\s|=)(~\/[^\s;&|]*|\/[^\s;&|]+)/g) || [];
  return paths.map((p) => p.trim().replace(/^=/, '')).some((p) => {
    if (p.startsWith('~')) return true;
    if (/^\/(dev|tmp|proc|usr\/bin|bin)\b/.test(p)) return false;
    return !(p === root || p.startsWith(root + '/'));
  });
}
function cannotUndo(cmd, root) { return UNDOABLE_OUTSIDE.some((re) => re.test(cmd)) || outsideProject(cmd, root); }
module.exports = { isDangerous, cannotUndo };
