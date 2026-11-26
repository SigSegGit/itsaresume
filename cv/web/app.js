// itsaresume — the local page. Every text from the server or the model goes
// into the page through textContent: nothing here parses HTML or evaluates
// code (test/web.test.js keeps every such sink out of this file).

// 6.7: every text through t() (web/i18n.js, loaded first); the French is the key.
const { t } = globalThis.i18n;
const token = document.querySelector('meta[name="csrf-token"]').content;
const $ = (id) => document.getElementById(id);
const MAX_TEXT = 60000;
// A job's progress seen 5 s late costs nothing (a local model runs for
// minutes); a tab out of sight asks nothing until it is back.
const POLL_MS = 5000;
const MODEL_NAMES = { auto: 'auto', claude: t('Claude seul'), local: t('IA locale seule') };
// 6.7: the server's notes on a model (src/models.js) are French; those with a
// time in them are read through their pattern.
const NOTE_PATTERNS = [
  [/^limite atteinte, levée à (.+)$/, 'limite atteinte, levée à {at}'], // i18n: key
  [/^limite d’usage atteinte à (.+)$/, 'limite d’usage atteinte à {at}'], // i18n: key
  [/^limite atteinte à (.+), peut-être levée$/, 'limite atteinte à {at}, peut-être levée'], // i18n: key
];
function noteText(note) {
  for (const [pattern, key] of NOTE_PATTERNS) {
    const match = pattern.exec(note);
    if (match) return t(key, { at: match[1] });
  }
  return t(note);
}
const seconds = (ms) => (Number.isFinite(ms) ? `${Math.round(ms / 1000)} s` : t('durée inconnue'));

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

/* 8.43: the menu follows the router: a model that cannot answer is greyed
   with the server's note; the default is set once, and again when the chosen
   model goes away. Nothing can answer: no generation. */
// 2.22c-link: the questions are the owner's, on the local page only.
let local = false;
let modelChosen = false;
let modelsReady = true;
function applyModels(models) {
  if (!models) return;
  const select = $('model');
  for (const option of select.options) {
    const state = models.options[option.value];
    if (!state) continue;
    option.dataset.label ??= option.textContent;
    // 2.34 (the owner, 2026-11-10): what cannot answer stays in sight, greyed with its reason.
    option.disabled = !state?.available;
    option.textContent = state.note ? `${option.dataset.label} (${noteText(state.note)})` : option.dataset.label;
  }
  if ((!modelChosen || !models.options[select.value]?.available) && models.default) select.value = models.default;
  modelsReady = models.default !== null;
  renderOffers();
}

/** 4.12: the templates and palettes as a person reads them. */
const STYLE_LABELS = { 'two-column': t('Deux colonnes'), linear: t('Linéaire'), marine: t('Marine'), bordeaux: 'Bordeaux', foret: t('Forêt'), ardoise: t('Ardoise'), graphite: 'Graphite' };

/** 2.47: the public page's pitch to a recruiter: whose CV, his role, a sample. */
function showPitch(profile) {
  if (!$('pitch').hidden) return;
  $('pitch').hidden = false;
  if (profile?.name) $('pitch-name').textContent = profile.name;
  if (profile?.title) {
    $('pitch-role').textContent = profile.title;
    $('pitch-role').hidden = false;
  }
  $('sample').addEventListener('click', async () => {
    const { SAMPLE_OFFER } = await import('/sample-offer.js');
    $('paste').value = SAMPLE_OFFER;
    // "auto" answers it from its past run: no model call after the first one.
    if (!$('model').querySelector('option[value="auto"]')?.disabled) $('model').value = 'auto';
    renderOffers();
    $('generate').click();
  });
}

