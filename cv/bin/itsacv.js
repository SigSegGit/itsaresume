#!/usr/bin/env node
// itsacv: tailor CVs and fit reports to job offers, from the command line or
// from a local web page.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { complete, TIMEOUT_MS } from '../src/llm.js';
import { loadProfile, tailorOffer, RunError } from '../src/run.js';
import { splitOffers } from '../src/split.js';
import { serve } from '../src/serve.js';

const USAGE = `usage:
  itsacv tailor <offer.txt>... [--split] [--profile FILE] [--out DIR] [--url URL] [--timeout SECONDS] [--no-layout]
  itsacv split <email.txt> [--url URL] [--timeout SECONDS]
  itsacv serve [--port PORT] [--profile FILE] [--out DIR] [--url URL] [--timeout SECONDS] [--no-layout]
               [--public-host NAME [--per-day N] [--per-hour N] [--max-queued N]]

  tailor     one CV and one report per offer file (with --split, per offer
             found in each file: an agency email often holds several)
  split      print the offers found in a file, without tailoring
  serve      the local web page, on http://127.0.0.1:PORT (default 8790)

  --profile  the profile (default: $ITSACV_PROFILE, else ~/.itsaresume/profile.json)
  --out      where to write the run directories (default: ./out)
  --url      itsaresume's HTTP endpoint (default: $ITSARESUME_URL, else http://127.0.0.1:8787)
  --timeout  how long one model answer may take, in seconds (default: $ITSACV_TIMEOUT,
             else ${TIMEOUT_MS / 1000}); must exceed the router backend's timeout_secs, or the
             client gives up on an answer the router is still waiting for
  --no-layout  skip Word: no page fitting, no PDF, no ATS check
  --public-host  serve anyone behind a reverse proxy that answers as NAME (e.g. cv.ngas.fr):
             job offers only, one visitor per page load, the owner's notes hidden, no split,
             an offer already answered reused; at most --per-day CVs a day for everyone
             (default 20), --per-hour per visitor (default 3), --max-queued waiting (default 3)

Each run writes <out>/<timestamp>-<offer>/ with cv.docx, report.md and
analysis.json, and with Word (Windows) cv.pdf, fitted to one full page (two
only when the relevant content alone reaches a page and a half) and checked
for ATS. Word runs through pwsh ($ITSACV_PWSH names another PowerShell).
Exit codes: 0 done; 2 usage, profile or sources error; 3 the model's answer
stayed invalid; 4 itsaresume unreachable or refusing; 5 Word or the PDF check
failed (the CV is written, the report says what was not done); 1 anything
else. With several offers, each runs whatever happened to the others, and
the exit code is the highest.`;

const VALUED = ['--profile', '--out', '--url', '--port', '--timeout', '--public-host', '--per-day', '--per-hour', '--max-queued'];
const FLAGS = { '--no-layout': ['layout', false], '--split': ['split', true] };

function fail(code, message) {
  process.stderr.write(`itsacv: ${message}\n`);
  process.exit(code);
}

function parse(argv) {
  const [command, ...rest] = argv;
  if (!['tailor', 'split', 'serve'].includes(command)) fail(2, `a command is needed\n\n${USAGE}`);
  const options = {
    command,
    files: [],
    profile: process.env.ITSACV_PROFILE ?? join(homedir(), '.itsaresume', 'profile.json'),
    out: 'out',
    url: process.env.ITSARESUME_URL ?? 'http://127.0.0.1:8787',
    port: '8790',
    timeout: process.env.ITSACV_TIMEOUT || String(TIMEOUT_MS / 1000),
    layout: true,
    split: false,
    publicHost: null,
    perDay: '20',
    perHour: '3',
    maxQueued: '3',
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (FLAGS[arg]) options[FLAGS[arg][0]] = FLAGS[arg][1];
    else if (VALUED.includes(arg)) {
      if (rest[i + 1] === undefined) fail(2, `${arg} needs a value\n\n${USAGE}`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = rest[(i += 1)];
    } else if (arg.startsWith('--')) fail(2, `bad option ${arg}\n\n${USAGE}`);
    else options.files.push(arg);
  }
  if (command !== 'serve' && options.files.length === 0) fail(2, `${command} needs a file\n\n${USAGE}`);
  if (command === 'split' && options.files.length !== 1) fail(2, `split takes one file\n\n${USAGE}`);
  if (!/^\d+(\.\d+)?$/.test(options.timeout) || !(Number(options.timeout) > 0)) {
    fail(2, `--timeout (or ITSACV_TIMEOUT) needs a number of seconds above 0, not "${options.timeout}"\n\n${USAGE}`);
  }
  return options;
}

const read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    return fail(2, error.message);
  }
};

