/**
 * SQLite database — schema, prepared statements, and helpers.
 * Uses better-sqlite3 for synchronous, fast, file-based storage.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'tournament.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  school      TEXT,
  color       TEXT DEFAULT '#00e6d2',
  logo_path   TEXT,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS matches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  match_number    INTEGER NOT NULL,
  stage           TEXT NOT NULL CHECK (stage IN ('group', 'knockout')),
  round           TEXT,
  group_index     INTEGER,
  bracket_slot    TEXT,
  depends_on      TEXT,
  bonus           INTEGER NOT NULL DEFAULT 0,
  team_a_id       INTEGER,
  team_b_id       INTEGER,
  time_a          REAL,
  time_b          REAL,
  winner_team_id  INTEGER,
  completed       INTEGER NOT NULL DEFAULT 0,
  completed_at    INTEGER,
  FOREIGN KEY (team_a_id) REFERENCES teams(id) ON DELETE SET NULL,
  FOREIGN KEY (team_b_id) REFERENCES teams(id) ON DELETE SET NULL,
  FOREIGN KEY (winner_team_id) REFERENCES teams(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS group_assignments (
  team_id      INTEGER PRIMARY KEY,
  group_index  INTEGER NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

CREATE TABLE IF NOT EXISTS history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  action         TEXT NOT NULL,
  payload        TEXT NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_matches_match_number ON matches(match_number);
CREATE INDEX IF NOT EXISTS idx_matches_completed ON matches(completed);
CREATE INDEX IF NOT EXISTS idx_matches_stage ON matches(stage);
CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_match_number_unique ON matches(match_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_bracket_slot_unique ON matches(bracket_slot) WHERE bracket_slot IS NOT NULL;
`);

// Seed default settings if missing
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
function getConfig(key, fallback = null) {
  const row = getSetting.get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function setConfig(key, value) {
  setSetting.run(key, JSON.stringify(value));
}

const defaults = {
  tournament_name: 'STEM Racing Championship',
  tournament_state: 'registration', // registration | running | finished
  current_match_number: null,
  last_completed_match_number: null,
  race_screen_mode: 'idle', // idle | intro | lights | racing | result
  backup_mode: 'auto', // auto | manual
};
for (const [k, v] of Object.entries(defaults)) {
  if (getConfig(k) === null) setConfig(k, v);
}

// ---------- TEAMS ----------
const q = {
  insertTeam: db.prepare(`INSERT INTO teams (name, school, color, logo_path) VALUES (?, ?, ?, ?)`),
  updateTeam: db.prepare(`UPDATE teams SET name = ?, school = ?, color = ?, logo_path = COALESCE(?, logo_path) WHERE id = ?`),
  deleteTeam: db.prepare(`DELETE FROM teams WHERE id = ?`),
  listTeams: db.prepare(`SELECT * FROM teams ORDER BY name COLLATE NOCASE`),
  getTeam: db.prepare(`SELECT * FROM teams WHERE id = ?`),
  findTeamByNameCI: db.prepare(`SELECT * FROM teams WHERE name = ? COLLATE NOCASE LIMIT 1`),

  insertMatch: db.prepare(`
    INSERT INTO matches
      (match_number, stage, round, group_index, bracket_slot, depends_on, bonus, team_a_id, team_b_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listMatches: db.prepare(`SELECT * FROM matches ORDER BY match_number`),
  getMatch: db.prepare(`SELECT * FROM matches WHERE id = ?`),
  getMatchByNumber: db.prepare(`SELECT * FROM matches WHERE match_number = ?`),
  getMatchBySlot: db.prepare(`SELECT * FROM matches WHERE bracket_slot = ?`),
  deleteAllMatches: db.prepare(`DELETE FROM matches`),
  deleteKnockoutMatches: db.prepare(`DELETE FROM matches WHERE stage = 'knockout'`),
  resetMatchesAutoIncrement: db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'matches'`),
  updateMatchResult: db.prepare(`
    UPDATE matches
      SET time_a = ?, time_b = ?, winner_team_id = ?, completed = 1, completed_at = strftime('%s', 'now')
    WHERE id = ?
  `),
  clearMatchResult: db.prepare(`
    UPDATE matches
      SET time_a = NULL, time_b = NULL, winner_team_id = NULL, completed = 0, completed_at = NULL
    WHERE id = ?
  `),
  updateMatchTeams: db.prepare(`
    UPDATE matches SET team_a_id = ?, team_b_id = ? WHERE id = ?
  `),
  nextIncompleteMatch: db.prepare(`
    SELECT * FROM matches
      WHERE completed = 0 AND team_a_id IS NOT NULL AND team_b_id IS NOT NULL
      ORDER BY match_number ASC LIMIT 1
  `),

  insertAssignment: db.prepare(`
    INSERT INTO group_assignments (team_id, group_index) VALUES (?, ?)
    ON CONFLICT(team_id) DO UPDATE SET group_index = excluded.group_index
  `),
  deleteAssignments: db.prepare(`DELETE FROM group_assignments`),
  listAssignments: db.prepare(`SELECT * FROM group_assignments`),

  insertHistory: db.prepare(`INSERT INTO history (action, payload) VALUES (?, ?)`),
  lastHistory: db.prepare(`SELECT * FROM history ORDER BY id DESC LIMIT 1`),
  deleteHistory: db.prepare(`DELETE FROM history WHERE id = ?`),
  clearHistory: db.prepare(`DELETE FROM history`),
};

function listTeams() {
  return q.listTeams.all().map(row => ({
    id: row.id, name: row.name, school: row.school,
    color: row.color, logoPath: row.logo_path, createdAt: row.created_at,
  }));
}

function listMatches() {
  return q.listMatches.all().map(rowToMatch);
}

function rowToMatch(row) {
  return {
    id: row.id,
    matchNumber: row.match_number,
    stage: row.stage,
    round: row.round,
    groupIndex: row.group_index,
    bracketSlot: row.bracket_slot,
    dependsOn: row.depends_on ? JSON.parse(row.depends_on) : null,
    bonus: row.bonus,
    teamAId: row.team_a_id,
    teamBId: row.team_b_id,
    timeA: row.time_a,
    timeB: row.time_b,
    winnerTeamId: row.winner_team_id,
    completed: !!row.completed,
    completedAt: row.completed_at,
  };
}

function getGroupAssignments() {
  const map = new Map();
  for (const row of q.listAssignments.all()) map.set(row.team_id, row.group_index);
  return map;
}

function resetTournament() {
  const tx = db.transaction(() => {
    q.deleteAllMatches.run();
    q.deleteAssignments.run();
    q.clearHistory.run();
    try { q.resetMatchesAutoIncrement.run(); } catch { /* ignore */ }
    setConfig('tournament_state', 'registration');
    setConfig('current_match_number', null);
    setConfig('last_completed_match_number', null);
    setConfig('race_screen_mode', 'idle');
  });
  tx();
}

module.exports = {
  db,
  q,
  getConfig,
  setConfig,
  listTeams,
  listMatches,
  rowToMatch,
  getGroupAssignments,
  resetTournament,
  DATA_DIR,
  DB_PATH,
};
