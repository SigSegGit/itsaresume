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
  interpersonal posture interagir interact bienveillan empath créativ creativ diplomat teamwork
  collabor coopér cooperat dynamis dynamism sérieu ponctu punctual motiv proactiv initiative impliqu enthousias`.split(/\s+/)
  .concat(['esprit équipe', 'travail équipe', 'team player', 'team spirit', 'force proposition',
    'monter rapidement', 'nouveaux sujets', 'montée compétence', 'quick learner', 'fast learner', 'learn quickly', 'autodidact'])
  .concat(['binôm', 'binom', 'pair work'])
  // 2.27: working with a team is the collaboration, not its technology.
  .concat(['travailler avec', 'travail avec', 'en lien avec', 'work with', 'working with', 'inter équipe']);

/**
 * Administrative conditions (2026-10-02: "Nationalité française", "Profil
 * habilitable" shown as failed): a status the candidate confirms, not a skill.
 */
export const CONDITIONS = `nationalit citoyen citizen habilit clearance permis visa`.split(/\s+/)
  .concat(['work permit', 'driving licen', 'right work']);

/** Whether a name holds a word, or a run of words, of the conditions above. */
export function namesCondition(name) {
  return holds(name, CONDITIONS);
}

/** Whether a name holds a word, or a run of words, of the qualities above. */
export function namesQuality(name) {
  return holds(name, QUALITIES);
}

function holds(name, entries) {
  const words = wordsOf(name);
  return entries.some((entry) => {
    const starts = entry.split(' ');
    return words.some((_, i) => starts.every((start, j) => words[i + j]?.startsWith(start)));
  });
}

/** The words of `text` of three characters or more, lower-cased, in canonical form. */
export function wordsOf(text) {
  return (canonical(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 3);
}

/**
 * Endings an inflection or a derivation adds (FR/EN), longest first. The
 * six-letter prefix this replaced made "product" and "production" one word
 * (2.9); endings keep "conteneurs" and "conteneurisation" one.
 */
const ENDINGS = [
  ['imentée', ''], ['isation', ''], ['ization', ''], ['imenté', ''], ['ateur', 'at'], ['ience', ''], ['ation', 'at'], ['ement', ''], ['ator', 'at'], ['ated', 'at'],
  ['iser', ''], ['ment', ''], ['tion', ''], ['ate', 'at'], ['ure', ''], ['ing', ''], ['ées', ''], ['ée', ''], ['és', ''], ['er', ''], ['ed', ''], ['é', ''], ['e', ''],
];
/** A root shorter than this is not cut ("gestion" stays whole). */
const MIN_ROOT = 4;

/**
 * The word without its plural and its ending: "automation", "automated",
 * "automatiser" are one; "production" and "product" are two.
 */
export function stem(word) {
  const root = word.length > MIN_ROOT && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
  const found = ENDINGS.find(([end]) => root.endsWith(end) && root.length - end.length >= MIN_ROOT);
  return found ? root.slice(0, -found[0].length) + found[1] : root;
}

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

/**
 * The offer's alternatives outside parentheses (2.26b): short items one
 * clause joins by commas and at least one "ou" / "or" ("AWS, Azure ou
 * GCP"). "et" / "and" ends a run: "Linux, Terraform et Kubernetes ou
 * OpenShift" gives "Kubernetes ou OpenShift" only, and a comma after the
 * "ou" ends it too ("Docker ou Podman, Ansible"). A run's first item keeps
 * its last EXAMPLE_WORDS words ("Maîtrise de Python ou Go"); a longer later
 * item is prose and ends the run.
 */
export function alternatives(offer) {
  const found = [];
  for (const clause of canonical(offer).split(/[\n;:()]|\.(?=\s|$)/)) {
    const pieces = clause.split(/(,|\s(?:ou|or|et|and)\s)/i);
    let run = [];
    let either = false;
    const close = () => {
      if (either && run.length >= 2) found.push(run.join(', '));
      run = [];
      either = false;
    };
    for (let i = 0; i < pieces.length; i += 2) {
      const words = pieces[i].trim().split(/\s+/).filter(Boolean);
      const before = (pieces[i - 1] ?? '').trim().toLowerCase();
      if (before === 'et' || before === 'and' || (either && before === ',')) close();
      if (words.length === 0 || (run.length > 0 && words.length > EXAMPLE_WORDS)) {
        close();
        if (words.length === 0) continue;
      }
      run.push(words.slice(-EXAMPLE_WORDS).join(' '));
      if (before === 'ou' || before === 'or') either = true;
    }
    close();
  }
  return found;
}

/** Whether `text` mentions `term` as a whole word, ignoring case. */
export function mentions(text, term) {
  const escaped = canonical(term).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(canonical(text).toLowerCase());
}
