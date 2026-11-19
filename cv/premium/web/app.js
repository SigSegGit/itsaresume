// 6.4: the paid site's page. Text only (textContent), never HTML.
const $ = (id) => document.getElementById(id);
const euro = (value) => `${value.toFixed(2).replace('.', ',')} €`;
let token = sessionStorage.getItem('premium_token') ?? '';

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(json.error ?? `HTTP ${response.status}`), { status: response.status });
  return json;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

let packs = [];
async function showPacks() {
  const data = await api('/api/packs');
  packs = data.packs;
  const base = packs[0].per_cv;
  $('packs').replaceChildren(...packs.map((pack, index) => {
    const card = el('div', undefined, `pack${index === 2 ? ' best' : ''}`);
    if (index === 2) card.append(el('span', 'Le plus choisi', 'tag'));
    card.append(el('h3', pack.label), el('p', euro(pack.price), 'price'), el('p', `${euro(pack.per_cv)} par CV`, 'muted'));
    if (pack.per_cv < base) card.append(el('p', `−${Math.round((1 - pack.per_cv / base) * 100)} %`, 'save'));
    const buy = el('button', 'Acheter');
    buy.type = 'button';
    buy.addEventListener('click', () => checkout(pack));
    card.append(buy);
    return card;
  }));
  const models = Object.keys(data.prices);
  const table = el('table');
  const head = el('tr');
  head.append(el('th', 'Lot'), el('th', 'Prix / CV'), ...models.map((model) => el('th', `Marge / CV (${model})`)));
  table.append(head);
  for (const pack of packs) {
    const row = el('tr');
    row.append(el('td', pack.label), el('td', euro(pack.per_cv)), ...models.map((model) => el('td', euro(pack.margin[model]))));
    table.append(row);
  }
  const cost = (model) => ((data.run.calls * data.run.input * data.prices[model].input + data.run.calls * data.run.output * data.prices[model].output) / 1e6);
  $('costs').replaceChildren(
    el('p', `Un CV, au pire : ${data.run.calls} appels × ${data.run.input / 1000}k tokens en entrée + ${data.run.output / 1000}k en sortie. Modèle payant : ${data.model}.`),
    el('ul'),
    table,
    el('p', `Marge = prix − frais de carte (1,5 % + 0,25 € par paiement) − API (au taux ${data.eur_per_usd} €/$) − hébergement (0,02 €). L'aperçu gratuit passe par le forfait : 0 € d'API, limité à 3 par jour et par compte.`, 'muted'),
  );
  $('costs').children[1].append(...models.map((model) => el('li', `${model} : ${cost(model).toFixed(3)} $ par CV`)));
}

function checkout(pack) {
  if (!token && $('dashboard').hidden) {
    location.hash = '#account';
    return say('auth-error', 'Créez un compte ou connectez-vous pour acheter.');
  }
  $('checkout-what').textContent = `${pack.label} — ${euro(pack.price)}`;
  $('checkout').returnValue = '';
  $('checkout').showModal();
  $('checkout').onclose = async () => {
    if ($('checkout').returnValue !== 'pay') return;
    const result = await api('/api/checkout', { pack: pack.id });
    $('me-credits').textContent = String(result.credits);
  };
}

function say(id, text) {
  $(id).textContent = text;
  $(id).hidden = !text;
}

async function showMe() {
  let me;
  try {
    me = await api('/api/me');
  } catch {
    $('auth').hidden = false;
    $('dashboard').hidden = true;
    return;
  }
  $('auth').hidden = true;
  $('dashboard').hidden = false;
  $('me-email').textContent = me.email;
  $('me-credits').textContent = String(me.credits);
  $('profile-status').textContent = me.profile
    ? `Profil importé : ${me.profile.name}, ${me.profile.experiences} expérience(s).`
    : 'Aucun profil : importez-le depuis votre page LinkedIn avec l’extension, ou collez un JSON Resume.';
  $('ext-url').textContent = location.origin;
  if (token) $('ext-token').textContent = token;
  $('jobs').replaceChildren(...me.jobs.map((job) => {
    const li = el('li');
    li.append(el('span', job.title || 'Offre'), el('span', ` — ${new Date(job.created).toLocaleString('fr-FR')}`, 'muted'));
    if (job.status === 'done') {
      const link = el('a', `Ouvrir le CV${job.score != null ? ` (${job.score}/100)` : ''}`);
      link.href = `/cv.html?job=${encodeURIComponent(job.id)}`;
      link.target = '_blank';
      link.rel = 'noopener';
      li.append(el('span', ' '), link);
    } else li.append(el('span', job.status === 'failed' ? ' — échec, crédit rendu' : ' — en cours…', 'muted'));
    return li;
  }));
  if (me.jobs.some((job) => job.status === 'running')) setTimeout(showMe, 3000);
}

function showPreview(preview) {
  $('preview-result').hidden = false;
  $('pv-score').textContent = String(preview.score ?? '—');
  $('pv-verdict').textContent = preview.verdict;
  $('pv-reqs').replaceChildren(...preview.requirements.map((req) => el('li', req.name, `chip ${req.match}`)));
  const skeleton = [];
  for (const length of preview.summary_lines) skeleton.push(el('div', undefined, 'line wide'));
  for (const experience of preview.experiences) {
    skeleton.push(el('p', `${experience.title} — ${experience.org}  ${experience.dates}`, 'sk-title'));
    for (const length of experience.lines) {
      const line = el('div', undefined, 'line');
      line.style.width = `${Math.min(100, 30 + length / 3)}%`;
      skeleton.push(line);
    }
  }
  $('pv-skeleton').replaceChildren(...skeleton);
  $('preview-result').scrollIntoView({ behavior: 'smooth' });
}

async function run(kind) {
  const offer = $('offer').value.trim();
  if (!offer) return say('work-status', 'Collez d’abord une offre.');
  say('work-status', kind === 'preview' ? 'Analyse en cours (1 à 2 minutes)…' : 'Génération lancée…');
  try {
    if (kind === 'preview') {
      showPreview(await api('/api/preview', { offer }));
      say('work-status', '');
    } else {
      await api('/api/generate', { offer });
      say('work-status', 'CV en cours de rédaction : il apparaîtra dans « Mes CV ».');
      await showMe();
    }
  } catch (error) {
    say('work-status', error.status === 402 ? 'Plus de crédit : choisissez un lot dans les tarifs.' : error.message);
    if (error.status === 402) location.hash = '#pricing';
  }
}

function wire() {
  let action = 'login';
  for (const button of document.querySelectorAll('#auth button')) button.addEventListener('click', () => { action = button.dataset.action; });
  $('auth').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await api(`/api/${action}`, { email: $('email').value, password: $('password').value });
      token = result.token;
      sessionStorage.setItem('premium_token', token);
      say('auth-error', '');
      await showMe();
    } catch (error) {
      say('auth-error', error.message);
    }
  });
  $('logout').addEventListener('click', async () => {
    await api('/api/logout', {});
    sessionStorage.removeItem('premium_token');
    token = '';
    await showMe();
  });
  $('save-resume').addEventListener('click', async () => {
    try {
      await api('/api/profile', { resume: JSON.parse($('resume').value) });
      await showMe();
    } catch (error) {
      $('profile-status').textContent = `Import refusé : ${error.message}`;
    }
  });
  $('preview').addEventListener('click', () => run('preview'));
  $('generate').addEventListener('click', () => run('generate'));
  $('unlock').addEventListener('click', () => run('generate'));
}

wire();
showPacks();
showMe();
