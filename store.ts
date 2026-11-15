// The forge's in-memory store: repositories, git objects and refs, issues, pull
// requests, labels and comments. Everything is deterministic: server-made commits and
// timestamps derive from a fixed epoch plus monotonic counters, never the wall clock,
// so a live run and its replay build identical state.

import {
  buildCommit,
  buildTreesFromFlat,
  collectReachable,
  flattenTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTree,
  ZERO_OID,
  type FlatFile,
  type GitObject,
  type GitObjectType,
} from './gitcore.ts';
import { serverIdentity, viewerUser } from './scenario.ts';

export const FIXED_EPOCH = 1700000000;

export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function repoGlobalId(owner: string, name: string): string {
  return `R_${b64url(`repo:${owner}/${name}`)}`;
}

export function issueGlobalId(owner: string, repo: string, number: number): string {
  return `I_${b64url(`issue:${owner}/${repo}:${number}`)}`;
}

export function pullGlobalId(owner: string, repo: string, number: number): string {
  return `PR_${b64url(`pr:${owner}/${repo}:${number}`)}`;
}

export function commentGlobalId(owner: string, repo: string, issueNumber: number, id: number): string {
  return `C_${b64url(`comment:${owner}/${repo}:${issueNumber}:${id}`)}`;
}

export function isoAt(seq: number): string {
  return new Date((FIXED_EPOCH + seq) * 1000).toISOString();
}

export interface Label {
  id: number;
  nodeId: string;
  name: string;
  color: string;
  description: string;
  url: string;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface IssueComment {
  id: number;
  nodeId: string;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  userLogin: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  nodeId: string;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextNumber: number;
  nextCommentId: number;
  nextLabelId: number;
  commitSeq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextSeq = 1;
  /** global id -> {kind, repoKey, number} for node() lookups */
  readonly globalIds = new Map<string, { kind: 'repo' | 'issue' | 'pull' | 'comment'; repoKey: string; number: number }>();

  private seq(): number {
    return this.nextSeq++;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string }): Repo | { error: string } {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return { error: 'already exists' };
    const seq = this.seq();
    const repo: Repo = {
      id: this.nextRepoId++,
      nodeId: repoGlobalId(owner, name),
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdSeq: seq,
      createdAt: isoAt(seq),
      updatedAt: isoAt(seq),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
      commitSeq: 0,
    };
    this.repos.set(key, repo);
    this.globalIds.set(repo.nodeId, { kind: 'repo', repoKey: key, number: 0 });
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.key(owner, name);
    const repo = this.repos.get(key);
    if (!repo) return false;
    this.repos.delete(key);
    this.globalIds.delete(repo.nodeId);
    for (const issue of repo.issues) this.globalIds.delete(issue.nodeId);
    for (const pull of repo.pulls) this.globalIds.delete(pull.nodeId);
    return true;
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // git objects and refs
  // -------------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  headTip(repo: Repo): string | undefined {
    return repo.refs.get(this.headRef(repo));
  }

