#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const tournament = require('../src/tournament');
const security = require('../src/security');
const networkAccess = require('../src/networkAccess');
const { csvCell } = require('../src/export');
const portableBackup = require('../src/portableBackup');
const backupScheduler = require('../src/backup');
const corrections = require('../src/matchCorrections');

const ROOT = path.join(__dirname, '..');

function analyzeSchedule(teamCount) {
  const ids = Array.from({ length: teamCount }, (_, i) => i + 1);
  const plan = tournament.generateSchedule(ids);
  const counts = new Map(ids.map(id => [id, 0]));
  const pairs = new Set();

  for (const match of plan.matches) {
    counts.set(match.teamAId, counts.get(match.teamAId) + 1);
    counts.set(match.teamBId, counts.get(match.teamBId) + 1);
    const pairKey = [match.teamAId, match.teamBId].sort((a, b) => a - b).join(':');
    assert(!pairs.has(pairKey), `duplicate pairing detected for ${pairKey} with ${teamCount} teams`);
    pairs.add(pairKey);
  }

  const perTeam = [...counts.values()].sort((a, b) => a - b);
  assert.equal(perTeam.length, teamCount, `missing team counts for ${teamCount} teams`);
  assert(perTeam[0] >= Math.min(teamCount - 1, tournament.MIN_MATCHES_PER_TEAM),
    `team count floor violated for ${teamCount} teams`);
  assert(perTeam.at(-1) - perTeam[0] <= 1,
    `schedule balance drifted for ${teamCount} teams`);
  return plan;
}

for (let teamCount = 4; teamCount <= 32; teamCount++) {
  analyzeSchedule(teamCount);
}

const teams12 = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  name: `Team ${i + 1}`,
  school: 'School',
  color: '#00e6d2',
  logoPath: null,
}));
const plan12 = tournament.generateSchedule(teams12.map(team => team.id));
const groupMap12 = new Map();
plan12.groups.forEach((group, groupIndex) => {
  group.forEach(teamId => groupMap12.set(teamId, groupIndex));
});
const completed12 = plan12.matches.map(match => ({
  ...match,
  timeA: 1 + match.teamAId * 0.01,
  timeB: 1 + match.teamBId * 0.01,
  winnerTeamId: match.teamAId < match.teamBId ? match.teamAId : match.teamBId,
  completed: true,
}));
const standings12 = tournament.computeGroupStandings(teams12, completed12, groupMap12);
assert.equal(standings12.length, 2, '12-team schedule should produce 2 groups');
assert.equal(tournament.buildKnockoutBracket(standings12, completed12.length + 1).length, 8,
  '12-team schedule should produce an 8-match knockout bracket');
const pole = tournament.computePolePosition(teams12, completed12);
assert.equal(pole.team.id, 1, 'pole position should belong to the fastest team');

const oneBonusMatch = {
  matchNumber: 999,
  stage: 'group',
  groupIndex: -1,
  bonus: 1,
  teamAId: plan12.groups[0][0],
  teamBId: plan12.groups[1][0],
  timeA: 1.1,
  timeB: 1.2,
  winnerTeamId: plan12.groups[0][0],
  completed: true,
};
const standingsWithBonus = tournament.computeGroupStandings(teams12, [oneBonusMatch], groupMap12);
const bonusWinnerGroup = groupMap12.get(oneBonusMatch.teamAId);
const bonusWinnerStats = standingsWithBonus
  .find(group => group.groupIndex === bonusWinnerGroup)
  .standings.find(stats => stats.teamId === oneBonusMatch.teamAId);
assert.equal(bonusWinnerStats.played, 1, 'cross-group bonus races should count in each team group standings');
assert.equal(bonusWinnerStats.points, 3, 'cross-group bonus race winner should receive group-standing points');

const teams8 = Array.from({ length: 8 }, (_, i) => ({
  id: i + 1,
  name: `Solo ${i + 1}`,
  school: 'School',
  color: '#ff2e92',
  logoPath: null,
}));
const plan8 = tournament.generateSchedule(teams8.map(team => team.id));
const groupMap8 = new Map();
plan8.groups.forEach((group, groupIndex) => {
  group.forEach(teamId => groupMap8.set(teamId, groupIndex));
});
const completed8 = plan8.matches.map(match => ({
  ...match,
  timeA: 2 + match.teamAId * 0.01,
  timeB: 2 + match.teamBId * 0.01,
  winnerTeamId: match.teamAId < match.teamBId ? match.teamAId : match.teamBId,
  completed: true,
}));
const standings8 = tournament.computeGroupStandings(teams8, completed8, groupMap8);
assert.equal(standings8.length, 1, '8-team schedule should produce 1 group');
assert.equal(tournament.buildKnockoutBracket(standings8, completed8.length + 1).length, 4,
  '8-team schedule should produce a 4-match knockout bracket');

