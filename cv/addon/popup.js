// 4.6/4.7: on the user's click, read the active tab's offer (activeTab).
// With a key set in the options, post it to the generator as a job (the
// owner's `serve --addon-origin`); without, copy it and open the generator.
import { offerText } from './extract.js';
import { tokenFromPage, serviceJob, jobUrl, pdfUrl } from './service.js';

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

// 6.2: service mode, with the candidate's profile from chrome.storage.local:
// a fresh visitor token from the public page, the job, its progress, the PDF.
const service = document.getElementById('service');
const pdf = document.getElementById('pdf');
const { site = '', profile = [] } = await chrome.storage.local.get(['profile', 'site']);
service.hidden = !(site && profile.length);
service.disabled = !text;
service.addEventListener('click', async () => {
  service.disabled = true;
  try {
    status.textContent = 'Connexion au service…';
    const token = tokenFromPage(await (await fetch(new URL('/', site), { credentials: 'omit' })).text());
    if (!token) throw new Error('le site ne répond pas comme le service attendu');
    const { url: post, init } = serviceJob({ site, token, title: tab.title, text, sources: profile });
    const answer = await fetch(post, init);
    const body = await answer.json().catch(() => ({}));
    if (!answer.ok) throw new Error(`${answer.status} ${body.error ?? ''}`);
    const [{ id }] = body;
    const read = { credentials: 'omit', headers: { 'X-CSRF-Token': token } };
    for (let i = 0; i < 300; i += 1) {
      const job = await (await fetch(jobUrl(site, id), read)).json();
      if (job.status === 'done') {
        pdf.href = URL.createObjectURL(await (await fetch(pdfUrl(site, id), read)).blob());
        pdf.hidden = false;
        status.textContent = 'CV prêt : il est effacé du serveur dans 30 minutes.';
        return;
      }
      if (job.status !== 'queued' && job.status !== 'running') throw new Error(job.error ?? job.status);
      status.textContent = `CV en préparation… ${job.position ? `(file : ${job.position})` : (job.steps ?? []).at(-1) ?? ''}`;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error('trop long : réessaie plus tard');
  } catch (error) {
    status.textContent = `Échec : ${error.message}`;
    service.disabled = false;
  }
});
