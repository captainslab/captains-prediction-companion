// MLB multi-series Kalshi discovery + game-key join.
// Read-only. No trades.
//
// Game key = the per-game segment that follows the series prefix in event
// tickers, e.g. "26MAY211605NYMWSH". It encodes YY MMM DD HHMM <AWAY><HOME>
// and is consistent across KXMLBGAME, KXMLBSPREAD, KXMLBTOTAL, KXMLBHR,
// KXMLBKS, and KXMLBRFI events. We use it to align all six market types to
// the same physical game.

import {
  fetchKalshiEvents,
  filterByEventDate,
  normalizeMarket,
} from '../../packets/lib/kalshi-discovery.mjs';
import { parseEventTickerTeams, lookupMlbTeam } from '../../packets/lib/mlb-teams.mjs';

export const MLB_SERIES = Object.freeze({
  ml: { key: 'mlb', prefix: 'KXMLBGAME', label: 'Moneyline' },
  spread: { key: 'mlb_spread', prefix: 'KXMLBSPREAD', label: 'Spread' },
  total: { key: 'mlb_total', prefix: 'KXMLBTOTAL', label: 'Total' },
  hr: { key: 'mlb_hr', prefix: 'KXMLBHR', label: 'Home Runs' },
  ks: { key: 'mlb_ks', prefix: 'KXMLBKS', label: 'Pitcher Strikeouts' },
  rfi: { key: 'mlb_rfi', prefix: 'KXMLBRFI', label: 'YFRI / 1st Inning Run' },
});

export function gameKeyFromEventTicker(ticker) {
  if (typeof ticker !== 'string') return null;
  // Format: PREFIX-<gameKey>[-marketSuffix]; strip leading prefix segment
  // and any subsequent suffix. Returns the second hyphen-separated segment.
  const parts = ticker.split('-');
  if (parts.length < 2) return null;
  return parts[1] || null;
}

// Parse "26MAY211605NYMWSH" → { yy, mon, dd, hh, mm, away, home, startUtc }
const MON = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
export function parseGameKey(gameKey) {
  if (typeof gameKey !== 'string') return null;
  const m = gameKey.match(/^(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})([A-Z]+)$/);
  if (!m) return null;
  const yy = Number(m[1]);
  const mon = MON[m[2]];
  const dd = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const letters = m[6];
  if (mon == null) return null;
  // Split team letters using MLB abbrev table via parseEventTickerTeams fake.
  const teams = parseEventTickerTeams(`KXMLBGAME-${gameKey}`);
  if (!teams) return null;
  // The encoded HHMM is in US Eastern (Kalshi convention observed in data).
  // Build a UTC-equivalent timestamp by computing the ET wall time then
  // letting Date interpret an explicit offset. EDT for most of the season
  // (Mar-Nov) is -04:00; EST is -05:00. We pick based on standard US DST
  // boundaries to avoid pulling in a tz lib.
  const year = 2000 + yy;
  const offsetMin = inUsDst(year, mon, dd) ? -240 : -300;
  const utcMs = Date.UTC(year, mon, dd, hh, mm) - offsetMin * 60 * 1000;
  const startUtc = new Date(utcMs).toISOString();
  return {
    year, month: mon + 1, day: dd, hour: hh, minute: mm,
    away: teams[0], home: teams[1],
    away_full: lookupMlbTeam(teams[0]),
    home_full: lookupMlbTeam(teams[1]),
    startUtc,
  };
}

// US DST: second Sunday of March → first Sunday of November.
function inUsDst(year, month0, day) {
  if (month0 < 2 || month0 > 10) return false;
  if (month0 > 2 && month0 < 10) return true;
  if (month0 === 2) {
    // Second Sunday of March
    const firstDow = new Date(Date.UTC(year, 2, 1)).getUTCDay();
    const secondSun = 1 + ((7 - firstDow) % 7) + 7;
    return day >= secondSun;
  }
  // November: first Sunday
  const firstDow = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstSun = 1 + ((7 - firstDow) % 7);
  return day < firstSun;
}

