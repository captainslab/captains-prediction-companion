#!/usr/bin/env node
// Single-event mentions packet command.
//
// Produces ONE source-backed, customer-facing mention-event packet for a single
// Kalshi mention event from a NORMALIZED, source-backed research artifact, then
// banks the six lineage'd research-bank files and prints a price-isolation /
// contract proof summary.
//
// This is the smallest safe single-event entry point and it reuses the same
// CPC mentions stack as the daily path:
//   - deterministic route resolver (scripts/mentions/mention-route-resolver.mjs)
//   - model/profile router (scripts/mentions/model-router.mjs)
//   - sanitized research artifact + research bank (preview-artifact-sanitizer.mjs,
//     cpc-research-bank.mjs)
//   - deterministic CPC packet renderer (scripts/mentions/render-mention-packet.mjs)
//   - CPC packet contract / janitor validation
//
// NO live Perplexity call, NO Telegram send, NO trading/order API. The embedded
// normalized artifact captures research the controller fetched fresh for this
// run from primary/official-first sources (Kalshi event metadata + Roll Call
// Factbase calendar + news confirmation); it is NOT invented. Anything that was
// not source-confirmed at research time is marked "unavailable".
//
// Usage:
//   node scripts/packets/generate-mention-event-proof.mjs --event KXTRUMPMENTION-26JUN23 [--date 2026-06-23]

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertCpcResearchArtifact,
} from '../shared/cpc-research-artifact-schema.mjs';
import { CPC_RESEARCH_PROMPT_BUILDERS } from '../shared/perplexity-preview-prompts.mjs';
import {
  sanitizeResearchArtifact,
  assertNoMarketLeak,
} from '../shared/preview-artifact-sanitizer.mjs';
import {
  scrubCustomerText,
  findBannedCustomerWord,
} from '../shared/sports-preview-builder.mjs';
import { validateCpcCustomerPacket } from './lib/cpc-packet-validator.mjs';
import { writeResearchBankArtifacts } from '../shared/cpc-research-bank.mjs';
import { resolveResearchRoute } from '../mentions/mention-route-resolver.mjs';
import {
  buildMentionsSynthesisInput,
  composeMentionPacketDeterministic,
  describeMentionsHermesInvocation,
} from './generate-mentions-daily.mjs';
import { loadModelRouting, resolveTier } from '../mentions/model-router.mjs';

// --- arg parsing -----------------------------------------------------------

function parseArg(argv, flag, fallback = null) {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return fallback;
}

// --- embedded source-backed research, keyed by event_id --------------------
//
// Each builder returns { event, normalized } where `event` is the minimal
// text/ticker object handed to the DETERMINISTIC route resolver (never price),
// and `normalized` is the source-backed cpc_research_artifact_v1 (route field
// is overwritten by the resolver's verdict downstream).

const CHECKED_AT = '2026-06-23T18:30:00Z';

function fresh(url) {
  return { url, published_at: 'unavailable', checked_at: CHECKED_AT, freshness: 'same_day' };
}

