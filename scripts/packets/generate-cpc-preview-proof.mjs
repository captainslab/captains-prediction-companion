#!/usr/bin/env node
// Proof CLI for the reusable CPC Perplexity extraction layer.
//
// Generates one source-backed research artifact per concrete Kalshi fixture
// from EMBEDDED normalized fixtures (NO live Perplexity, NO network, NO
// Telegram, NO trading/order APIs), sanitizes each, writes the six lineage'd
// bank files, and prints a per-artifact + global price-isolation summary.
//
// Usage: node scripts/packets/generate-cpc-preview-proof.mjs --date 2026-06-22

import process from 'node:process';

import {
  assertCpcResearchArtifact,
  makeEmptyCpcResearchArtifact,
} from '../shared/cpc-research-artifact-schema.mjs';
import {
  sanitizeResearchArtifact,
  assertNoMarketLeak,
} from '../shared/preview-artifact-sanitizer.mjs';
import {
  scrubCustomerText,
  findBannedCustomerWord,
  assembleCpcPreviewPacket,
} from '../shared/sports-preview-builder.mjs';
import { writeResearchBankArtifacts } from '../shared/cpc-research-bank.mjs';

function parseDate(argv) {
  const idx = argv.indexOf('--date');
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return '2026-06-22';
}

function freshness(url, checkedAt) {
  return { url, published_at: 'unavailable', checked_at: checkedAt, freshness: 'same_day' };
}

const CHECKED_AT = '2026-06-22T13:05:00Z';

// --- Embedded normalized fixtures (source-backed; not live) -----------------

function mlbGameFixture() {
  return {
    schema: 'cpc_research_artifact_v1',
    packet_family: 'sports',
    packet_type: 'mlb-game',
    route: 'mlb_game',
    submarket: 'game_preview',
    event_id: 'KXMLBGAME-26JUN221810NYYDET',
    market_id: 'KXMLBGAME-26JUN221810NYYDET',
    event_url: 'https://kalshi.com/markets/kxmlbgame/professional-baseball-game/KXMLBGAME-26JUN221810NYYDET',
    generated_at: CHECKED_AT,
    source_id: 'perplexity',
    source_urls: ['https://www.mlb.com/probable-pitchers', 'https://www.mlb.com/standings'],
    source_titles: ['Baseball Probable Pitchers | MLB.com', '2026 MLB Standings and Records: Regular Season | MLB.com'],
    source_freshness: [freshness('https://www.mlb.com/probable-pitchers', CHECKED_AT), freshness('https://www.mlb.com/standings', CHECKED_AT)],
    confirmed_facts: [
      'Yankees are 46-30 and Tigers are 33-44 in late June.',
      'The listed venue is Comerica Park.',
      'The probable pitchers page lists Gerrit Cole and Framber Valdez for this game.',
    ],
    unconfirmed_claims: ['Official starting lineups were not yet posted at retrieval time.'],
    unavailable_fields: ['confirmed_lineups'],
    model_safe_inputs: {
      probable_pitchers: { away: 'Gerrit Cole', home: 'Framber Valdez' },
      standings_context: { away_record: '46-30', home_record: '33-44' },
      venue_weather_roof: { venue: 'Comerica Park', weather: 'unavailable', roof_status: 'unavailable' },
      // Banned market residue — must be stripped by the sanitizer.
      market_snapshot: { bid_ask: '58/44', odds: '-132', implied_probability: 0.58 },
      yes_bid: 58,
      volume: 18230,
    },
    editorial_context: {
      public_narrative: 'A brand-name Yankees road game against a below-.500 Detroit club.',
      tactical_matchup: 'A veteran right-hander against a left-handed starter shapes the pregame frame.',
    },
    market_context: { display_only: true, text: 'Market context only: NYY 58c, DET 44c.' },
    why_this_matters: 'The Yankees enter as a division leader while Detroit is chasing ground in the AL Central, making the matchup relevant to both standings races.',
    headline_candidates: ['Division leader meets spoiler candidate in Detroit'],
    risk_notes: ['Starting lineups remained unavailable at retrieval time.'],
  };
}

