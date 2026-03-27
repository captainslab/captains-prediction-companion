function canonicalizeVenue(venue) {
  if (!venue) return 'Kalshi';
  const value = String(venue).trim();
  if (!value) return 'Kalshi';
  if (/^kalshi/i.test(value)) return 'Kalshi';
  if (/^polymarket/i.test(value)) return 'Polymarket';
  return value;
}

function normalizeDomain(domain) {
  if (!domain) return 'general';
  const value = String(domain).trim().toLowerCase();
  const aliases = {
    sports: 'sports',
    politics: 'politics',
    macro: 'macro',
    economics: 'macro',
    earnings: 'mention',
    corporate: 'mention',
    mention: 'mention',
    mentions: 'mention',
    media: 'mention',
    general: 'general',
  };
  return aliases[value] ?? value;
}

function normalizeText(value) {
  return value == null ? '' : String(value).trim().toLowerCase();
}

function extractUrlContext(url) {
  if (!url) {
    return {
      hostname: '',
      pathname: '',
      tokens: [],
      tail: '',
    };
  }

  const raw = String(url).trim();
  if (!raw) {
    return {
      hostname: '',
      pathname: '',
      tokens: [],
      tail: '',
    };
  }

  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      hostname: '',
      pathname: raw.toLowerCase(),
      tokens: raw
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
      tail: raw.toLowerCase(),
    };
  }

  const pathname = parsed.pathname.toLowerCase();
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .map(segment => segment.toLowerCase());
  const tail = segments.length > 0 ? segments[segments.length - 1] : '';
  const slugTokens = segments.flatMap(segment => segment.split(/[^a-z0-9]+/).filter(Boolean));

  return {
    hostname: parsed.hostname.toLowerCase(),
    pathname,
    tokens: slugTokens,
    tail,
  };
}

function inferMarketId(input) {
  if (input.market_id) {
    return String(input.market_id).trim() || null;
  }

  const urlContext = extractUrlContext(input.url);
  if (urlContext.tail && /[a-z0-9]/i.test(urlContext.tail)) {
    return urlContext.tail.toUpperCase();
  }

  return null;
}

