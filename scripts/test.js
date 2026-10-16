#!/usr/bin/env node
// Runs the test suite with a dedicated TMPDIR and removes it afterwards,
// so test temp dirs never pile up in the system /tmp.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const base = process.env.TEST_TMP_BASE || path.join(path.dirname(root), '.test-tmp', path.basename(root));
fs.mkdirSync(base, { recursive: true });
const dir = fs.mkdtempSync(path.join(base, 'run-'));
const files = fs.readdirSync(path.join(root, 'test'))
  .filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
const args = ['--test', ...process.argv.slice(2), ...files];
const res = spawnSync(process.execPath, args, {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir },
});
if (!process.env.KEEP_TEST_TMP) fs.rmSync(dir, { recursive: true, force: true });
process.exit(res.status == null ? 1 : res.status);
