// Source adapter stub: sports announcer mentions
//
// Returns layer records for the sports_announcer_mentions profile.
// Closed-event calendar applies — check last 6 closed broadcast events for
// the same announcer/show before sourcing external broadcast notes.
//
// When a live data source is wired, replace the relevant stub record with a
// real fetcher that returns { present: true, score, source_basis, source_path, detail }.
//
// NEVER include bid/ask/odds/volume/open_interest/line_movement in any record.

/**
 * buildSportsBroadcastLayerRecords
 *
 * @param {object} opts
 * @param {string}  opts.announcer        - Announcer or show name
 * @param {string}  opts.keyword          - Target mention keyword (team, player, phrase)
 * @param {object?} opts.broadcastEvent   - { game_date_utc, network, show_type: 'live'|'pregame'|'postgame', confirmed }
 * @param {object?} opts.closedEventHitRate - { hits, total } from closed-event calendar
 * @param {object?} opts.storylineContext - { active: boolean, type: 'injury'|'milestone'|'rivalry'|'record', detail }
 * @param {object?} opts.breakingTrigger  - { present: boolean, detail } — injury news, record alert, etc.
 *
 * @returns {object} Map of layerKey → layer record
 */
export function buildSportsBroadcastLayerRecords({
  announcer,
  keyword,
  broadcastEvent = null,
  closedEventHitRate = null,
  storylineContext = null,
  breakingTrigger = null,
} = {}) {
  const records = {};

  // baseline_relevance — stub
  records.baseline_relevance = {
    present: false,
    score: null,
    source_basis: 'sports-broadcast-stub: requires announcer/team/topic-fit lookup',
    source_path: null,
    detail: null,
    missing_note: `no baseline relevance data for "${announcer}" / "${keyword}"`,
  };

  // event_proximity — populated if broadcast event is provided
  if (broadcastEvent?.game_date_utc && broadcastEvent?.confirmed) {
    const msUntil = new Date(broadcastEvent.game_date_utc) - Date.now();
    const hoursOut = msUntil / 3_600_000;
    let score = 10;
    if (hoursOut <= 0)   score = 99; // game is live
    else if (hoursOut <= 2)   score = 95;
    else if (hoursOut <= 6)   score = 85;
    else if (hoursOut <= 12)  score = 72;
    else if (hoursOut <= 24)  score = 55;
    else if (hoursOut <= 72)  score = 30;
    records.event_proximity = {
      present: true,
      score,
      source_basis: `confirmed broadcast schedule (${broadcastEvent.network ?? 'network unknown'}, ${broadcastEvent.show_type ?? 'broadcast'})`,
      source_path: broadcastEvent.source_url ?? null,
      detail: `${announcer} broadcast at ${broadcastEvent.game_date_utc} (~${Math.round(Math.max(0, hoursOut))}h out), show type: ${broadcastEvent.show_type ?? 'unknown'}`,
      missing_note: null,
    };
  } else {
    records.event_proximity = {
      present: false,
      score: null,
      source_basis: 'sports-broadcast-stub: no confirmed broadcast schedule supplied',
      source_path: null,
      detail: null,
      missing_note: 'confirm game/show date, network, and broadcast type (live/pregame/postgame)',
    };
  }

  // historical_tendency — populated from closed-event calendar
  if (closedEventHitRate && Number.isFinite(closedEventHitRate.hits) && Number.isFinite(closedEventHitRate.total) && closedEventHitRate.total > 0) {
    const rate = closedEventHitRate.hits / closedEventHitRate.total;
    const score = Math.round(rate * 100);
    records.historical_tendency = {
      present: true,
      score,
      source_basis: `closed-event calendar: ${closedEventHitRate.hits}/${closedEventHitRate.total} prior broadcasts resolved YES`,
      source_path: null,
      detail: `hit rate ${(rate * 100).toFixed(0)}% over last ${closedEventHitRate.total} closed events`,
      missing_note: null,
    };
  } else {
    records.historical_tendency = {
      present: false,
      score: null,
      source_basis: 'sports-broadcast-stub: no closed-event hit rate supplied',
      source_path: null,
      detail: null,
      missing_note: 'check closed-event calendar (top-right calendar icon on Kalshi board) for prior broadcast hit rates',
    };
  }

  // storyline_relevance — populated if storyline context is provided
  if (storylineContext?.active === true) {
    const typeScores = { injury: 85, milestone: 80, rivalry: 72, record: 78 };
    const score = typeScores[storylineContext.type] ?? 65;
    records.storyline_relevance = {
      present: true,
      score,
      source_basis: `active ${storylineContext.type ?? 'storyline'} narrative involving "${keyword}"`,
      source_path: storylineContext.source_url ?? null,
      detail: storylineContext.detail ?? `active ${storylineContext.type} storyline`,
      missing_note: null,
    };
  } else if (storylineContext?.active === false) {
    records.storyline_relevance = {
      present: true,
      score: 20,
      source_basis: `no active storyline found for "${keyword}" in this broadcast window`,
      source_path: null,
      detail: 'storyline context reviewed; no active narrative',
      missing_note: null,
    };
  } else {
    records.storyline_relevance = {
      present: false,
      score: null,
      source_basis: 'sports-broadcast-stub: storyline context not supplied',
      source_path: null,
      detail: null,
      missing_note: 'check injury reports, milestone trackers, rivalry/history context for this keyword',
    };
  }

  // injury_milestone_trigger — populated if breaking trigger context is provided
  if (breakingTrigger?.present === true) {
    records.injury_milestone_trigger = {
      present: true,
      score: 88,
      source_basis: 'live breaking trigger present — high likelihood of forced mention',
      source_path: breakingTrigger.source_url ?? null,
      detail: breakingTrigger.detail ?? 'breaking news/milestone context active',
      missing_note: null,
    };
  } else if (breakingTrigger?.present === false) {
    records.injury_milestone_trigger = {
      present: true,
      score: 30,
      source_basis: 'no breaking trigger; mention depends on narrative or talking-points pathway',
      source_path: null,
      detail: 'no live injury/milestone/record-breaking trigger detected',
      missing_note: null,
    };
  } else {
    records.injury_milestone_trigger = {
      present: false,
      score: null,
      source_basis: 'sports-broadcast-stub: breaking trigger context not supplied',
      source_path: null,
      detail: null,
      missing_note: 'check injury wire, record tracker, and live news for breaking context',
    };
  }

  // mention_type_likelihood — populated from show_type
  if (broadcastEvent?.show_type) {
    const typeScores = { live: 75, pregame: 65, postgame: 60 };
    const score = typeScores[broadcastEvent.show_type] ?? 50;
    records.mention_type_likelihood = {
      present: true,
      score,
      source_basis: `broadcast type "${broadcastEvent.show_type}" — ${broadcastEvent.show_type === 'live' ? 'live commentary window is longest' : 'pre/post window is shorter'}`,
      source_path: null,
      detail: `show type: ${broadcastEvent.show_type}`,
      missing_note: null,
    };
  } else {
    records.mention_type_likelihood = {
      present: false,
      score: null,
      source_basis: 'sports-broadcast-stub: broadcast show type not supplied',
      source_path: null,
      detail: null,
      missing_note: 'specify show type: live, pregame, or postgame',
    };
  }

  // Remaining layers — stubs
  const stubs = [
    ['source_velocity',       'sports-media keyword velocity search (stub)'],
    ['direct_mention_pathway','show notes / broadcaster talking-points review (stub)'],
    ['suppression_signal',    'sponsor conflict / broadcast restriction check (stub)'],
    ['evidence_quality',      'confirmed schedule + official broadcast context quality check (stub)'],
  ];
  for (const [key, note] of stubs) {
    records[key] = {
      present: false,
      score: null,
      source_basis: `sports-broadcast-stub: ${note}`,
      source_path: null,
      detail: null,
      missing_note: `${key} requires live source integration`,
    };
  }

  return records;
}