function collectDomainText(input) {
  const urlContext = extractUrlContext(input.url);
  return [
    input.title,
    input.question,
    input.market_id,
    input.url,
    input.resolution_source,
    urlContext.pathname,
    urlContext.tokens.join(' '),
    urlContext.tail,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');
}

function inferDomain(input) {
  const explicit = normalizeDomain(input.domain);
  if (explicit !== 'general') {
    return explicit;
  }

  const haystack = collectDomainText(input);

  if (/\bmention(s)?\b|\bphrase\b|\bword\b|\bsaid\b|\bsays\b|\bsaying\b|\bspeech\b|\bremarks\b/.test(haystack)) {
    return 'mention';
  }

  if (/\b(nfl|nba|mlb|ufc|nascar|football|basketball|baseball|team|game|score|win|quarter|series)\b/.test(haystack)) {
    return 'sports';
  }

  if (/\b(election|politics|president|congress|senate|house|debate|campaign|white house|c-span|press conference)\b/.test(haystack)) {
    return 'politics';
  }

  if (/\b(inflation|fed|fomc|rates|cpi|jobs|unemployment|gdp|powell|treasury)\b/.test(haystack)) {
    return 'macro';
  }

  if (/\b(earnings|earnings call|quarter|revenue|guidance|investor relations|transcript)\b/.test(haystack)) {
    return 'mention';
  }

  return 'general';
}

function inferMarketType(input, domain) {
  const haystack = collectDomainText(input);

  if (/\bmention(s)?\b|\bphrase\b|\bword\b|\bsaid\b|\bsays\b|\bsaying\b/.test(haystack)) {
    return 'mention';
  }
  if (/\bplayer prop\b|\bplayer_prop\b|\bprops\b|\bpoints\b|\brebounds\b|\bassist(s)?\b/.test(haystack)) {
    return 'player_prop';
  }
  if (/\bspread\b|\bcover\b/.test(haystack)) {
    return 'spread';
  }
  if (/\btotal\b|\bover\b|\bunder\b/.test(haystack)) {
    return 'total';
  }
  if (domain === 'sports' && /\bmoneyline\b|\bwinner\b|\bwin\b/.test(haystack)) {
    return 'moneyline';
  }

  return 'general';
}

function inferEventType(input, domain) {
  const haystack = collectDomainText(input);

  if (/\bhearing\b|\bcommittee\b|\bwitness\b/.test(haystack)) {
    return 'hearing';
  }
  if (/\bpress conference\b|\bpresser\b|\bbriefing\b/.test(haystack)) {
    return 'press_conference';
  }
  if (/\binterview\b|\bhost\b|\bprogram\b/.test(haystack)) {
    return 'interview';
  }
  if (/\bspeech\b|\bremarks\b|\baddress\b|\brally\b/.test(haystack)) {
    return 'speech';
  }
  if (/\bearnings\b|\bearnings call\b|\bquarterly results\b|\binvestor relations\b|\btranscript\b|\bq[1-4]\b/.test(haystack)) {
    return 'earnings_call';
  }
  if (domain === 'sports') {
    if (/\bncaamb\b|\bncaa\b|\bcollege basketball\b|\bmarch madness\b/.test(haystack)) {
      return 'ncaamb_game';
    }
    if (/\bmlb\b|\bbaseball\b|\bfirst pitch\b/.test(haystack)) {
      return 'mlb_game';
    }
    if (/\bnfl\b|\bfootball\b|\bkickoff\b/.test(haystack)) {
      return 'nfl_game';
    }
    if (/\bnba\b|\bbasketball\b|\btipoff\b/.test(haystack)) {
      return 'nba_game';
    }
  }

  return 'general';
}

function inferEventDomain(domain, eventType) {
  const eventMap = {
    earnings_call: 'corporate',
    ncaamb_game: 'sports',
    mlb_game: 'sports',
    nfl_game: 'sports',
    nba_game: 'sports',
    speech: 'politics',
    hearing: 'politics',
    press_conference: 'politics',
    interview: 'media',
  };

  if (eventMap[eventType]) {
    return eventMap[eventType];
  }
  if (domain === 'sports') return 'sports';
  if (domain === 'politics') return 'politics';
  if (domain === 'mention') return 'media';
  if (domain === 'macro') return 'general';
  return 'general';
}

function metadataValue(metadata, ...keys) {
  for (const key of keys) {
    const value = metadata?.[key];
    if (value == null) continue;
    if (typeof value === 'string') {
      const cleaned = value.trim();
      if (cleaned) return cleaned;
      continue;
    }
    return value;
  }
  return null;
}

function extractMatchup(...values) {
  for (const value of values) {
    if (!value) continue;
    const match = String(value).match(/([A-Za-z0-9 .&'-]+?)\s+(?:vs\.?|at)\s+([A-Za-z0-9 .&'-]+)/i);
    if (match) {
      return {
        away: match[1].trim(),
        home: match[2].trim(),
      };
    }
  }
  return { away: null, home: null };
}

function extractTargetPhrase(...values) {
  for (const value of values) {
    if (!value) continue;
    const text = String(value);
    const quoted = text.match(/"([^"]+)"/) ?? text.match(/'([^']+)'/);
    if (quoted?.[1]) return quoted[1].trim();
    const sayMatch = text.match(/\bsay\s+([A-Za-z0-9 .&/-]+?)(?:\?|$)/i);
    if (sayMatch?.[1]) return sayMatch[1].trim();
    const mentionMatch = text.match(/\bmention(?:ing|ed)?\s+([A-Za-z0-9 .&/-]+?)(?:\?|$)/i);
    if (mentionMatch?.[1]) return mentionMatch[1].trim();
  }
  return null;
}

