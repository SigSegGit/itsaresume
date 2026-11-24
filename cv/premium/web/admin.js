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
  if (!response.ok) throw Object.assign(new Error(json.error ? globalThis.i18n.serverText(json.error) : `HTTP ${response.status}`), { status: response.status });
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

/* 2026-11-24: customers' spend today, its cost, the day's revenue. */
async function showApiSpend() {
  const { budget, estimate, revenue_today: revenue } = await api('api/admin/api-spend');
  const sold = Object.entries(revenue).map(([currency, total]) => globalThis.i18n.money(total, currency)).join(' + ') || '0';
  $('api-spend-line').textContent = budget
    ? t('{v0} requêtes / {v1} · {v2} jetons / {v3} · coût estimé {v4} · ventes du jour {v5}', {
      v0: budget.requests, v1: budget.requests_limit ?? '∞', v2: budget.tokens, v3: budget.tokens_limit ?? '∞',
      v4: globalThis.i18n.money(estimate.eur, 'EUR'), v5: sold,
    })
    : t('Routeur injoignable : dépense inconnue.');
}

/* 2026-11-24: the LinkedIn outreach: one link per person, its funnel, its opinions. */
async function showInvites() {
  let invitations;
  try {
    ({ invitations } = await api('api/admin/invites'));
  } catch (error) {
    $('invites').replaceChildren(el('h2', t('Invitations (CV gratuits contre un avis)')), el('p', error.message));
    return;
  }
  const header = el('tr');
  header.append(...[t('Libellé'), t('État'), t('Demandés'), t('Faits'), t('Avis'), t('Note'), t('Dernière activité'), ''].map((name) => el('th', name)));
  const rows = invitations.map((row) => {
    const line = el('tr');
    line.append(...[row.label, row.live ? t('actif') : t('révoqué'), row.asked, row.made, row.opinions, row.mean === null ? '—' : `${row.mean}/5`, when(row.last)].map((cell) => el('td', cell)));
    const actions = el('td');
    if (row.link) {
      const copy = el('button', t('Copier le lien'));
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        await navigator.clipboard.writeText(row.link);
        copy.textContent = t('Copié');
      });
      const revoke = el('button', t('Révoquer'));
      revoke.type = 'button';
      revoke.className = 'danger';
      revoke.addEventListener('click', async () => {
        if (!window.confirm(t('Révoquer le lien de {label} ? Il ne servira plus.', { label: row.label }))) return;
        await api('api/admin/invites/revoke', { label: row.label });
        await Promise.all([showInvites(), showLog()]);
      });
      actions.append(copy, revoke);
    }
    line.append(actions);
    return line;
  });
  $('invitations').replaceChildren(header, ...rows);
  const opinions = invitations.flatMap((row) => row.comments.map((comment) => ({ ...comment, label: row.label })))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  $('opinions').replaceChildren(...(opinions.length
    ? opinions.map((row) => el('li', `${when(row.at)} — ${row.label} — ${row.rating}/5${row.comment ? ` — ${row.comment}` : ''}`))
    : [el('li', t('Aucun avis pour l’instant.'))]));
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

async function showOrders() {
  const { orders } = await api('api/admin/orders');
  const header = el('tr');
  header.append(...[t('Commande'), t('Date'), t('Adresse'), t('Lot'), t('Montant'), t('Remboursée'), ''].map((name) => el('th', name)));
  $('orders').replaceChildren(header, ...orders.map((order) => {
    const row = el('tr');
    row.append(...[order.id, when(order.at), order.email ?? t('(effacée)'), order.pack, `${order.price} ${order.currency}${order.simulated ? ` (${t('simulé')})` : ''}`, when(order.refunded_at)].map((cell) => el('td', cell)));
    const cell = el('td');
    if (!order.refunded_at) {
      const button = el('button', t('Rembourser'));
      button.type = 'button';
      button.className = 'secondary';
      button.addEventListener('click', async () => {
        const reason = window.prompt(t('Motif du remboursement (journalisé) :'));
        if (!reason) return;
        const say = $('o-result');
        say.hidden = false;
        try {
          const done = await api('api/admin/refund', { id: order.id, reason });
          say.textContent = t('Remboursement enregistré : {n} crédit(s) repris.', { n: done.credits_taken });
          await Promise.all([showOrders(), showStats(), showUsers($('q').value.trim()), showLog()]);
        } catch (error) {
          say.textContent = error.message;
        }
      });
      cell.append(button);
    }
    row.append(cell);
    return row;
  }));
}

async function showFailed() {
  const { jobs } = await api('api/admin/failed');
  $('failed').replaceChildren(...(jobs.length ? jobs.map((job) => el('li', `${when(job.created)} — ${job.email} — ${job.title || t('Offre')} : ${job.error ?? '?'}`)) : [el('li', t('Aucune.'))]));
}

async function showLog() {
  const { log } = await api('api/admin/log');
  $('log').replaceChildren(...log.map((row) => el('li', `${when(row.at)} — ${row.admin} → ${row.target} : ${row.action}`)));
}

async function start() {
  try {
    await showStats();
    await showApiSpend();
  } catch (error) {
    $('denied').textContent = error.status === 403 ? t('Réservé aux administrateurs.') : t('Connectez-vous d’abord (Mon compte).');
    $('denied').hidden = false;
    return;
  }
  $('admin').hidden = false;
  await Promise.all([showInvites(), showSnapshots(), showUsers(), showLog(), showOrders(), showFailed()]);
  $('invite').addEventListener('submit', async (event) => {
    event.preventDefault();
    const say = $('i-result');
    say.hidden = false;
    try {
      const { label, link } = await api('api/admin/invites', { label: $('i-label').value });
      say.textContent = t('Lien pour {label} : {link}', { label, link });
      $('i-label').value = '';
      await Promise.all([showInvites(), showLog()]);
    } catch (error) {
      say.textContent = error.message;
    }
  });
  $('erase').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = $('e-email').value.trim();
    if (!window.confirm(t('Effacer définitivement le compte {email} ? Ses commandes restent, sans son adresse.', { email }))) return;
    const say = $('e-result');
    say.hidden = false;
    try {
      await api('api/admin/erase', { email, reason: $('e-reason').value });
      say.textContent = t('Compte effacé : {email}.', { email });
      $('e-email').value = '';
      $('e-reason').value = '';
      await Promise.all([showUsers($('q').value.trim()), showLog(), showStats(), showOrders()]);
    } catch (error) {
      say.textContent = error.message;
    }
  });
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
