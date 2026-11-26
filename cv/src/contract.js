// The kind of contract an offer is for, read by code from its words (the
// owner, 2026-11-25): a mission through an intermediary is "freelance", a CDI
// is "permanent", and an offer that names both, or neither, is "any". The CV
// then shows the profile's line for that kind (tailor.js); "any" shows what it
// always did.

const FREELANCE = [
  /\bfree-?lances?\b/i,
  /\bind[ée]pendante?s?\b/i,
  /\bportage\b/i,
  /\bTJM\b/,
  /€\s*(?:HT\s*)?\/\s*j(?:our)?\b/i,
  /€\s*(?:HT\s*)?par\s+jour\b/i,
  /\b(?:day|daily)\s+rate\b/i,
  /\bper\s+day\b/i,
  /\bcontractors?\b/i,
  /\bprestation\b/i,
  /\bsoci[ée]t[ée]\s+interm[ée]diaire\b/i,
];

const PERMANENT = [
  /\bCDI\b/,
  /\bcontrat\s+[àa]\s+dur[ée]e\s+ind[ée]termin[ée]e\b/i,
  /\bpermanent\s+(?:contract|position|role|job)\b/i,
];

/** "freelance", "permanent" or "any": what the offer's words say it is for. */
export function offerContract(offer) {
  const text = String(offer ?? '');
  const freelance = FREELANCE.some((pattern) => pattern.test(text));
  const permanent = PERMANENT.some((pattern) => pattern.test(text));
  if (freelance === permanent) return 'any';
  return freelance ? 'freelance' : 'permanent';
}

export const CONTRACTS = ['freelance', 'permanent'];

const MONTHS = {
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

/** "Disponible au 1er décembre 2026" for "2026-12-01", or null once that day has passed. */
export function availability(date, lang, now = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const today = now.toISOString().slice(0, 10);
  if (date < today) return null;
  const name = MONTHS[lang]?.[month - 1];
  if (!name) return null;
  return lang === 'fr' ? `Disponible au ${day === 1 ? '1er' : day} ${name} ${year}` : `Available from ${day} ${name} ${year}`;
}
