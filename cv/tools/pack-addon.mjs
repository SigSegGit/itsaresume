#!/usr/bin/env node
// 6.3: the add-on as a zip, for "Load unpacked" after unzipping or for a
// store upload. Only what the manifest reaches goes in: its pages, the
// scripts they load, the modules those import. A fixed date per entry keeps
// the bytes the same for the same files.
//   node tools/pack-addon.mjs [outDir]   (default: dist)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import PizZip from 'pizzip';

const FIXED = new Date(Date.UTC(2026, 0, 1));
const pathOf = (dir) => (dir instanceof URL ? fileURLToPath(dir) : String(dir));

function referenced(name, text) {
  const found = [];
  if (name.endsWith('.html')) for (const m of text.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) found.push(m[1]);
  if (name.endsWith('.js')) for (const m of text.matchAll(/(?:^|\n)\s*import\b[^'"]*['"]([^'"]+)['"]/g)) found.push(m[1]);
  return found
    .filter((ref) => !/^[a-z]+:|^\/\//i.test(ref))
    .map((ref) => posix.normalize(posix.join(posix.dirname(name), ref)));
}

/** The files the manifest reaches, relative to `dir`, sorted. */
export function addonFiles(dir) {
  const root = pathOf(dir);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const start = [
    manifest.action?.default_popup,
    manifest.options_page,
    manifest.options_ui?.page,
    manifest.background?.service_worker,
    ...(manifest.content_scripts ?? []).flatMap((entry) => [...(entry.js ?? []), ...(entry.css ?? [])]),
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ].filter(Boolean);
  const seen = new Set(['manifest.json']);
  const queue = [...start];
  while (queue.length) {
    const name = posix.normalize(queue.shift());
    if (seen.has(name)) continue;
    if (name.startsWith('..')) throw new Error(`the add-on reaches outside its folder: ${name}`);
    let text;
    try {
      text = readFileSync(join(root, normalize(name)));
    } catch {
      throw new Error(`the add-on reaches ${name}, which is missing`);
    }
    seen.add(name);
    if (/\.(html|js)$/.test(name)) queue.push(...referenced(name, text.toString('utf8')));
  }
  return [...seen].sort();
}

/** `{ name, buffer }`: the zip, named by the manifest's version. */
export function packAddon(dir) {
  const root = pathOf(dir);
  const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const zip = new PizZip();
  for (const name of addonFiles(root)) zip.file(name, readFileSync(join(root, normalize(name))), { date: FIXED, binary: true });
  return { name: `itsaresume-addon-${version}.zip`, buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = process.argv[2] ?? 'dist';
  const { name, buffer } = packAddon(new URL('../addon/', import.meta.url));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, name), buffer);
  console.log(join(out, name));
}

