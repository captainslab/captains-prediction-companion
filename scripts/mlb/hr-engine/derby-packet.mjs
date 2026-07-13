// Customer packet and artifact builder for the deterministic 2026 Derby model.
// The TXT is rendered only from the projection JSON so parity is testable.
import { createHash } from 'node:crypto';
import { assertCpcPacketValid } from '../../packets/lib/cpc-packet-validator.mjs';
import { buildInventoryArtifact } from '../../shared/decision-packet.mjs';
import { buildScopedLedger } from '../lib/assumptions-ledger.mjs';
import {
  DERBY_EVENT,
  DERBY_ASSUMPTION_QUALITY_DEFAULTS,
  DERBY_ASSUMPTION_SUPPORT_DEFAULTS,
  DERBY_MODEL_ASSUMPTIONS,
  DERBY_PUBLICATION_RULES,
  DERBY_RULES,
  buildDerbyProjection,
  fixtureDerbyParticipants,
} from './derby-simulator.mjs';

const FORMAT_SOURCE = 'MLB.com: "Changes coming to 2026 Home Run Derby" (June 18, 2026) and "The 2026 Home Run Derby field is complete" (July 11, 2026)';

function number(value) {
  if (!Number.isFinite(Number(value))) return 'null';
  return Number(Number(value).toFixed(4)).toString();
}

function renderFigure(label, value) {
  const sampling = value?.sampling_uncertainty?.interval ?? { low: null, high: null };
  const model = value?.model_uncertainty?.interval ?? { low: null, high: null };
  return `${label}: probability=${number(value?.probability)} monte_carlo_95pct_low=${number(sampling.low)} monte_carlo_95pct_high=${number(sampling.high)} model_scenario_low=${number(model.low)} model_scenario_high=${number(model.high)} data_quality=${value?.data_quality ?? 'F'}`;
}

function renderFigureMap(title, values, { maxRows = null } = {}) {
  const lines = [`${title}:`];
  const entries = Object.entries(values ?? {});
  const shown = Number.isInteger(maxRows) && entries.length > maxRows
    ? [...entries]
      .sort((left, right) => (right[1]?.probability ?? 0) - (left[1]?.probability ?? 0)
        || String(left[0]).localeCompare(String(right[0]), 'en'))
      .slice(0, maxRows)
    : entries;
  for (const [key, value] of shown) lines.push(`  - ${renderFigure(key, value)}`);
  if (shown.length < entries.length) {
    lines.push(`  - ${entries.length - shown.length} additional eligible bins retained in public-view.json and the full internal research artifact.`);
  }
  if (lines.length === 1) lines.push('  - BLOCKED: no simulation figure available');
  return lines;
}

function participantInputSources(projection) {
  const sources = [...new Set(Object.values(projection?.participant_models ?? {})
    .map((model) => String(model?.source_kind ?? '').trim())
    .filter(Boolean))];
  return sources.length ? sources.join('; ') : 'UNKNOWN';
}

function fieldEligible(eligibility, field) {
  return eligibility?.fields?.[field]?.status === 'eligible';
}

function suppressedOutput(field, label, eligibility) {
  return {
    field,
    label,
    status: eligibility?.fields?.[field]?.status ?? 'suppressed',
    minimum_quality: eligibility?.fields?.[field]?.minimum_quality ?? null,
  };
}

function buildPublicRobustConclusions(robustConclusions) {
  if (!robustConclusions) return null;
  return {
    schema_version: 'mlb_hr_derby_public_robust_conclusions_v1',
    required_scenarios: robustConclusions.required_scenarios,
    publication_rule: robustConclusions.publication_rule,
    conclusions: Object.fromEntries(Object.entries(robustConclusions.conclusions ?? {}).map(([id, conclusion]) => [id, {
      label: conclusion.label,
      stability_rule: conclusion.stability_rule,
      tier_definition: conclusion.tier_definition,
      stable_top_tier: (conclusion.stable_top_tier ?? []).map((entry) => ({
        candidate: entry.candidate,
        stable_across_all_scenarios: entry.stable_across_all_scenarios,
        sampling_separated_across_all_scenarios: entry.sampling_separated_across_all_scenarios,
        stable_tier: entry.stable_tier,
        scenario_rank_range: entry.scenario_rank_range,
        rounded_scenario_band: entry.rounded_scenario_band,
      })),
    }])),
  };
}