const leagueOnlyPlan = tournament.generateSchedule(
  Array.from({ length: 12 }, (_, i) => i + 1),
  { format: 'league_only', targetMatchesPerTeam: 3 }
);
assert.equal(leagueOnlyPlan.options.format, 'league_only',
  'schedule options should preserve explicit league-only format');
assert.equal(leagueOnlyPlan.summary.knockoutEnabled, false,
  'league-only mode should disable knockout generation');
const leagueOnlyCounts = tournament.countMatches(leagueOnlyPlan.matches);
assert.deepEqual([...leagueOnlyCounts.values()].sort((a, b) => a - b), Array(12).fill(3),
  '12-team league-only target of 3 should produce exactly 3 matches per team');

const highTargetPlan = tournament.generateSchedule(
  [1, 2, 3, 4],
  { format: 'league_plus_knockout', targetMatchesPerTeam: 10 }
);
assert.equal(highTargetPlan.summary.approxMatchesPerTeam.min, 3,
  'impossible high target should clamp to available unique pairings');
assert(highTargetPlan.summary.warnings.some(msg => /could not reach/i.test(msg)),
  'impossible high target should explain that the requested target was not reachable');

assert.equal(tournament.normalizeScheduleOptions({ format: 'bad', targetMatchesPerTeam: 'bad' }).format, 'league_plus_knockout',
  'invalid stored format options should fall back to the current default behavior');

assert.throws(
  () => corrections.parseCorrectedTimes({ timeA: '1.234', timeB: '1.234' }),
  /tied/i,
  'result corrections should reject exact ties'
);
const correctionMatch = { id: 1, matchNumber: 4, stage: 'knockout', bracketSlot: 'QF1', completed: true, teamAId: 1, teamBId: 2 };
const downstreamCompleted = [
  correctionMatch,
  { id: 2, matchNumber: 5, stage: 'knockout', bracketSlot: 'SF1', dependsOn: ['QF1-winner', 'QF2-winner'], completed: true },
];
assert.equal(corrections.canCorrectMatch(correctionMatch, downstreamCompleted).ok, false,
  'knockout corrections should be blocked when completed downstream matches depend on the result');
const downstreamOpen = [
  correctionMatch,
  { id: 2, matchNumber: 5, stage: 'knockout', bracketSlot: 'SF1', dependsOn: ['QF1-winner', 'QF2-winner'], completed: false },
  { id: 3, matchNumber: 6, stage: 'knockout', bracketSlot: 'FINAL', dependsOn: ['SF1-winner', 'SF2-winner'], completed: false },
];
assert.deepEqual(corrections.downstreamKnockoutMatches(correctionMatch, downstreamOpen).map(m => m.bracketSlot), ['SF1', 'FINAL'],
  'knockout corrections should identify every unresolved downstream pairing to clear');
const blockedGroupCorrection = corrections.canCorrectMatch(
  { id: 10, matchNumber: 2, stage: 'group', completed: true },
  [{ id: 11, matchNumber: 40, stage: 'knockout', completed: true }]
);
assert.equal(blockedGroupCorrection.ok, false,
  'group corrections should be blocked after knockout results have completed');

assert.equal(security.requireAdmin, undefined, 'admin pages should not require a password in school-event mode');
assert.equal(security.isAuthorizedBasic, undefined, 'Basic auth should not be part of school-event mode');
const remoteRequest = (requestPath, { method = 'GET', query = {}, remoteAddress = '192.168.1.40' } = {}) => ({
  path: requestPath,
  method,
  query,
  socket: { remoteAddress },
  ip: remoteAddress,
});
assert.equal(networkAccess.isLocalRequest(remoteRequest('/admin', { remoteAddress: '127.0.0.1' })), true,
  'loopback requests should be treated as local organiser access');
assert.equal(networkAccess.spectatorRedirectPath(remoteRequest('/')), '/spectator',
  'remote root requests should redirect to the spectator menu');
assert.equal(networkAccess.spectatorRedirectPath(remoteRequest('/leaderboard')), '/leaderboard?spectator=1',
  'remote leaderboard requests should be forced into spectator mode');
assert.equal(networkAccess.spectatorRedirectPath(remoteRequest('/leaderboard', { query: { spectator: '1' } })), null,
  'remote spectator leaderboard requests should not redirect repeatedly');
assert.equal(networkAccess.spectatorRedirectPath(remoteRequest('/rotation')), null,
  'remote rotation display should not be redirected away from the rotation page');
