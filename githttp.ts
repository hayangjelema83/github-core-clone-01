// Git smart HTTP: info/refs advertisements, upload-pack (protocol v2 and v0) and
// receive-pack (v0). Speaks the wire the kit's git-client.ts implements.

import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  hashObject,
  isObjectId,
  parseCommit,
  pktDelim,
  pktFlush,
  readPack,
  sidebandPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitcore.ts';
import { objectsToSend, type Repo, type Store } from './store.ts';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

const AGENT = 'forge/1.0';

function refsOf(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  out.push({ oid: headTip ?? ZERO_OID, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const object = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && object?.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match) entry.peeled = match[1];
    }
    out.push(entry);
  }
  return out;
}

function v0Capabilities(service: GitService, repo: Repo): string {
  const caps = [
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'multi_ack_detailed',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    `agent=${AGENT}`,
    'object-format=sha1',
  ];
  if (service === 'git-receive-pack') caps.push('report-status', 'delete-refs');
  return caps.join(' ');
}

/** GET info/refs?service=... — returns {status, contentType, body}. */
export function infoRefs(store: Store, owner: string, name: string, service: GitService, gitProtocol: string | undefined): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  }
  const parts: Buffer[] = [];
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    parts.push(encodePktLine('version 2\n'));
    parts.push(encodePktLine('ls-refs=unborn\n'));
    parts.push(encodePktLine('fetch=shallow filter\n'));
    parts.push(encodePktLine('object-format=sha1\n'));
    parts.push(encodePktLine(`agent=${AGENT}\n`));
    parts.push(pktFlush());
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
  }
  // v0 advertisement, with the # service= preamble.
  parts.push(encodePktLine(`# service=${service}\n`));
  parts.push(pktFlush());
  const caps = v0Capabilities(service, repo);
  const refs = refsOf(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(encodePktLine(line));
      if (ref.peeled) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return {
    status: 200,
    contentType: service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement',
    body: Buffer.concat(parts),
  };
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  thinPack: boolean;
  filter: string | null;
}

function parseFetchLines(lines: string[]): FetchArgs {
  const args: FetchArgs = {
    wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], thinPack: false, filter: null,
  };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) args.depth = Number.parseInt(text.slice(7).trim(), 10);
    else if (text.startsWith('deepen-since ')) args.deepenSince = Number.parseInt(text.slice(13).trim(), 10);
    else if (text.startsWith('deepen-not ')) args.deepenNot.push(text.slice(11).trim());
    else if (text === 'thin-pack') args.thinPack = true;
    else if (text.startsWith('filter ')) args.filter = text.slice(7).trim();
  }
  return args;
}

/** Build the pack and shallow info for a fetch. */
function planFetch(repo: Repo, args: FetchArgs): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const depth = args.depth ?? Infinity;
  const { objects, shallow } = objectsToSend(repo, args.wants, args.haves, depth, args.shallow);
  // A previous shallow boundary is unshallow once a sent commit's parent is that boundary:
  // it is now reachable within the fetched depth.
  const unshallow: string[] = [];
  const sent = new Set(objects.map((object) => hashObject(object.type, object.data)));
  for (const boundary of args.shallow) {
    if (sent.has(boundary)) continue;
    for (const object of objects) {
      if (object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.includes(boundary)) {
        unshallow.push(boundary);
        break;
      }
    }
  }
  return { objects, shallow, unshallow };
}

