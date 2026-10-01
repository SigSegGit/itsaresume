// LibreOffice as the layout engine where Word is absent (ADR-11: the Linux
// VM): the docx converted to PDF headless, its length read from the PDF
// (tools/pdfmeasure.py). Same interface as word.js: `measure(docx, pdf?)`
// gives `{pages}` (full pages plus the fill of the last), `close()`.
// Trusted only once measured against Word on the corpus (HANDOVER 3.1).

import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIBRE_TIMEOUT_MS = 180 * 1000;

const MEASURE = fileURLToPath(new URL('../tools/pdfmeasure.py', import.meta.url));

/** Run `[command, ...args]`, stdout as text, killed past `timeoutMs`. */
function run([command, ...args], timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      reject(new Error(`${basename(command)} did not finish within ${timeoutMs / 1000} s, and was stopped`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${basename(command)} exited ${code}: ${err.trim().split(/\r?\n/).at(-1) ?? ''}`));
    });
  });
}

/** Whether `[command, ...args, '--version']` runs at all. */
function available([command, ...args]) {
  return new Promise((resolve) => execFile(command, [...args, '--version'], { timeout: 30_000 }, (error) => resolve(!error)));
}

/**
 * `soffice` and `reader` are commands as arrays ($ITSACV_SOFFICE, else
 * `soffice`; $ITSACV_PYTHON, else `python3`, running tools/pdfmeasure.py);
 * tests fake both. Null when LibreOffice is not there.
 */
export async function startLibre({ soffice, reader, timeoutMs = LIBRE_TIMEOUT_MS } = {}) {
  soffice ??= [process.env.ITSACV_SOFFICE || 'soffice'];
  reader ??= [process.env.ITSACV_PYTHON || 'python3', MEASURE];
  if (!(await available(soffice))) return null;
  // One profile directory per engine: two conversions at once do not share
  // LibreOffice's user profile (it locks it).
  const work = mkdtempSync(join(tmpdir(), 'itsacv-libre-'));
  const profile = `-env:UserInstallation=file:///${join(work, 'profile').replace(/\\/g, '/').replace(/^\//, '')}`;
  return {
    async measure(docx, pdf) {
      const out = mkdtempSync(join(work, 'out-'));
      try {
        await run([...soffice, profile, '--headless', '--convert-to', 'pdf', '--outdir', out, docx], timeoutMs);
        const made = join(out, basename(docx).replace(/\.docx$/i, '.pdf'));
        if (!existsSync(made)) throw new Error('LibreOffice wrote no PDF');
        const answer = JSON.parse(await run([...reader, made], timeoutMs));
        if (!Number.isInteger(answer.pages) || answer.pages < 1 || !(answer.fill >= 0 && answer.fill <= 1)) {
          throw new Error(`the PDF reader answered ${JSON.stringify(answer)}`);
        }
        if (pdf) copyFileSync(made, pdf);
        return { pages: answer.pages - 1 + answer.fill, raw: answer };
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    close() {
      rmSync(work, { recursive: true, force: true });
    },
  };
}