/* 2026-11-24: the owner's applications, one per run folder (src/applications.js). */
const channelLabel = (channel) => ({ linkedin: 'LinkedIn', email: t('E-mail'), site: t('Site'), phone: t('Téléphone'), other: t('Autre') })[channel] ?? channel;
const statusLabel = (status) => ({ todo: t('À envoyer'), sent: t('Envoyée'), interview: t('Entretien'), offer: t('Offre reçue'), rejected: t('Refusée') })[status] ?? status;
let applicationsShown = false;
async function showApplications() {
  if (applicationsShown) return;
  let data;
  try {
    data = await api('/api/applications');
  } catch {
    return;
  }
  applicationsShown = true;
  $('applications-card').hidden = data.rows.length === 0;
  const filter = $('applications-filter');
  filter.replaceChildren(h('option', { value: '', text: t('Toutes') }), ...data.statuses.map((status) => h('option', { value: status, text: statusLabel(status) })));
  const counts = data.summary;
  $('applications-summary').textContent = t('{v0} candidatures · {v1} envoyées · {v2} entretiens ({v3}) · {v4} à relancer', { v0: counts.total, v1: counts.sent, v2: counts.interviews, v3: counts.rate == null ? '–' : `${counts.rate} %`, v4: counts.followUps });
  $('applications-weekly').textContent = t('Envoyées par semaine : {v0}', { v0: data.weekly.map((week) => `${week.week.slice(5)} ${week.sent}`).join(' · ') });
  const rows = data.rows.map((row) => {
    const select = h('select', { 'aria-label': t('Statut') }, data.statuses.map((status) => h('option', { value: status, text: statusLabel(status), ...(status === row.status ? { selected: true } : {}) })));
    const note = h('input', { type: 'text', value: row.note, maxLength: 500, placeholder: t('Remarque'), 'aria-label': t('Remarque') });
    const contact = h('input', { type: 'text', value: row.contact ?? '', maxLength: 120, placeholder: t('Contact'), 'aria-label': t('Contact') });
    const channel = h('select', { 'aria-label': t('Canal') }, ['', 'linkedin', 'email', 'site', 'phone', 'other'].map((value) => h('option', { value, text: value ? channelLabel(value) : '—', ...(value === (row.channel ?? '') ? { selected: true } : {}) })));
    const draft = h('button', { type: 'button', class: 'link', text: t('Brouillon de relance') });
    draft.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText((await api(`/api/applications/${encodeURIComponent(row.run)}/follow-up?lang=${lang}`)).text);
        draft.textContent = t('Copié !');
      } catch (failure) {
        showError(failure.message);
      }
    });
    const save = async () => {
      try {
        Object.assign(row, await api(`/api/applications/${encodeURIComponent(row.run)}`, { status: select.value, note: note.value, contact: contact.value, channel: channel.value }));
        tr.dataset.status = row.status;
      } catch (failure) {
        showError(failure.message);
      }
    };
    select.addEventListener('change', save);
    note.addEventListener('change', save);
    contact.addEventListener('change', save);
    channel.addEventListener('change', save);
    const tr = h('tr', { 'data-status': row.status },
      h('td', { text: row.date }),
      h('td', {}, row.title, ' ', row.follow_up ? h('span', { class: 'chip warn', text: t('À relancer') }) : null,
        ...row.files.map((file) => h('a', { class: 'cv-file', href: `/api/applications/${encodeURIComponent(row.run)}/${file}`, download: file, text: file.endsWith('.pdf') ? 'PDF' : 'Word' }))), h('td', { text: row.score == null ? '' : `${row.score}/100` }), h('td', {}, select, ' ', channel), h('td', {}, note, contact, row.status === 'sent' ? draft : null));
    return tr;
  });
  $('applications-rows').replaceChildren(...rows);
  filter.addEventListener('change', () => {
    for (const tr of rows) tr.hidden = Boolean(filter.value) && tr.dataset.status !== filter.value;
  });
}

/* 2026-11-24: the opinions people gave on their CVs, on the owner's page only. */
async function showFeedback() {
  let entries = [];
  try {
    entries = await api('/api/feedback');
  } catch {
    return;
  }
  $('feedback-card').hidden = entries.length === 0;
  $('feedback-list').replaceChildren(...entries.slice(0, 50).map((entry) => h('li', {},
    h('strong', { text: `${'★'.repeat(entry.rating)}${'☆'.repeat(5 - entry.rating)}` }),
    ` ${String(entry.at).slice(0, 10)} · ${entry.invite ?? t('sans invitation')} · ${entry.title ?? ''}`,
    entry.comment ? h('p', { text: entry.comment }) : null)));
}

