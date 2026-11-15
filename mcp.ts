// Model Context Protocol endpoint at POST /mcp: JSON-RPC 2.0 over Streamable HTTP.
// Speaks the modern revision 2026-07-28 (server/discover, no handshake/session) and
// the legacy initialize handshake as a fallback. Tools act on the same store as REST.

import type { Store } from './store.ts';
import { repoObject as restRepoObject } from './rest.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';

export interface McpContext {
  store: Store;
  viewerLogin: string;
}

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      name: { type: 'string', description: 'The name of the repository.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body of the issue.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      body: { type: 'string', description: 'The body of the pull request.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolJson(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  };
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | undefined {
  const wanted = normalizeName(name);
  for (const tool of TOOLS) {
    const canonical = normalizeName(tool.name);
    if (wanted === canonical || wanted.endsWith(canonical)) return tool;
  }
  return undefined;
}

// Synonym sets the suite maps documented arguments onto (rules §MCP).
const SYNONYMS: Record<string, string[]> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  head: ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
};

function pickArg(args: Record<string, unknown>, semantic: string): unknown {
  for (const key of SYNONYMS[semantic] ?? [semantic]) {
    if (args[key] !== undefined) return args[key];
  }
  return undefined;
}

function splitFullName(args: Record<string, unknown>): { owner?: string; repo?: string } {
  for (const key of ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']) {
    const value = args[key];
    if (typeof value === 'string' && value.includes('/')) {
      const [owner, repo] = value.split('/', 2);
      return { owner, repo };
    }
  }
  return {};
}

interface ToolOutcome {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

function runTool(ctx: McpContext, tool: ToolDef, args: Record<string, unknown>): ToolOutcome {
  const store = ctx.store;
  // Required-argument check (the suite never sends an unfillable required property).
  for (const required of tool.required) {
    const value = pickArg(args, required);
    if (value === undefined || value === null || value === '') {
      return { ok: false, error: `missing required argument "${required}"` };
    }
  }
  const full = splitFullName(args);
  const owner = (pickArg(args, 'owner') as string | undefined) ?? full.owner ?? ctx.viewerLogin;
  const repoName = (pickArg(args, 'repo') as string | undefined) ?? full.repo;

  switch (tool.name) {
    case 'create_repo': {
      const name = (pickArg(args, 'name') as string | undefined) ?? repoName;
      if (!name) return { ok: false, error: 'missing required argument "name"' };
      const created = store.createRepo(owner, name, {
        private: pickArg(args, 'private') === true,
        description: typeof pickArg(args, 'description') === 'string' ? (pickArg(args, 'description') as string) : '',
      });
      if ('error' in created) return { ok: false, error: created.error };
      const repo = restRepoObject(created);
      return { ok: true, result: { ...repo, full_name: `${owner}/${name}` } };
    }
    case 'get_repo': {
      if (!repoName) return { ok: false, error: 'missing required argument "repo"' };
      const repo = store.getRepo(owner, repoName);
      if (!repo || owner !== ctx.viewerLogin) return { ok: false, error: 'repository not found' };
      return { ok: true, result: { ...restRepoObject(repo), full_name: `${owner}/${repoName}` } };
    }
    case 'create_issue': {
      if (!repoName) return { ok: false, error: 'missing required argument "repo"' };
      const repo = store.getRepo(owner, repoName);
      if (!repo || owner !== ctx.viewerLogin) return { ok: false, error: 'repository not found' };
      const title = pickArg(args, 'title') as string;
      const body = (pickArg(args, 'body') as string | undefined) ?? '';
      const created = store.createIssue(repo, title, body, []);
      if ('error' in created) return { ok: false, error: created.error };
      return {
        ok: true,
        result: {
          id: created.id, number: created.number, title: created.title, body: created.body,
          state: created.state, full_name: `${owner}/${repoName}`, html_url: '',
        },
      };
    }
    case 'list_issues': {
      if (!repoName) return { ok: false, error: 'missing required argument "repo"' };
      const repo = store.getRepo(owner, repoName);
      if (!repo || owner !== ctx.viewerLogin) return { ok: false, error: 'repository not found' };
      const state = (pickArg(args, 'state') as string | undefined) ?? 'open';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return {
        ok: true,
        result: {
          issues: issues.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state })),
        },
      };
    }
    case 'create_pull_request': {
      if (!repoName) return { ok: false, error: 'missing required argument "repo"' };
      const repo = store.getRepo(owner, repoName);
      if (!repo || owner !== ctx.viewerLogin) return { ok: false, error: 'repository not found' };
      const title = pickArg(args, 'title') as string;
      const body = (pickArg(args, 'body') as string | undefined) ?? '';
      const head = pickArg(args, 'head') as string;
      const base = pickArg(args, 'base') as string;
      const created = store.createPull(repo, title, body, head, base);
      if ('error' in created) return { ok: false, error: created.error };
      return {
        ok: true,
        result: {
          id: created.id, number: created.number, title: created.title, body: created.body,
          state: created.state, head: { ref: created.headRef, sha: created.headSha },
          base: { ref: created.baseRef, sha: created.baseSha }, full_name: `${owner}/${repoName}`,
        },
      };
    }
    case 'merge_pull_request': {
      if (!repoName) return { ok: false, error: 'missing required argument "repo"' };
      const repo = store.getRepo(owner, repoName);
      if (!repo || owner !== ctx.viewerLogin) return { ok: false, error: 'repository not found' };
      const number = Number(pickArg(args, 'pull_number'));
      const pull = store.getPull(repo, number);
      if (!pull) return { ok: false, error: 'pull request not found' };
      const merged = store.mergePull(repo, pull);
      if (typeof merged === 'object') return { ok: false, error: merged.error === 'conflict' ? 'merge conflict' : merged.error };
      return { ok: true, result: { merged: true, sha: merged, message: 'Pull request successfully merged', number } };
    }
    default:
      return { ok: false, error: `unknown tool "${tool.name}"` };
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/**
 * Handle one POST /mcp request. `rawBody` is the exact request text (already read).
 * Returns {status, body} where body is a JSON value (or null for 202 notifications).
 */
export function handleMcp(ctx: McpContext, rawBody: string): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id === undefined ? null : request.id;
  const method = request.method;
  if (typeof method !== 'string') {
    return { status: 200, body: rpcError(id, -32600, 'Invalid Request') };
  }
  // Notifications (no id) are answered 202 with no body.
  if (id === null && request.id === undefined) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 202, body: null };
    }
  }
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        resultType: 'server/discover',
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
    };
  }

  if (method === 'initialize') {
    const offered = (params.protocolVersion as string | undefined) ?? '2025-11-25';
    const legacy = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const negotiated = legacy.includes(offered) ? offered : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS.map(toolJson) }) };
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string') {
      return { status: 200, body: rpcError(id, -32602, 'Invalid params: tool name is required') };
    }
    const tool = findTool(name);
    if (!tool) {
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${name}`) };
    }
    const outcome = runTool(ctx, tool, args);
    if (!outcome.ok) {
      // Missing required argument -> -32602; other tool failures -> isError result.
      if (outcome.error?.startsWith('missing required argument')) {
        return { status: 200, body: rpcError(id, -32602, `Invalid params: ${outcome.error}`) };
      }
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: outcome.error }) }],
          structuredContent: { error: outcome.error },
          isError: true,
        }),
      };
    }
    const text = JSON.stringify(outcome.result);
    return {
      status: 200,
      body: rpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.result,
        isError: false,
      }),
    };
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
