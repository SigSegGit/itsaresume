// 2.24b: the CV on a fixed A4 page, filled in the browser. The server sends
// only what the honesty checks allow, ranked (GET /api/jobs/:id/page); this
// script only chooses how many of those items fit, and the line spacing.
// It sets textContent only, never HTML. test/a4.test.js runs fill() over a
// fake sheet; the DOM part below runs only in a browser.
// 6.7: its notices through t() (web/i18n.js, loaded first by cv.html; the
// French key itself where it is not loaded, as in test/a4.test.js).
const t = globalThis.i18n?.t ?? ((key) => key);
//
// 2.61 (the owner, 2026-11-19): four options, read from the address and the
// toolbar, applied with no new model call: a linear or two-column layout, a
// highlight density for the offer's keywords, a detail level (how many items
// per experience, and the keywords each one already says) and one or two
// pages (two only when one page leaves ranked items out).

const SPACING = { min: 1, start: 1.15, max: 1.5, step: 0.05 };
const TARGET = 0.95;
/** Items per experience at detail 1 (concise). */
const CONCISE = 2;
// 4.x: the docx palettes (src/style.js, test/a4.test.js keeps them equal).
const PALETTES = {
  marine: { primary: '1B2A4A', accent: 'B8935A', light: 'EAE4D6' },
  bordeaux: { primary: '5B1A2A', accent: 'C28F5C', light: 'F1E6DA' },
  foret: { primary: '1F3A2E', accent: '7A9A5B', light: 'E6EDE3' },
  ardoise: { primary: '2F3E46', accent: '52796F', light: 'E3ECE8' },
  graphite: { primary: '222222', accent: '888888', light: 'EEEEEE' },
};
const DEFAULTS = { layout: 'linear', highlight: 1, detail: 2, pages: 1, palette: 'marine' };
const CHOICES = { layout: ['linear', 'columns'], highlight: [0, 1, 2, 3], detail: [1, 2, 3], pages: [1, 2], palette: Object.keys(PALETTES) };

const round = (value) => Math.round(value * 100) / 100;