function buildUserFacingContext(input, eventType) {
  const metadata = input.metadata ?? {};
  const matchup = extractMatchup(input.title, input.question);

  if (eventType === 'earnings_call') {
    return {
      company: metadataValue(metadata, 'company', 'issuer'),
      event_name: metadataValue(metadata, 'event_name') ?? input.title ?? null,
      start_time: metadataValue(metadata, 'start_time', 'call_start_time'),
      quarter: metadataValue(metadata, 'quarter', 'reporting_quarter'),
    };
  }

  if (['ncaamb_game', 'mlb_game', 'nfl_game', 'nba_game'].includes(eventType)) {
    const startKey =
      eventType === 'mlb_game'
        ? 'first_pitch'
        : eventType === 'nfl_game'
          ? 'kickoff'
          : 'tipoff';
    return {
      teams: {
        away: metadataValue(metadata, 'away_team', 'away') ?? matchup.away,
        home: metadataValue(metadata, 'home_team', 'home') ?? matchup.home,
      },
      venue: metadataValue(metadata, 'venue'),
      [startKey]: metadataValue(metadata, startKey, 'start_time'),
      broadcast: {
        network: metadataValue(metadata, 'broadcast_network', 'network'),
      },
    };
  }

  if (eventType === 'speech') {
    return {
      speaker: metadataValue(metadata, 'speaker'),
      event_name: metadataValue(metadata, 'event_name') ?? input.title ?? null,
      start_time: metadataValue(metadata, 'start_time'),
      venue: metadataValue(metadata, 'venue'),
      platform: metadataValue(metadata, 'platform'),
    };
  }

  if (eventType === 'interview') {
    return {
      speaker: metadataValue(metadata, 'speaker'),
      program: metadataValue(metadata, 'program') ?? input.title ?? null,
      start_time: metadataValue(metadata, 'start_time'),
      platform: metadataValue(metadata, 'platform'),
      host: metadataValue(metadata, 'host'),
    };
  }

  if (eventType === 'hearing') {
    return {
      witness: metadataValue(metadata, 'witness'),
      committee: metadataValue(metadata, 'committee'),
      start_time: metadataValue(metadata, 'start_time'),
      venue: metadataValue(metadata, 'venue'),
    };
  }

  if (eventType === 'press_conference') {
    return {
      speaker: metadataValue(metadata, 'speaker'),
      event_name: metadataValue(metadata, 'event_name') ?? input.title ?? null,
      start_time: metadataValue(metadata, 'start_time'),
      venue: metadataValue(metadata, 'venue'),
      platform: metadataValue(metadata, 'platform'),
    };
  }

  return {
    event_name: metadataValue(metadata, 'event_name') ?? input.title ?? null,
    start_time: metadataValue(metadata, 'start_time'),
    venue: metadataValue(metadata, 'venue'),
  };
}

function buildUserFacingMarketView(input, marketType, eventType) {
  const metadata = input.metadata ?? {};

  if (marketType === 'mention') {
    const targetPhrase =
      metadataValue(metadata, 'target_phrase', 'phrase') ??
      extractTargetPhrase(input.title, input.question, input.market_id, input.url);

    const watchFor =
      Array.isArray(metadata.watch_for) && metadata.watch_for.every(item => typeof item === 'string')
        ? metadata.watch_for
        : eventType === 'earnings_call'
          ? [
              `prepared remarks use ${targetPhrase ?? 'the target phrase'}`,
              `analysts force ${targetPhrase ?? 'the target phrase'} into Q&A`,
              'management pivots to substitute wording',
            ]
          : [
              `the source uses ${targetPhrase ?? 'the target phrase'}`,
              'the exact wording changes',
              'the rules exclude the speaker or segment',
            ];

    return {
      target_phrase: targetPhrase,
      rules_summary:
        metadataValue(metadata, 'rules_summary') ??
        'Confirm the exact phrase, allowed speaker set, and venue counting rules before pricing.',
      mention_paths:
        metadata.mention_paths && typeof metadata.mention_paths === 'object'
          ? metadata.mention_paths
          : {},
      trade_view: {
        best_side: 'watch',
        market_yes: null,
        fair_yes: null,
        edge_cents: null,
      },
      watch_for: watchFor,
    };
  }

  if (marketType === 'moneyline') {
    return {
      moneyline: {
        lean: 'watch',
        confidence: 'medium',
        reason: 'The game market is classified, but live prices and matchup inputs still need to be added.',
      },
      game_factors: Array.isArray(metadata.game_factors) ? metadata.game_factors : [],
      price_view: {
        market_implied: null,
        fair_implied: null,
        edge_cents: null,
        best_action: 'watch',
      },
    };
  }

  if (marketType === 'spread') {
    return {
      spread: {
        line: metadataValue(metadata, 'line', 'spread_line'),
        lean: 'watch',
        confidence: 'medium',
        reason: 'The spread market is classified, but the posted line and fair margin still need to be added.',
      },
      margin_factors: Array.isArray(metadata.margin_factors) ? metadata.margin_factors : [],
      price_view: {
        market_yes: null,
        fair_yes: null,
        edge_cents: null,
        best_action: 'watch',
      },
    };
  }

  if (marketType === 'total') {
    return {
      total: {
        line: metadataValue(metadata, 'line', 'total_line'),
        lean: 'watch',
        confidence: 'medium',
        reason: 'The totals market is classified, but the posted number and fair total still need to be added.',
      },
      scoring_factors: Array.isArray(metadata.scoring_factors) ? metadata.scoring_factors : [],
      price_view: {
        market_yes: null,
        fair_yes: null,
        edge_cents: null,
        best_action: 'watch',
      },
    };
  }

  if (marketType === 'player_prop') {
    return {
      player_prop: {
        player: metadataValue(metadata, 'player'),
        stat_type: metadataValue(metadata, 'stat_type'),
        line: metadataValue(metadata, 'line', 'prop_line'),
        lean: 'watch',
        confidence: 'medium',
        reason: 'The player prop is classified, but projection inputs and live pricing still need to be added.',
      },
      projection: {
        fair_value: null,
        expected_stat: null,
      },
      price_view: {
        market_yes: null,
        fair_yes: null,
        edge_cents: null,
        best_action: 'watch',
      },
    };
  }

  return {
    status_note: 'The market type is not mapped to a user-facing market view yet.',
  };
}

