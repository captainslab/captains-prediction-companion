// Current-event NASCAR production evidence composer.
//
// This module joins official field/qualifying data to the committed Gen-7
// history adapter and the market-neutral track-aware scorer. Kalshi market
// values are intentionally not accepted by this API and cannot enter a model
// candidate, ranking, posture, ceiling, or packet section.

import { resolve } from 'node:path';
import { writeJsonAtomic } from './cache.mjs';
import { normalizeNascarDriverName } from './driver-name.mjs';
import {
  loopHistoryLayerInputs,
  normalizeDriverNameForLoopHistory,
  resolveGen7TrackProfile,
} from './source-adapters/loop-history-gen7.mjs';
import { scoreNascarField } from './track-aware-scoring-core.mjs';

const REQUIRED_LAYER_NAMES = Object.freeze([
  'race_event_identity',
  'entry_list_drivers',
  'qualifying_starting_order',
  'practice_speed',
  'recent_driver_form',
  'track_history_gen7_comparables',
  'team_manufacturer_notes',
  'penalties_inspection_news',
  'weather_track_condition',
]);

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstRecord(envelope) {
  return Array.isArray(envelope?.records) ? envelope.records[0] ?? null : null;
}

function sourceObjects(urls = []) {
  return urls
    .map((source) => typeof source === 'string' ? { url: source } : source)
    .filter((source) => compact(source?.url));
}

function evidenceLayer({ status = 'ok', notes, sourceId, fetchedUtc, dataAsOfUtc = null, sources = [] }) {
  return {
    status,
    notes: compact(notes) || null,
    source_id: sourceId,
    fetched_utc: fetchedUtc,
    data_as_of_utc: dataAsOfUtc,
    sources: sourceObjects(sources),
  };
}

