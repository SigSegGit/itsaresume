// 6.4b: the simulated payment page and its receipt. Text only.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

async function api(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error ? globalThis.i18n.serverText(json.error) : `HTTP ${response.status}`);
  return json;
}

// 6.12: with card payment, the simulated texts go and the real ones show.
function mode(card) {
  for (const element of document.querySelectorAll('.simulated-only')) element.hidden = card;
  for (const element of document.querySelectorAll('.card-only')) element.hidden = !card;
}

// 6.12: back from Stripe, the order's receipt; credited when Stripe's signed event arrives.
async function receipt(id, tries = 0) {
  const order = await api(`api/orders/${encodeURIComponent(id)}`);
  const me = await api('api/me');
  const money = (value) => globalThis.i18n.money(value, order.currency);
  $('r-id').textContent = order.id;
  $('r-pack').textContent = order.pack;
  $('r-amount').textContent = money(order.price);
  $('r-credits').textContent = String(me.credits);
  $('pay').hidden = true;
  $('receipt').hidden = false;
  $('waiting').hidden = !order.pending;
  if (order.pending && tries < 30) setTimeout(() => receipt(id, tries + 1), 2000);
}

async function start() {
  try {
    await api('api/me');
  } catch {
    location.href = './#account';
    return;
  }
  const data = await api(`api/packs?currency=${encodeURIComponent(params.get('currency') ?? '')}`);
  mode(Boolean(data.card_payment));
  if (params.get('order')) {
    await receipt(params.get('order')).catch(() => { location.href = './#account'; });
    return;
  }
  const pack = data.packs.find((entry) => entry.id === params.get('pack'));
  if (!pack) {
    location.href = './#pricing';
    return;
  }
  const money = (value) => globalThis.i18n.money(value, data.currency);
  $('what').textContent = globalThis.i18n.t('{label} ({count} crédit(s))', { label: pack.label, count: pack.credits });
  $('price').textContent = money(pack.price);
  $('per-cv').textContent = money(Math.round(pack.per_cv * 100) / 100);
  $('total').textContent = money(pack.price);
  $('terms').addEventListener('change', () => { $('confirm').disabled = !$('terms').checked; });
  $('confirm').addEventListener('click', async () => {
    $('confirm').disabled = true;
    try {
      const { order, credits, redirect } = await api('api/checkout', { pack: pack.id, currency: data.currency });
      if (redirect) {
        location.href = redirect;
        return;
      }
      $('r-id').textContent = order.id;
      $('r-pack').textContent = pack.label;
      $('r-amount').textContent = money(order.price);
      $('r-credits').textContent = String(credits);
      $('pay').hidden = true;
      $('receipt').hidden = false;
    } catch (error) {
      $('error').textContent = error.message;
      $('error').hidden = false;
      $('confirm').disabled = false;
    }
  });
}

start();
