/**
 * F1 in Schools / STEM Racing — tournament platform server.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const os = require('os');

const {
  db, q, getConfig, setConfig,
  listTeams, listMatches, getGroupAssignments, resetTournament, rowToMatch,
  DATA_DIR,
} = require('./src/db');
const tournament = require('./src/tournament');
const backup = require('./src/backup');
const portableBackup = require('./src/portableBackup');
const corrections = require('./src/matchCorrections');
const {
  securityHeaders,
  noStoreSensitiveResponses,
  logoFileFilter,
  detectImageKind,
} = require('./src/security');
const {
  isLocalRequest,
  isRestrictedNetworkRequest,
  spectatorRedirectPath,
} = require('./src/networkAccess');
const { csvCell: csv } = require('./src/export');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server);

const LOGO_DIR = path.join(DATA_DIR, 'logos');
if (!fs.existsSync(LOGO_DIR)) fs.mkdirSync(LOGO_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: LOGO_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, Date.now() + '-' + crypto.randomUUID() + ext);
    },
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: logoFileFilter,
});
const backupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 128 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const ok = name.endsWith('.zip') || ['application/zip', 'application/x-zip-compressed'].includes(mime);
    cb(ok ? null : new Error('Backup must be a ZIP file.'), ok);
  },
});

app.use(securityHeaders);
app.use(noStoreSensitiveResponses);
app.use(express.json());
app.use(restrictNetworkAccess);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/logos', express.static(LOGO_DIR));

function restrictNetworkAccess(req, res, next) {
  const local = isLocalRequest(req);

  if (!local) {
    const spectatorRedirect = spectatorRedirectPath(req);
    if (spectatorRedirect) return res.redirect(spectatorRedirect);
  }

  if (local || !isRestrictedNetworkRequest(req)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(403).json({
      error: 'This control area is only available on the organiser laptop.',
    });
  }

  return res.status(403).send(`
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Organiser Access Only</title>
      <link rel="stylesheet" href="/assets/styles.css" />
    </head>
    <body>
      <main class="wrap" style="min-height: 100vh; display: grid; place-items: center;">
        <section class="card" style="max-width: 620px;">
          <h1>Organiser Access Only</h1>
          <p class="muted">Admin and backup tools are only available from this laptop.</p>
          <p class="muted">Spectator screens are available at <a href="/spectator">/spectator</a>.</p>
        </section>
      </main>
    </body>
    </html>
  `);
}

function discardUploadedFile(file) {
  if (!file?.path) return;
  try { fs.rmSync(file.path, { force: true }); } catch { /* ignore */ }
}

function publicLogoPath(file) {
  if (!file) return null;
  const bytes = fs.readFileSync(file.path);
  const kind = detectImageKind(bytes);
  const ext = path.extname(file.originalname).toLowerCase();
  const expected = ext === '.png' ? 'png' : 'jpeg';
  if (kind !== expected) {
    discardUploadedFile(file);
    throw new Error('Logo file content must match PNG or JPG.');
  }
  return '/logos/' + path.basename(file.path);
}

function clearScheduleState() {
  q.deleteAllMatches.run();
  q.deleteAssignments.run();
  q.clearHistory.run();
  try { q.resetMatchesAutoIncrement.run(); } catch { /* ignore */ }
  setConfig('tournament_state', 'registration');
  setConfig('current_match_number', null);
  setConfig('last_completed_match_number', null);
  setConfig('race_screen_mode', 'idle');
  setConfig('schedule_summary', null);
}

function normalizeText(value, { field, max = 120, required = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text && required) throw new Error(`${field} required.`);
  if (text.length > max) throw new Error(`${field} must be ${max} characters or fewer.`);
  return text;
}

