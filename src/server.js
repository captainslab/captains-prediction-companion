#!/usr/bin/env node
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import {
  buildEventMarketPlan,
  buildEventMarketPlanSummary,
  buildFocusedKalshiMarketPlan,
} from './eventMarketTool.js';
import { buildEventMarketWorkflowPrompt } from './eventMarketPrompt.js';
import { createNoteStore } from './noteStore.js';
import { loadDotEnv } from './env.js';
import { createPipelineService } from './pipelineService.js';
import { fetchKalshiMarkets } from './marketSources.js';

loadDotEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const APP_NAME = process.env.APP_NAME ?? 'Captains Prediction Companion';
const APP_VERSION = process.env.APP_VERSION ?? '1.0.0';
const PUBLIC_DIR = resolve(__dirname, '../public');
const PORT = Number(process.env.PORT ?? 3000);
const ENABLE_NOTE_TOOLS = process.env.ENABLE_NOTE_TOOLS === 'true';
const DATA_FILE = resolve(process.env.APP_DATA_FILE ?? `${__dirname}/../data/notes.json`);
const PIPELINE_STATE_FILE = resolve(
  process.env.PIPELINE_STATE_FILE ?? `${__dirname}/../data/pipeline-state.json`
);
const PIPELINE_OUTPUT_FILE = resolve(
  process.env.PIPELINE_OUTPUT_FILE ?? `${__dirname}/../data/pipeline-card-outputs.json`
);

mkdirSync(dirname(DATA_FILE), { recursive: true });

if (!existsSync(DATA_FILE)) {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
}

const noteStore = createNoteStore(DATA_FILE);
const transports = new Map();

function parseSeedUrls(rawValue) {
  if (typeof rawValue !== 'string') return [];
  return rawValue
    .split(/[\n,]/)
    .map(value => value.trim())
    .filter(Boolean);
}

async function buildSeedUrls() {
  const envUrls = parseSeedUrls(process.env.PIPELINE_SEED_URLS);

  try {
    const calendarUrls = await fetchKalshiMarkets({
      calendarUrl: process.env.PIPELINE_CALENDAR_URL,
      limit: Number(process.env.PIPELINE_CALENDAR_LIMIT ?? 50),
    });

    return [...new Set([...calendarUrls, ...envUrls])];
  } catch (err) {
    console.error('Calendar seed fetch failed, falling back to env seeds:', err);
    return envUrls;
  }
}

const pipelineService = createPipelineService({
  stateFile: PIPELINE_STATE_FILE,
  outputFile: PIPELINE_OUTPUT_FILE,
  seedUrls: await buildSeedUrls(),
});

function buildCardToolResult(result, { includeHidden = false } = {}) {
  const summary = buildEventMarketPlanSummary(result);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(summary, null, 2),
      },
    ],
    structuredContent: includeHidden ? result : summary,
  };
}

export async function analyzeKalshiMarketUrlTool({ url }, options = {}) {
  options.pipelineService?.recordRecentUrl?.(url);
  const result = await buildFocusedKalshiMarketPlan({ url, venue: 'Kalshi' }, options);
  return buildCardToolResult(result);
}