export function buildDerbyPublicView(projection) {
  if (projection?.schema_version === 'mlb_hr_derby_public_product_v1') return projection;
  const eligibility = projection.publication_eligibility ?? {
    data_quality: projection.model_data_quality ?? 'F',
    fields: {},
  };
  if (projection.status === 'blocked') {
    return {
      schema_version: 'mlb_hr_derby_public_product_v1',
      product: 'PUBLIC_CAPTAIN_PACKET',
      status: 'blocked',
      event: projection.event,
      format: projection.format,
      generated_utc: projection.generated_utc,
      seed: projection.seed,
      simulations: projection.simulations,
      model_data_quality: projection.model_data_quality ?? 'F',
      publication_eligibility: eligibility,
      blocked_participants: projection.blocked_participants ?? [],
    };
  }
  const exactWinnerEligible = fieldEligible(eligibility, 'exact_winner_probabilities');
  const exactOutcomesEligible = fieldEligible(eligibility, 'exact_outcome_probabilities');
  const roundTotalsEligible = fieldEligible(eligibility, 'exact_round_hr_distributions');
  const tournamentTotalsEligible = fieldEligible(eligibility, 'exact_tournament_totals');
  const distancesEligible = fieldEligible(eligibility, 'per_foot_distance_distributions');
  const fiveHundredEligible = fieldEligible(eligibility, 'five_hundred_plus_probabilities');
  const evEligible = fieldEligible(eligibility, 'exact_ev_distributions');
  const assumptionQuality = projection.quality_metadata?.assumption_quality
    ?? DERBY_ASSUMPTION_QUALITY_DEFAULTS;
  const assumptionSupport = projection.quality_metadata?.assumption_support
    ?? DERBY_ASSUMPTION_SUPPORT_DEFAULTS;
  return {
    schema_version: 'mlb_hr_derby_public_product_v1',
    product: 'PUBLIC_CAPTAIN_PACKET',
    status: projection.status,
    event: projection.event,
    format: projection.format,
    generated_utc: projection.generated_utc,
    seed: projection.seed,
    simulations: projection.simulations,
    model_data_quality: projection.model_data_quality,
    participant_input_sources: participantInputSources(projection),
    publication_eligibility: eligibility,
    uncertainty: projection.uncertainty,
    sensitivity_summary: {
      calibration_status: projection.sensitivity?.calibration_status ?? 'UNCALIBRATED',
      documentation: projection.sensitivity?.documentation ?? null,
      shared_seed_across_scenarios: projection.sensitivity?.shared_seed_across_scenarios ?? true,
      common_random_numbers: projection.sensitivity?.common_random_numbers ?? false,
      scenarios: (projection.sensitivity?.scenarios ?? []).map((scenario) => ({
        id: scenario.id,
        label: scenario.label,
        calibration_status: scenario.calibration_status,
        description: scenario.description,
      })),
    },
    robust_conclusions: fieldEligible(eligibility, 'broad_tiers')
      ? buildPublicRobustConclusions(projection.robust_conclusions)
      : null,
    exact_outcomes: {
      winner: exactWinnerEligible ? projection.winner : null,
      round_1_leader: exactOutcomesEligible ? projection.round_1_leader : null,
      qualifiers: exactOutcomesEligible ? projection.qualifiers : null,
      finals_matchup: exactOutcomesEligible ? projection.finals_matchup : null,
      finals_result: exactOutcomesEligible ? projection.finals_result : null,
      longest_hr_player: exactOutcomesEligible ? projection.longest_home_run.player : null,
      highest_ev_player: exactOutcomesEligible ? projection.highest_exit_velocity.player : null,
    },
    exact_distributions: {
      round_1_hr_totals: roundTotalsEligible ? projection.round_1_hr_totals : null,
      tournament_total_home_runs: tournamentTotalsEligible ? projection.total_home_runs : null,
      longest_hr_distance_ft: distancesEligible ? projection.longest_home_run.distance_ft : null,
      longest_hr_player_distance: distancesEligible ? projection.longest_home_run.player_distance : null,
      home_runs_500_plus: fiveHundredEligible ? projection.home_runs_500_plus : null,
      highest_ev_mph: evEligible ? projection.highest_exit_velocity.mph : null,
      highest_ev_player_mph: evEligible ? projection.highest_exit_velocity.player_mph : null,
    },
    suppressed_outputs: [
      suppressedOutput('exact_winner_probabilities', 'Exact winner probabilities', eligibility),
      suppressedOutput('exact_round_hr_distributions', 'Exact Round 1 HR distributions', eligibility),
      suppressedOutput('exact_tournament_totals', 'Exact tournament HR totals', eligibility),
      suppressedOutput('per_foot_distance_distributions', 'Per-foot distance distributions', eligibility),
      suppressedOutput('five_hundred_plus_probabilities', '500+ foot probabilities', eligibility),
      suppressedOutput('exact_ev_distributions', 'Exact exit-velocity distributions', eligibility),
    ].filter((item) => item.status !== 'eligible'),
    assumption_summary: {
      bp_power_transform: assumptionQuality.bp_power_transform,
      fatigue_curve: assumptionQuality.fatigue_curve,
      distance_transform: assumptionQuality.distance_transform,
      rule_coverage: assumptionQuality.rule_coverage,
      support_kinds: Object.fromEntries(Object.entries(assumptionSupport).map(([domain, support]) => [
        domain,
        support.support_kind,
      ])),
      unverified_rule_gap_count: (Array.isArray(projection.assumptions) ? projection.assumptions : [])
        .filter((item) => item.status === 'ASSUMED' || item.status === 'UNKNOWN').length,
    },
  };
}

