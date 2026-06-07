/**
 * Tournament engine — generates group stage + knockout schedule for 9-16 teams.
 *
 * Format: adapted World Cup
 *   - 9-12 teams  -> 2 groups, round-robin within group, top 4 each -> QF (8 teams)
 *   - 13-16 teams -> 4 groups, round-robin within group, top 2 each -> QF (8 teams)
 *   - Cross-group "bonus" matches added automatically so every team gets >= 5 matches.
 *   - Knockout stage: QF -> SF -> Final + 3rd-place match.
 *
 * Scoring: 3 points for a win, 1 point for a loss.
 * Tiebreak order: points desc, wins desc, fastest-lap asc, team name.
 */

const MIN_MATCHES_PER_TEAM = 5;
const FORMAT_LEAGUE_ONLY = 'league_only';
const FORMAT_LEAGUE_PLUS_KNOCKOUT = 'league_plus_knockout';
const FORMATS = new Set([FORMAT_LEAGUE_ONLY, FORMAT_LEAGUE_PLUS_KNOCKOUT]);
const DEFAULT_SCHEDULE_OPTIONS = Object.freeze({
  format: FORMAT_LEAGUE_PLUS_KNOCKOUT,
  targetMatchesPerTeam: MIN_MATCHES_PER_TEAM,
  grouping: 'auto',
});

function normalizeScheduleOptions(options = {}) {
  const raw = options && typeof options === 'object' ? options : {};
  const format = FORMATS.has(raw.format) ? raw.format : DEFAULT_SCHEDULE_OPTIONS.format;
  const parsedTarget = Number(raw.targetMatchesPerTeam);
  const targetMatchesPerTeam = Number.isInteger(parsedTarget) && parsedTarget >= 1
    ? Math.min(parsedTarget, 31)
    : DEFAULT_SCHEDULE_OPTIONS.targetMatchesPerTeam;
  return {
    format,
    targetMatchesPerTeam,
    grouping: 'auto',
  };
}

function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Split N teams into G groups as evenly as possible.
 * Returns array of arrays of team IDs.
 */
function splitIntoGroups(teamIds, numGroups) {
  const shuffled = shuffle(teamIds);
  const groups = Array.from({ length: numGroups }, () => []);
  shuffled.forEach((id, i) => groups[i % numGroups].push(id));
  return groups;
}

/**
 * Generate round-robin pairings for a group.
 * Uses circle method so pairings are spread across rounds (teams rest between matches).
 */
function roundRobin(teams) {
  const list = [...teams];
  if (list.length % 2 === 1) list.push(null); // BYE placeholder
  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairings = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a !== null && b !== null) pairings.push([a, b]);
    }
    rounds.push(pairings);
    // rotate (keep first fixed)
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

/**
 * Build the full group stage schedule (interleaved across groups so each round
 * advances all groups roughly together, which feels better on the big screen).
 */
function buildGroupStage(groups, { targetMatchesPerTeam = null } = {}) {
  const perGroupRounds = groups.map((group) => {
    const rounds = roundRobin(group);
    if (targetMatchesPerTeam == null) return rounds;
    return rounds.slice(0, Math.min(rounds.length, targetMatchesPerTeam));
  });
  const matches = [];
  const maxRounds = Math.max(...perGroupRounds.map(r => r.length));
  let matchNum = 1;
  for (let r = 0; r < maxRounds; r++) {
    for (let g = 0; g < groups.length; g++) {
      const groupRound = perGroupRounds[g][r];
      if (!groupRound) continue;
      for (const [a, b] of groupRound) {
        matches.push({
          matchNumber: matchNum++,
          stage: 'group',
          groupIndex: g,
          round: r + 1,
          teamAId: a,
          teamBId: b,
          bonus: 0,
        });
      }
    }
  }
  return matches;
}

/**
 * Count how many matches each team currently has scheduled.
 */
function countMatches(matches, teamIds = []) {
  const counts = new Map(teamIds.map(id => [id, 0]));
  for (const m of matches) {
    counts.set(m.teamAId, (counts.get(m.teamAId) || 0) + 1);
    counts.set(m.teamBId, (counts.get(m.teamBId) || 0) + 1);
  }
  return counts;
}

/**
 * Add cross-group matches until every team has at least MIN_MATCHES_PER_TEAM.
 * Pairs lowest-match teams across different groups without repeating pairings.
 */
