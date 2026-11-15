// GitHub REST v3 API under /api/v3: repositories, branches, commits, contents,
// issues, comments, labels and pull requests. Every reply is JSON with an
// X-GitHub-Request-Id; errors carry {message}.

import { hashObject, isObjectId, parseCommit } from './gitcore.ts';
import {
  diffFlat,
  FIXED_EPOCH,
  isoAt,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { viewerUser } from './scenario.ts';

export interface RestContext {
  store: Store;
  viewerLogin: string;
  host: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

export function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function userObject(login: string): Record<string, unknown> {
  const viewer = viewerUser();
  return {
    login,
    id: login === viewer.login ? viewer.id : 1000,
    node_id: `U_${Buffer.from(`user:${login}`).toString('base64url')}`,
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

export function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(repo.owner),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelObject(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: label.nodeId,
    url: label.url,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueObject(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: userObject(issue.userLogin),
    labels: issue.labels.map(labelObject),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    body: issue.body,
    reactions: { url: '', total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    timeline_url: '',
    performed_via_github_app: null,
    state_reason: null,
  };
}

function pullObject(pull: PullRequest, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.nodeId,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userObject(pull.userLogin),
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.merged ? pull.mergedAt : pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: '',
    review_comments_url: '',
    review_comment_url: '',
    comments_url: '',
    statuses_url: '',
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userObject(repo.owner),
      repo: repoObject(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userObject(repo.owner),
      repo: repoObject(repo),
    },
    _links: {},
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: pull.mergeable,
    rebaseable: true,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commitObject(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha,
    node_id: `C_${Buffer.from(`commit:${repo.owner}/${repo.name}:${sha}`).toString('base64url')}`,
    commit: {
      author: { name: author.name, email: author.email, date: new Date(author.timestamp * 1000).toISOString() },
      committer: { name: committer.name, email: committer.email, date: new Date(committer.timestamp * 1000).toISOString() },
      message: commit.message,
      tree: { sha: commit.tree, url: '' },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: '',
    comments_url: '',
    author: userObject(author.email.split('@')[0]),
    committer: userObject(committer.email.split('@')[0]),
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

function parseIdentity(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match) return { name: match[1], email: match[2], timestamp: Number(match[3]) };
  return { name: line, email: '', timestamp: FIXED_EPOCH };
}

function queryOf(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) out[key] = value;
  return out;
}

function pageOf(query: Record<string, string>): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.per_page ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  return { page, perPage };
}

function linkHeader(ctx: RestContext, path: string, query: Record<string, string>, page: number, perPage: number, totalPages: number): string {
  const parts: string[] = [];
  const build = (p: number): string => {
    const params = new URLSearchParams({ ...query, page: String(p), per_page: String(perPage) });
    return `http://${ctx.host}${path}?${params.toString()}`;
  };
  if (page < totalPages) parts.push(`<${build(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${build(page - 1)}>; rel="prev"`);
  parts.push(`<${build(1)}>; rel="first"`);
  parts.push(`<${build(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { page: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages };
}

/** The store's repo for a path, or an error result when it is not this token's to read. */
function repoOrError(ctx: RestContext, owner: string, name: string): Repo | RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  return repo;
}

function asRepo(value: Repo | RestResult): value is Repo {
  return (value as Repo).objects !== undefined;
}

/** Route a REST request. `segments` are the path parts after /api/v3. */
export function handleRest(
  ctx: RestContext,
  method: string,
  url: URL,
  body: unknown,
): RestResult {
  const query = queryOf(url);
  const rawSegments = url.pathname.split('/').filter((part) => part !== '');
  // rawSegments[0..1] are 'api','v3'; the rest is the route.
  const segments = rawSegments.slice(2);
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  // API root.
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  // /meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', verifiable_rate_limit: false });
  }
  // /user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    const viewer = viewerUser();
    return ok(200, {
      login: viewer.login, id: viewer.id, node_id: `U_${Buffer.from(`user:${viewer.login}`).toString('base64url')}`,
      avatar_url: '', gravatar_id: '', url: '/api/v3/user', html_url: `https://github.com/${viewer.login}`,
      type: 'User', site_admin: false, name: viewer.name, email: viewer.email,
      public_repos: ctx.store.listRepos(viewer.login).length,
    });
  }
  // /user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pageOf(query);
      const repos = ctx.store.listRepos(ctx.viewerLogin);
      const { page: items, totalPages } = paginate(repos, page, perPage);
      const headers: Record<string, string> = {};
      if (totalPages > 1) headers.link = linkHeader(ctx, '/api/v3/user/repos', query, page, perPage, totalPages);
      return ok(200, items.map(repoObject), headers);
    }
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') return err(422, 'name is required');
      const created = ctx.store.createRepo(ctx.viewerLogin, name, {
        private: input.private === true,
        description: typeof input.description === 'string' ? input.description : '',
      });
      if ('error' in created) return err(422, 'Repository already exists');
      return ok(201, repoObject(created));
    }
    return err(404, 'Not Found');
  }

  // /repos/{owner}/{repo}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decode(segments[1]);
    const name = decode(segments[2]);
    const rest = segments.slice(3);
    const repo = repoOrError(ctx, owner, name);
    if (!asRepo(repo)) return repo;

    // The repository itself.
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoObject(repo));
      if (method === 'PATCH') {
        const input = (body ?? {}) as Record<string, unknown>;
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        return ok(200, repoObject(repo));
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    // /branches and /branches/{branch}
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref), url: '' }, protected: false }));
        return ok(200, list);
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decode(rest[1]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return err(404, 'Branch not found');
        return ok(200, { name: branch, commit: { sha, url: '' }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // /commits
    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const ref = query.sha ?? repo.defaultBranch;
        const tip = ctx.store.resolveRef(repo, ref);
        if (!tip) return err(404, 'No commit found for SHA: ' + ref);
        const { page, perPage } = pageOf(query);
        const commits = ctx.store.listCommits(repo, tip, 1000);
        const { page: items } = paginate(commits, page, perPage);
        return ok(200, items.map((commit) => commitObject(repo, commit.sha)).filter((entry) => entry !== null));
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = decode(rest[1]);
        const object = commitObject(repo, sha);
        if (!object) return err(404, 'Not Found');
        return ok(200, object);
      }
      return err(404, 'Not Found');
    }

    // /git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const input = (body ?? {}) as Record<string, unknown>;
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!ref.startsWith('refs/') || !isObjectId(sha)) return err(422, 'Invalid ref or sha');
        const object = repo.objects.get(sha);
        if (!object) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return ok(201, { ref, node_id: `R_${Buffer.from(`ref:${repo.owner}/${repo.name}:${ref}`).toString('base64url')}`, url: '', object: { sha, type: object.type, url: '' } });
      }
      if (method === 'GET') {
        const wanted = rest.slice(2).map(decode).join('/');
        if (wanted === '') {
          const list = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => ({
            ref, node_id: '', url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' },
          }));
          return ok(200, list);
        }
        const ref = `refs/${wanted}`;
        const sha = repo.refs.get(ref);
        if (!sha) return err(404, 'Not Found');
        return ok(200, { ref, node_id: '', url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
      }
      return err(404, 'Not Found');
    }

    // /contents/{path...}
    if (rest[0] === 'contents') {
      return handleContents(ctx, repo, method, rest.slice(1).map(decode), query, body);
    }

    // /labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return ok(200, [...repo.labels.values()].map(labelObject));
      }
      if (method === 'POST' && rest.length === 1) {
        const input = (body ?? {}) as Record<string, unknown>;
        const labelName = typeof input.name === 'string' ? input.name : '';
        if (labelName === '') return err(422, 'name is required');
        const color = typeof input.color === 'string' ? input.color : 'ededed';
        const label = ctx.store.createLabel(repo, labelName, color, typeof input.description === 'string' ? input.description : '');
        return ok(201, labelObject(label));
      }
      return err(404, 'Not Found');
    }

    // /issues...
    if (rest[0] === 'issues') {
      return handleIssues(ctx, repo, method, rest.slice(1), query, body);
    }

    // /pulls...
    if (rest[0] === 'pulls') {
      return handlePulls(ctx, repo, method, rest.slice(1), query, body);
    }
  }

  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// contents
