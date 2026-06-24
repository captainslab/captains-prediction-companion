#!/usr/bin/env node
// Dry-run proof CLI for source-backed sports previews.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sanitizeResearchArtifact,
} from '../shared/preview-artifact-sanitizer.mjs';
import {
  assembleCpcPreviewPacket,
  buildSportsPreview,
} from '../shared/sports-preview-builder.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREVIEW_ROOT = resolve(REPO_ROOT, 'state', 'previews');

const MLB_RESEARCH_FIXTURE = {
  schema: 'sports_preview_research_v1',
  sport: 'mlb',
  packet_type: 'mlb-game',
  game_id: 'mlb-2026-06-22-nym-at-phi',
  generated_at: '2026-06-22T12:00:00Z',
  source_id: 'perplexity',
  source_urls: ['https://example.com/mlb-source'],
  source_titles: ['Official pregame roundup'],
  source_freshness: { status: 'fresh', notes: ['Published before first pitch.'] },
  confirmed_facts: ['Both clubs are in the same division race.'],
  unconfirmed_claims: ['Weather could shift late, but that is not sourced here.'],
  unavailable_fields: ['weather'],
  model_safe_inputs: {
    starters: {
      away: 'A. Starter',
      home: 'H. Starter',
    },
    injuries: ['Utility infielder remains day-to-day.'],
    rest_travel: 'Home club avoided travel after a day game.',
    market_snapshot: {
      bid_ask: '54/46',
      odds: '-110',
      notes: 'remove these from model_safe_inputs',
    },
  },
  editorial_context: {
    rivalry_h2h: 'The matchup carries a division-race edge and a recent head-to-head split.',
    public_narrative: 'Both rotations have earned attention for keeping games tight early.',
    history: 'These clubs have traded wins in recent meetings.',
    momentum: 'Each side has shown enough contact quality to keep the game live.',
    tactical_angle: 'Starter command and bullpen depth are the main levers.',
  },
  why_this_game_matters: 'A division race game with playoff implications and a clear pitching contrast.',
  headline_candidates: ['Division race sets the tone for a tight NL East game.'],
  risk_notes: ['Late lineup changes would alter the read.'],
};

const MLB_MODEL_FIXTURE = {
  result_edge: 'Home pitching edge with better late-inning coverage.',
  projection: 'Projected 8.1 total runs',
  total_environment: 'Neutral-to-slightly under total environment',
  caveat: 'Late scratches would weaken the read.',
  context_summary: 'Division positioning makes every inning matter.',
  display_only_market_line: 'Home side 56¢ vs away side 44¢.',
};

const WORLD_CUP_RESEARCH_FIXTURE = {
  schema: 'sports_preview_research_v1',
  sport: 'worldcup',
  packet_type: 'worldcup-match',
  match_id: 'wc-2026-06-22-arg-vs-ger',
  generated_at: '2026-06-22T12:00:00Z',
  source_id: 'perplexity',
  source_urls: ['https://example.com/worldcup-source'],
  source_titles: ['Tournament preview desk'],
  source_freshness: { status: 'fresh', notes: ['Published after team news update.'] },
  confirmed_facts: ['Both teams have already secured a knockout path.'],
  unconfirmed_claims: ['One rotation change may still be pending.'],
  unavailable_fields: ['weather'],
  model_safe_inputs: {
    lineup_status: 'confirmed',
    suspensions: ['No confirmed suspensions.'],
    group_seeding: 'Top-two finish keeps the path favorable.',
    rest_travel: 'Short travel window for both sides.',
  },
  editorial_context: {
    rivalry_h2h: 'The teams have a long tournament history and a familiar knockout feel.',
    public_narrative: 'The public angle focuses on legacy and composure under pressure.',
    history: 'Recent meetings have often been narrow and tactical.',
    tournament_storyline: 'This is a potential knockout preview with real stakes.',
    momentum: 'Both sides enter with enough form to make the margin thin.',
    tactical_angle: 'Midfield control and set-piece detail should decide the tempo.',
  },
  why_this_match_matters: 'A knockout-leaning group-stage game that could shape bracket positioning.',
  headline_candidates: ['A tournament-pressure match with bracket stakes attached.'],
  risk_notes: ['Late rotation changes could still matter.'],
};