let ownTabOffered = false;
async function refreshStatus() {
  try {
    const { profile, profiles, router, models, layout, public: open, styles, service, invited, customer_budget: budget } = await api('/api/status');
    // 4.12: the CV's template and palette, the default selected.
    if (styles) {
      const fill = (id, names, chosen) => $(id).replaceChildren(...names.map((name) => h('option', { value: name, text: STYLE_LABELS[name] ?? name, ...(name === chosen ? { selected: true } : {}) })));
      fill('template', styles.templates, styles.default.template);
      fill('palette', styles.palettes, styles.default.palette);
      $('style-row').hidden = false;
    }
    local = !open;
    if (!open) showApplications();
    $('questions-link').hidden = Boolean(open);
    if (!open) showFeedback();
    applyModels(models);
    // 4.1: several profiles (the owner's --profiles): choose the one to tailor to.
    if (!open && profiles?.length > 1 && $('profile-row').hidden) {
      $('profile').replaceChildren(...profiles.map((id) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        return option;
      }));
      $('profile-row').hidden = false;
    }
    // Public mode: a recruiter pastes one offer; splitting an email is the owner's.
    if (open) {
      showPitch(profile);
      $('split').hidden = true;
      $('add').hidden = true;
      $('status-router').hidden = true;
      $('status-layout').hidden = true;
      $('foot-owner').textContent = t('Aucune candidature envoyée, rien de conservé hors du CV généré · l’offre est analysée par une IA sous contrôle du code · zéro facturation au token');
      rankAllowed = false;
      $('import-row').hidden = true;
      // 2026-11-24: in service mode a visitor brings their own profile (files only).
      $('sources-card').hidden = !service;
      $('links-row').hidden = true;
      $('tab-stored').textContent = t('CV de {v0}', { v0: profile.name ?? t('ce candidat') });
      $('tab-sources').textContent = t('Mon propre profil');
      // A person invited from LinkedIn came for their own CV: that tab first, once.
      if (service && invited && !ownTabOffered) {
        ownTabOffered = true;
        $('tab-sources').click();
      }
      $('drop-help').textContent = t('Colle le texte d’une offre d’emploi : tu obtiens le CV de {v0} adapté à l’offre, et une évaluation honnête de l’adéquation. Une offre à la fois ; une offre déjà traitée est servie aussitôt.', { v0: profile.name ?? 'ce candidat' });
    }
    if (profile.error) setPill('status-profile', 'bad', t('Profil invalide'));
    else {
      // Public mode serves no assessment (verdicts, truth): the owner's.
      const verified = profile.verdicts ? t(' · {v0} vérifiées', { v0: profile.verdicts.verified ?? 0 }) : '';
      setPill('status-profile', 'ok', t('{v0} · {v1} compétences{v2}', { v0: profile.name, v1: profile.skills, v2: verified }));
      $('status-profile').title = profile.truth ?? '';
    }
    setPill('status-router', router.up ? 'ok' : 'bad', router.up ? t('Routeur joignable') : t('Routeur injoignable'));
    // 2026-11-24: customers' spend today against the router's ceilings.
    $('status-customers').hidden = !budget;
    if (budget) {
      const full = (budget.requests_limit != null && budget.requests >= budget.requests_limit) || (budget.tokens_limit != null && budget.tokens >= budget.tokens_limit);
      setPill('status-customers', full ? 'bad' : 'ok', t('Clients aujourd’hui : {v0}/{v1} requêtes', { v0: budget.requests, v1: budget.requests_limit ?? '∞' }));
    }
    setPill('status-layout', layout.word || layout.libre ? 'ok' : 'warn', layout.word ? t('Word : PDF et page pleine') : layout.libre ? t('LibreOffice : PDF et page pleine') : t('Sans moteur de mise en page : DOCX seul'));
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
  return (text.split('\n').find((line) => line.trim()) ?? t('Offre')).replace(/^[\s/#*-]+/, '').slice(0, 80);
}

/**
 * Section headings an offer has once; twice in one text means two offers
 * pasted together, which would give one CV scored against both.
 */
// 2.53: no skills heading here: one offer repeats "Compétences attendues" per domain.
const HEADINGS = [/^contexte\b/, /^missions? principales?\b/, /^responsabilit[ée]s\b/, /^profil (recherch[ée]|&)/, /^description du poste\b/, /^informations mission\b/];

function repeatedHeading(text) {
  const lines = text.split('\n').map((line) => line.trim().toLowerCase().replace(/^[^\p{L}]+/u, ''));
  return HEADINGS.find((heading) => lines.filter((line) => heading.test(line)).length > 1);
}

function addOffer(text, title) {
  const clean = text.trim();
  if (!clean) return;
  if (repeatedHeading(clean)) {
    showError(t('Ce texte semble contenir plusieurs offres (une même rubrique y apparaît deux fois) : utilise « Détecter plusieurs offres », ou colle-les une par une.'));
    return;
  }
  if (clean.length > MAX_TEXT) {
    showError(t('Offre trop longue ({v0} caractères, {v1} au plus).', { v0: clean.length, v1: MAX_TEXT }));
    return;
  }
  offers.push({ text: clean, title: title || firstLine(clean) });
  renderOffers();
}

// 5.2b: the owner's page ranks the waiting offers (no analysis), keeps the best.
const RANK_TOP = 3;
/** A button busy while `work` runs; its error shown, its label back. */
async function withButton(id, busy, work) {
  showError(null);
  const button = $(id);
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busy;
  try {
    await work();
  } catch (error) {
    showError(`${label} : ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}
/** One line: each ranked row, chosen or not, its share and estimated tokens. */
function showRanking(what, rows) {
  const list = rows.map((row) => `${row.chosen ? '✓' : '✗'} ${row.name} ${Math.round(row.share * 100)} % (~${row.tokens} tokens)`).join(' · ');
  $('rank-result').textContent = (what === 'profils' ? t('Classement des profils par couverture : {rows}', { rows: list }) : t('Classement des offres par couverture : {rows}', { rows: list }));
  $('rank-result').hidden = false;
}
let rankAllowed = true;

function renderOffers() {
  const list = $('offers');
  list.replaceChildren(...offers.map((offer, index) => {
    // 2.31a: the name names the run and its folder; optional, the first line by default.
    const title = h('input', { type: 'text', value: offer.title, maxLength: 80, placeholder: t('Nom de l’offre (facultatif)'), title: t('Nom du run, modifiable : il nomme aussi son dossier'), 'aria-label': t('Nom de l’offre {n} (facultatif)', { n: index + 1 }) });
    title.addEventListener('input', () => { offer.title = title.value; });
    const remove = h('button', { type: 'button', class: 'link', text: t('Retirer'), 'aria-label': t('Retirer l’offre {n}', { n: index + 1 }) });
    remove.addEventListener('click', () => {
      offers.splice(index, 1);
      renderOffers();
    });
    return h('li', { class: 'offer' }, title, remove, h('span', { class: 'meta', text: t('{v0} lignes · {v1} caractères', { v0: offer.text.split('\n').length, v1: offer.text.length }) }));
  }));
  $('rank').hidden = !rankAllowed || offers.length <= RANK_TOP;
  $('match').hidden = !rankAllowed || offers.length !== 1;
  const button = $('generate');
  // 2.47: a pasted offer is enough, no "add" step first.
  button.disabled = (offers.length === 0 && !$('paste').value.trim()) || !modelsReady;
  button.textContent = offers.length > 1 ? t('Générer les {v0} CV', { v0: offers.length }) : t('Générer le CV');
}

async function readFiles(fileList) {
  for (const file of fileList) {
    // 2.53: a pdf or docx goes base64 in one request (256 KB at most);
    // 2026-11-24: an image (a phone screenshot) up to 5 MB, the owner's page only.
    const image = /\.(png|jpe?g|webp)$/i.test(file.name);
    if (file.size > (image ? 5 * 1024 * 1024 : /\.(pdf|docx)$/i.test(file.name) ? 180 * 1024 : MAX_TEXT * 4)) {
      showError(`${file.name} : fichier trop gros.`);
      continue;
    }
    const title = file.name.replace(/\.(txt|md|pdf|docx|png|jpe?g|webp)$/i, '');
    // 2.53: a pdf or docx is read by the server, its text comes back; an
    // image is transcribed there by a model, then checked as an offer.
    if (/\.(pdf|docx|png|jpe?g|webp)$/i.test(file.name)) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
        const { text } = await api('/api/offer-text', { name: file.name, data: btoa(binary) });
        addOffer(text, title);
      } catch (error) {
        showError(`${file.name} : ${error.message}`);
      }
      continue;
    }
    addOffer(await file.text(), title);
  }
}

function setupOffers() {
  // 2.47: the Generate button follows what is pasted.
  $('paste').addEventListener('input', renderOffers);
  $('add').addEventListener('click', () => {
    showError(null);
    addOffer($('paste').value);
    $('paste').value = '';
  });
  $('split').addEventListener('click', async () => {
    showError(null);
    const text = $('paste').value;
    if (!text.trim()) return showError(t('Colle d’abord le texte à découper.'));
    const button = $('split');
    button.disabled = true;
    button.textContent = t('Détection…');
    try {
      const found = await api('/api/split', { text });
      for (const offer of found.offers) addOffer(offer.text, offer.title);
      // Each repair says what happened: kept as one offer, or lines left out.
      if (found.repairs.length) showError(t('Découpage : {v0}.', { v0: found.repairs.join(' ; ') }));
      $('paste').value = '';
    } catch (error) {
      showError(t('Découpage impossible : {v0}', { v0: error.message }));
    } finally {
      button.disabled = false;
      button.textContent = t('Détecter plusieurs offres');
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
  // 4.5: the employer's side, the profiles ranked for the one waiting offer.
  $('match').addEventListener('click', () => withButton('match', 'Classement…', async () => {
    const { rows } = await api('/api/match', { offer: { title: offers[0].title, text: offers[0].text }, top: RANK_TOP });
    showRanking('profils', rows);
  }));
  // 4.5: a JSON Resume file, or the CSV files of a LinkedIn export.
  $('import').addEventListener('click', () => withButton('import', 'Import…', async () => {
    const files = [...$('import-files').files];
    if (!files.length) throw new Error(t('choisis un fichier .json ou les .csv de l’export LinkedIn'));
    const json = files.find((file) => file.name.toLowerCase().endsWith('.json'));
    const body = json ? { resume: JSON.parse(await json.text()) } : { linkedin: Object.fromEntries(await Promise.all(files.map(async (file) => [file.name, await file.text()]))) };
    const done = await api('/api/profiles', { id: $('import-id').value.trim(), ...body });
    $('rank-result').textContent = t('Profil « {v0} » importé ; à confirmer : {v1} ligne(s). Recharge la page pour le choisir.', { v0: done.id, v1: done.to_confirm.length });
    $('rank-result').hidden = false;
  }));
  $('rank').addEventListener('click', () => withButton('rank', 'Classement…', async () => {
    const { rows } = await api('/api/rank', { offers: offers.map(({ title, text }) => ({ title, text })), top: RANK_TOP });
    const kept = rows.filter((row) => row.chosen).map((row) => offers[row.index]);
    offers.splice(0, offers.length, ...kept);
    renderOffers();
    showRanking('offres', rows);
  }));
  // 4.11: two tabs: the stored profile, or this run's own sources (nothing kept).
  const tab = (sources) => {
    $('tab-stored').setAttribute('aria-selected', String(!sources));
    $('tab-sources').setAttribute('aria-selected', String(sources));
    $('sources-panel').hidden = !sources;
  };
  $('tab-stored').addEventListener('click', () => tab(false));
  $('tab-sources').addEventListener('click', () => tab(true));
  /** The sources tab's files (base64), links and threshold, or nothing on the stored-profile tab. */
  const runSources = async () => {
    if ($('sources-panel').hidden) return {};
    const files = await Promise.all([...$('source-files').files].map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      return { name: file.name, data: btoa(binary) };
    }));
    const links = local ? $('source-links').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
    if (!files.length && !links.length) throw new Error(local ? t('ajoute au moins un fichier ou un lien du candidat') : t('ajoute au moins un fichier de ton profil'));
    // Public: no link is ever fetched for a visitor; files only.
    return { sources: files, ...(local ? { links } : {}), threshold: Number($('threshold').value) };
  };
  $('generate').addEventListener('click', async () => {
    showError(null);
    if (!offers.length && $('paste').value.trim()) {
      addOffer($('paste').value);
      $('paste').value = '';
    }
    const batch = offers.splice(0, offers.length);
    renderOffers();
    try {
      await api('/api/jobs', { offers: batch.map(({ title, text }) => ({ title, text })), model: $('model').value, profile: $('profile-row').hidden ? undefined : $('profile').value, ...($('style-row').hidden ? {} : { style: { template: $('template').value, palette: $('palette').value } }), ...(await runSources()) });
      poll();
    } catch (error) {
      offers.push(...batch);
      renderOffers();
      showError(t('Génération refusée : {v0}', { v0: error.message }));
    }
  });
}

/* ---------- Jobs ---------- */

const STEPS = [
  ['wake', t('Réveil de l’IA locale')],
  ['listing', t('Lecture de l’offre')],
  ['analysis', t('Analyse')],
  ['layout', t('Mise en page')],
  ['pdf', 'PDF'],
  ['ats', t('Contrôle ATS')],
  ['done', t('Terminé')],
];
const QUALIFICATION = {
  qualified: ['ok', t('Qualifié')],
  partial: ['warn', t('Partiellement qualifié')],
  'not-qualified': ['bad', t('Non qualifié')],
};
const VERDICT = { strong: t('fort'), good: t('bon'), partial: t('partiel'), weak: t('faible') };
const MATCH = { yes: ['ok', t('oui')], adjacent: ['warn', t('proche')], no: ['bad', t('non')] };
/** The code's gap labels, in the page's language. */
const GAP_LABELS = [[/ \(never claimed\)$/, t(' (jamais revendiqué)')], [/ \(lab only\)$/, t(' (lab uniquement)')], [/ \(to verify\)$/, t(' (à vérifier)')]];
const gapLabel = (gap) => GAP_LABELS.reduce((text, [pattern, label]) => text.replace(pattern, label), gap);
/** 2.45: the cap's reason in French (score.js capOf writes it in English). */
const capLabel = (cap) => {
  const core = /^core: (.+), the technology the title leads with, is missed$/.exec(cap);
  if (core) return t('Score plafonné à 30 : {v0}, la technologie en tête du titre, manque au profil.', { v0: core[1] });
  if (cap.startsWith('level:')) return t('Score plafonné à 30 : poste junior ou de premier niveau, profil senior.');
  return t('Score plafonné à 30 : {v0}', { v0: cap });
};
const details = new Map();
const cards = new Map();

function stepsOf(job) {
  const reached = new Map();
  for (const step of job.steps) reached.set(step.step, step);
  const last = job.steps.at(-1)?.step;
  return h('ol', { class: 'steps' }, STEPS.filter(([key]) => reached.has(key) || key === 'done').map(([key, label]) => {
    const step = reached.get(key);
    const extra = key === 'analysis' && step?.attempt > 1 ? t(' (essai {n})', { n: step.attempt }) : key === 'layout' && step ? t(' ({n} mesures)', { n: step.layouts }) : '';
    const state = job.status === 'done' || (reached.has(key) && key !== last) ? 'done' : key === last && job.status === 'running' ? 'now' : '';
    return h('li', { class: state, text: label + extra });
  }));
}

function ring(score) {
  const node = h('div', { class: 'ring', role: 'img', 'aria-label': t('Adéquation {v0} sur 100', { v0: score }) },
    h('span', {}, String(score), h('small', { text: '/ 100' })));
  node.style.setProperty('--value', String(score));
  node.style.setProperty('--color', score >= 70 ? 'var(--ok)' : score >= 45 ? 'var(--warn)' : 'var(--bad)');
  return node;
}

function requirementsTable(requirements) {
  const rows = requirements.map((r) => {
    const [tone, label] = MATCH[r.match] ?? ['', r.match];
    const covered = r.never
      ? [h('span', { class: 'chip bad', text: t('jamais revendiqué') })]
      : r.skills.map((s) => h('span', { class: `chip ${s.lab ? 'lab' : ''}`, text: s.lab ? `${s.name} · lab` : s.name }));
    // A match no profile skill names is the model's reading: shown with its note, to verify.
    const judged = r.judged ? h('div', { class: 'quote', text: t('à vérifier : {v0}', { v0: r.note || t('rapprochement du modèle') }) }) : null;
    return h('tr', {}, h('td', { text: r.name }), h('td', { text: r.importance === 'must' ? t('requis') : t('souhaité') }),
      h('td', {}, h('span', { class: `chip ${tone}`, text: label })), h('td', {}, covered.length ? covered : '—', judged));
  });
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, [t('Exigence'), t('Importance'), t('Couverte'), t('Par')].map((name) => h('th', { text: name })))),
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
      ? t('{v0} — appuyé par : {v1}', { v0: r.name, v1: r.skills.map((s) => s.name).join(', ') })
      : t('{v0} — à montrer en entretien : ton profil n’en dit rien encore', { v0: r.name }),
  })));
}

function verification(items) {
  return h('ul', { class: 'list' }, items.map((item) => h('li', {},
    h('strong', { text: item.name }), ' — ',
    h('span', { class: `chip ${item.verdict === 'verified' ? 'ok' : item.verdict === 'self-declared' ? 'info' : 'warn'}`, text: item.verdict }),
    item.sources.slice(0, 2).map((s) => h('div', { class: 'quote', text: t('{v0} ({v1}) : « {v2} »', { v0: s.title, v1: s.grade, v2: s.quote }) })))));
}

function resultOf(job, detail) {
  const fit = detail.fit;
  const scored = detail.requirements.filter((r) => r.kind !== 'quality' && r.kind !== 'condition');
  const conditions = detail.requirements.filter((r) => r.kind === 'condition');
  const qualities = detail.requirements.filter((r) => r.kind === 'quality');
  const [qTone, qLabel] = QUALIFICATION[fit.qualification?.level] ?? ['', 'Qualification inconnue'];
  const gaps = fit.qualification?.gaps ?? [];
  const toConfirm = [
    ...detail.older.map((o) => t('{v0} : cité par {v1}, absent du profil — à confirmer, puis ajouter au profil si vrai', { v0: o.requirement, v1: o.sources.join(', ') })),
    ...detail.flags,
  ];
  const layout = detail.layout ? `${detail.layout.pages.toFixed(2)} page(s)` : t('mise en page non mesurée');
  const ats = detail.ats ? (detail.ats.problems.length ? t('ATS : {v0} problème(s)', { v0: detail.ats.problems.length }) : t('ATS : texte lisible, dans l’ordre')) : '';
  const downloads = detail.files.map((name) => h('a', {
    class: name === 'cv.pdf' ? 'main' : '',
    href: `/api/jobs/${job.id}/files/${name}`,
    download: '',
    text: { 'cv.pdf': 'CV (PDF)', 'cv.docx': 'CV (Word)', 'report.md': t('Rapport') }[name],
  }));
  downloads.push(h('a', { href: `/cv.html?job=${encodeURIComponent(job.id)}`, target: '_blank', rel: 'noopener', text: t('Page A4') }));
  if (local) downloads.push(h('a', { href: `/questions.html?job=${encodeURIComponent(job.id)}`, text: t('Compléter le profil') }));
  return [
    h('div', { class: 'result' }, ring(fit.score), h('div', {},
      h('div', { class: 'verdict' },
        h('span', { class: `chip ${qTone}`, text: qLabel }),
        h('span', { class: 'chip', text: t('adéquation {v0}', { v0: VERDICT[fit.verdict] ?? fit.verdict }) }),
        h('span', { class: 'chip', text: `${layout}${ats ? ` · ${ats}` : ''}` })),
      h('p', { class: 'headline', text: detail.headline }),
      h('ul', { class: 'summary' }, detail.summary.map((s) => h('li', { text: s }))),
      gaps.length ? h('p', { class: 'gaps', text: t('Écarts sur l’essentiel : {v0}', { v0: gaps.map(gapLabel).join(', ') }) }) : null,
      // 2.45: why the score is capped (score.js capOf).
      fit.cap ? h('p', { class: 'gaps', text: capLabel(fit.cap) }) : null,
      detail.offer_instructions ? h('p', { class: 'gaps', text: t("Cette offre contient des consignes adressées au candidat ou à une IA : elles n'ont pas été appliquées.") }) : null,
      detail.skipped ? h('p', { class: 'gaps', text: `Non fait : ${detail.skipped.reason}` }) : null)),
    h('div', { class: 'downloads' }, downloads),
    h('details', {}, h('summary', { text: t('Exigences de l’offre ({v0})', { v0: scored.length }) }), requirementsTable(scored)),
    qualities.length ? h('details', {}, h('summary', { text: t('Savoir-être, non notés ({v0})', { v0: qualities.length }) }), qualitiesList(qualities)) : null,
    conditions.length ? h('details', {}, h('summary', { text: t('Conditions à confirmer, non notées ({v0})', { v0: conditions.length }) }),
      h('ul', { class: 'list' }, conditions.map((r) => h('li', { text: t('{v0} — à confirmer : ton profil n’en dit rien', { v0: r.name }) })))) : null,
    toConfirm.length ? h('details', { open: true }, h('summary', { text: t('À confirmer avant envoi ({v0})', { v0: toConfirm.length }) }),
      h('ul', { class: 'list' }, toConfirm.map((line) => h('li', { text: line })))) : null,
    h('details', {}, h('summary', { text: t('Preuves des compétences affichées ({v0})', { v0: detail.verification.length }) }), verification(detail.verification)),
    detail.fit.rationale ? h('details', {}, h('summary', { text: t('Commentaire du modèle (non vérifié)') }), h('p', { class: 'quote', text: detail.fit.rationale })) : null,
    h('p', { class: 'help', text: t('Modèle demandé : {v0}, via {v1} · répondu par {v2} en {v3} essai(s), {v4}.', { v0: MODEL_NAMES[detail.model] ?? detail.model, v1: detail.via === 'vm' ? t('la VM') : t('le portable'), v2: detail.backend, v3: detail.attempts, v4: seconds(detail.elapsed_ms) }) }),
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
    queued: ['', Number.isInteger(job.position) ? (job.position === 1 ? t('en attente : prochain dans la file') : t('en attente : {n}e dans la file', { n: job.position })) : t('en attente')],
    running: ['info', t('en cours')],
    done: ['ok', t('prêt')],
    failed: ['bad', t('échec')],
  }[job.status] ?? ['', job.status];
  // The server's clock (audit 2026-09-27): running, it grows; done, it stays.
  const elapsed = Number.isFinite(job.elapsed_ms) ? ` · ${Math.round(job.elapsed_ms / 1000)} s` : '';
  // 2.31a: a run can be renamed at any time, to be found again.
  const rename = h('button', { type: 'button', class: 'link rename', text: t('Renommer'), 'aria-label': t('Renommer « {v0} »', { v0: job.title }) });
  rename.addEventListener('click', () => renameJob(job));
  const children = [h('div', { class: 'job-head' }, h('h3', { text: job.title }), rename, h('span', { class: `chip ${status[0]}`, text: status[1] + elapsed }))];
  if (job.status !== 'done') children.push(stepsOf(job));
  if (job.status === 'failed') children.push(h('p', { class: 'error', text: job.error ?? t('échec') }));
  const detail = details.get(job.id);
  if (detail) children.push(...resultOf(job, detail).filter(Boolean));
  if (job.status === 'done') children.push(opinionOf(job));
  card.replaceChildren(...children);
  $('jobs-empty').hidden = true;
}

/* 2.31b: one card for a comparison; each model keeps its own card, its CV and report. */
const groupCards = new Map();
async function renderGroup(id) {
  if (groupCards.get(id)?.done) return;
  const group = await api(`/api/groups/${id}`);
  let card = groupCards.get(id)?.card;
  if (!card) {
    card = h('article', { class: 'job', 'aria-label': t('Comparaison : {title}', { title: group.title }) });
    $('jobs').prepend(card);
  }
  groupCards.set(id, { card, done: group.status === 'done' });
  const head = h('div', { class: 'job-head' }, h('h3', { text: t('Comparaison : {title}', { title: group.title }) }), h('span', { class: `chip ${group.comparison ? 'ok' : 'info'}`, text: group.comparison ? t('prête') : t('en cours') }));
  if (!group.comparison) return card.replaceChildren(head);
  const { models, rows, leads } = group.comparison;
  const cells = (tag, values) => h('tr', {}, ...values.map((value) => h(tag, { text: value === null || value === undefined ? '–' : String(value) })));
  const done = models.filter((model) => model.status === 'done').map((model) => model.model);
  const differ = rows.filter((row) => !row.agree);
  return card.replaceChildren(head,
    ...(leads.length ? [h('ul', {}, ...leads.map((lead) => h('li', { text: lead.text })))] : []),
    h('table', {}, cells('th', [t('Modèle'), t('Statut'), t('Score'), t('Verdict'), t('Durée (s)'), t('Tokens'), t('Tentatives'), t('Réparations'), t('Verdicts changés')]),
      ...models.map((m) => cells('td', [m.model, m.status, m.score, m.verdict, m.elapsed_ms === null ? null : Math.round(m.elapsed_ms / 1000), m.tokens, m.attempts, m.repairs, m.verdicts_changed]))),
    ...(differ.length ? [h('table', {}, cells('th', [t('Désaccords'), ...done]), ...differ.map((row) => cells('td', [row.name, ...done.map((name) => row.verdicts[name])])))] : []),
    h('a', { href: `/api/groups/${id}/compare.md`, text: t('Télécharger la comparaison') }));
}

/* 2026-11-24: an opinion on a CV (a rating, a comment, what it would be worth) for the owner. */
const opinions = new Set();
const PRICES = [0, 5, 10, 20, 50];
function opinionOf(job) {
  if (opinions.has(job.id)) return h('p', { class: 'muted', text: t('Merci pour votre avis !') });
  const rating = h('select', { 'aria-label': t('Note') }, [5, 4, 3, 2, 1].map((value) => h('option', { value: String(value), text: `${'★'.repeat(value)}${'☆'.repeat(5 - value)}` })));
  const comment = h('textarea', { rows: 3, maxLength: 2000, placeholder: t('Ce qui est juste, ce qui manque, ce qui gêne…'), 'aria-label': t('Commentaire') });
  const price = h('select', { 'aria-label': t('Combien paieriez-vous pour ce CV ?') }, [h('option', { value: '', text: t('Combien paieriez-vous pour ce CV ? (facultatif)') }),
    ...PRICES.map((value) => h('option', { value: String(value), text: value ? `${value} €` : t('Rien : seulement gratuit') }))]);
  const error = h('p', { class: 'error', hidden: true });
  const send = h('button', { type: 'button', text: t('Envoyer mon avis') });
  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      await api(`/api/jobs/${job.id}/feedback`, { rating: Number(rating.value), comment: comment.value, price: price.value === '' ? null : Number(price.value) });
      opinions.add(job.id);
      box.replaceWith(opinionOf(job));
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      send.disabled = false;
    }
  });
  const box = h('details', { class: 'opinion' }, h('summary', { text: t('Votre avis sur ce CV') }), rating, comment, price, send, error);
  return box;
}

async function renameJob(job) {
  const title = window.prompt('Nouveau nom du run :', job.title);
  if (title === null || !title.trim() || title.trim() === job.title) return;
  try {
    job.title = (await api(`/api/jobs/${job.id}/title`, { title: title.trim() })).title;
    renderJob(job);
  } catch (error) {
    showError(t('Renommage refusé : {v0}', { v0: error.message }));
  }
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      if (document.hidden) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      const jobs = await api('/api/jobs');
      for (const job of jobs) {
        if (job.status === 'done' && !details.has(job.id)) details.set(job.id, await api(`/api/jobs/${job.id}`));
        renderJob(job);
      }
      for (const id of new Set(jobs.map((job) => job.group).filter(Boolean))) await renderGroup(id);
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
$('model').addEventListener('change', () => { modelChosen = true; });
refreshStatus();
// Every 30 s while in sight, and when the menu is opened (a test sandbox has no interval).
globalThis.setInterval?.(() => document.hidden || refreshStatus(), 30000);
$('model').addEventListener('focus', refreshStatus);
poll();
