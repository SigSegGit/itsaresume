// 6.8: the founder's admin page. Text only (textContent), never HTML; its
// API answers the configured admins only (PREMIUM_ADMINS), 403 otherwise.
const $ = (id) => document.getElementById(id);
const { t, lang } = globalThis.i18n;
const token = sessionStorage.getItem('premium_token') ?? '';

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(json.error ?? `HTTP ${response.status}`), { status: response.status });
  return json;
}

function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function table(id, head, rows) {
  const header = el('tr');
  header.append(...head.map((name) => el('th', name)));
  $(id).replaceChildren(header, ...rows.map((cells) => {
    const row = el('tr');
    row.append(...cells.map((cell) => el('td', cell ?? '—')));
    return row;
  }));
}

const when = (value) => (value ? new Date(value).toLocaleString(lang === 'en' ? 'en-GB' : 'fr-FR') : '—');
const kb = (bytes) => t('{n} ko', { n: Math.round(bytes / 1024) });

async function showStats() {
  const { stats, revenue, integrity } = await api('api/admin/stats');
  $('integrity').textContent = integrity;
  table('stats', [t('Table'), t('Lignes')], Object.entries(stats));
  table('revenue', [t('Devise'), t('Commandes'), t('Total'), t('Simulées')], revenue.map((row) => [row.currency, row.orders, row.total, row.simulated]));
}

async function showSnapshots() {
  const { snapshots, newest } = await api('api/admin/snapshots');
  $('newest').textContent = newest
    ? t('Dernière : {name}, intégrité {integrity}, {users} compte(s).', { name: newest.name, integrity: newest.integrity, users: newest.stats.users })
    : t('Aucune sauvegarde.');
  $('snapshots').replaceChildren(...snapshots.slice(0, 10).map((row) => el('li', `${row.name} — ${kb(row.bytes)}`)));
}

async function showUsers(query = '') {
  const { users } = await api(`api/admin/users?q=${encodeURIComponent(query)}`);
  table('users', [t('Adresse'), t('Crédits'), t('Commandes'), t('CV'), t('Profil'), t('Créé'), t('Dernière connexion')],
    users.map((row) => [row.email, row.credits, row.orders, row.jobs, row.has_profile ? t('oui') : t('non'), when(row.created_at), when(row.last_login)]));
}

async function showLog() {
  const { log } = await api('api/admin/log');
  $('log').replaceChildren(...log.map((row) => el('li', `${when(row.at)} — ${row.admin} → ${row.target} : ${row.action}`)));
}

async function start() {
  try {
    await showStats();
  } catch (error) {
    $('denied').textContent = error.status === 403 ? t('Réservé aux administrateurs.') : t('Connectez-vous d’abord (Mon compte).');
    $('denied').hidden = false;
    return;
  }
  $('admin').hidden = false;
  await Promise.all([showSnapshots(), showUsers(), showLog()]);
  $('search').addEventListener('submit', (event) => {
    event.preventDefault();
    showUsers($('q').value.trim());
  });
  $('credits').addEventListener('submit', async (event) => {
    event.preventDefault();
    const say = $('c-result');
    say.hidden = false;
    try {
      const { credits } = await api('api/admin/credits', { email: $('c-email').value, delta: Number($('c-delta').value), reason: $('c-reason').value });
      say.textContent = t('Nouveau solde : {credits} crédit(s).', { credits });
      $('c-delta').value = '';
      $('c-reason').value = '';
      await Promise.all([showUsers($('q').value.trim()), showLog(), showStats()]);
    } catch (error) {
      say.textContent = error.message;
    }
  });
}

start();
