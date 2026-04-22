import { dirname, resolve } from 'node:path';
import { loadJsonFile, writeJsonFileAtomic } from './storage.js';
import { buildFocusedKalshiMarketPlan, buildEventMarketPlanSummary } from './eventMarketTool.js';
import { runHermesResearch } from './hermesResearch.js';
import { runHermesOracle } from './hermesOracle.js';
import { resolveOpenRouterModel } from './modelDefaults.js';
import { buildOfficialSourcePacket } from './sourcePackets.js';

const MAX_RECENT_URLS = 20;
const ACTIONABLE_RECOMMENDATIONS = new Set([
  'buy_yes',
  'buy_no',
  'home',
  'away',
  'home_cover',
  'away_cover',
  'over',
  'under',
]);

const PIPELINE_STEPS = [
  {
    step_number: 1,
    stage: 'intake',
    step_name: 'Intake market universe',
    description: 'Load the recent and seeded Kalshi markets queued for research.',
    emoji: '🧭',
  },
  {
    step_number: 2,
    stage: 'market',
    step_name: 'Prepare research queue',
    description: 'Deduplicate URLs and lock the set of markets to analyze.',
    emoji: '🗂️',
  },
  {
    step_number: 3,
    stage: 'research',
    step_name: 'Research live markets',
    description: 'Run the compact market-card research pipeline on each queued market.',
    emoji: '🔎',
  },
  {
    step_number: 4,
    stage: 'scope',
    step_name: 'Scope event context',
    description: 'Summarize speakers, events, and contracts from the analyzed cards.',
    emoji: '🎯',
  },
  {
    step_number: 5,
    stage: 'evidence',
    step_name: 'Extract market evidence',
    description: 'Pull the key rules, pricing, and watch-for evidence from each card.',
    emoji: '📎',
  },
  {
    step_number: 6,
    stage: 'pricing',
    step_name: 'Price alpha edge',
    description: 'Count cards with fair value, edge, and actionable pricing.',
    emoji: '🧠',
  },
  {
    step_number: 7,
    stage: 'decision',
    step_name: 'Rank actionable cards',
    description: 'Sort the researched cards so the strongest edges float to the top.',
    emoji: '📊',
  },
  {
    step_number: 8,
    stage: 'logging',
    step_name: 'Persist pipeline state',
    description: 'Save the completed run and final research snapshot for the UI.',
    emoji: '💾',
  },
];

