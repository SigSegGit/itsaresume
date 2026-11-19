// 4.6/4.7: the generator's address (local page by default) and, to post
// offers directly, the key the owner gave `serve` (ITSACV_ADDON_KEY). The
// host is granted on save, by the user: nothing else is reachable.
// 6.2: service mode, the candidate's own profile, kept in
// chrome.storage.local only (never sync), sent only to the service site.
import { packProfile } from './service.js';

const url = document.getElementById('url');
const key = document.getElementById('key');
const saved = document.getElementById('saved');
const site = document.getElementById('site');
const kept = document.getElementById('kept');
chrome.storage.sync.get(['url', 'key']).then((stored) => { url.value = stored.url ?? ''; key.value = stored.key ?? ''; });
chrome.storage.local.get(['site', 'profile']).then((stored) => {
  site.value = stored.site ?? '';
  kept.textContent = stored.profile?.length ? `profil : ${stored.profile.map((file) => file.name).join(', ')}` : 'aucun profil';
});
document.getElementById('save').addEventListener('click', async () => {
  const address = url.value.trim() || 'http://127.0.0.1:18790/';
  if (!/^https?:\/\//.test(address)) { saved.textContent = 'adresse http(s) attendue'; return; }
  const granted = await chrome.permissions.request({ origins: [`${new URL(address).origin}/*`] });
  await chrome.storage.sync.set({ url: address, key: key.value.trim() });
  saved.textContent = granted ? 'enregistré' : 'enregistré (accès au site refusé : copie seulement)';
});
document.getElementById('keep').addEventListener('click', async () => {
  try {
    const address = site.value.trim();
    if (!/^https:\/\/[^/]+/.test(address)) throw new Error('site https attendu');
    const files = await Promise.all([...document.getElementById('files').files].map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
    const profile = packProfile(files);
    if (!(await chrome.permissions.request({ origins: [`${new URL(address).origin}/*`] }))) throw new Error('accès au site refusé');
    await chrome.storage.local.set({ profile, site: address });
    kept.textContent = `profil : ${profile.map((file) => file.name).join(', ')}`;
  } catch (error) {
    kept.textContent = `refusé : ${error.message}`;
  }
});
document.getElementById('forget').addEventListener('click', async () => {
  await chrome.storage.local.remove(['profile']);
  kept.textContent = 'aucun profil';
});
