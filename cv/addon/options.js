// 4.6: the generator's address: the local page by default, or a public one.
const input = document.getElementById('url');
chrome.storage.sync.get('url').then(({ url }) => { input.value = url ?? ''; });
document.getElementById('save').addEventListener('click', () => {
  const url = input.value.trim();
  if (url && !/^https?:\/\//.test(url)) return;
  chrome.storage.sync.set({ url: url || undefined });
});
