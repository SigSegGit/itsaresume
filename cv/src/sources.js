// 4.8-4.9 (the owner, 2026-11-14): a run's own sources, kept in memory only
// (nothing stored, no GDPR retention): JSON Resume files, LinkedIn exports
// (folder or ZIP), old CVs (docx, pdf, text), profiles an AI wrote, web
// pages. Structured sources compile by code; free text goes through the
// model, then code keeps only what the text says word for word.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import PizZip from 'pizzip';
import { fromJsonResume, linkedInToJsonResume } from './import.js';
import { validateProfile } from './profile.js';
import { extractJson } from './llm.js';
import { mentions } from './text.js';
import { pdfText } from './run.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text) => text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
  if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? whole;
  const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
  return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
});
const lines = (text) => text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');

/** A web page's readable text: no head, script or style; blocks on their own lines. */
export function htmlToText(html) {
  const body = String(html)
    .replace(/<(head|script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return lines(decode(body));
}

/** A docx's paragraphs, one per line. */
function docxText(buffer) {
  const xml = new PizZip(buffer).file('word/document.xml')?.asText() ?? '';
  return lines(xml.split(/<\/w:p>/).map((paragraph) => decode([...paragraph.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join(''))).join('\n'));
}

const LINKEDIN_MARKS = ['Profile.csv', 'Positions.csv'];
const defaultFetch = async (url) => {
  const answer = await fetch(url, { headers: { 'User-Agent': 'itsacv' }, signal: AbortSignal.timeout(20000) });
  if (!answer.ok) throw new Error(`${url}: HTTP ${answer.status}`);
  return answer.text();
};

/** One source: `{ resume }` (structured) or `{ text }` (free text), with its `name`. */
export async function readSource(spec, { fetchText = defaultFetch } = {}) {
  if (/^https?:\/\//i.test(spec)) return { name: spec, text: htmlToText(await fetchText(spec)) };
  if (statSync(spec).isDirectory()) return { name: spec, resume: linkedInToJsonResume((file) => { try { return readFileSync(`${spec}/${file}`, 'utf8'); } catch { return null; } }) };
  const kind = extname(spec).toLowerCase();
  if (kind === '.zip') {
    const zip = new PizZip(readFileSync(spec));
    const find = (file) => zip.file(new RegExp(`(^|/)${file.replace('.', '\\.')}$`))[0]?.asText() ?? null;
    if (!LINKEDIN_MARKS.some(find)) throw new Error(`${spec}: not a LinkedIn export (no Profile.csv or Positions.csv)`);
    return { name: spec, resume: linkedInToJsonResume(find) };
  }
  if (kind === '.json') return { name: spec, resume: JSON.parse(readFileSync(spec, 'utf8')) };
  if (kind === '.docx') return { name: spec, text: docxText(readFileSync(spec)) };
  if (kind === '.pdf') return { name: spec, text: lines(pdfText(spec)) };
  return { name: spec, text: lines(readFileSync(spec, 'utf8').replace(/\r/g, '')) };
}

/** 2.53: the kinds of file an offer may be dropped as on the page. */
export const OFFER_FILES = ['.pdf', '.docx', '.txt', '.md'];

/** 2.53: a dropped offer's text, from its name (kind) and bytes; no model call. */
export async function offerFromFile(name, buffer) {
  const kind = extname(String(name)).toLowerCase();
  if (!OFFER_FILES.includes(kind)) throw new Error(`${name}: an offer file is pdf, docx, txt or md`);
  if (kind === '.docx') return docxText(buffer);
  if (kind === '.pdf') {
    const dir = mkdtempSync(join(tmpdir(), 'itsacv-offer-'));
    try {
      const file = join(dir, 'offer.pdf');
      writeFileSync(file, buffer);
      return lines(pdfText(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return lines(buffer.toString('utf8').replace(/\r/g, ''));
}

/** An offer: a file, a link, or the text itself. */
export async function readOffer(spec, options) {
  let isPath = /^https?:\/\//i.test(spec);
  if (!isPath) try { isPath = statSync(spec).isFile(); } catch { isPath = false; }
  if (!isPath) return String(spec);
  const source = await readSource(spec, options);
  if (source.text === undefined) throw new Error(`${spec}: an offer is a text, a link or a document`);
  return source.text;
}

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const keyOf = (job) => `${clean(job.name ?? job.company).toLowerCase()}|${clean(job.position).toLowerCase()}`;
const unique = (items) => [...new Set(items)];

/** Several resumes into one: the first value given wins; a position once, its highlights together. */
export function mergeResumes(resumes) {
  const basics = {};
  const work = new Map();
  const out = { skills: [], education: [], certificates: [], languages: [] };
  for (const resume of resumes) {
    for (const [field, value] of Object.entries(resume.basics ?? {})) if (basics[field] === undefined && value) basics[field] = value;
    for (const job of resume.work ?? []) {
      const kept = work.get(keyOf(job));
      if (kept) kept.highlights = unique([...kept.highlights, ...(job.highlights ?? [])]);
      else work.set(keyOf(job), { ...job, highlights: [...(job.highlights ?? [])] });
    }
    for (const field of Object.keys(out)) out[field].push(...(resume[field] ?? []));
  }
  const once = (items) => [...new Map(items.map((item) => [JSON.stringify(item).toLowerCase(), item])).values()];
  return { basics, work: [...work.values()], ...Object.fromEntries(Object.entries(out).map(([field, items]) => [field, once(items)])) };
}

export const TEXT_SYSTEM = `You read texts about one person (an old CV, a profile, a web page) and answer ONE JSON object in the JSON Resume shape: {"basics":{"name","label","email","phone","summary"},"work":[{"name","position","startDate","endDate","highlights":[]}],"skills":[{"name","keywords":[]}],"education":[{"institution","studyType","area"}],"certificates":[{"name"}],"languages":[{"language","fluency"}]}.
Copy every highlight and summary WORD FOR WORD from the texts; never rephrase, never add. Dates as YYYY or YYYY-MM. A skill only if the texts name it. Anything you cannot find: leave it out.`;

const flat = (text) => clean(text).toLowerCase();

/** 4.9: free texts -> JSON Resume through the model; code drops every sentence or skill the texts do not hold. */
export async function profileFromTexts(texts, { llm }) {
  const { text } = await llm({ system: TEXT_SYSTEM, prompt: texts.map((source, index) => `--- text ${index + 1} ---\n${source}`).join('\n\n') });
  const resume = extractJson(text);
  const corpus = flat(texts.join('\n'));
  const all = texts.join('\n');
  const dropped = [];
  const said = (sentence) => (corpus.includes(flat(sentence)) ? true : (dropped.push(sentence), false));
  const named = (name) => (mentions(all, name) ? true : (dropped.push(name), false));
  if (resume.basics?.summary && !said(resume.basics.summary)) delete resume.basics.summary;
  for (const job of resume.work ?? []) job.highlights = (job.highlights ?? []).filter(said);
  for (const skill of resume.skills ?? []) skill.keywords = (skill.keywords ?? []).filter(named);
  resume.skills = (resume.skills ?? []).filter((skill) => skill.keywords.length || mentions(all, skill.name));
  return { resume, dropped };
}

/** 4.9: every source of a run -> one checked profile, in memory. */
export async function profileFromSources(specs, { llm, fetchText } = {}) {
  const sources = [];
  for (const spec of specs) sources.push(await readSource(spec, { fetchText }));
  const resumes = sources.filter((source) => source.resume).map((source) => source.resume);
  const texts = sources.filter((source) => source.text).map((source) => source.text);
  let dropped = [];
  if (texts.length) {
    const read = await profileFromTexts(texts, { llm });
    resumes.push(read.resume);
    dropped = read.dropped;
  }
  const profile = fromJsonResume(mergeResumes(resumes));
  if (dropped.length) profile.to_confirm.push(...dropped.map((item) => `not in the sources word for word, left out: ${item}`));
  const { errors } = validateProfile(profile);
  if (errors.length) throw new Error(`the sources do not make a usable profile: ${errors.slice(0, 5).join('; ')}`);
  return { profile, dropped };
}
