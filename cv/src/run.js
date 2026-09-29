// One offer, end to end, as a library: the CLI (bin/itsacv.js) and the web
// server (src/server.js) run the same steps.
//
//   loadProfile    profile.json → checked, and restricted by its evidence
//   tailorOffer    offer → analysis → cv.docx (+ fitted cv.pdf, ATS check) → report.md
//
// Failures carry the CLI's exit code: 2 profile or sources, 3 the model's
// answer stayed invalid, 4 the router unreachable or refusing.

import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { validateProfile } from './profile.js';
import { assess, checkProvenance, checkQuotes, olderMentions, readSources, restrict, scanSources } from './evidence.js';
import { analyse } from './pipeline.js';
import { buildModel, rankBullets, defaultBullets } from './tailor.js';
import { fitToPage } from './fit.js';
import { startWord } from './word.js';
import { atsCheck } from './ats.js';
import { render } from './render.js';
import { report } from './report.js';

export class RunError extends Error {
  constructor(code, message, { answers, dir } = {}) {
    super(message);
    this.code = code;
    this.answers = answers;
    this.dir = dir;
  }
}

/**
 * The profile the CV may draw from. With sources, every quote and every line
 * is checked word for word against them (the truth document first), and the
 * evidence restricts the profile; without, the profile is used as it is,
 * unchecked.
 */
export function loadProfile(path) {
  let full;
  try {
    full = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new RunError(2, error.message);
  }
  const { errors } = validateProfile(full);
  if (errors.length) throw new RunError(2, `the profile is invalid:\n- ${errors.join('\n- ')}`);
  if (!full.sources?.length) return { full, profile: full, assessment: undefined, removed: [], texts: [] };
  let texts;
  try {
    texts = readSources(full, dirname(path));
  } catch (error) {
    throw new RunError(2, error.message);
  }
  const quotes = [...checkQuotes(full, texts), ...checkProvenance(full, texts)];
  if (quotes.length) throw new RunError(2, `the evidence does not match its sources:\n- ${quotes.join('\n- ')}`);
  const assessment = assess(full, scanSources(full, texts));
  const { profile, removed } = restrict(full, assessment);
  return { full, profile, assessment, removed, texts };
}

/** "20260924-031500-architecte-solutions" from the time and the offer's first line. */
export function runName(offer, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const first = offer.split('\n').find((line) => line.trim()) ?? 'offer';
  const slug = first.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'offer';
  return `${stamp}-${slug}`;
}

/**
 * Tailor one offer. `onStep(step, detail)` reports progress: listing,
 * analysis ({attempt}), layout ({layouts}), pdf, ats, done ({dir}).
 * `startLayout` starts the layout engine (Word; tests fake it).
 */
export async function tailorOffer({ loaded, offer, llm, outDir, useWord = true, startLayout = startWord, onStep = () => {} }) {
  const { full, profile, assessment, removed, texts } = loaded;
  const dir = join(outDir, runName(offer));
  let result;
  try {
    result = await analyse({ profile, offer, llm, assessment, onStep });
  } catch (error) {
    // Keep what the model said: the next attempt at a prompt starts there.
    (error.answers ?? []).forEach((answer, index) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `rejected-attempt-${index + 1}.txt`), answer);
    });
    throw new RunError(/itsaresume/.test(error.message) ? 4 : 3, error.message, { answers: error.answers, dir: error.answers ? dir : undefined });
  }
  const { analysis, attempts, backend, repairs } = result;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'analysis.json'), JSON.stringify(analysis, null, 2));
  const { layout, ats, skipped } = await writeCv({ profile, analysis, dir, useWord, startLayout, onStep });
  const older = olderMentions(analysis, full, texts);
  const text = report(analysis, profile, { backend, attempts, repairs, layout, ats, skipped, assessment, removed, older });
  writeFileSync(join(dir, 'report.md'), text);
  // The offer and what the run did, so that the same offer can be answered
  // from this run later (public mode, src/intake.js), with no model call.
  writeFileSync(join(dir, 'offer.txt'), offer);
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ attempts, backend, repairs, layout, ats, skipped, older }, null, 2));
  onStep('done', { dir });
  return { dir, name: basename(dir), analysis, attempts, backend, repairs, layout, ats, skipped, older, report: text };
}