function hearingWordBankFixture() {
  return {
    schema: 'cpc_research_artifact_v1',
    packet_family: 'mentions',
    packet_type: 'hearing-word-bank-mention',
    route: 'debate_hearing',
    submarket: 'word_bank_threshold',
    event_id: 'KXHEARINGMENTION-26JUN23B',
    market_id: 'KXHEARINGMENTION-26JUN23B:TRUMP_3PLUS',
    event_url: 'https://kalshi.com/markets/kxhearingmention/hearing-mention/KXHEARINGMENTION-26JUN23B',
    generated_at: '2026-06-22T13:08:00Z',
    source_id: 'perplexity',
    source_urls: ['https://www.banking.senate.gov/hearings', 'https://www.banking.senate.gov/hearings/witness-list'],
    source_titles: [
      'Hearings | United States Committee on Banking, Housing, and Urban Affairs',
      'Witness List | Hearings | United States Committee on Banking, Housing, and Urban Affairs',
    ],
    source_freshness: [
      freshness('https://www.banking.senate.gov/hearings', '2026-06-22T13:08:00Z'),
      freshness('https://www.banking.senate.gov/hearings/witness-list', '2026-06-22T13:08:00Z'),
    ],
    confirmed_facts: [
      "The committee has an upcoming hearing titled 'The Affordability Agenda' in Dirksen 538.",
      'The committee maintains a first-party witness-list page.',
    ],
    unconfirmed_claims: ['A final transcript posting timeline was not confirmed.'],
    unavailable_fields: ['official_transcript_url'],
    model_safe_inputs: {
      committee_or_agency: 'Senate Banking Committee',
      hearing_title: 'The Affordability Agenda',
      speaker_scope: 'witnesses',
      word_bank: ['American Dream', 'Fannie / Freddie', 'Trump'],
      threshold_rule: 'Trump (3+ times)',
      counting_rule: 'Use the official hearing record for counted mentions when available.',
      transcript_status: 'unavailable',
      // Banned market residue — must be stripped by the sanitizer.
      market_snapshot: { bid_ask: '38/62', yes_no_price: '38c / 62c' },
      implied_probability: 0.38,
    },
    editorial_context: {
      high_frequency_topic_candidates: 'Housing affordability and mortgage-market language are central to the hearing title.',
      phrase_collision_risk: 'Generic housing language may dominate the event even if strike terms are politically salient.',
    },
    why_this_matters: 'The hearing title and witness structure suggest a narrow policy vocabulary, which matters for any threshold or word-bank settlement.',
    headline_candidates: ['Affordability hearing narrows the likely word-bank universe'],
    risk_notes: ['Transcript timing may lag the live event.'],
  };
}

function worldCupMatchFixture() {
  return makeEmptyCpcResearchArtifact({
    packet_family: 'sports',
    packet_type: 'worldcup-match',
    route: 'worldcup_match',
    submarket: 'match_preview',
    event_id: 'KXWCGAME-26JUN22NORSEN',
    market_id: 'KXWCGAME-26JUN22NORSEN',
    event_url: 'https://kalshi.com/markets/kxwcgame/world-cup-game/KXWCGAME-26JUN22NORSEN',
    generated_at: CHECKED_AT,
    source_urls: ['https://www.fifa.com/fifaplus/en/tournaments', 'https://www.fifa.com/fifaplus/en/match-centre'],
    source_titles: ['FIFA World Cup Tournaments | FIFA', 'Match Centre | FIFA'],
    source_freshness: [freshness('https://www.fifa.com/fifaplus/en/tournaments', CHECKED_AT), freshness('https://www.fifa.com/fifaplus/en/match-centre', CHECKED_AT)],
    confirmed_facts: ['The official match centre lists Norway versus Senegal as a group-stage fixture.'],
    unconfirmed_claims: ['Confirmed starting lineups were not yet posted at retrieval time.'],
    unavailable_fields: ['squad_availability'],
    model_safe_inputs: {
      team_quality_baseline: { home: 'Norway', away: 'Senegal' },
      tournament_incentive_state: 'Both sides still alive in the group stage.',
      rest_travel_venue_climate: 'unavailable',
    },
    editorial_context: {
      group_or_knockout_pressure: 'A group-stage result swings advancement math for both sides.',
      public_storyline: 'A cross-confederation group fixture with contrasting styles.',
    },
    why_this_matters: 'The result reshapes group advancement scenarios for both federations.',
    headline_candidates: ['Group-stage advancement on the line in Norway vs Senegal'],
    risk_notes: ['Lineups remained unavailable at retrieval time.'],
  });
}