function assumptionsItems(
  generatedUtc,
  modelAssumptions = DERBY_MODEL_ASSUMPTIONS,
  assumptionSupport = DERBY_ASSUMPTION_SUPPORT_DEFAULTS,
) {
  const common = { scope: 'FULL_DAY_PREVIEW', checked_utc: generatedUtc };
  const evidence = (domain, fallback) => {
    const support = assumptionSupport[domain] ?? DERBY_ASSUMPTION_SUPPORT_DEFAULTS[domain];
    if (support.source_quality === 'F') return { ...fallback, source_quality: 'F' };
    return {
      status: support.status,
      source_quality: support.source_quality,
      basis: support.basis,
      source: support.source,
    };
  };
  return [
    {
      ...common, type: 'derby_format', status: 'LOCKED', source_quality: 'A',
      basis: '2026 format and complete field were directly observed in official MLB.com event coverage.', source: FORMAT_SOURCE,
      value: DERBY_RULES,
    },
    {
      ...common, type: 'bp_power_transform', ...evidence('bp_power_transform', {
        status: 'ASSUMED',
        basis: 'No public Derby batting-practice/max-effort measurement exists; in-game Statcast is only a proxy.',
        source: 'Unmeasured model assumption; no fabricated BP source',
      }),
      value: {
        hr_probability_multiplier: modelAssumptions.bp_hr_probability_multiplier,
        contact_floor: modelAssumptions.bp_contact_floor,
        exit_velocity_lift_mph: modelAssumptions.bp_exit_velocity_lift_mph,
      },
    },
    {
      ...common, type: 'fatigue_curve', ...evidence('fatigue_curve', {
        status: 'ASSUMED',
        basis: 'No public per-round Derby fatigue data exists.',
        source: 'Unmeasured model assumption; no fabricated fatigue source',
      }),
      value: {
        hr_probability_decay_per_round: modelAssumptions.fatigue_hr_probability_decay_per_round,
        distance_decay_ft_per_round: modelAssumptions.fatigue_distance_decay_ft_per_round,
      },
    },
    {
      ...common, type: 'distance_transform', ...evidence('distance_transform', {
        status: 'ASSUMED',
        basis: 'In-game distance/exit velocity are proxies for Derby ball flight.',
        source: 'Unmeasured model assumption; no fabricated BP source',
      }),
      value: {
        max_to_hr_mean_ft: modelAssumptions.distance_max_to_hr_mean_ft,
        pull_air_bonus_ft: modelAssumptions.distance_pull_air_bonus_ft,
        ev_slope_ft_per_mph: modelAssumptions.distance_ev_slope_ft_per_mph,
        standard_deviation_ft: modelAssumptions.distance_standard_deviation_ft,
        exit_velocity_standard_deviation_mph: modelAssumptions.exit_velocity_standard_deviation_mph,
      },
    },
    {
      ...common, type: 'round_1_exact_distance_tie', ...evidence('rule_coverage', {
        status: 'ASSUMED',
        basis: 'The supplied 2026 rules do not specify a fallback when longest-HR distances are also equal.',
        source: 'Unverified rule gap; deterministic alphabetical fallback',
      }), value: modelAssumptions.round_1_exact_distance_tie_fallback,
    },
    {
      ...common, type: 'round_1_swingoff_fallback', ...evidence('rule_coverage', {
        status: 'ASSUMED',
        basis: 'The supplied 2026 rules do not specify a Round-1 fallback beyond longest-HR distance.',
        source: 'Unverified rule gap; alphabetical fallback if still tied',
      }), value: 'alphabetical participant name',
    },
    {
      ...common, type: 'swingoff_hot_hand', ...evidence('rule_coverage', {
        status: 'ASSUMED',
        basis: 'The supplied 2026 rules do not say whether hot-hand applies during a 3-swing swing-off.',
        source: 'Unverified rule gap; hot-hand not applied in swing-offs',
      }), value: modelAssumptions.swingoff_hot_hand,
    },
    {
      ...common, type: 'timeout_survival', ...evidence('rule_coverage', {
        status: 'UNKNOWN',
        basis: 'The supplied rules do not specify whether any timeout survives.',
        source: 'Unverified rule gap',
      }), value: 'UNKNOWN',
    },
    {
      ...common, type: 'hot_hand_numerical_cap', ...evidence('rule_coverage', {
        status: 'ASSUMED',
        basis: 'The hot-hand tail is unbounded; a numerical safety cap is required and every cap event is logged.',
        source: 'Model safety assumption; not an event rule',
      }), value: modelAssumptions.max_hot_hand_swings,
    },
    {
      ...common, type: 'swingoff_output_accounting', ...evidence('rule_coverage', {
        status: 'ASSUMED',
        basis: 'The supplied rules do not define market-specific accounting for swing-off home runs.',
        source: 'Model output convention; swing-off swings included in tournament aggregates',
      }),
      value: 'include swing-off HR, distance, exit velocity, and 500+ ft results',
    },
  ];
}

