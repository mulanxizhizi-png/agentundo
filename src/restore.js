'use strict';
// Restore a snapshot into the working tree.
// 1. snapshot the current state first ("pre-restore"), so every restore can be undone;
// 2. write a journal; 3. check the needed files out into a temp dir inside the project and
// rename each into place (each file is replaced atomically); 4. delete files the target lacks.
// Ctrl+C stops between files; the journal stays and re-running the same restore completes it.
const fs = require('fs');
const path = require('path');

function planRestore(store, target, paths = []) {
  const cur = store.currentTree();
  const changes = store.changes(cur.tree, target.tree, paths);
  return {
    write: changes.filter((c) => c.status !== 'D').map((c) => c.path), // A/M/T: (re)create from target
    remove: changes.filter((c) => c.status === 'D').map((c) => c.path), // in current, not in target
    skippedNow: cur.skipped,
  };
}

function rmIfNotDir(p) { try { const st = fs.lstatSync(p); if (!st.isDirectory()) fs.unlinkSync(p); } catch {} }
function ensureParent(root, rel) {
  const parts = rel.split('/').slice(0, -1);
  let cur = root;
  for (const seg of parts) { cur = path.join(cur, seg); rmIfNotDir(cur); }
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
}
function pruneEmptyDirs(root, rel) {
  let d = path.dirname(rel);
  while (d && d !== '.') { try { fs.rmdirSync(path.join(root, d)); } catch { break; } d = path.dirname(d); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

async function restore(store, target, { paths = [], log = () => {} } = {}) {
  let journal = null;
  try { journal = JSON.parse(fs.readFileSync(store.journal, 'utf8')); } catch {}
  let pre;
  if (journal && journal.target === target.id && JSON.stringify(journal.paths || []) === JSON.stringify(paths)) {
    pre = store.resolve(String(journal.pre)); // resuming an interrupted restore: keep the original undo point
    log(`resuming interrupted restore of #${target.id}`);
  } else {
    pre = store.snapshot({ event: 'restore', note: `before restore of #${target.id}` }, { force: true }).snap;
  }
  fs.writeFileSync(store.journal, JSON.stringify({ target: target.id, pre: pre.id, paths, started: new Date().toISOString() }));

  const { write, remove } = planRestore(store, target, paths);
  let interrupted = false;
  const onSig = () => { interrupted = true; };
  process.on('SIGINT', onSig); process.on('SIGTERM', onSig);
  const tmp = path.join(store.root, `.agentundo-tmp-${process.pid}`);
  const delay = Number(process.env.AGENTUNDO_TEST_DELAY_MS || 0);
  const restoreIndex = path.join(store.dir, 'restore-index');
  try {
    if (write.length) {
      store.git(['read-tree', target.tree], { index: restoreIndex });
      fs.rmSync(tmp, { recursive: true, force: true });
      store.git(['checkout-index', '-f', '-z', '--stdin', `--prefix=${tmp}/`], { index: restoreIndex, input: write.join('\0') + '\0' });
    }
    let done = 0;
    for (const rel of write) {
      if (interrupted) break;
      const dest = path.join(store.root, rel);
      ensureParent(store.root, rel);
      try { const st = fs.lstatSync(dest); if (st.isDirectory()) fs.rmSync(dest, { recursive: true, force: true }); } catch {}
      fs.renameSync(path.join(tmp, rel), dest);
      done++;
      await (delay ? sleep(delay) : tick());
    }
    for (const rel of remove) {
      if (interrupted) break;
      try { fs.unlinkSync(path.join(store.root, rel)); } catch (e) { if (e.code === 'EISDIR' || e.code === 'EPERM') fs.rmSync(path.join(store.root, rel), { recursive: true, force: true }); }
      pruneEmptyDirs(store.root, rel);
      done++;
      await (delay ? sleep(delay) : tick());
    }
    if (interrupted) return { interrupted: true, pre, written: write.length, removed: remove.length, done };
    fs.rmSync(store.journal, { force: true });
    return { interrupted: false, pre, written: write.length, removed: remove.length };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(restoreIndex, { force: true });
    process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig);
  }
}

module.exports = { restore, planRestore };
