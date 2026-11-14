// 4.6: on the user's click, read the active tab's offer (activeTab), copy
// it, open the generator; the user pastes it there. Nothing else is read.
import { offerText } from './extract.js';

const DEFAULT_URL = 'http://127.0.0.1:18790/';
const status = document.getElementById('status');
const send = document.getElementById('send');

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const [{ result: text = '' } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: offerText, args: [] }).catch(() => [{}]);
status.textContent = text ? `${text.length} caractères lus sur cette page.` : 'Rien à lire ici : sélectionne le texte de l’offre.';
send.disabled = !text;
send.addEventListener('click', async () => {
  const { url = DEFAULT_URL } = await chrome.storage.sync.get('url');
  await navigator.clipboard.writeText(text);
  await chrome.tabs.create({ url });
  status.textContent = 'Offre copiée : colle-la dans le générateur.';
});