function earningsFixture() {
  return makeEmptyCpcResearchArtifact({
    packet_family: 'mentions',
    packet_type: 'earnings-call-mention',
    route: 'earnings_call',
    submarket: 'event',
    event_id: 'KXEARNINGSMENTIONCCL-26JUN23',
    market_id: 'KXEARNINGSMENTIONCCL-26JUN23',
    event_url: 'https://kalshi.com/markets/kxearningsmentionccl/carnival-cruise-earnings-call/KXEARNINGSMENTIONCCL-26JUN23',
    generated_at: CHECKED_AT,
    source_urls: ['https://www.carnivalcorp.com/news-events', 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=CCL'],
    source_titles: ['News & Events | Carnival Corporation & plc', 'EDGAR Company Filings | SEC.gov'],
    source_freshness: [freshness('https://www.carnivalcorp.com/news-events', CHECKED_AT), freshness('https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=CCL', CHECKED_AT)],
    confirmed_facts: ['Carnival maintains an investor-relations news and events page that lists upcoming earnings calls.'],
    unconfirmed_claims: ['The final prepared-remarks document was not posted at retrieval time.'],
    unavailable_fields: ['prepared_remarks_status'],
    model_safe_inputs: {
      company_identity: 'Carnival Corporation & plc',
      executive_speakers: 'unavailable',
      transcript_status: 'unavailable',
      current_guidance_topics: ['booking trends', 'fuel costs'],
    },
    editorial_context: {
      management_focus: 'Demand and yield commentary tend to anchor cruise-line calls.',
      why_this_quarter_matters: 'Summer booking strength is a recurring theme for the sector.',
    },
    why_this_matters: 'Cruise-line calls tend to revisit demand, yield, and cost vocabulary, which shapes any mention market.',
    headline_candidates: ['Carnival call centers on demand and cost vocabulary'],
    risk_notes: ['Prepared remarks may post late.'],
  });
}

function hearingTestimonyFixture() {
  return makeEmptyCpcResearchArtifact({
    packet_family: 'mentions',
    packet_type: 'hearing-testimony-mention',
    route: 'debate_hearing',
    submarket: 'event',
    event_id: 'KXHEARINGMENTION-26JUN23B',
    market_id: 'KXHEARINGMENTION-26JUN23B',
    event_url: 'https://kalshi.com/markets/kxhearingmention/hearing-mention/KXHEARINGMENTION-26JUN23B',
    generated_at: CHECKED_AT,
    source_urls: ['https://www.banking.senate.gov/hearings', 'https://www.banking.senate.gov/hearings/witness-list'],
    source_titles: ['Hearings | United States Committee on Banking, Housing, and Urban Affairs', 'Witness List | Committee on Banking, Housing, and Urban Affairs'],
    source_freshness: [freshness('https://www.banking.senate.gov/hearings', CHECKED_AT), freshness('https://www.banking.senate.gov/hearings/witness-list', CHECKED_AT)],
    confirmed_facts: ["The committee lists an upcoming hearing titled 'The Affordability Agenda' in Dirksen 538.", 'A first-party witness list is published.'],
    unconfirmed_claims: ['Final witness order was not confirmed at retrieval time.'],
    unavailable_fields: ['official_video_status'],
    model_safe_inputs: {
      committee_or_agency: 'Senate Banking Committee',
      hearing_title: 'The Affordability Agenda',
      room_or_platform: 'Dirksen 538',
      witness_list: ['Witness A', 'Witness B'],
      transcript_status: 'unavailable',
    },
    editorial_context: {
      issue_frame: 'Housing affordability anchors the hearing.',
      witness_focus: 'Witness backgrounds skew toward housing-finance policy.',
    },
    why_this_matters: 'The hearing topic and witness slate frame which policy terms are likely to surface.',
    headline_candidates: ['Affordability hearing frames the testimony vocabulary'],
    risk_notes: ['Witness order may shift.'],
  });
}

function trumpFixture() {
  return makeEmptyCpcResearchArtifact({
    packet_family: 'mentions',
    packet_type: 'public-figure-mention',
    route: 'trump_event',
    submarket: 'event',
    event_id: 'KXTRUMPMENTION-26JUN23',
    market_id: 'KXTRUMPMENTION-26JUN23',
    event_url: 'https://kalshi.com/markets/kxtrumpmention/what-will-trump-say/KXTRUMPMENTION-26JUN23',
    generated_at: CHECKED_AT,
    source_urls: ['https://www.whitehouse.gov/news/', 'https://rollcall.com/'],
    source_titles: ['News | The White House', 'Roll Call'],
    source_freshness: [freshness('https://www.whitehouse.gov/news/', CHECKED_AT), freshness('https://rollcall.com/', CHECKED_AT)],
    confirmed_facts: ['The official schedule lists a public address for the day.'],
    unconfirmed_claims: ['A full prepared-remarks document was not posted at retrieval time.'],
    unavailable_fields: ['official_transcript_status'],
    model_safe_inputs: {
      speaker_identity: 'President of the United States',
      event_type: 'public address',
      horizon: 'event',
      official_schedule: 'unavailable',
      prepared_remarks_status: 'unavailable',
    },
    editorial_context: {
      campaign_or_public_narrative: 'Recent addresses have revisited economic and border themes.',
      issue_salience: 'Topic salience is high heading into the appearance.',
    },
    why_this_matters: 'The scheduled appearance frames which recurring topics are likely to surface.',
    headline_candidates: ['Scheduled address frames the likely topic vocabulary'],
    risk_notes: ['Remarks may be unscripted.'],
  });
}

function worldCupMentionFixture() {
  return makeEmptyCpcResearchArtifact({
    packet_family: 'mentions',
    packet_type: 'sports-mention',
    route: 'sports_announcer',
    submarket: 'event',
    event_id: 'KXWCMENTION-26JUN22NORSEN',
    market_id: 'KXWCMENTION-26JUN22NORSEN',
    event_url: 'https://kalshi.com/markets/kxwcmention/world-cup-mentions/KXWCMENTION-26JUN22NORSEN',
    generated_at: CHECKED_AT,
    source_urls: ['https://www.fifa.com/fifaplus/en/match-centre', 'https://www.fifa.com/fifaplus/en/tournaments'],
    source_titles: ['Match Centre | FIFA', 'FIFA World Cup Tournaments | FIFA'],
    source_freshness: [freshness('https://www.fifa.com/fifaplus/en/match-centre', CHECKED_AT), freshness('https://www.fifa.com/fifaplus/en/tournaments', CHECKED_AT)],
    confirmed_facts: ['The official match centre lists Norway versus Senegal with broadcast information.'],
    unconfirmed_claims: ['The on-air announcer pairing was not confirmed at retrieval time.'],
    unavailable_fields: ['announcer_list'],
    model_safe_inputs: {
      sport: 'soccer',
      matchup: 'Norway vs Senegal',
      competition_stage: 'group stage',
      broadcast_network: 'unavailable',
      standings_or_advancement_state: 'Both sides alive in the group.',
    },
    editorial_context: {
      broadcast_storylines: 'Group-stage stakes tend to dominate broadcast framing.',
      star_focus: 'Marquee attackers often anchor the broadcast narrative.',
    },
    why_this_matters: 'Broadcast framing around a group-stage decider shapes which phrases announcers tend to use.',
    headline_candidates: ['Group-stage stakes shape the broadcast vocabulary'],
    risk_notes: ['Announcer assignment may change.'],
  });
}

function loveIslandFixture() {
  return makeEmptyCpcResearchArtifact({
    packet_family: 'mentions',
    packet_type: 'tv-show-mention',
    route: 'talk_show_media',
    submarket: 'event',
    event_id: 'KXLOVEISLMENTION-26JUN22',
    market_id: 'KXLOVEISLMENTION-26JUN22',
    event_url: 'https://kalshi.com/markets/kxloveislmention/love-island-mentions/KXLOVEISLMENTION-26JUN22',
    generated_at: CHECKED_AT,
    source_urls: ['https://www.itv.com/watch/love-island/2a3697'],
    source_titles: ['Love Island | ITVX'],
    source_freshness: [freshness('https://www.itv.com/watch/love-island/2a3697', CHECKED_AT)],
    confirmed_facts: ['ITVX hosts the official Love Island episode hub with synopses and air information.'],
    unconfirmed_claims: ['The exact contestant lineup for the episode was not confirmed at retrieval time.'],
    unavailable_fields: ['cast_or_contestants'],
    model_safe_inputs: {
      show_title: 'Love Island',
      network_or_platform: 'ITVX',
      official_synopsis: 'unavailable',
      official_clip_or_recap_status: 'unavailable',
    },
    editorial_context: {
      episode_arc: 'Reality-format episodes revisit recurring relationship beats.',
      running_gag_or_catchphrase_context: 'Show catchphrases recur across episodes.',
    },
    why_this_matters: 'Recurring show vocabulary and format beats shape which phrases are likely to appear.',
    headline_candidates: ['Recurring format beats shape the episode vocabulary'],
    risk_notes: ['Episode contents may vary from the synopsis.'],
  });
}

const FIXTURES = [
  { label: 'MLB game', build: mlbGameFixture },
  { label: 'World Cup match', build: worldCupMatchFixture },
  { label: 'Earnings mention', build: earningsFixture },
  { label: 'Hearing / testimony', build: hearingTestimonyFixture },
  { label: 'Hearing word-bank / threshold', build: hearingWordBankFixture },
  { label: 'Trump / public figure', build: trumpFixture },
  { label: 'World Cup sports mention', build: worldCupMentionFixture },
  { label: 'Love Island TV/show', build: loveIslandFixture },
];

// Strip anything ISO-timestamp-shaped from customer-facing text (defense in depth).
function stripIso(text) {
  return String(text ?? '').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?Z?/g, '(time withheld)');
}

