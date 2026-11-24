// 6.13: a receipt for one paid order, plain text, French or English. Not an
// invoice: the invoices (VAT, terms of sale) wait for the owner's choices.

const TEXT = {
  fr: {
    title: 'itsaresume — Reçu',
    order: 'Commande', date: 'Date', pack: 'Lot', credits: (n) => `${n} crédits`, amount: 'Montant',
    simulated: 'Paiement de démonstration : aucun argent n’a été prélevé.',
    refunded: (day) => `Remboursée le ${day}.`,
    note: 'Ce reçu n’est pas une facture.',
    decimal: ',',
    colon: ' : ',
  },
  en: {
    title: 'itsaresume — Receipt',
    order: 'Order', date: 'Date', pack: 'Pack', credits: (n) => `${n} credits`, amount: 'Amount',
    simulated: 'Demo payment: no money was taken.',
    refunded: (day) => `Refunded on ${day}.`,
    note: 'This receipt is not an invoice.',
    decimal: '.',
    colon: ': ',
  },
};

/** The receipt's text; a pending order has none (throws). */
export function receiptText(order, lang = 'fr') {
  if (order.pending) throw new Error('a pending order has no receipt');
  const words = TEXT[lang] ?? TEXT.fr;
  const amount = `${Number(order.price).toFixed(2).replace('.', words.decimal)} ${order.currency}`;
  const line = (label, value) => `${label}${words.colon}${value}`;
  const lines = [
    words.title,
    '',
    line(words.order, order.id),
    line(words.date, String(order.at).slice(0, 10)),
    line(words.pack, `${order.pack} (${words.credits(order.credits)})`),
    line(words.amount, amount),
    '',
  ];
  if (order.simulated) lines.push(words.simulated);
  if (order.refunded_at) lines.push(words.refunded(String(order.refunded_at).slice(0, 10)));
  lines.push(words.note, '');
  return lines.join('\n');
}
