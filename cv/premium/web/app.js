// 6.4: the paid site's page. Text only (textContent), never HTML.
const $ = (id) => document.getElementById(id);
// 6.7: every text through t() (web/i18n.js, loaded first).
const { t, lang } = globalThis.i18n;
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
  if (!response.ok) throw Object.assign(new Error(json.error ? globalThis.i18n.serverText(json.error) : `HTTP ${response.status}`), { status: response.status });
  return json;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

let packs = [];
let currency = new URLSearchParams(location.search).get('currency') ?? '';
async function showPacks() {
  const data = await api(`api/packs${currency ? `?currency=${encodeURIComponent(currency)}` : ''}`);
  currency = data.currency;
  packs = data.packs;
  const money = (value) => globalThis.i18n.money(value, data.currency);
  const select = $('currency');
  select.replaceChildren(...data.currencies.map((code) => Object.assign(el('option', code), { value: code, selected: code === data.currency })));
  select.onchange = () => { currency = select.value; showPacks(); };
  const base = packs[0].per_cv;
  $('packs').replaceChildren(...packs.map((pack, index) => {
    const card = el('div', undefined, `pack${index === 2 ? ' best' : ''}`);
    if (index === 2) card.append(el('span', t('Le plus choisi'), 'tag'));
    card.append(el('h3', pack.label), el('p', money(pack.price), 'price'), el('p', t('{price} par CV', { price: money(Math.round(pack.per_cv * 100) / 100) }), 'muted'));
    if (pack.per_cv < base) card.append(el('p', `−${Math.round((1 - pack.per_cv / base) * 100)} %`, 'save'));
    const buy = el('button', t('Acheter'));
    buy.type = 'button';
    buy.addEventListener('click', () => checkout(pack));
    card.append(buy);
    return card;
  }));
  const models = Object.keys(data.prices);
  const table = el('table');
  const head = el('tr');
  head.append(el('th', t('Lot')), el('th', t('Prix ({currency})', { currency: data.currency })), el('th', t('Marge / CV (€, modèle payant)')), ...models.map((model) => el('th', t('Marge EUR / CV ({model})', { model }))));
  table.append(head);
  packs.forEach((pack, index) => {
    const row = el('tr');
    const founder = data.founder[index];
    row.append(el('td', pack.label), el('td', money(pack.price)), el('td', pack.margin_eur.toFixed(2)), ...models.map((model) => el('td', founder.margin[model].toFixed(2))));
    table.append(row);
  });
  const cost = (model) => ((data.run.calls * data.run.input * data.prices[model].input + data.run.calls * data.run.output * data.prices[model].output) / 1e6);
  const list = el('ul');
  list.append(...models.map((model) => el('li', t('{model} : {cost} $ par CV', { model, cost: cost(model).toFixed(3) }) + (model === data.model ? t(' (modèle payant)') : ''))));
  $('costs').replaceChildren(
    el('p', t('Un CV, au pire : {calls} appels × {input}k tokens en entrée + {output}k en sortie.', { calls: data.run.calls, input: data.run.input / 1000, output: data.run.output / 1000 })),
    list,
    table,
    el('p', t('Prix locaux = grille EUR × taux de change × facteur de marché, arrondis à un prix psychologique (.49/.99). Marge = prix − frais de carte (1,5 % + 0,25 €) − API ({rate} €/$) − hébergement (0,02 €). Colonnes par modèle : grille EUR.', { rate: data.eur_per_usd }), 'muted'),
  );
}

function checkout(pack) {
  if ($('dashboard').hidden) {
    location.hash = '#account';
    return say('auth-error', t('Créez un compte ou connectez-vous pour acheter.'));
  }
  location.href = `checkout.html?pack=${encodeURIComponent(pack.id)}&currency=${encodeURIComponent(currency)}`;
}

function say(id, text) {
  $(id).textContent = text;
  $(id).hidden = !text;
}

