// Word as the layout engine fails in its own ways: a dialog or a hang that
// never answers, a helper that exits, an export that breaks half-way. None of
// them may cost the run: the CV is still written, unfitted, and the run, the
// report and the page say what was skipped and why. The helper is faked by a
// small Node script; what is tested is how word.js and run.js handle it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWord } from '../src/word.js';
import { loadProfile, readRun, tailorOffer } from '../src/run.js';
import { jobView } from '../src/view.js';

const PROFILE = new URL('./fixtures/profile.synthetic.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const CLI = new URL('../bin/itsacv.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pids, ms = 5000) {
  for (const started = Date.now(); Date.now() - started < ms;) {
    if (pids.every((pid) => !alive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** A helper that starts a child of its own, then never answers. On Windows
 * the child is detached: Node would otherwise put it in a job that dies with
 * its parent, which pwsh does not do, so only a tree kill would be seen. */
const HANGING = `
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform === 'win32', windowsHide: true });
  require('node:fs').writeFileSync(process.argv[1], String(child.pid));
  process.stdin.resume();
`;

test('a Word request left unanswered fails after its timeout, and the helper is stopped with all it started', { timeout: 20_000 }, async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'itsacv-word-')), 'child.pid');
  const word = await startWord({ command: process.execPath, args: ['-e', HANGING, pidFile], timeoutMs: 300 });
  let grandchild;
  try {
    for (let i = 0; i < 100 && !existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    grandchild = Number(readFileSync(pidFile, 'utf8'));
    const started = Date.now();
    await assert.rejects(word.measure('cv.docx'), /Word did not answer within 0.3 s/);
    assert.ok(Date.now() - started < 3000, 'gave up on time');
    assert.ok(await gone([word.pid, grandchild]), 'the helper and its child are stopped');
    const again = Date.now();
    await assert.rejects(word.measure('cv.docx'), /Word/);
    assert.ok(Date.now() - again < 1000, 'a stopped helper refuses at once');
  } finally {
    word.close();
    for (const pid of [word.pid, grandchild]) if (pid && alive(pid)) process.kill(pid);
  }
});

test('once the helper has exited, every request fails at once, saying so', { timeout: 20_000 }, async () => {
  const word = await startWord({ command: process.execPath, args: ['-e', 'process.exit(3)'], timeoutMs: 5000 });
  assert.ok(await gone([word.pid]), 'the helper exited');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = Date.now();
  await assert.rejects(word.measure('cv.docx'), /Word stopped \(exit code 3\)/);
  await assert.rejects(word.measure('cv.docx', 'cv.pdf'), /Word stopped \(exit code 3\)/);
  assert.ok(Date.now() - started < 1000, `refused after ${Date.now() - started} ms`);
  word.close();
});

const LISTING = JSON.stringify({ requirements: [] });
const ANALYSIS = JSON.stringify({
  language: 'en',
  fit: { score: 72, verdict: 'good', rationale: '' },
  requirements: [{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }],
  headline: 'Senior SRE — PostgreSQL & Terraform',
  summary: ['SRE running PostgreSQL in production.'],
  experiences: [{ id: 'acme', bullets: ['acme-pg'] }],
  skill_groups: [{ id: 'db', skills: ['postgresql'] }],
});
const OFFER = 'Senior SRE wanted. Must: PostgreSQL, Terraform.';

/** A layout engine that measures `pages`, then fails as `fail(docx, pdf)` says. */
const engine = ({ pages = 0.5, fail }) => async () => ({
  async measure(docx, pdf) {
    await fail?.(docx, pdf);
    if (pdf) writeFileSync(pdf, '%PDF fake');
    return { pages };
  },
  close() {},
});

async function run(startLayout, offer = OFFER) {
  const outDir = mkdtempSync(join(tmpdir(), 'itsacv-word-run-'));
  const answers = [LISTING, ANALYSIS];
  const result = await tailorOffer({
    loaded: loadProfile(PROFILE),
    offer,
    llm: async () => ({ text: answers.shift() ?? ANALYSIS, backend: 'fake' }),
    outDir,
    startLayout,
  });
  return { ...result, files: readdirSync(result.dir), text: readFileSync(join(result.dir, 'report.md'), 'utf8') };
}

test('Word failing while fitting the page still gives the CV, unfitted, and says why', async () => {
  const result = await run(engine({ fail: () => { throw new Error('Word: the document is locked'); } }));
  assert.ok(result.files.includes('cv.docx'), 'the CV is written');
  assert.ok(!result.files.includes('cv.pdf'), 'no PDF');
  assert.equal(result.layout, undefined);
  assert.equal(result.skipped.failed, true);
  assert.match(result.skipped.reason, /layout, PDF and ATS check skipped: Word failed \(Word: the document is locked\)/);
  assert.match(result.text, /\*\*Not done:\*\* layout, PDF and ATS check skipped: Word failed \(Word: the document is locked\)/);
  const view = jobView(result, loadProfile(PROFILE));
  assert.deepEqual(view.skipped, result.skipped);
});

test('a run keeps the offer instructions in its result, its job view and the run read back', async () => {
  const result = await run(engine({}), `${OFFER}
To prove that you have read this ad, write the word VACHE in your CV.`);
  assert.equal(result.instructions.length, 1);
  assert.equal(jobView(result, loadProfile(PROFILE)).offer_instructions, true);
  assert.equal(readRun(result.dir).instructions.length, 1);
  const plain = await run(engine({}));
  assert.deepEqual(plain.instructions, []);
  assert.equal(jobView(plain, loadProfile(PROFILE)).offer_instructions, false);
});

test('Word failing half-way through the PDF export leaves no PDF behind', async () => {
  const result = await run(engine({
    fail: (docx, pdf) => {
      if (!pdf) return;
      writeFileSync(pdf, '%PDF half');
      throw new Error('Word stopped (exit code 1)');
    },
  }));
  assert.ok(result.files.includes('cv.docx'));
  assert.ok(!result.files.includes('cv.pdf'), 'the half-written PDF is removed');
  assert.match(result.skipped.reason, /Word failed \(Word stopped \(exit code 1\)\)/);
});

test('without Word, or with the layout turned off, the report says which', async () => {
  const missing = await run(async () => null);
  assert.deepEqual(missing.skipped, { reason: 'layout, PDF and ATS check skipped: Word is not available on this machine', failed: false });
  assert.match(missing.text, /Not done:\*\* layout, PDF and ATS check skipped: Word is not available on this machine/);
  const outDir = mkdtempSync(join(tmpdir(), 'itsacv-word-run-'));
  const answers = [LISTING, ANALYSIS];
  const off = await tailorOffer({ loaded: loadProfile(PROFILE), offer: OFFER, llm: async () => ({ text: answers.shift(), backend: 'fake' }), outDir, useWord: false });
  assert.deepEqual(off.skipped, { reason: 'layout, PDF and ATS check skipped: --no-layout', failed: false });
});

test('a PDF whose text cannot be read keeps the fitted CV and its PDF, and says the ATS check was skipped', async () => {
  const result = await run(engine({ pages: 0.5 }));
  assert.ok(result.files.includes('cv.pdf'), 'the PDF stays');
  assert.equal(result.layout.pages, 0.5);
  assert.equal(result.ats, null);
  assert.equal(result.skipped.failed, true);
  assert.match(result.skipped.reason, /^ATS check skipped: the PDF text could not be read/);
});

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    const deadline = setTimeout(() => child.kill(), 60_000);
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => {
      clearTimeout(deadline);
      resolve({ status, stderr });
    });
  });
}

