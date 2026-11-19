// 6.4: the account add-on. Reads the open page only on a click (activeTab):
// the user's own LinkedIn profile (linkedin.js), or the job offer shown.
const $ = (id) => document.getElementById(id);
const say = (text) => { $('status').textContent = text; };

// Self-contained, serialised into the page: the selection, else the job
// block (LinkedIn's, then common ones), else the page's text.
function offerText() {
  const selected = String(getSelection()?.toString() ?? '').trim();
  if (selected) return selected.slice(0, 60000);
  for (const selector of ['#job-details', '.jobs-description__content', '[data-testid="jobDescriptionText"]', 'main']) {
    const text = String(document.querySelector(selector)?.innerText ?? '').trim();
    if (text) return text.slice(0, 60000);
  }
  return String(document.body?.innerText ?? '').trim().slice(0, 60000);
}

async function settings() {
  return chrome.storage.local.get({ server: 'http://127.0.0.1:18791', token: '' });
}

async function api(path, body) {
  const { server, token } = await settings();
  if (!token) throw new Error('Renseignez le serveur et le jeton (« Compte »).');
  const response = await fetch(server.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
  return json;
}

async function inTab(options) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, ...options });
  return { tab, value: result?.result };
}

$('save').addEventListener('click', async () => {
  const server = $('server').value.trim().replace(/\/$/, '');
  const granted = await chrome.permissions.request({ origins: [`${new URL(server).origin}/*`] });
  if (!granted) return say('Autorisation refusée pour ce serveur.');
  await chrome.storage.local.set({ server, token: $('token').value.trim() });
  say('Compte enregistré.');
});

$('import').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!/^https:\/\/www\.linkedin\.com\/in\//.test(tab.url ?? '')) return say('Ouvrez votre profil LinkedIn (linkedin.com/in/…).');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['linkedin.js'] });
    const { value: resume } = await inTab({ func: () => linkedInProfile() }); // eslint-disable-line no-undef
    if (!resume?.work?.length) return say('Aucune expérience trouvée : dépliez la section Expérience et réessayez.');
    await api('/api/profile', { resume });
    say(`Profil importé : ${resume.basics.name}, ${resume.work.length} expérience(s).`);
  } catch (error) {
    say(error.message);
  }
});

$('preview').addEventListener('click', async () => {
  try {
    say('Analyse en cours (1 à 2 minutes)…');
    const { value: offer } = await inTab({ func: offerText });
    const preview = await api('/api/preview', { offer });
    say(`Adéquation : ${preview.score}/100 (${preview.verdict}).`);
    $('reqs').replaceChildren(...preview.requirements.map((req) => Object.assign(document.createElement('li'), { textContent: req.name, className: req.match })));
  } catch (error) {
    say(error.message);
  }
});

$('generate').addEventListener('click', async () => {
  try {
    const { value: offer } = await inTab({ func: offerText });
    await api('/api/generate', { offer });
    const { server } = await settings();
    chrome.tabs.create({ url: `${server}/#account` });
  } catch (error) {
    say(error.message);
  }
});

settings().then(({ server, token }) => {
  $('server').value = server;
  $('token').value = token;
  if (!token) $('settings').open = true;
});
