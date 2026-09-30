// Text helpers shared by the checks.

/**
 * The text the checks read: compatibility forms folded (NFKC: fullwidth
 * letters, ligatures) and format characters removed (zero-width, soft
 * hyphen, byte-order mark, bidi marks). "Kuber<U+FEFF>netes" renders as
 * "Kubernetes" in Word; the checks must read it so too.
 */
export function canonical(text) {
  return String(text ?? '').normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '');
}

/** Words that carry no content, in French and English. */
export const STOP = new Set(`le la les l de des du d un une et ou en au aux avec pour dans sur sous par vers chez entre sans plus très
  tout tous toute toutes cette ces ce cet son sa ses leur leurs nos vos notre votre qui que quoi dont où est sont être avoir a
  the and for with from into over under your our their this that these those have has are was were will would can could
  should of to in on at by an as or its it be not`.split(/\s+/));

/** Words too general to state a requirement ("experience of X" states X). */
export const GENERIC = new Set(`expérience expériences experience experiences connaissance connaissances knowledge bonne bonnes
  good solide solides strong maîtrise mastery compétence compétences skill skills capacité capacités ability capable
  pratique practical practice travail work profil profile outil outils tool tools métier environnement environment
  forte fort sens esprit mise place`.split(/\s+/));

/**
 * Personal qualities, French and English: word beginnings ("pédagog" for
 * pédagogie, pédagogique), or runs of them for a phrase ("esprit équipe").
 * None begins a technical word the offers use ("fédérer", not "fédér":
 * an identity federation is a technology).
 */
export const QUALITIES = `communica rigueur rigoureu rigor rigour organis organiz pédagog pedagog écoute écouter listening facilita
  fédérer fédérateur fédératrice leadership polyvalen versatil curios curieu curious autonom adaptab relationnel relational
  interpersonal posture interagir interact bienveillan empath créativ creativ diplomat teamwork`.split(/\s+/)
  .concat(['esprit équipe', 'travail équipe', 'team player', 'team spirit', 'force proposition',
    'monter rapidement', 'nouveaux sujets', 'montée compétence', 'quick learner', 'fast learner', 'learn quickly', 'autodidact']);

/** Whether a name holds a word, or a run of words, of the qualities above. */
export function namesQuality(name) {
  const words = wordsOf(name);
  return QUALITIES.some((entry) => {
    const starts = entry.split(' ');
    return words.some((_, i) => starts.every((start, j) => words[i + j]?.startsWith(start)));
  });
}

/** The words of `text` of three characters or more, lower-cased, in canonical form. */
export function wordsOf(text) {
  return (canonical(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 3);
}

/** A crude stem: the first six characters ("conteneurs" and "conteneurisation" share one). */
export const stem = (word) => word.slice(0, 6);

/**
 * Whether the offer states a requirement the model names: the name itself, or
 * one of its content words in any inflection. "AWS" on an offer that never
 * says AWS is not stated; "Conteneurisation" on one that says "Conteneurs" is.
 */
export function statedIn(offer, name) {
  if (mentions(offer, name)) return true;
  const stems = new Set(wordsOf(offer).map(stem));
  return wordsOf(name).filter((word) => !STOP.has(word) && !GENERIC.has(word)).some((word) => stems.has(stem(word)));
}

/** Words at most in one example of an enumeration: a longer piece is prose. */
export const EXAMPLE_WORDS = 4;

/**
 * The offer's enumerations of examples: the text inside each pair of
 * parentheses holding two short items or more, separated by commas, "/",
 * "ou" or "or", "etc." aside ("(Claude Code, GitHub Copilot, BMad, etc.)").
 * One item ("(Postgres)") or prose is no enumeration.
 */
export function enumerations(offer) {
  return [...canonical(offer).matchAll(/\(([^()]*)\)/g)].map(([, inside]) => inside).filter((inside) => {
    const items = inside.split(/,|\/|\s(?:ou|or)\s/i).map((item) => item.trim()).filter((item) => item && !/^(?:etc\.?|\.\.\.|…)$/i.test(item));
    return items.length >= 2 && items.every((item) => item.split(/\s+/).length <= EXAMPLE_WORDS);
  });
}

/** Whether `text` mentions `term` as a whole word, ignoring case. */
export function mentions(text, term) {
  const escaped = canonical(term).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(canonical(text).toLowerCase());
}
