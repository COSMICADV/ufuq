/**
 * Starting a real application and asking it a real question.
 *
 * The Phase 1 exit criterion in DOCUMENT 25 is that an empty application
 * *boots* and switches language and direction. A unit test cannot show that; a
 * process that answers on a socket can. Nothing here needs Docker, because
 * nothing in Phase 1 talks to a database yet.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

/** An unused TCP port, chosen by the operating system. */
export async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForAnswer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt was made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`${url} did not answer within ${timeoutMs}ms (${lastError})`);
}

/**
 * Run `body` against a freshly started process, then stop it. The process is
 * stopped whether the body succeeds or throws, so a failing check never leaves
 * a listener behind.
 */
export async function withServer({ command, args, cwd, env, readyUrl, timeoutMs = 60000 }, body) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const collect = (chunk) => {
    output += String(chunk);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const exitedEarly = once(child, 'exit').then(([code]) => {
    throw new Error(`the process exited early with code ${code}:\n${output.trim()}`);
  });
  exitedEarly.catch(() => undefined);

  try {
    await Promise.race([waitForAnswer(readyUrl, timeoutMs), exitedEarly]);
    return await body();
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(5000)]);
  }
}