function addBonusMatches(matches, groups, teamToGroup, startMatchNum, targetMatchesPerTeam = MIN_MATCHES_PER_TEAM) {
  const counts = countMatches(matches, groups.flat());
  const existingPairs = new Set(
    matches.map(m => [m.teamAId, m.teamBId].sort((a, b) => a - b).join(':'))
  );
  let matchNum = startMatchNum;

  const pairKey = (a, b) => [a, b].sort((x, y) => x - y).join(':');

  let safety = 500;
  while (safety-- > 0) {
    // find teams below threshold, sorted by match count asc
    const needy = [...counts.entries()]
      .filter(([, c]) => c < targetMatchesPerTeam)
      .sort((a, b) => a[1] - b[1]);
    if (needy.length === 0) break;

    const [teamA] = needy[0];
    // find a partner in a different group, also ideally below threshold, not yet paired
    const candidates = [...counts.entries()]
      .filter(([id, c]) => id !== teamA
        && teamToGroup.get(id) !== teamToGroup.get(teamA)
        && !existingPairs.has(pairKey(teamA, id)))
      .sort((a, b) => a[1] - b[1]);
    if (candidates.length === 0) {
      // no cross-group partner available — fall back to any partner (different team, not paired)
      const fallback = [...counts.entries()]
        .filter(([id]) => id !== teamA && !existingPairs.has(pairKey(teamA, id)))
        .sort((a, b) => a[1] - b[1]);
      if (fallback.length === 0) break; // fully saturated
      const [teamB] = fallback[0];
      matches.push({
        matchNumber: matchNum++, stage: 'group', groupIndex: -1,
        round: 99, teamAId: teamA, teamBId: teamB, bonus: 1,
      });
      existingPairs.add(pairKey(teamA, teamB));
      counts.set(teamA, (counts.get(teamA) || 0) + 1);
      counts.set(teamB, (counts.get(teamB) || 0) + 1);
      continue;
    }
    const [teamB] = candidates[0];
    matches.push({
      matchNumber: matchNum++, stage: 'group', groupIndex: -1,
      round: 99, teamAId: teamA, teamBId: teamB, bonus: 1,
    });
    existingPairs.add(pairKey(teamA, teamB));
    counts.set(teamA, (counts.get(teamA) || 0) + 1);
    counts.set(teamB, (counts.get(teamB) || 0) + 1);
  }
  return matchNum;
}

/**
 * Re-number and reorder matches so that the same team never races twice in a row.
 * Simple greedy: pick the next match whose teams haven't just raced.
 */
function avoidBackToBack(matches) {
  const remaining = [...matches];
  const ordered = [];
  const lastRaced = new Map(); // teamId -> index of last race
  while (remaining.length) {
    let chosenIdx = -1;
    for (let i = 0; i < remaining.length; i++) {
      const m = remaining[i];
      const aLast = lastRaced.get(m.teamAId);
      const bLast = lastRaced.get(m.teamBId);
      // prefer matches where both teams have rested at least 1 slot
      if ((aLast === undefined || ordered.length - aLast > 1)
        && (bLast === undefined || ordered.length - bLast > 1)) {
        chosenIdx = i;
        break;
      }
    }
    if (chosenIdx === -1) chosenIdx = 0; // fallback
    const m = remaining.splice(chosenIdx, 1)[0];
    ordered.push(m);
    lastRaced.set(m.teamAId, ordered.length - 1);
    lastRaced.set(m.teamBId, ordered.length - 1);
  }
  ordered.forEach((m, i) => { m.matchNumber = i + 1; });
  return ordered;
}

/**
 * Top-level: generate the full group stage schedule.
 * Knockout matches are created later once group results are final.
 */
function buildScheduleSummary({ teamCount, groups, matches, options, warnings = [] }) {
  const counts = countMatches(matches, groups.flat());
  const values = [...counts.values()];
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const average = values.length
    ? Math.round((values.reduce((sum, count) => sum + count, 0) / values.length) * 10) / 10
    : 0;
  return {
    format: options.format,
    targetMatchesPerTeam: options.targetMatchesPerTeam,
    knockoutEnabled: options.format === FORMAT_LEAGUE_PLUS_KNOCKOUT,
    grouping: options.grouping,
    teamCount,
    groups: groups.length,
    totalMatches: matches.length,
    approxMatchesPerTeam: { min, max, average },
    warnings,
  };
}