function buildUserFacingStatus(eventType, marketType, marketView) {
  if (marketType === 'general') return 'market_unmapped';
  if (marketType === 'mention' && !marketView.target_phrase) return 'insufficient_context';
  if (eventType === 'general' && marketType !== 'mention') return 'insufficient_context';
  return 'needs_pricing';
}

function buildUserFacingRecommendation(marketType, status) {
  if (status !== 'needs_pricing') return 'pass';
  return 'watch';
}

function buildUserFacingHeadline(status, marketType, eventType, input) {
  if (status === 'market_unmapped') {
    return 'The market needs a manual classification pass before the app can price it.';
  }
  if (status === 'insufficient_context') {
    return 'The market needs more event detail before the app can score it.';
  }
  if (marketType === 'mention') {
    return 'The contract is mapped as a mention market and is ready for pricing.';
  }
  if (marketType === 'moneyline') {
    return 'The contract is mapped as a game winner market and is ready for pricing.';
  }
  if (marketType === 'spread') {
    return 'The contract is mapped as a spread market and is ready for pricing.';
  }
  if (marketType === 'total') {
    return 'The contract is mapped as a totals market and is ready for pricing.';
  }
  if (marketType === 'player_prop') {
    return 'The contract is mapped as a player prop and is ready for pricing.';
  }
  if (eventType !== 'general' && input.title) {
    return `${input.title} is classified and ready for pricing.`;
  }
  return 'The event market is classified and ready for pricing.';
}

function buildUserFacingReason(status, marketType) {
  if (status === 'market_unmapped') {
    return 'The market type is not supported by the current event-market card.';
  }
  if (status === 'insufficient_context') {
    return 'The app can parse the venue, but it still lacks enough event detail to build an actionable card.';
  }
  if (marketType === 'mention') {
    return 'The phrase path is mapped, but exact pricing and edge still need to be computed.';
  }
  return 'The event and market types are classified, but fair value and edge are still missing.';
}

function buildUserFacingNextAction(status, marketType, eventType) {
  if (status === 'market_unmapped') return 'review_market_rules';
  if (status === 'insufficient_context') return 'confirm_event_context';
  if (marketType === 'mention' && ['ncaamb_game', 'mlb_game', 'nfl_game', 'nba_game'].includes(eventType)) {
    return 'confirm_broadcast_crew';
  }
  if (marketType === 'mention') return 'review_market_rules';
  return 'fetch_live_prices';
}

function buildUserFacingCard(input, plan) {
  const eventType = inferEventType(input, plan.domain);
  const eventDomain = inferEventDomain(plan.domain, eventType);
  const marketType = inferMarketType(input, plan.domain);
  const marketView = buildUserFacingMarketView(input, marketType, eventType);
  const status = buildUserFacingStatus(eventType, marketType, marketView);
  const recommendation = buildUserFacingRecommendation(marketType, status);

  return {
    source: {
      platform: plan.venue,
      url: plan.metadata.url ?? null,
      market_id: plan.metadata.market_id ?? null,
    },
    event_domain: eventDomain,
    event_type: eventType,
    market_type: marketType,
    status,
    confidence: status === 'needs_pricing' ? 'medium' : 'low',
    summary: {
      headline: buildUserFacingHeadline(status, marketType, eventType, input),
      recommendation,
      one_line_reason: buildUserFacingReason(status, marketType),
    },
    next_action: buildUserFacingNextAction(status, marketType, eventType),
    context: buildUserFacingContext(input, eventType),
    market_view: marketView,
  };
}