function liveLayerOrUnavailable(liveResearch, layerName, {
  sourceId,
  fetchedUtc,
  notes,
  unavailableSourceId = sourceId,
  unavailableFetchedUtc = fetchedUtc,
  unavailableSources = [],
}) {
  const live = liveResearch?.layers?.[layerName] ?? null;
  const liveSources = sourceObjects(live?.sources ?? [])
    .filter((source) => /^https?:\/\//i.test(compact(source.url)));
  const liveFetchedUtc = live?.fetched_utc ?? liveResearch?.generated_utc ?? null;
  const liveFetchedMs = Date.parse(liveFetchedUtc ?? '');
  const checkedMs = Date.parse(fetchedUtc ?? '');
  const current = Number.isFinite(liveFetchedMs)
    && Number.isFinite(checkedMs)
    && liveFetchedMs <= checkedMs + (5 * 60 * 1000)
    && checkedMs - liveFetchedMs <= (36 * 60 * 60 * 1000);
  if (String(live?.status ?? '').toLowerCase() === 'ok'
    && compact(live?.source_id ?? sourceId)
    && liveSources.length
    && current) {
    return evidenceLayer({
      status: 'ok',
      notes: live.notes ?? notes,
      sourceId: live.source_id ?? sourceId,
      fetchedUtc: liveFetchedUtc,
      sources: liveSources,
    });
  }
  return evidenceLayer({
    status: 'source_unavailable',
    notes: live?.notes ?? notes,
    sourceId: unavailableSourceId,
    fetchedUtc: unavailableFetchedUtc,
    sources: unavailableSources,
  });
}

function startScore(position, fieldSize) {
  const pos = numberOrNull(position);
  if (pos === null || fieldSize <= 1) return null;
  return Math.max(0, Math.min(100, Math.round(((fieldSize - pos) / (fieldSize - 1)) * 100)));
}

function speedScores(records = [], field = 'qualifying_speed') {
  const available = records
    .map((record) => ({
      key: normalizeNascarDriverName(record.driver_name),
      value: numberOrNull(record[field]),
    }))
    .filter((record) => record.key && record.value !== null)
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const scores = new Map();
  const denominator = Math.max(1, available.length - 1);
  available.forEach((record, index) => {
    scores.set(record.key, Math.round(((available.length - 1 - index) / denominator) * 100));
  });
  return scores;
}

function postureFor(candidate) {
  const score = numberOrNull(candidate.composite_score);
  const present = candidate.layer_breakdown?.filter((layer) => layer.value !== null).length ?? 0;
  if (score === null) return 'NO_CLEAR_PICK';
  if (score >= 65 && present >= 6 && candidate.confidence !== 'low') return 'EVIDENCE_LEAN';
  if (score >= 56 && present >= 4) return 'LEAN';
  if (score >= 42) return 'WATCH';
  return 'NO_CLEAR_PICK';
}

function assertProductionInputs({ date, event, officialEnvelope, activeFieldEnvelope, practiceEnvelope }) {
  const official = firstRecord(officialEnvelope);
  const active = Array.isArray(activeFieldEnvelope?.records) ? activeFieldEnvelope.records : [];
  const qualifying = Array.isArray(practiceEnvelope?.records) ? practiceEnvelope.records : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) throw new Error('production NASCAR date must be YYYY-MM-DD');
  if (!compact(event?.event_ticker)) throw new Error('production NASCAR event_ticker is missing');
  if (String(officialEnvelope?.status ?? '').toLowerCase() !== 'ok' || !official) throw new Error('official NASCAR identity is unavailable');
  if (official.race_started === true || Number(official.actual_laps) > 0) throw new Error('official NASCAR feed reports that the race has started');
  if (!active.length || String(activeFieldEnvelope?.status ?? '').toLowerCase() !== 'ok') throw new Error('official NASCAR active field is unavailable');
  if (!qualifying.length || String(practiceEnvelope?.status ?? '').toLowerCase() !== 'ok') throw new Error('official NASCAR qualifying order is unavailable');
  const activeNames = new Set(active.map((record) => normalizeNascarDriverName(record.driver_name)));
  const qualifyingNames = new Set(qualifying.map((record) => normalizeNascarDriverName(record.driver_name)));
  if (activeNames.size !== active.length || qualifyingNames.size !== qualifying.length) throw new Error('official NASCAR field/grid contains missing or duplicate drivers');
  if (activeNames.size !== qualifyingNames.size || [...activeNames].some((name) => !qualifyingNames.has(name))) {
    throw new Error('official NASCAR active field and qualifying order do not match');
  }
  return { official, active, qualifying };
}

