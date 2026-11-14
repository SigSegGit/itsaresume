// 4.6/4.7: on the user's click, read the active tab's offer (activeTab).
// With a key set in the options, post it to the generator as a job (the
// owner's `serve --addon-origin`); without, copy it and open the generator.
import { offerText } from './extract.js';

const DEFAULT_URL = 'http://127.0.0.1:18790/';
const status = document.getElementById('status');
const send = document.getElementById('send');

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const [{ result: text = '' } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: offerText, args: [] }).catch(() => [{}]);
const { url = DEFAULT_URL, key = '' } = await chrome.storage.sync.get(['url', 'key']);
status.textContent = text ? `${text.length} caractères lus sur cette page.` : 'Rien à lire ici : sélectionne le texte de l’offre.';
send.textContent = key ? 'Envoyer l’offre au générateur' : 'Copier l’offre et ouvrir le générateur';
send.disabled = !text;
send.addEventListener('click', async () => {
  send.disabled = true;
  try {
    if (key) {
      const answer = await fetch(new URL('/api/jobs', url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': key }, body: JSON.stringify({ offers: [{ title: String(tab.title ?? '').slice(0, 80), text }] }) });
      if (!answer.ok) throw new Error(`${answer.status} ${(await answer.json().catch(() => ({}))).error ?? ''}`);
      status.textContent = 'Offre envoyée : le CV se prépare dans le générateur.';
    } else {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Offre copiée : colle-la dans le générateur.';
    }
    await chrome.tabs.create({ url });
  } catch (error) {
    status.textContent = `Échec : ${error.message}`;
    send.disabled = false;
  }
});