function buildMacroProfile() {
  return {
    name: 'macro-market-research',
    wrapper: 'macro-market',
    source_hints: [
      'Official government release or central-bank release',
      'Official transcript or press conference when applicable',
      'Perplexity-discovered authoritative public source',
    ],
    evidence_targets: [
      'official release',
      'official transcript',
      'press conference replay',
      'statement',
      'data release page',
    ],
    comparison_axes: ['release type', 'policy path', 'headline data vs. core data', 'surprise vs. expectation', 'execution risk'],
    source_tree_note:
      'For macro markets, the controlling source is usually the official release or press event named by the rules. Use the scraper only after the authoritative public source is located.',
    stage_overrides: [
      {
        stage: 'intake',
        purpose: 'Identify the release, event type, venue, and settlement boundary.',
        input_focus: 'market title, market id, venue, release type, date, time',
        output_focus: 'macro market context',
      },
      {
        stage: 'market',
        purpose: 'Read the Kalshi board and the rules before looking at any macro data.',
        input_focus: 'contract wording, resolution rules, source hierarchy, price, order book',
        output_focus: 'venue-grounded macro snapshot',
      },
      {
        stage: 'research',
        purpose: 'Use Perplexity to find the authoritative official release or event page.',
        input_focus: 'which official page or press event controls the question',
        output_focus: 'ranked source tree and source summary',
      },
      {
        stage: 'evidence',
        purpose: 'Use the scraper skill to extract the exact release, statement, or transcript evidence.',
        input_focus: 'official release pages, transcripts, press conference replays, statements',
        output_focus: 'verbatim or structured evidence',
      },
      {
        stage: 'pricing',
        purpose: 'Convert the evidence into fair probability and edge.',
        input_focus: 'market probability, fair probability, and release surprise',
        output_focus: 'EV, confidence, and stake cap',
      },
      {
        stage: 'decision',
        purpose: 'Apply macro-specific no-bet filters and produce the final action.',
        input_focus: 'confidence, source quality, release timing, execution risk',
        output_focus: 'buy_yes, buy_no, or pass',
      },
      {
        stage: 'logging',
        purpose: 'Store the source tree and final decision for reuse.',
        input_focus: 'all intermediate outputs',
        output_focus: 'audit-ready decision record',
      },
    ],
    notes:
      'Macro markets are release-and-event problems. Read the official source first, then use Perplexity to confirm the exact page or event, then scrape the source for the actionable text or numbers.',
  };
}

function buildPoliticsProfile() {
  return {
    name: 'politics-market-research',
    wrapper: 'politics-market',
    source_hints: [
      'Official stream or public event page',
      'Official transcript or pool report when available',
      'Perplexity-discovered authoritative public source',
    ],
    evidence_targets: [
      'official stream',
      'official transcript',
      'press conference replay',
      'debate replay',
      'statement',
      'campaign page',
    ],
    comparison_axes: ['speaker role', 'event type', 'prepared remarks vs Q&A', 'policy position', 'execution risk'],
    source_tree_note:
      'For politics markets, the controlling source is usually the exact official stream, transcript, or event page named by the rules. Use the scraper only after the authoritative public source is located.',
    stage_overrides: [
      {
        stage: 'intake',
        purpose: 'Identify the speaker, event type, venue, and settlement boundary.',
        input_focus: 'market title, market id, venue, speaker, event type, date, time',
        output_focus: 'politics market context',
      },
      {
        stage: 'market',
        purpose: 'Read the Kalshi board and the rules before looking at any political data.',
        input_focus: 'contract wording, resolution rules, source hierarchy, price, order book',
        output_focus: 'venue-grounded politics snapshot',
      },
      {
        stage: 'research',
        purpose: 'Use Perplexity to find the authoritative official stream or event page.',
        input_focus: 'which official page or event controls the question',
        output_focus: 'ranked source tree and source summary',
      },
      {
        stage: 'evidence',
        purpose: 'Use the scraper skill to extract the exact speech, debate, or transcript evidence.',
        input_focus: 'official streams, transcripts, debate clips, statements, pool reports',
        output_focus: 'verbatim or structured evidence',
      },
      {
        stage: 'pricing',
        purpose: 'Convert the evidence into fair probability and edge.',
        input_focus: 'market probability, fair probability, and speaker incentives',
        output_focus: 'EV, confidence, and stake cap',
      },
      {
        stage: 'decision',
        purpose: 'Apply politics-specific no-bet filters and produce the final action.',
        input_focus: 'confidence, source quality, timing, execution risk',
        output_focus: 'buy_yes, buy_no, or pass',
      },
      {
        stage: 'logging',
        purpose: 'Store the source tree and final decision for reuse.',
        input_focus: 'all intermediate outputs',
        output_focus: 'audit-ready decision record',
      },
    ],
    notes:
      'Politics markets are speaker-and-event problems. Read the official source first, then use Perplexity to confirm the exact page or event, then scrape the source for the actionable text or words.',
  };
}