/** A finished run read back from its directory, to answer the same offer again. */
export function readRun(dir) {
  const read = (file) => readFileSync(join(dir, file), 'utf8');
  const meta = existsSync(join(dir, 'run.json')) ? JSON.parse(read('run.json')) : {};
  return {
    dir,
    name: basename(dir),
    analysis: JSON.parse(read('analysis.json')),
    attempts: meta.attempts ?? 0,
    backend: meta.backend ?? 'reused',
    repairs: meta.repairs ?? [],
    layout: meta.layout ?? null,
    ats: meta.ats ?? null,
    skipped: meta.skipped ?? null,
    older: meta.older ?? [],
    report: read('report.md'),
    reused: true,
  };
}

/**
 * cv.docx, and with Word: fitted to the page, exported to a tagged cv.pdf,
 * and the PDF's text layer checked as an ATS would read it. What could not
 * be done is `skipped`: {reason, failed}, failed when Word or the check broke
 * rather than being absent or turned off.
 */
async function writeCv({ profile, analysis, dir, useWord, startLayout, onStep }) {
  const docx = join(dir, 'cv.docx');
  const pdf = join(dir, 'cv.pdf');
  /** The CV as with --no-layout: not fitted to the page, no PDF, no ATS check. */
  const unfitted = (why, failed) => {
    writeFileSync(docx, render(buildModel(profile, analysis, { bullets: defaultBullets(profile, analysis) })));
    return { skipped: { reason: `layout, PDF and ATS check skipped: ${why}`, failed } };
  };
  if (!useWord) return unfitted('--no-layout', false);
  const word = await startLayout();
  if (!word) return unfitted('Word is not available on this machine', false);
  const scratch = mkdtempSync(join(tmpdir(), 'itsacv-layout-'));
  try {
    let count = 0;
    const measure = async (bullets, skillCap) => {
      const file = join(scratch, `layout-${(count += 1)}.docx`);
      onStep('layout', { layouts: count });
      writeFileSync(file, render(buildModel(profile, analysis, { bullets, skillCap })));
      return (await word.measure(file)).pages;
    };
    let model;
    let final;
    let layouts;
    try {
      const fitted = await fitToPage({ ranked: rankBullets(profile, analysis), measure });
      model = buildModel(profile, analysis, { bullets: fitted.bullets, skillCap: fitted.cap });
      writeFileSync(docx, render(model));
      onStep('pdf');
      final = await word.measure(docx, pdf);
      layouts = fitted.layouts;
    } catch (error) {
      // Word hung, died or refused: the run keeps its CV, unfitted, and says why.
      rmSync(pdf, { force: true });
      return unfitted(`Word failed (${error.message}); cv.docx is not fitted to the page`, true);
    }
    onStep('ats');
    const layout = { pages: final.pages, layouts };
    try {
      return { layout, ats: atsCheck(model, pdfText(pdf)) };
    } catch (error) {
      return { layout, ats: null, skipped: { reason: `ATS check skipped: the PDF text could not be read (${error.message})`, failed: true } };
    }
  } finally {
    word.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The PDF's text layer, as an ATS reads it (tools/pdftext.py, PyMuPDF). */
function pdfText(pdf) {
  const script = fileURLToPath(new URL('../tools/pdftext.py', import.meta.url));
  try {
    return execFileSync('python', [script, pdf], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // Python's last line says what went wrong; the traceback above it does not.
    throw new Error(String(error.stderr ?? '').trim().split(/\r?\n/).at(-1) || error.message);
  }
}
