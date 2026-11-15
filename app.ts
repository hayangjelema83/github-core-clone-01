// The forge's HTTP server: one node:http server, in-memory store, no dependencies.
// Routes: GET /healthz, git smart HTTP at /{owner}/{repo}.git, REST v3 under /api/v3,
// GraphQL at /api/graphql, MCP at /mcp. Everything else is a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { viewerUser } from './scenario.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const FORGE_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const store = new Store();
const viewerLogin = viewerUser().login;
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Read the whole request body (binary-safe). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

/** The bearer token authorizes; an absent or wrong token is 401. */
function authorized(req: IncomingMessage): boolean {
  if (FORGE_TOKEN === '') return true; // local dev: no token configured
  const token = bearerToken(req);
  return token !== null && token === FORGE_TOKEN;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } catch {
        // The response is already gone; nothing left to do.
      }
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);
  const host = req.headers.host ?? '127.0.0.1';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${host}`);
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Boot probe: no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const name = decodeURIComponent(gitMatch[2]);
    const suffix = gitMatch[3] ?? '';
    if (method === 'GET' && suffix === '/info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'service is required' });
        return;
      }
      const gitProtocol = req.headers['git-protocol'];
      const result = infoRefs(store, owner, name, service, typeof gitProtocol === 'string' ? gitProtocol : undefined);
      sendBytes(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && (suffix === '/git-upload-pack' || suffix === '/git-receive-pack')) {
      const body = await readBody(req);
      const gitProtocol = req.headers['git-protocol'];
      const result =
        suffix === '/git-upload-pack'
          ? uploadPack(store, owner, name, body, typeof gitProtocol === 'string' ? gitProtocol : undefined)
          : receivePack(store, owner, name, body);
      sendBytes(res, result.status, result.contentType, result.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // MCP: POST /mcp (DELETE closes a session best-effort).
  if (path === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp({ store, viewerLogin }, raw.toString('utf8'));
    if (result.body === null) {
      res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  // GraphQL: POST /api/graphql.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    } catch {
      sendJson(res, 400, { message: 'Malformed JSON body' });
      return;
    }
    const result = handleGraphQL({ store, viewerLogin }, parsed);
    sendJson(res, result.status, result.body);
    return;
  }

  // REST v3: /api/v3/...
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    let parsed: unknown = undefined;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length) {
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Malformed JSON body' });
          return;
        }
      }
    }
    const result = handleRest({ store, viewerLogin, host }, method, url, parsed);
    if (result.status === 204) {
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    const headers = { 'x-oauth-scopes': 'repo, read:org', ...(result.headers ?? {}) };
    sendJson(res, result.status, result.body, headers);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