function summarizeExistingSchedule({ teamCount, groups, matches, options }) {
  return buildScheduleSummary({
    teamCount,
    groups,
    matches,
    options: normalizeScheduleOptions(options),
  });
}

function generateSchedule(teamIds, options = {}) {
  if (teamIds.length < 4) {
    throw new Error(`Need at least 4 teams to run a tournament (got ${teamIds.length}).`);
  }
  if (teamIds.length > 32) {
    throw new Error(`This platform supports up to 32 teams (got ${teamIds.length}).`);
  }
  const normalizedOptions = normalizeScheduleOptions(options);
  const hasExplicitTarget = options
    && typeof options === 'object'
    && Object.prototype.hasOwnProperty.call(options, 'targetMatchesPerTeam');
  const n = teamIds.length;
  // 4-8 teams: single group, round-robin, top 4 -> SF. Still guarantees 3-7 matches each.
  // 9-12: 2 groups, top 4 each -> QF
  // 13-16: 4 groups, top 2 each -> QF
  // 17-32: 4 groups, top 2 each -> QF  (stretch support; not officially promised)
  let numGroups;
  if (n <= 8) numGroups = 1;
  else if (n <= 12) numGroups = 2;
  else numGroups = 4;

  const groups = splitIntoGroups(teamIds, numGroups);
  const teamToGroup = new Map();
  groups.forEach((g, i) => g.forEach(id => teamToGroup.set(id, i)));

  let matches = buildGroupStage(groups, {
    targetMatchesPerTeam: hasExplicitTarget ? normalizedOptions.targetMatchesPerTeam : null,
  });
  addBonusMatches(matches, groups, teamToGroup, matches.length + 1, normalizedOptions.targetMatchesPerTeam);
  matches = avoidBackToBack(matches);
  const counts = countMatches(matches, teamIds);
  const warnings = [];
  const minMatches = Math.min(...counts.values());
  if (minMatches < normalizedOptions.targetMatchesPerTeam) {
    warnings.push(`Requested ${normalizedOptions.targetMatchesPerTeam} matches per team; the schedule could not reach that without repeat pairings for this team count.`);
  }
  const summary = buildScheduleSummary({
    teamCount: n,
    groups,
    matches,
    options: normalizedOptions,
    warnings,
  });

  return {
    numGroups,
    groups,
    matches,
    options: normalizedOptions,
    knockoutEnabled: normalizedOptions.format === FORMAT_LEAGUE_PLUS_KNOCKOUT,
    summary,
  };
}

/**
 * Compute standings from completed matches.
 * Returns array sorted by: points desc, wins desc, fastestLap asc (nulls last), name.
 */
function computeStandings(teams, matches, { stage = 'group' } = {}) {
  const stats = new Map(teams.map(t => [t.id, {
    teamId: t.id,
    name: t.name,
    school: t.school,
    color: t.color,
    logoPath: t.logoPath,
    played: 0,
    wins: 0,
    losses: 0,
    points: 0,
    fastestLap: null,
    groupIndex: null,
  }]));

  const relevant = stage === 'all'
    ? matches
    : matches.filter(m => m.stage === stage);

  for (const m of relevant) {
    if (!m.completed) continue;
    const a = stats.get(m.teamAId);
    const b = stats.get(m.teamBId);
    if (!a || !b) continue;
    a.played++; b.played++;
    if (m.timeA != null && (a.fastestLap == null || m.timeA < a.fastestLap)) a.fastestLap = m.timeA;
    if (m.timeB != null && (b.fastestLap == null || m.timeB < b.fastestLap)) b.fastestLap = m.timeB;
    if (m.winnerTeamId === m.teamAId) {
      a.wins++; a.points += 3;
      b.losses++; b.points += 1;
    } else if (m.winnerTeamId === m.teamBId) {
      b.wins++; b.points += 3;
      a.losses++; a.points += 1;
    }
  }

  const arr = [...stats.values()];
  arr.sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    if (y.wins !== x.wins) return y.wins - x.wins;
    const fx = x.fastestLap == null ? Infinity : x.fastestLap;
    const fy = y.fastestLap == null ? Infinity : y.fastestLap;
    if (fx !== fy) return fx - fy;
    return x.name.localeCompare(y.name);
  });
  return arr;
}