function normalizeColor(value, fallback = '#00e6d2') {
  const color = String(value ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
}

function parseMatchNumber(value) {
  const matchNumber = Number(value);
  if (!Number.isInteger(matchNumber) || matchNumber < 1) {
    throw new Error('Invalid match number.');
  }
  return matchNumber;
}

function parseRaceTime(value, label) {
  if (value === '' || value == null) return null;
  const time = Number(value);
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid number.`);
  if (time <= 0) throw new Error(`${label} must be greater than 0.`);
  if (time > 300) throw new Error(`${label} looks too large.`);
  return Math.round(time * 1000) / 1000;
}

function getMatchByNumber(matches, matchNumber) {
  return matches.find(m => m.matchNumber === matchNumber) || null;
}

function getExistingMatchByNumber(matchNumber) {
  const row = q.getMatchByNumber.get(matchNumber);
  if (!row) throw new Error('Match not found.');
  const match = rowToMatch(row);
  if (match.teamAId == null || match.teamBId == null) {
    throw new Error('Match teams not yet resolved.');
  }
  return match;
}

function getPlayableMatchByNumber(matchNumber) {
  const match = getExistingMatchByNumber(matchNumber);
  if (match.completed) throw new Error('Match already completed.');
  return match;
}

function buildState() {
  const teams = listTeams();
  const matches = listMatches();
  const groupMap = getGroupAssignments();
  const tournamentName = getConfig('tournament_name');
  const formatOptions = getTournamentFormatOptions();
  const state = getConfig('tournament_state');
  const currentMatchNumber = getConfig('current_match_number');
  const lastCompletedMatchNumber = getConfig('last_completed_match_number');
  const raceScreenMode = getConfig('race_screen_mode') || 'idle';

  const groups = [];
  for (const [teamId, gi] of groupMap.entries()) {
    if (!groups[gi]) groups[gi] = [];
    groups[gi].push(teamId);
  }

  let groupStandings = [];
  if (groupMap.size > 0) {
    groupStandings = tournament.computeGroupStandings(teams, matches, groupMap);
  }
  const overallStandings = tournament.computeStandings(teams, matches, { stage: 'all' });
  const polePosition = tournament.computePolePosition(teams, matches);

  const firstPlayableMatch = matches.find(m => !m.completed && m.teamAId != null && m.teamBId != null) || null;
  const queuedMatch = currentMatchNumber != null
    ? getMatchByNumber(matches, currentMatchNumber)
    : null;
  const playableQueuedMatch = queuedMatch && !queuedMatch.completed && queuedMatch.teamAId != null && queuedMatch.teamBId != null
    ? queuedMatch
    : firstPlayableMatch;
  const lastCompletedMatch = lastCompletedMatchNumber != null
    ? getMatchByNumber(matches, lastCompletedMatchNumber)
    : null;

  let currentMatch = playableQueuedMatch;
  let nextMatch = null;
  if (raceScreenMode === 'result' && lastCompletedMatch?.completed) {
    currentMatch = lastCompletedMatch;
    nextMatch = playableQueuedMatch;
  } else if (playableQueuedMatch) {
    nextMatch = matches.find(m =>
      !m.completed
      && m.teamAId != null
      && m.teamBId != null
      && m.matchNumber > playableQueuedMatch.matchNumber
    ) || null;
  } else {
    currentMatch = null;
    nextMatch = firstPlayableMatch;
  }

  const bracketMatches = matches.filter(m => m.stage === 'knockout');

  const savedSummary = getConfig('schedule_summary');
  const scheduleSummary = savedSummary || tournament.summarizeExistingSchedule({
    teamCount: teams.length,
    groups: groups.filter(Boolean),
    matches,
    options: formatOptions,
  });

  return {
    tournamentName, state, teams, matches,
    groups: groups.filter(Boolean),
    groupStandings, overallStandings, polePosition,
    currentMatch, nextMatch, queuedMatch: playableQueuedMatch, bracketMatches,
    formatOptions, scheduleSummary,
    raceScreenMode,
    serverUrl: serverBaseUrl(),
    generatedAt: Date.now(),
  };
}

function getTournamentFormatOptions() {
  return tournament.normalizeScheduleOptions(getConfig('tournament_format_options'));
}

function serverBaseUrl() {
  return serverBaseUrls()[0] || `http://localhost:${PORT}`;
}

function serverBaseUrls() {
  return networkAddresses().map(ip => `http://${ip}:${PORT}`);
}

function networkAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const interfaces of Object.values(nets)) {
    for (const ni of interfaces || []) {
      if (ni.family === 'IPv4' && !ni.internal && isUsableNetworkAddress(ni.address)) {
        addresses.push(ni.address);
      }
    }
  }
  return [...new Set(addresses)].sort((a, b) => addressPriority(a) - addressPriority(b));
}

