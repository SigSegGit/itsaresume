// What may enter in public mode, before any model call.
//
// The public page must spend the owner's model quota on one thing only:
// tailoring his CV to a job offer. So a text is admitted only if it reads as
// an offer and has an offer's size, and an offer already answered is
// answered again from its run, with no call at all (which also gives the same
// CV to the same offer, instead of a second, possibly different reading).
// The owner rates a run by renaming its directory with a .q0 to .q5 suffix;
// a run rated below 3 is never reused.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PROFILE } from './profiles.js';
import { STOP, wordsOf } from './text.js';

/** An offer's size: shorter is a question, longer is not one offer. */
export const OFFER_CHARS = { min: 200, max: 12_000 };

/** Words nearly every offer uses, French and English; an offer holds several. */
const OFFER_WORDS = `mission missions poste profil compétences compétence expérience expériences requis recherché recherchée
  responsabilités contrat cdi cdd freelance télétravail candidat candidate équipe environnement technique
  role responsibilities requirements required skills experience position team contract remote hybrid`.split(/\s+/);

/** At least this many distinct offer words, and this share of letters in the text. */
const MIN_OFFER_WORDS = 4;
const MIN_LETTERS = 0.6;

/** Whether a text reads as a job offer of a reasonable size. */
export function looksLikeOffer(text) {
  const clean = String(text ?? '').trim();
  if (clean.length < OFFER_CHARS.min || clean.length > OFFER_CHARS.max) return false;
  const letters = (clean.match(/\p{L}/gu) ?? []).length;
  if (letters / clean.replace(/\s/g, '').length < MIN_LETTERS) return false;
  const words = new Set(wordsOf(clean));
  return OFFER_WORDS.filter((word) => words.has(word)).length >= MIN_OFFER_WORDS;
}

/** The content words of a text, as a set. */
const contentOf = (text) => new Set(wordsOf(text).filter((word) => !STOP.has(word)));

/** Jaccard similarity of two texts' content words, 0 to 1. */
export function similarity(a, b) {
  const left = contentOf(a);
  const right = contentOf(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** The owner's rating of a run, from its directory name: .q0 to .q5, else null. */
export function qualityOf(name) {
  const found = /\.q([0-5])$/.exec(name);
  return found ? Number(found[1]) : null;
}

/** Offers at least this close are the same offer. */
export const SAME_OFFER = 0.9;
/** A run rated below this is regenerated, never reused. */
export const MIN_REUSED_QUALITY = 3;

/** The finished runs under `out` that saved their offer. */
export function loadRuns(out) {
  if (!existsSync(out)) return [];
  return readdirSync(out, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(out, entry.name))
    .filter((dir) => ['offer.txt', 'analysis.json', 'cv.pdf'].every((file) => existsSync(join(dir, file))))
    .map((dir) => {
      const name = dir.split(/[\\/]/).at(-1);
      return { dir, name, offer: readFileSync(join(dir, 'offer.txt'), 'utf8'), quality: qualityOf(name), profile: profileOf(dir) };
    });
}

/** The profile a run was tailored to (4.1): its run.json says; none, the owner's. */
function profileOf(dir) {
  try {
    const { profile } = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    return typeof profile === 'string' ? profile : DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

/**
 * The run to answer this offer with, for this profile: the best rated among
 * the same offer's, then the newest; or null. Another profile's run is never
 * an answer (4.1).
 */
export function findReusable(offer, runs, profile = DEFAULT_PROFILE) {
  const candidates = runs
    .filter((run) => (run.profile ?? DEFAULT_PROFILE) === profile)
    .filter((run) => (run.quality ?? MIN_REUSED_QUALITY) >= MIN_REUSED_QUALITY)
    .filter((run) => similarity(offer, run.offer) >= SAME_OFFER);
  candidates.sort((a, b) => (b.quality ?? MIN_REUSED_QUALITY) - (a.quality ?? MIN_REUSED_QUALITY) || b.name.localeCompare(a.name));
  return candidates[0] ?? null;
}
