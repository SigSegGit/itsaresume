// 6.2: the add-on in service mode, its pure parts. The candidate's profile
// files are packed as the public server takes them (`sources`: at most 10
// files { name, data base64 }, 480 000 base64 characters each); the visitor
// token comes from the public page (its csrf-token meta) and rides in the
// header, never a cookie; https only, to the site's own paths.
export const PROFILE_KINDS = ['.zip', '.json', '.pdf', '.docx', '.txt', '.md'];
const MAX_FILES = 10;
const MAX_BYTES = 360000;

export function tokenFromPage(html) {
  return /<meta name="csrf-token" content="([0-9a-f]{48})">/.exec(String(html))?.[1] ?? null;
}

function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function packProfile(files) {
  if (!files?.length) throw new Error('aucun fichier de profil');
  if (files.length > MAX_FILES) throw new Error(`au plus ${MAX_FILES} fichiers`);
  return files.map(({ name, bytes }) => {
    if (!/^[^\\/:*?"<>|]{1,120}$/.test(name) || name.startsWith('.')) throw new Error(`nom de fichier refusé : ${name}`);
    const kind = (/\.[^.]+$/.exec(name)?.[0] ?? '').toLowerCase();
    if (!PROFILE_KINDS.includes(kind)) throw new Error(`${kind || name} : attendu ${PROFILE_KINDS.join(' ')}`);
    if (bytes.length > MAX_BYTES) throw new Error(`${name} : trop gros (${Math.round(MAX_BYTES / 1000)} ko au plus)`);
    return { name, data: base64(bytes) };
  });
}

function siteOf(site) {
  const url = new URL(site);
  if (url.protocol !== 'https:') throw new Error('le site du service doit être en https');
  return url;
}

/** 2026-11-24: the invitation code of a link (`…/?i=<code>`) or a bare code, else null. */
export function inviteCode(given) {
  const text = String(given ?? '').trim();
  const code = /[?&]i=([0-9a-f]{24})(?:&|#|$)/.exec(text)?.[1] ?? (/^[0-9a-f]{24}$/.test(text) ? text : null);
  return code;
}

export function serviceJob({ site, token, title, text, sources, invite }) {
  return {
    url: new URL('/api/jobs', siteOf(site)).href,
    init: {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ offers: [{ title: String(title ?? '').slice(0, 80), text }], sources, ...(invite ? { invite } : {}) }),
    },
  };
}

export const jobUrl = (site, id) => new URL(`/api/jobs/${encodeURIComponent(id)}`, siteOf(site)).href;
export const pdfUrl = (site, id) => new URL(`/api/jobs/${encodeURIComponent(id)}/files/cv.pdf`, siteOf(site)).href;
