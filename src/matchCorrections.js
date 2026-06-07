const MAX_RACE_TIME_SECONDS = 300;

function parseCorrectedTimes(body = {}) {
  const timeA = parseRequiredRaceTime(body.timeA, 'Lane A time');
  const timeB = parseRequiredRaceTime(body.timeB, 'Lane B time');
  if (timeA === timeB) {
    throw new Error('Times are tied. Enter a more precise result or rerun the race.');
  }
  return { timeA, timeB };
}

function parseRequiredRaceTime(value, label) {
  if (value === '' || value == null) throw new Error(`${label} required.`);
  const time = Number(value);
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid number.`);
  if (time <= 0) throw new Error(`${label} must be greater than 0.`);
  if (time > MAX_RACE_TIME_SECONDS) throw new Error(`${label} looks too large.`);
  return Math.round(time * 1000) / 1000;
}

function calculateWinnerTeamId(match, { timeA, timeB }) {
  if (!match || match.teamAId == null || match.teamBId == null) {
    throw new Error('Match teams are not available.');
  }
  return timeA < timeB ? match.teamAId : match.teamBId;
}

function downstreamKnockoutMatches(match, matches) {
  if (!match || match.stage !== 'knockout' || !match.bracketSlot) return [];
  const sourceSlots = new Set([match.bracketSlot]);
  const downstream = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of matches) {
      if (candidate.stage !== 'knockout' || !Array.isArray(candidate.dependsOn)) continue;
      if (downstream.some(existing => existing.id === candidate.id)) continue;
      const dependsOnSource = candidate.dependsOn.some(token => sourceSlots.has(String(token).split('-')[0]));
      if (!dependsOnSource) continue;
      downstream.push(candidate);
      if (candidate.bracketSlot) sourceSlots.add(candidate.bracketSlot);
      changed = true;
    }
  }
  return downstream.sort((a, b) => a.matchNumber - b.matchNumber);
}

function canCorrectMatch(match, matches) {
  if (!match) return { ok: false, error: 'Match not found.' };
  if (!match.completed) return { ok: false, error: 'Only completed matches can be corrected.' };
  if (match.teamAId == null || match.teamBId == null) {
    return { ok: false, error: 'Match teams are not available.' };
  }

  if (match.stage === 'group') {
    const completedKnockout = matches.find(candidate => candidate.stage === 'knockout' && candidate.completed);
    if (completedKnockout) {
      return {
        ok: false,
        error: 'This group-stage correction would affect an already-started knockout bracket. Undo completed knockout results first.',
      };
    }
    return { ok: true, affectedMatches: [] };
  }

  if (match.stage === 'knockout') {
    const affectedMatches = downstreamKnockoutMatches(match, matches);
    const completedDownstream = affectedMatches.find(candidate => candidate.completed);
    if (completedDownstream) {
      return {
        ok: false,
        error: 'This knockout correction would invalidate a completed downstream knockout match. Undo those results first.',
        affectedMatches,
      };
    }
    return { ok: true, affectedMatches };
  }

  return { ok: false, error: 'Unsupported match stage.' };
}

module.exports = {
  MAX_RACE_TIME_SECONDS,
  parseCorrectedTimes,
  calculateWinnerTeamId,
  downstreamKnockoutMatches,
  canCorrectMatch,
};