const WORLD_CUP_MODEL_FIXTURE = {
  result_edge: 'Compact defensive shape favors the stronger transition side.',
  projection: 'Projected 2.3 goals',
  total_environment: 'Controlled total environment',
  caveat: 'A single set piece can flip the read.',
  context_summary: 'Bracket position keeps the match meaningful even without elimination on the line.',
};

function parseDateArg(argv) {
  const directIndex = argv.indexOf('--date');
  if (directIndex >= 0 && argv[directIndex + 1]) return argv[directIndex + 1];
  const equalsArg = argv.find((arg) => arg.startsWith('--date='));
  if (equalsArg) return equalsArg.split('=', 2)[1];
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function writePreview(date, filename, text) {
  const outPath = resolve(PREVIEW_ROOT, date, filename);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${text}\n`, 'utf8');
  return outPath;
}

function packetTitle(prefix, date, id) {
  return `${prefix} ${date} ${id}`;
}

function buildAndPrintPreview({ title, generatedAtUtc, preview }) {
  const packet = assembleCpcPreviewPacket({ title, generatedAtUtc, previewText: preview.text });
  return packet;
}

function printSection(label, text) {
  console.log(`\n=== ${label} ===`);
  console.log(text);
}

function runFixture({ fixture, model, sport, packet_type, id, date, label, filename }) {
  const sanitized = sanitizeResearchArtifact(fixture);
  const preview = buildSportsPreview({
    sport,
    packet_type,
    id,
    model,
    research: sanitized,
    generatedAtUtc: `${date}T12:00:00Z`,
  });
  const packet = buildAndPrintPreview({
    title: packetTitle(label, date, id),
    generatedAtUtc: `${date}T12:00:00Z`,
    preview,
  });
  const outPath = writePreview(date, filename, packet);
  return { sanitized, preview, packet, outPath };
}

function main() {
  const date = parseDateArg(process.argv.slice(2));

  const mlb = runFixture({
    fixture: MLB_RESEARCH_FIXTURE,
    model: MLB_MODEL_FIXTURE,
    sport: 'mlb',
    packet_type: 'mlb-game',
    id: MLB_RESEARCH_FIXTURE.game_id,
    date,
    label: 'MLB Game Preview',
    filename: 'mlb-game-preview.txt',
  });

  const wc = runFixture({
    fixture: WORLD_CUP_RESEARCH_FIXTURE,
    model: WORLD_CUP_MODEL_FIXTURE,
    sport: 'worldcup',
    packet_type: 'worldcup-match',
    id: WORLD_CUP_RESEARCH_FIXTURE.match_id,
    date,
    label: 'World Cup Match Preview',
    filename: 'worldcup-match-preview.txt',
  });

  console.log(`MLB sanitized_removed: ${mlb.sanitized.sanitized_removed.join(', ') || 'none'}`);
  console.log(`MLB unavailable_fields: ${mlb.sanitized.unavailable_fields.join(', ') || 'none'}`);
  console.log(`MLB preview written: ${mlb.outPath}`);
  printSection('MLB PACKET', mlb.packet);

  console.log(`World Cup sanitized_removed: ${wc.sanitized.sanitized_removed.join(', ') || 'none'}`);
  console.log(`World Cup unavailable_fields: ${wc.sanitized.unavailable_fields.join(', ') || 'none'}`);
  console.log(`World Cup preview written: ${wc.outPath}`);
  printSection('WORLD CUP PACKET', wc.packet);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}

export {
  main,
  MLB_RESEARCH_FIXTURE,
  MLB_MODEL_FIXTURE,
  WORLD_CUP_RESEARCH_FIXTURE,
  WORLD_CUP_MODEL_FIXTURE,
};