// -------------------------------------------------------------------------------------------

function handleContents(
  ctx: RestContext,
  repo: Repo,
  method: string,
  pathParts: string[],
  query: Record<string, string>,
  body: unknown,
): RestResult {
  const path = pathParts.join('/');
  const input = (body ?? {}) as Record<string, unknown>;
  const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
  const refName = query.ref ?? branch;

  if (method === 'GET') {
    const tip = ctx.store.resolveRef(repo, refName);
    if (!tip) return err(404, 'Not Found');
    const flat = ctx.store.flatAt(repo, tip);
    if (path === '') {
      // Root listing.
      const entries = [...flat.keys()].map((filePath) => {
        const top = filePath.split('/')[0];
        return top;
      });
      const unique = [...new Set(entries)].sort();
      return ok(200, unique.map((name) => {
        const isDir = [...flat.keys()].some((filePath) => filePath.startsWith(`${name}/`));
        const oid = isDir ? '' : flat.get(name)?.oid ?? '';
        return { type: isDir ? 'dir' : 'file', name, path: name, sha: oid, size: 0, url: '', html_url: '', git_url: '', download_url: null };
      }));
    }
    const file = flat.get(path);
    if (file) {
      const object = repo.objects.get(file.oid);
      const data = object?.data ?? Buffer.alloc(0);
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop(),
        path,
        content: data.toString('base64'),
        sha: file.oid,
        url: '',
        git_url: '',
        html_url: '',
        download_url: null,
        _links: {},
      });
    }
    // Directory listing.
    const prefix = `${path}/`;
    const entries = new Map<string, { type: string; name: string; path: string; sha: string }>();
    for (const [filePath, entry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const first = rest.split('/')[0];
      if (rest.includes('/')) {
        entries.set(first, { type: 'dir', name: first, path: `${path}/${first}`, sha: '' });
      } else {
        entries.set(first, { type: 'file', name: first, path: filePath, sha: entry.oid });
      }
    }
    if (entries.size === 0) return err(404, 'Not Found');
    return ok(200, [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((entry) => ({
      ...entry,
      size: 0, url: '', html_url: '', git_url: '', download_url: null, _links: {},
    })));
  }

  if (method === 'PUT') {
    const content = typeof input.content === 'string' ? input.content : '';
    if (content === '') return err(422, 'content is required');
    let data: Buffer;
    try {
      data = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return err(422, 'content is not valid base64');
    }
    const message = typeof input.message === 'string' ? input.message : `Update ${path}`;
    // Resolve the branch tip (create the branch from the default tip when missing).
    let tip = ctx.store.resolveRef(repo, branch);
    if (tip === undefined && branch !== repo.defaultBranch) {
      tip = ctx.store.headTip(repo) ?? undefined;
      if (tip !== undefined) repo.refs.set(`refs/heads/${branch}`, tip);
    }
    const flat = tip === undefined ? new Map() : ctx.store.flatAt(repo, tip);
    const existing = flat.get(path);
    const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
    if (existing && givenSha !== undefined && givenSha !== existing.oid) {
      return err(409, 'sha does not match the current file');
    }
    const isCreate = existing === undefined;
    const blobOid = ctx.store.putObject(repo, 'blob', data);
    const next = new Map(flat);
    next.set(path, { mode: '100644', oid: blobOid });
    const sha = ctx.store.makeCommit(repo, branch, next, message, tip ?? null);
    return ok(isCreate ? 201 : 200, {
      content: {
        name: path.split('/').pop(), path, sha: blobOid, size: data.length,
        url: '', html_url: '', git_url: '', download_url: null, type: 'file', encoding: 'base64',
      },
      commit: { sha, node_id: '', url: '', html_url: '', author: null, committer: null, message, tree: { sha: '', url: '' }, parents: [] },
    });
  }

  if (method === 'DELETE') {
    const tip = ctx.store.resolveRef(repo, branch);
    if (!tip) return err(404, 'Not Found');
    const flat = ctx.store.flatAt(repo, tip);
    const existing = flat.get(path);
    if (!existing) return err(404, 'Not Found');
    const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing.oid) return err(409, 'sha does not match the current file');
    const message = typeof input.message === 'string' ? input.message : `Delete ${path}`;
    const next = new Map(flat);
    next.delete(path);
    const sha = ctx.store.makeCommit(repo, branch, next, message, tip);
    return ok(200, {
      commit: { sha, node_id: '', url: '', html_url: '', author: null, committer: null, message, tree: { sha: '', url: '' }, parents: [] },
    });
  }

  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// issues
