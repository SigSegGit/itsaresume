// Source hygiene. A zero-width or bidi-override character in code reads as
// one thing and runs as another ("Trojan Source", CVE-2021-42574). One slipped
// into src/guard.js through an editing tool on 2026-09-24; this keeps it out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['src', 'bin', 'test', 'tools', 'scripts', 'web', 'docs'];
const TEXT = new Set(['.js', '.mjs', '.json', '.py', '.ps1', '.md', '.html', '.css', '.yml', '.yaml']);
const INVISIBLE = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];

function* files(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== '__pycache__') yield* files(path);
    } else if (TEXT.has(extname(name))) yield path;
  }
}

/** A sabotage plan names the exact text it breaks; when the code moves, the
 * plan must follow, or the defence silently stops being verified. Running the
 * plans takes minutes, counting their anchors takes none. */
test('every sabotage anchor appears exactly once in its file', () => {
  const stale = [];
  for (const name of readdirSync(join(ROOT, 'scripts', 'sabotage')).filter((file) => file.endsWith('.json'))) {
    const plan = JSON.parse(readFileSync(join(ROOT, 'scripts', 'sabotage', name), 'utf8'));
    for (const [defence, { file, live }] of Object.entries(plan.defences)) {
      const count = readFileSync(join(ROOT, file), 'utf8').split(live).length - 1;
      if (count !== 1) stale.push(`${name} | ${defence}: ${count} times in ${file}`);
    }
  }
  assert.deepEqual(stale, []);
});

/** .gitattributes says LF, but a Windows tool writing in text mode leaves CRLF
 * in the working copy, and multi-line sabotage anchors then silently miss. */
test('source files end their lines with LF, PowerShell scripts aside', () => {
  const found = [];
  for (const dir of DIRS) {
    for (const path of files(join(ROOT, dir))) {
      if (extname(path) !== '.ps1' && readFileSync(path, 'utf8').includes('\r\n')) found.push(path.slice(ROOT.length));
    }
  }
  assert.deepEqual(found, []);
});

test('no source file contains an invisible or bidi control character', () => {
  const found = [];
  for (const dir of DIRS) {
    for (const path of files(join(ROOT, dir))) {
      readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
        for (const char of line) {
          const code = char.codePointAt(0);
          if (INVISIBLE.some(([from, to]) => code >= from && code <= to)) {
            found.push(`${path.slice(ROOT.length)}:${index + 1} U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
          }
        }
      });
    }
  }
  assert.deepEqual(found, []);
});
