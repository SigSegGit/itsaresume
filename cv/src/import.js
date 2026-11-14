// 4.2 (ADR-12): another person's profile, imported from a JSON Resume
// (jsonresume.org, schema v1). Compiled by code, no model: every bullet is a
// sentence of the file, every skill a name of the file, a level read from
// the file's own words or "working" by default (to confirm). One language
// in, the same text in fr and en.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mentions } from './text.js';

const LEVEL_WORDS = [
  [/\b(?:master|expert)\b/i, 'expert'],
  [/\b(?:advanced|proficient|senior)\b/i, 'proficient'],
  [/\b(?:intermediate|working)\b/i, 'working'],
  [/\b(?:beginner|basic|novice|notions?)\b/i, 'notions'],
];
const DASH = '—';

const both = (text) => ({ fr: text, en: text });
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
export const slug = (text) => clean(text).normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

/** "2021-03-01" or "2021-03" -> "03/2021"; "2021" stays; anything else: none. */
function date(value) {
  const found = /^(\d{4})(?:-(\d{2}))?/.exec(clean(value));
  if (!found) return undefined;
  return found[2] ? `${found[2]}/${found[1]}` : found[1];
}
const sortKey = (value) => {
  const found = /^(\d{4})(?:-(\d{2}))?/.exec(clean(value));
  return found ? Number(found[1]) * 12 + Number(found[2] ?? 1) : 0;
};

