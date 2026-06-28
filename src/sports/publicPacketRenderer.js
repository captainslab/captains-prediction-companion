/**
 * publicPacketRenderer.js
 * Shared renderer for CPC public-facing sports packets.
 */

'use strict';

const { checkForecastFreshness } = require('./worldCupResearchContext.js');

const PUBLIC_BANNED_TERMS = [
  'bet', 'betting', 'wager', 'sportsbook', 'odds', 'moneyline', 'prop',
  'pick', 'lean', 'lock', 'fade', 'edge', 'trade', 'buy', 'sell',
  'bankroll', 'stake', 'unit', 'market price', 'bid', 'ask',
  'open interest', 'volume', 'liquidity', 'NOT IN SCORE', 'display-only',
];

function scanPublicOutput(text) {
  const lower = String(text ?? '').toLowerCase();
  const violations = PUBLIC_BANNED_TERMS.filter((term) => {
    const pattern = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?<![a-z])${pattern}(?![a-z])`, 'i');
    return regex.test(lower);
  });
  return { clean: violations.length === 0, violations };
}

function renderWcPublicPacket(opts) {
  const {
    matchMeta = {},
    forecastMeta = {},
    forecast = {},
    researchContext = {},
    auditArtifact = null,
  } = opts || {};

  const { allow_active_forecast, held_reason } = checkForecastFreshness(forecastMeta);
  const research = researchContext?.research || {};
  const lines = [];

  lines.push(`🏟️ ${matchMeta.homeTeam || '?'} vs ${matchMeta.awayTeam || '?'}`);
  if (matchMeta.group) lines.push(`Group: ${matchMeta.group}`);
  if (matchMeta.venue) lines.push(`Venue: ${matchMeta.venue}`);
  if (matchMeta.matchDate) lines.push(`Date: ${matchMeta.matchDate}`);
  lines.push('');

  if (research.home_confirmed_xi?.length) {
    lines.push(`🟢 ${matchMeta.homeTeam} XI: ${research.home_confirmed_xi.join(', ')}`);
  }
  if (research.away_confirmed_xi?.length) {
    lines.push(`🟢 ${matchMeta.awayTeam} XI: ${research.away_confirmed_xi.join(', ')}`);
  }
  if (research.home_injury_notes) lines.push(`⚠️ ${matchMeta.homeTeam} injury note: ${research.home_injury_notes}`);
  if (research.away_injury_notes) lines.push(`⚠️ ${matchMeta.awayTeam} injury note: ${research.away_injury_notes}`);
  if (research.group_standings_note) lines.push(`📊 Standings: ${research.group_standings_note}`);
  if (research.advancement_context) lines.push(`🎯 Context: ${research.advancement_context}`);
  if (research.match_context_note) lines.push(`📝 Note: ${research.match_context_note}`);
  lines.push('');

  if (allow_active_forecast) {
    if (forecast.projected_goals_home != null) {
      lines.push(`Projected goals: ${matchMeta.homeTeam} ${forecast.projected_goals_home}, ${matchMeta.awayTeam} ${forecast.projected_goals_away}`);
    }
    if (forecast.projected_total != null) {
      lines.push(`Projected total: ${forecast.projected_total}`);
    }
    if (forecast.btts_pct != null) {
      lines.push(`Both teams score: ${forecast.btts_pct}%`);
    }
  } else {
    lines.push(`⏸ FORECAST HELD — ${held_reason}`);
    if (auditArtifact && typeof auditArtifact === 'object') {
      auditArtifact._suppressed_forecast = {
        reason: held_reason,
        prior_composite: forecast,
        suppressed_at: new Date().toISOString(),
      };
    }
  }

  const output = lines.filter((line) => line !== undefined).join('\n').trim();
  const scan = scanPublicOutput(output);
  if (!scan.clean) {
    console.error('[publicPacketRenderer] BANNED TERM IN OUTPUT:', scan.violations);
  }

  return { output, held: !allow_active_forecast, held_reason, scan };
}

function renderMlbPublicPacket(opts) {
  const {
    gameMeta = {},
    researchContext = {},
  } = opts || {};

  const research = researchContext?.research || {};
  const lines = [];

  lines.push(`⚾ ${gameMeta.awayTeam || '?'} at ${gameMeta.homeTeam || '?'}`);
  if (gameMeta.gameDate) lines.push(`Date: ${gameMeta.gameDate}`);
  if (gameMeta.venue) lines.push(`Venue: ${gameMeta.venue}`);
  lines.push('');

  if (research.home_starter_name) {
    lines.push(`🏠 ${gameMeta.homeTeam} starter: ${research.home_starter_name}${research.home_starter_handedness ? ` (${research.home_starter_handedness}HP)` : ''}${research.home_starter_recent_note ? ` — ${research.home_starter_recent_note}` : ''}`);
  }
  if (research.away_starter_name) {
    lines.push(`✈️ ${gameMeta.awayTeam} starter: ${research.away_starter_name}${research.away_starter_handedness ? ` (${research.away_starter_handedness}HP)` : ''}${research.away_starter_recent_note ? ` — ${research.away_starter_recent_note}` : ''}`);
  }
  if (research.home_injury_notes) lines.push(`⚠️ ${gameMeta.homeTeam} injury: ${research.home_injury_notes}`);
  if (research.away_injury_notes) lines.push(`⚠️ ${gameMeta.awayTeam} injury: ${research.away_injury_notes}`);
  if (research.weather_note) lines.push(`🌥️ Weather: ${research.weather_note}`);
  if (research.run_environment_note) lines.push(`📈 Run env: ${research.run_environment_note}`);
  if (research.recent_series_context) lines.push(`📜 Series: ${research.recent_series_context}`);

  const output = lines.filter(Boolean).join('\n').trim();
  const scan = scanPublicOutput(output);
  if (!scan.clean) {
    console.error('[publicPacketRenderer:mlb] BANNED TERM IN OUTPUT:', scan.violations);
  }

  return { output, scan };
}

module.exports = {
  renderWcPublicPacket,
  renderMlbPublicPacket,
  scanPublicOutput,
  PUBLIC_BANNED_TERMS,
};