function buildDomainProfile(domain) {
  if (domain === 'mention') {
    return {
      name: 'mention-market-research',
      wrapper: 'mention-market',
      source_hints: [
        'Kalshi market rules and board wording',
        'Perplexity-discovered authoritative source',
        'Live broadcast, replay, or official transcript depending on the rules',
      ],
      evidence_targets: [
        'live broadcast',
        'official replay',
        'official transcript',
        'captions only if the rules allow them',
      ],
      comparison_axes: [
        'allowed speaker role',
        'prepared remarks versus Q&A',
        'event segment and boundary',
        'exact word form and phrase allowance',
        'reflexivity risk if the market changes speech incentives',
      ],
      source_tree_note:
        'For mention markets, the controlling source is usually the exact live source named by the rules. The scraper is only for exact evidence extraction after the source is located.',
      stage_overrides: [
        {
          stage: 'intake',
          purpose: 'Identify the exact phrase, allowed speaker, event boundary, and rules clause.',
          input_focus: 'market title, market id, venue, allowed speaker scope, phrase wording',
          output_focus: 'contract-specific mention context',
        },
        {
          stage: 'market',
          purpose: 'Read the Kalshi board and the rules before doing any probability work.',
          input_focus: 'contract wording, resolution rules, source hierarchy, price, order book',
          output_focus: 'venue-grounded mention snapshot',
        },
        {
          stage: 'research',
          purpose: 'Use Perplexity to discover the exact authoritative source that controls settlement.',
          input_focus: 'which live source, replay, or transcript actually matters',
          output_focus: 'ranked source tree and source summary',
        },
        {
          stage: 'scope',
          purpose: 'Determine whether the phrase is allowed for the speaker, role, and segment.',
          input_focus: 'speaker role, prepared remarks, Q&A, moderator prompts, exclusions',
          output_focus: 'speaker-scope decision',
        },
        {
          stage: 'evidence',
          purpose: 'Use the scraper skill to extract the exact supporting or falsifying evidence.',
          input_focus: 'official pages, transcripts, captions, replay timestamps, clip text',
          output_focus: 'verbatim or structured evidence',
        },
        {
          stage: 'pricing',
          purpose: 'Convert the evidence into a phrase probability and edge estimate.',
          input_focus: 'market probability vs. fair probability, role, and event-specific bias',
          output_focus: 'EV, confidence, and stake cap',
        },
        {
          stage: 'decision',
          purpose: 'Apply mention-specific no-bet filters and produce the final action.',
          input_focus: 'confidence, source quality, clause fit, execution risk',
          output_focus: 'buy_yes, buy_no, or pass',
        },
        {
          stage: 'logging',
          purpose: 'Store the source tree, scope judgment, and final decision for reuse.',
          input_focus: 'all intermediate outputs',
          output_focus: 'audit-ready decision record',
        },
      ],
      notes:
        'Mention markets are resolution-constrained language problems. Treat contract wording as stricter than common sense, separate allowed speaker roles carefully, and only trust transcripts or captions when the rules allow them. Earnings-call markets belong here as mention markets, not as a separate domain.',
    };
  }

  if (domain === 'sports') {
    return {
      name: 'sports-market-research',
      wrapper: 'sports-market',
      source_hints: [
        'Kalshi board and rules',
        'Perplexity-discovered official source',
        'Public schedules, scoreboards, injury reports, lineup pages, or broadcast evidence',
      ],
      evidence_targets: [
        'official schedule',
        'live scoreboard',
        'injury report',
        'lineup page',
        'broadcast replay',
        'official stats page',
      ],
      comparison_axes: ['league', 'market subtype', 'game state', 'team or player context', 'execution risk'],
      source_tree_note:
        'For sports markets, the outside source should be the smallest authoritative public page that actually controls settlement, with scraper extraction used only after that page is identified.',
      stage_overrides: [
        {
          stage: 'intake',
          purpose: 'Identify the league, market subtype, venue, and settlement boundary.',
          input_focus: 'market title, market id, venue, league, market subtype, date',
          output_focus: 'sports market context',
        },
        {
          stage: 'market',
          purpose: 'Read the Kalshi board and rules before looking at any outside sports data.',
          input_focus: 'contract wording, resolution rules, price, order book, market subtype',
          output_focus: 'venue-grounded sports snapshot',
        },
        {
          stage: 'routing',
          purpose: 'Route the market into the correct league-specific modeling skill.',
          input_focus: 'league id, sport, market subtype, pregame versus live versus futures',
          output_focus: 'sport-specific model route',
        },
        {
          stage: 'research',
          purpose: 'Use Perplexity to find the authoritative sports source or public page.',
          input_focus: 'which official page, scoreboard, or report controls the question',
          output_focus: 'ranked source tree and source summary',
        },
        {
          stage: 'evidence',
          purpose: 'Use the scraper skill to extract the exact sports evidence needed for pricing.',
          input_focus: 'schedules, scoreboards, lineups, injuries, stats, replay evidence',
          output_focus: 'verbatim or structured evidence',
        },
        {
          stage: 'pricing',
          purpose: 'Convert the evidence into fair probability and edge.',
          input_focus: 'model probability, market probability, and risk limits',
          output_focus: 'EV, confidence, and stake cap',
        },
        {
          stage: 'decision',
          purpose: 'Apply sports-specific no-bet filters and produce the final action.',
          input_focus: 'confidence, stale data, injury uncertainty, execution risk',
          output_focus: 'buy_yes, buy_no, or pass',
        },
        {
          stage: 'logging',
          purpose: 'Store the routing choice, source tree, and final decision for reuse.',
          input_focus: 'all intermediate outputs',
          output_focus: 'audit-ready decision record',
        },
      ],
      notes:
        'Sports markets should route by league and market subtype before pricing. Use the market venue first, then route into the sport-specific skill, then research the truth source, then extract evidence.',
    };
  }

  if (domain === 'macro') {
    return buildMacroProfile();
  }

  if (domain === 'politics') {
    return buildPoliticsProfile();
  }

  return {
    name: 'event-market-research',
    wrapper: 'general-event-market',
    source_hints: ['Kalshi market rules and board wording', 'Perplexity source discovery', 'Playwright scraper evidence extraction'],
    evidence_targets: ['official page', 'transcript', 'filing', 'schedule', 'board or replay'],
    comparison_axes: ['source fit', 'resolution wording', 'timing boundary', 'execution risk'],
    source_tree_note:
      'Use the venue first, then discover the authoritative outside source, then extract evidence with the scraper skill.',
    stage_overrides: [],
    notes:
      'Keep the output compact, audit-friendly, and reusable across sports, politics, macro, and mention markets.',
  };
}

