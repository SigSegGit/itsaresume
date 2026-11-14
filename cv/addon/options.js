// 4.6/4.7: the generator's address (local page by default) and, to post
// offers directly, the key the owner gave `serve` (ITSACV_ADDON_KEY). The
// host is granted on save, by the user: nothing else is reachable.
const url = document.getElementById('url');
const key = document.getElementById('key');
const saved = document.getElementById('saved');
chrome.storage.sync.get(['url', 'key']).then((stored) => { url.value = stored.url ?? ''; key.value = stored.key ?? ''; });
document.getElementById('save').addEventListener('click', async () => {
  const address = url.value.trim() || 'http://127.0.0.1:18790/';
  if (!/^https?:\/\//.test(address)) { saved.textContent = 'adresse http(s) attendue'; return; }
  const granted = await chrome.permissions.request({ origins: [`${new URL(address).origin}/*`] });
  await chrome.storage.sync.set({ url: address, key: key.value.trim() });
  saved.textContent = granted ? 'enregistré' : 'enregistré (accès au site refusé : copie seulement)';
});