function isUsableNetworkAddress(address) {
  return address && !address.startsWith('169.254.') && address !== '0.0.0.0';
}

function addressPriority(address) {
  if (/^192\.168\./.test(address)) return 0;
  if (/^10\./.test(address)) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return 2;
  return 3;
}

function broadcast() {
  io.emit('state', buildState());
}

function recordHistory(action, payload) {
  q.insertHistory.run(action, JSON.stringify(payload));
}

function insertGeneratedMatches(matches) {
  for (const m of matches) {
    q.insertMatch.run(
      m.matchNumber, m.stage, String(m.round),
      m.groupIndex ?? null,
      m.bracketSlot ?? null,
      m.dependsOn ? JSON.stringify(m.dependsOn) : null,
      m.bonus ? 1 : 0,
      m.teamAId ?? null, m.teamBId ?? null
    );
  }
}

function buildKnockoutFromCurrentStandings() {
  if (getTournamentFormatOptions().format === tournament.FORMAT_LEAGUE_ONLY) return 0;
  const matches = listMatches();
  const groupMatches = matches.filter(m => m.stage === 'group');
  if (groupMatches.length === 0 || groupMatches.some(m => !m.completed)) return 0;
  const teams = listTeams();
  const groupMap = getGroupAssignments();
  const standings = tournament.computeGroupStandings(teams, matches, groupMap);
  const startNum = Math.max(...groupMatches.map(m => m.matchNumber)) + 1;
  const bracket = tournament.buildKnockoutBracket(standings, startNum);
  insertGeneratedMatches(bracket);
  return bracket.length;
}

function maybeBuildKnockout() {
  const matches = listMatches();
  if (matches.some(m => m.stage === 'knockout')) return false;
  return buildKnockoutFromCurrentStandings() > 0;
}

function advanceBracket() {
  const matches = listMatches();
  const bySlot = new Map();
  for (const m of matches) if (m.bracketSlot) bySlot.set(m.bracketSlot, m);

  const getWinnerLoser = (slot) => {
    const m = bySlot.get(slot);
    if (!m || !m.completed || !m.winnerTeamId) return { winner: null, loser: null };
    const loser = m.winnerTeamId === m.teamAId ? m.teamBId : m.teamAId;
    return { winner: m.winnerTeamId, loser };
  };

  for (const m of matches) {
    if (m.stage !== 'knockout' || !m.dependsOn) continue;
    if (m.teamAId && m.teamBId) continue;
    const resolve = (token) => {
      const [slot, which] = token.split('-');
      const { winner, loser } = getWinnerLoser(slot);
      return which === 'winner' ? winner : loser;
    };
    const a = resolve(m.dependsOn[0]);
    const b = resolve(m.dependsOn[1]);
    if (a != null && b != null) {
      q.updateMatchTeams.run(a, b, m.id);
    }
  }
}

function rollbackBracket(matchIdThatWasUndone) {
  const matches = listMatches();
  const undone = matches.find(m => m.id === matchIdThatWasUndone);
  if (!undone || undone.stage !== 'knockout' || !undone.bracketSlot) return;
  for (const m of matches) {
    if (m.stage !== 'knockout' || !m.dependsOn) continue;
    if (m.dependsOn.some(dep => dep.startsWith(undone.bracketSlot + '-'))) {
      q.clearMatchResult.run(m.id);
      q.updateMatchTeams.run(null, null, m.id);
    }
  }
}

function refreshProgressAfterResult(fallbackMatchNumber = null) {
  const next = q.nextIncompleteMatch.get();
  if (next) {
    setConfig('current_match_number', next.match_number);
    setConfig('race_screen_mode', 'result');
    return;
  }

  const remaining = listMatches().filter(m => !m.completed);
  if (remaining.length === 0) {
    setConfig('current_match_number', fallbackMatchNumber);
    setConfig('tournament_state', 'finished');
    setConfig('race_screen_mode', 'finished');
  } else {
    setConfig('current_match_number', fallbackMatchNumber);
    setConfig('race_screen_mode', 'result');
  }
}

function rebuildKnockoutAfterGroupChange() {
  q.deleteKnockoutMatches.run();
  buildKnockoutFromCurrentStandings();
}

function clearDownstreamKnockoutMatches(affectedMatches) {
  for (const affected of affectedMatches) {
    q.clearMatchResult.run(affected.id);
    q.updateMatchTeams.run(null, null, affected.id);
  }
}