function recordTeamResult(stats, match, side) {
  const teamId = side === 'a' ? match.teamAId : match.teamBId;
  const time = side === 'a' ? match.timeA : match.timeB;
  const opponentId = side === 'a' ? match.teamBId : match.teamAId;
  const row = stats.get(teamId);
  if (!row) return;
  row.played++;
  if (time != null && (row.fastestLap == null || time < row.fastestLap)) row.fastestLap = time;
  if (match.winnerTeamId === teamId) {
    row.wins++;
    row.points += 3;
  } else if (match.winnerTeamId === opponentId) {
    row.losses++;
    row.points += 1;
  }
}

function sortStandings(stats) {
  const arr = [...stats.values()];
  arr.sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    if (y.wins !== x.wins) return y.wins - x.wins;
    const fx = x.fastestLap == null ? Infinity : x.fastestLap;
    const fy = y.fastestLap == null ? Infinity : y.fastestLap;
    if (fx !== fy) return fx - fy;
    return x.name.localeCompare(y.name);
  });
  return arr;
}

/**
 * Return the team with the single fastest lap time across all completed matches.
 */
function computePolePosition(teams, matches) {
  const byId = new Map(teams.map(t => [t.id, t]));
  let best = null; // { team, time, matchNumber }
  for (const m of matches) {
    if (!m.completed) continue;
    if (m.timeA != null) {
      if (!best || m.timeA < best.time) best = { team: byId.get(m.teamAId), time: m.timeA, matchNumber: m.matchNumber };
    }
    if (m.timeB != null) {
      if (!best || m.timeB < best.time) best = { team: byId.get(m.teamBId), time: m.timeB, matchNumber: m.matchNumber };
    }
  }
  return best;
}

/**
 * Standings per group, each group independently sorted.
 */
function computeGroupStandings(teams, matches, groupAssignments) {
  // groupAssignments: Map<teamId, groupIndex>
  const groupsOf = new Map();
  for (const [teamId, gi] of groupAssignments.entries()) {
    if (!groupsOf.has(gi)) groupsOf.set(gi, []);
    const team = teams.find(t => t.id === teamId);
    if (team) groupsOf.get(gi).push(team);
  }
  const out = [];
  for (const [gi, groupTeams] of [...groupsOf.entries()].sort((a, b) => a[0] - b[0])) {
    const stats = new Map(groupTeams.map(t => [t.id, {
      teamId: t.id,
      name: t.name,
      school: t.school,
      color: t.color,
      logoPath: t.logoPath,
      played: 0,
      wins: 0,
      losses: 0,
      points: 0,
      fastestLap: null,
      groupIndex: gi,
    }]));
    for (const m of matches) {
      if (m.stage !== 'group' || !m.completed) continue;
      recordTeamResult(stats, m, 'a');
      recordTeamResult(stats, m, 'b');
    }
    const standings = sortStandings(stats);
    standings.forEach(s => { s.groupIndex = gi; });
    out.push({ groupIndex: gi, standings });
  }
  return out;
}

/**
 * Build the knockout bracket seedings.
 * 1 group  -> top 4 -> SF (2 matches) -> Final + 3rd place
 * 2 groups -> top 4 each = 8 -> QF -> SF -> Final + 3rd place
 * 4 groups -> top 2 each = 8 -> QF -> SF -> Final + 3rd place
 *
 * Seeding (8-team):  1A v 2B | 1C v 2D | 1B v 2A | 1D v 2C  (adapted for 2 groups)
 */
