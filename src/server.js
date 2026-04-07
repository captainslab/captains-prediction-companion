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

loadDotEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const APP_NAME = process.env.APP_NAME ?? 'Captains Prediction Companion';
const APP_VERSION = process.env.APP_VERSION ?? '1.0.0';
const PUBLIC_DIR = resolve(__dirname, '../public');
const PORT = Number(process.env.PORT ?? 3000);
const ENABLE_NOTE_TOOLS = process.env.ENABLE_NOTE_TOOLS === 'true';
const DATA_FILE = resolve(process.env.APP_DATA_FILE ?? `${__dirname}/../data/notes.json`);

mkdirSync(dirname(DATA_FILE), { recursive: true });

if (!existsSync(DATA_FILE)) {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
}

const noteStore = createNoteStore(DATA_FILE);
const transports = new Map();

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

function createServer() {
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
    async ({ url }) => {
      const result = await buildFocusedKalshiMarketPlan({ url, venue: 'Kalshi' });
      return buildCardToolResult(result);
    }
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

async function main() {
  const httpServer = http.createServer(async (req, res) => {
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
        noteCount: noteStore.stats().count,
      }));
      return;
    }

    if (req.url.startsWith('/mcp')) {
      let transport = null;
      const sessionId = req.headers['mcp-session-id'];

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
      } else if (req.method === 'POST') {
        const body = await getBodyBuffer(req);

        const server = createServer();
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
  });

  httpServer.listen(PORT, () => {
    console.log(`${APP_NAME} v${APP_VERSION} listening on http://localhost:${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/`);
    console.log(`Health:    http://localhost:${PORT}/healthz`);
    console.log(`MCP:       http://localhost:${PORT}/mcp`);
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
