// NASCAR Stage 4 deterministic output writer (dry-run).
// Writes six files under <stateRoot>/nascar/<date>/:
//   race_manifest.json, source_registry.json, discovery.json,
//   ceiling_board.json, daily-nascar-guide.md, run_log.md
// Fixtures-only. No live network. No credentials. No trading.

import { writeJsonAtomic, writeTextAtomic, isoNow } from './cache.mjs';
import { runSourceAdapterDryRun } from '../source-adapter-dry-run.mjs';
import { composeRaceDiscovery } from './discovery.mjs';
import { composeCeilingBoard } from './ceiling.mjs';

const FROZEN_DEFAULT = '2026-02-13T12:00:00.000Z';

function applyEventFormatOverlay(envelopes, eventFormat) {
  if (!eventFormat || eventFormat === 'points') return envelopes;
  const official = envelopes.nascar_official;
  if (!official || !Array.isArray(official.records) || official.records.length === 0) {
    return envelopes;
  }
  return {
    ...envelopes,
    nascar_official: {
      ...official,
      records: official.records.map((r, i) =>
        i === 0
          ? {
              ...r,
              race_type: eventFormat,
              event_format: eventFormat,
              is_special_event: true,
              notes:
                'Special event: downstream discovery must mark special_event_override metadata; do not use as default points-race model.',
            }
          : r,
      ),
    },
  };
}

function freezeEnvelopeTimestamps(envelopes, frozen) {
  const out = {};
  for (const [id, env] of Object.entries(envelopes)) {
    out[id] = { ...env, checked_at_utc: frozen, cache_key: `${env.source_id}_${frozen}` };
  }
  return out;
}

function buildSourceRegistry({ envelopes, runDate, checkedAtUtc }) {
  const sources = {};
  for (const [id, env] of Object.entries(envelopes)) {
    sources[id] = {
      source_id: env.source_id,
      status: env.status,
      record_count: Array.isArray(env.records) ? env.records.length : 0,
      warnings: Array.isArray(env.warnings) ? env.warnings.length : 0,
      errors: Array.isArray(env.errors) ? env.errors.length : 0,
      required: env.required === true,
      source_urls: Array.isArray(env.source_urls) ? env.source_urls : [],
    };
  }
  return {
    schema_version: 'nascar_source_registry_v1',
    mode: 'fixtures-only',
    run_date: runDate,
    checked_at_utc: checkedAtUtc,
    sources,
    safety_notes: [
      'Source registry only summarizes Stage 2 envelope metadata.',
      'No trades placed by this workflow.',
    ],
  };
}

function buildRaceManifest({ discovery, runDate, checkedAtUtc, eventFormat }) {
  return {
    schema_version: 'nascar_race_manifest_v1',
    run_date: runDate,
    checked_at_utc: checkedAtUtc,
    event_context: discovery.event_context,
    event_format: discovery.event_context?.event_format ?? eventFormat,
    special_event_override: discovery.special_event_override,
    supported_market_lanes: discovery.supported_market_lanes,
    pool_rules: discovery.pool_rules,
    run_metadata: {
      mode: 'fixtures-only',
      generator: 'scripts/nascar/lib/output-writer.mjs',
      stage: 'stage_4_output_writer_dry_run',
      no_trades: true,
    },
  };
}

