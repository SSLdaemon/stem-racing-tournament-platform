/**
 * Portable tournament backup ZIP creation and restore helpers.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');
const { db, DB_PATH, DATA_DIR, getConfig } = require('./db');

const BACKUP_TYPE = 'f1-stem-racing-backup';
const BACKUP_VERSION = 1;
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const LOGO_DIR = path.join(DATA_DIR, 'logos');

const TABLE_COLUMNS = {
  teams: ['id', 'name', 'school', 'color', 'logo_path', 'created_at'],
  matches: [
    'id', 'match_number', 'stage', 'round', 'group_index', 'bracket_slot',
    'depends_on', 'bonus', 'team_a_id', 'team_b_id', 'time_a', 'time_b',
    'winner_team_id', 'completed', 'completed_at',
  ],
  group_assignments: ['team_id', 'group_index'],
  settings: ['key', 'value'],
  history: ['id', 'action', 'payload', 'created_at'],
};

function ensureDirs() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.mkdirSync(LOGO_DIR, { recursive: true });
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function safeSlug(value) {
  const slug = String(value || 'tournament')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'tournament';
}

function validateZipEntryName(name) {
  const entryName = String(name || '');
  if (
    !entryName
    || entryName.includes('\0')
    || entryName.includes('\\')
    || entryName.startsWith('/')
    || /^[a-z]:/i.test(entryName)
    || entryName.split('/').includes('..')
  ) {
    throw new Error(`Invalid backup entry path: ${entryName || '(empty)'}`);
  }
  return entryName;
}

function addDirectoryToZip(zip, sourceDir, zipRoot) {
  if (!fs.existsSync(sourceDir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const fullPath = path.join(sourceDir, entry.name);
    const zipName = `${zipRoot}/${entry.name}`;
    validateZipEntryName(zipName);
    if (entry.isDirectory()) {
      count += addDirectoryToZip(zip, fullPath, zipName);
    } else if (entry.isFile()) {
      zip.addFile(zipName, fs.readFileSync(fullPath));
      count++;
    }
  }
  return count;
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

function replaceDir(source, target) {
  const swapTarget = `${target}.restore-${process.pid}-${Date.now()}`;
  const oldTarget = `${target}.old-${process.pid}-${Date.now()}`;
  fs.rmSync(swapTarget, { recursive: true, force: true });
  copyDir(source, swapTarget);
  fs.rmSync(oldTarget, { recursive: true, force: true });
  if (fs.existsSync(target)) fs.renameSync(target, oldTarget);
  fs.renameSync(swapTarget, target);
  fs.rmSync(oldTarget, { recursive: true, force: true });
}

function emptyDir(target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

function readTournamentNameFromDb(dbPath) {
  let restoredDb;
  try {
    restoredDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = restoredDb.prepare(`SELECT value FROM settings WHERE key = 'tournament_name'`).get();
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
  } catch {
    return null;
  } finally {
    if (restoredDb) restoredDb.close();
  }
}

function makeManifest({ includeLogos, createdAt = new Date(), tournamentName = null }) {
  return {
    type: BACKUP_TYPE,
    version: BACKUP_VERSION,
    createdAt: createdAt.toISOString(),
    app: 'f1-stem-racing-tournament',
    tournamentName: tournamentName || getConfig('tournament_name') || 'F1 in Schools Championship',
    database: 'tournament.db',
    sections: {
      logos: !!includeLogos,
    },
  };
}

function zipDatabaseFile({ dbPath, includeLogos = false, logosDir = LOGO_DIR, tournamentName = null, filename = null }) {
  const createdAt = new Date();
  const zip = new AdmZip();
  const manifest = makeManifest({ includeLogos, createdAt, tournamentName });
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile('tournament.db', fs.readFileSync(dbPath));
  if (includeLogos) addDirectoryToZip(zip, logosDir, 'logos');
  const safeName = safeSlug(manifest.tournamentName);
  return {
    filename: filename || `${safeName}-backup-${timestampForFile(createdAt)}.zip`,
    buffer: zip.toBuffer(),
    manifest,
  };
}

async function createBackupZip({ includeLogos = true } = {}) {
  ensureDirs();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-backup-create-'));
  try {
    const dbCopy = path.join(tmpDir, 'tournament.db');
    await db.backup(dbCopy);
    return zipDatabaseFile({
      dbPath: dbCopy,
      includeLogos: !!includeLogos,
      logosDir: LOGO_DIR,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseManifest(zip) {
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) throw new Error('Backup manifest.json is missing.');
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch {
    throw new Error('Backup manifest.json is not valid JSON.');
  }
  if (manifest.type !== BACKUP_TYPE) throw new Error('Backup file is not a STEM Racing backup.');
  if (manifest.version !== BACKUP_VERSION) throw new Error('Backup version is not supported.');
  if (manifest.database !== 'tournament.db') throw new Error('Backup manifest points to an unsupported database path.');
  return manifest;
}

function parseBackupJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid backup ${label}.`);
  }
}

function assertText(value, label, { max, required = false } = {}) {
  if (value == null) {
    if (required) throw new Error(`Invalid backup ${label}.`);
    return;
  }
  if (typeof value !== 'string' || value.length > max || (required && value.trim() === '')) {
    throw new Error(`Invalid backup ${label}.`);
  }
}

function assertInteger(value, label, { min = null, nullable = false } = {}) {
  if (value == null && nullable) return;
  if (!Number.isInteger(value) || (min != null && value < min)) {
    throw new Error(`Invalid backup ${label}.`);
  }
}

function assertFlag(value, label) {
  if (!(value === 0 || value === 1)) throw new Error(`Invalid backup ${label}.`);
}

function assertRaceTime(value, label) {
  if (value == null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 300) {
    throw new Error(`Invalid backup ${label}.`);
  }
}

function logoFilenameFromPath(logoPath) {
  if (logoPath == null || logoPath === '') return null;
  if (typeof logoPath !== 'string' || !logoPath.startsWith('/logos/')) {
    throw new Error('Invalid backup team logo path.');
  }
  const filename = logoPath.slice('/logos/'.length);
  if (
    !filename
    || filename.includes('/')
    || filename.includes('\\')
    || filename.includes('\0')
    || filename.includes('..')
    || !/\.(png|jpe?g)$/i.test(filename)
  ) {
    throw new Error('Invalid backup team logo path.');
  }
  return filename;
}

function validateSettings(rows, matchNumbers) {
  const settings = new Map();
  for (const row of rows) {
    assertText(row.key, 'setting key', { max: 80, required: true });
    assertText(row.value, 'setting value', { max: 1000, required: true });
    settings.set(row.key, parseBackupJson(row.value, `setting ${row.key}`));
  }

  assertText(settings.get('tournament_name'), 'tournament name setting', { max: 200, required: true });
  if (!['registration', 'running', 'finished'].includes(settings.get('tournament_state'))) {
    throw new Error('Invalid backup tournament state setting.');
  }
  if (!['idle', 'intro', 'lights', 'racing', 'result', 'finished'].includes(settings.get('race_screen_mode'))) {
    throw new Error('Invalid backup race screen mode setting.');
  }
  if (settings.has('backup_mode') && !['auto', 'manual'].includes(settings.get('backup_mode'))) {
    throw new Error('Invalid backup backup mode setting.');
  }

  for (const key of ['current_match_number', 'last_completed_match_number']) {
    const value = settings.get(key);
    if (value == null) continue;
    assertInteger(value, `${key} setting`, { min: 1 });
    if (!matchNumbers.has(value)) throw new Error(`Invalid backup ${key} setting.`);
  }
}

function validateRestoreDatabase(dbPath, { manifest = null, extractDir = null } = {}) {
  const restoredDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(restoredDb.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(row => row.name));
    for (const table of Object.keys(TABLE_COLUMNS)) {
      if (!tables.has(table)) throw new Error(`Backup database is missing table: ${table}`);
      const columns = new Set(restoredDb.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      for (const column of TABLE_COLUMNS[table]) {
        if (!columns.has(column)) throw new Error(`Backup database is missing column: ${table}.${column}`);
      }
    }

    const fkProblems = restoredDb.pragma('foreign_key_check');
    if (fkProblems.length > 0) throw new Error('Backup database has broken foreign key references.');

    const teams = rowsFrom(restoredDb, 'teams');
    const teamIds = new Set();
    for (const team of teams) {
      assertInteger(team.id, 'team id', { min: 1 });
      if (teamIds.has(team.id)) throw new Error('Invalid backup duplicate team id.');
      teamIds.add(team.id);
      assertText(team.name, 'team name', { max: 80, required: true });
      assertText(team.school, 'team school', { max: 120 });
      if (typeof team.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(team.color)) {
        throw new Error('Invalid backup team color.');
      }
      const logoName = logoFilenameFromPath(team.logo_path);
      if (manifest?.sections?.logos === true && logoName) {
        const logoPath = path.join(extractDir || '', 'logos', logoName);
        if (!fs.existsSync(logoPath) || !fs.statSync(logoPath).isFile()) {
          throw new Error('Invalid backup team logo path.');
        }
      }
      assertInteger(team.created_at, 'team created_at', { min: 0 });
    }

    const matchRows = rowsFrom(restoredDb, 'matches');
    const matchNumbers = new Set();
    for (const match of matchRows) {
      assertInteger(match.id, 'match id', { min: 1 });
      assertInteger(match.match_number, 'match number', { min: 1 });
      if (matchNumbers.has(match.match_number)) throw new Error('Invalid backup duplicate match number.');
      matchNumbers.add(match.match_number);
      if (!['group', 'knockout'].includes(match.stage)) throw new Error('Invalid backup match stage.');
      assertText(match.round, 'match round', { max: 40 });
      assertInteger(match.group_index, 'match group index', { min: -1, nullable: true });
      assertText(match.bracket_slot, 'match bracket slot', { max: 24 });
      if (match.depends_on != null) {
        const dependsOn = parseBackupJson(match.depends_on, 'match dependency JSON');
        if (!Array.isArray(dependsOn) || dependsOn.some(item => typeof item !== 'string' || item.length > 60)) {
          throw new Error('Invalid backup match dependency JSON.');
        }
      }
      assertFlag(match.bonus, 'match bonus flag');
      assertFlag(match.completed, 'match completed flag');
      for (const key of ['team_a_id', 'team_b_id', 'winner_team_id']) {
        const value = match[key];
        if (value == null) continue;
        assertInteger(value, `match ${key}`, { min: 1 });
        if (!teamIds.has(value)) throw new Error(`Invalid backup match ${key}.`);
      }
      assertRaceTime(match.time_a, 'match lane A time');
      assertRaceTime(match.time_b, 'match lane B time');
      if (match.winner_team_id != null && ![match.team_a_id, match.team_b_id].includes(match.winner_team_id)) {
        throw new Error('Invalid backup match winner.');
      }
      if (match.completed === 1 && match.winner_team_id == null) {
        throw new Error('Invalid backup completed match.');
      }
      assertInteger(match.completed_at, 'match completed_at', { min: 0, nullable: true });
    }

    for (const assignment of rowsFrom(restoredDb, 'group_assignments')) {
      assertInteger(assignment.team_id, 'group assignment team id', { min: 1 });
      if (!teamIds.has(assignment.team_id)) throw new Error('Invalid backup group assignment team id.');
      assertInteger(assignment.group_index, 'group assignment group index', { min: 0 });
    }

    validateSettings(rowsFrom(restoredDb, 'settings'), matchNumbers);

    for (const history of rowsFrom(restoredDb, 'history')) {
      assertInteger(history.id, 'history id', { min: 1 });
      assertText(history.action, 'history action', { max: 80, required: true });
      assertText(history.payload, 'history payload', { max: 100000, required: true });
      parseBackupJson(history.payload, 'history payload JSON');
      assertInteger(history.created_at, 'history created_at', { min: 0 });
    }
  } finally {
    restoredDb.close();
  }
}

function validateBackupBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Backup upload is empty.');

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new Error('Backup must be a readable ZIP file.');
  }
  const entries = zip.getEntries();
  if (entries.length === 0) throw new Error('Backup ZIP is empty.');
  for (const entry of entries) validateZipEntryName(entry.entryName);

  const manifest = parseManifest(zip);
  if (!zip.getEntry('tournament.db')) throw new Error('Backup ZIP is missing tournament.db.');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-backup-validate-'));
  try {
    zip.extractAllTo(tmpDir, true);
    const restoredDbPath = path.join(tmpDir, 'tournament.db');
    if (!fs.existsSync(restoredDbPath)) throw new Error('Backup database could not be extracted.');
    validateRestoreDatabase(restoredDbPath, { manifest, extractDir: tmpDir });
    return { manifest };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function rowsFrom(restoredDb, table) {
  const columns = TABLE_COLUMNS[table].join(', ');
  return restoredDb.prepare(`SELECT ${columns} FROM ${table}`).all();
}

function insertRows(table, rows) {
  if (rows.length === 0) return;
  const columns = TABLE_COLUMNS[table];
  const names = columns.join(', ');
  const values = columns.map(column => `@${column}`).join(', ');
  const stmt = db.prepare(`INSERT INTO ${table} (${names}) VALUES (${values})`);
  for (const row of rows) stmt.run(row);
}

function copyDatabaseTables(restoredDbPath, { clearLogoPaths = false } = {}) {
  const restoredDb = new Database(restoredDbPath, { readonly: true, fileMustExist: true });
  const rowsByTable = {};
  try {
    for (const table of Object.keys(TABLE_COLUMNS)) rowsByTable[table] = rowsFrom(restoredDb, table);
  } finally {
    restoredDb.close();
  }

  const previousForeignKeys = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      db.exec(`
        DELETE FROM group_assignments;
        DELETE FROM matches;
        DELETE FROM teams;
        DELETE FROM settings;
        DELETE FROM history;
        DELETE FROM sqlite_sequence WHERE name IN ('teams', 'matches', 'history');
      `);
      insertRows('teams', rowsByTable.teams);
      insertRows('matches', rowsByTable.matches);
      insertRows('group_assignments', rowsByTable.group_assignments);
      insertRows('settings', rowsByTable.settings);
      insertRows('history', rowsByTable.history);
      if (clearLogoPaths) clearLogoReferences();
    });
    tx();
  } finally {
    db.pragma(`foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
  }
}

function clearLogoReferences() {
  db.prepare(`UPDATE teams SET logo_path = NULL`).run();
}

async function restoreFromZip(buffer, { createSafetyArchive } = {}) {
  ensureDirs();
  validateBackupBuffer(buffer);

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new Error('Backup must be a readable ZIP file.');
  }
  const entries = zip.getEntries();
  if (entries.length === 0) throw new Error('Backup ZIP is empty.');
  for (const entry of entries) validateZipEntryName(entry.entryName);

  const manifest = parseManifest(zip);
  if (!zip.getEntry('tournament.db')) throw new Error('Backup ZIP is missing tournament.db.');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-backup-restore-'));
  try {
    zip.extractAllTo(tmpDir, true);
    const restoredDbPath = path.join(tmpDir, 'tournament.db');
    if (!fs.existsSync(restoredDbPath)) throw new Error('Backup database could not be extracted.');
    validateRestoreDatabase(restoredDbPath, { manifest, extractDir: tmpDir });

    const includesLogos = manifest.sections?.logos === true;
    const extractedLogos = path.join(tmpDir, 'logos');
    if (includesLogos) fs.mkdirSync(extractedLogos, { recursive: true });

    const safetyArchivePath = createSafetyArchive ? await createSafetyArchive() : null;
    copyDatabaseTables(restoredDbPath, { clearLogoPaths: !includesLogos });
    if (includesLogos) replaceDir(extractedLogos, LOGO_DIR);
    else emptyDir(LOGO_DIR);

    return { safetyArchivePath, manifest };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function localId(kind, name) {
  return crypto.createHash('sha1').update(`${kind}\0${name}`).digest('hex').slice(0, 16);
}

function readArchiveManifest(dirPath) {
  const manifestPath = path.join(dirPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return {};
  }
}

function listLocalBackups({ includePaths = false } = {}) {
  ensureDirs();
  const items = [];
  for (const entry of fs.readdirSync(BACKUP_DIR, { withFileTypes: true })) {
    const fullPath = path.join(BACKUP_DIR, entry.name);
    if (entry.isDirectory() && entry.name.startsWith('archive-') && fs.existsSync(path.join(fullPath, 'tournament.db'))) {
      const stat = fs.statSync(fullPath);
      const manifest = readArchiveManifest(fullPath);
      const hasLogos = fs.existsSync(path.join(fullPath, 'logos'));
      items.push({
        id: localId('archive', entry.name),
        kind: 'archive',
        name: entry.name,
        label: entry.name.replace(/^archive-/, 'Safety archive '),
        createdAt: manifest.createdAt || new Date(stat.mtimeMs).toISOString(),
        size: stat.size,
        hasLogos,
        restorable: true,
        warning: hasLogos ? null : 'Archive has database data only.',
        ...(includePaths ? { fullPath } : {}),
      });
    } else if (entry.isFile() && entry.name.endsWith('.db')) {
      const stat = fs.statSync(fullPath);
      items.push({
        id: localId('auto', entry.name),
        kind: 'auto',
        name: entry.name,
        label: entry.name.replace(/^tournament-/, 'Auto backup ').replace(/\.db$/, ''),
        createdAt: new Date(stat.mtimeMs).toISOString(),
        size: stat.size,
        hasLogos: false,
        restorable: true,
        warning: 'Database-only backup. Team logos will be cleared on restore.',
        ...(includePaths ? { fullPath } : {}),
      });
    }
  }
  return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function resolveLocalBackup(id) {
  const entry = listLocalBackups({ includePaths: true }).find(item => item.id === id);
  if (!entry) throw new Error('Local backup not found.');
  return entry;
}

function clearLocalBackups() {
  ensureDirs();
  let deleted = 0;
  for (const entry of fs.readdirSync(BACKUP_DIR, { withFileTypes: true })) {
    const fullPath = path.join(BACKUP_DIR, entry.name);
    if (entry.isDirectory() && entry.name.startsWith('archive-')) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      deleted++;
    } else if (entry.isFile() && entry.name.endsWith('.db')) {
      fs.rmSync(fullPath, { force: true });
      deleted++;
    }
  }
  return { deleted };
}

async function zipLocalBackup(entry) {
  if (!entry?.fullPath) throw new Error('Local backup entry is invalid.');
  if (entry.kind === 'archive') {
    const dbPath = path.join(entry.fullPath, 'tournament.db');
    const logosDir = path.join(entry.fullPath, 'logos');
    const includeLogos = fs.existsSync(logosDir);
    return zipDatabaseFile({
      dbPath,
      includeLogos,
      logosDir,
      tournamentName: readTournamentNameFromDb(dbPath),
      filename: `${entry.name}.zip`,
    });
  }
  if (entry.kind === 'auto') {
    return zipDatabaseFile({
      dbPath: entry.fullPath,
      includeLogos: false,
      tournamentName: readTournamentNameFromDb(entry.fullPath),
      filename: `${entry.name.replace(/\.db$/, '')}.zip`,
    });
  }
  throw new Error('Unsupported local backup type.');
}

module.exports = {
  BACKUP_TYPE,
  BACKUP_VERSION,
  createBackupZip,
  restoreFromZip,
  validateBackupBuffer,
  listLocalBackups,
  clearLocalBackups,
  zipLocalBackup,
  resolveLocalBackup,
  clearLogoReferences,
  validateZipEntryName,
};
