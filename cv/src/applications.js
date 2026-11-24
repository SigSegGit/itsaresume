// 2026-11-24: the owner's applications, tracked on his own page. Each run
// folder of <out> (a name stamped by runName(), an analysis) is one
// application; its status lives beside it in application.json, so a restart
// or a move of the folder keeps it. Never served on the public page.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATUSES = ['todo', 'sent', 'interview', 'offer', 'rejected'];
export const NOTE_MAX = 500;
const RUN = /^(\d{4})(\d{2})(\d{2})-\d{6}-[a-z0-9-]+$/;
const FILE = 'application.json';
const DAY = 24 * 3600 * 1000;

const day = (now) => new Date(now).toISOString().slice(0, 10);
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const read = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

/** Whether `run` names a run folder of `out` that wrote an analysis. */
const isRun = (out, run) => RUN.test(String(run)) && existsSync(join(out, run, 'analysis.json'));

function titleOf(dir, run) {
  const named = existsSync(join(dir, 'title.txt')) && oneLine(readFileSync(join(dir, 'title.txt'), 'utf8'));
  if (named) return named;
  const offer = existsSync(join(dir, 'offer.txt')) && readFileSync(join(dir, 'offer.txt'), 'utf8').split(/\r?\n/).map(oneLine).find(Boolean);
  return offer ? offer.slice(0, 120) : run.replace(RUN, '').replace(/^-/, '') || run.slice(16);
}

/** Every application, newest first: run, date, title, score, verdict, status, at, sent, note. */
export function listApplications(out) {
  if (!existsSync(out)) return [];
  return readdirSync(out, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isRun(out, entry.name))
    .map((entry) => {
      const dir = join(out, entry.name);
      const [, year, month, date] = RUN.exec(entry.name);
      const analysis = read(join(dir, 'analysis.json'), {});
      const saved = read(join(dir, FILE), {});
      return {
        run: entry.name,
        date: `${year}-${month}-${date}`,
        title: titleOf(dir, entry.name),
        score: Number.isFinite(analysis.fit?.score) ? analysis.fit.score : null,
        verdict: analysis.fit?.verdict ?? null,
        status: STATUSES.includes(saved.status) ? saved.status : 'todo',
        at: saved.at ?? null,
        sent: saved.sent ?? null,
        note: typeof saved.note === 'string' ? saved.note : '',
        files: CV_FILES.filter((name) => existsSync(join(dir, name))),
      };
    })
    .sort((a, b) => b.run.localeCompare(a.run));
}

/** A new status (and note) for one run; the day it was first sent is kept. */
export function setApplication(out, run, { status, note } = {}, now = Date.now()) {
  if (!isRun(out, run)) throw new Error('run: not a run folder of this page');
  if (!STATUSES.includes(status)) throw new Error(`status: one of ${STATUSES.join(', ')}`);
  const clean = oneLine(note);
  if (clean.length > NOTE_MAX) throw new Error(`note: at most ${NOTE_MAX} characters`);
  const file = join(out, run, FILE);
  const before = read(file, {});
  const sent = before.sent ?? (status !== 'todo' ? day(now) : null);
  const saved = { status, at: day(now), sent, note: note === undefined ? before.note ?? '' : clean };
  writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
  return { run, ...saved };
}

/** Applications sent per week (Monday first), the last eight weeks. */
export function weekly(rows, now = Date.now()) {
  const today = new Date(day(now));
  const monday = today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY;
  const weeks = Array.from({ length: 8 }, (_, at) => ({ week: day(monday - (7 - at) * 7 * DAY), sent: 0 }));
  for (const row of rows) {
    if (!row.sent) continue;
    const when = Date.parse(row.sent);
    // The week it falls in; before the first week or after this one, none.
    const slot = weeks.findLast((week) => Date.parse(week.week) <= when);
    if (slot && when < monday + 7 * DAY) slot.sent += 1;
  }
  return weeks;
}

/** The applications as CSV (a cell never opens as a formula). */
export function applicationsCsv(rows) {
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n']/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const columns = [['run', 'run'], ['date', 'date'], ['title', 'title'], ['score', 'score'], ['status', 'status'], ['since', 'at'], ['sent', 'sent'], ['note', 'note']];
  return `${columns.map(([name]) => name).join(',')}\n${rows.map((row) => columns.map(([, key]) => cell(row[key])).join(',')).join('\n')}${rows.length ? '\n' : ''}`;
}

export const FOLLOW_UP_DAYS = 7;
/** The files of a run the owner may open from his page: the CV only. */
export const CV_FILES = ['cv.pdf', 'cv.docx'];

/** Sent over FOLLOW_UP_DAYS ago with no news since: time to follow it up. */
export function followUp(row, now = Date.now()) {
  return row.status === 'sent' && Boolean(row.at) && now - Date.parse(row.at) > FOLLOW_UP_DAYS * DAY;
}

/** Counts for the card's line: sent, interviews (an offer counts), their rate, follow-ups. */
export function summary(rows, now = Date.now()) {
  const sent = rows.filter((row) => row.status !== 'todo').length;
  const interviews = rows.filter((row) => row.status === 'interview' || row.status === 'offer').length;
  return {
    total: rows.length,
    sent,
    interviews,
    rate: sent ? Math.round((interviews / sent) * 100) : null,
    followUps: rows.filter((row) => followUp(row, now)).length,
  };
}

/** The CV file `name` of `run`, as a path, or null: never another file, never outside <out>. */
export function cvFile(out, run, name) {
  if (!isRun(out, run) || !CV_FILES.includes(name)) return null;
  const file = join(out, run, name);
  return existsSync(file) ? file : null;
}

/** `itsacv applications`: one line each, then the counts. */
export function applicationsText(rows, now = Date.now()) {
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const lines = rows.map((row) => [row.date, row.status, row.score ?? '', row.title, ...(followUp(row, now) ? ['follow up'] : [])].join('\t'));
  const counts = summary(rows, now);
  return `${lines.map((line) => `${line}\n`).join('')}${plural(counts.total, 'application')}, ${counts.sent} sent, ${plural(counts.interviews, 'interview')}, ${counts.followUps} to follow up\n`;
}
