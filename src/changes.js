'use strict';
// `agentundo changes`: read-only summary of what a turn (or everything since a snapshot) added / modified / deleted.
// Path rules only: no LLM, no network, no git writes. All functions here are pure except `gather`, which only reads the snapshot store.

const DEP_NAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bun.lockb', 'bun.lock',
  'pipfile', 'pipfile.lock', 'poetry.lock', 'pyproject.toml', 'setup.py', 'setup.cfg', 'uv.lock', 'pdm.lock', 'environment.yml',
  'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'gradle.lockfile', 'mix.exs', 'mix.lock', 'pubspec.yaml', 'pubspec.lock',
  'package.swift', 'package.resolved', 'podfile', 'podfile.lock', 'flake.nix', 'flake.lock', 'deno.json', 'deno.lock',
]);
const CONFIG_NAMES = new Set([
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', '.dockerignore', 'makefile', 'justfile', 'procfile',
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc', '.node-version', '.python-version', '.tool-versions', '.babelrc',
  'tsconfig.json', 'jsconfig.json', 'vercel.json', 'netlify.toml', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'nginx.conf', 'tox.ini', 'pytest.ini', 'mypy.ini',
]);
const CONFIG_RE = [/^\.env(\..*)?$/i, /^tsconfig\..*\.json$/i, /\.config\.(js|cjs|mjs|ts|cts|mts|json)$/i, /^\.(eslint|prettier|stylelint|babel|mocharc|npmrc|swcrc)[a-z]*(\..*)?$/i, /\.(ini|cfg|conf|toml)$/i];
const CONFIG_DIRS = new Set(['.github', '.vscode', '.circleci', '.gitlab', '.husky', 'config', 'configs', '.config', '.devcontainer']);
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', '__mocks__', 'fixtures']);
const TEST_RE = [/\.(test|spec)\.[a-z0-9]+$/i, /^test_.*\.py$/i, /_test\.(py|go|rb|rs|exs)$/i, /Tests?\.(java|kt|cs|swift)$/];
const DOC_EXT = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const DOC_NAMES = /^(readme|license|licence|changelog|contributing|authors|notice|history|progress|todo)(\..*)?$/i;
const DOC_DIRS = new Set(['docs', 'doc', 'documentation']);
const ENTRY_RE = /^(index|main|app|server|cli|__main__|manage|wsgi|asgi|serve|worker)\.[a-z0-9]+$/i;

const CATEGORIES = [
  { key: 'deps', title: '依赖与锁文件' },
  { key: 'config', title: '配置文件' },
  { key: 'source', title: '核心源码' },
  { key: 'test', title: '测试' },
  { key: 'docs', title: '文档' },
];
// Suggested review order (each file lands in exactly one batch, so the batches always add up to all changed files).
const BATCHES = [
  { title: '配置 / 依赖', keys: ['deps', 'config'] },
  { title: '核心源码', keys: ['source'] },
  { title: '测试', keys: ['test'] },
  { title: '文档', keys: ['docs'] },
];

function classify(p) {
  const segs = p.split('/');
  const base = segs[segs.length - 1];
  const lower = base.toLowerCase();
  const dirs = segs.slice(0, -1).map((x) => x.toLowerCase());
  if (dirs.some((d) => TEST_DIRS.has(d)) || TEST_RE.some((r) => r.test(base))) return 'test';
  if (DEP_NAMES.has(lower) || /^requirements.*\.(txt|in)$/i.test(base)) return 'deps';
  if (dirs.some((d) => CONFIG_DIRS.has(d)) || CONFIG_NAMES.has(lower) || CONFIG_RE.some((r) => r.test(base))) return 'config';
  if (dirs.some((d) => DOC_DIRS.has(d)) || DOC_EXT.test(base) || DOC_NAMES.test(base)) return 'docs';
  return 'source';
}