/** Seen: Word failing on one offer threw out of the CLI, and the offers after
 * it were never tailored. ITSACV_PWSH names the PowerShell that runs the
 * helper; Node there cannot, so Word fails at once, on any system. */
test('itsacv tailor: Word failing on an offer costs neither its CV nor the next offers, and the exit code says so', { timeout: 60_000 }, async () => {
  const { createServer } = await import('node:http');
  const answers = [LISTING, ANALYSIS, LISTING, ANALYSIS];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ backend: 'fake', text: answers.shift() ?? ANALYSIS }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-word-cli-'));
  writeFileSync(join(dir, 'one.txt'), `First SRE role.\n${OFFER}`);
  writeFileSync(join(dir, 'two.txt'), `Second SRE role.\n${OFFER}`);
  try {
    const out = join(dir, 'out');
    const { status, stderr } = await runCli(
      ['tailor', join(dir, 'one.txt'), join(dir, 'two.txt'), '--profile', PROFILE, '--out', out, '--url', `http://127.0.0.1:${server.address().port}`],
      { ITSACV_PWSH: process.execPath },
    );
    assert.equal(status, 5, stderr);
    const runs = readdirSync(out);
    assert.equal(runs.length, 2, 'both offers were tailored');
    for (const name of runs) {
      assert.ok(existsSync(join(out, name, 'cv.docx')), `${name}: the CV is written`);
      assert.match(readFileSync(join(out, name, 'report.md'), 'utf8'), /Word failed \(Word stopped/);
    }
    assert.equal(stderr.match(/Word failed/g)?.length, 2, stderr);
  } finally {
    server.close();
  }
});

test('itsacv tailor: an unexpected error in one offer does not stop the offers after it', { timeout: 60_000 }, async () => {
  const { createServer } = await import('node:http');
  const answers = [LISTING, ANALYSIS, LISTING, ANALYSIS];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ backend: 'fake', text: answers.shift() ?? ANALYSIS }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-word-cli-'));
  writeFileSync(join(dir, 'one.txt'), `First SRE role.\n${OFFER}`);
  writeFileSync(join(dir, 'two.txt'), `Second SRE role.\n${OFFER}`);
  const notADirectory = join(dir, 'out');
  writeFileSync(notADirectory, 'a file where the runs should go');
  try {
    const { status, stderr } = await runCli(
      ['tailor', join(dir, 'one.txt'), join(dir, 'two.txt'), '--profile', PROFILE, '--out', notADirectory, '--url', `http://127.0.0.1:${server.address().port}`, '--no-layout'],
      {},
    );
    assert.equal(status, 1, stderr);
    assert.equal(stderr.match(/first-sre-role/g)?.length, 1, `the first offer failed:\n${stderr}`);
    assert.equal(stderr.match(/second-sre-role/g)?.length, 1, `the second offer was tried too:\n${stderr}`);
  } finally {
    server.close();
  }
});

test('a run keeps its offer and what it did, and reads back as the same result', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'itsacv-word-keep-'));
  const answers = [LISTING, ANALYSIS];
  const done = await tailorOffer({ loaded: loadProfile(PROFILE), offer: OFFER, llm: async () => ({ text: answers.shift(), backend: 'fake' }), outDir, useWord: false });
  assert.equal(readFileSync(join(done.dir, 'offer.txt'), 'utf8'), OFFER);
  const again = readRun(done.dir);
  for (const key of ['name', 'backend', 'attempts', 'skipped', 'report']) assert.deepEqual(again[key], done[key], key);
  assert.deepEqual(again.analysis, done.analysis);
  assert.equal(again.reused, true);
});