function trumpMackTrucksEvent() {
  // Minimal event object for the deterministic resolver: title + tickers only.
  const event = {
    event_ticker: 'KXTRUMPMENTION-26JUN23',
    series_ticker: 'KXTRUMPMENTION',
    title: 'What will Donald Trump say during Remarks at Mack Trucks?',
    sub_title: 'Mack Trucks Lehigh Valley Operations, Macungie, PA',
  };

  // Source-backed strike catalog (watched phrases) read from the Kalshi event
  // metadata. These are market terms, NOT price data.
  const strike_catalog = [
    'Event does not qualify (EDNQ)', 'Bibi / Netanyahu', 'Israel / Israeli', 'Iran (5+ times)',
    'Hormuz', 'Oil', 'Stock Market', 'Crypto / Bitcoin', 'Hottest', 'First Term',
    'China / Chinese', 'Tariff', 'Barack Hussein Obama', 'Biden', '250', 'Gulf of America',
    'Dumbocrat / Dumacrat', 'Democrat', 'Nuclear', 'Manufacture / Manufacturing',
    'AI / Artificial Intelligence', 'Data Center', 'Fraud', 'World Cup', 'Gas / Gasoline',
    'America First', 'Fake News', 'Afford / Affordable / Affordability', 'Transgender',
    'Venezuela', 'Soleimani',
  ];

  const normalized = {
    schema: 'cpc_research_artifact_v1',
    packet_family: 'mentions',
    packet_type: 'public-figure-mention',
    route: 'trump_event', // overwritten by deterministic resolver below
    submarket: 'event',
    event_id: 'KXTRUMPMENTION-26JUN23',
    market_id: 'KXTRUMPMENTION-26JUN23',
    event_url: 'https://kalshi.com/markets/kxtrumpmention/what-will-trump-say/KXTRUMPMENTION-26JUN23',
    generated_at: CHECKED_AT,
    source_id: 'perplexity',
    source_urls: [
      'https://kalshi.com/markets/kxtrumpmention/what-will-trump-say/KXTRUMPMENTION-26JUN23',
      'https://rollcall.com/factbase/trump/calendar/',
      'https://www.abc27.com/pennsylvania/president-trump-to-visit-pennsylvania-manufacturing-plant/',
      'https://www.inquirer.com/politics/pennsylvania/trump-mack-trucks-lower-macungie-visit-lehigh-valley-20260622.html',
    ],
    source_titles: [
      'What will Donald Trump say during Remarks at Mack Trucks? | Kalshi',
      "Roll Call Factbase — Donald J. Trump's Public Schedule",
      'President Trump to visit Pennsylvania manufacturing plant | ABC27',
      'Trump to visit Pa. Tuesday as the battle for control of Congress heats up in the Lehigh Valley | The Philadelphia Inquirer',
    ],
    source_freshness: [
      fresh('https://kalshi.com/markets/kxtrumpmention/what-will-trump-say/KXTRUMPMENTION-26JUN23'),
      fresh('https://rollcall.com/factbase/trump/calendar/'),
      fresh('https://www.abc27.com/pennsylvania/president-trump-to-visit-pennsylvania-manufacturing-plant/'),
      fresh('https://www.inquirer.com/politics/pennsylvania/trump-mack-trucks-lower-macungie-visit-lehigh-valley-20260622.html'),
    ],
    confirmed_facts: [
      "Roll Call Factbase's public schedule lists President Trump delivering Remarks at Mack Trucks Lehigh Valley Operations in Macungie, Pennsylvania, on the afternoon of June 23, 2026 (listed about 2:05 p.m. Eastern).",
      'The Kalshi event "What will Donald Trump say during Remarks at Mack Trucks?" lists 31 markets, each tracking whether Trump says a specified word or phrase during the remarks.',
      'Kalshi settlement is based on the live broadcast or stream; the exact word or phrase (including plural or possessive forms) must be said, and the event must be open to press for live televised or streamed coverage to qualify.',
      'A dedicated "Event does not qualify" (EDNQ) market resolves YES and all other markets resolve NO if the event is cancelled or fails the payout criteria.',
      'News outlets (ABC27, Fox43, The Philadelphia Inquirer, Just The News) report the Macungie visit as Trump\'s first major public appearance outside Washington since an interim agreement to wind down the conflict with Iran, framed around manufacturing and the economy ahead of the November 2026 midterms.',
    ],
    unconfirmed_claims: [
      'An official White House transcript or official video URL for these specific remarks was not posted at research time.',
      'A full prepared-remarks document was not available at research time; the remarks may be partly unscripted.',
    ],
    unavailable_fields: [
      'official_transcript_status',
      'official_video_status',
      'prepared_remarks_status',
    ],
    model_safe_inputs: {
      speaker_identity: 'Donald Trump, speaking in an official capacity',
      event_type: 'Public remarks at a manufacturing facility (Mack Trucks Lehigh Valley Operations)',
      horizon: 'event',
      official_schedule: 'Roll Call Factbase public schedule lists Remarks at Mack Trucks, Macungie PA, afternoon of June 23, 2026.',
      venue_or_platform: 'Mack Trucks Lehigh Valley Operations, Macungie, Pennsylvania',
      prepared_remarks_status: 'unavailable',
      official_transcript_status: 'unavailable',
      official_video_status: 'Live broadcast/stream expected per news coverage; official White House video URL unavailable at research time.',
      agenda_topics: ['manufacturing', 'economy', 'tariffs', 'energy', 'Iran agreement', 'midterm framing'],
      associated_official_documents: 'unavailable',
      eligible_speaker_rule: 'Donald Trump speaking in official capacity; previously aired/archival footage and unofficial statements are excluded.',
      settlement_window: 'Resolution uses the live broadcast/stream of the Mack Trucks remarks (about 1:05 p.m. Central, Tuesday June 23, 2026); the Kalshi market closes in early July 2026.',
      settlement_rule_summary: 'Exact word/phrase (or plural/possessive form) said during the live remarks resolves the matching market YES; non-qualifying or cancelled event resolves the EDNQ market YES and the rest NO.',
      strike_catalog,
      strike_count: String(strike_catalog.length),
      // Source-backed market RESIDUE: Kalshi returns live prices on every
      // market. It is present-on-Kalshi only and must be stripped before any
      // scoring/posture. The sanitizer removes this key (never a model input).
      market_snapshot: 'Per-strike prices exist on Kalshi; display-only and stripped before scoring — never a model input.',
    },
    editorial_context: {
      issue_salience: 'The strike catalog leans heavily on the Iran/Israel conflict (Iran, Israel, Bibi, Hormuz, Nuclear, Soleimani, Oil) and the manufacturing/economy frame (Manufacture, Tariff, America First, Data Center, AI, Stock Market), matching the reported framing of the appearance.',
      prior_event_continuity: 'This is described as Trump\'s first major out-of-Washington appearance since the interim Iran agreement, so geopolitical and economic vocabulary is plausibly elevated relative to a routine factory visit.',
      audience_context: 'A heavy-truck manufacturing workforce in a Lehigh Valley swing region ahead of the November 2026 midterms.',
    },
    // display-only market context (no numbers); survives sanitization.
    market_context: {
      display_only: true,
      text: 'Each strike trades on Kalshi with its own live price; all market prices are display-only context and are NOT IN SCORE.',
    },
    why_this_matters: 'The settlement word/phrase set is fixed and public, and the appearance is a confirmed, scheduled, likely-televised event, so the research question is which sourced topics frame the remarks — not a price view.',
    headline_candidates: [
      'Trump\'s Mack Trucks remarks anchor a 31-term mention market spanning Iran-conflict and manufacturing vocabulary',
    ],
    risk_notes: [
      'Remarks may be partly unscripted, so topic vocabulary is uncertain.',
      'Qualification risk: the event must stay open to press and be live televised/streamed, or the EDNQ market governs.',
      'Counting strikes (e.g. "Iran 5+ times") depend on the official record/broadcast, which may lag the live event.',
    ],
  };

  return { event, normalized };
}