export function ctClockFromUtc(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // America/Chicago, 24h
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const obj = Object.fromEntries(f.map((p) => [p.type, p.value]));
  return `${obj.year}-${obj.month}-${obj.day} ${obj.hour}:${obj.minute} CT`;
}

export async function discoverAllSeries(date, options = {}) {
  const out = {};
  const filter = filterByEventDate(date, { windowDays: 0, allowUndated: false });
  for (const [k, meta] of Object.entries(MLB_SERIES)) {
    const res = await fetchKalshiEvents(meta.key, options);
    const events = (res.events || []).filter(filter);
    out[k] = {
      series: meta.prefix,
      label: meta.label,
      ok: res.ok,
      error: res.error || null,
      total: (res.events || []).length,
      matched: events.length,
      events,
    };
  }
  return out;
}

// Build per-game records joining all series by gameKey.
// Returns Array<{ game_key, away, home, away_full, home_full, start_utc,
//   start_ct, series: { ml, spread, total, hr, ks, rfi } }>
export function joinGames(seriesResults) {
  const games = new Map();
  for (const [seriesId, bucket] of Object.entries(seriesResults)) {
    for (const ev of bucket.events || []) {
      const gk = gameKeyFromEventTicker(ev.event_ticker);
      if (!gk) continue;
      if (!games.has(gk)) {
        const parsed = parseGameKey(gk);
        games.set(gk, {
          game_key: gk,
          away: parsed?.away ?? null,
          home: parsed?.home ?? null,
          away_full: parsed?.away_full ?? null,
          home_full: parsed?.home_full ?? null,
          start_utc: parsed?.startUtc ?? null,
          start_ct: parsed?.startUtc ? ctClockFromUtc(parsed.startUtc) : null,
          series: {},
        });
      }
      const g = games.get(gk);
      const markets = (ev.markets || []).map(normalizeMarket);
      g.series[seriesId] = {
        event_ticker: ev.event_ticker,
        event_title: ev.title || null,
        sub_title: ev.sub_title || null,
        market_count: markets.length,
        markets,
        priced: markets.some((m) =>
          m.yes_ask_dollars != null || m.no_ask_dollars != null || m.last_price_dollars != null),
      };
    }
  }
  return Array.from(games.values()).sort((a, b) =>
    (a.start_utc || '').localeCompare(b.start_utc || ''));
}

// Group games into clusters where first pitches are within `withinMinutes`.
// Returns Array<{ cluster_id, lead_utc, report_at_utc, games: [...] }>
// report_at_utc = lead_utc minus `prelockMinutes`.
export function clusterWindows(games, options = {}) {
  const within = options.withinMinutes ?? 10;
  const prelock = options.prelockMinutes ?? 60;
  const sorted = [...games]
    .filter((g) => g.start_utc)
    .sort((a, b) => a.start_utc.localeCompare(b.start_utc));
  const clusters = [];
  for (const g of sorted) {
    const t = Date.parse(g.start_utc);
    const last = clusters[clusters.length - 1];
    if (last && t - Date.parse(last.lead_utc) <= within * 60_000) {
      last.games.push(g);
    } else {
      clusters.push({ lead_utc: g.start_utc, games: [g] });
    }
  }
  return clusters.map((c, i) => ({
    cluster_id: `W${String(i + 1).padStart(2, '0')}`,
    lead_utc: c.lead_utc,
    lead_ct: ctClockFromUtc(c.lead_utc),
    report_at_utc: new Date(Date.parse(c.lead_utc) - prelock * 60_000).toISOString(),
    report_at_ct: ctClockFromUtc(new Date(Date.parse(c.lead_utc) - prelock * 60_000).toISOString()),
    game_keys: c.games.map((g) => g.game_key),
    games: c.games.map((g) => ({
      game_key: g.game_key,
      away: g.away, home: g.home,
      away_full: g.away_full, home_full: g.home_full,
      start_utc: g.start_utc, start_ct: g.start_ct,
    })),
  }));
}
