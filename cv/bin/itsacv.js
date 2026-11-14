#!/usr/bin/env node
// itsacv: tailor CVs and fit reports to job offers, from the command line or
// from a local web page.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { complete, TIMEOUT_MS } from '../src/llm.js';
import { loadProfile, tailorOffer, RunError } from '../src/run.js';
import { splitOffers } from '../src/split.js';
import { serve } from '../src/serve.js';
import { createInvite, loadInvites, revokeInvite, usageByInvite } from '../src/invites.js';
import { QA_LOG } from '../src/qa.js';
import { readAnswers } from '../src/answers.js';
import { formatQuestions, gatherQuestions, readRunDirs, readRuns } from '../src/questions.js';
import { matrix, offersFromRuns, toCsv, toMarkdown } from '../src/matrix.js';
import { ID, listProfiles } from '../src/profiles.js';
import { fileListingCache } from '../src/listing.js';
import { listingOf, rankListed, rankMarkdown, rankProfiles } from '../src/rank.js';
import { importProfile, writeProfile } from '../src/import.js';

const USAGE = `usage:
  itsacv tailor <offer.txt>... [--split] [--profile FILE] [--out DIR] [--url URL] [--timeout SECONDS] [--no-layout]
  itsacv split <email.txt> [--url URL] [--timeout SECONDS]
  itsacv serve [--port PORT] [--profile FILE] [--profiles DIR] [--out DIR] [--url URL] [--timeout SECONDS] [--no-layout]
               [--public-host NAME [--per-day N] [--per-hour N] [--max-queued N]
               [--ban-after N] [--ban-hours N] [--invite-only]]
  itsacv invite <label> [--out DIR] [--public-host NAME]
  itsacv invite --list | --usage | --revoke <label|code> [--out DIR]
  itsacv questions [<run-dir>...] [--profile FILE] [--out DIR]
  itsacv matrix [<run-dir>...] [--profile FILE] [--profiles DIR] [--out DIR] [--csv]
  itsacv rank <offer.txt>... [--top K] [--run] [--profile FILE] [--out DIR] [--url URL] [--timeout SECONDS]
  itsacv match <offer.txt> [--top K] [--run] [--profile FILE] [--profiles DIR] [--out DIR] [--url URL]
  itsacv import <resume.json | linkedin-export-dir> --id ID [--profiles DIR]

  tailor     one CV and one report per offer file (with --split, per offer
             found in each file: an agency email often holds several)
  split      print the offers found in a file, without tailoring
  serve      the local web page, on http://127.0.0.1:PORT (default 8790)
  invite     an invitation link for one ESN (printed): the jobs of a page opened
             with it name the label in <out>/qa-log.jsonl; --list shows them,
             --usage the jobs and tokens per backend of each, read from that log,
             --revoke ends one (by label or code), at once, no restart
  questions  what the offers ask that no profile skill meets, most asked first, minus
             what answers.json (beside the profile) already answers: of every run in
             --out, or of the run directories named
  matrix     no model call: for each offer run in --out (or each run named; an offer run
             twice is its latest run) and each profile (--profile, then --profiles DIR),
             the share of its requirements the profile's skills name; a Markdown table,
             or CSV with --csv
  rank       the offers ranked by the share of their listed requirements the profile
             covers (one listing call per offer, cached in <out>/.listings and reused
             by the analysis), each with its analysis prompt's estimated tokens; the
             best --top K (default 3) marked; with --run, only those are tailored
  match      the employer's side: the profiles (--profile, then --profiles DIR) ranked for
             one offer, the same way; with --run, a CV for each of the top K
  import     a JSON Resume (jsonresume.org) or a LinkedIn data export folder compiled into
             DIR/<id>.json (default ~/.itsaresume/profiles), nothing invented: levels the file
             does not state read as working and listed in to_confirm

  --profile  the profile (default: $ITSACV_PROFILE, else ~/.itsaresume/profile.json)
  --profiles serve: other profiles a job may be tailored to, each DIR/<id>.json (id: lower
             case letters, digits, dashes); the page offers the choice; never in public mode
  --out      where to write the run directories (default: ./out)
  --url      itsaresume's HTTP endpoint (default: $ITSARESUME_URL, else http://127.0.0.1:8787)
  --timeout  how long one model answer may take, in seconds (default: $ITSACV_TIMEOUT,
             else ${TIMEOUT_MS / 1000}); must exceed the router backend's timeout_secs, or the
             client gives up on an answer the router is still waiting for
  --no-layout  skip Word: no page fitting, no PDF, no ATS check
  --public-host  serve anyone behind a reverse proxy that answers as NAME (e.g. cv.ngas.fr):
             job offers only, one visitor per page load, the owner's notes hidden, no split,
             an offer already answered reused; at most --per-day CVs a day for everyone
             (default 20), --per-hour per visitor (default 10), --max-queued waiting (default 3),
             --ban-after N requests an hour from one IP or visitor ban both (default 10) for
             --ban-hours hours (default 24); with --invite-only, only a page opened
             from a live invitation link may generate

Each run writes <out>/<timestamp>-<offer>/ with cv.docx, report.md and
analysis.json, and with Word (Windows) cv.pdf, fitted to one full page (two
only when the relevant content alone reaches a page and a half) and checked
for ATS. Word runs through pwsh ($ITSACV_PWSH names another PowerShell).
Exit codes: 0 done; 2 usage, profile or sources error; 3 the model's answer
stayed invalid; 4 itsaresume unreachable or refusing; 5 Word or the PDF check
failed (the CV is written, the report says what was not done); 1 anything
else. With several offers, each runs whatever happened to the others, and
the exit code is the highest.`;