async function main() {
  const options = parse(process.argv.slice(2));
  const timeoutMs = Number(options.timeout) * 1000;
  const llm = ({ system, prompt }) => complete({ url: options.url, system, prompt, timeoutMs });

  if (options.command === 'serve') {
    for (const key of ['perDay', 'perHour', 'maxQueued']) {
      if (!/^[1-9]\d*$/.test(options[key])) fail(2, `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: a whole number, 1 or more`);
    }
    if (options.publicHost !== null && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(options.publicHost)) fail(2, '--public-host: a host name, like cv.ngas.fr');
    const publicMode = options.publicHost && { host: options.publicHost, perDay: Number(options.perDay), perVisitorPerHour: Number(options.perHour), maxQueued: Number(options.maxQueued), now: Date.now };
    const server = await serve({ ...options, port: Number(options.port), useWord: options.layout, llm, publicMode });
    const open = publicMode ? `, public as https://${publicMode.host} (at most ${publicMode.perDay} CVs a day)` : '';
    process.stderr.write(`itsacv: serving on http://127.0.0.1:${server.address().port}${open} (Ctrl+C to stop)\n`);
    return;
  }

  if (options.command === 'split') {
    const { offers, repairs } = await splitOffers({ text: read(options.files[0]), llm }).catch((error) => fail(4, error.message));
    for (const repair of repairs) process.stderr.write(`itsacv: ${repair}\n`);
    offers.forEach((offer, index) => process.stdout.write(`--- offer ${index + 1}: ${offer.title}\n${offer.text}\n`));
    return;
  }

  let loaded;
  try {
    loaded = loadProfile(options.profile);
  } catch (error) {
    fail(error.code ?? 2, error.message);
  }
  const offers = [];
  for (const file of options.files) {
    const text = read(file);
    if (!options.split) offers.push(text);
    else {
      const found = await splitOffers({ text, llm }).catch((error) => fail(4, error.message));
      for (const repair of found.repairs) process.stderr.write(`itsacv: ${file}: ${repair}\n`);
      offers.push(...found.offers.map((offer) => offer.text));
    }
  }

  // Each offer runs whatever happened to the ones before it; the exit code
  // says, at the end, the worst that happened to any.
  let worst = 0;
  for (const offer of offers) {
    try {
      const { dir, analysis, attempts, backend, layout, ats, skipped } = await tailorOffer({ loaded, offer, llm, outDir: options.out, useWord: options.layout });
      const pages = layout ? `, ${layout.pages.toFixed(2)} page(s)` : '';
      const atsLine = ats ? `, ATS ${ats.problems.length === 0 ? 'ok' : `${ats.problems.length} problem(s)`}` : '';
      const q = analysis.fit.qualification;
      process.stderr.write(
        `itsacv: fit ${analysis.fit.score}/100 (${analysis.fit.verdict}${q ? `, ${q.level}` : ''}), answered by ${backend} in ${attempts} attempt(s)${pages}${atsLine}\n` +
          `itsacv: written to ${dir}\n`,
      );
      if (skipped?.failed) {
        worst = Math.max(worst, 5);
        process.stderr.write(`itsacv: ${skipped.reason}\n`);
      }
    } catch (error) {
      worst = Math.max(worst, error instanceof RunError ? error.code : 1);
      process.stderr.write(`itsacv: ${error instanceof RunError ? error.message : error.stack ?? error}${error.dir ? `\nitsacv: the rejected answers are in ${error.dir}` : ''}\n`);
    }
  }
  if (worst) process.exit(worst);
}

main();