export function buildNascarProductionEvidence({
  date,
  event,
  officialEnvelope,
  activeFieldEnvelope,
  practiceEnvelope,
  liveResearch = null,
  checkedAtUtc = null,
} = {}) {
  const { official, active, qualifying } = assertProductionInputs({
    date,
    event,
    officialEnvelope,
    activeFieldEnvelope,
    practiceEnvelope,
  });
  const checked = checkedAtUtc ?? officialEnvelope.checked_at_utc ?? new Date().toISOString();
  const profile = resolveGen7TrackProfile({ track_id: official.track_id, track_name: official.track });
  if (!profile?.track_type) throw new Error(`Gen-7 track profile unavailable for track_id ${official.track_id}`);
  const race = {
    track_id: Number(official.track_id),
    track_name: official.track,
    track_type: profile.track_type,
    restrictor_plate: profile.restrictor_plate,
    scheduled_distance: profile.scheduled_distance,
  };
  const history = loopHistoryLayerInputs({
    race,
    driverNames: active.map((record) => record.driver_name),
    entryList: active,
  });
  const historyDataAsOfUtc = profile.snapshots
    .map((snapshot) => snapshot.captured_at_utc)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const recentFormFresh = historyDataAsOfUtc
    ? Date.parse(checked) - Date.parse(historyDataAsOfUtc) <= 21 * 24 * 60 * 60 * 1000
    : false;
  const qualifyingByName = new Map(qualifying.map((record) => [normalizeNascarDriverName(record.driver_name), record]));
  const qualifyingScores = speedScores(qualifying);
  const practiceScores = speedScores(qualifying, 'practice_speed');
  const practiceAvailable = practiceScores.size > 0;
  const fieldSize = active.length;

  const driverInputs = active.map((entry) => {
    const key = normalizeNascarDriverName(entry.driver_name);
    const historyKey = normalizeDriverNameForLoopHistory(entry.driver_name);
    const hist = history.by_driver[historyKey] ?? null;
    const qualifyingRecord = qualifyingByName.get(key) ?? null;
    const layers = { ...(hist?.layers ?? {}) };
    if (!recentFormFresh) delete layers.recent_form_weighted_by_track_type;
    const start = qualifyingRecord?.effective_race_start ?? entry.starting_grid_position ?? null;
    const startLayer = startScore(start, fieldSize);
    if (startLayer !== null) {
      layers.starting_position_context = {
        score: startLayer,
        evidence: 'OK',
        sample: 1,
        note: `official effective race start P${start}`,
      };
    }
    const qualifyingScore = qualifyingScores.get(key);
    if (qualifyingScore !== undefined) {
      layers.single_lap_speed = {
        score: qualifyingScore,
        evidence: 'OK',
        sample: 1,
        note: `official qualifying speed ${qualifyingRecord.qualifying_speed}`,
      };
    }
    const practiceScore = practiceScores.get(key);
    return {
      driver_name: entry.driver_name,
      car_number: entry.car_number ?? null,
      team: entry.team ?? null,
      manufacturer: entry.manufacturer ?? null,
      starting_position: start,
      layers,
      track_specific_inputs: hist?.track_specific_inputs ?? {
        track_name: race.track_name,
        track_id: race.track_id,
        track_type: race.track_type,
        this_track_races: 0,
      },
      similar_track_inputs: hist?.similar_track_inputs ?? null,
      practice_context: practiceScore === undefined ? {
        long_run: null,
        single_lap: null,
        evidence: 'MISSING',
        note: 'no official run_type 1 practice record',
      } : {
        long_run: null,
        single_lap: practiceScore,
        evidence: 'OK',
        note: `official practice rank ${qualifyingRecord.practice_rank ?? 'n/a'} at ${qualifyingRecord.practice_speed ?? 'n/a'} mph`,
      },
    };
  });

  const scored = scoreNascarField({ race, drivers: driverInputs, gamma: 7 });
  const rawProbabilityTotal = scored.candidates.reduce((total, candidate) =>
    total + (numberOrNull(candidate.fair_win_probability) ?? 0), 0);
  const normalizedProbabilities = scored.candidates.map((candidate) =>
    rawProbabilityTotal > 0
      ? Math.round(((numberOrNull(candidate.fair_win_probability) ?? 0) / rawProbabilityTotal) * 10_000) / 10_000
      : 0);
  const roundedProbabilityTotal = normalizedProbabilities.reduce((total, probability) => total + probability, 0);
  if (normalizedProbabilities.length) {
    normalizedProbabilities[0] = Math.round((normalizedProbabilities[0] + (1 - roundedProbabilityTotal)) * 10_000) / 10_000;
  }
  const candidates = scored.candidates.map((candidate, index) => {
    const posture = postureFor(candidate);
    const present = candidate.layer_breakdown.filter((layer) => layer.value !== null);
    return {
      ...candidate,
      fair_win_probability: normalizedProbabilities[index],
      layers_present: present.length,
      fundamentals_layer_coverage: present.length,
      fundamentals_layer_coverage_label: `${present.length}/${scored.layers_total} layers`,
      score_breakdown: { inputs_used: present.map((layer) => ({ layer: layer.layer })) },
      lanes: {
        win: {
          status: posture,
          narrative: `model-only ${posture}; rating ${candidate.composite_score}/100 from ${present.length} source-backed layers`,
        },
      },
    };
  });
  if (candidates.length !== active.length || candidates.some((candidate) => !Number.isFinite(candidate.composite_score))) {
    throw new Error('production NASCAR model did not produce one numeric candidate per active driver');
  }

  const officialSources = official.source_urls ?? officialEnvelope.source_urls ?? [];
  const liveFetched = liveResearch?.generated_utc ?? checked;
  const liveSourceId = 'perplexity_live_research';
  const historySources = sourceObjects(history.source_urls);
  const evidenceLayers = {
    race_event_identity: evidenceLayer({ status: 'ok', notes: `${official.race_name} at ${official.track}`, sourceId: 'nascar_official', fetchedUtc: checked, sources: officialSources }),
    entry_list_drivers: evidenceLayer({ status: 'ok', notes: `${active.length} official active drivers`, sourceId: 'nascar_official', fetchedUtc: checked, sources: officialSources }),
    qualifying_starting_order: evidenceLayer({ status: 'ok', notes: `${qualifying.length} official contiguous starting positions`, sourceId: 'nascar_official', fetchedUtc: checked, sources: officialSources }),
    practice_speed: practiceAvailable
      ? evidenceLayer({ status: 'ok', notes: `Official run_type 1 practice data joined for ${practiceScores.size}/${active.length} drivers.`, sourceId: 'nascar_official', fetchedUtc: checked, sources: officialSources })
      : liveLayerOrUnavailable(liveResearch, 'practice_speed', {
        sourceId: liveSourceId,
        fetchedUtc: checked,
        notes: 'No separate practice session data was returned; official qualifying remains available.',
        unavailableSourceId: 'nascar_official',
        unavailableFetchedUtc: checked,
        unavailableSources: officialSources,
      }),
    recent_driver_form: recentFormFresh
      ? evidenceLayer({ status: 'ok', notes: `Gen-7 track-type form available for ${history.driver_count}/${active.length} active drivers; individual gaps remain MISSING in candidate ledgers.`, sourceId: history.source_id, fetchedUtc: checked, dataAsOfUtc: historyDataAsOfUtc, sources: historySources })
      : evidenceLayer({ status: 'source_unavailable', notes: `Committed recent-form snapshot is stale for a current-form claim (data as of ${historyDataAsOfUtc ?? 'unknown'}); the recent-form layer is excluded from scoring.`, sourceId: history.source_id, fetchedUtc: checked, dataAsOfUtc: historyDataAsOfUtc, sources: historySources }),
    track_history_gen7_comparables: evidenceLayer({ status: 'ok', notes: `${profile.completed_race_sample} completed Gen-7 races at track_id ${official.track_id}, plus ${profile.track_type} comparables. Historical data as of ${historyDataAsOfUtc ?? 'unknown'}.`, sourceId: history.source_id, fetchedUtc: checked, dataAsOfUtc: historyDataAsOfUtc, sources: historySources }),
    team_manufacturer_notes: evidenceLayer({ status: 'ok', notes: `Official team/manufacturer identity joined for ${active.length} active entries; equipment history remains car-keyed and historical data is as of ${historyDataAsOfUtc ?? 'unknown'}.`, sourceId: 'nascar_official+nascar_loop_history_gen7', fetchedUtc: checked, dataAsOfUtc: historyDataAsOfUtc, sources: [...sourceObjects(officialSources), ...historySources] }),
    penalties_inspection_news: official.inspection_complete === true
      ? evidenceLayer({ status: 'ok', notes: `Official inspection complete; infractions published: ${Number(official.infractions_count) || 0}.`, sourceId: 'nascar_official', fetchedUtc: checked, sources: officialSources })
      : evidenceLayer({ status: 'source_unavailable', notes: 'Official feed has not marked inspection complete; no penalty or inspection conclusion is fabricated.', sourceId: 'nascar_official', fetchedUtc: checked, sources: officialSources }),
    weather_track_condition: liveLayerOrUnavailable(liveResearch, 'weather_track_condition', { sourceId: liveSourceId, fetchedUtc: liveFetched, notes: 'Weather/track-condition source returned no verified current data.' }),
  };

  const evidenceArtifact = {
    schema_version: 'nascar_current_event_evidence_v1',
    mode: 'production',
    generated_utc: checked,
    event_ticker: event.event_ticker,
    model: 'cpc_nascar_production_v1',
    source_urls: [...sourceObjects(officialSources), ...historySources, ...sourceObjects(liveResearch?.source_urls ?? [])],
    layers: evidenceLayers,
    drivers: candidates.map((candidate) => ({
      driver: candidate.driver_name,
      notes: candidate.lanes.win.narrative,
      fetched_utc: checked,
      layer: 'model_candidate',
      sources: [],
    })),
  };
  if (Object.keys(evidenceLayers).length !== REQUIRED_LAYER_NAMES.length
    || REQUIRED_LAYER_NAMES.some((name) => !['ok', 'source_unavailable'].includes(evidenceLayers[name]?.status))) {
    throw new Error('production NASCAR evidence layer coverage is incomplete');
  }

  const identity = {
    event_ticker: event.event_ticker,
    event_title: event.title ?? null,
    race_id: Number(official.race_id),
    track_id: Number(official.track_id),
    series_id: Number(official.series_id),
    race_name: official.race_name,
    track: official.track,
    scheduled_start_utc: official.scheduled_start_utc,
    race_date: date,
  };
  const sourceRegistry = {
    schema_version: 'nascar_source_registry_v2',
    mode: 'production',
    checked_at_utc: checked,
    event_identity: identity,
    sources: {
      nascar_official: { source_id: 'nascar_official', status: 'ok', record_count: active.length, checked_at_utc: checked, source_urls: sourceObjects(officialSources) },
      nascar_loop_history_gen7: { source_id: history.source_id, status: 'ok', record_count: history.driver_count, checked_at_utc: checked, data_as_of_utc: historyDataAsOfUtc, recent_form_status: recentFormFresh ? 'ok' : 'source_unavailable', source_urls: historySources },
      current_event_research: { source_id: liveSourceId, status: liveResearch?._adapter_status ?? (liveResearch ? 'ok' : 'source_unavailable'), record_count: Object.values(evidenceLayers).filter((layer) => layer.status === 'ok').length, checked_at_utc: liveFetched },
    },
  };
  const discovery = {
    schema_version: 'nascar_discovery_v2',
    mode: 'production',
    checked_at_utc: checked,
    event_identity: identity,
    active_field_count: active.length,
    grid_count: qualifying.length,
    track_profile: profile,
  };
  const raceManifest = {
    schema_version: 'nascar_race_manifest_v2',
    mode: 'production',
    checked_at_utc: checked,
    event_identity: identity,
    active_field_count: active.length,
    model_candidate_count: candidates.length,
    evidence_layer_status: Object.fromEntries(Object.entries(evidenceLayers).map(([name, layer]) => [name, layer.status])),
  };
  const ceiling = {
    schema_version: 'nascar_track_aware_production_v1',
    mode: 'production',
    checked_at_utc: checked,
    source: 'current-event production model',
    event_identity: identity,
    track: scored.track,
    layers_total: scored.layers_total,
    candidate_count: candidates.length,
    candidates,
    field_notes: scored.field_notes,
    market_neutral: true,
    no_trades: true,
  };

  return { identity, ceiling, sourceRegistry, discovery, raceManifest, evidenceArtifact };
}

export function persistNascarProductionArtifacts({ stateRoot = 'state', date, built } = {}) {
  if (!built?.ceiling || built.ceiling.mode !== 'production') throw new Error('production NASCAR artifact bundle is invalid');
  const root = resolve(stateRoot, 'nascar', date);
  return {
    discovery: writeJsonAtomic(`${root}/discovery.json`, built.discovery),
    sourceRegistry: writeJsonAtomic(`${root}/source_registry.json`, built.sourceRegistry),
    raceManifest: writeJsonAtomic(`${root}/race_manifest.json`, built.raceManifest),
    ceiling: writeJsonAtomic(`${root}/ceiling_board.json`, built.ceiling),
    evidence: writeJsonAtomic(`${root}/live-research.json`, built.evidenceArtifact),
  };
}
