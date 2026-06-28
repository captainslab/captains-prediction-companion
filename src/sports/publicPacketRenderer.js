/**
 * publicPacketRenderer.js
 * Shared renderer for CPC public-facing sports packets and Telegram captions.
 *
 * SAFETY RULES (enforced at render time, not just at prompt time):
 *  - Active forecast language is blocked when the World Cup stale-model gate fires.
 *  - Banned terms are stripped/flagged from any rendered string before output.
 *  - Market/price data is NEVER included in rendered public output.
 *  - All suppressed forecast data is preserved separately for audit artifacts only.
 */

'use strict';

const { checkForecastFreshness } = require('./worldCupResearchContext');

// ─── Banned Language ──────────────────────────────────────────────────────────

/** Exact terms that must never appear in public packet output or Telegram captions. */
const PUBLIC_BANNED_TERMS = [
  'bet', 'betting', 'wager', 'sportsbook', 'odds', 'moneyline', 'prop',
  'pick', 'lean', 'lock', 'fade', 'edge', 'trade', 'buy', 'sell',
  'bankroll', 'stake', 'unit', 'market price', 'bid', 'ask',
  'open interest', 'volume', 'liquidity', 'NOT IN SCORE', 'display-only',
];

/**
 * Scan a rendered string for banned terms.
 * @param {string} text
 * @returns {{ clean: boolean, violations: string[] }}
 */
function scanPublicOutput(text) {
  const lower = (text || '').toLowerCase();
  const violations = PUBLIC_BANNED_TERMS.filter(t => {
    // Word-boundary aware: only flag standalone word matches, not substrings
    const re = new RegExp(`(?<![a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`, 'i');
    return re.test(lower);
  });
  return { clean: violations.length === 0, violations };
}

// ─── World Cup Public Renderer ───────────────────────────────────────────────────

/**
 * Render a public World Cup match packet.
 *
 * @param {object} opts
 * @param {object} opts.matchMeta          — { homeTeam, awayTeam, matchDate, venue, group }
 * @param {object} opts.forecastMeta       — { lineup_confirmed, model_consumes_lineup }
 * @param {object} opts.forecast           — prior composite forecast numbers (audit only if held)
 * @param {object} opts.researchContext    — { research } from worldCupResearchContext
 * @param {object} [opts.auditArtifact]    — object that receives suppressed numbers if held
 * @returns {{ output: string, held: boolean, held_reason: string|null, scan: object }}
 */
function renderWcPublicPacket(opts) {
  const {
    matchMeta = {},
    forecastMeta = {},
    forecast = {},
    researchContext = {},
    auditArtifact = null,
  } = opts;

  const { allow_active_forecast, held_reason } = checkForecastFreshness(forecastMeta);
  const research = researchContext?.research || {};

  let lines = [];

  // Header
  lines.push(`🏟️ ${matchMeta.homeTeam || '?'} vs ${matchMeta.awayTeam || '?'}`);
  if (matchMeta.group) lines.push(`Group: ${matchMeta.group}`);
  if (matchMeta.venue) lines.push(`Venue: ${matchMeta.venue}`);
  if (matchMeta.matchDate) lines.push(`Date: ${matchMeta.matchDate}`);
  lines.push('');

  // Confirmed XIs always shown when available
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

  // Forecast block — gated
  if (allow_active_forecast) {
    if (forecast.projected_goals_home != null)
      lines.push(`Projected goals: ${matchMeta.homeTeam} ${forecast.projected_goals_home}, ${matchMeta.awayTeam} ${forecast.projected_goals_away}`);
    if (forecast.projected_total != null)
      lines.push(`Projected total: ${forecast.projected_total}`);
    if (forecast.btts_pct != null)
      lines.push(`Both teams score: ${forecast.btts_pct}%`);
  } else {
    // Stale model: show held notice, suppress numbers
    lines.push(`⏸️ FORECAST HELD — ${held_reason}`);

    // Preserve suppressed numbers in audit artifact if provided
    if (auditArtifact && typeof auditArtifact === 'object') {
      auditArtifact._suppressed_forecast = {
        reason: held_reason,
        prior_composite: forecast,
        suppressed_at: new Date().toISOString(),
      };
    }
  }

  const output = lines.filter(l => l !== undefined).join('\n').trim();

  // Final public-safe scan
  const scan = scanPublicOutput(output);
  if (!scan.clean) {
    console.error('[publicPacketRenderer] BANNED TERM IN OUTPUT:', scan.violations);
  }

  return { output, held: !allow_active_forecast, held_reason, scan };
}

// ─── MLB Public Renderer ────────────────────────────────────────────────────────────

/**
 * Render a public MLB game context block.
 * Research context feeds the narrative; no forecast numbers are rendered
 * unless provided and explicitly marked as model-confirmed.
 *
 * @param {object} opts
 * @param {object} opts.gameMeta        — { homeTeam, awayTeam, gameDate, venue }
 * @param {object} opts.researchContext — { research } from mlbResearchContext
 * @param {object} [opts.forecast]      — optional confirmed model forecast
 * @returns {{ output: string, scan: object }}
 */
function renderMlbPublicPacket(opts) {
  const {
    gameMeta = {},
    researchContext = {},
    forecast = null,
  } = opts;

  const research = researchContext?.research || {};
  let lines = [];

  lines.push(`⚾ ${gameMeta.awayTeam || '?'} at ${gameMeta.homeTeam || '?'}`);
  if (gameMeta.gameDate) lines.push(`Date: ${gameMeta.gameDate}`);
  if (gameMeta.venue) lines.push(`Venue: ${gameMeta.venue}`);
  lines.push('');

  if (research.home_starter_name)
    lines.push(`🏠 ${gameMeta.homeTeam} starter: ${research.home_starter_name}${research.home_starter_handedness ? ` (${research.home_starter_handedness}HP)` : ''}${research.home_starter_recent_note ? ` — ${research.home_starter_recent_note}` : ''}`);
  if (research.away_starter_name)
    lines.push(`✈️ ${gameMeta.awayTeam} starter: ${research.away_starter_name}${research.away_starter_handedness ? ` (${research.away_starter_handedness}HP)` : ''}${research.away_starter_recent_note ? ` — ${research.away_starter_recent_note}` : ''}`);

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