function buildKnockoutBracket(groupStandings, startMatchNum) {
  const numGroups = groupStandings.length;
  const matches = [];
  let mn = startMatchNum;

  if (numGroups === 1) {
    // top 4 -> SF1 (1v4), SF2 (2v3), winners -> Final, losers -> 3rd place
    const top = groupStandings[0].standings.slice(0, 4);
    if (top.length < 4) return matches;
    matches.push({ matchNumber: mn++, stage: 'knockout', round: 'SF', bracketSlot: 'SF1', teamAId: top[0].teamId, teamBId: top[3].teamId, bonus: 0 });
    matches.push({ matchNumber: mn++, stage: 'knockout', round: 'SF', bracketSlot: 'SF2', teamAId: top[1].teamId, teamBId: top[2].teamId, bonus: 0 });
    matches.push({ matchNumber: mn++, stage: 'knockout', round: '3rd', bracketSlot: 'B3', teamAId: null, teamBId: null, bonus: 0, dependsOn: ['SF1-loser', 'SF2-loser'] });
    matches.push({ matchNumber: mn++, stage: 'knockout', round: 'Final', bracketSlot: 'FINAL', teamAId: null, teamBId: null, bonus: 0, dependsOn: ['SF1-winner', 'SF2-winner'] });
    return matches;
  }

  if (numGroups === 2) {
    // Top 4 from each group -> 8-team bracket
    const A = groupStandings[0].standings.slice(0, 4);
    const B = groupStandings[1].standings.slice(0, 4);
    if (A.length < 4 || B.length < 4) return matches;
    // QF pairings: 1A v 4B, 2B v 3A, 1B v 4A, 2A v 3B
    const qf = [
      ['QF1', A[0], B[3]],
      ['QF2', B[1], A[2]],
      ['QF3', B[0], A[3]],
      ['QF4', A[1], B[2]],
    ];
    for (const [slot, x, y] of qf) {
      matches.push({ matchNumber: mn++, stage: 'knockout', round: 'QF', bracketSlot: slot, teamAId: x.teamId, teamBId: y.teamId, bonus: 0 });
    }
    matches.push({ matchNumber: mn++, stage: 'knockout', round: 'SF', bracketSlot: 'SF1', teamAId: null, teamBId: null, bonus: 0, dependsOn: ['QF1-winner', 'QF2-winner'] });
    matches.push({ matchNumber: mn++, stage: 'knockout', round: 'SF', bracketSlot: 'SF2', teamAId: null, teamBId: null, bonus: 0, dependsOn: ['QF3-winner', 'QF4-winner'] });
    matches.push({ matchNumber: mn++, stage: 'knockout', round: '3rd', bracketSlot: 'B3', teamAId: null, teamBId: null, bonus: 0, dependsOn: ['SF1-loser', 'SF2-loser'] });
    matches.push({ matchNumber: mn++, stage: 'knockout', round: 'Final', bracketSlot: 'FINAL', teamAId: null, teamBId: null, bonus: 0, dependsOn: ['SF1-winner', 'SF2-winner'] });
    return matches;
  }

  if (numGroups === 4) {
    // Top 2 from each group -> 8-team bracket
    const pools = groupStandings.map(gs => gs.standings.slice(0, 2));
    if (pools.some(p => p.length < 2)) return matches;
    // QF: 1A v 2B, 1C v 2D, 1B v 2A, 1D v 2C
    const qf = [
      ['QF1', pools[0][0], pools[1][1]],
      ['QF2', pools[2][0], pools[3][1]],
      ['QF3', pools[1][0], pools[0][1]],
      ['QF4', pools[3][0], pools[2][1]],
    ];
    for (const [slot, x, y] of qf) {
      matches.push({ matchNumber: mn++, stage: 'knockout', round: 'QF', bracketSlot: slot, teamAId: x.teamId, teamBId: y.teamId, bonus: 0 });
    }
    matches.push({ matchNumber: mn++, stage: 'knockout', round: 'SF', bracketSlot: 'SF1', teamAId: null, teamBId: null, bonus: 0, dependsOn: ['QF1-winner', 'QF2-winner'] });
    matches.push({ matchNumber: mn++, stage: 'knockout', round: 'SF', bracketSlot: 'SF2', teamAId: null, teamBId: null, bonus: 0, dependsOn: ['QF3-winner', 'QF4-winner'] });
    matches.push({ matchNumber: mn++, stage: 'knockout', round: '3rd', bracketSlot: 'B3', teamAId: null, teamBId: null, bonus: 0, dependsOn: ['SF1-loser', 'SF2-loser'] });
    matches.push({ matchNumber: mn++, stage: 'knockout', round: 'Final', bracketSlot: 'FINAL', teamAId: null, teamBId: null, bonus: 0, dependsOn: ['SF1-winner', 'SF2-winner'] });
    return matches;
  }

  return matches;
}

module.exports = {
  MIN_MATCHES_PER_TEAM,
  FORMAT_LEAGUE_ONLY,
  FORMAT_LEAGUE_PLUS_KNOCKOUT,
  DEFAULT_SCHEDULE_OPTIONS,
  normalizeScheduleOptions,
  generateSchedule,
  countMatches,
  summarizeExistingSchedule,
  computeStandings,
  computeGroupStandings,
  computePolePosition,
  buildKnockoutBracket,
  shuffle,
};
