/**
 * Periodic SQLite backup — copies the DB file every 5 minutes and keeps the last 20.
 */

const fs = require('fs');
const path = require('path');
const { db, DB_PATH, DATA_DIR, getConfig, setConfig } = require('./db');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const LOGO_DIR = path.join(DATA_DIR, 'logos');
const INTERVAL_MS = 5 * 60 * 1000;
const KEEP = 20;
const ARCHIVE_KEEP = 10;
const MODES = new Set(['auto', 'manual']);
let initialTimer = null;
let intervalTimer = null;
let started = false;

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

async function backupOnce() {
  if (!fs.existsSync(DB_PATH)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(BACKUP_DIR, `tournament-${stamp}.db`);
  await db.backup(target);
  // prune oldest
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.db'))
    .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const extra of files.slice(KEEP)) {
    fs.unlinkSync(path.join(BACKUP_DIR, extra.f));
  }
  return target;
}

async function safeBackupOnce() {
  try {
    await backupOnce();
  } catch (err) {
    console.error('[backup] error:', err.message);
  }
}

function copyDir(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function pruneArchiveDirs() {
  const dirs = fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('archive-'))
    .map(entry => {
      const fullPath = path.join(BACKUP_DIR, entry.name);
      return { name: entry.name, fullPath, t: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.t - a.t);
  for (const extra of dirs.slice(ARCHIVE_KEEP)) {
    fs.rmSync(extra.fullPath, { recursive: true, force: true });
  }
}

function normalizeMode(mode) {
  return mode === 'manual' ? 'manual' : 'auto';
}

function getMode() {
  return normalizeMode(getConfig('backup_mode', 'auto'));
}

function getStatus() {
  const mode = getMode();
  return {
    mode,
    automatic: mode === 'auto',
    intervalMinutes: INTERVAL_MS / 60000,
    backupDir: BACKUP_DIR,
  };
}

function clearTimers() {
  if (initialTimer) clearTimeout(initialTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  initialTimer = null;
  intervalTimer = null;
}

function scheduleAutoBackups() {
  clearTimers();
  initialTimer = setTimeout(() => { void safeBackupOnce(); }, 10_000);
  intervalTimer = setInterval(() => { void safeBackupOnce(); }, INTERVAL_MS);
}

function applyMode({ log = false } = {}) {
  const status = getStatus();
  if (status.mode === 'auto') {
    scheduleAutoBackups();
    if (log) console.log(`[backup] auto every ${status.intervalMinutes} minutes -> ${BACKUP_DIR}`);
  } else {
    clearTimers();
    if (log) console.log(`[backup] manual mode -> ${BACKUP_DIR}`);
  }
  return status;
}

function setMode(mode) {
  if (!MODES.has(mode)) throw new Error('Backup mode must be auto or manual.');
  setConfig('backup_mode', mode);
  if (started) return applyMode({ log: true });
  return getStatus();
}

async function archiveOnce() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetDir = path.join(BACKUP_DIR, `archive-${stamp}`);
  fs.mkdirSync(targetDir, { recursive: true });
  await db.backup(path.join(targetDir, 'tournament.db'));
  copyDir(LOGO_DIR, path.join(targetDir, 'logos'));
  fs.writeFileSync(
    path.join(targetDir, 'manifest.json'),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      database: 'tournament.db',
      logos: fs.existsSync(LOGO_DIR) ? 'logos/' : null,
    }, null, 2)
  );
  pruneArchiveDirs();
  return targetDir;
}

function start() {
  if (started) return getStatus();
  started = true;
  return applyMode({ log: true });
}

module.exports = { start, backupOnce, archiveOnce, getMode, setMode, getStatus, BACKUP_DIR };