function asIsoString(value) {
  return value instanceof Date ? value.toISOString() : new Date(value ?? Date.now()).toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function makeEmptyState() {
  return {
    recent_urls: [],
    results: [],
    runs: [],
    run_counter: 0,
    running: false,
    current_step: null,
    step_progress: null,
    production: {
      total_events: 0,
      total_entities: 0,
      total_edges: 0,
      last_full_run: null,
      last_refresh: null,
      last_run: null,
    },
  };
}

function normalizeUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function uniqueUrls(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeUrl(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeLoadedState(raw) {
  const fallback = makeEmptyState();
  if (!isObject(raw)) return fallback;

  const recentUrls = uniqueUrls(Array.isArray(raw.recent_urls) ? raw.recent_urls : []).slice(0, MAX_RECENT_URLS);
  const results = Array.isArray(raw.results) ? raw.results : [];
  const runs = Array.isArray(raw.runs) ? raw.runs : [];
  const production = isObject(raw.production)
    ? {
        total_events: Number(raw.production.total_events) || 0,
        total_entities: Number(raw.production.total_entities) || 0,
        total_edges: Number(raw.production.total_edges) || 0,
        last_full_run: raw.production.last_full_run ?? null,
        last_refresh: raw.production.last_refresh ?? null,
        last_run: raw.production.last_run ?? null,
      }
    : fallback.production;

  return {
    recent_urls: recentUrls,
    results,
    runs,
    run_counter: Number(raw.run_counter) || 0,
    running: false,
    current_step: null,
    step_progress: raw.running ? null : raw.step_progress ?? null,
    production,
  };
}

function resolveDefaultModels(defaultModels = {}) {
  const implications =
    typeof defaultModels.implications === 'string' && defaultModels.implications.trim()
      ? defaultModels.implications.trim()
      : resolveOpenRouterModel('IMPLICATIONS_MODEL');
  const validation =
    typeof defaultModels.validation === 'string' && defaultModels.validation.trim()
      ? defaultModels.validation.trim()
      : resolveOpenRouterModel('VALIDATION_MODEL', implications);

  return {
    implications,
    validation,
  };
}

function sortResultsByPriority(results = []) {
  return [...results].sort((left, right) => {
    const leftEdge = Math.abs(Number(left?.market_view?.trade_view?.edge_cents) || 0);
    const rightEdge = Math.abs(Number(right?.market_view?.trade_view?.edge_cents) || 0);
    if (rightEdge !== leftEdge) return rightEdge - leftEdge;

    const leftConfidence = String(left?.confidence ?? 'low');
    const rightConfidence = String(right?.confidence ?? 'low');
    const score = { high: 3, medium: 2, low: 1 };
    if ((score[rightConfidence] ?? 0) !== (score[leftConfidence] ?? 0)) {
      return (score[rightConfidence] ?? 0) - (score[leftConfidence] ?? 0);
    }

    return String(left?.source?.url ?? '').localeCompare(String(right?.source?.url ?? ''));
  });
}

function summarizeResult(result, url) {
  const summary = buildEventMarketPlanSummary(result);
  return {
    ...summary,
    board_url: result?.board_url ?? summary?.source?.url ?? url,
    board_headline: result?.board_headline ?? summary?.summary?.headline ?? null,
    board_recommendation: result?.board_recommendation ?? summary?.summary?.recommendation ?? null,
    board_confidence: result?.board_confidence ?? summary?.confidence ?? null,
    board_no_edge_reason_code: result?.board_no_edge_reason_code ?? null,
    board_no_edge_reason: result?.board_no_edge_reason ?? null,
    official_source_url: result?.official_source_url ?? null,
    official_source_type: result?.official_source_type ?? null,
    transcript_excerpt: result?.transcript_excerpt ?? null,
    research_summary: result?.research_summary ?? result?.summary?.one_line_reason ?? null,
    evidence_strength: result?.evidence_strength ?? null,
    source_quality: result?.source_quality ?? null,
    source_packet_kind: result?.source_packet_kind ?? null,
    event_format: result?.event_format ?? null,
    speaker_type: result?.speaker_type ?? null,
    timing_relevance: result?.timing_relevance ?? null,
    why_valid_under_kalshi_rules: result?.why_valid_under_kalshi_rules ?? null,
    exact_phrase_status: result?.exact_phrase_status ?? null,
    official_source_candidates: Array.isArray(result?.official_source_candidates) ? result.official_source_candidates : [],
    edge_type: result?.edge_type ?? null,
    catalyst: result?.catalyst ?? null,
    reasoning_chain: Array.isArray(result?.reasoning_chain) ? result.reasoning_chain : [],
    invalidation_condition: result?.invalidation_condition ?? null,
    time_sensitivity: result?.time_sensitivity ?? null,
    source: {
      ...(isObject(summary.source) ? summary.source : {}),
      platform: summary?.source?.platform ?? 'Kalshi',
      url: summary?.source?.url ?? url,
      market_id: summary?.source?.market_id ?? null,
    },
    analyzed_at: null,
  };
}

function formatPercentage(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return `${Math.round(numeric * 100)}%`;
}

function formatCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  return `${rounded >= 0 ? '' : '-'}${Math.abs(rounded)}c`;
}

function getResultEdgeCents(result) {
  const edge =
    result?.market_view?.trade_view?.edge_cents ??
    result?.market_view?.price_view?.edge_cents ??
    null;
  return typeof edge === 'number' ? edge : null;
}

function hasActionableEdge(result) {
  const recommendation = String(result?.summary?.recommendation ?? '').trim().toLowerCase();
  if (ACTIONABLE_RECOMMENDATIONS.has(recommendation)) {
    return true;
  }

  const edge = getResultEdgeCents(result);
  return typeof edge === 'number' && Math.abs(edge) >= 3;
}

function buildNoEdgeReason(result) {
  if (hasActionableEdge(result)) {
    return null;
  }

  const recommendation = String(result?.summary?.recommendation ?? '').trim().toLowerCase();
  const tradeView = result?.market_view?.trade_view ?? {};
  const fairYes = formatPercentage(tradeView.fair_yes);
  const marketYes = formatPercentage(tradeView.market_yes ?? tradeView.last_price);
  const edgeCents = formatCents(getResultEdgeCents(result));
  const eventDomain = String(result?.event_domain ?? '').trim().toLowerCase();
  const eventType = String(result?.event_type ?? '').trim().toLowerCase();

  if (eventDomain === 'general' && eventType === 'general') {
    return {
      code: 'manual_classification_required',
      message: 'The card was classified as general/general, so it stayed pass pending manual classification.',
    };
  }

  if (fairYes && marketYes && edgeCents) {
    return {
      code: 'priced_in',
      message: `Market price (${marketYes}) and model fair value (${fairYes}) were too close, leaving only a ${edgeCents} gap.`,
    };
  }

  if (recommendation === 'pass') {
    return {
      code: 'manual_classification_required',
      message: 'The market stayed pass because the researched evidence did not map cleanly to an actionable pricing gap.',
    };
  }

  return {
    code: 'no_actionable_edge',
    message: 'The researched evidence did not show an actionable pricing gap.',
  };
}

function createOutputRecord(result, runId, recordedAt) {
  const boardUrl =
    result?.board_url ??
    result?.source?.url ??
    result?.user_facing?.source?.url ??
    null;
  const boardHeadline =
    result?.board_headline ??
    result?.summary?.headline ??
    result?.user_facing?.summary?.headline ??
    null;
  const boardRecommendation =
    result?.board_recommendation ??
    result?.summary?.recommendation ??
    result?.user_facing?.summary?.recommendation ??
    null;
  const boardConfidence = result?.board_confidence ?? result?.confidence ?? result?.user_facing?.confidence ?? null;

  const childContracts = Array.isArray(result?.child_contracts)
    ? result.child_contracts
    : Array.isArray(result?.user_facing?.market_view?.available_contracts)
      ? result.user_facing.market_view.available_contracts.map(contract => ({
          ticker: contract.market_ticker ?? null,
          label: contract.label ?? null,
          market_price: contract.market_yes ?? null,
          fair_value: contract.fair_yes ?? null,
          edge_cents: contract.edge_cents ?? null,
          phrase_found: contract.phrase_found ?? null,
          transcript_excerpt: contract.transcript_excerpt ?? null,
          evidence: Array.isArray(contract.evidence) ? contract.evidence : [],
          pick: contract.pick ?? null,
          confidence: contract.confidence ?? null,
          reasoning: contract.reasoning ?? null,
        }))
      : [];

  const boardNoEdgeReasonCode = result?.board_no_edge_reason_code ?? null;
  const boardNoEdgeReason = result?.board_no_edge_reason ?? null;
  const record = {
    run_id: runId,
    recorded_at: recordedAt,
    board_url: boardUrl,
    url: boardUrl,
    board_headline: boardHeadline,
    summary_headline: boardHeadline,
    official_source_url: result?.official_source_url ?? null,
    official_source_type: result?.official_source_type ?? null,
    transcript_excerpt: result?.transcript_excerpt ?? null,
    research_summary: result?.research_summary ?? result?.summary?.one_line_reason ?? null,
    evidence_strength: result?.evidence_strength ?? null,
    source_quality: result?.source_quality ?? null,
    unresolved_gaps: Array.isArray(result?.unresolved_gaps) ? result.unresolved_gaps : [],
    board_recommendation: boardRecommendation,
    recommendation: boardRecommendation,
    board_confidence: boardConfidence,
    confidence: boardConfidence,
    board_no_edge_reason_code: boardNoEdgeReasonCode,
    no_edge_reason_code: boardNoEdgeReasonCode,
    board_no_edge_reason: boardNoEdgeReason,
    no_edge_reason: boardNoEdgeReason,
    edge_type: result?.edge_type ?? null,
    catalyst: result?.catalyst ?? null,
    reasoning_chain: Array.isArray(result?.reasoning_chain) ? result.reasoning_chain : [],
    invalidation_condition: result?.invalidation_condition ?? null,
    time_sensitivity: result?.time_sensitivity ?? null,
    child_contracts: childContracts,
  };

  if (!record.board_no_edge_reason_code || !record.board_no_edge_reason) {
    const noEdgeReason = buildNoEdgeReason(result);
    if (noEdgeReason) {
      record.board_no_edge_reason_code = noEdgeReason.code;
      record.no_edge_reason_code = noEdgeReason.code;
      record.board_no_edge_reason = noEdgeReason.message;
      record.no_edge_reason = noEdgeReason.message;
    }
  }

  return record;
}

function normalizeLatestBoardRecord(card = {}) {
  return {
    board_url: card?.board_url ?? card?.url ?? null,
    board_headline: card?.board_headline ?? card?.summary_headline ?? null,
    board_recommendation: card?.board_recommendation ?? card?.recommendation ?? null,
    board_confidence: card?.board_confidence ?? card?.confidence ?? null,
    official_source_url: card?.official_source_url ?? null,
    official_source_type: card?.official_source_type ?? null,
    board_no_edge_reason_code: card?.board_no_edge_reason_code ?? card?.no_edge_reason_code ?? null,
    board_no_edge_reason: card?.board_no_edge_reason ?? card?.no_edge_reason ?? null,
    edge_type: card?.edge_type ?? null,
    catalyst: card?.catalyst ?? null,
    reasoning_chain: Array.isArray(card?.reasoning_chain) ? card.reasoning_chain : [],
    invalidation_condition: card?.invalidation_condition ?? null,
    time_sensitivity: card?.time_sensitivity ?? null,
    child_contracts: Array.isArray(card?.child_contracts) ? card.child_contracts : [],
  };
}

function fallbackResult(url, error) {
  const message = error instanceof Error ? error.message : 'Pipeline research failed for this market.';
  return {
    source: {
      platform: 'Kalshi',
      url,
      market_id: null,
    },
    event_domain: 'general',
    event_type: 'general',
    market_type: 'general',
    status: 'insufficient_context',
    confidence: 'low',
    summary: {
      headline: 'Pipeline research could not finish this market.',
      recommendation: 'pass',
      one_line_reason: message,
    },
    next_action: 'confirm_event_context',
    context: {},
    market_view: {},
    analyzed_at: null,
  };
}

function countActionableEdges(results = []) {
  return results.filter(result => {
    const recommendation = String(result?.summary?.recommendation ?? '').trim().toLowerCase();
    if (ACTIONABLE_RECOMMENDATIONS.has(recommendation)) {
      return true;
    }

    const edge =
      result?.market_view?.trade_view?.edge_cents ??
      result?.market_view?.price_view?.edge_cents ??
      null;
    return typeof edge === 'number' && Math.abs(edge) >= 3;
  }).length;
}

function countEntities(results = []) {
  const uniqueEntities = new Set(
    results
      .map(result => result?.context?.event_name ?? result?.source?.market_id ?? result?.source?.url ?? null)
      .filter(Boolean)
  );
  return uniqueEntities.size;
}

function buildStatusSnapshot(state, now, defaultModels) {
  const timestamp = asIsoString(now());
  const stepProgress = state.step_progress ? clone(state.step_progress) : null;

  if (stepProgress && state.running && state.current_step?.started_at) {
    const pipelineElapsedSeconds = Math.max(
      0,
      Math.round((new Date(timestamp).getTime() - new Date(stepProgress.started_at).getTime()) / 1000)
    );
    const currentStep = clone(state.current_step);
    currentStep.elapsed_seconds = Math.max(
      0,
      Math.round((new Date(timestamp).getTime() - new Date(currentStep.started_at).getTime()) / 1000)
    );
    stepProgress.current_step = currentStep;
    stepProgress.pipeline_elapsed_seconds = pipelineElapsedSeconds;
  }

  return {
    timestamp,
    running: state.running,
    current_step: state.current_step?.stage ?? null,
    step_progress: stepProgress,
    production: clone(state.production),
    default_models: clone(defaultModels),
  };
}

export function createPipelineService(options = {}) {
  const stateFile = options.stateFile;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const defaultModels = resolveDefaultModels(options.defaultModels);
  const runMarketAnalysis =
    typeof options.runMarketAnalysis === 'function'
      ? options.runMarketAnalysis
      : async (input, runOptions) => {
          const research = await runHermesResearch(input, runOptions);
          return runHermesOracle(research, input, runOptions);
        };
  const seedUrls = uniqueUrls(Array.isArray(options.seedUrls) ? options.seedUrls : []);

  if (!stateFile) {
    throw new Error('createPipelineService requires a stateFile path.');
  }

  const state = normalizeLoadedState(loadJsonFile(stateFile, makeEmptyState()));
  const outputFile = resolve(options.outputFile ?? `${dirname(stateFile)}/pipeline-card-outputs.json`);
  let activeRunPromise = null;

  function persist() {
    writeJsonFileAtomic(stateFile, state);
  }

  function persistOutputRecord(runId, recordedAt, results) {
    const existing = loadJsonFile(outputFile, []);
    const entries = Array.isArray(existing) ? existing : [];
    const record = {
      run_id: runId,
      recorded_at: recordedAt,
      cards: results.map(result => createOutputRecord(result, runId, recordedAt)),
    };

    const filtered = entries.filter(entry => entry?.run_id !== runId);
    writeJsonFileAtomic(outputFile, [...filtered, record]);
  }

  function setCurrentStep(step, details = null) {
    if (!state.step_progress) {
      state.step_progress = {
        started_at: asIsoString(now()),
        current_step: null,
        completed_steps: [],
        pipeline_elapsed_seconds: 0,
        total_steps: PIPELINE_STEPS.length,
        completed_count: 0,
      };
    }

    state.current_step = {
      step_number: step.step_number,
      stage: step.stage,
      step_name: step.step_name,
      status: 'running',
      started_at: asIsoString(now()),
      elapsed_seconds: 0,
      details,
      description: step.description,
      emoji: step.emoji,
    };
    state.step_progress.current_step = clone(state.current_step);
    persist();
  }

  function updateCurrentStepDetails(details) {
    if (!state.current_step || !state.step_progress?.current_step) return;
    state.current_step.details = details;
    state.step_progress.current_step.details = details;
    persist();
  }

  function completeCurrentStep(status = 'completed') {
    if (!state.current_step || !state.step_progress) return;
    const endedAt = asIsoString(now());
    const completedStep = {
      ...state.current_step,
      status,
      elapsed_seconds: Math.max(
        0,
        Math.round((new Date(endedAt).getTime() - new Date(state.current_step.started_at).getTime()) / 1000)
      ),
    };

    state.step_progress.completed_steps.push(completedStep);
    state.step_progress.completed_count = state.step_progress.completed_steps.length;
    state.step_progress.current_step = null;
    state.step_progress.pipeline_elapsed_seconds = Math.max(
      0,
      Math.round((new Date(endedAt).getTime() - new Date(state.step_progress.started_at).getTime()) / 1000)
    );
    state.current_step = null;
    persist();
  }

  function getCandidateUrls({ full = true, max_events } = {}) {
    const limit = Number.isInteger(max_events) && max_events > 0 ? max_events : null;
    const preferred = uniqueUrls([...state.recent_urls, ...seedUrls]);
    const universe = full ? uniqueUrls([...preferred, ...seedUrls]) : preferred;
    return limit ? universe.slice(0, limit) : universe;
  }

  function mergeResults(processedResults, full) {
    const normalized = processedResults.map(result => ({
      ...result,
      analyzed_at: asIsoString(now()),
    }));

    if (full) {
      return sortResultsByPriority(normalized);
    }

    const mergedByUrl = new Map();
    for (const existing of state.results) {
      const url = normalizeUrl(existing?.source?.url);
      if (!url) continue;
      mergedByUrl.set(url, existing);
    }
    for (const fresh of normalized) {
      const url = normalizeUrl(fresh?.source?.url);
      if (!url) continue;
      mergedByUrl.set(url, fresh);
    }

    return sortResultsByPriority([...mergedByUrl.values()]);
  }

  function refreshProductionSnapshot(results, lastRun, full) {
    state.production.total_events = results.length;
    state.production.total_entities = countEntities(results);
    state.production.total_edges = countActionableEdges(results);
    state.production.last_refresh = lastRun.completed_at;
    if (full) {
      state.production.last_full_run = lastRun.completed_at;
    }
    state.production.last_run = lastRun;
  }

  function queueUrl(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      return { ok: false, error: 'url is required' };
    }

    state.recent_urls = [normalized, ...state.recent_urls.filter(value => value !== normalized)].slice(0, MAX_RECENT_URLS);
    persist();
    return { ok: true, queued: normalized };
  }

  function recordRecentUrl(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    state.recent_urls = [normalized, ...state.recent_urls.filter(value => value !== normalized)].slice(0, MAX_RECENT_URLS);
    persist();
  }

  function reset() {
    const empty = makeEmptyState();
    state.recent_urls = empty.recent_urls;
    state.results = empty.results;
    state.runs = empty.runs;
    state.run_counter = empty.run_counter;
    state.running = empty.running;
    state.current_step = empty.current_step;
    state.step_progress = empty.step_progress;
    state.production = empty.production;
    persist();
  }

  async function runProduction(runOptions = {}) {
    if (state.running) {
      throw new Error('Pipeline already running.');
    }

    const full = runOptions.full !== false;
    const startedAt = asIsoString(now());
    const previousUrlSet = new Set(
      state.results.map(result => normalizeUrl(result?.source?.url)).filter(Boolean)
    );

    state.running = true;
    state.step_progress = {
      started_at: startedAt,
      current_step: null,
      completed_steps: [],
      pipeline_elapsed_seconds: 0,
      total_steps: PIPELINE_STEPS.length,
      completed_count: 0,
    };
    state.current_step = null;

    state.run_counter += 1;
    const lastRun = {
      id: state.run_counter,
      run_type: full ? 'full' : 'incremental',
      started_at: startedAt,
      completed_at: null,
      events_processed: null,
      new_events: null,
      status: 'running',
    };
    state.production.last_run = lastRun;
    persist();

    let finalStatus = 'completed';
    let completedAt = startedAt;

    try {
      setCurrentStep(PIPELINE_STEPS[0], 'Loading recent research context.');
      const selectedUrls = getCandidateUrls(runOptions);
      completeCurrentStep();

      setCurrentStep(
        PIPELINE_STEPS[1],
        selectedUrls.length > 0
          ? `Queued ${selectedUrls.length} market${selectedUrls.length === 1 ? '' : 's'} for research.`
          : 'No recent or seeded markets are queued yet.'
      );
      completeCurrentStep();

      const processedResults = [];
      setCurrentStep(PIPELINE_STEPS[2], 'Starting market research.');
      for (const [index, url] of selectedUrls.entries()) {
        updateCurrentStepDetails(`Researching ${index + 1}/${selectedUrls.length}: ${url}`);
        recordRecentUrl(url);
        try {
          const result = await runMarketAnalysis(
            {
              venue: 'Kalshi',
              url,
              source_packet: await buildOfficialSourcePacket({ venue: 'Kalshi', url }, {
                alphaModel: runOptions.implications_model ?? defaultModels.implications,
                validationModel: runOptions.validation_model ?? defaultModels.validation,
              }),
            },
            {
              alphaModel: runOptions.implications_model ?? defaultModels.implications,
              validationModel: runOptions.validation_model ?? defaultModels.validation,
            }
          );
          processedResults.push(summarizeResult(result, url));
        } catch (error) {
          processedResults.push(fallbackResult(url, error));
        }
      }
      completeCurrentStep();

      setCurrentStep(
        PIPELINE_STEPS[3],
        `Scoped ${processedResults.filter(result => result?.context?.event_name || result?.context?.speaker).length} market context${processedResults.length === 1 ? '' : 's'}.`
      );
      completeCurrentStep();

      setCurrentStep(
        PIPELINE_STEPS[4],
        `Captured pricing or rules evidence for ${processedResults.filter(result => result?.market_view).length} card${processedResults.length === 1 ? '' : 's'}.`
      );
      completeCurrentStep();

      const pricedCount = countActionableEdges(processedResults);
      setCurrentStep(
        PIPELINE_STEPS[5],
        pricedCount > 0
          ? `Detected ${pricedCount} actionable edge${pricedCount === 1 ? '' : 's'}.`
          : 'No actionable edges detected in the researched cards.'
      );
      completeCurrentStep();

      const mergedResults = mergeResults(processedResults, full);
      setCurrentStep(
        PIPELINE_STEPS[6],
        mergedResults.length > 0
          ? `Ranked ${mergedResults.length} researched market${mergedResults.length === 1 ? '' : 's'}.`
          : 'No researched markets to rank yet.'
      );
      completeCurrentStep();

      const processedUrls = processedResults.map(result => normalizeUrl(result?.source?.url)).filter(Boolean);
      const newEvents = processedUrls.filter(url => !previousUrlSet.has(url)).length;
      lastRun.completed_at = asIsoString(now());
      lastRun.events_processed = processedResults.length;
      lastRun.new_events = newEvents;
      lastRun.status = 'completed';

      state.results = mergedResults;
      refreshProductionSnapshot(mergedResults, lastRun, full);
      state.runs = [clone(lastRun), ...state.runs].slice(0, 25);
      persistOutputRecord(lastRun.id, lastRun.completed_at, processedResults);

      setCurrentStep(
        PIPELINE_STEPS[7],
        `Saved ${state.results.length} researched market${state.results.length === 1 ? '' : 's'} to pipeline state.`
      );
      completeCurrentStep();

      completedAt = lastRun.completed_at;
    } catch (error) {
      finalStatus = 'failed';
      completedAt = asIsoString(now());
      lastRun.completed_at = completedAt;
      lastRun.events_processed = lastRun.events_processed ?? 0;
      lastRun.new_events = lastRun.new_events ?? 0;
      lastRun.status = 'failed';
      state.production.last_run = lastRun;
      state.runs = [clone(lastRun), ...state.runs].slice(0, 25);

      if (state.current_step) {
        state.current_step.details = error instanceof Error ? error.message : 'Pipeline failed unexpectedly.';
        completeCurrentStep('failed');
      }
      throw error;
    } finally {
      state.running = false;
      state.current_step = null;
      if (state.step_progress) {
        state.step_progress.current_step = null;
        state.step_progress.pipeline_elapsed_seconds = Math.max(
          0,
          Math.round((new Date(completedAt).getTime() - new Date(state.step_progress.started_at).getTime()) / 1000)
        );
      }
      if (finalStatus === 'failed') {
        state.production.last_run = lastRun;
      }
      persist();
    }

    return getStatus();
  }

  function startProductionRun(runOptions = {}) {
    if (activeRunPromise) {
      return {
        started: false,
        promise: activeRunPromise,
        status: getStatus(),
      };
    }

    activeRunPromise = runProduction(runOptions).finally(() => {
      activeRunPromise = null;
    });

    return {
      started: true,
      promise: activeRunPromise,
      status: getStatus(),
    };
  }

  function getStatus() {
    return buildStatusSnapshot(state, now, defaultModels);
  }

  function getLatestBoardOutput() {
    const results = Array.isArray(state.results) ? state.results : [];
    let latestResult = null;
    let latestTimestamp = -Infinity;

    for (const result of results) {
      const analyzedAt = new Date(result?.analyzed_at ?? 0).getTime();
      if (Number.isFinite(analyzedAt) && analyzedAt >= latestTimestamp) {
        latestTimestamp = analyzedAt;
        latestResult = result;
      }
    }

    if (latestResult) {
      return normalizeLatestBoardRecord(latestResult);
    }

    const existing = loadJsonFile(outputFile, []);
    const entries = Array.isArray(existing) ? existing : [];

    for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const entry = entries[entryIndex];
      const cards = Array.isArray(entry?.cards) ? entry.cards : [entry];
      for (let cardIndex = cards.length - 1; cardIndex >= 0; cardIndex -= 1) {
        const card = cards[cardIndex];
        if (card) {
          return normalizeLatestBoardRecord(card);
        }
      }
    }

    return null;
  }

  persist();

  return {
    getLatestBoardOutput,
    getStatus,
    queueUrl,
    recordRecentUrl,
    reset,
    runProduction,
    startProductionRun,
  };
}
