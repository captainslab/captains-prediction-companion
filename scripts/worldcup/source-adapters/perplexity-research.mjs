// World Cup Perplexity research adapter.
//
// Supplemental source context only. This lane never feeds model scoring,
// market math, or any pricing input. It exists to gather team news, injuries,
// suspensions, lineup status, and source-quality notes for the packet path.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { ensurePerplexityEnvLoaded } from '../../mentions/mentions-research-perplexity.mjs';

const PPLX_URL = 'https://api.perplexity.ai/chat/completions';
const KEY_PATH = resolve(homedir(), '.config/cpc/perplexity.key');
const DEFAULT_MODEL = 'sonar';

export const PERPLEXITY_UNAVAILABLE = 'PERPLEXITY_UNAVAILABLE';

function nowIso() {
  return new Date().toISOString();
}

function readKey(env = process.env) {
  ensurePerplexityEnvLoaded(env);
  const fromEnv = (env.PERPLEXITY_API_KEY || env.PPLX_API_KEY || '').replace(/\s+/g, '');
  if (fromEnv) return fromEnv;
  if (!existsSync(KEY_PATH)) return null;
  const key = readFileSync(KEY_PATH, 'utf8').replace(/\s+/g, '');
  return key || null;
}

function kickoffLabel(match) {
  if (!match?.kickoff_utc) return 'kickoff TBD';
  const d = new Date(match.kickoff_utc);
  if (Number.isNaN(d.getTime())) return 'kickoff TBD';
  const ct = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(d);
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(d);
  return `${ct} / ${et}`;
}

function normalizeTextList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  const text = String(value).trim();
  return text ? [text] : [];
}

function extractJsonPayload(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const codeFenceStripped = trimmed
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  for (const candidate of [trimmed, codeFenceStripped]) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.records)) return parsed.records;
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function buildPrompt({ date, matches }) {
  const matchLines = (matches || []).map((match, idx) => (
    `${idx + 1}. ${match.home_team} vs ${match.away_team} | match_id ${match.match_id} | kickoff ${kickoffLabel(match)} | venue ${match.venue ?? 'unknown'} | group ${match.group ?? 'group stage'}`
  )).join('\n');

  return [
    'You are a soccer research assistant for a pre-lock World Cup packet.',
    'Return only sourced context. Do not include odds, prices, spreads, totals, projections, or picks.',
    'If a fact is unconfirmed, say unknown or not confirmed.',
    'Return a JSON array only.',
    'Each object must contain:',
    '- match_id',
    '- lineup_status',
    '- summary',
    '- team_news',
    '- injuries',
    '- suspensions',
    '- source_quality',
    '- citations',
    '',
    `Slate date: ${date}`,
    'Matches:',
    matchLines || '(none)',
  ].join('\n');
}

function normalizeRecord(raw, matchId) {
  const citations = Array.isArray(raw?.citations)
    ? raw.citations.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
    : [];
  return {
    match_id: String(raw?.match_id ?? matchId ?? '').trim() || null,
    lineup_status: String(raw?.lineup_status ?? 'unknown').trim() || 'unknown',
    summary: String(raw?.summary ?? raw?.note ?? 'No sourced summary returned.').trim(),
    team_news: normalizeTextList(raw?.team_news),
    injuries: normalizeTextList(raw?.injuries),
    suspensions: normalizeTextList(raw?.suspensions),
    source_quality: String(raw?.source_quality ?? 'unknown').trim() || 'unknown',
    citations,
    notes: raw?.notes ?? null,
  };
}

function buildUnavailableArtifact({ date, matches, reason, model = DEFAULT_MODEL }) {
  return {
    schema: 'worldcup_perplexity_research_v1',
    generated_utc: nowIso(),
    date,
    source_id: 'perplexity',
    model,
    status: PERPLEXITY_UNAVAILABLE,
    used_in_score: false,
    reason,
    match_count: matches.length,
    records: [],
    raw_answer: null,
    citations: [],
    prompt: buildPrompt({ date, matches }),
  };
}

function summarizeRecords(records = []) {
  const counts = { confirmed: 0, not_confirmed: 0, unknown: 0 };
  for (const record of records) {
    const status = String(record?.lineup_status ?? 'unknown').toLowerCase();
    if (status.includes('confirm')) counts.confirmed += 1;
    else if (status.includes('not')) counts.not_confirmed += 1;
    else counts.unknown += 1;
  }
  return counts;
}

function writeArtifact(outPath, artifact) {
  mkdirSync(resolve(outPath, '..'), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

export async function runWorldCupPerplexityResearch({
  date,
  matches = [],
  stateRoot = 'state',
  env = process.env,
  model = DEFAULT_MODEL,
  fetchImpl = fetch,
  perplexityImpl = null,
} = {}) {
  const outPath = resolve(stateRoot, 'worldcup', date, 'research', 'perplexity_research.json');
  const key = readKey(env);
  if (!key) {
    const artifact = buildUnavailableArtifact({ date, matches, reason: 'PERPLEXITY_UNAVAILABLE: key not found', model });
    writeArtifact(outPath, artifact);
    return { ok: false, status: PERPLEXITY_UNAVAILABLE, outPath, artifact };
  }

  const runRequest = async (messages) => {
    if (typeof perplexityImpl === 'function') {
      return perplexityImpl({ key, model, messages });
    }
    const res = await fetchImpl(PPLX_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 1200,
        temperature: 0.2,
        return_citations: true,
      }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const message = json?.error?.message || `HTTP ${res.status}`;
      throw new Error(message);
    }
    return {
      content: json?.choices?.[0]?.message?.content ?? '',
      citations: Array.isArray(json?.citations) ? json.citations : [],
    };
  };

  try {
    const messages = [
      {
        role: 'system',
        content: 'You are a soccer research assistant. Report only sourced facts. Never invent lineups, injuries, or suspensions. Do not include betting odds or market prices.',
      },
      {
        role: 'user',
        content: buildPrompt({ date, matches }),
      },
    ];
    const result = await runRequest(messages);
    const parsed = extractJsonPayload(result?.content) || [];
    const parsedRecords = matches.map((match, idx) => normalizeRecord(parsed[idx], match.match_id));
    const artifact = {
      schema: 'worldcup_perplexity_research_v1',
      generated_utc: nowIso(),
      date,
      source_id: 'perplexity',
      model,
      status: 'ok',
      used_in_score: false,
      match_count: matches.length,
      records: parsedRecords,
      raw_answer: result?.content ?? '',
      citations: Array.isArray(result?.citations) ? result.citations : [],
      prompt: buildPrompt({ date, matches }),
      source_quality: summarizeRecords(parsedRecords),
    };
    writeArtifact(outPath, artifact);
    return { ok: true, status: 'ok', outPath, artifact };
  } catch (error) {
    const artifact = buildUnavailableArtifact({
      date,
      matches,
      reason: `PERPLEXITY_UNAVAILABLE: ${error?.message || 'request failed'}`,
      model,
    });
    artifact.error = error?.message || 'request failed';
    writeArtifact(outPath, artifact);
    return { ok: false, status: PERPLEXITY_UNAVAILABLE, outPath, artifact };
  }
}