// -------------------------------------------------------------------------------------------

function handleIssues(
  ctx: RestContext,
  repo: Repo,
  method: string,
  rest: string[],
  query: Record<string, string>,
  body: unknown,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const { page, perPage } = pageOf(query);
      const state = query.state ?? 'open';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      const sort = query.sort ?? 'created';
      const direction = query.direction ?? 'desc';
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { page: items, totalPages } = paginate(issues, page, perPage);
      const headers: Record<string, string> = {};
      if (totalPages > 1) headers.link = linkHeader(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query, page, perPage, totalPages);
      return ok(200, items.map((issue) => issueObject(issue, repo)), headers);
    }
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') return err(422, 'title is required');
      const rawLabels = Array.isArray(input.labels) ? input.labels : [];
      const labelNames = rawLabels.map((label) => (typeof label === 'string' ? label : (label as Record<string, unknown>).name)).filter((name): name is string => typeof name === 'string');
      const created = ctx.store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', labelNames);
      if ('error' in created) return err(422, created.error);
      return ok(201, issueObject(created, repo));
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0], 10);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const issue = ctx.store.getIssue(repo, number);
  if (!issue) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return ok(200, issueObject(issue, repo));
    if (method === 'PATCH') {
      const input = (body ?? {}) as Record<string, unknown>;
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (input.state === 'closed' || input.state === 'open') {
        issue.state = input.state;
        issue.closedAt = input.state === 'closed' ? isoAt(repo.commitSeq + 1000) : null;
      }
      if (Array.isArray(input.labels)) {
        const names = (input.labels as unknown[]).map((label) => (typeof label === 'string' ? label : (label as Record<string, unknown>).name)).filter((name): name is string => typeof name === 'string');
        const labels: Label[] = [];
        let bad = false;
        for (const name of names) {
          const label = repo.labels.get(name);
          if (!label) {
            bad = true;
            break;
          }
          labels.push(label);
        }
        if (bad) return err(422, 'a label does not exist');
        issue.labels = labels;
      }
      issue.updatedAt = isoAt(issue.createdSeq + 1);
      return ok(200, issueObject(issue, repo));
    }
    return err(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      return ok(200, issue.comments.map((comment) => ({
        id: comment.id,
        node_id: comment.nodeId,
        url: '',
        html_url: '',
        body: comment.body,
        user: userObject(comment.userLogin),
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
        author_association: 'OWNER',
        reactions: { url: '', total_count: 0 },
      })));
    }
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const commentBody = typeof input.body === 'string' ? input.body : '';
      if (commentBody === '') return err(422, 'body is required');
      const id = repo.nextCommentId++;
      const comment = {
        id,
        nodeId: `C_${Buffer.from(`comment:${repo.owner}/${repo.name}:${issue.number}:${id}`).toString('base64url')}`,
        body: commentBody,
        userLogin: ctx.viewerLogin,
        createdAt: isoAt(issue.createdSeq + id),
      };
      issue.comments.push(comment);
      return ok(201, {
        id: comment.id,
        node_id: comment.nodeId,
        url: '',
        html_url: '',
        body: comment.body,
        user: userObject(comment.userLogin),
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
        author_association: 'OWNER',
        reactions: { url: '', total_count: 0 },
      });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// pull requests