for (const page of ['/admin', '/backups', '/race', '/bracket', '/overlay']) {
  assert.equal(networkAccess.isRestrictedNetworkRequest(remoteRequest(page)), true,
    `remote clients should not be allowed to open ${page}`);
}
assert.equal(networkAccess.isRestrictedNetworkRequest(remoteRequest('/rotation')), false,
  'remote clients should be allowed to open the read-only rotation display');
assert.equal(networkAccess.isRestrictedNetworkRequest(remoteRequest('/api/state')), false,
  'remote spectator screens should be allowed to read live state');
assert.equal(networkAccess.isRestrictedNetworkRequest(remoteRequest('/api/race/mode', { method: 'POST' })), true,
  'remote clients should not be allowed to mutate race mode');
assert.equal(networkAccess.isRestrictedNetworkRequest(remoteRequest('/api/export/csv')), true,
  'remote clients should not be allowed to export tournament data');
assert.equal(
  security.detectImageKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'png',
  'PNG magic bytes should be accepted'
);
assert.equal(
  security.detectImageKind(Buffer.from('<svg onload=alert(1)>')),
  null,
  'SVG/HTML uploads should not be accepted as logos'
);
assert.equal(csvCell('=SUM(A1:A2)'), "'=SUM(A1:A2)", 'CSV cells that look like formulas should be neutralized');
assert.equal(csvCell('Team, Alpha'), '"Team, Alpha"', 'CSV cells with commas should still be quoted');

const requiredMedia = [
  'stem-racing-logo-dark.png',
  'stem-racing-logo-light.jpg',
  'stem-racing-banner.jpg',
  'espire.svg',
  'race-hero.jpg',
  'race-alt.jpg',
  'workshop-build.jpg',
  'workshop-action.jpg',
  'poster-brand.jpg',
];
for (const file of requiredMedia) {
  const fullPath = path.join(ROOT, 'public/assets/media', file);
  assert(fs.existsSync(fullPath), `missing public media asset: ${file}`);
  assert(fs.statSync(fullPath).size > 1024, `public media asset is unexpectedly tiny: ${file}`);
}

const styles = fs.readFileSync(path.join(ROOT, 'public/assets/styles.css'), 'utf8');
assert(styles.includes('.media-head'), 'shared CSS should include media header styles');
assert(styles.includes('/assets/media/race-hero.jpg'), 'shared CSS should reference race hero media');
assert(styles.includes('.launcher-logo'), 'shared CSS should include launcher logo styling');
assert(styles.includes('.sound-toggle'), 'shared CSS should include the sound toggle styling');
assert(styles.includes('.segmented-control'), 'shared CSS should include segmented controls for backup mode');

const common = fs.readFileSync(path.join(ROOT, 'public/assets/common.js'), 'utf8');
assert(common.includes('/assets/media/stem-racing-logo-dark.png'), 'topbar should use the STEM Racing logo asset');
assert(common.includes('/assets/audio.js'), 'shared UI should load the Web Audio engine');
assert(common.includes('data-sound-toggle'), 'shared UI should expose a sound toggle');

const audio = fs.readFileSync(path.join(ROOT, 'public/assets/audio.js'), 'utf8');
assert(audio.includes('uiSound'), 'audio engine should expose UI sound effects');
assert(audio.includes('uiBackup'), 'audio engine should include a backup/export sound');

assert.equal(typeof AdmZip, 'function', 'adm-zip should be available for portable backups');
assert.equal(typeof portableBackup.createBackupZip, 'function', 'portable backup module should create ZIPs');
assert.equal(typeof portableBackup.restoreFromZip, 'function', 'portable backup module should restore ZIPs');
assert.equal(typeof portableBackup.listLocalBackups, 'function', 'portable backup module should list local backups');
assert.equal(typeof portableBackup.clearLocalBackups, 'function', 'portable backup module should clear local backups');
assert.equal(typeof portableBackup.validateZipEntryName, 'function', 'portable backup module should validate ZIP paths');
assert.equal(typeof portableBackup.validateBackupBuffer, 'function', 'portable backup module should validate backup contents');
assert.equal(typeof portableBackup.findMissingLogoReferences, 'function',
  'portable backup module should expose missing-logo reference detection for safe legacy restores');
