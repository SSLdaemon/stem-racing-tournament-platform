#!/usr/bin/env node

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function isNativeAbiMismatch(err) {
  const message = String(err?.message || err || '');
  return err?.code === 'ERR_DLOPEN_FAILED'
    && message.includes('NODE_MODULE_VERSION');
}

function ensureBetterSqlite3() {
  try {
    require('better-sqlite3');
    return;
  } catch (err) {
    if (!isNativeAbiMismatch(err)) throw err;
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    console.warn('[bootstrap] Detected a Node.js/native module mismatch. Rebuilding better-sqlite3...');
    execFileSync(npmBin, ['rebuild', 'better-sqlite3'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    require('better-sqlite3');
  }
}

try {
  ensureBetterSqlite3();
  require(path.join(ROOT, 'server'));
} catch (err) {
  console.error('[bootstrap] Unable to start the tournament platform.');
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
