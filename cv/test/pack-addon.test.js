// 6.3 (2026-11-23): the add-on zipped for loading or publishing: the manifest
// and what it reaches (pages, their scripts, the scripts' imports), nothing
// else from the folder; the same bytes from the same files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PizZip from 'pizzip';
import { addonFiles, packAddon } from '../tools/pack-addon.mjs';

const ADDON = new URL('../addon/', import.meta.url);

test('the add-on zip holds the manifest and every file it reaches, named by its version', () => {
  const { name, buffer } = packAddon(ADDON);
  assert.match(name, /^itsaresume-addon-\d+\.\d+\.\d+\.zip$/);
  const names = Object.keys(new PizZip(buffer).files).sort();
  assert.deepEqual(names, ['extract.js', 'manifest.json', 'options.html', 'options.js', 'popup.html', 'popup.js', 'service.js']);
});

test('a file the manifest never reaches stays out; a reached file missing stops the pack', () => {
  const dir = mkdtempSync(join(tmpdir(), 'addon-'));
  cpSync(ADDON, dir, { recursive: true });
  writeFileSync(join(dir, 'notes.md'), 'private draft');
  writeFileSync(join(dir, '.env'), 'TOKEN=x');
  assert.ok(!addonFiles(dir).includes('notes.md'));
  assert.ok(!addonFiles(dir).includes('.env'));
  rmSync(join(dir, 'service.js'));
  assert.throws(() => addonFiles(dir), /service\.js/);
});

test('the same files give the same zip, byte for byte', () => {
  assert.ok(packAddon(ADDON).buffer.equals(packAddon(ADDON).buffer));
});
