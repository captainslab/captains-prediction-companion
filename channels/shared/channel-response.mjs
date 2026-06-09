// Shared fan-channel response builder.
// Converts route/workflow results into safe CPC packet text.

import {
  buildDecisionRow,
  renderSectionedPacket,
  EDGE_STATUS,
  CONFIDENCE,
} from '../../scripts/shared/decision-packet.mjs';
import { NO_TRADE_FOOTER } from '../../scripts/packets/lib/common.mjs';

const RAW_INVENTORY_PATTERNS = [
  /={2,}\s*RAW CONTRACT INVENTORY/i,
  /AUDIT ONLY.{0,16}NOT IN MAIN PACKET/i,
  /full board metadata \+ pricing for audit/i,
];

const SECRET_PATTERNS = [
  [/mfa\.[\w-]{20,}/gi, '<REDACTED_DISCORD_TOKEN>'],
  [/[MNO][\w-]{23}\.[\w-]{6}\.[\w-]{27,}/g, '<REDACTED_DISCORD_TOKEN>'],
  [/https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '<REDACTED_DISCORD_WEBHOOK>'],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '<REDACTED_TELEGRAM_TOKEN>'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '<REDACTED_API_KEY>'],
  [/\b(?:bot[_-]?token|api[_-]?key|client[_-]?secret|webhook[_-]?url|secret|authorization|bearer)\b\s*[:=]\s*\S+/gi, (m) => m.replace(/[:=].*/, '=<REDACTED>')],
  [/\b[A-Fa-f0-9]{40,}\b/g, '<REDACTED_HEX>'],
];

function asText(value, fallback = 'MISSING') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function asNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compactReason(value = '') {
  const text = asText(value, '').replace(/\s+/g, ' ').trim();
  if (!text) return 'No additional reason supplied.';
  return text.length <= 260 ? text : `${text.slice(0, 257)}...`;
}

export function scrubSecrets(text = '') {
  let out = String(text ?? '');
  let redactions = 0;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, (...args) => {
      redactions += 1;
      return typeof replacement === 'function' ? replacement(args[0]) : replacement;
    });
  }
  return { text: out, redactions };
}

export function looksLikeRawInventory(text = '') {
  return RAW_INVENTORY_PATTERNS.some((pattern) => pattern.test(String(text ?? '')));
}

function recommendationToStatus(recommendation, status) {
  if (['insufficient_context', 'waiting', 'needs_pricing', 'blocked'].includes(status)) return EDGE_STATUS.BLOCKED;
  if (recommendation === 'buy_yes' || recommendation === 'buy_no') return EDGE_STATUS.PICK;
  if (recommendation === 'watch') return EDGE_STATUS.WATCH;
  if (recommendation === 'pass') return EDGE_STATUS.PASS;
  return EDGE_STATUS.WATCH;
}

function recommendationToPosture(recommendation, status) {
  if (['insufficient_context', 'waiting', 'needs_pricing', 'blocked'].includes(status)) return 'NO_CLEAR_PICK';
  if (recommendation === 'buy_yes' || recommendation === 'buy_no') return 'PICK';
  if (recommendation === 'watch') return 'WATCH';
  return 'NO_CLEAR_PICK';
}

function summaryMissingLayers(summary = {}) {
  const missing = [];
  if (!summary?.source?.url && !summary?.source?.market_id) missing.push('source_url_or_ticker');
  if (summary.status === 'insufficient_context') missing.push('event_context');
  if (summary.status === 'waiting') missing.push('specific_contract');
  if (summary.status === 'needs_pricing') missing.push('model_fair_value');
  if (summary.status === 'market_unmapped') missing.push('supported_market_mapping');
  return missing.length ? missing : ['none'];
}

function summaryAnalysis(summary = {}) {
  const parts = [
    summary?.summary?.one_line_reason,
    summary?.summary?.headline,
    summary?.next_action ? `next_action=${summary.next_action}` : null,
  ].filter(Boolean);
  return compactReason(parts.join(' '));
}

function responseStatusFromSummary(summary = {}) {
  if (summary.status === 'ready') return 'READY';
  if (['waiting', 'needs_pricing'].includes(summary.status)) return 'WAITING';
  if (summary.status === 'market_unmapped') return 'UNSUPPORTED';
  if (summary.status === 'insufficient_context') return 'BLOCKED';
  return 'WAITING';
}