function percent(value) {
  return `${Math.round(Number(value) * 100)}%`;
}

function renderRobustConclusion(conclusion) {
  const lines = [];
  const stableTop = conclusion?.stable_top_tier ?? [];
  if (!stableTop.length) {
    lines.push(`  ${conclusion?.label ?? 'Conclusion'}: NO STABLE TOP TIER across all three scenarios.`);
    return lines;
  }
  lines.push(`  ${conclusion.label}: ${stableTop.map((entry) => entry.candidate).join('; ')} (scenario-stable and sampling-separated)`);
  for (const entry of stableTop) {
    const band = entry.rounded_scenario_band;
    const ranks = entry.scenario_rank_range;
    lines.push(`    - ${entry.candidate}: EXPERIMENTAL scenario band ${percent(band.low)}-${percent(band.high)}; scenario rank ${ranks.best}-${ranks.worst}; rounded stress range, not a confidence interval.`);
  }
  return lines;
}

function renderReadyPacket(view) {
  const lines = [
    `CPC Packet: ${view.event.name}${view.model_data_quality === 'F' ? ' — FIXTURE MODE' : ''}`,
    'product: PUBLIC CAPTAIN PACKET',
    `date: ${view.event.date}`,
    `venue: ${view.event.venue}, ${view.event.city}`,
    `generated_utc: ${view.generated_utc}`,
    `seed: ${view.seed}`,
    `simulations: ${view.simulations}`,
    `data_quality: ${view.model_data_quality}`,
    `sources: ${FORMAT_SOURCE}`,
    `participant_input_sources: ${view.participant_input_sources}`,
    '',
    'EVENT FORMAT',
    `  participants=${view.format.participants} rounds=${view.format.rounds} clock=NONE outs=NONE bonus_time=NONE`,
    `  round_1=${view.format.round_1_swings} swings open round; top ${view.format.round_1_qualifiers} advance by HR total then longest-HR distance`,
    `  round_2=${view.format.round_2_swings} swings seeded ${view.format.round_2_bracket}; finals=${view.format.finals_swings} swings`,
    '  hot-hand: a home run on the final swing continues the contestant until a miss.',
    '',
    'DATA AND MODEL HONESTY',
    '  In-game Statcast contact quality is a proxy for Derby batting-practice power; it is not a Derby BP measurement.',
    '  BP conversion, per-round fatigue, distance, exit velocity, and BP-pitcher quality are assumptions, not measurements.',
    `  This packet is ${view.model_data_quality === 'F' ? 'FIXTURE MODE: participant inputs are fixtures, not live 2026 Statcast data.' : 'based on supplied participant inputs; verify source freshness before publication.'}`,
    '',
    'MARKET CONTEXT — NOT IN SCORE',
    '  No market price, odds, bid, ask, volume, open interest, or price movement entered the model.',
    '',
    'PUBLICATION GATE',
    `  Quality ${view.model_data_quality}: relative rankings and broad tiers require D; exact outcome probabilities require C; exact HR, distance, 500+, and EV distributions require B.`,
    '  Names are never hard-coded into the public top tier; a player appears only when scenario stability and sampling separation support inclusion.',
    '',
    'UNCERTAINTY — TWO DISTINCT LAYERS',
    '  Monte Carlo sampling uncertainty: Wilson intervals measure finite-run repeatability only and remain in the internal research artifact.',
    `  Model/assumption uncertainty: ${view.uncertainty?.model_assumption?.qualitative_confidence ?? 'VERY_LOW'} confidence; conservative/base/aggressive scenario envelopes are not confidence intervals or total calibrated uncertainty.`,
    '',
    'SENSITIVITY SCENARIOS — UNCALIBRATED STRESS CASES',
  ];
  for (const scenario of view.sensitivity_summary.scenarios) {
    lines.push(`  - ${scenario.id}: ${scenario.description}`);
  }
  lines.push('  These parameters are configurable modeling choices; no historical calibration claim is made.');

  if (view.robust_conclusions) {
    lines.push('', 'ROBUST CONCLUSIONS — STABLE ACROSS CONSERVATIVE / BASE / AGGRESSIVE');
    for (const conclusion of Object.values(view.robust_conclusions.conclusions)) {
      lines.push(...renderRobustConclusion(conclusion));
    }
  } else {
    lines.push('', 'ROBUST CONCLUSIONS — SUPPRESSED', '  Quality below D cannot support public rankings or tiers.');
  }

  if (view.exact_outcomes.winner || view.exact_outcomes.round_1_leader) {
    lines.push('', 'EXACT RELATIVE OUTCOMES — ELIGIBLE AT QUALITY C+');
    if (view.exact_outcomes.winner) lines.push(...renderFigureMap('winner probabilities', view.exact_outcomes.winner.probabilities));
    if (view.exact_outcomes.round_1_leader) lines.push(...renderFigureMap('round_1_leader probabilities', view.exact_outcomes.round_1_leader.probabilities));
    if (view.exact_outcomes.qualifiers) {
      lines.push('qualifier probabilities:');
      for (const [name, value] of Object.entries(view.exact_outcomes.qualifiers)) lines.push(`  - ${renderFigure(name, value)}`);
    }
    if (view.exact_outcomes.finals_matchup) lines.push(...renderFigureMap('finals matchup probabilities', view.exact_outcomes.finals_matchup.probabilities, { maxRows: 8 }));
    if (view.exact_outcomes.finals_result) lines.push(...renderFigureMap('finals result probabilities', view.exact_outcomes.finals_result.probabilities));
    if (view.exact_outcomes.longest_hr_player) lines.push(...renderFigureMap('longest-HR player probabilities', view.exact_outcomes.longest_hr_player));
    if (view.exact_outcomes.highest_ev_player) lines.push(...renderFigureMap('highest-EV player probabilities', view.exact_outcomes.highest_ev_player));
  }

  if (view.exact_distributions.round_1_hr_totals) {
    lines.push('', 'EXACT ROUND 1 HR DISTRIBUTIONS — ELIGIBLE AT QUALITY B', 'round_1_hr_totals:');
    for (const [name, result] of Object.entries(view.exact_distributions.round_1_hr_totals)) {
      lines.push(`  ${name}:`);
      lines.push(...renderFigureMap('distribution', result.distribution, { maxRows: 4 }).map((line) => `    ${line}`));
    }
  }
  if (view.exact_distributions.tournament_total_home_runs) {
    lines.push('', 'EXACT TOURNAMENT TOTALS — ELIGIBLE AT QUALITY B');
    lines.push(...renderFigureMap('total HRs distribution', view.exact_distributions.tournament_total_home_runs.distribution, { maxRows: 8 }));
  }
  if (view.exact_distributions.home_runs_500_plus) {
    lines.push(...renderFigureMap('500+ ft HR count distribution', view.exact_distributions.home_runs_500_plus.distribution, { maxRows: 5 }));
  }
  if (view.exact_distributions.longest_hr_distance_ft) {
    lines.push('', 'EXACT DISTANCE DISTRIBUTIONS — ELIGIBLE AT QUALITY B');
    lines.push(...renderFigureMap('distance_ft', view.exact_distributions.longest_hr_distance_ft, { maxRows: 8 }));
    lines.push(...renderFigureMap('player_distance', view.exact_distributions.longest_hr_player_distance, { maxRows: 8 }));
  }
  if (view.exact_distributions.highest_ev_mph) {
    lines.push('', 'EXACT EXIT-VELOCITY DISTRIBUTIONS — ELIGIBLE AT QUALITY B');
    lines.push(...renderFigureMap('mph', view.exact_distributions.highest_ev_mph, { maxRows: 8 }));
    lines.push(...renderFigureMap('player_mph', view.exact_distributions.highest_ev_player_mph, { maxRows: 8 }));
  }

  if (view.suppressed_outputs.length) {
    lines.push('', 'SUPPRESSED INTERNAL-ONLY OUTPUTS');
    for (const output of view.suppressed_outputs) {
      lines.push(`  - ${output.label}: ${output.status === 'experimental_only' ? 'EXPERIMENTAL' : 'UNCALIBRATED'} — requires quality ${output.minimum_quality}; retained in the internal research artifact.`);
    }
  }
  lines.push('', 'ASSUMPTION / RULE-GAP STATUS');
  lines.push(`  BP power transform quality=${view.assumption_summary.bp_power_transform}; fatigue curve quality=${view.assumption_summary.fatigue_curve}; distance transform quality=${view.assumption_summary.distance_transform}; rule coverage quality=${view.assumption_summary.rule_coverage}.`);
  lines.push(`  support_kinds=${Object.entries(view.assumption_summary.support_kinds).map(([domain, kind]) => `${domain}:${kind}`).join('; ')}.`);
  lines.push(`  unverified_or_assumed_rule_gaps=${view.assumption_summary.unverified_rule_gap_count}; full rules ledger, tie/swing-off counts, and cap-event logs remain internal.`);
  lines.push('', '---', 'No trades placed by this workflow.', 'No bankroll advice. No order placement. Research only.');
  return lines.join('\n');
}