/** The options from a query string; anything unknown falls back to its default (the run's palette first). */
function options(search, palette = null) {
  const params = new URLSearchParams(search);
  const chosen = {};
  const defaults = { ...DEFAULTS, ...(CHOICES.palette.includes(palette) ? { palette } : {}) };
  for (const [name, values] of Object.entries(CHOICES)) {
    const raw = params.get(name);
    const value = typeof values[0] === 'number' ? Number(raw) : raw;
    chosen[name] = raw !== null && values.includes(value) ? value : defaults[name];
  }
  return chosen;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A keyword as matched in the text: its " (lab)" mark dropped. */
const bare = (keyword) => keyword.replace(/ \(lab\)$/, '');
const pattern = (keywords) => {
  const words = [...new Set(keywords.map(bare).filter(Boolean))].sort((a, b) => b.length - a.length);
  return words.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
};

/** 2026-11-24: the offer's keywords the visible CV says (whole words), and the ones it leaves out. */
function keywordCoverage(keywords, text) {
  const covered = [];
  const missing = [];
  for (const keyword of [...new Set(keywords)]) {
    const regex = pattern([keyword]);
    (regex && regex.test(text) ? covered : missing).push(keyword);
  }
  return { covered, missing };
}

/**
 * The text cut into segments, `mark` on the offer's keywords: level 0 none,
 * 1 and 2 a keyword's first occurrence not yet in `seen` (the caller keeps
 * one `seen` for the page at 1, one per block at 2), 3 every occurrence.
 * The segments always join back to the text.
 */
function marks(text, keywords, level, seen) {
  const regex = level > 0 ? pattern(keywords) : null;
  if (!regex) return [{ text, mark: false }];
  const segments = [];
  let last = 0;
  for (const match of text.matchAll(regex)) {
    const key = match[0].toLowerCase();
    if (level < 3 && seen.has(key)) continue;
    seen.add(key);
    if (match.index > last) segments.push({ text: text.slice(last, match.index), mark: false });
    segments.push({ text: match[0], mark: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), mark: false });
  return segments;
}

/** The offer keywords the texts already say, in the keywords' order. */
function reused(texts, keywords) {
  const joined = texts.join('\n');
  return keywords.filter((keyword) => pattern([keyword])?.test(joined));
}

/**
 * Musts first (shrinking the spacing down to SPACING.min if they overflow),
 * then the other ranked items in rank order while the page holds them; at
 * detail 2 an item never makes its experience show more than the reference
 * (the docx's cap), it waits until the reference has grown; detail 1 keeps
 * CONCISE items per experience, detail 3 lifts the reference cap. Rank 0 that
 * is not a must never shows. Then, on one page, the spacing widens up to
 * SPACING.max while the page is under TARGET full. `left`: the ranked items
 * left out. sheet: show(id, on), bare(index, on), spacing(value), height(), box().
 */
function fill(page, sheet, { detail = DEFAULTS.detail, pages = DEFAULTS.pages } = {}) {
  const experiences = page.experiences.map((experience, index) => ({ ...experience, index, shown: new Set() }));
  const reference = experiences.find((experience) => experience.reference) ?? experiences[0];
  const set = (experience, item, on) => {
    if (on) experience.shown.add(item.id);
    else experience.shown.delete(item.id);
    sheet.show(item.id, on);
    sheet.bare(experience.index, experience.shown.size === 0);
  };
  const fits = () => sheet.height() <= sheet.box();
  const ratio = () => round(sheet.height() / sheet.box());
  const room = (experience) => {
    if (detail === 1) return experience.shown.size < CONCISE;
    if (detail === 3) return true;
    return experience === reference || experience.shown.size < reference.shown.size;
  };

  let spacing = SPACING.start;
  sheet.spacing(spacing);
  for (const experience of experiences) {
    sheet.bare(experience.index, true);
    for (const item of experience.items) if (item.must) set(experience, item, true);
  }
  const pending = experiences
    .flatMap((experience) => experience.items.filter((item) => !item.must && item.rank > 0).map((item) => ({ experience, item })))
    .sort((a, b) => a.item.rank - b.item.rank);
  let shrunk = false;
  while (!fits() && spacing > SPACING.min) {
    spacing = round(spacing - SPACING.step);
    sheet.spacing(spacing);
    shrunk = true;
  }
  if (!fits()) return { spacing, shrunk: true, overflow: true, fill: ratio(), left: pending.length };

  for (;;) {
    const next = pending.findIndex(({ experience }) => room(experience));
    if (next < 0) break;
    const [{ experience, item }] = pending.splice(next, 1);
    set(experience, item, true);
    if (!fits()) {
      set(experience, item, false);
      pending.unshift({ experience, item });
      break;
    }
  }
  // detail 1 leaves items out by choice, not for lack of room.
  const left = detail === 1 ? 0 : pending.length;

  while (pages === 1 && !shrunk && ratio() < TARGET && spacing < SPACING.max) {
    const wider = round(spacing + SPACING.step);
    sheet.spacing(wider);
    if (!fits()) {
      sheet.spacing(spacing);
      break;
    }
    spacing = wider;
  }
  return { spacing, shrunk, overflow: false, fill: ratio(), left };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Lays the whole page out, every item hidden; fill() then shows some. */
function render(page, sheet, chosen = DEFAULTS) {
  // The sheet's height is fixed, so its scrollHeight never drops below its
  // box: the fill is measured on an inner block that grows with the content.
  const root = element('div', 'content');
  sheet.replaceChildren(root);
  sheet.classList.toggle('columns', chosen.layout === 'columns');
  sheet.classList.toggle('pages-2', chosen.pages === 2);
  sheet.classList.toggle('dense', chosen.highlight === 3);
  const colours = PALETTES[chosen.palette] ?? PALETTES.marine;
  for (const [role, hex] of Object.entries(colours)) sheet.style?.setProperty?.(`--${role}`, `#${hex}`);
  const padding = () => {
    const style = getComputedStyle(sheet);
    return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  };
  const keywords = page.keywords ?? [];
  const pageSeen = new Set();
  /** A text node set, its keywords in <strong class="kw">, by textContent only. */
  const said = (tag, className, text, seen = pageSeen) => {
    const node = element(tag, className);
    for (const segment of marks(text, keywords, chosen.highlight, chosen.highlight === 1 ? pageSeen : seen)) {
      node.append(segment.mark ? element('strong', 'kw', segment.text) : document.createTextNode(segment.text));
    }
    return node;
  };
  const items = new Map();
  const experiences = [];
  const header = element('header', 'top');
  const main = element('div', 'main');
  const side = element('aside', 'side');
  const section = (parent, label, ...children) => {
    const block = element('section');
    block.append(element('h2', '', label), ...children);
    parent.append(block);
  };
  const list = (texts) => {
    const ul = element('ul');
    for (const text of texts) ul.append(element('li', '', text));
    return ul;
  };
  header.append(element('h1', '', page.name), element('p', 'headline', page.headline), element('p', 'contact', page.contact));
  root.append(header, main);
  if (chosen.layout === 'columns') root.append(side);
  const rest = chosen.layout === 'columns' ? side : main;
  const profileSeen = new Set();
  section(main, page.labels.profile, ...page.profile.map((text) => said('p', '', text, profileSeen)));
  const skills = element('dl', 'skills');
  for (const group of page.skill_groups) skills.append(element('dt', '', group.title), element('dd', '', group.items.join(', ')));
  // Columns: the skills lead the side column; linear: they follow the profile.
  section(chosen.layout === 'columns' ? side : main, page.labels.skills, skills);
  const work = element('section');
  work.append(element('h2', '', page.labels.experience));
  for (const experience of page.experiences) {
    const seen = new Set();
    const block = element('article', 'experience');
    const title = element('span', 'title', experience.title);
    const env = chosen.detail === 1 || !experience.env ? element('p', 'env', '') : said('p', 'env', page.labels.env + experience.env, seen);
    const ul = element('ul');
    const head = element('div', 'head');
    head.append(title, element('span', 'org', ` — ${experience.org}`), element('span', 'dates', experience.dates));
    block.append(head, ul, env);
    for (const item of experience.items) {
      const li = said('li', '', item.text, seen);
      li.hidden = true;
      items.set(item.id, li);
      ul.append(li);
    }
    // Detail 3: the offer's keywords this experience already says, said again.
    const words = chosen.detail === 3 ? reused([...experience.items.map((item) => item.text), experience.env ?? ''], keywords) : [];
    const tags = element('p', 'tags', words.length ? (page.labels.keywords ?? 'Keywords: ') + words.join(', ') : '');
    tags.hidden = !words.length;
    block.append(tags);
    experiences.push({ experience, block, title, env, tags, words });
    work.append(block);
  }
  main.append(work);
  if (page.education.length) section(rest, page.labels.education, list(page.education.map((school) => [school.title, ...school.details].join(' — '))));
  if (page.certifications.length) section(rest, page.labels.certifications, list(page.certifications));
  if (page.languages.length) section(rest, page.labels.languages, list(page.languages));
  // 2.50: how the CV was made, at the foot of the page.
  if (page.made_by) root.append(element('footer', 'made-by', page.made_by));
  return {
    show: (id, on) => { items.get(id).hidden = !on; },
    // An experience with no item shown: what the docx does (when_empty).
    bare: (index, on) => {
      const { experience, block, title, env, tags, words } = experiences[index];
      const empty = on ? experience.when_empty : undefined;
      block.hidden = empty === null;
      title.textContent = empty ? empty.title : experience.title;
      env.hidden = Boolean(empty) || !experience.env || chosen.detail === 1;
      tags.hidden = Boolean(empty) || !words.length;
    },
    spacing: (value) => sheet.style.setProperty('--spacing', String(value)),
    height: () => root.offsetHeight + padding(),
    box: () => sheet.clientHeight,
  };
}

async function start() {
  const notice = document.getElementById('notice');
  const sheet = document.getElementById('sheet');
  const say = (text) => {
    notice.textContent = text;
    notice.hidden = !text;
  };
  document.getElementById('print').addEventListener('click', () => window.print());
  // 2026-11-24: the CV as plain text, for the forms that want it pasted.
  const copy = document.getElementById('copy-text');
  copy?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(sheet.innerText);
      copy.textContent = t('Copié !');
    } catch {
      copy.textContent = t('Copie impossible : sélectionnez le texte à la main.');
    }
  });
  const job = new URLSearchParams(location.search).get('job') ?? '';
  const response = await fetch(`/api/jobs/${encodeURIComponent(job)}/page`);
  if (!response.ok) return say(t('CV introuvable : relancez la génération depuis la page d’accueil.'));
  const page = await response.json();
  await document.fonts?.ready;
  const controls = Object.fromEntries(Object.keys(CHOICES).map((name) => [name, document.getElementById(name)]));
  const draw = () => {
    const chosen = options(location.search, page.palette);
    for (const [name, control] of Object.entries(controls)) if (control) control.value = String(chosen[name]);
    const notes = [];
    let result;
    if (chosen.pages === 2) {
      // Two pages only when one page leaves ranked items out.
      const one = fill(page, render(page, sheet, { ...chosen, pages: 1 }), { ...chosen, pages: 1 });
      if (one.left === 0 && !one.overflow) {
        result = one;
        notes.push(t('Tout tient sur une page : la deuxième page n’apporterait rien.'));
      }
    }
    result ??= fill(page, render(page, sheet, chosen), chosen);
    if (result.overflow) notes.push(t('Le contenu obligatoire dépasse la page, même à l’interligne minimal.'));
    else if (result.shrunk) notes.push(t('Le contenu obligatoire ne tenait qu’en resserrant l’interligne.'));
    say(notes.join(' '));
    // 2026-11-24: what the visible CV says of the offer's keywords.
    const coverage = document.getElementById('coverage');
    if (coverage && page.keywords?.length) {
      const { covered, missing } = keywordCoverage(page.keywords ?? [], sheet.innerText);
      coverage.textContent = t('Mots-clés de l’offre présents dans le CV : {v0}/{v1}', { v0: covered.length, v1: covered.length + missing.length })
        + (missing.length ? ` — ${t('absents')} : ${missing.join(', ')}` : '');
      coverage.hidden = false;
    }
  };
  for (const [name, control] of Object.entries(controls)) {
    control?.addEventListener('input', () => {
      const params = new URLSearchParams(location.search);
      params.set(name, control.value);
      history.replaceState(null, '', `?${params}`);
      draw();
    });
  }
  draw();
}

if (typeof document !== 'undefined') start();
