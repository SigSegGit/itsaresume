// 2.24b: the CV on a fixed A4 page, filled in the browser. The server sends
// only what the honesty checks allow, ranked (GET /api/jobs/:id/page); this
// script only chooses how many of those items fit, and the line spacing.
// It sets textContent only, never HTML. test/a4.test.js runs fill() over a
// fake sheet; the DOM part below runs only in a browser.

const SPACING = { min: 1, start: 1.15, max: 1.5, step: 0.05 };
const TARGET = 0.95;

const round = (value) => Math.round(value * 100) / 100;

/**
 * Musts first (shrinking the spacing down to SPACING.min if they overflow),
 * then the other ranked items in rank order while the page holds them; an
 * item never makes its experience show more than the reference (the docx's
 * cap), it waits until the reference has grown. Rank 0 that is not a must
 * never shows. Then the spacing widens up to SPACING.max while the page is
 * under TARGET full. sheet: show(id, on), bare(index, on), spacing(value),
 * height(), box().
 */
function fill(page, sheet) {
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

  let spacing = SPACING.start;
  sheet.spacing(spacing);
  for (const experience of experiences) {
    sheet.bare(experience.index, true);
    for (const item of experience.items) if (item.must) set(experience, item, true);
  }
  let shrunk = false;
  while (!fits() && spacing > SPACING.min) {
    spacing = round(spacing - SPACING.step);
    sheet.spacing(spacing);
    shrunk = true;
  }
  if (!fits()) return { spacing, shrunk: true, overflow: true, fill: ratio() };

  const pending = experiences
    .flatMap((experience) => experience.items.filter((item) => !item.must && item.rank > 0).map((item) => ({ experience, item })))
    .sort((a, b) => a.item.rank - b.item.rank);
  for (;;) {
    const next = pending.findIndex(({ experience }) => experience === reference || experience.shown.size < reference.shown.size);
    if (next < 0) break;
    const [{ experience, item }] = pending.splice(next, 1);
    set(experience, item, true);
    if (!fits()) {
      set(experience, item, false);
      break;
    }
  }

  while (!shrunk && ratio() < TARGET && spacing < SPACING.max) {
    const wider = round(spacing + SPACING.step);
    sheet.spacing(wider);
    if (!fits()) {
      sheet.spacing(spacing);
      break;
    }
    spacing = wider;
  }
  return { spacing, shrunk, overflow: false, fill: ratio() };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Lays the whole page out, every item hidden; fill() then shows some. */
function render(page, root) {
  const items = new Map();
  const experiences = [];
  const section = (label, ...children) => {
    const block = element('section');
    block.append(element('h2', '', label), ...children);
    root.append(block);
  };
  const list = (texts) => {
    const ul = element('ul');
    for (const text of texts) ul.append(element('li', '', text));
    return ul;
  };
  root.replaceChildren(element('h1', '', page.name), element('p', 'headline', page.headline), element('p', 'contact', page.contact));
  section(page.labels.profile, ...page.profile.map((text) => element('p', '', text)));
  const skills = element('dl', 'skills');
  for (const group of page.skill_groups) skills.append(element('dt', '', group.title), element('dd', '', group.items.join(', ')));
  section(page.labels.skills, skills);
  const work = element('section');
  work.append(element('h2', '', page.labels.experience));
  for (const experience of page.experiences) {
    const block = element('article', 'experience');
    const title = element('span', 'title', experience.title);
    const env = element('p', 'env', experience.env ? page.labels.env + experience.env : '');
    const ul = element('ul');
    block.append(element('span', 'dates', experience.dates), title, element('span', 'org', ` — ${experience.org}`), ul, env);
    for (const item of experience.items) {
      const li = element('li', '', item.text);
      li.hidden = true;
      items.set(item.id, li);
      ul.append(li);
    }
    experiences.push({ experience, block, title, env });
    work.append(block);
  }
  root.append(work);
  if (page.education.length) section(page.labels.education, list(page.education.map((school) => [school.title, ...school.details].join(' — '))));
  if (page.certifications.length) section(page.labels.certifications, list(page.certifications));
  if (page.languages.length) section(page.labels.languages, list(page.languages));
  return {
    show: (id, on) => { items.get(id).hidden = !on; },
    // An experience with no item shown: what the docx does (when_empty).
    bare: (index, on) => {
      const { experience, block, title, env } = experiences[index];
      const empty = on ? experience.when_empty : undefined;
      block.hidden = empty === null;
      title.textContent = empty ? empty.title : experience.title;
      env.hidden = Boolean(empty) || !experience.env;
    },
    spacing: (value) => root.style.setProperty('--spacing', String(value)),
    height: () => root.scrollHeight,
    box: () => root.clientHeight,
  };
}

async function start() {
  const notice = document.getElementById('notice');
  const sheet = document.getElementById('sheet');
  const say = (text) => {
    notice.textContent = text;
    notice.hidden = false;
  };
  document.getElementById('print').addEventListener('click', () => window.print());
  const job = new URLSearchParams(location.search).get('job') ?? '';
  const response = await fetch(`/api/jobs/${encodeURIComponent(job)}/page`);
  if (!response.ok) return say('CV introuvable : relancez la génération depuis la page d’accueil.');
  const page = await response.json();
  await document.fonts?.ready;
  const result = fill(page, render(page, sheet));
  if (result.overflow) say('Le contenu obligatoire dépasse la page, même à l’interligne minimal.');
  else if (result.shrunk) say('Le contenu obligatoire ne tenait qu’en resserrant l’interligne.');
}

if (typeof document !== 'undefined') start();