function renderBlockedPacket(projection) {
  const lines = [
    `CPC Packet: ${projection.event.name} — BLOCKED`,
    `date: ${projection.event.date}`,
    `venue: ${projection.event.venue}, ${projection.event.city}`,
    `generated_utc: ${projection.generated_utc}`,
    `seed: ${projection.seed}`,
    `simulations_requested: ${projection.simulations}`,
    `sources: ${FORMAT_SOURCE}`,
    '',
    'BLOCKED — NO IMPUTED PROBABILITIES',
    '  Required participant contact-quality data is missing or failed the profile quality gate.',
    ...projection.blocked_participants.map((participant) => `  - ${participant.name ?? 'unknown'}: ${participant.blocked_reasons.join(', ')}`),
    '',
    'DATA AND MODEL HONESTY',
    '  Derby power would be proxied from in-game Statcast; BP/max-effort power and fatigue are assumptions, not measurements.',
    '',
    'MARKET CONTEXT — NOT IN SCORE',
    '  No market data was used.',
    '',
    '---', 'No trades placed by this workflow.', 'No bankroll advice. No order placement. Research only.',
  ];
  return lines.join('\n');
}

export function renderDerbyPacket(projectionOrView) {
  const view = buildDerbyPublicView(projectionOrView);
  const text = view.status === 'blocked' ? renderBlockedPacket(view) : renderReadyPacket(view);
  assertCpcPacketValid(text, '2026 Home Run Derby packet', {
    product: 'mlb_hr_derby',
    data_quality: view.model_data_quality,
    status: view.status,
  });
  return text;
}