// -------------------------------------------------------------------------------------------

function handlePulls(
  ctx: RestContext,
  repo: Repo,
  method: string,
  rest: string[],
  query: Record<string, string>,
  body: unknown,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const { page, perPage } = pageOf(query);
      const state = query.state ?? 'open';
      let pulls = [...repo.pulls];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const { page: items, totalPages } = paginate(pulls, page, perPage);
      const headers: Record<string, string> = {};
      if (totalPages > 1) headers.link = linkHeader(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, query, page, perPage, totalPages);
      return ok(200, items.map((pull) => pullObject(pull, repo)), headers);
    }
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') return err(422, 'title is required');
      const head = typeof input.head === 'string' ? input.head : (input.head as Record<string, unknown>)?.ref;
      const base = typeof input.base === 'string' ? input.base : (input.base as Record<string, unknown>)?.ref;
      if (typeof head !== 'string' || typeof base !== 'string') return err(422, 'head and base are required');
      const created = ctx.store.createPull(repo, title, typeof input.body === 'string' ? input.body : '', head, base);
      if ('error' in created) return err(422, created.error);
      return ok(201, pullObject(created, repo));
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0], 10);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const pull = ctx.store.getPull(repo, number);
  if (!pull) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return ok(200, pullObject(pull, repo));
    return err(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const files = ctx.store.pullFiles(repo, pull);
    return ok(200, files.map((file) => ({
      sha: '',
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    })));
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const merged = ctx.store.mergePull(repo, pull);
    if (typeof merged === 'object') {
      if (merged.error === 'conflict') return err(405, 'Merge conflict');
      if (merged.error === 'already-merged') return err(405, 'Pull request already merged');
      return err(404, 'Not Found');
    }
    return ok(200, { sha: merged, merged: true, message: 'Pull request successfully merged' });
  }

  return err(404, 'Not Found');
}

export { diffFlat, hashObject };