function buildRowFromPlanSummary(summary = {}, route = {}) {
  const marketView = summary.market_view ?? {};
  const tradeView = marketView.trade_view ?? {};
  const recommendation = summary?.summary?.recommendation ?? tradeView.best_side ?? 'watch';
  const status = summary.status ?? 'waiting';
  const blocker = ['ready'].includes(status)
    ? null
    : `${responseStatusFromSummary(summary)}: ${summary?.summary?.one_line_reason ?? 'source or model layer missing'}`;

  const fairYes = asNumberOrNull(tradeView.fair_yes);
  const marketTicker = tradeView.market_ticker
    ?? summary?.source?.market_id
    ?? route?.intake?.ticker
    ?? 'MISSING';
  const sideTarget = marketView.target_phrase
    ?? summary?.summary?.headline
    ?? route?.intake?.ticker
    ?? route?.intake?.url
    ?? 'MISSING';

  return buildDecisionRow({
    marketTicker,
    sideTarget,
    marketType: summary.market_type ?? route?.family ?? 'event_market',
    settlementSummary: marketView.rules_summary ?? 'Verify settlement wording from the source listing before acting.',
    composite: {
      score: fairYes === null ? null : Math.round(fairYes * 1000) / 10,
      posture: recommendationToPosture(recommendation, status),
      layersPresent: status === 'ready' ? 2 : 1,
      layersTotal: 3,
      topEvidenceLayers: [
        summary?.source?.platform ? `${summary.source.platform} source` : 'source intake',
        summary.market_type ? `${summary.market_type} classifier` : null,
      ].filter(Boolean),
      missingLayers: summaryMissingLayers(summary),
      modelProbability: fairYes,
    },
    market: {
      yes_bid: tradeView.market_yes_bid ?? null,
      yes_ask: tradeView.market_yes_ask ?? null,
      last_price: tradeView.last_price ?? tradeView.market_yes ?? null,
    },
    fair: fairYes === null ? {} : { probability: fairYes },
    confidence: summary.confidence === CONFIDENCE.HIGH || summary.confidence === CONFIDENCE.MEDIUM
      ? summary.confidence
      : CONFIDENCE.LOW,
    analysis: summaryAnalysis(summary),
    trigger: {
      price: null,
      event: summary.next_action ?? 'confirm source and model layers before acting',
    },
    blocker,
    statusOverride: recommendationToStatus(recommendation, status),
  });
}

function responseHeader({ title, status, route }) {
  return [
    `=== ${title} ===`,
    `status: ${status}`,
    `family: ${route?.family ?? 'unknown'}`,
    `workflow: ${route?.workflow?.id ?? route?.workflow?.module ?? 'none'}`,
    'safety: no live trades; no bankroll; no order placement; market data is NOT IN SCORE.',
    '',
  ].join('\n');
}

function appendArtifactLines(lines, artifactPaths = []) {
  lines.push('');
  lines.push('artifact_paths:');
  if (artifactPaths.length) {
    for (const p of artifactPaths) lines.push(`  - ${p}`);
  } else {
    lines.push('  - pending: no local artifact was written for this response yet');
  }
}

export function buildStartResponse() {
  return {
    status: 'READY',
    title: 'CPC Telegram Bot',
    route: null,
    artifactPaths: [],
    packetText: [
      'CPC Telegram Bot',
      '',
      'Send a Kalshi market URL or ticker and CPC will return a safe decision packet.',
      '',
      'Supported now:',
      '- Kalshi market/event URLs',
      '- Kalshi market/event tickers',
      '- mentions, MLB, NASCAR, UFC, and politics Kalshi families when the source is provided',
      '',
      'Safety defaults: research only; no live trades; no bankroll; no order placement.',
      'Use /help for examples.',
    ].join('\n'),
  };
}

export function buildHelpResponse() {
  return {
    status: 'READY',
    title: 'CPC Telegram Help',
    route: null,
    artifactPaths: [],
    packetText: [
      'CPC Telegram Help',
      '',
      'Send one of these:',
      '- https://kalshi.com/... market or event URL',
      '- a Kalshi ticker like KX...',
      '- a plain market request plus the exact URL/ticker',
      '',
      'Responses are dry-run decision packets by default.',
      'Unsupported or missing-source requests return BLOCKED/WAITING instead of fake picks.',
      '',
      'Never send secrets, API keys, bot tokens, or private bankroll details.',
    ].join('\n'),
  };
}