function buildInternalResearchArtifact(projection, ledger, publicView) {
  return {
    schema_version: 'mlb_hr_derby_internal_research_v1',
    product: 'INTERNAL_RESEARCH_ARTIFACT',
    generated_utc: projection.generated_utc,
    reproducibility: {
      seed: projection.seed,
      simulations_per_scenario: projection.simulations,
      sensitivity_scenarios: projection.sensitivity?.scenario_order ?? [],
      shared_seed_across_scenarios: projection.sensitivity?.shared_seed_across_scenarios ?? true,
      common_random_numbers: projection.sensitivity?.common_random_numbers ?? false,
    },
    quality_metadata: {
      model_data_quality: projection.model_data_quality,
      publication_policy: DERBY_PUBLICATION_RULES,
      publication_eligibility: projection.publication_eligibility,
      assumption_source_quality: Object.fromEntries(ledger.items.map((item) => [item.type, item.source_quality])),
      model_assumption_confidence: projection.uncertainty?.model_assumption?.qualitative_confidence ?? 'VERY_LOW',
    },
    assumptions: ledger.items,
    rule_gaps: ledger.items.filter((item) => item.status === 'ASSUMED' || item.status === 'UNKNOWN'),
    raw_distributions: projection.status === 'ready' ? {
      winner: projection.winner,
      round_1_leader: projection.round_1_leader,
      round_1_hr_totals: projection.round_1_hr_totals,
      qualifiers: projection.qualifiers,
      finals_matchup: projection.finals_matchup,
      finals_result: projection.finals_result,
      total_home_runs: projection.total_home_runs,
      longest_home_run: projection.longest_home_run,
      highest_exit_velocity: projection.highest_exit_velocity,
      home_runs_500_plus: projection.home_runs_500_plus,
    } : null,
    diagnostics: projection.status === 'ready' ? {
      dead_heats_and_swingoffs: projection.dead_heats,
      hot_hand: projection.hot_hand,
      total_accounting: projection.total_accounting,
      cap_event_logs: projection.cap_event_logs,
      simulation_trace: projection.simulation,
    } : null,
    uncertainty: projection.uncertainty ?? null,
    sensitivity: projection.sensitivity ?? null,
    robust_conclusions: projection.robust_conclusions ?? null,
    public_product_view: publicView,
    raw_projection: projection,
  };
}