function createServer(options = {}) {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    { capabilities: { logging: {} } }
  );

  server.registerTool(
    'app_status',
    {
      description: 'Get a compact status report for Captains Prediction Companion.',
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      const status = {
        appName: APP_NAME,
        version: APP_VERSION,
        dataFile: DATA_FILE,
        noteCount: noteStore.stats().count,
        launchedAt: new Date().toISOString(),
        transport: 'streamable-http',
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        structuredContent: status,
      };
    }
  );

  if (ENABLE_NOTE_TOOLS) {
    server.registerTool(
      'remember_note',
      {
        description: 'Save a short note for later retrieval inside this private app.',
        inputSchema: {
          title: z.string().min(1).describe('Short note title'),
          body: z.string().min(1).describe('Note text'),
          tags: z.array(z.string()).default([]).describe('Optional tags'),
        },
      },
      async ({ title, body, tags }) => {
        const note = noteStore.create({ title, body, tags });
        return {
          content: [{ type: 'text', text: `Saved note ${note.id}.` }],
          structuredContent: note,
        };
      }
    );

    server.registerTool(
      'list_notes',
      {
        description: 'List the newest saved notes.',
        inputSchema: {
          limit: z.number().int().min(1).max(50).default(10).describe('Maximum notes to return'),
        },
      },
      async ({ limit }) => {
        const notes = noteStore.list(limit);
        return {
          content: [{ type: 'text', text: JSON.stringify(notes, null, 2) }],
          structuredContent: { notes },
        };
      }
    );

    server.registerTool(
      'search_notes',
      {
        description: 'Search notes by text or tag.',
        inputSchema: {
          query: z.string().min(1).describe('Search term'),
          limit: z.number().int().min(1).max(50).default(10).describe('Maximum notes to return'),
        },
      },
      async ({ query, limit }) => {
        const notes = noteStore.search(query, limit);
        return {
          content: [{ type: 'text', text: JSON.stringify(notes, null, 2) }],
          structuredContent: { query, notes },
        };
      }
    );

    server.registerTool(
      'delete_note',
      {
        description: 'Delete a note by id.',
        inputSchema: {
          id: z.string().min(1).describe('Note id'),
        },
      },
      async ({ id }) => {
        const removed = noteStore.delete(id);
        return {
          content: [{ type: 'text', text: removed ? `Deleted note ${id}.` : `No note found for ${id}.` }],
          structuredContent: { id, removed },
        };
      }
    );
  }

  server.registerTool(
    'analyze_kalshi_market_url',
    {
      description:
        'Call this immediately when the user pastes a kalshi.com/markets URL. This is the primary read-only URL analysis tool for Captains Prediction Companion. Input: one Kalshi market URL. Output: the authoritative compact user-facing card JSON only.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        url: z.string().describe('Kalshi market URL to analyze'),
      },
    },
    async ({ url }) => analyzeKalshiMarketUrlTool({ url }, { pipelineService: options.pipelineService })
  );

  server.registerPrompt(
    'event_market_workflow',
    {
      title: 'Event Market Workflow',
      description: 'Prime the model with the reusable event-market research workflow. When the user drops a Kalshi or supported market link, immediately call event_market_plan with that URL.',
      argsSchema: {
        venue: z.string().default('Kalshi').describe('Market venue or exchange name'),
        domain: z.string().optional().describe('Domain label such as sports, politics, macro, or mention'),
        market_id: z.string().optional().describe('Venue-specific market identifier'),
        title: z.string().optional().describe('Human-readable title or question for the market'),
        question: z.string().optional().describe('Binary proposition or resolution question'),
        market_type: z.string().optional().describe('High-level market type'),
        market_subtype: z.string().optional().describe('Narrow market subtype used for routing'),
        url: z.string().optional().describe('Canonical URL for the market or source page. Pass the URL when the user drops a link so the plan tool auto-runs.'),
        resolution_source: z.string().optional().describe('Primary authoritative source if known'),
        notes: z.string().optional().describe('Optional operator notes'),
      },
    },
    async args => buildEventMarketWorkflowPrompt(args)
  );

  return server;
}