const EVENT_BUILDERS = Object.freeze({
  'KXTRUMPMENTION-26JUN23': trumpMackTrucksEvent,
});

// --- customer-facing renderer ----------------------------------------------

// Strip ISO timestamps, local fs paths, and module paths from customer text.
function scrubLeaks(text) {
  return String(text ?? '')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?Z?/g, '(time withheld)')
    .replace(/\/home\/[^\s]*/g, '(path withheld)')
    .replace(/[\w./-]+\.mjs/g, '(module withheld)');
}

function clean(text) {
  return scrubCustomerText(scrubLeaks(text));
}

function bullet(label, value) {
  return `- ${label}: ${clean(value)}`;
}

// Deterministic model read. No price, no probability, no pick/lean/watch.
function buildModelRead(sanitized, routeResult) {
  const inputs = sanitized.model_safe_inputs || {};
  return [
    `Route family: ${routeResult.route} (profile ${routeResult.profile_key}); deterministic CPC routing, not model-classified.`,
    'CPC does not predict whether any phrase will be said. The watched-term set is the market\'s own published catalog, and settlement is decided by the live broadcast of the remarks.',
    `Source-backed framing: ${clean(inputs.agenda_topics ? [].concat(inputs.agenda_topics).join(', ') : 'unavailable')}.`,
    'Read: a confirmed, scheduled, likely-televised appearance with a fixed public word/phrase catalog; the model surfaces sourced topic salience only and assigns no market-implied probability.',
  ];
}