function buildPreviewText(sanitized) {
  const headline = sanitized.headline_candidates?.[0] || 'Research preview';
  const why = sanitized.why_this_matters || 'unavailable';
  const facts = (sanitized.confirmed_facts || []).slice(0, 2);
  const editorialValues = Object.values(sanitized.editorial_context || {})
    .filter((v) => typeof v === 'string')
    .slice(0, 1);
  const sourceTitle = sanitized.source_titles?.[0] || 'No external source confirmed.';

  const lines = [
    `Headline: ${headline}`,
    `Why it matters: ${why}`,
    'Confirmed context:',
    ...facts.map((f) => `- ${f}`),
  ];
  if (editorialValues.length) {
    lines.push(`Storyline: ${editorialValues[0]}`);
  }
  lines.push(`Primary source: ${sourceTitle}`);

  return scrubCustomerText(stripIso(lines.join('\n')));
}

function priceIsolationPass(sanitized, previewText) {
  try {
    assertNoMarketLeak(sanitized.model_safe_inputs);
  } catch {
    return false;
  }
  if (findBannedCustomerWord(previewText)) return false;
  if (/\/home\//.test(previewText) || /\.mjs/.test(previewText)) return false;
  if (/\d{4}-\d\d-\d\dT\d\d:\d\d/.test(previewText)) return false;
  return true;
}

function truncate(text, max = 90) {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function main() {
  const date = parseDate(process.argv.slice(2));
  let globalPass = true;
  let written = 0;

  console.log(`CPC preview extraction proof — date ${date}`);
  console.log('='.repeat(64));

  for (const { label, build } of FIXTURES) {
    const raw = build();
    assertCpcResearchArtifact(raw, label);

    const sanitized = sanitizeResearchArtifact(raw);
    const previewText = buildPreviewText(sanitized);

    // Deterministic CPC model output is owned by CPC code, not Perplexity.
    const builderInput = {
      sanitized_artifact: sanitized,
      cpc_model_output: { note: 'Deterministic CPC model output is produced by CPC code, not by Perplexity.' },
    };

    const packet = assembleCpcPreviewPacket({
      title: `${label} — ${sanitized.event_id}`,
      generatedAtUtc: raw.generated_at,
      previewText,
    });

    const pass = priceIsolationPass(sanitized, packet);
    if (!pass) globalPass = false;

    const { dir } = writeResearchBankArtifacts({
      date,
      packet_family: sanitized.packet_family,
      packet_type: sanitized.packet_type,
      event_id: sanitized.event_id,
      route: sanitized.route,
      submarket: sanitized.submarket,
      raw,
      normalized: raw,
      sanitized,
      builderInput,
      previewText: packet,
      lineage: {
        generated_at: raw.generated_at,
        source_id: raw.source_id,
        source_urls: raw.source_urls,
        source_titles: raw.source_titles,
        source_freshness: raw.source_freshness,
      },
    });
    written += 1;

    console.log(`\n[${label}] ${sanitized.event_id}`);
    console.log(`  artifact_dir: ${dir}`);
    console.log(`  sanitized_removed: ${JSON.stringify(sanitized.sanitized_removed || [])}`);
    console.log(`  unavailable_fields: ${JSON.stringify(sanitized.unavailable_fields || [])}`);
    console.log(`  why_this_matters: ${truncate(sanitized.why_this_matters)}`);
    console.log(`  headline: ${truncate(sanitized.headline_candidates?.[0] || 'unavailable')}`);
    console.log(`  price isolation: ${pass ? 'PASS' : 'FAIL'}`);
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log(`ARTIFACTS: ${written}/${FIXTURES.length}`);
  console.log(`PRICE ISOLATION: ${globalPass ? 'PASS' : 'FAIL'}`);

  if (!globalPass || written !== FIXTURES.length) {
    process.exitCode = 1;
  }
}

main();
