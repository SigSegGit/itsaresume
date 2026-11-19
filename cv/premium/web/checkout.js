// 6.4b: the simulated payment page and its receipt. Text only.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

async function api(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
  return json;
}

async function start() {
  try {
    await api('api/me');
  } catch {
    location.href = './#account';
    return;
  }
  const data = await api(`api/packs?currency=${encodeURIComponent(params.get('currency') ?? '')}`);
  const pack = data.packs.find((entry) => entry.id === params.get('pack'));
  if (!pack) {
    location.href = './#pricing';
    return;
  }
  const money = (value) => new Intl.NumberFormat(data.locale, { style: 'currency', currency: data.currency, maximumFractionDigits: value % 1 ? 2 : 0 }).format(value);
  $('what').textContent = `${pack.label} (${pack.credits} crédit${pack.credits > 1 ? 's' : ''})`;
  $('price').textContent = money(pack.price);
  $('per-cv').textContent = money(Math.round(pack.per_cv * 100) / 100);
  $('total').textContent = money(pack.price);
  $('terms').addEventListener('change', () => { $('confirm').disabled = !$('terms').checked; });
  $('confirm').addEventListener('click', async () => {
    $('confirm').disabled = true;
    try {
      const { order, credits } = await api('api/checkout', { pack: pack.id, currency: data.currency });
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