export function buildUnsupportedResponse(route = {}) {
  const lines = [
    responseHeader({ title: 'CPC Unsupported Input', status: 'UNSUPPORTED', route }),
    `reason: ${route.reason ?? 'Unsupported input.'}`,
    `supported_types: ${route.supportedTypes ?? 'Kalshi URL or ticker'}`,
    `next_best_command: ${route.nextBestCommand ?? '/help'}`,
    '',
    NO_TRADE_FOOTER,
  ];
  return {
    status: 'UNSUPPORTED',
    title: 'CPC Unsupported Input',
    route,
    artifactPaths: [],
    packetText: lines.join('\n'),
  };
}

export function buildBlockedResponse(route = {}, blocker = null) {
  const status = route.status === 'blocked' ? 'WAITING' : 'BLOCKED';
  const lines = [
    responseHeader({ title: 'CPC Blocked Response', status, route }),
    `blocker: ${blocker ?? route.blocker ?? route.reason ?? 'source or model layer missing'}`,
    `next_best_command: ${route.nextBestCommand ?? 'Send a Kalshi URL or ticker.'}`,
    '',
    'No pick was generated. Missing source/model layers stay BLOCKED or WAITING.',
    '',
    NO_TRADE_FOOTER,
  ];
  return {
    status,
    title: 'CPC Blocked Response',
    route,
    artifactPaths: [],
    packetText: lines.join('\n'),
  };
}

export function buildDecisionResponse(route = {}, workflowResult = {}) {
  const summary = workflowResult.summary;
  if (!summary) return buildBlockedResponse(route, workflowResult.blocker ?? 'workflow did not return a source-backed summary');

  const row = buildRowFromPlanSummary(summary, route);
  const status = responseStatusFromSummary(summary);
  const board = renderSectionedPacket([row], {
    tldrNote: summary?.summary?.headline ?? 'CPC source-backed market packet.',
    auditArtifacts: ['pending: Telegram preview artifact path below'],
    perSectionLimit: 4,
  });
  const lines = [
    responseHeader({ title: 'CPC Decision Packet', status, route }),
    `source: ${summary?.source?.platform ?? 'Kalshi'} ${summary?.source?.url ?? summary?.source?.market_id ?? ''}`.trim(),
    `recommendation: ${summary?.summary?.recommendation ?? 'watch'}`,
    '',
    board,
    '',
    NO_TRADE_FOOTER,
    'No bankroll advice. No order placement. Research only.',
  ];
  appendArtifactLines(lines, []);
  return {
    status,
    title: 'CPC Decision Packet',
    route,
    summary,
    artifactPaths: [],
    packetText: lines.join('\n'),
  };
}

export function buildChannelResponse({ intake, route, workflowResult } = {}) {
  if (intake?.inputType === 'command') {
    if (intake.command === '/start') return buildStartResponse();
    if (intake.command === '/help') return buildHelpResponse();
    return buildUnsupportedResponse({
      ...route,
      reason: `Unknown command: ${intake.command}`,
      nextBestCommand: '/help',
    });
  }
  if (!route?.supported && route?.status === 'blocked') return buildBlockedResponse(route, route.blocker);
  if (!route?.supported) return buildUnsupportedResponse(route);
  if (workflowResult?.blocker) return buildBlockedResponse(route, workflowResult.blocker);
  return buildDecisionResponse(route, workflowResult);
}

export function withArtifactPaths(response = {}, artifactPaths = []) {
  const paths = artifactPaths.filter(Boolean);
  if (!paths.length) return response;
  const lines = String(response.packetText ?? '').split('\n');
  const marker = lines.findIndex((line) => line.trim() === 'artifact_paths:');
  if (marker >= 0) {
    const keep = lines.slice(0, marker + 1);
    for (const p of paths) keep.push(`  - ${p}`);
    return { ...response, artifactPaths: paths, packetText: keep.join('\n') };
  }
  const next = lines.slice();
  appendArtifactLines(next, paths);
  return { ...response, artifactPaths: paths, packetText: next.join('\n') };
}