function renderSingleEventPacket({ date, sanitized, routeResult }) {
  const inputs = sanitized.model_safe_inputs || {};
  const facts = Array.isArray(sanitized.confirmed_facts) ? sanitized.confirmed_facts : [];
  const editorial = sanitized.editorial_context || {};
  const strikes = Array.isArray(inputs.strike_catalog) ? inputs.strike_catalog : [];
  const sources = (sanitized.source_titles || []).map((t, i) => `  - ${clean(t)} (${clean((sanitized.source_urls || [])[i] || 'url unavailable')})`);
  const unavailable = (sanitized.unavailable_fields || []).map((f) => String(f).replace(/_/g, ' '));
  const freshnessLabels = (sanitized.source_freshness || []).map((f) => f?.freshness).filter(Boolean);

  const lines = [];
  lines.push('=== Captain Mentions — CPC Packet: TRUMP MENTION EVENT ===');
  lines.push(`date: ${date}`);
  lines.push('packet_type: mention-event');
  lines.push(`route: public-figure-mention / ${routeResult.route}`);
  lines.push(`event_id: ${sanitized.event_id}`);
  lines.push(`generated_utc: ${date}`);
  lines.push('Market Context — NOT IN SCORE: market prices are display-only and never a model input.');
  lines.push('No trades placed by this workflow. Research only.');
  lines.push('');

  lines.push('1. EVENT PREVIEW — WHY THIS MATTERS');
  lines.push(clean(sanitized.headline_candidates?.[0] || 'Public-figure mention event.'));
  lines.push(clean(sanitized.why_this_matters || 'unavailable'));
  lines.push('');

  lines.push('2. MARKET / SETTLEMENT SCOPE');
  lines.push(bullet('Event', 'What will Donald Trump say during Remarks at Mack Trucks?'));
  lines.push(bullet('Eligible speaker', inputs.eligible_speaker_rule || inputs.speaker_identity || 'unavailable'));
  lines.push(bullet('Source window', inputs.settlement_window || 'unavailable'));
  lines.push(bullet('Settlement rule', inputs.settlement_rule_summary || 'unavailable'));
  lines.push(bullet('Watched strikes', `${strikes.length} markets — ${strikes.slice(0, 8).join('; ')}${strikes.length > 8 ? '; …(full list in section 5)' : ''}`));
  lines.push(bullet('Rules caveat', (sanitized.risk_notes || []).join(' ')));
  lines.push(bullet('Unavailable fields', unavailable.length ? unavailable.join(', ') : 'none'));
  lines.push('');

  lines.push('3. SOURCE-BACKED CONTEXT');
  for (const f of facts) lines.push(`- ${clean(f)}`);
  lines.push(bullet('Issue framing', editorial.issue_salience || 'unavailable'));
  lines.push(bullet('Prior-event continuity', editorial.prior_event_continuity || 'unavailable'));
  lines.push(bullet('Official transcript / video', inputs.official_video_status || 'unavailable'));
  lines.push('Sources:');
  for (const s of sources) lines.push(s);
  lines.push('');

  lines.push('4. MODEL READ');
  for (const l of buildModelRead(sanitized, routeResult)) lines.push(`- ${clean(l)}`);
  lines.push('');

  lines.push('5. SOURCE QUALITY / CAVEATS');
  lines.push(bullet('Source count', String((sanitized.source_urls || []).length)));
  lines.push(bullet('Source freshness', freshnessLabels.length ? freshnessLabels.join(', ') : 'unavailable'));
  lines.push(bullet('Transcript / video status', inputs.official_video_status || 'unavailable'));
  lines.push(bullet('Unavailable fields', unavailable.length ? unavailable.join(', ') : 'none'));
  for (const r of (sanitized.risk_notes || [])) lines.push(`- Caveat: ${clean(r)}`);
  lines.push('Full strike catalog:');
  for (const s of strikes) lines.push(`  - ${clean(s)}`);
  lines.push('');

  lines.push('---');
  lines.push('Market prices are display-only when present and are NOT IN SCORE.');
  lines.push('Research only. No trades.');

  return lines.join('\n');
}

// --- main ------------------------------------------------------------------

function priceIsolationProof(sanitized, packetText) {
  const result = { pass: true, checks: {} };
  try {
    assertNoMarketLeak(sanitized.model_safe_inputs);
    result.checks.no_market_leak = 'PASS';
  } catch (err) {
    result.checks.no_market_leak = `FAIL: ${err.message}`;
    result.pass = false;
  }
  const banned = findBannedCustomerWord(packetText);
  result.checks.no_banned_customer_word = banned ? `FAIL: "${banned}"` : 'PASS';
  if (banned) result.pass = false;

  result.checks.no_fs_paths = /\/home\//.test(packetText) || /\.mjs/.test(packetText) ? 'FAIL' : 'PASS';
  if (result.checks.no_fs_paths === 'FAIL') result.pass = false;

  result.checks.no_iso_timestamps = /\d{4}-\d\d-\d\dT\d\d:\d\d/.test(packetText) ? 'FAIL' : 'PASS';
  if (result.checks.no_iso_timestamps === 'FAIL') result.pass = false;

  // Defense in depth: cent/odds-style numbers must not appear in customer text.
  result.checks.no_price_numbers = /\b\d{1,3}\s?(?:cents?|¢)\b/i.test(packetText) || /[-+]\d{3}\b/.test(packetText)
    ? 'FAIL' : 'PASS';
  if (result.checks.no_price_numbers === 'FAIL') result.pass = false;

  return result;
}

