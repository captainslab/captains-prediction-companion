import { createHash } from 'node:crypto';

const CONFIRMED_LINEUP_STATUSES = new Set([
  'confirmed',
  'confirmed_or_boxscore_available',
  'lineup_confirmed',
]);

function text(value) {
  return String(value ?? '').trim();
}

function normalized(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function teamValues(team) {
  if (team && typeof team === 'object') {
    return [team.id, team.mlb_id, team.name, team.team, team.abbreviation, team.abbrev]
      .map(normalized)
      .filter(Boolean);
  }
  return [normalized(team)].filter(Boolean);
}

function recordTeamValues(record, side) {
  const team = record?.[`${side}_team`];
  const nested = record?.[side]?.team ?? record?.[side];
  return [
    team,
    record?.[`${side}_team_id`],
    record?.[`${side}_team_abbrev`],
    nested?.id,
    nested?.name,
    nested?.abbreviation,
  ].map(normalized).filter(Boolean);
}

function matchesTeam(record, team, side) {
  const wanted = teamValues(team);
  const available = recordTeamValues(record, side);
  return wanted.some(value => available.includes(value));
}

function gameDate(record) {
  return text(
    record?.game_date
      ?? record?.officialDate
      ?? record?.date
      ?? record?.played_date
      ?? record?.result_date,
  ).slice(0, 10);
}

function gamePk(record) {
  return record?.game_pk ?? record?.gamePk ?? record?.id ?? null;
}

function lineupStatus(record) {
  return text(record?.lineup_status ?? record?.context?.lineup_status).toLowerCase();
}

function isConfirmedLineup(record) {
  const status = lineupStatus(record);
  return CONFIRMED_LINEUP_STATUSES.has(status) || status.startsWith('confirmed_') || status.includes('boxscore');
}

function battingOrder(record, side) {
  const direct = record?.[`${side}_batting_order`];
  const nested = record?.[side]?.batting_order ?? record?.context?.[`${side}_batting_order`];
  const order = Array.isArray(direct) ? direct : nested;
  return Array.isArray(order) ? order.filter(value => value != null) : [];
}

function mergeRecords(records) {
  const merged = new Map();
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw.game && typeof raw.game === 'object' ? { ...raw.game, ...raw } : raw;
    const context = record.context && typeof record.context === 'object' ? record.context : {};
    const key = gamePk(record) == null ? `${gameDate(record)}|${record.away_team ?? ''}|${record.home_team ?? ''}` : String(gamePk(record));
    merged.set(key, { ...(merged.get(key) ?? {}), ...record, ...context });
  }
  return [...merged.values()];
}

function records(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.records) ? value.records : [];
}

function candidateRecords({ priorGames = [], priorSchedule = [], priorResults = [] } = {}) {
  return mergeRecords([...records(priorGames), ...records(priorSchedule), ...records(priorResults)]);
}

function opponentForTeam(team, record) {
  if (matchesTeam(record, team, 'away')) return record.home_team ?? record.home?.team?.name ?? record.home?.name ?? null;
  if (matchesTeam(record, team, 'home')) return record.away_team ?? record.away?.team?.name ?? record.away?.name ?? null;
  return null;
}

export function isConfirmedLineupStatus(status) {
  const value = text(status).toLowerCase();
  return CONFIRMED_LINEUP_STATUSES.has(value) || value.startsWith('confirmed_') || value.includes('boxscore');
}

export function resolveLastLockedLineupProxy({
  team,
  generationDate,
  lineup_status = null,
  currentLineupStatus = null,
  todayLineupStatus = null,
  priorGames = [],
  priorSchedule = [],
  priorResults = [],
} = {}) {
  const currentStatus = currentLineupStatus ?? todayLineupStatus ?? lineup_status;
  if (isConfirmedLineupStatus(currentStatus)) return null;
  const date = text(generationDate).slice(0, 10);
  if (!date || !team) return null;

  const candidate = candidateRecords({ priorGames, priorSchedule, priorResults })
    .filter(record => {
      const priorDate = gameDate(record);
      const order = battingOrder(record, matchesTeam(record, team, 'away') ? 'away' : 'home');
      return priorDate && priorDate < date && isConfirmedLineup(record) && order.length > 0
        && (matchesTeam(record, team, 'away') || matchesTeam(record, team, 'home'));
    })
    .sort((a, b) => gameDate(b).localeCompare(gameDate(a)) || String(gamePk(b)).localeCompare(String(gamePk(a))))[0];

  if (!candidate) return null;
  const side = matchesTeam(candidate, team, 'away') ? 'away' : 'home';
  const result = {
    mode: 'LAST_LOCKED_LINEUP_PROXY',
    proxy_date: gameDate(candidate),
    proxy_game_pk: gamePk(candidate),
    batting_order: battingOrder(candidate, side),
    source: text(candidate.source_id ?? candidate.context_source ?? candidate.source) || 'prior_lineup_context',
  };
  result.hash = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  return result;
}

export function formatLineupProxySource({ team, proxy, priorGames = [], priorSchedule = [], priorResults = [] } = {}) {
  if (!proxy) return null;
  const record = candidateRecords({ priorGames, priorSchedule, priorResults })
    .find(candidate => String(gamePk(candidate)) === String(proxy.proxy_game_pk));
  const opponent = record ? opponentForTeam(team, record) : null;
  return `LAST_LOCKED_LINEUP_PROXY from ${proxy.proxy_date} vs ${opponent ?? 'UNKNOWN_OPPONENT'}`;
}