assert.equal(typeof backupScheduler.backupOnce, 'function', 'backup scheduler should support manual local backups');
assert.equal(typeof backupScheduler.getStatus, 'function', 'backup scheduler should report backup mode');
assert.equal(typeof backupScheduler.setMode, 'function', 'backup scheduler should update backup mode');
assert.throws(() => portableBackup.validateZipEntryName('../bad.db'), /Invalid backup entry/);
assert.throws(() => portableBackup.validateZipEntryName('/bad.db'), /Invalid backup entry/);
assert.doesNotThrow(() => portableBackup.validateZipEntryName('logos/team.png'));
assert(fs.existsSync(path.join(ROOT, 'public/backups.html')), 'admin Backups page should exist');
const backupsPage = fs.readFileSync(path.join(ROOT, 'public/backups.html'), 'utf8');
assert(backupsPage.includes('Delete All Backups'), 'Backups page should expose a delete-all backup action');
assert(backupsPage.includes("F1.api('DELETE', '/api/backups')"), 'Backups page should call the delete-all backup API');
assert(backupsPage.includes('Auto Backup'), 'Backups page should expose auto backup mode');
assert(backupsPage.includes('Manual Backup'), 'Backups page should expose manual backup mode');
assert(backupsPage.includes("F1.api('POST', '/api/backups/mode'"), 'Backups page should call the backup mode API');
assert(backupsPage.includes("F1.api('POST', '/api/backups/run'"), 'Backups page should call the manual backup API');
assert(backupsPage.includes('Database-only'), 'Backups page should warn clearly about database-only restores');

const rotationPagePath = path.join(ROOT, 'public/rotation.html');
assert(fs.existsSync(rotationPagePath), 'rotation display page should exist');
const rotationPage = fs.readFileSync(rotationPagePath, 'utf8');
assert(rotationPage.includes('Event Live Rotation'), 'rotation page should show a clear public display title');
assert(rotationPage.includes('setInterval'), 'rotation page should advance automatically');
assert(rotationPage.includes('keydown'), 'rotation page should support keyboard/manual advance');
assert(common.includes('/rotation'), 'topbar should link to the rotation display');
const spectatorPage = fs.readFileSync(path.join(ROOT, 'public/spectator.html'), 'utf8');
assert(spectatorPage.includes('/rotation'), 'spectator menu should link to the rotation display');

async function runPortableBackupChecks() {
  const logoDir = path.join(ROOT, 'data/logos');
  fs.mkdirSync(logoDir, { recursive: true });
  const sampleLogo = path.join(logoDir, 'smoke-backup-logo.txt');
  fs.writeFileSync(sampleLogo, 'sample logo payload');
  try {
    const withLogos = await portableBackup.createBackupZip({ includeLogos: true });
    assert(withLogos.filename.endsWith('.zip'), 'backup filename should end in .zip');
    const zipWithLogos = new AdmZip(withLogos.buffer);
    assert(zipWithLogos.getEntry('manifest.json'), 'backup ZIP should include manifest.json');
    assert(zipWithLogos.getEntry('tournament.db'), 'backup ZIP should include tournament.db');
    assert(zipWithLogos.getEntry('logos/smoke-backup-logo.txt'), 'backup ZIP should include logos when requested');
    const manifest = JSON.parse(zipWithLogos.readAsText('manifest.json'));
    assert.equal(manifest.type, 'f1-stem-racing-backup', 'backup manifest should have the expected type');
    assert.equal(manifest.sections.logos, true, 'backup manifest should record included logos');

    const withoutLogos = await portableBackup.createBackupZip({ includeLogos: false });
    const zipWithoutLogos = new AdmZip(withoutLogos.buffer);
    assert(!zipWithoutLogos.getEntries().some(entry => entry.entryName.startsWith('logos/')),
      'backup ZIP should omit logos when unchecked');
    const manifestWithoutLogos = JSON.parse(zipWithoutLogos.readAsText('manifest.json'));
    assert.equal(manifestWithoutLogos.sections.logos, false, 'backup manifest should record omitted logos');

    const corruptDbPath = path.join(ROOT, 'data', `smoke-corrupt-${process.pid}.db`);
    fs.writeFileSync(corruptDbPath, zipWithoutLogos.getEntry('tournament.db').getData());
    const corruptDb = new Database(corruptDbPath);
    try {
      corruptDb.prepare(`
        INSERT INTO matches (match_number, stage, round, depends_on, bonus, completed)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(9001, 'knockout', 'Final', 'not-json', 0, 0);
    } finally {
      corruptDb.close();
    }
    const corruptZip = new AdmZip();
    corruptZip.addFile('manifest.json', zipWithoutLogos.getEntry('manifest.json').getData());
    corruptZip.addFile('tournament.db', fs.readFileSync(corruptDbPath));
    assert.throws(
      () => portableBackup.validateBackupBuffer(corruptZip.toBuffer()),
      /Invalid backup match dependency/,
      'backup validation should reject corrupt match dependency JSON before restore'
    );
    fs.rmSync(corruptDbPath, { force: true });
  } finally {
    fs.rmSync(sampleLogo, { force: true });
  }
}

runPortableBackupChecks()
  .then(() => console.log('Smoke tests passed.'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