async function showMe() {
  let me;
  try {
    me = await api('api/me');
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
    ? t('Profil importé : {name}, {count} expérience(s).', { name: me.profile.name, count: me.profile.experiences })
    : t('Aucun profil : importez-le depuis votre page LinkedIn avec l’add-on, ou collez un JSON Resume.');
  // 6.4d: saving a profile and the chat come with a purchase.
  if (!me.paid && !me.profile) $('profile-status').textContent = t('Aperçu gratuit possible tout de suite. Enregistrer votre profil et l’assistant sont inclus dès le premier lot de CV.');
  $('chat-status').textContent = me.paid
    ? t('{count} message(s) restant(s).', { count: me.chat_left })
    : t('Inclus avec un lot de CV : des messages offerts, puis 1 crédit = {count} messages.', { count: me.chat_per_credit });
  $('chat-send').disabled = !me.paid || me.chat_left < 1;
  $('chat-refill').hidden = !me.paid || me.chat_left > 0;
  $('chat-refill').textContent = t('Recharger : 1 crédit = {count} messages', { count: me.chat_per_credit });
  $('chat-log').replaceChildren(...me.chat_history.flatMap((entry) => [el('li', entry.message, 'me'), el('li', entry.reply)]));
  $('ext-url').textContent = new URL('.', location.href).href.replace(/\/$/, '');
  if (token) $('ext-token').textContent = token;
  $('nav-admin').hidden = !me.admin;
  $('jobs').replaceChildren(...me.jobs.map((job) => {
    const li = el('li');
    li.append(el('span', job.title || t('Offre')), el('span', ` — ${new Date(job.created).toLocaleString(lang === 'en' ? 'en-GB' : 'fr-FR')}`, 'muted'));
    if (job.status === 'done') {
      const link = el('a', t('Ouvrir le CV') + (job.score != null ? ` (${job.score}/100)` : ''));
      link.href = `cv.html?job=${encodeURIComponent(job.id)}`;
      link.target = '_blank';
      link.rel = 'noopener';
      li.append(el('span', ' '), link);
    } else li.append(el('span', job.status === 'failed' ? t(' — échec, crédit rendu') : t(' — en cours…'), 'muted'));
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
  if (!offer) return say('work-status', t('Collez d’abord une offre.'));
  say('work-status', kind === 'preview' ? t('Analyse en cours (1 à 2 minutes)…') : t('Génération lancée…'));
  try {
    if (kind === 'preview') {
      // Without a saved profile, the pasted one is sent along, never stored.
      const pasted = $('resume').value.trim();
      showPreview(await api('api/preview', pasted ? { offer, resume: JSON.parse(pasted) } : { offer }));
      say('work-status', '');
    } else {
      await api('api/generate', { offer });
      say('work-status', t('CV en cours de rédaction : il apparaîtra dans « Mes CV ».'));
      await showMe();
    }
  } catch (error) {
    say('work-status', error.status === 402 ? t('Plus de crédit : choisissez un lot dans les tarifs.') : error.message);
    if (error.status === 402) location.hash = '#pricing';
  }
}

function wire() {
  let action = 'login';
  for (const button of document.querySelectorAll('#auth button')) button.addEventListener('click', () => { action = button.dataset.action; });
  $('auth').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await api(`api/${action}`, { email: $('email').value, password: $('password').value, accept: $('accept').checked });
      token = result.token;
      sessionStorage.setItem('premium_token', token);
      say('auth-error', '');
      await showMe();
    } catch (error) {
      say('auth-error', error.message);
    }
  });
  $('logout').addEventListener('click', async () => {
    await api('api/logout', {});
    sessionStorage.removeItem('premium_token');
    token = '';
    await showMe();
  });
  $('save-resume').addEventListener('click', async () => {
    try {
      await api('api/profile', { resume: JSON.parse($('resume').value) });
      await showMe();
    } catch (error) {
      if (error.status === 402) {
        $('profile-status').textContent = t('Enregistrer un profil est inclus dès le premier lot : choisissez un lot ci-dessus.');
        location.hash = '#pricing';
      } else $('profile-status').textContent = t('Import refusé : {error}', { error: error.message });
    }
  });
  $('delete-profile').addEventListener('click', async () => {
    if (!confirm(t('Supprimer votre profil importé ? Vos CV déjà générés restent.'))) return;
    await api('api/profile/delete', {});
    await showMe();
  });
  $('delete-account').addEventListener('click', async () => {
    if (!confirm(t('Supprimer définitivement votre compte et vos données ?'))) return;
    try {
      await api('api/me/delete', { password: $('delete-password').value });
      sessionStorage.removeItem('premium_token');
      token = '';
      await showMe();
    } catch (error) {
      say('delete-error', error.message);
    }
  });
  $('chat-send').addEventListener('click', async () => {
    const message = $('chat-input').value.trim();
    if (!message) return;
    $('chat-send').disabled = true;
    try {
      await api('api/chat', { message });
      $('chat-input').value = '';
    } catch (error) {
      $('chat-status').textContent = error.message;
    }
    await showMe();
  });
  $('chat-refill').addEventListener('click', async () => {
    try {
      await api('api/chat/refill', {});
    } catch (error) {
      $('chat-status').textContent = error.status === 402 ? t('Plus de crédit : choisissez un lot.') : error.message;
    }
    await showMe();
  });
  $('forgot').addEventListener('click', async (event) => {
    event.preventDefault();
    if (!$('email').value) return say('auth-error', t('Indiquez votre adresse e-mail.'));
    await api('api/password/forgot', { email: $('email').value });
    say('auth-error', t('Si un compte existe pour cette adresse, un e-mail avec un lien (valable une heure) vient de partir.'));
  });
  const reset = /^#reset=([0-9a-f]+)$/.exec(location.hash)?.[1];
  if (reset) {
    $('reset-form').hidden = false;
    $('reset-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('api/password/reset', { token: reset, password: $('new-password').value });
        say('reset-msg', t('Mot de passe changé : connectez-vous.'));
        $('reset-form').hidden = true;
        history.replaceState(null, '', './#account');
      } catch (error) {
        say('reset-msg', error.message);
      }
    });
  }
  $('preview').addEventListener('click', () => run('preview'));
  $('generate').addEventListener('click', () => run('generate'));
  $('unlock').addEventListener('click', () => run('generate'));
}

wire();
showPacks();
showMe();