function main() {
  const argv = process.argv.slice(2);
  const eventId = parseArg(argv, '--event', 'KXTRUMPMENTION-26JUN23');
  const date = parseArg(argv, '--date', '2026-06-23');

  const builder = EVENT_BUILDERS[eventId];
  if (!builder) {
    console.error(`No source-backed single-event builder for ${eventId}.`);
    console.error(`Known events: ${Object.keys(EVENT_BUILDERS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const { event, normalized } = builder();

  // 1) Deterministic route resolution (never price). CPC owns the route.
  const routeResult = resolveResearchRoute(event, { now: new Date(`${date}T12:00:00Z`) });
  normalized.route = routeResult.route;

  // 2) Confirm the Trump prompt contract from the research extraction layer is
  //    the one this packet type binds to (proof only; no live model call).
  const promptContract = CPC_RESEARCH_PROMPT_BUILDERS['public-figure-mention']({
    event_id: normalized.event_id,
    market_id: normalized.market_id,
    event_url: normalized.event_url,
    route: routeResult.route,
    submarket: 'event',
    date_central: date,
  });

  // 3) Validate the source-backed artifact against the shared schema.
  assertCpcResearchArtifact(normalized, eventId);

  // 4) Sanitize (strip any market residue before anything downstream).
  const sanitized = sanitizeResearchArtifact(normalized);
  assertNoMarketLeak(sanitized.model_safe_inputs);

  // 5) Render the customer-facing single-event packet.
  const packetText = renderSingleEventPacket({ date, sanitized, routeResult });

  // 6) Contract + price-isolation proof.
  const contract = validateCpcCustomerPacket(packetText);
  const priceProof = priceIsolationProof(sanitized, packetText);

  // 7) Bank the six lineage'd research-bank files.
  const builderInput = {
    sanitized_artifact: sanitized,
    prompt_contract: { packet_type: promptContract.packet_type, route: promptContract.route, submarket: promptContract.submarket },
    cpc_model_output: { note: 'Deterministic CPC model output is produced by CPC code, not by any external model.' },
  };
  const { dir: bankDir } = writeResearchBankArtifacts({
    date,
    packet_family: sanitized.packet_family,
    packet_type: sanitized.packet_type,
    event_id: sanitized.event_id,
    route: sanitized.route,
    submarket: sanitized.submarket,
    raw: normalized,
    normalized,
    sanitized,
    builderInput,
    previewText: packetText,
    lineage: {
      generated_at: normalized.generated_at,
      source_id: normalized.source_id,
      source_urls: normalized.source_urls,
      source_titles: normalized.source_titles,
      source_freshness: normalized.source_freshness,
    },
  });

  // 8) Write the customer-facing packet artifact (dry-run; never sent).
  const previewsDir = path.join(process.cwd(), 'state', 'previews', date, 'mention-event');
  fs.mkdirSync(previewsDir, { recursive: true });
  const packetPath = path.join(previewsDir, `${eventId}.txt`);
  fs.writeFileSync(packetPath, `${packetText}\n`, 'utf8');

  // 9) Proof summary.
  console.log('CPC single-event mention packet proof');
  console.log('='.repeat(64));
  console.log(`event_id:            ${eventId}`);
  console.log(`packet_path:         ${packetPath}`);
  console.log(`research_bank_dir:   ${bankDir}`);
  console.log(`route_resolver:      route=${routeResult.route} basis=${routeResult.basis} profile=${routeResult.profile_key} entity=${routeResult.entity}`);
  console.log(`model_profile:       ${routeResult.profile_key} (deterministic renderer; no Hermes call)`);
  console.log(`prompt_contract:     packet_type=${promptContract.packet_type} route=${promptContract.route} submarket=${promptContract.submarket}`);
  console.log(`source_count:        ${(sanitized.source_urls || []).length}`);
  console.log(`source_freshness:    ${(sanitized.source_freshness || []).map((f) => f.freshness).join(', ')}`);
  console.log(`sanitized_removed:   ${JSON.stringify(sanitized.sanitized_removed || [])}`);
  console.log(`unavailable_fields:  ${JSON.stringify(sanitized.unavailable_fields || [])}`);
  console.log(`contract_valid:      ${contract.valid ? 'PASS' : `FAIL: ${contract.errors.join('; ')}`}`);
  console.log(`price_isolation:     ${priceProof.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(priceProof.checks)}`);
  console.log('Sources:');
  for (let i = 0; i < (sanitized.source_titles || []).length; i += 1) {
    console.log(`  - ${sanitized.source_titles[i]} :: ${sanitized.source_urls[i]}`);
  }

  if (!contract.valid || !priceProof.pass) {
    process.exitCode = 1;
  }
}

main();