function getBodyBuffer(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise(null);
        return;
      }

      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolvePromise(JSON.parse(raw));
      } catch (error) {
        rejectPromise(error);
      }
    });
    req.on('error', rejectPromise);
  });
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function createHttpRequestHandler({ pipelineService = null, noteStore = null } = {}) {
  return async function handleRequest(req, res) {
    if (!req.url) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing request URL' }));
      return;
    }

    if (req.url === '/' || req.url === '/index.html') {
      const indexPath = resolve(PUBLIC_DIR, 'index.html');
      if (existsSync(indexPath)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(indexPath));
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Dashboard not found');
      }
      return;
    }

    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        appName: APP_NAME,
        version: APP_VERSION,
        noteCount: noteStore?.stats?.().count ?? 0,
      }));
      return;
    }

    if (req.url === '/pipeline/status' && req.method === 'GET') {
      writeJson(res, 200, pipelineService?.getStatus?.() ?? {});
      return;
    }

    if (req.url === '/pipeline/outputs/latest' && req.method === 'GET') {
      const latest = pipelineService?.getLatestBoardOutput?.();
      if (!latest) {
        writeJson(res, 404, { error: 'No stored board outputs found' });
        return;
      }

      writeJson(res, 200, latest);
      return;
    }

    if (req.url === '/pipeline/outputs' && req.method === 'GET') {
      try {
        const raw = readFileSync(PIPELINE_OUTPUT_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        writeJson(res, 200, Array.isArray(parsed) ? parsed.slice(-10) : []);
      } catch {
        writeJson(res, 200, []);
      }
      return;
    }

    if (req.url === '/pipeline/reset' && req.method === 'POST') {
      pipelineService?.reset?.();
      writeJson(res, 200, {
        ok: true,
        status: pipelineService?.getStatus?.() ?? {},
      });
      return;
    }

    if (req.url === '/pipeline/queue' && req.method === 'POST') {
      let body = null;
      try {
        body = await getBodyBuffer(req);
      } catch {
        writeJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      const result = pipelineService?.queueUrl?.(body?.url) ?? { ok: false, error: 'Pipeline unavailable' };
      if (!result.ok) {
        writeJson(res, 400, { error: result.error });
        return;
      }

      writeJson(res, 200, {
        ok: true,
        queued: result.queued,
        url: result.url,
        status: pipelineService?.getStatus?.() ?? {},
      });
      return;
    }

    if (req.url === '/pipeline/run/production' && req.method === 'POST') {
      let body = null;
      try {
        body = await getBodyBuffer(req);
      } catch {
        writeJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      const maxEvents = Number(body?.max_events);
      const runResult = pipelineService?.startProductionRun?.({
        full: body?.full !== false,
        max_events: Number.isInteger(maxEvents) && maxEvents > 0 ? maxEvents : undefined,
        implications_model:
          typeof body?.implications_model === 'string' ? body.implications_model : undefined,
        validation_model:
          typeof body?.validation_model === 'string' ? body.validation_model : undefined,
      });

      if (!runResult?.started) {
        writeJson(res, 409, {
          error: 'Pipeline already running',
          status: runResult?.status ?? pipelineService?.getStatus?.() ?? {},
        });
        return;
      }

      writeJson(res, 202, {
        ok: true,
        status: runResult.status,
      });
      return;
    }

    if (req.url.startsWith('/mcp')) {
      let transport = null;
      const sessionId = req.headers['mcp-session-id'];

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
      } else if (req.method === 'POST') {
        const body = await getBodyBuffer(req);

        const server = createServer({ pipelineService });
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => {
            transports.set(id, transport);
          },
        });

        transport.onclose = () => {
          const currentSessionId = transport?.sessionId;
          if (currentSessionId) {
            transports.delete(currentSessionId);
          }
        };

        transport.onerror = error => {
          console.error('MCP transport error:', error);
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (!transport) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'No valid MCP session' },
          id: null,
        }));
        return;
      }

      const body = req.method === 'POST' ? await getBodyBuffer(req) : undefined;
      await transport.handleRequest(req, res, body);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  };
}

async function main() {
  const handleRequest = createHttpRequestHandler({ pipelineService, noteStore });
  const httpServer = http.createServer(handleRequest);

  httpServer.listen(PORT, () => {
    console.log(`${APP_NAME} v${APP_VERSION} listening on http://localhost:${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/`);
    console.log(`Health:    http://localhost:${PORT}/healthz`);
    console.log(`MCP:       http://localhost:${PORT}/mcp`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
