# github-core-clone-01 — a GitHub-compatible git forge

A standalone, single-process GitHub-compatible forge in Node 22 TypeScript (stdlib
only, no dependencies, no git binary, no network beyond serving).

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — `info/refs`, `git-upload-pack`
  (protocol v2 with `ls-refs`/`fetch`, plus a v0 fallback) and `git-receive-pack`
  (v0, `report-status`, `side-band-64k`, `delete-refs`). Packs are read and written
  in-process (SHA-1 objects, OFS/REF deltas, thin packs, shallow/deepen).
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, labels,
  issues, comments and pull requests with squash merges and three-way conflict
  detection. Every reply is JSON with `X-GitHub-Request-Id`.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and `github-mcp-server`
  send (viewer, repository, issues, pull requests, mutations, `node`, `__type`
  introspection, batched operations).
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, modern revision
  `2026-07-28` (`server/discover`) with a legacy `initialize` fallback, and six
  tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store as REST.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind ephemeral port, register, poll
  `/done`, exit 0). Kept as the starter ships it.
- `app.ts` — the HTTP server, routing and auth.
- `store.ts` — the in-memory store: repos, git objects/refs, issues, PRs, labels,
  merge-base/diff/merge logic.
- `gitcore.ts` — git object model, pkt-line codec, packfile read/write, deltas.
- `githttp.ts` — the smart-HTTP handlers.
- `rest.ts` — the REST v3 handlers.
- `graphql.ts` — a hand-rolled GraphQL parser and executor.
- `mcp.ts` — the MCP endpoint and tools.
- `scenario.ts` — the kit's seeded-scenario PRNG ported, so the forge derives the
  token owner's login (`adaiversen`) at runtime instead of hard-coding it.

## Determinism

Server-made commits and timestamps derive from a fixed epoch plus monotonic
counters, never the wall clock, so a live trial and its replay build identical
state. All data lives in memory; nothing is written to disk.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

With no `MAKEFUN_ENV_URL` set the process exits 1 (there is no env to register
with); with no `MAKEFUN_SHOP_TOKEN` set, auth is skipped (local development
only — the trial always sets it).

## Test it locally

Start the forge with a token, then exercise it with `curl` and the system `git`
client (a real `git clone`/`git push` against it must work):

```sh
export MAKEFUN_SHOP_TOKEN=test-token
node --experimental-strip-types main.ts &
# in another shell:
curl -s -H "Authorization: Bearer test-token" http://127.0.0.1:<port>/api/v3/user/repos \
  -X POST -d '{"name":"demo","private":true}'
git clone http://127.0.0.1:<port>/adaiversen/demo.git
```

The kit grades it with:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot <repo> --driver docker
```