function buildPlan(input) {
  const venue = canonicalizeVenue(input.venue);
  const domain = inferDomain(input);
  const domainProfile = buildDomainProfile(domain);
  const sourceOrder = [venue, 'Perplexity', 'Playwright Scraper Skill'];
  const marketId = inferMarketId(input);
  const url = input.url ? String(input.url).trim() || null : null;

  return {
    venue,
    domain,
    domain_profile: domainProfile,
    source_order: sourceOrder,
    primary_source: sourceOrder[0],
    research_source: sourceOrder[1],
    evidence_source: sourceOrder[2],
    decision_rule: 'Market first, Perplexity second, scraper third, decision layer last.',
    notes: domainProfile.notes,
    metadata: {
      market_id: marketId,
      title: input.title ?? null,
      question: input.question ?? null,
      market_type: input.market_type ?? null,
      market_subtype: input.market_subtype ?? null,
      url,
      resolution_source: input.resolution_source ?? null,
      context: input.metadata ? { ...input.metadata } : {},
    },
  };
}

function buildWorkflow(plan) {
  const domainProfile = plan.domain_profile;
  const stages =
    domainProfile.stage_overrides.length > 0
      ? domainProfile.stage_overrides
      : [
          {
            stage: 'intake',
            purpose: 'Identify the market, venue, domain, and contract boundary.',
            input_focus: 'market title, market id, venue, question, domain',
            output_focus: 'canonical market context',
          },
          {
            stage: 'market',
            purpose: 'Read the venue itself before looking anywhere else.',
            input_focus: 'contract wording, resolution rules, price, order book',
            output_focus: 'venue-grounded market snapshot',
          },
          {
            stage: 'research',
            purpose: 'Use Perplexity to find the authoritative outside source.',
            input_focus: 'what source actually settles the dispute',
            output_focus: 'ranked source tree and source summary',
          },
          {
            stage: 'evidence',
            purpose: 'Use the scraper skill to extract the exact supporting facts.',
            input_focus: 'official pages, transcripts, filings, schedules, scoreboards',
            output_focus: 'verbatim or structured evidence',
          },
          {
            stage: 'pricing',
            purpose: 'Convert the evidence into fair probability and edge.',
            input_focus: 'market probability vs. fair probability',
            output_focus: 'EV, confidence, and stake cap',
          },
          {
            stage: 'decision',
            purpose: 'Apply no-bet filters and produce a final action.',
            input_focus: 'confidence, stale data, CLV, execution risk',
            output_focus: 'buy_yes, buy_no, or pass',
          },
          {
            stage: 'logging',
            purpose: 'Store the market source tree and final decision for reuse.',
            input_focus: 'all intermediate outputs',
            output_focus: 'audit-ready decision record',
          },
        ];

  return {
    name: domainProfile.name,
    domain_wrapper: domainProfile.wrapper,
    domain_profile: domainProfile,
    stages,
    source_order: plan.source_order,
    source_hints: domainProfile.source_hints,
    evidence_targets: domainProfile.evidence_targets,
    comparison_axes: domainProfile.comparison_axes,
    source_tree_note: domainProfile.source_tree_note,
    decision_rule: plan.decision_rule,
    notes: plan.notes,
  };
}

