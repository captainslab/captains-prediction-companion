// Schema-locked prompt builders for World Cup advances research.
//
// These are pure prompt constructors only. They never fetch or score anything.

const ADVANCES_ELO_SCHEMA = 'worldcup_advances_elo_baseline_v1';
const ADVANCES_SOFT_SCHEMA = 'worldcup_advances_soft_layer_v1';

function joinLines(lines) {
  return lines.filter(Boolean).join('\n');
}

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text.length ? text : 'unknown';
}

function matchLabel(match = {}) {
  const home = normalizeText(match.home_team ?? match.homeTeam);
  const away = normalizeText(match.away_team ?? match.awayTeam);
  return `${home} vs ${away}`;
}

function teamList(teams = []) {
  return (Array.isArray(teams) ? teams : []).map((team, index) => {
    const name = normalizeText(team?.team_name ?? team?.team ?? team?.name ?? `team_${index + 1}`);
    const code = normalizeText(team?.team_code ?? team?.code ?? '');
    return `${index + 1}. ${name}${code !== 'unknown' ? ` (${code})` : ''}`;
  }).join('\n');
}

function sourceLockedSchema({ title, fields, example }) {
  return {
    schema: title,
    generated_at: '...',
    source_id: 'perplexity',
    source_title: '...',
    source_url: '...',
    records: example,
    notes: 'Use null for unknown values. Do not author ratings, scores, or rankings.',
    fields,
  };
}

export function buildEloBaselineFetchPrompt({ teams = [] } = {}) {
  const outputSchema = sourceLockedSchema({
    title: ADVANCES_ELO_SCHEMA,
    fields: [
      'team_name',
      'team_code',
      'published_elo',
      'source',
      'retrieved_at',
      'published_at',
      'notes',
    ],
    example: [{
      team_name: '...',
      team_code: '...',
      published_elo: {
        value: null,
        source: null,
        retrieved_at: null,
      },
      source: '...',
      retrieved_at: '...',
      published_at: '...',
      notes: '...',
    }],
  });

  return {
    schema: ADVANCES_ELO_SCHEMA,
    system: [
      'You are a source-extraction assistant for World Cup Elo baselines.',
      'Return one JSON object only.',
      'Never author ratings, probabilities, scores, model outputs, or rankings.',
      'Use null for any unknown field.',
      'Every field you populate must carry source and retrieved_at metadata when applicable.',
    ].join(' '),
    user: joinLines([
      'Fetch only published Elo baseline data from a named source.',
      'Do not estimate, infer, or synthesize Elo values.',
      'Do not include betting-market data or market language.',
      'If a team is not found, return null for its Elo value and explain why in notes.',
      '',
      'Teams:',
      teamList(teams) || '1. unknown',
      '',
      'Return format:',
      '- JSON object only.',
      '- Use null on unknown.',
      '- Do not output markdown.',
      '',
      'Output schema:',
      JSON.stringify(outputSchema, null, 2),
    ]),
    output_schema: outputSchema,
  };
}

export function buildSoftLayerFetchPrompt({ match = {} } = {}) {
  const outputSchema = sourceLockedSchema({
    title: ADVANCES_SOFT_SCHEMA,
    fields: [
      'match_id',
      'matchup',
      'observed_at',
      'lineup_status',
      'team_news',
      'injuries',
      'suspensions',
      'conditions',
      'sources',
    ],
    example: [{
      match_id: '...',
      matchup: '...',
      observed_at: '...',
      lineup_status: 'CONFIRMED|PROJECTED|STALE|UNKNOWN',
      team_news: [{
        value: null,
        source: null,
        observed_at: null,
        tag: 'CONFIRMED|PROJECTED|STALE|UNKNOWN',
      }],
      injuries: [{
        value: null,
        source: null,
        observed_at: null,
        tag: 'CONFIRMED|PROJECTED|STALE|UNKNOWN',
      }],
      suspensions: [{
        value: null,
        source: null,
        observed_at: null,
        tag: 'CONFIRMED|PROJECTED|STALE|UNKNOWN',
      }],
      conditions: {
        weather: { value: null, source: null, observed_at: null, tag: 'CONFIRMED|PROJECTED|STALE|UNKNOWN' },
        travel: { value: null, source: null, observed_at: null, tag: 'CONFIRMED|PROJECTED|STALE|UNKNOWN' },
        venue: { value: null, source: null, observed_at: null, tag: 'CONFIRMED|PROJECTED|STALE|UNKNOWN' },
      },
      sources: ['...'],
    }],
  });

  return {
    schema: ADVANCES_SOFT_SCHEMA,
    system: [
      'You are a source-extraction assistant for World Cup lineup, news, and conditions only.',
      'Return one JSON object only.',
      'Never author ratings, probabilities, scores, odds, prices, or rankings.',
      'Tag every sourced field CONFIRMED, PROJECTED, STALE, or UNKNOWN.',
      'Use null for any unknown field.',
    ].join(' '),
    user: joinLines([
      `Match: ${matchLabel(match)}`,
      `Match id: ${normalizeText(match.match_id ?? match.matchId ?? '')}`,
      `Kickoff: ${normalizeText(match.kickoff_utc ?? match.kickoffUtc ?? 'unknown')}`,
      `Stage: ${normalizeText(match.stage ?? match.round ?? 'unknown')}`,
      '',
      'Return only lineup/news/conditions context.',
      'Do not include betting-market data or market language.',
      'If unconfirmed, return null and tag the field UNKNOWN.',
      '',
      'Return format:',
      '- JSON object only.',
      '- Null on unknown.',
      '- No markdown.',
      '',
      'Output schema:',
      JSON.stringify(outputSchema, null, 2),
    ]),
    output_schema: outputSchema,
  };
}