/** A unique id from `text` among `taken`. */
function idFor(text, taken) {
  const base = slug(text);
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

export function fromJsonResume(resume) {
  const basics = resume?.basics ?? {};
  const work = (resume?.work ?? []).filter((job) => clean(job.name ?? job.company) || clean(job.position));
  if (!work.length) throw new Error('the resume has no work: a profile needs one experience at least');
  const toConfirm = [];

  // Skills: one group per entry of `skills`, its keywords as skills (or the
  // entry's own name when it lists none), the entry's level for each.
  const groupIds = new Set();
  const skillIds = new Set();
  const skillGroups = [];
  const skills = [];
  for (const entry of resume.skills ?? []) {
    const name = clean(entry.name);
    if (!name) continue;
    const group = idFor(`g-${name}`, groupIds);
    skillGroups.push({ id: group, title: both(name) });
    const stated = LEVEL_WORDS.find(([pattern]) => pattern.test(clean(entry.level)))?.[1];
    const names = (entry.keywords ?? []).map(clean).filter(Boolean);
    for (const skillName of names.length ? names : [name]) {
      if (skillIds.has(slug(skillName))) continue;
      skills.push({ id: idFor(skillName, skillIds), name: skillName, group, level: stated ?? 'working', aliases: [] });
      if (!stated) toConfirm.push(`${skillName}: level not stated in the resume, read as working`);
    }
  }

  // Experiences, newest first; each bullet cites the skills it names.
  const experienceIds = new Set();
  const bulletIds = new Set();
  const experiences = [...work].sort((a, b) => sortKey(b.startDate) - sortKey(a.startDate)).map((job) => {
    const org = clean(job.name ?? job.company) || DASH;
    const position = clean(job.position) || DASH;
    const id = idFor(org === DASH ? position : org, experienceIds);
    const highlights = (job.highlights ?? []).map(clean).filter(Boolean);
    const sentences = highlights.length ? highlights : clean(job.summary) ? [clean(job.summary)] : [`${position} — ${org}`];
    const bullets = sentences.map((text) => ({
      id: idFor(`${id}-b`, bulletIds),
      ...both(text),
      skills: skills.filter((skill) => mentions(text, skill.name)).map((skill) => skill.id),
    }));
    const start = date(job.startDate);
    if (!start) toConfirm.push(`${position} at ${org}: no start date in the resume`);
    const end = date(job.endDate);
    return { id, title: both(position), org: both(org), start: start ?? DASH, ...(end ? { end } : {}), bullets, env: [] };
  });

  const contact = (field) => {
    const value = clean(basics[field]);
    if (value) return value;
    toConfirm.push(`identity: no ${field} in the resume`);
    return DASH;
  };
  const place = [clean(basics.location?.city), clean(basics.location?.region), clean(basics.location?.countryCode)].filter(Boolean).join(', ');
  return {
    version: 1,
    identity: { name: clean(basics.name) || DASH, email: contact('email'), phone: contact('phone'), location: both(place || DASH) },
    glance: [],
    profile_facts: clean(basics.summary) ? [{ id: 'summary', kind: 'hook', ...both(clean(basics.summary)) }] : [],
    skill_groups: skillGroups,
    skills,
    experiences,
    education: (resume.education ?? []).map((school, index) => ({ id: `school-${index + 1}`, title: both([school.studyType, school.area, school.institution].map(clean).filter(Boolean).join(' — ') || DASH), details: [] })),
    certifications: (resume.certificates ?? []).map((certificate) => clean(certificate.name)).filter(Boolean).map(both),
    languages: (resume.languages ?? []).map((language) => [language.language, language.fluency].map(clean).filter(Boolean).join(' — ')).filter(Boolean).map(both),
    to_confirm: toConfirm,
  };
}

/** RFC 4180 CSV (quotes, doubled quotes, line breaks inside quotes) -> objects by header. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/^\uFEFF/, '');
  for (let at = 0; at < src.length; at += 1) {
    const char = src[at];
    if (quoted) {
      if (char === '"' && src[at + 1] === '"') { field += '"'; at += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && src[at + 1] === '\n') at += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows.filter((cells) => cells.some((cell) => cell.trim()));
  return body.map((cells) => Object.fromEntries(header.map((name, index) => [name.trim(), cells[index] ?? ''])));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** LinkedIn's "Mar 2021" or "2021" -> JSON Resume's "2021-03" or "2021". */
function linkedInDate(value) {
  const found = /^(?:([A-Za-z]{3})[a-z]*\s+)?(\d{4})$/.exec(clean(value));
  if (!found) return undefined;
  const month = found[1] ? MONTHS.indexOf(found[1].toLowerCase()) + 1 : 0;
  return month ? `${found[2]}-${String(month).padStart(2, '0')}` : found[2];
}

/** 4.3: a LinkedIn data export (folder of its CSV files) -> JSON Resume. */
export function linkedInToJsonResume(read) {
  const table = (name) => {
    const text = read(name);
    return text === null ? [] : parseCsv(text);
  };
  const [me = {}] = table('Profile.csv');
  const emails = table('Email Addresses.csv');
  const email = (emails.find((row) => /^yes$/i.test(row.Primary)) ?? emails[0])?.['Email Address'];
  const phone = table('PhoneNumbers.csv')[0]?.Number;
  return {
    basics: { name: [me['First Name'], me['Last Name']].map(clean).filter(Boolean).join(' '), label: me.Headline, email, phone, summary: me.Summary, location: { city: me['Geo Location'] } },
    work: table('Positions.csv').map((row) => ({
      name: row['Company Name'],
      position: row.Title,
      startDate: linkedInDate(row['Started On']),
      endDate: linkedInDate(row['Finished On']),
      highlights: String(row.Description ?? '').split(/\r?\n/).map((line) => clean(line.replace(/^[-•*·]\s*/, ''))).filter(Boolean),
    })),
    skills: [{ name: 'Skills', keywords: table('Skills.csv').map((row) => row.Name) }],
    education: table('Education.csv').map((row) => ({ institution: row['School Name'], studyType: row['Degree Name'], area: row.Notes })),
    certificates: table('Certifications.csv').map((row) => ({ name: [row.Name, row.Authority].map(clean).filter(Boolean).join(' — ') })),
    languages: table('Languages.csv').map((row) => ({ language: row.Name, fluency: row.Proficiency })),
  };
}

export function fromLinkedInExport(dir) {
  return fromJsonResume(linkedInToJsonResume((name) => {
    const path = join(dir, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }));
}

/** A JSON Resume file or a LinkedIn export folder -> profile. */
export function importProfile(path) {
  return statSync(path).isDirectory() ? fromLinkedInExport(path) : fromJsonResume(JSON.parse(readFileSync(path, 'utf8')));
}