function buildOutputContract() {
  return {
    name: 'event-market-output',
    sections: [
      {
        section: 'source',
        fields: [
          { name: 'platform', kind: 'string', required: true, description: 'Market venue or platform name.' },
          { name: 'url', kind: 'string', required: false, description: 'Original market URL when provided.' },
          { name: 'market_id', kind: 'string', required: false, description: 'Venue-specific market identifier when available.' },
        ],
      },
      {
        section: 'classification',
        fields: [
          { name: 'event_domain', kind: 'string', required: true, description: 'Broad event bucket such as sports, corporate, politics, media, or general.' },
          { name: 'event_type', kind: 'string', required: true, description: 'Specific event classification such as earnings_call, speech, or ncaamb_game.' },
          { name: 'market_type', kind: 'string', required: true, description: 'Market mechanic such as mention, moneyline, spread, total, or player_prop.' },
          { name: 'status', kind: 'string', required: true, description: 'Analysis readiness status, separate from trade direction.' },
          { name: 'confidence', kind: 'string', required: true, description: 'Confidence in the card quality, not the event outcome.' },
        ],
      },
      {
        section: 'summary',
        fields: [
          { name: 'headline', kind: 'string', required: true, description: 'Compact headline safe to render directly in the app UI.' },
          { name: 'recommendation', kind: 'string', required: true, description: 'Market-type-aware recommendation such as watch, buy_yes, home, or over.' },
          { name: 'one_line_reason', kind: 'string', required: true, description: 'Single-sentence plain-English rationale without workflow leakage.' },
        ],
      },
      {
        section: 'action',
        fields: [
          { name: 'next_action', kind: 'string', required: false, description: 'Operational next step such as fetch_live_prices or review_market_rules.' },
        ],
      },
      {
        section: 'context',
        fields: [
          { name: 'context', kind: 'object', required: true, description: 'Event-specific facts block whose fields vary by event_type.' },
        ],
      },
      {
        section: 'market_view',
        fields: [
          { name: 'market_view', kind: 'object', required: true, description: 'Market-type-specific analysis block whose fields vary by market_type.' },
        ],
      },
    ],
    notes: 'Expose only the compact card in the visible app response. Keep workflow, source tree, and planning details in structured content.',
  };
}

export function buildEventMarketContract(input = {}) {
  const plan = buildPlan(input);
  const user_facing = buildUserFacingCard(input, plan);
  return {
    plan,
    workflow: buildWorkflow(plan),
    output_contract: buildOutputContract(),
    user_facing,
  };
}