  /** Resolve a ref name, branch name or commit oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      return object && object.type === 'commit' ? ref : undefined;
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag) {
      const object = repo.objects.get(tag);
      if (object?.type === 'tag') {
        const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
        if (match) return match[1];
      }
      return tag;
    }
    return undefined;
  }

  /** Is `ancestor` an ancestor of (or equal to) `tip`? */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The merge base of two commits: the common ancestor closest to both tips. */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const distA = new Map<string, number>();
    const queueA: Array<[string, number]> = [[a, 0]];
    while (queueA.length) {
      const [oid, dist] = queueA.shift()!;
      if (distA.has(oid)) continue;
      distA.set(oid, dist);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push([parent, dist + 1]);
    }
    const distB = new Map<string, number>();
    const queueB: Array<[string, number]> = [[b, 0]];
    let best: string | undefined;
    let bestScore = Infinity;
    while (queueB.length) {
      const [oid, dist] = queueB.shift()!;
      if (distB.has(oid)) continue;
      distB.set(oid, dist);
      const da = distA.get(oid);
      if (da !== undefined) {
        const score = da + dist;
        if (score < bestScore) {
          bestScore = score;
          best = oid;
        }
      }
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push([parent, dist + 1]);
    }
    return best;
  }

  /** Flat file map at a commit (empty when the commit does not exist). */
  flatAt(repo: Repo, commitOid: string): Map<string, FlatFile> {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return new Map();
    return flattenTree((oid) => repo.objects.get(oid), parseCommit(object.data).tree);
  }

  /**
   * Create a commit on `branch` (creating the branch from the default tip when it does
   * not exist yet) whose tree is `flat` at `parent` (null for the first commit).
   */
  makeCommit(
    repo: Repo,
    branch: string,
    flat: ReadonlyMap<string, FlatFile>,
    message: string,
    parent: string | null,
  ): string {
    const { rootOid, trees } = buildTreesFromFlat(flat);
    for (const tree of trees) this.putObject(repo, 'tree', tree.data);
    const identity = serverIdentity();
    const who = `${identity.name} <${identity.email}>`;
    const timestamp = FIXED_EPOCH + repo.commitSeq++;
    const data = buildCommit({
      tree: rootOid,
      parents: parent === null ? [] : [parent],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: who,
      committer: who,
      timestamp,
    });
    const oid = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** Commits reachable from `tip`, newest first (BFS order). */
  listCommits(repo: Repo, tip: string, limit = 100): Array<{ sha: string; message: string; author: string; committer: string; timestamp: number }> {
    const out: Array<{ sha: string; message: string; author: string; committer: string; timestamp: number }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length && out.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      const author = parseIdentityLine(commit.author);
      out.push({
        sha: oid,
        message: commit.message,
        author: commit.author,
        committer: commit.committer,
        timestamp: author.timestamp,
      });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // issues / pulls / labels / comments
  // -------------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string, description = ''): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = {
      id: repo.nextLabelId++,
      nodeId: `L_${b64url(`label:${repo.owner}/${repo.name}:${name}`)}`,
      name,
      color: color || 'ededed',
      description,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: `Label "${name}" does not exist` };
      labels.push(label);
    }
    const seq = this.seq();
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: this.nextIssueId++,
      nodeId: issueGlobalId(repo.owner, repo.name, number),
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      userLogin: viewerUser().login,
      createdSeq: seq,
      createdAt: isoAt(seq),
      updatedAt: isoAt(seq),
      closedAt: null,
      comments: [],
    };
    repo.issues.push(issue);
    this.globalIds.set(issue.nodeId, { kind: 'issue', repoKey: this.key(repo.owner, repo.name), number });
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | { error: string } {
    const headSha = this.resolveRef(repo, headRef);
    if (!headSha) return { error: `head ref "${headRef}" not found` };
    const baseSha = this.resolveRef(repo, baseRef);
    if (!baseSha) return { error: `base ref "${baseRef}" not found` };
    const seq = this.seq();
    const number = repo.nextNumber++;
    const pull: PullRequest = {
      id: this.nextPullId++,
      nodeId: pullGlobalId(repo.owner, repo.name, number),
      number,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergeable: this.computeMergeable(repo, headSha, baseSha),
      mergeCommitSha: null,
      mergedAt: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      userLogin: viewerUser().login,
      createdSeq: seq,
      createdAt: isoAt(seq),
      updatedAt: isoAt(seq),
    };
    repo.pulls.push(pull);
    this.globalIds.set(pull.nodeId, { kind: 'pull', repoKey: this.key(repo.owner, repo.name), number });
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Files changed between the merge base and the head tip. */
  pullFiles(repo: Repo, pull: PullRequest): PullFile[] {
    const base = this.mergeBase(repo, pull.headSha, pull.baseSha) ?? pull.baseSha;
    const baseFlat = this.flatAt(repo, base);
    const headFlat = this.flatAt(repo, pull.headSha);
    return diffFlat(repo, baseFlat, headFlat);
  }

  /** Three-way conflict: a path changed on both sides of the merge base to different content. */
  /** The current tip of a PR's base branch (it may have moved since the PR was opened). */
  currentBaseSha(repo: Repo, pull: PullRequest): string {
    return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  }

  hasMergeConflict(repo: Repo, pull: PullRequest): boolean {
    const baseTip = this.currentBaseSha(repo, pull);
    const base = this.mergeBase(repo, pull.headSha, baseTip);
    if (!base) return false;
    const baseFlat = this.flatAt(repo, base);
    const headFlat = this.flatAt(repo, pull.headSha);
    const tipFlat = this.flatAt(repo, baseTip);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path)?.oid;
      const h = headFlat.get(path)?.oid;
      const t = tipFlat.get(path)?.oid;
      const headChanged = h !== b;
      const tipChanged = t !== b;
      if (headChanged && tipChanged && h !== t) return true;
    }
    return false;
  }

  computeMergeable(repo: Repo, headSha: string, baseSha: string): boolean {
    const probe: PullRequest = {
      id: 0, nodeId: '', number: 0, title: '', body: '', state: 'open', merged: false,
      mergeable: true, mergeCommitSha: null, mergedAt: null, headRef: '', headSha,
      baseRef: '', baseSha, userLogin: '', createdSeq: 0, createdAt: '', updatedAt: '',
    };
    return !this.hasMergeConflict(repo, probe);
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit sha,
   * or an error string ('conflict' | 'unknown' | 'already-merged').
   */
  mergePull(repo: Repo, pull: PullRequest): string | { error: string } {
    if (pull.merged || pull.state === 'closed') return { error: 'already-merged' };
    if (this.hasMergeConflict(repo, pull)) return { error: 'conflict' };
    const baseTip = this.currentBaseSha(repo, pull);
    const base = this.mergeBase(repo, pull.headSha, baseTip) ?? baseTip;
    const baseFlat = this.flatAt(repo, base);
    const headFlat = this.flatAt(repo, pull.headSha);
    const tipFlat = this.flatAt(repo, baseTip);
    const merged = new Map<string, FlatFile>(tipFlat);
    for (const [path, file] of headFlat) {
      if (baseFlat.get(path)?.oid !== file.oid) merged.set(path, file);
    }
    for (const path of baseFlat.keys()) {
      if (!headFlat.has(path) && baseFlat.get(path)?.oid !== tipFlat.get(path)?.oid) {
        // deleted on head, unchanged on base side
        if (tipFlat.get(path)?.oid === baseFlat.get(path)?.oid) merged.delete(path);
      }
    }
    const identity = serverIdentity();
    const who = `${identity.name} <${identity.email}>`;
    const { rootOid, trees } = buildTreesFromFlat(merged);
    for (const tree of trees) this.putObject(repo, 'tree', tree.data);
    const timestamp = FIXED_EPOCH + repo.commitSeq++;
    const message = `${pull.title} (#${pull.number})\n`;
    const data = buildCommit({
      tree: rootOid,
      parents: [baseTip],
      message,
      author: who,
      committer: who,
      timestamp,
    });
    const sha = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedAt = isoAt(this.seq());
    pull.mergeable = true;
    return sha;
  }
}