// entries: [{status:'A'|'M'|'D'|'T', path}], stats: { path: {add,del,binary} }, fromTops: Set of top-level dirs present before.
function summarize(entries, stats, fromTops) {
  const files = entries.map((e) => {
    const st = stats[e.path] || { add: 0, del: 0, binary: false };
    const kind = e.status === 'A' ? 'added' : e.status === 'D' ? 'deleted' : 'modified';
    const segs = e.path.split('/');
    const flags = [];
    if (kind === 'added') {
      if (segs.length > 1 && !fromTops.has(segs[0])) flags.push('新增顶层目录');
      if (segs.length <= 3 && ENTRY_RE.test(segs[segs.length - 1])) flags.push('新增入口文件');
    }
    return { path: e.path, kind, category: classify(e.path), add: st.add, del: st.del, binary: st.binary, flags };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const count = (k) => files.filter((f) => f.kind === k).length;
  const totals = {
    files: files.length, added: count('added'), modified: count('modified'), deleted: count('deleted'),
    add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0), binary: files.filter((f) => f.binary).length,
  };
  const newDirs = [...new Set(files.filter((f) => f.flags.includes('新增顶层目录')).map((f) => f.path.split('/')[0]))].sort();
  const batches = BATCHES.map((b) => ({ title: b.title, files: files.filter((f) => b.keys.includes(f.category)) })).filter((b) => b.files.length);
  return { files, totals, newDirs, batches };
}

const summaryLine = (t) => `${t.added} 个新增 · ${t.modified} 个修改 · ${t.deleted} 个删除 · +${t.add}/−${t.del} 行${t.binary ? `（含 ${t.binary} 个二进制文件，不计行数）` : ''}`;
const KIND = { added: '新增', modified: '修改', deleted: '删除' };
const num = (f) => (f.binary ? '二进制' : `+${f.add}/−${f.del}`);
const note = (f) => [KIND[f.kind] === '修改' ? '' : KIND[f.kind], ...f.flags].filter(Boolean).join(' · ');
function codeSpan(s) { const run = (s.match(/`+/g) || []).reduce((m, x) => Math.max(m, x.length), 0); const f = '`'.repeat(run + 1); return `${f}${run ? ' ' : ''}${s}${run ? ' ' : ''}${f}`; }

// ---- text ----
function renderText(r, { title, batches }) {
  const { files, totals } = r;
  const out = [title, summaryLine(totals)];
  if (!files.length) return [title, '没有文件变化。'].join('\n') + '\n';
  const row = (f) => `  ${num(f).padEnd(10)} ${f.path}${note(f) ? `   [${note(f)}]` : ''}`;
  if (batches) {
    out.push('', '建议分批顺序（只是建议；agentundo 不会改动 git 或提交任何东西）：');
    r.batches.forEach((b, i) => { out.push('', `第 ${i + 1} 批 · ${b.title}（${b.files.length} 个文件）`); for (const f of b.files) out.push(row(f)); });
    out.push('', `共 ${totals.files} 个文件 = ${r.batches.map((b) => b.files.length).join(' + ')}（各批合计，不多不漏）`);
    return out.join('\n') + '\n';
  }
  const hi = [];
  if (r.newDirs.length) hi.push(`新增顶层目录：${r.newDirs.join(', ')}`);
  const entries = files.filter((f) => f.flags.includes('新增入口文件'));
  if (entries.length) hi.push(`新增入口文件：${entries.map((f) => f.path).join(', ')}`);
  if (totals.added) hi.push(`新增文件：${totals.added} 个`);
  const dels = files.filter((f) => f.kind === 'deleted');
  if (dels.length) hi.push(`删除文件：${dels.length} 个`);
  const dep = files.filter((f) => f.category === 'deps');
  if (dep.length) hi.push(`依赖与锁文件有变化：${dep.map((f) => f.path).join(', ')}`);
  const cfg = files.filter((f) => f.category === 'config');
  if (cfg.length) hi.push(`配置文件有变化：${cfg.map((f) => f.path).join(', ')}`);
  if (hi.length) { out.push('', '需要留意（容易让人迷失）：'); for (const h of hi) out.push(`  ! ${h}`); }
  for (const cat of CATEGORIES) {
    const list = files.filter((f) => f.category === cat.key);
    if (!list.length) continue;
    out.push('', `${cat.title}（${list.length}）`);
    for (const f of list) out.push(row(f));
  }
  out.push('', '提示：`agentundo changes --batches` 给出建议分批；`--md` 输出可粘贴的 Markdown。');
  return out.join('\n') + '\n';
}

// ---- markdown ----
function renderMarkdown(r, { title, batches }) {
  const { files, totals } = r;
  const out = [`### ${title}`, '', `**${summaryLine(totals)}**`];
  if (!files.length) return [`### ${title}`, '', '没有文件变化。'].join('\n') + '\n';
  const item = (f) => `- ${codeSpan(f.path)} — ${f.binary ? '二进制' : `+${f.add}/−${f.del}`}${f.kind === 'modified' ? '' : `（${KIND[f.kind]}）`}${f.flags.length ? ` ⚠ ${f.flags.join('、')}` : ''}`;
  if (batches) {
    out.push('', '建议分批（仅建议，未改动 git）：');
    r.batches.forEach((b, i) => { out.push('', `#### 第 ${i + 1} 批 · ${b.title}（${b.files.length}）`, ''); for (const f of b.files) out.push(item(f)); });
    return out.join('\n') + '\n';
  }
  for (const cat of CATEGORIES) {
    const list = files.filter((f) => f.category === cat.key);
    if (!list.length) continue;
    out.push('', `#### ${cat.title}（${list.length}）`, '');
    for (const f of list) out.push(item(f));
  }
  return out.join('\n') + '\n';
}

function renderJson(r, extra) {
  return JSON.stringify({ schemaVersion: 1, ...extra, totals: r.totals, files: r.files, batches: r.batches.map((b) => ({ title: b.title, files: b.files.map((f) => f.path) })) });
}

// Read-only: resolves the range and reads the shadow store. `spec` = undefined (latest turn) | "tN" | snapshot id.
// Returns { title, from, to, entries, stats, fromTops } or throws Error with a plain message.
function gather(store, spec) {
  const all = store.meta();
  if (!all.length) throw new Error('no snapshots yet; nothing to compare. (Run `agentundo init` first, then let the agent work.)');
  const s = spec == null ? '' : String(spec).trim();
  let from; let toTree; let toLabel; let title;
  const turnMatch = /^t(\d+)$/i.exec(s);
  if (turnMatch || !s) {
    // Latest turn the store knows about (a turn can exist in state without any snapshot yet, e.g. the agent edited
    // files without running a command; its start is then the newest earlier snapshot, same rule as `restore tN`).
    const maxTurn = Math.max(0, Number(store.state().turn) || 0, ...all.map((m) => m.turn));
    const n = turnMatch ? Number(turnMatch[1]) : maxTurn;
    if (n < 1 && turnMatch) throw new Error('turns start at t1 (see `agentundo list`)');
    if (n > maxTurn) throw new Error(`no turn ${n} yet; latest is t${maxTurn} (see \`agentundo list\`)`);
    from = all.find((m) => m.turn === n && m.event === 'turn') || [...all].reverse().find((m) => m.turn < n) || all.find((m) => m.turn === n) || all[0];
    const next = all.find((m) => m.turn > n && m.event === 'turn') || all.find((m) => m.turn > n);
    if (next) { toTree = next.tree; toLabel = `第 ${next.turn} 轮开始时`; } else { toTree = store.currentTree().tree; toLabel = '当前工作区'; }
    title = n < 1 ? `快照 #${from.id} 之后的变化（→ ${toLabel}）` : `第 ${n} 轮的变化（快照 #${from.id} → ${toLabel}）`;
  } else {
    from = store.resolve(s);
    toTree = store.currentTree().tree;
    title = `快照 #${from.id} 之后的变化（→ 当前工作区）`;
  }
  const entries = from.tree === toTree ? [] : store.changes(from.tree, toTree);
  const stats = entries.length ? store.numstat(from.tree, toTree) : {};
  const fromTops = new Set(store.git(['ls-tree', '--name-only', '-z', from.tree]).split('\0').filter(Boolean));
  return { title, from, entries, stats, fromTops };
}

module.exports = { gather, summarize, classify, renderText, renderMarkdown, renderJson, summaryLine, CATEGORIES, BATCHES };
