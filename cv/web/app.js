// itsaresume — the local page. Every text from the server or the model goes
// into the page through textContent: nothing here parses HTML or evaluates
// code (test/web.test.js keeps every such sink out of this file).

const token = document.querySelector('meta[name="csrf-token"]').content;
const $ = (id) => document.getElementById(id);
const MAX_TEXT = 60000;
const POLL_MS = 1500;

/** An element with text only: attrs are properties, children are nodes or strings. */
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('data-') || key.startsWith('aria-') || key === 'role') node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, body) {
  // The token goes with every call: in public mode it is also who the visitor is.
  const options = body === undefined
    ? { headers: { 'X-CSRF-Token': token } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(body) };
  const response = await fetch(path, { ...options, credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

/* ---------- Status ---------- */

function setPill(id, state, text) {
  const pill = $(id);
  pill.dataset.state = state;
  pill.textContent = text;
}

async function refreshStatus() {
  try {
    const { profile, router, layout, public: open } = await api('/api/status');
    // Public mode: a recruiter pastes one offer; splitting an email is the owner's.
    if (open) {
      $('split').hidden = true;
      $('drop-help').textContent = `Colle le texte d’une offre d’emploi : tu obtiens le CV de ${profile.name ?? 'ce candidat'} adapté à l’offre, et une évaluation honnête de l’adéquation. Une offre à la fois ; une offre déjà traitée est servie aussitôt.`;
    }
    if (profile.error) setPill('status-profile', 'bad', 'Profil invalide');
    else {
      const verified = profile.verdicts.verified ?? 0;
      setPill('status-profile', 'ok', `${profile.name} · ${profile.skills} compétences · ${verified} vérifiées`);
      $('status-profile').title = profile.truth ?? '';
    }
    setPill('status-router', router.up ? 'ok' : 'bad', router.up ? 'Routeur joignable' : 'Routeur injoignable');
    setPill('status-layout', layout.word ? 'ok' : 'warn', layout.word ? 'Word : PDF et page pleine' : 'Sans Word : DOCX seul');
  } catch (error) {
    setPill('status-profile', 'bad', `Statut indisponible : ${error.message}`);
  }
}

/* ---------- Offers ---------- */

const offers = [];

function showError(message) {
  const box = $('offers-error');
  box.hidden = !message;
  box.textContent = message ?? '';
}

function firstLine(text) {
  return (text.split('\n').find((line) => line.trim()) ?? 'Offre').replace(/^[\s/#*-]+/, '').slice(0, 80);
}

/**
 * Section headings an offer has once; twice in one text means two offers
 * pasted together, which would give one CV scored against both.
 */
const HEADINGS = [/^contexte\b/, /^missions? principales?\b/, /^responsabilit[ée]s\b/, /^profil (recherch[ée]|&)/, /^comp[ée]tences (attendues|recherch[ée]es|requises)\b/, /^description du poste\b/, /^informations mission\b/];

function repeatedHeading(text) {
  const lines = text.split('\n').map((line) => line.trim().toLowerCase().replace(/^[^\p{L}]+/u, ''));
  return HEADINGS.find((heading) => lines.filter((line) => heading.test(line)).length > 1);
}

function addOffer(text, title) {
  const clean = text.trim();
  if (!clean) return;
  if (repeatedHeading(clean)) {
    showError('Ce texte semble contenir plusieurs offres (une même rubrique y apparaît deux fois) : utilise « Détecter plusieurs offres », ou colle-les une par une.');
    return;
  }
  if (clean.length > MAX_TEXT) {
    showError(`Offre trop longue (${clean.length} caractères, ${MAX_TEXT} au plus).`);
    return;
  }
  offers.push({ text: clean, title: title || firstLine(clean) });
  renderOffers();
}

function renderOffers() {
  const list = $('offers');
  list.replaceChildren(...offers.map((offer, index) => {
    const title = h('input', { type: 'text', value: offer.title, maxLength: 80, 'aria-label': `Titre de l'offre ${index + 1}` });
    title.addEventListener('input', () => { offer.title = title.value; });
    const remove = h('button', { type: 'button', class: 'link', text: 'Retirer', 'aria-label': `Retirer l'offre ${index + 1}` });
    remove.addEventListener('click', () => {
      offers.splice(index, 1);
      renderOffers();
    });
    return h('li', { class: 'offer' }, title, remove, h('span', { class: 'meta', text: `${offer.text.split('\n').length} lignes · ${offer.text.length} caractères` }));
  }));
  const button = $('generate');
  button.disabled = offers.length === 0;
  button.textContent = offers.length > 1 ? `Générer les ${offers.length} CV` : 'Générer le CV';
}

async function readFiles(fileList) {
  for (const file of fileList) {
    if (file.size > MAX_TEXT * 4) {
      showError(`${file.name} : fichier trop gros.`);
      continue;
    }
    addOffer(await file.text(), file.name.replace(/\.(txt|md)$/i, ''));
  }
}

function setupOffers() {
  $('add').addEventListener('click', () => {
    showError(null);
    addOffer($('paste').value);
    $('paste').value = '';
  });
  $('split').addEventListener('click', async () => {
    showError(null);
    const text = $('paste').value;
    if (!text.trim()) return showError('Colle d’abord le texte à découper.');
    const button = $('split');
    button.disabled = true;
    button.textContent = 'Détection…';
    try {
      const found = await api('/api/split', { text });
      for (const offer of found.offers) addOffer(offer.text, offer.title);
      // Each repair says what happened: kept as one offer, or lines left out.
      if (found.repairs.length) showError(`Découpage : ${found.repairs.join(' ; ')}.`);
      $('paste').value = '';
    } catch (error) {
      showError(`Découpage impossible : ${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = 'Détecter plusieurs offres';
    }
  });
  const drop = $('drop');
  const input = $('files');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => readFiles(input.files).then(() => { input.value = ''; }));
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('over');
    readFiles(event.dataTransfer.files);
  });
  $('generate').addEventListener('click', async () => {
    showError(null);
    const batch = offers.splice(0, offers.length);
    renderOffers();
    try {
      await api('/api/jobs', { offers: batch.map(({ title, text }) => ({ title, text })) });
      poll();
    } catch (error) {
      offers.push(...batch);
      renderOffers();
      showError(`Génération refusée : ${error.message}`);
    }
  });
}

/* ---------- Jobs ---------- */

const STEPS = [
  ['listing', 'Lecture de l’offre'],
  ['analysis', 'Analyse'],
  ['layout', 'Mise en page'],
  ['pdf', 'PDF'],
  ['ats', 'Contrôle ATS'],
  ['done', 'Terminé'],
];
const QUALIFICATION = {
  qualified: ['ok', 'Qualifié'],
  partial: ['warn', 'Partiellement qualifié'],
  'not-qualified': ['bad', 'Non qualifié'],
};
const VERDICT = { strong: 'fort', good: 'bon', partial: 'partiel', weak: 'faible' };
const MATCH = { yes: ['ok', 'oui'], adjacent: ['warn', 'proche'], no: ['bad', 'non'] };
/** The code's gap labels, in the page's language. */
const GAP_LABELS = [[/ \(never claimed\)$/, ' (jamais revendiqué)'], [/ \(lab only\)$/, ' (lab uniquement)'], [/ \(to verify\)$/, ' (à vérifier)']];
const gapLabel = (gap) => GAP_LABELS.reduce((text, [pattern, label]) => text.replace(pattern, label), gap);
const details = new Map();
const cards = new Map();

function stepsOf(job) {
  const reached = new Map();
  for (const step of job.steps) reached.set(step.step, step);
  const last = job.steps.at(-1)?.step;
  return h('ol', { class: 'steps' }, STEPS.filter(([key]) => reached.has(key) || key === 'done').map(([key, label]) => {
    const step = reached.get(key);
    const extra = key === 'analysis' && step?.attempt > 1 ? ` (essai ${step.attempt})` : key === 'layout' && step ? ` (${step.layouts} mesures)` : '';
    const state = job.status === 'done' || (reached.has(key) && key !== last) ? 'done' : key === last && job.status === 'running' ? 'now' : '';
    return h('li', { class: state, text: label + extra });
  }));
}

function ring(score) {
  const node = h('div', { class: 'ring', role: 'img', 'aria-label': `Adéquation ${score} sur 100` },
    h('span', {}, String(score), h('small', { text: '/ 100' })));
  node.style.setProperty('--value', String(score));
  node.style.setProperty('--color', score >= 70 ? 'var(--ok)' : score >= 45 ? 'var(--warn)' : 'var(--bad)');
  return node;
}

function requirementsTable(requirements) {
  const rows = requirements.map((r) => {
    const [tone, label] = MATCH[r.match] ?? ['', r.match];
    const covered = r.never
      ? [h('span', { class: 'chip bad', text: 'jamais revendiqué' })]
      : r.skills.map((s) => h('span', { class: `chip ${s.lab ? 'lab' : ''}`, text: s.lab ? `${s.name} · lab` : s.name }));
    // A match no profile skill names is the model's reading: shown with its note, to verify.
    const judged = r.judged ? h('div', { class: 'quote', text: `à vérifier : ${r.note || 'rapprochement du modèle'}` }) : null;
    return h('tr', {}, h('td', { text: r.name }), h('td', { text: r.importance === 'must' ? 'requis' : 'souhaité' }),
      h('td', {}, h('span', { class: `chip ${tone}`, text: label })), h('td', {}, covered.length ? covered : '—', judged));
  });
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Exigence', 'Importance', 'Couverte', 'Par'].map((t) => h('th', { text: t })))),
    h('tbody', {}, rows)));
}

/**
 * Personal qualities are not scored: one the profile backs names its skills,
 * one it does not is to be shown in interview. Never a "no": the absence of
 * a line in the profile is not a verdict on the person.
 */
function qualitiesList(qualities) {
  return h('ul', { class: 'list' }, qualities.map((r) => h('li', {
    text: r.skills.length
      ? `${r.name} — appuyé par : ${r.skills.map((s) => s.name).join(', ')}`
      : `${r.name} — à montrer en entretien : ton profil n’en dit rien encore`,
  })));
}

function verification(items) {
  return h('ul', { class: 'list' }, items.map((item) => h('li', {},
    h('strong', { text: item.name }), ' — ',
    h('span', { class: `chip ${item.verdict === 'verified' ? 'ok' : item.verdict === 'self-declared' ? 'info' : 'warn'}`, text: item.verdict }),
    item.sources.slice(0, 2).map((s) => h('div', { class: 'quote', text: `${s.title} (${s.grade}) : « ${s.quote} »` })))));
}

function resultOf(job, detail) {
  const fit = detail.fit;
  const scored = detail.requirements.filter((r) => r.kind !== 'quality');
  const qualities = detail.requirements.filter((r) => r.kind === 'quality');
  const [qTone, qLabel] = QUALIFICATION[fit.qualification?.level] ?? ['', 'Qualification inconnue'];
  const gaps = fit.qualification?.gaps ?? [];
  const toConfirm = [
    ...detail.older.map((o) => `${o.requirement} : cité par ${o.sources.join(', ')}, absent du profil — à confirmer, puis ajouter au profil si vrai`),
    ...detail.flags,
  ];
  const layout = detail.layout ? `${detail.layout.pages.toFixed(2)} page(s)` : 'mise en page non mesurée';
  const ats = detail.ats ? (detail.ats.problems.length ? `ATS : ${detail.ats.problems.length} problème(s)` : 'ATS : texte lisible, dans l’ordre') : '';
  const downloads = detail.files.map((name) => h('a', {
    class: name === 'cv.pdf' ? 'main' : '',
    href: `/api/jobs/${job.id}/files/${name}`,
    download: '',
    text: { 'cv.pdf': 'CV (PDF)', 'cv.docx': 'CV (Word)', 'report.md': 'Rapport' }[name],
  }));
  return [
    h('div', { class: 'result' }, ring(fit.score), h('div', {},
      h('div', { class: 'verdict' },
        h('span', { class: `chip ${qTone}`, text: qLabel }),
        h('span', { class: 'chip', text: `adéquation ${VERDICT[fit.verdict] ?? fit.verdict}` }),
        h('span', { class: 'chip', text: `${layout}${ats ? ` · ${ats}` : ''}` })),
      h('p', { class: 'headline', text: detail.headline }),
      h('ul', { class: 'summary' }, detail.summary.map((s) => h('li', { text: s }))),
      gaps.length ? h('p', { class: 'gaps', text: `Écarts sur l’essentiel : ${gaps.map(gapLabel).join(', ')}` }) : null,
      detail.skipped ? h('p', { class: 'gaps', text: `Non fait : ${detail.skipped.reason}` }) : null)),
    h('div', { class: 'downloads' }, downloads),
    h('details', {}, h('summary', { text: `Exigences de l’offre (${scored.length})` }), requirementsTable(scored)),
    qualities.length ? h('details', {}, h('summary', { text: `Savoir-être, non notés (${qualities.length})` }), qualitiesList(qualities)) : null,
    toConfirm.length ? h('details', { open: true }, h('summary', { text: `À confirmer avant envoi (${toConfirm.length})` }),
      h('ul', { class: 'list' }, toConfirm.map((t) => h('li', { text: t })))) : null,
    h('details', {}, h('summary', { text: `Preuves des compétences affichées (${detail.verification.length})` }), verification(detail.verification)),
    detail.fit.rationale ? h('details', {}, h('summary', { text: 'Commentaire du modèle (non vérifié)' }), h('p', { class: 'quote', text: detail.fit.rationale })) : null,
    h('p', { class: 'help', text: `Répondu par ${detail.backend} en ${detail.attempts} essai(s).` }),
  ];
}

function renderJob(job) {
  let card = cards.get(job.id);
  if (!card) {
    card = h('article', { class: 'job', 'aria-label': job.title });
    cards.set(job.id, card);
    $('jobs').prepend(card);
  }
  const status = {
    queued: ['', 'en attente'],
    running: ['info', 'en cours'],
    done: ['ok', 'prêt'],
    failed: ['bad', 'échec'],
  }[job.status] ?? ['', job.status];
  const children = [h('div', { class: 'job-head' }, h('h3', { text: job.title }), h('span', { class: `chip ${status[0]}`, text: status[1] }))];
  if (job.status !== 'done') children.push(stepsOf(job));
  if (job.status === 'failed') children.push(h('p', { class: 'error', text: job.error ?? 'échec' }));
  const detail = details.get(job.id);
  if (detail) children.push(...resultOf(job, detail).filter(Boolean));
  card.replaceChildren(...children);
  $('jobs-empty').hidden = true;
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const jobs = await api('/api/jobs');
      for (const job of jobs) {
        if (job.status === 'done' && !details.has(job.id)) details.set(job.id, await api(`/api/jobs/${job.id}`));
        renderJob(job);
      }
      if (!jobs.some((job) => job.status === 'queued' || job.status === 'running')) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } catch (error) {
    showError(`Suivi interrompu : ${error.message}`);
  } finally {
    polling = false;
  }
}

setupOffers();
renderOffers();
refreshStatus();
poll();