function parseIdentityLine(line: string): { timestamp: number } {
  const match = / (\d+) [+-]\d{4}$/.exec(line);
  return { timestamp: match ? Number(match[1]) : FIXED_EPOCH };
}

/** Diff two flat maps into GitHub pull-file entries. */
export function diffFlat(repo: Repo, before: ReadonlyMap<string, FlatFile>, after: ReadonlyMap<string, FlatFile>): PullFile[] {
  const files: PullFile[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const b = before.get(path);
    const a = after.get(path);
    if (b && !a) {
      const deletions = countLines(repo, b.oid);
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && a) {
      const additions = countLines(repo, a.oid);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && a && b.oid !== a.oid) {
      const addLines = countLines(repo, a.oid);
      const delLines = countLines(repo, b.oid);
      files.push({ filename: path, status: 'modified', additions: addLines, deletions: delLines, changes: addLines + delLines });
    }
  }
  return files;
}

function countLines(repo: Repo, oid: string): number {
  const object = repo.objects.get(oid);
  if (!object) return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** All objects reachable from `tips`, minus objects reachable from `excludeTips`. */
export function objectsToSend(
  repo: Repo,
  tips: Iterable<string>,
  excludeTips: Iterable<string>,
  depth: number,
  shallowBoundaries: Iterable<string> = [],
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const shallowSet = new Set(shallowBoundaries);
  const haveSet = new Set(excludeTips);
  // Objects the client already holds: the full closure of each non-shallow have,
  // and (for a shallow boundary) the boundary commit itself plus its tree — the
  // client has the boundary but NOT its parents, so traversal continues past it.
  const excluded = new Set<string>();
  for (const tip of excludeTips) {
    if (shallowSet.has(tip)) {
      excluded.add(tip);
      const object = repo.objects.get(tip);
      if (object?.type === 'commit') {
        for (const oid of collectReachable([parseCommit(object.data).tree], (o) => repo.objects.get(o))) excluded.add(oid);
      }
    } else {
      for (const oid of collectReachable([tip], (o) => repo.objects.get(o))) excluded.add(oid);
    }
  }
  // BFS over commits by generation from the want tips. Annotated tag tips are
  // sent themselves and traversed to their target at the same generation.
  const commitGen = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const tip of tips) queue.push([tip, 0]);
  const sendCommits: string[] = [];
  const sendTags: string[] = [];
  while (queue.length) {
    const [oid, gen] = queue.shift()!;
    if (gen >= depth) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      if (excluded.has(oid) || sendTags.includes(oid)) continue;
      sendTags.push(oid);
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match) queue.push([match[1], gen]);
      continue;
    }
    if (object.type !== 'commit') continue;
    if (commitGen.has(oid)) continue;
    commitGen.set(oid, gen);
    // A full have is held with its whole history: never sent, never traversed.
    if (haveSet.has(oid) && !shallowSet.has(oid)) continue;
    // A shallow boundary is held itself, but its parents are not: traverse past it.
    if (!haveSet.has(oid)) sendCommits.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push([parent, gen + 1]);
  }
  const shallow = sendCommits.filter((oid) => commitGen.get(oid) === depth - 1);
  const objects = new Map<string, GitObject>();
  for (const oid of sendCommits) {
    const object = repo.objects.get(oid);
    if (object && !excluded.has(oid)) objects.set(oid, object);
    const treeOid = object ? parseCommit(object.data).tree : '';
    for (const reachable of collectReachable([treeOid], (o) => repo.objects.get(o))) {
      if (excluded.has(reachable)) continue;
      const entry = repo.objects.get(reachable);
      if (entry) objects.set(reachable, entry);
    }
  }
  for (const oid of sendTags) {
    const object = repo.objects.get(oid);
    if (object && !excluded.has(oid)) objects.set(oid, object);
  }
  return { objects: [...objects.values()], shallow, unshallow: [] };
}

export { parseTree, ZERO_OID };