const pages = ['index', 'admin', 'backups', 'race', 'leaderboard', 'schedule', 'rotation', 'bracket', 'overlay', 'spectator'];
for (const p of pages) {
  const route = p === 'index' ? '/' : '/' + p;
  app.get(route, (req, res) => {
    if (!isLocalRequest(req)) {
      if (p === 'index') return res.redirect('/spectator');
      if ((p === 'leaderboard' || p === 'schedule') && !('spectator' in req.query)) {
        return res.redirect(route + '?spectator=1');
      }
    }
    return res.sendFile(path.join(__dirname, 'public', p + '.html'));
  });
}

app.get('/api/state', (_req, res) => res.json(buildState()));

app.post('/api/teams', upload.single('logo'), (req, res) => {
  if (getConfig('tournament_state') !== 'registration') {
    discardUploadedFile(req.file);
    return res.status(400).json({ error: 'Tournament already started; reset to re-register teams.' });
  }
  try {
    const name = normalizeText(req.body?.name, { field: 'Team name', max: 80, required: true });
    const school = normalizeText(req.body?.school, { field: 'School', max: 120 });
    const color = normalizeColor(req.body?.color);
    const existing = q.findTeamByNameCI.get(name);
    if (existing) {
      discardUploadedFile(req.file);
      return res.status(400).json({ error: 'A team with that name already exists.' });
    }

    const logoPath = publicLogoPath(req.file);
    const hadSchedule = listMatches().length > 0;
    const tx = db.transaction(() => {
      const info = q.insertTeam.run(name, school, color, logoPath);
      if (hadSchedule) clearScheduleState();
      return info;
    });
    const info = tx();
    broadcast();
    res.json({ id: info.lastInsertRowid, scheduleInvalidated: hadSchedule });
  } catch (err) {
    discardUploadedFile(req.file);
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/teams/:id', upload.single('logo'), (req, res) => {
  const id = Number(req.params.id);
  const existing = q.getTeam.get(id);
  if (!existing) {
    discardUploadedFile(req.file);
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const name = normalizeText(req.body?.name ?? existing.name, { field: 'Team name', max: 80, required: true });
    const school = normalizeText(req.body?.school ?? existing.school ?? '', { field: 'School', max: 120 });
    const color = normalizeColor(req.body?.color ?? existing.color, existing.color || '#00e6d2');
    const dupe = q.findTeamByNameCI.get(name);
    if (dupe && dupe.id !== id) {
      discardUploadedFile(req.file);
      return res.status(400).json({ error: 'A team with that name already exists.' });
    }

    const logoPath = publicLogoPath(req.file);
    q.updateTeam.run(name, school, color, logoPath, id);
    broadcast();
    res.json({ ok: true });
  } catch (err) {
    discardUploadedFile(req.file);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/teams/:id', (req, res) => {
  if (getConfig('tournament_state') !== 'registration') {
    return res.status(400).json({ error: 'Cannot delete teams after tournament has started.' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid team id.' });
  if (!q.getTeam.get(id)) return res.status(404).json({ error: 'Not found' });
  const hadSchedule = listMatches().length > 0;
  const tx = db.transaction(() => {
    q.deleteTeam.run(id);
    if (hadSchedule) clearScheduleState();
  });
  tx();
  broadcast();
  res.json({ ok: true, scheduleInvalidated: hadSchedule });
});

app.post('/api/schedule/generate', (_req, res) => {
  if (getConfig('tournament_state') !== 'registration') {
    return res.status(400).json({ error: 'Reset the tournament before regenerating the schedule.' });
  }
  const teams = listTeams();
  if (teams.length < 4) return res.status(400).json({ error: 'Need at least 4 teams.' });
  try {
    const plan = tournament.generateSchedule(teams.map(t => t.id), getTournamentFormatOptions());
    const tx = db.transaction(() => {
      clearScheduleState();
      plan.groups.forEach((g, gi) => g.forEach(tid => q.insertAssignment.run(tid, gi)));
      insertGeneratedMatches(plan.matches);
      setConfig('tournament_format_options', plan.options);
      setConfig('schedule_summary', plan.summary);
    });
    tx();
    broadcast();
    res.json({ ok: true, matches: plan.matches.length, groups: plan.groups.length, summary: plan.summary });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/tournament/start', (_req, res) => {
  const matches = listMatches();
  if (matches.length === 0) return res.status(400).json({ error: 'Generate the schedule first.' });
  const first = matches.find(m => !m.completed && m.teamAId != null && m.teamBId != null);
  if (!first) return res.status(400).json({ error: 'Schedule has no playable matches. Regenerate it before starting.' });
  setConfig('tournament_state', 'running');
  setConfig('current_match_number', first.matchNumber);
  setConfig('last_completed_match_number', null);
  setConfig('race_screen_mode', 'intro');
  broadcast();
  res.json({ ok: true });
});

app.post('/api/tournament/reset', async (_req, res) => {
  let archivePath = null;
  try {
    archivePath = await backup.archiveOnce();
  } catch (err) {
    console.error('[backup] pre-reset archive failed:', err.message);
  }
  resetTournament();
  broadcast();
  res.json({ ok: true, archivePath });
});

app.post('/api/matches/:id/result', (req, res) => {
  const id = Number(req.params.id);
  const match = q.getMatch.get(id);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (!match.team_a_id || !match.team_b_id) return res.status(400).json({ error: 'Match teams not yet resolved.' });
  if (match.completed) {
    return res.status(400).json({ error: 'Match already completed. Use Undo before entering a corrected result.' });
  }
  let tA;
  let tB;
  try {
    tA = parseRaceTime(req.body?.timeA, 'Lane A time');
    tB = parseRaceTime(req.body?.timeB, 'Lane B time');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (tA == null && tB == null) return res.status(400).json({ error: 'At least one time required.' });
  if (tA != null && tB != null && tA === tB) {
    return res.status(400).json({ error: 'Times are tied. Enter a more precise result or rerun the race.' });
  }
  let winner = null;
  if (tA != null && tB != null) winner = tA < tB ? match.team_a_id : match.team_b_id;
  else if (tA != null) winner = match.team_a_id;
  else winner = match.team_b_id;

  const tx = db.transaction(() => {
    const prev = rowToMatch(match);
    recordHistory('match_result', {
      matchId: id,
      prev: { timeA: prev.timeA, timeB: prev.timeB, winnerTeamId: prev.winnerTeamId, completed: prev.completed },
    });
    q.updateMatchResult.run(tA, tB, winner, id);
    maybeBuildKnockout();
    advanceBracket();

    const next = q.nextIncompleteMatch.get();
    setConfig('last_completed_match_number', match.match_number);
    if (next) {
      setConfig('current_match_number', next.match_number);
      setConfig('race_screen_mode', 'result');
    } else {
      const remaining = listMatches().filter(m => !m.completed);
      if (remaining.length === 0) {
        setConfig('current_match_number', match.match_number);
        setConfig('tournament_state', 'finished');
        setConfig('race_screen_mode', 'finished');
      } else {
        setConfig('current_match_number', match.match_number);
        setConfig('race_screen_mode', 'result');
      }
    }
  });
  tx();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/matches/:id/correct-result', (req, res) => {
  const id = Number(req.params.id);
  const row = q.getMatch.get(id);
  if (!row) return res.status(404).json({ error: 'Match not found' });
  const match = rowToMatch(row);
  let times;
  try {
    times = corrections.parseCorrectedTimes(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const matches = listMatches();
  const safety = corrections.canCorrectMatch(match, matches);
  if (!safety.ok) return res.status(400).json({ error: safety.error });

  let winnerTeamId;
  try {
    winnerTeamId = corrections.calculateWinnerTeamId(match, times);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const affectedMatches = safety.affectedMatches || [];
  const tx = db.transaction(() => {
    recordHistory('match_correction', {
      matchId: id,
      matchNumber: match.matchNumber,
      stage: match.stage,
      previous: {
        timeA: match.timeA,
        timeB: match.timeB,
        winnerTeamId: match.winnerTeamId,
        completed: match.completed,
      },
      corrected: {
        timeA: times.timeA,
        timeB: times.timeB,
        winnerTeamId,
      },
      affectedMatchNumbers: affectedMatches.map(m => m.matchNumber),
    });

    q.updateMatchResult.run(times.timeA, times.timeB, winnerTeamId, id);

    if (match.stage === 'group') {
      rebuildKnockoutAfterGroupChange();
    } else if (match.stage === 'knockout') {
      clearDownstreamKnockoutMatches(affectedMatches);
      advanceBracket();
    }

    setConfig('last_completed_match_number', match.matchNumber);
    refreshProgressAfterResult(match.matchNumber);
  });
  tx();
  broadcast();
  res.json({ ok: true, affectedMatchNumbers: affectedMatches.map(m => m.matchNumber) });
});

app.post('/api/undo', (_req, res) => {
  const last = q.lastHistory.get();
  if (!last) return res.status(400).json({ error: 'Nothing to undo.' });
  const payload = JSON.parse(last.payload);

  const tx = db.transaction(() => {
    if (last.action === 'match_correction' && payload.matchId) {
      const correctedRow = q.getMatch.get(payload.matchId);
      const corrected = correctedRow ? rowToMatch(correctedRow) : null;
      const previous = payload.previous || {};
      if (previous.completed) {
        q.updateMatchResult.run(previous.timeA, previous.timeB, previous.winnerTeamId, payload.matchId);
      } else {
        q.clearMatchResult.run(payload.matchId);
      }
      if (corrected?.stage === 'group') {
        rebuildKnockoutAfterGroupChange();
      } else if (corrected?.stage === 'knockout') {
        const affected = corrections.downstreamKnockoutMatches(corrected, listMatches());
        clearDownstreamKnockoutMatches(affected);
        advanceBracket();
      }
      setConfig('last_completed_match_number', payload.matchNumber ?? null);
      refreshProgressAfterResult(payload.matchNumber ?? null);
      q.deleteHistory.run(last.id);
      return;
    }

    if (last.action === 'match_result' && payload.matchId) {
      const undoneRow = q.getMatch.get(payload.matchId);
      const wasGroupStage = undoneRow && undoneRow.stage === 'group';
      if (payload.prev && payload.prev.completed) {
        q.updateMatchResult.run(payload.prev.timeA, payload.prev.timeB, payload.prev.winnerTeamId, payload.matchId);
      } else {
        q.clearMatchResult.run(payload.matchId);
      }
      rollbackBracket(payload.matchId);
      if (wasGroupStage) {
        const all = listMatches();
        const groupDone = all.filter(m => m.stage === 'group').every(m => m.completed);
        if (!groupDone) {
          const koStarted = all.some(m => m.stage === 'knockout' && m.completed);
          if (!koStarted) {
            db.prepare(`DELETE FROM matches WHERE stage = 'knockout'`).run();
          }
        }
      }
      const next = q.nextIncompleteMatch.get();
      if (next) setConfig('current_match_number', next.match_number);
      else setConfig('current_match_number', null);
      setConfig('last_completed_match_number', null);
      setConfig('tournament_state', 'running');
      setConfig('race_screen_mode', 'intro');
      q.deleteHistory.run(last.id);
      return;
    }
    q.deleteHistory.run(last.id);
  });
  tx();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/race/mode', (req, res) => {
  const { mode, matchNumber } = req.body;
  const valid = ['idle', 'intro', 'lights', 'racing', 'result', 'finished'];
  if (!valid.includes(mode)) return res.status(400).json({ error: 'Bad mode' });
  try {
    if (matchNumber != null) {
      const parsed = parseMatchNumber(matchNumber);
      if (mode === 'result') {
        getExistingMatchByNumber(parsed);
      } else if (['intro', 'lights', 'racing'].includes(mode)) {
        getPlayableMatchByNumber(parsed);
      }
      setConfig('current_match_number', parsed);
    } else if (['intro', 'lights', 'racing'].includes(mode)) {
      const current = getConfig('current_match_number');
      const playable = current != null
        ? (() => {
            try { return getPlayableMatchByNumber(current); } catch { return null; }
          })()
        : null;
      if (!playable) {
        const next = q.nextIncompleteMatch.get();
        if (!next) return res.status(400).json({ error: 'No playable match is available right now.' });
        setConfig('current_match_number', next.match_number);
      }
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  setConfig('race_screen_mode', mode);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/current-match', (req, res) => {
  try {
    const matchNumber = parseMatchNumber(req.body?.matchNumber);
    getPlayableMatchByNumber(matchNumber);
    setConfig('current_match_number', matchNumber);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  broadcast();
  res.json({ ok: true });
});

app.post('/api/settings', (req, res) => {
  const allowed = ['tournament_name'];
  for (const [k, v] of Object.entries(req.body || {})) {
    if (allowed.includes(k)) setConfig(k, String(v).slice(0, 200));
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'tournament_format_options')) {
    if (getConfig('tournament_state') !== 'registration') {
      return res.status(400).json({ error: 'Tournament format can only be changed before the tournament starts.' });
    }
    if (listMatches().some(m => m.completed)) {
      return res.status(400).json({ error: 'Completed results exist. Reset before changing the tournament format.' });
    }
    const options = tournament.normalizeScheduleOptions(req.body.tournament_format_options);
    setConfig('tournament_format_options', options);
    setConfig('schedule_summary', null);
  }
  broadcast();
  res.json({ ok: true });
});

app.post('/api/archive', async (_req, res) => {
  try {
    const archivePath = await backup.archiveOnce();
    res.json({ ok: true, archivePath });
  } catch (err) {
    console.error('[backup] archive failed:', err.message);
    res.status(500).json({ error: 'Unable to create archive.' });
  }
});

app.get('/api/backups', (_req, res) => {
  try {
    res.json({ backups: portableBackup.listLocalBackups(), backup: backup.getStatus() });
  } catch (err) {
    console.error('[backup] list failed:', err.message);
    res.status(500).json({ error: 'Unable to list backups.' });
  }
});

app.delete('/api/backups', (_req, res) => {
  try {
    const result = portableBackup.clearLocalBackups();
    res.json({ ok: true, ...result, backups: portableBackup.listLocalBackups(), backup: backup.getStatus() });
  } catch (err) {
    console.error('[backup] clear failed:', err.message);
    res.status(500).json({ error: 'Unable to clear local backups.' });
  }
});

app.post('/api/backups/mode', (req, res) => {
  try {
    const status = backup.setMode(String(req.body?.mode || ''));
    res.json({ ok: true, backup: status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/backups/run', async (_req, res) => {
  try {
    const backupPath = await backup.backupOnce();
    res.json({
      ok: true,
      backupPath,
      backups: portableBackup.listLocalBackups(),
      backup: backup.getStatus(),
    });
  } catch (err) {
    console.error('[backup] manual backup failed:', err.message);
    res.status(500).json({ error: 'Unable to create local backup.' });
  }
});

app.post('/api/backups/create', async (req, res) => {
  try {
    const includeLogos = req.body?.logos !== false;
    const out = await portableBackup.createBackupZip({ includeLogos });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  } catch (err) {
    console.error('[backup] create failed:', err.message);
    res.status(500).json({ error: 'Unable to create backup ZIP.' });
  }
});

app.post('/api/backups/restore', backupUpload.single('backup'), async (req, res) => {
  if (!req.file?.buffer) return res.status(400).json({ error: 'Choose a backup ZIP first.' });
  try {
    const result = await portableBackup.restoreFromZip(req.file.buffer, {
      createSafetyArchive: backup.archiveOnce,
    });
    backup.setMode(backup.getMode());
    broadcast();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[backup] restore failed:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/backups/restore-local', async (req, res) => {
  try {
    const entry = portableBackup.resolveLocalBackup(req.body?.id);
    const zip = await portableBackup.zipLocalBackup(entry);
    const result = await portableBackup.restoreFromZip(zip.buffer, {
      createSafetyArchive: backup.archiveOnce,
    });
    backup.setMode(backup.getMode());
    broadcast();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[backup] local restore failed:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/backups/download-local/:id', async (req, res) => {
  try {
    const entry = portableBackup.resolveLocalBackup(req.params.id);
    const out = await portableBackup.zipLocalBackup(entry);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  } catch (err) {
    console.error('[backup] local download failed:', err.message);
    res.status(404).json({ error: err.message });
  }
});

app.get('/api/export/:format', (req, res) => {
  const state = buildState();
  const fmt = req.params.format;
  if (fmt === 'json') {
    res.setHeader('Content-Disposition', 'attachment; filename=f1-tournament-results.json');
    res.setHeader('Content-Type', 'application/json');
    return res.send(JSON.stringify(state, null, 2));
  }
  if (fmt === 'csv') {
    const lines = [];
    lines.push('# TEAMS');
    lines.push('id,name,school,color');
    for (const t of state.teams) lines.push([t.id, csv(t.name), csv(t.school || ''), t.color].join(','));
    lines.push('');
    lines.push('# OVERALL STANDINGS');
    lines.push('rank,team,school,played,wins,losses,points,fastest_lap');
    state.overallStandings.forEach((s, i) => lines.push([i + 1, csv(s.name), csv(s.school || ''), s.played, s.wins, s.losses, s.points, s.fastestLap ?? ''].join(',')));
    lines.push('');
    lines.push('# MATCHES');
    lines.push('match_number,stage,round,group,bonus,team_a,team_b,time_a,time_b,winner,completed');
    const byId = new Map(state.teams.map(t => [t.id, t.name]));
    for (const m of state.matches) {
      lines.push([
        m.matchNumber, m.stage, m.round ?? '',
        m.groupIndex ?? '', m.bonus ? 'yes' : '',
        csv(byId.get(m.teamAId) || ''), csv(byId.get(m.teamBId) || ''),
        m.timeA ?? '', m.timeB ?? '',
        csv(byId.get(m.winnerTeamId) || ''), m.completed ? 'yes' : 'no',
      ].join(','));
    }
    if (state.polePosition) {
      lines.push('');
      lines.push('# POLE POSITION');
      lines.push('team,time,match_number');
      lines.push([csv(state.polePosition.team?.name || ''), state.polePosition.time, state.polePosition.matchNumber].join(','));
    }
    res.setHeader('Content-Disposition', 'attachment; filename=f1-tournament-results.csv');
    res.setHeader('Content-Type', 'text/csv');
    return res.send(lines.join('\n'));
  }
  res.status(400).json({ error: 'Unknown format' });
});

app.get('/api/qr', async (req, res) => {
  const target = safeQrTarget(req.query.target);
  try {
    const png = await QRCode.toBuffer(target, {
      width: 512,
      margin: 1,
      color: { dark: '#ffffff', light: '#0000' },
    });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

function safeQrTarget(rawTarget) {
  const fallback = serverBaseUrl() + '/spectator';
  const allowedPaths = new Set(['/spectator', '/leaderboard', '/schedule', '/rotation']);
  const allowedHosts = new Set([
    `localhost:${PORT}`,
    `127.0.0.1:${PORT}`,
    ...networkAddresses().map(ip => `${ip}:${PORT}`),
  ]);

  try {
    const target = new URL(String(rawTarget || fallback), fallback);
    if (!allowedHosts.has(target.host)) return fallback;
    if (!allowedPaths.has(target.pathname.replace(/\/$/, '') || '/')) return fallback;
    return target.toString();
  } catch {
    return fallback;
  }
}

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    const message = err.field === 'backup'
      ? 'Backup ZIP must be 128 MB or smaller.'
      : 'Logo file must be 4 MB or smaller.';
    return res.status(400).json({ error: message });
  }
  if (err?.message === 'Logo must be a PNG or JPG image.' || err?.message === 'Backup must be a ZIP file.') {
    return res.status(400).json({ error: err.message });
  }
  console.error('[http] unexpected error:', err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

io.on('connection', (socket) => {
  socket.emit('state', buildState());
});

server.listen(PORT, HOST, () => {
  const urls = serverBaseUrls();
  const url = urls[0] || `http://localhost:${PORT}`;
  console.log('');
  console.log('  F1 in Schools Tournament Platform');
  console.log('  ==================================');
  console.log('  Open on this laptop:  http://localhost:' + PORT);
  console.log('  Spectator network:    ' + (urls.length ? urls.map(u => u + '/spectator').join(', ') : 'no LAN IPv4 address detected'));
  console.log('  Listening on:         ' + HOST + ':' + PORT);
  console.log('');
  console.log('  Admin panel:          http://localhost:' + PORT + '/admin');
  console.log('  Backups:              http://localhost:' + PORT + '/backups');
  console.log('  Race screen:          http://localhost:' + PORT + '/race');
  console.log('  Leaderboard:          http://localhost:' + PORT + '/leaderboard');
  console.log('  Schedule:             http://localhost:' + PORT + '/schedule');
  console.log('  Spectator menu:       ' + url + '/spectator');
  console.log('');
  backup.start();
});