export function buildHomeRunDerbyPacket(input = {}) {
  const projection = buildDerbyProjection(input);
  const generatedUtc = projection.generated_utc;
  const ledger = buildScopedLedger({
    scope: 'FULL_DAY_PREVIEW',
    date: DERBY_EVENT.date,
    items: assumptionsItems(
      generatedUtc,
      projection.assumptions,
      projection.quality_metadata?.assumption_support ?? DERBY_ASSUMPTION_SUPPORT_DEFAULTS,
    ),
    now: () => generatedUtc,
  });
  const projectionWithLedger = {
    ...projection,
    assumptions: ledger.items,
  };
  const publicView = buildDerbyPublicView(projectionWithLedger);
  const packetText = renderDerbyPacket(publicView);
  const internalArtifact = buildInternalResearchArtifact(projectionWithLedger, ledger, publicView);
  const inventoryText = buildInventoryArtifact({
    marketType: 'mlb_hr_derby',
    date: DERBY_EVENT.date,
    eventTicker: 'NONE',
    inventoryLines: Object.entries(projection.participant_models ?? {}).map(([name, model]) => `  - ${name}: status=${model.status ?? 'ready'} data_quality=${model.data_quality ?? 'F'}`),
    meta: { source_mode: projection.model_data_quality === 'F' ? 'FIXTURE' : 'SUPPLIED_INPUTS', price_isolation: 'true' },
  });
  const audit = {
    schema_version: 'mlb_hr_derby_audit_v2',
    generated_utc: generatedUtc,
    seed: projection.seed,
    simulations: projection.simulations,
    packet_sha256: createHash('sha256').update(packetText).digest('hex'),
    projection_sha256: createHash('sha256').update(JSON.stringify(projectionWithLedger)).digest('hex'),
    internal_research_sha256: createHash('sha256').update(JSON.stringify(internalArtifact)).digest('hex'),
    price_isolation: 'assertNoPriceFields passed on model input and output',
    public_render_path: 'packet rendered exclusively from the field-gated public product view',
    internal_research_location: 'internal-research.json; never rendered directly into the public packet',
    raw_inventory_location: 'inventory.txt; audit-only and not in the public packet',
    delivery_invoked: false,
  };
  return {
    projection: projectionWithLedger,
    publicView,
    internalArtifact,
    packetText,
    participantProfiles: projection.participant_profiles ?? {},
    simulationSummary: projection.simulation,
    assumptionsLedger: ledger,
    inventoryText,
    audit,
  };
}

export function buildFixtureHomeRunDerbyPacket(options = {}) {
  return buildHomeRunDerbyPacket({
    participants: fixtureDerbyParticipants(),
    seed: options.seed ?? 'cpc-hr-derby-phase3-fixture',
    simulations: options.simulations ?? 4000,
    as_of: options.as_of ?? DERBY_EVENT.date,
    generated_utc: options.generated_utc ?? '2026-07-13T00:00:00.000Z',
  });
}
