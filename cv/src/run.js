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
import { DEFAULT_PROFILE } from './profiles.js';
import { validateProfile } from './profile.js';
import { mergeAnswers, readAnswers } from './answers.js';
import { assess, blocked, checkProvenance, checkQuotes, olderMentions, readSources, restrict, scanSources } from './evidence.js';
import { analyse } from './pipeline.js';
import { buildModel, rankBullets, defaultBullets } from './tailor.js';
import { fitToPage } from './fit.js';
import { startWord } from './word.js';
import { startLibre } from './libre.js';

/** Word where it runs, else LibreOffice (ADR-11, the Linux VM), else none. */
export const startLayoutEngine = async () => (await startWord()) ?? (await startLibre());
import { atsCheck } from './ats.js';
import { render } from './render.js';
import { report } from './report.js';
import { offerInstructions } from './instructions.js';

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
  if (!full.sources?.length) return { full, profile: answered(full, path), assessment: undefined, removed: [], texts: [] };
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
  return { full, profile: answered(profile, path, blocked(assessment)), assessment, removed, texts };
}

/** The profile with the owner's answers beside it (2.22a); a refused one stops the run. */
function answered(profile, path, out) {
  let answers;
  try {
    answers = readAnswers(join(dirname(path), 'answers.json'));
  } catch (error) {
    throw new RunError(2, error.message);
  }
  const { profile: merged, errors } = mergeAnswers(profile, answers, { blocked: out });
  if (errors.length) throw new RunError(2, `the answers cannot join the profile:\n- ${errors.join('\n- ')}`);
  return merged;
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
export async function tailorOffer({ loaded, offer, llm, outDir, useWord = true, startLayout = startLayoutEngine, onStep = () => {}, profileId = DEFAULT_PROFILE }) {
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
  const { analysis, attempts, backend, repairs, calls } = result;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'analysis.json'), JSON.stringify(analysis, null, 2));
  writeFileSync(join(dir, 'raw.json'), JSON.stringify({ calls }, null, 2));
  const { model, layout, ats, skipped } = await writeCv({ profile, analysis, dir, useWord, startLayout, onStep });
  const older = olderMentions(analysis, full, texts);
  const instructions = offerInstructions(offer);
  const text = report(analysis, profile, { backend, attempts, repairs, layout, ats, skipped, assessment, removed, older, rendered: model.experiences, instructions });
  writeFileSync(join(dir, 'report.md'), text);
  // The offer and what the run did, so that the same offer can be answered
  // from this run later (public mode, src/intake.js), with no model call.
  writeFileSync(join(dir, 'offer.txt'), offer);
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ profile: profileId, attempts, backend, repairs, layout, ats, skipped, older, instructions }, null, 2));
  onStep('done', { dir });
  return { dir, name: basename(dir), analysis, attempts, backend, repairs, layout, ats, skipped, older, instructions, report: text };
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
    instructions: meta.instructions ?? (existsSync(join(dir, 'offer.txt')) ? offerInstructions(read('offer.txt')) : []),
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
    const plain = buildModel(profile, analysis, { bullets: defaultBullets(profile, analysis) });
    writeFileSync(docx, render(plain));
    return { model: plain, skipped: { reason: `layout, PDF and ATS check skipped: ${why}`, failed } };
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
      return { model, layout, ats: atsCheck(model, pdfText(pdf)) };
    } catch (error) {
      return { model, layout, ats: null, skipped: { reason: `ATS check skipped: the PDF text could not be read (${error.message})`, failed: true } };
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
    return execFileSync(process.env.ITSACV_PYTHON || 'python', [script, pdf], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // Python's last line says what went wrong; the traceback above it does not.
    throw new Error(String(error.stderr ?? '').trim().split(/\r?\n/).at(-1) || error.message);
  }
}
