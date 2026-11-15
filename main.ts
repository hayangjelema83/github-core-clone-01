// Entry point for the forge: bring the HTTP server up on a kernel-chosen
// port, tell the trial environment where to find it, then stay alive until
// the environment says the trial is over.
//
// Nothing here serves forge traffic — that lives in app.ts. This file only
// wires the process to the outside world: the env URL, the ephemeral port,
// registration, and the wait for the trial to finish.

import { createApp } from './app.ts';

// How long to wait before retrying a failed env call, and how far that
// wait is allowed to grow. Retries never give up: a transient env hiccup
// must not kill a trial that is otherwise healthy.
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2000;

// How long one /done poll may hang before we treat it as failed.
const DONE_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Next delay in a doubling sequence that starts at FIRST_RETRY_MS and
// never passes MAX_RETRY_MS.
function nextDelay(current: number): number {
  return Math.min(current * 2, MAX_RETRY_MS);
}

// The env's base URL, with any trailing slashes trimmed so the paths we
// append to it never end up with a double slash. Without it there is
// nowhere to register with, so bail out right away.
const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

// Tell the env which port the forge is listening on. A 200 (fresh) or a
// 409 (already known) both mean the env has what it needs. A 400 or 405
// means our request itself is wrong, so retrying would be pointless —
// fail loudly instead. Anything else (a 5xx, a dropped connection, a
// refused socket) is treated as transient and retried forever on the
// doubling backoff above.
async function register(port: number): Promise<void> {
  let delay = FIRST_RETRY_MS;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch {
      await sleep(delay);
      delay = nextDelay(delay);
      continue;
    }
    if (res.status === 200 || res.status === 409) return;
    if (res.status === 400 || res.status === 405) {
      throw new Error(`register rejected with HTTP ${res.status}`);
    }
    await sleep(delay);
    delay = nextDelay(delay);
  }
}

// Keep asking the env whether the trial is finished. A poll that answers
// { done: true } ends the wait; an answer of { done: false } means "not
// yet", so we ask again shortly after, with the backoff reset because the
// env is answering fine. A poll that times out, fails to connect, comes
// back with a bad status, or carries an unreadable body is retried on the
// doubling backoff — the process must never exit while the trial is
// still running.
async function waitForDone(): Promise<void> {
  let delay = FIRST_RETRY_MS;
  for (;;) {
    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DONE_TIMEOUT_MS);
      try {
        res = await fetch(`${envUrl}/done`, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      await sleep(delay);
      delay = nextDelay(delay);
      continue;
    }
    if (!res.ok) {
      await sleep(delay);
      delay = nextDelay(delay);
      continue;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      await sleep(delay);
      delay = nextDelay(delay);
      continue;
    }
    if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) {
      return;
    }
    delay = FIRST_RETRY_MS;
    await sleep(delay);
  }
}

// Boot the forge on an ephemeral port (0 lets the kernel pick one —
// never 8080, where the env itself listens), register that port, then
// wait for the trial to finish. When the env says done, shut the server
// down cleanly and leave with 0.
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('server is not listening on a port');
  }
  await register(address.port);
  await waitForDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