function v2FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = planFetch(repo, args);
  // Real git (and the protocol) only expects an acknowledgments section when the
  // client sent at least one 'have' line; without haves it goes straight to the
  // packfile section. The kit's client accepts either shape.
  const sections: Buffer[][] = [];
  if (args.haves.length) {
    const ack: Buffer[] = [encodePktLine('acknowledgments\n')];
    const knownHaves = args.haves.filter((have) => repo.objects.has(have));
    if (knownHaves.length) {
      for (const have of knownHaves) ack.push(encodePktLine(`ACK ${have}\n`));
    } else {
      ack.push(encodePktLine('NAK\n'));
    }
    ack.push(encodePktLine('ready\n'));
    sections.push(ack);
  }
  if (shallow.length || unshallow.length) {
    const info: Buffer[] = [encodePktLine('shallow-info\n')];
    for (const oid of shallow) info.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) info.push(encodePktLine(`unshallow ${oid}\n`));
    sections.push(info);
  }
  if (objects.length) {
    sections.push([encodePktLine('packfile\n'), ...sidebandPack(writePack(objects))]);
  }
  const parts: Buffer[] = [];
  sections.forEach((section, index) => {
    if (index > 0) parts.push(pktDelim());
    parts.push(...section);
  });
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const { objects, shallow, unshallow } = planFetch(repo, args);
  const knownHaves = args.haves.filter((have) => repo.objects.has(have));
  if (knownHaves.length) {
    for (const have of knownHaves) parts.push(encodePktLine(`ACK ${have}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (objects.length) parts.push(...sidebandPack(writePack(objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/**
 * POST git-upload-pack. `body` is the raw request bytes; `gitProtocol` is the
 * Git-Protocol header value ('version=2' or undefined).
 */
export function uploadPack(
  store: Store,
  owner: string,
  name: string,
  body: Buffer,
  gitProtocol: string | undefined,
): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  }
  const contentType = 'application/x-git-upload-pack-result';
  const packets = decodePktLines(body);
  if (gitProtocol === 'version=2') {
    // command section until delim, then argument section until flush.
    let command = '';
    const argLines: string[] = [];
    let seenDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        seenDelim = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const text = packet.payload!.toString('utf8');
      if (!seenDelim) {
        if (text.startsWith('command=')) command = text.slice(8).replace(/\n$/, '');
      } else {
        argLines.push(text);
      }
    }
    if (command === 'ls-refs') {
      return { status: 200, contentType, body: v2LsRefs(repo, argLines) };
    }
    if (command === 'fetch') {
      const args = parseFetchLines(argLines);
      return { status: 200, contentType, body: v2FetchResponse(repo, args) };
    }
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: `unknown command ${command}` }) + '\n') };
  }
  // v0: want/have/deepen lines across two sections, then done.
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload!.toString('utf8'));
  }
  const args = parseFetchLines(lines);
  return { status: 200, contentType, body: v0FetchResponse(repo, args) };
}

function v2LsRefs(repo: Repo, argLines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of argLines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice(11));
  }
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (headTip === undefined) {
    if (unborn && keep('HEAD')) {
      parts.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else if (keep('HEAD')) {
    const extra = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    parts.push(encodePktLine(`${headTip} HEAD${extra}\n`));
  }
  for (const ref of refsOf(repo).filter((entry) => entry.name !== 'HEAD')) {
    if (!keep(ref.name)) continue;
    const extra = peel && ref.peeled ? ` peeled:${ref.peeled}` : '';
    parts.push(encodePktLine(`${ref.oid} ${ref.name}${extra}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack. Returns the sideband-framed report-status stream. */
export function receivePack(
  store: Store,
  owner: string,
  name: string,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, name);
  const contentType = 'application/x-git-receive-pack-result';
  if (!repo) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  }
  // Parse command pkt-lines until the first flush; the rest is the pack.
  const commands: PushCommand[] = [];
  let sideband = false;
  let offset = 0;
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = payload.indexOf('\0');
    const commandText = nul >= 0 ? payload.slice(0, nul) : payload;
    const caps = nul >= 0 ? payload.slice(nul + 1) : '';
    if (caps.includes('side-band-64k')) sideband = true;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(commandText.replace(/\n$/, ''));
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
    offset += length;
  }
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of objects) repo.objects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const reportLines: string[] = [];
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const verdict = applyPush(repo, command);
      reportLines.push(verdict === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict}\n`);
    }
  }
  // Frame the report-status stream in band 1 when sideband was negotiated.
  const inner = Buffer.concat([...reportLines.map((line) => encodePktLine(line)), pktFlush()]);
  let out: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let at = 0; at < inner.length; at += CHUNK) {
      const slice = inner.subarray(at, Math.min(inner.length, at + CHUNK));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    parts.push(pktFlush());
    out = Buffer.concat(parts);
  } else {
    out = Buffer.concat([inner, pktFlush()]);
  }
  return { status: 200, contentType, body: out };
}

/** Apply one push command; returns null on success or the ng reason. */
function applyPush(repo: Repo, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return 'remote ref does not exist';
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return 'non-fast-forward';
    repo.refs.delete(command.ref);
    return null;
  }
  const object = repo.objects.get(command.newOid);
  if (!object) return 'object not found';
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return 'already exists';
    repo.refs.set(command.ref, command.newOid);
    return null;
  }
  // Update: old must match, and the new tip must descend from old (branches).
  if (current === undefined) return 'remote ref does not exist';
  if (command.oldOid !== current) return 'non-fast-forward';
  if (command.ref.startsWith('refs/heads/')) {
    const newObject = repo.objects.get(command.newOid);
    if (!newObject || newObject.type !== 'commit') return 'invalid new object';
    if (!isAncestorOf(repo, command.oldOid, command.newOid)) return 'non-fast-forward';
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}

function isAncestorOf(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

export { collectReachable };