const VALUED = ['--profile', '--profiles', '--out', '--url', '--port', '--timeout', '--public-host', '--per-day', '--per-hour', '--max-queued', '--ban-after', '--ban-hours', '--revoke', '--top', '--id'];
const FLAGS = { '--no-layout': ['layout', false], '--split': ['split', true], '--invite-only': ['inviteOnly', true], '--list': ['list', true], '--usage': ['usage', true], '--csv': ['csv', true], '--run': ['run', true] };

function fail(code, message) {
  process.stderr.write(`itsacv: ${message}\n`);
  process.exit(code);
}

function parse(argv) {
  const [command, ...rest] = argv;
  if (!['tailor', 'split', 'serve', 'invite', 'questions', 'matrix', 'rank', 'match', 'import'].includes(command)) fail(2, `a command is needed\n\n${USAGE}`);
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
    profiles: null,
    perDay: '20',
    perHour: '10',
    maxQueued: '3',
    banAfter: '10',
    banHours: '24',
    inviteOnly: false,
    list: false,
    usage: false,
    csv: false,
    revoke: null,
    top: '3',
    id: null,
    run: false,
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
  if (command === 'invite') {
    if (!options.list && !options.usage && options.revoke === null && options.files.length !== 1) fail(2, `invite takes one label (quote it)\n\n${USAGE}`);
    return options;
  }
  if (!['serve', 'questions', 'matrix'].includes(command) && options.files.length === 0) fail(2, `${command} needs a file\n\n${USAGE}`);
  if ((command === 'rank' || command === 'match') && !/^[1-9]\d*$/.test(options.top)) fail(2, '--top: a whole number, 1 or more');
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
  const llm = ({ system, prompt, schema, backend, kind }) => complete({ url: options.url, system, prompt, schema, backend, kind, timeoutMs });

  // 4.2/4.3: another person's profile, compiled and checked before it is written.
  if (options.command === 'import') {
    if (!options.id || !ID.test(options.id)) fail(2, '--id: lower-case letters, digits and dashes');
    try {
      const written = writeProfile(options.profiles ?? join(homedir(), '.itsaresume', 'profiles'), options.id, importProfile(options.files[0]));
      process.stderr.write(`itsacv: ${written.path} written; to confirm: ${written.to_confirm.length} line(s)
`);
    } catch (error) {
      fail(2, error.message);
    }
    return;
  }

  if (options.command === 'invite') {
    try {
      if (options.usage) {
        const log = join(options.out, QA_LOG);
        process.stdout.write(usageByInvite(existsSync(log) ? readFileSync(log, 'utf8') : ''));
      } else if (options.list) {
        for (const [code, invite] of Object.entries(loadInvites(options.out))) {
          process.stdout.write(`${invite.label}\t${code}${invite.revoked ? '\trevoked' : ''}\n`);
        }
      } else if (options.revoke !== null) {
        const count = revokeInvite(options.out, options.revoke);
        if (!count) fail(2, `no invitation "${options.revoke}" to revoke`);
        process.stderr.write(`itsacv: ${count} invitation(s) revoked\n`);
      } else {
        mkdirSync(options.out, { recursive: true });
        const code = createInvite(options.out, options.files[0]);
        process.stdout.write(`${options.publicHost ? `https://${options.publicHost}` : ''}/?i=${code}\n`);
      }
    } catch (error) {
      fail(2, error.message);
    }
    return;
  }

  if (options.command === 'serve') {
    if (options.inviteOnly && options.publicHost === null) fail(2, '--invite-only goes with --public-host');
    for (const key of ['perDay', 'perHour', 'maxQueued', 'banAfter', 'banHours']) {
      if (!/^[1-9]\d*$/.test(options[key])) fail(2, `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: a whole number, 1 or more`);
    }
    if (options.publicHost !== null && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(options.publicHost)) fail(2, '--public-host: a host name, like cv.ngas.fr');
    const publicMode = options.publicHost && { host: options.publicHost, perDay: Number(options.perDay), perVisitorPerHour: Number(options.perHour), maxQueued: Number(options.maxQueued), banAfter: Number(options.banAfter), banHours: Number(options.banHours), inviteOnly: options.inviteOnly, now: Date.now };
    const server = await serve({ ...options, profilesDir: options.profiles, port: Number(options.port), useWord: options.layout, llm, publicMode }).catch((error) => fail(4, error.message));
    const open = publicMode ? `, public as https://${publicMode.host} (at most ${publicMode.perDay} CVs a day)` : '';
    process.stderr.write(`itsacv: serving on http://127.0.0.1:${server.address().port}${open} (Ctrl+C to stop)\n`);
    return;
  }

  if (options.command === 'questions') {
    let loaded;
    try {
      loaded = loadProfile(options.profile);
    } catch (error) {
      fail(error.code ?? 2, error.message);
    }
    let found;
    let answers;
    try {
      found = options.files.length ? readRunDirs(options.files) : readRuns(options.out);
      answers = readAnswers(join(dirname(options.profile), 'answers.json'));
    } catch (error) {
      fail(2, error.message);
    }
    for (const entry of found.unreadable) process.stderr.write(`itsacv: ${entry.name} skipped: ${entry.error}\n`);
    process.stdout.write(formatQuestions(gatherQuestions(found.runs, { profile: loaded.profile, answers }), found.runs.length));
    return;
  }

  if (options.command === 'matrix') {
    let found;
    let profiles;
    try {
      found = options.files.length === 0 ? readRuns(options.out) : readRunDirs(options.files);
      profiles = [...listProfiles({ profile: options.profile, profilesDir: options.profiles })].map(([id, path]) => ({ id, profile: loadProfile(path).profile }));
    } catch (error) {
      fail(2, error.message);
    }
    for (const entry of found.unreadable) process.stderr.write(`itsacv: ${entry.name} skipped: ${entry.error}
`);
    if (!found.runs.length) fail(2, `no run with an analysis.json in ${options.files.length ? 'the directories named' : options.out}`);
    const rows = matrix(offersFromRuns(found.runs), profiles);
    process.stdout.write(options.csv ? toCsv(rows) : toMarkdown(rows));
    return;
  }

  if (options.command === 'split') {
    const { offers, repairs } = await splitOffers({ text: read(options.files[0]), llm }).catch((error) => fail(4, error.message));
    for (const repair of repairs) process.stderr.write(`itsacv: ${repair}\n`);
    offers.forEach((offer, index) => process.stdout.write(`--- offer ${index + 1}: ${offer.title}\n${offer.text}\n`));
    return;
  }

  // 4.4: the employer's side, profiles ranked for one offer; CVs for the top K with --run.
  if (options.command === 'match') {
    const text = read(options.files[0]);
    let entries;
    try {
      entries = [...listProfiles({ profile: options.profile, profilesDir: options.profiles })].map(([id, path]) => ({ id, path, profile: loadProfile(path).profile }));
    } catch (error) {
      fail(2, error.message);
    }
    const listed = await listingOf(text, { llm, cache: fileListingCache(join(options.out, '.listings')) }).catch((error) => fail(4, error.message));
    const rows = rankProfiles(listed, entries, { top: Number(options.top), offer: text });
    process.stdout.write(rankMarkdown(rows, { what: 'profil' }));
    if (options.run !== true) return;
    let worst = 0;
    for (const row of rows.filter((candidate) => candidate.chosen)) {
      try {
        const { dir } = await tailorOffer({ loaded: loadProfile(entries[row.index].path), offer: text, llm, outDir: options.out, useWord: options.layout, profileId: row.name });
        process.stderr.write(`itsacv: ${row.name}: written to ${dir}
`);
      } catch (error) {
        worst = Math.max(worst, RunError === error.constructor ? error.code : 1);
        process.stderr.write(`itsacv: ${row.name}: ${error.message}
`);
      }
    }
    process.exit(worst);
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

  // 5.2a: rank first; the analysis, if asked, for the best K only.
  if (options.command === 'rank') {
    const named = offers.map((text, index) => ({ title: basename(options.files[index], extname(options.files[index])), text }));
    const rows = await rankListed({ offers: named, profile: loaded.profile, top: Number(options.top), llm, cache: fileListingCache(join(options.out, '.listings')) })
      .catch((error) => fail(4, error.message));
    process.stdout.write(rankMarkdown(rows));
    if (!options.run) return;
    offers.splice(0, offers.length, ...rows.filter((row) => row.chosen).map((row) => row.text));
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
