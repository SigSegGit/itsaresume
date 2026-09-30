// Word as the layout engine (tools/word.ps1): pages, fill, tagged PDF.
// Windows with Word only; elsewhere `startWord` returns null and the CV is
// written without fitting or PDF, which the report says.
//
// Word can hang (a dialog nobody sees, a file it will not open) or die. Each
// request has its own timeout, after which the helper and everything it
// started are killed; once the helper is gone, every request fails at once
// instead of waiting for an answer that cannot come.

import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../tools/word.ps1', import.meta.url));

/** How long one request (open, paginate, maybe export the PDF) may take. */
export const WORD_TIMEOUT_MS = 180 * 1000;

/** The helper and its children: taskkill /T on Windows, the process group elsewhere. */
function killTree(child) {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * The PowerShell that runs the helper is $ITSACV_PWSH, else pwsh (Windows
 * only). `command` and `args` replace the helper altogether (tests fake it).
 */
export async function startWord({ command, args = [], timeoutMs = WORD_TIMEOUT_MS } = {}) {
  if (!command) {
    const pwsh = process.env.ITSACV_PWSH;
    if (!pwsh && process.platform !== 'win32') return null;
    command = pwsh || 'pwsh';
    args = ['-NoProfile', '-NonInteractive', '-File', SCRIPT];
  }
  let child;
  try {
    child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], detached: process.platform !== 'win32' });
  } catch {
    return null;
  }
  const lines = createInterface({ input: child.stdout });
  const waiting = [];
  lines.on('line', (line) => waiting.shift()?.resolve(line));
  const failed = await new Promise((resolve) => {
    child.once('error', () => resolve(true));
    child.once('spawn', () => resolve(false));
  });
  if (failed) return null;
  /** Why the helper is gone, once it is. */
  let exited = null;
  child.on('exit', (code, signal) => {
    exited ??= `Word stopped (${signal ? `signal ${signal}` : `exit code ${code}`})`;
    for (const pending of waiting.splice(0)) pending.reject(new Error(exited));
  });
  // Writing to a helper that has just died fails here; the exit says why.
  child.stdin.on('error', () => {});

  const ask = (request) =>
    new Promise((resolve, reject) => {
      if (exited) return reject(new Error(exited));
      const timer = setTimeout(() => {
        exited = `Word did not answer within ${timeoutMs / 1000} s, and was stopped`;
        reject(new Error(exited));
        killTree(child);
      }, timeoutMs);
      const settle = (done) => (value) => {
        clearTimeout(timer);
        done(value);
      };
      waiting.push({ resolve: settle(resolve), reject: settle(reject) });
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }).then((line) => {
      const answer = JSON.parse(line);
      if (answer.error) throw new Error(`Word: ${answer.error}`);
      return answer;
    });

  return {
    pid: child.pid,
    /** Length in pages (full pages + fill of the last), optionally a PDF too. */
    async measure(docx, pdf) {
      const answer = await ask(pdf ? { docx, pdf } : { docx });
      return { pages: answer.pages - 1 + answer.fill, raw: answer };
    },
    close() {
      child.stdin.end();
    },
  };
}
