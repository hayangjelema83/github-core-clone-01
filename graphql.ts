// GitHub GraphQL v4 at POST /api/graphql: a hand-rolled executor for the documents
// gh and github-mcp-server send. No GraphQL library; a small lexer/parser for the
// subset used (operations, variables, aliases, inline fragments, input objects,
// enums, lists, batched operation arrays).

import type { Issue, PullRequest, Repo, Store } from './store.ts';

// -------------------------------------------------------------------------------------------
// lexer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      while (i < input.length && /[0-9.eE+-]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: /[.eE]/.test(value) ? 'float' : 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// -------------------------------------------------------------------------------------------
// AST
// -------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selection: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue?: ValueNode }>;
  selection: SelectionNode[];
}

export interface FragmentDefinition {
  kind: 'fragmentDefinition';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
    return token.value;
  }

  parseDocument(): Array<OperationNode | FragmentDefinition> {
    const definitions: Array<OperationNode | FragmentDefinition> = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        definitions.push({ kind: 'operation', operation: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = token.value as 'query' | 'mutation' | 'subscription';
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value as string;
        const variables = this.parseVariableDefinitions();
        definitions.push({ kind: 'operation', operation, name, variables, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        definitions.push({ kind: 'fragmentDefinition', name, typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token in GraphQL document: ${JSON.stringify(token)}`);
      }
    }
    return definitions;
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue?: ValueNode }> {
    const variables: Array<{ name: string; defaultValue?: ValueNode }> = [];
    const token = this.peek();
    if (!(token?.kind === 'punct' && token.value === '(')) return variables;
    this.next();
    for (;;) {
      const next = this.peek();
      if (next?.kind === 'punct' && next.value === ')') {
        this.next();
        return variables;
      }
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.skipType();
      let defaultValue: ValueNode | undefined;
      const eq = this.peek();
      if (eq?.kind === 'punct' && eq.value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      variables.push(defaultValue === undefined ? { name } : { name, defaultValue });
    }
  }

  /** Skip a GraphQL type: Name, [Type], Type! (recursively). */
  private skipType(): void {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      this.skipType();
      this.expectPunct(']');
    } else if (token.kind !== 'name') {
      throw new Error('expected a type in variable definitions');
    }
    const bang = this.peek();
    if (bang?.kind === 'punct' && bang.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.kind === 'spread') {
        this.next();
        const next = this.peek();
        if (next?.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        } else if (next?.kind === 'name') {
          this.next(); // named fragment spread; resolved at execution
          selections.push({ kind: 'fragment', typeCondition: '*', selection: [] });
        } else {
          selections.push({ kind: 'fragment', typeCondition: '*', selection: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push(this.parseField());
    }
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    const next = this.peek();
    if (next?.kind === 'punct' && next.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    const open = this.peek();
    if (open?.kind === 'punct' && open.value === '(') {
      this.next();
      for (;;) {
        const token = this.peek();
        if (token?.kind === 'punct' && token.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selection: SelectionNode[] = [];
    const brace = this.peek();
    if (brace?.kind === 'punct' && brace.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      for (;;) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ']') {
          this.next();
          return { kind: 'list', values };
        }
        values.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === '}') {
          this.next();
          return { kind: 'object', fields };
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// schema (for validation and introspection)
// -------------------------------------------------------------------------------------------

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema', 'search', 'rateLimit', 'user'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'fork', 'stargazerCount', 'watcherCount'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommitSha'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes'],
  Ref: ['name', 'target'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  Node: ['id'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PACKAGE', 'PULL_REQUEST', 'TOPIC', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const TYPE_KIND: Record<string, string> = {
  Query: 'OBJECT',
  Repository: 'OBJECT',
  User: 'OBJECT',
  Issue: 'OBJECT',
  IssueConnection: 'OBJECT',
  PageInfo: 'OBJECT',
  PullRequest: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  Ref: 'OBJECT',
  Mutation: 'OBJECT',
  IssueComment: 'OBJECT',
};

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

export interface GraphQLContext {
  store: Store;
  viewerLogin: string;
}

type AnyObject = Record<string, unknown> & { __typename?: string };

interface ExecState {
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentDefinition>;
}

function fieldError(state: ExecState, message: string): void {
  state.errors.push({ message });
}

/** Validate a selection against the schema; returns the first unknown field, if any. */
function validateSelection(typeName: string, selections: SelectionNode[], state: ExecState): string | null {
  const fields = FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === '*' || selection.typeCondition === typeName) {
        const bad = validateSelection(typeName, selection.selection, state);
        if (bad) return bad;
      }
      continue;
    }
    if (selection.name.startsWith('__')) continue; // __typename etc.
    if (fields !== undefined && !fields.includes(selection.name)) {
      return `Cannot query field "${selection.name}" on type "${typeName}".`;
    }
    // Validate nested selections against the field's return type.
    const childType = childTypeOf(typeName, selection.name);
    if (childType && selection.selection.length) {
      const bad = validateSelection(childType, selection.selection, state);
      if (bad) return bad;
    }
  }
  return null;
}

function childTypeOf(parent: string, field: string): string | null {
  const table: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Node' },
    Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
    IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
    IssueEdge: { node: 'Issue' },
    PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo' },
    PullRequestChangedFileEdge: { node: 'PullRequestChangedFile' },
    PullRequestEdge: { node: 'PullRequest' },
    PullRequest: { files: 'PullRequestChangedFileConnection', author: 'User' },
    Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
    IssueCommentEdge: { node: 'IssueComment' },
    Issue: { author: 'User', repository: 'Repository' },
    Node: {},
  };
  return table[parent]?.[field] ?? null;
}

function executeSelection(
  ctx: GraphQLContext,
  state: ExecState,
  typeName: string,
  object: AnyObject | null,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): AnyObject | null {
  if (object === null || object === undefined) return null;
  const out: AnyObject = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== '*' && selection.typeCondition !== (object.__typename ?? typeName)) continue;
      const merged = executeSelection(ctx, state, typeName, object, selection.selection, variables);
      if (merged) Object.assign(out, merged);
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(ctx, state, typeName, object, selection, variables);
  }
  return out;
}

function cursorOf(issue: Issue): string {
  return Buffer.from(`cursor:${issue.createdSeq}:${issue.number}`).toString('base64');
}

function cursorSeq(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+):\d+$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function resolveField(
  ctx: GraphQLContext,
  state: ExecState,
  typeName: string,
  object: AnyObject,
  field: FieldNode,
  variables: Record<string, unknown>,
): unknown {
  const args = argsOf(field, variables);
  const sel = field.selection;
  const sub = (childType: string, child: AnyObject | null): unknown =>
    sel.length ? executeSelection(ctx, state, childType, child, sel, variables) : child;

  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        return sub('User', { __typename: 'User', login: ctx.viewerLogin });
      }
      if (field.name === 'repository') {
        const owner = args.owner as string;
        const name = args.name as string;
        const repo = typeof owner === 'string' && typeof name === 'string' ? ctx.store.getRepo(owner, name) : undefined;
        if (!repo || owner !== ctx.viewerLogin) return null;
        return sub('Repository', repoObject(ctx, repo));
      }
      if (field.name === 'node') {
        const id = args.id as string;
        const entry = typeof id === 'string' ? ctx.store.globalIds.get(id) : undefined;
        if (!entry) return null;
        const repo = ctx.store.repos.get(entry.repoKey);
        if (!repo) return null;
        if (entry.kind === 'repo') return sub('Repository', repoObject(ctx, repo));
        if (entry.kind === 'issue') {
          const issue = ctx.store.getIssue(repo, entry.number);
          return issue ? sub('Issue', issueObject(ctx, repo, issue)) : null;
        }
        if (entry.kind === 'pull') {
          const pull = ctx.store.getPull(repo, entry.number);
          return pull ? sub('PullRequest', pullObject(ctx, repo, pull)) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = args.name as string;
        if (typeof name !== 'string') return null;
        const fields = FIELDS[name];
        const enums = ENUM_VALUES[name];
        if (!fields && !enums) return null;
        return sub('__Type', {
          __typename: '__Type',
          name,
          kind: TYPE_KIND[name] ?? (enums ? 'ENUM' : 'OBJECT'),
          fields: fields ? fields.map((fieldName) => ({ __typename: '__Field', name: fieldName })) : null,
          enumValues: enums ? enums.map((value) => ({ __typename: '__EnumValue', name: value })) : null,
        });
      }
      if (field.name === '__schema') {
        return sub('__Schema', { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } });
      }
      return null;
    }
    case 'Repository': {
      const repo = object as unknown as Repo;
      if (field.name === 'id') return repo.nodeId;
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return sub('User', { __typename: 'User', login: repo.owner });
      if (field.name === 'defaultBranchRef') {
        return sub('Ref', { __typename: 'Ref', name: repo.defaultBranch });
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'description') return repo.description;
      if (field.name === 'isPrivate') return repo.private;
      if (field.name === 'createdAt') return repo.createdAt;
      if (field.name === 'updatedAt') return repo.updatedAt;
      if (field.name === 'issue') {
        const issue = ctx.store.getIssue(repo, args.number as number);
        return issue ? sub('Issue', issueObject(ctx, repo, issue)) : null;
      }
      if (field.name === 'issues') {
        return sub('IssueConnection', issuesConnection(ctx, repo, args));
      }
      if (field.name === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : 100;
        const pulls = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
        return sub('PullRequestConnection', {
          __typename: 'PullRequestConnection',
          nodes: pulls.map((pull) => pullObject(ctx, repo, pull)),
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: repo.pulls.length,
        });
      }
      if (field.name === 'pullRequest') {
        const pull = ctx.store.getPull(repo, args.number as number);
        return pull ? sub('PullRequest', pullObject(ctx, repo, pull)) : null;
      }
      return null;
    }
    case 'Issue': {
      const issue = object as unknown as Issue;
      if (field.name === 'id') return issue.nodeId;
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state.toUpperCase();
      if (field.name === 'body') return issue.body;
      if (field.name === 'createdAt') return issue.createdAt;
      if (field.name === 'updatedAt') return issue.updatedAt;
      if (field.name === 'closedAt') return issue.closedAt;
      if (field.name === 'author') return sub('User', { __typename: 'User', login: issue.userLogin });
      return null;
    }
    case 'PullRequest': {
      const pull = object as unknown as PullRequest;
      if (field.name === 'id') return pull.nodeId;
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'mergeable') return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'headRefOid') return pull.headSha;
      if (field.name === 'baseRefOid') return pull.baseSha;
      if (field.name === 'mergedAt') return pull.mergedAt;
      if (field.name === 'mergeCommitSha') return pull.mergeCommitSha;
      if (field.name === 'createdAt') return pull.createdAt;
      if (field.name === 'updatedAt') return pull.updatedAt;
      if (field.name === 'files') {
        const repo = repoOfPull(ctx, pull);
        const files = repo ? ctx.store.pullFiles(repo, pull) : [];
        const first = typeof args.first === 'number' ? args.first : 100;
        const nodes = files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, filename: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes }));
        return sub('PullRequestChangedFileConnection', {
          __typename: 'PullRequestChangedFileConnection',
          nodes,
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: files.length,
        });
      }
      return null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      // Nodes were pre-built as plain objects; resolve nested selections on them.
      if (field.name === 'nodes') {
        const nodes = (object.nodes as AnyObject[] | undefined) ?? [];
        const childType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestChangedFileConnection' ? 'PullRequestChangedFile' : 'PullRequest';
        // File nodes carry their own __typename (PullRequestChangedFile); honour it
        // so their fields resolve through the default case instead of PullRequest.
        return nodes.map((node) => sub((node.__typename as string | undefined) ?? childType, node));
      }
      if (field.name === 'pageInfo') {
        return sub('PageInfo', (object.pageInfo as AnyObject) ?? { __typename: 'PageInfo', hasNextPage: false, endCursor: null });
      }
      if (field.name === 'totalCount') return object.totalCount ?? null;
      if (field.name === 'edges') return [];
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return object.hasNextPage ?? false;
      if (field.name === 'hasPreviousPage') return object.hasPreviousPage ?? false;
      if (field.name === 'startCursor') return object.startCursor ?? null;
      if (field.name === 'endCursor') return object.endCursor ?? null;
      return null;
    }
    case 'User': {
      if (field.name === 'login') return object.login ?? null;
      if (field.name === 'id') return object.login ?? null;
      if (field.name === 'name') return object.login ?? null;
      if (field.name === 'email') return null;
      return null;
    }
    case 'Ref': {
      if (field.name === 'name') return object.name ?? null;
      return null;
    }
    case 'Mutation': {
      return resolveMutation(ctx, state, field, args, sel, variables);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return sub('Issue', object.issue as AnyObject);
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return sub('PullRequest', object.pullRequest as AnyObject);
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return sub('IssueCommentEdge', object.commentEdge as AnyObject);
      return null;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return sub('IssueComment', object.node as AnyObject);
      if (field.name === 'cursor') return null;
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return object.id ?? null;
      if (field.name === 'body') return object.body ?? null;
      return null;
    }
    case 'IssueEdge': {
      if (field.name === 'node') return sub('Issue', object.node as AnyObject);
      return null;
    }
    case 'PullRequestEdge': {
      if (field.name === 'node') return sub('PullRequest', object.node as AnyObject);
      return null;
    }
    case '__Type': {
      if (field.name === 'name') return object.name ?? null;
      if (field.name === 'kind') return object.kind ?? 'OBJECT';
      if (field.name === 'fields') {
        const fields = (object.fields as AnyObject[] | null) ?? null;
        return fields === null ? null : fields.map((entry) => sub('__Field', entry));
      }
      if (field.name === 'enumValues') {
        const values = (object.enumValues as AnyObject[] | null) ?? null;
        return values === null ? null : values.map((entry) => sub('__EnumValue', entry));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return object.name ?? null;
      return null;
    }
    default:
      return object[field.name] ?? null;
  }
}

function repoObject(ctx: GraphQLContext, repo: Repo): AnyObject {
  return { __typename: 'Repository', ...repo };
}

function issueObject(ctx: GraphQLContext, repo: Repo, issue: Issue): AnyObject {
  return { __typename: 'Issue', ...issue, repoKey: `${repo.owner}/${repo.name}` };
}

function pullObject(ctx: GraphQLContext, repo: Repo, pull: PullRequest): AnyObject {
  return { __typename: 'PullRequest', ...pull, repoKey: `${repo.owner}/${repo.name}` };
}

function repoOfPull(ctx: GraphQLContext, pull: PullRequest): Repo | undefined {
  const entry = ctx.store.globalIds.get(pull.nodeId);
  return entry ? ctx.store.repos.get(entry.repoKey) : undefined;
}

function issuesConnection(ctx: GraphQLContext, repo: Repo, args: Record<string, unknown>): AnyObject {
  let issues = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  issues.sort((a, b) => {
    if (a.createdSeq !== b.createdSeq) return direction * (a.createdSeq - b.createdSeq);
    return direction * (a.number - b.number);
  });
  const after = typeof args.after === 'string' ? cursorSeq(args.after) : null;
  if (after !== null) {
    issues = issues.filter((issue) => (direction === 1 ? issue.createdSeq > after : issue.createdSeq < after));
  }
  const first = typeof args.first === 'number' ? args.first : 100;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > first;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(ctx, repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      startCursor: page.length ? cursorOf(page[0]) : null,
      endCursor: page.length ? cursorOf(page[page.length - 1]) : null,
    },
    totalCount: issues.length,
  };
}

function resolveMutation(
  ctx: GraphQLContext,
  state: ExecState,
  field: FieldNode,
  args: Record<string, unknown>,
  sel: SelectionNode[],
  variables: Record<string, unknown>,
): unknown {
  const sub = (childType: string, child: AnyObject | null): unknown =>
    sel.length ? executeSelection(ctx, state, childType, child, sel, variables) : child;
  const input = (args.input ?? {}) as Record<string, unknown>;

  if (field.name === 'createIssue') {
    const repoId = input.repositoryId as string;
    const entry = typeof repoId === 'string' ? ctx.store.globalIds.get(repoId) : undefined;
    const repo = entry ? ctx.store.repos.get(entry.repoKey) : undefined;
    if (!repo) {
      fieldError(state, 'repository not found');
      return null;
    }
    const created = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    if ('error' in created) {
      fieldError(state, created.error);
      return null;
    }
    return sub('CreateIssuePayload', { __typename: 'CreateIssuePayload', issue: issueObject(ctx, repo, created) });
  }
  if (field.name === 'closeIssue') {
    const issueId = input.issueId as string;
    const entry = typeof issueId === 'string' ? ctx.store.globalIds.get(issueId) : undefined;
    const repo = entry ? ctx.store.repos.get(entry.repoKey) : undefined;
    const issue = repo && entry ? ctx.store.getIssue(repo, entry.number) : undefined;
    if (!issue || !repo) {
      fieldError(state, 'issue not found');
      return null;
    }
    issue.state = 'closed';
    issue.closedAt = issue.createdAt;
    return sub('CloseIssuePayload', { __typename: 'CloseIssuePayload', issue: issueObject(ctx, repo, issue) });
  }
  if (field.name === 'createPullRequest') {
    const repoId = input.repositoryId as string;
    const entry = typeof repoId === 'string' ? ctx.store.globalIds.get(repoId) : undefined;
    const repo = entry ? ctx.store.repos.get(entry.repoKey) : undefined;
    if (!repo) {
      fieldError(state, 'repository not found');
      return null;
    }
    const created = ctx.store.createPull(
      repo,
      String(input.title ?? ''),
      String(input.body ?? ''),
      String(input.headRefName ?? ''),
      String(input.baseRefName ?? ''),
    );
    if ('error' in created) {
      fieldError(state, created.error);
      return null;
    }
    return sub('CreatePullRequestPayload', { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(ctx, repo, created) });
  }
  if (field.name === 'mergePullRequest') {
    const pullId = input.pullRequestId as string;
    const entry = typeof pullId === 'string' ? ctx.store.globalIds.get(pullId) : undefined;
    const repo = entry ? ctx.store.repos.get(entry.repoKey) : undefined;
    const pull = repo && entry ? ctx.store.getPull(repo, entry.number) : undefined;
    if (!pull || !repo) {
      fieldError(state, 'pull request not found');
      return null;
    }
    const merged = ctx.store.mergePull(repo, pull);
    if (typeof merged === 'object') {
      fieldError(state, merged.error === 'conflict' ? 'merge conflict' : merged.error);
      return null;
    }
    return sub('MergePullRequestPayload', { __typename: 'MergePullRequestPayload', pullRequest: pullObject(ctx, repo, pull) });
  }
  if (field.name === 'addComment') {
    const subjectId = input.subjectId as string;
    const entry = typeof subjectId === 'string' ? ctx.store.globalIds.get(subjectId) : undefined;
    const repo = entry ? ctx.store.repos.get(entry.repoKey) : undefined;
    const issue = repo && entry ? ctx.store.getIssue(repo, entry.number) : undefined;
    if (!issue || !repo) {
      fieldError(state, 'subject not found');
      return null;
    }
    const id = repo.nextCommentId++;
    const comment = {
      id,
      nodeId: `C_${Buffer.from(`comment:${repo.owner}/${repo.name}:${issue.number}:${id}`).toString('base64url')}`,
      body: String(input.body ?? ''),
      userLogin: ctx.viewerLogin,
      createdAt: issue.createdAt,
    };
    issue.comments.push(comment);
    return sub('AddCommentPayload', {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: comment.nodeId, body: comment.body } },
    });
  }
  fieldError(state, `unknown mutation "${field.name}"`);
  return null;
}

// -------------------------------------------------------------------------------------------
// entry point: one operation -> {data, errors}
// -------------------------------------------------------------------------------------------

export function executeGraphQL(
  ctx: GraphQLContext,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: unknown; errors?: Array<{ message: string }> } {
  let definitions: Array<OperationNode | FragmentDefinition>;
  try {
    definitions = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operations = definitions.filter((def): def is OperationNode => def.kind === 'operation');
  const fragments = new Map<string, FragmentDefinition>();
  for (const def of definitions) if (def.kind === 'fragmentDefinition') fragments.set(def.name, def);
  let operation: OperationNode | undefined;
  if (operationName) operation = operations.find((op) => op.name === operationName);
  else if (operations.length === 1) operation = operations[0];
  if (!operation) {
    return { data: null, errors: [{ message: operationName ? `unknown operation "${operationName}"` : 'an operation name is required when several operations are present' }] };
  }
  const state: ExecState = { errors: [], fragments };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  // Apply variable defaults.
  const vars: Record<string, unknown> = { ...variables };
  for (const variable of operation.variables) {
    if (vars[variable.name] === undefined && variable.defaultValue !== undefined) {
      vars[variable.name] = valueOf(variable.defaultValue, vars);
    }
  }
  const bad = validateSelection(rootType, operation.selection, state);
  if (bad) return { data: null, errors: [{ message: bad }] };
  const data = executeSelection(ctx, state, rootType, { __typename: rootType }, operation.selection, vars);
  if (state.errors.length) return { data, errors: state.errors };
  return { data };
}

/** Handle one POST /api/graphql body (object or array of operations). */
export function handleGraphQL(ctx: GraphQLContext, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return executeGraphQL(ctx, String(record.query ?? ''), (record.variables ?? {}) as Record<string, unknown>, record.operationName as string | undefined);
    });
    return { status: 200, body: results };
  }
  const record = (body ?? {}) as Record<string, unknown>;
  if (typeof record.query !== 'string') return { status: 400, body: { message: 'query is required' } };
  return { status: 200, body: executeGraphQL(ctx, record.query, (record.variables ?? {}) as Record<string, unknown>, record.operationName as string | undefined) };
}