function renderGuide({ manifest, board }) {
  const ctx = manifest.event_context ?? {};
  const lines = [];
  lines.push('# NASCAR Daily Research Board (Dry Run)');
  lines.push('');
  lines.push(`Run date: ${manifest.run_date ?? 'unknown'}`);
  lines.push(`Race: ${ctx.race_name ?? 'unknown'}`);
  lines.push(`Series: ${ctx.series ?? 'unknown'}`);
  lines.push(`Track: ${ctx.track ?? 'unknown'}`);
  lines.push(`Event format: ${manifest.event_format ?? 'points'}`);
  lines.push(
    `Special event override: ${manifest.special_event_override?.active ? 'ACTIVE' : 'inactive'}`,
  );
  lines.push('');
  lines.push('## Driver Ceiling Labels');
  lines.push('');
  if (board.ceilings.length === 0) {
    lines.push('- (no active candidate drivers)');
  } else {
    for (const entry of board.ceilings) {
      lines.push(`- ${entry.driver_name} ${entry.ceiling_label}`);
    }
  }
  lines.push('');
  lines.push('## FIELD / Longshots');
  lines.push('');
  const fb = board.field_bucket ?? {};
  lines.push(`- FIELD / Longshots: ${fb.summary ?? 'no field bucket summary available.'}`);
  lines.push('');
  lines.push('## Safety');
  lines.push('');
  lines.push('Research output only. Not picks, not recommendations.');
  lines.push('No trades placed by this workflow.');
  lines.push('');
  return lines.join('\n');
}

function renderRunLog({ runDate, checkedAtUtc, outputDir, eventFormat, files }) {
  const lines = [];
  lines.push('# NASCAR Output Writer Dry Run');
  lines.push('');
  lines.push(`Run date: ${runDate}`);
  lines.push(`Checked at UTC: ${checkedAtUtc}`);
  lines.push(`Event format: ${eventFormat}`);
  lines.push(`Output directory: ${outputDir}`);
  lines.push('Mode: fixtures-only');
  lines.push('No live network, no credentials, no order placement.');
  lines.push('');
  lines.push('## Files written');
  lines.push('');
  for (const f of files) lines.push(`${f}`);
  lines.push('');
  lines.push('## Dry-run proof');
  lines.push('');
  lines.push('No trades placed by this workflow.');
  lines.push('');
  return lines.join('\n');
}

export async function runOutputWriterDryRun({
  date = '2026-02-13',
  eventFormat = 'points',
  series = 'cup',
  stateRoot = 'state',
  frozenCheckedAtUtc = FROZEN_DEFAULT,
} = {}) {
  const runDate = date;
  const outputDir = `${stateRoot}/nascar/${runDate}`;
  const checkedAtUtc = frozenCheckedAtUtc ?? isoNow();

  const { envelopes: rawEnvelopes } = await runSourceAdapterDryRun({
    date: runDate,
    source: 'all',
    eventFormat,
    series,
    out: `${outputDir}/discovery`,
  });

  const envelopes = freezeEnvelopeTimestamps(
    applyEventFormatOverlay(rawEnvelopes, eventFormat),
    checkedAtUtc,
  );

  const discovery = composeRaceDiscovery({
    envelopes,
    runDate,
    checkedAtUtc,
  });

  const ceilingBoard = composeCeilingBoard({ discovery });
  const manifest = buildRaceManifest({ discovery, runDate, checkedAtUtc, eventFormat });
  const registry = buildSourceRegistry({ envelopes, runDate, checkedAtUtc });
  const guide = renderGuide({ manifest, board: ceilingBoard });

  const files = [
    'race_manifest.json',
    'source_registry.json',
    'discovery.json',
    'ceiling_board.json',
    'daily-nascar-guide.md',
    'run_log.md',
  ];

  writeJsonAtomic(`${outputDir}/race_manifest.json`, manifest);
  writeJsonAtomic(`${outputDir}/source_registry.json`, registry);
  writeJsonAtomic(`${outputDir}/discovery.json`, discovery);
  writeJsonAtomic(`${outputDir}/ceiling_board.json`, ceilingBoard);
  writeTextAtomic(`${outputDir}/daily-nascar-guide.md`, guide);
  writeTextAtomic(
    `${outputDir}/run_log.md`,
    renderRunLog({ runDate, checkedAtUtc, outputDir, eventFormat, files }),
  );

  return {
    runDate,
    outputDir,
    eventFormat,
    files: files.map(f => `${outputDir}/${f}`),
    manifest,
    registry,
    discovery,
    ceilingBoard,
  };
}
