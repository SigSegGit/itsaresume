// 2026-11-25 (the owner): the encrypted journal is only a backup while the
// ITSaNAS node next to it copies it away. Its first status line says how many
// other machines hold the newest file (`copies HAVE of WANT`), rewritten every
// 30 s. The premium service reads it and tells the admins when the backup has
// had fewer than 2 copies for 10 minutes, or when the line is missing or old:
// a node that stopped says nothing, and that silence is the case that matters.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BEHIND_AFTER_MS, STALE_AFTER_MS, createBackupWatch, readCopies } from '../premium/backup-watch.js';

const T0 = 1795564811;
const line = (rest) => `snapshot ${T0} every 300 version 0.1.21 ${rest}\nother lines\n`;

test('the status line read: copies, the time it was written, and nothing invented', () => {
  assert.deepEqual(readCopies(line('copies 6 of 2 reached 1795564659')), { have: 6, want: 2, at: T0 * 1000 });
  assert.deepEqual(readCopies(line('copies 1 of 2 since 1795564000 reached 1')), { have: 1, want: 2, at: T0 * 1000 });
  assert.deepEqual(readCopies(line('reached never since 1795564000')), { have: 0, want: null, at: T0 * 1000 }, 'nothing stored yet is no copy');
  assert.equal(readCopies('copies 6 of 2\n').at, null, 'no snapshot time: the caller uses the file time');
  assert.equal(readCopies('second line only\ncopies 6 of 2\n').have, 0, 'only the first line counts');
  assert.equal(readCopies('').have, 0);
});

function setup(text) {
  const home = mkdtempSync(join(tmpdir(), 'watch-'));
  if (text !== null) writeFileSync(join(home, 'status.snapshot'), text);
  return home;
}

function watchOf(home, clock) {
  const mails = [];
  const watch = createBackupWatch({ home, now: () => clock.now, alert: (mail) => mails.push(mail) });
  return { watch, mails };
}

test('two copies or more: ok, and no mail', () => {
  const home = setup(line('copies 2 of 2'));
  const clock = { now: T0 * 1000 + 30000 };
  const { watch, mails } = watchOf(home, clock);
  assert.equal(watch.check().state, 'ok');
  assert.equal(watch.status().have, 2);
  assert.equal(mails.length, 0);
  rmSync(home, { recursive: true });
});

test('fewer than 2 copies: quiet for 10 minutes, then one mail, then one when it is back', () => {
  const home = setup(line('copies 1 of 2'));
  const clock = { now: T0 * 1000 };
  const { watch, mails } = watchOf(home, clock);
  const write = (rest) => writeFileSync(join(home, 'status.snapshot'), `snapshot ${Math.floor(clock.now / 1000)} every 300 ${rest}\n`);
  assert.equal(watch.check().state, 'short', 'a write on its way out');
  clock.now += BEHIND_AFTER_MS - 1000;
  write('copies 1 of 2');
  assert.equal(watch.check().state, 'short');
  assert.equal(mails.length, 0, 'not before 10 minutes');
  clock.now += 2000;
  write('copies 1 of 2');
  assert.equal(watch.check().state, 'behind');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /sauvegarde|backup/i);
  assert.match(mails[0].text, /copies 1 of 2/);
  clock.now += 60000;
  write('copies 0 of 2');
  watch.check();
  assert.equal(mails.length, 1, 'one mail per incident, not one per check');
  clock.now += 60000;
  write('copies 3 of 2');
  assert.equal(watch.check().state, 'ok');
  assert.equal(mails.length, 2, 'the end of the incident is said too');
  assert.match(mails[1].text, /copies 3 of 2/);
  clock.now += 60000;
  write('copies 1 of 2');
  assert.equal(watch.check().state, 'short', 'a new shortfall starts its own 10 minutes');
  rmSync(home, { recursive: true });
});

test('a line written long ago, or no line at all, is an alert at once: the node is not there', () => {
  const old = setup(line('copies 6 of 2'));
  const clock = { now: T0 * 1000 + STALE_AFTER_MS + 1000 };
  const one = watchOf(old, clock);
  assert.equal(one.watch.check().state, 'stale', 'six copies said long ago prove nothing now');
  assert.equal(one.mails.length, 1);
  assert.match(one.mails[0].text, /status\.snapshot/);

  const none = setup(null);
  const two = watchOf(none, clock);
  assert.equal(two.watch.check().state, 'missing');
  assert.equal(two.mails.length, 1);

  const gone = join(none, 'no-such-home');
  const three = createBackupWatch({ home: gone, now: () => clock.now, alert: () => {} });
  assert.equal(three.check().state, 'missing', 'a home that is not mounted is missing, not a crash');

  // Without a snapshot time, the file's own time decides.
  const bare = setup('copies 6 of 2\n');
  const file = join(bare, 'status.snapshot');
  const fresh = createBackupWatch({ home: bare, now: () => Date.now(), alert: () => {} });
  assert.equal(fresh.check().state, 'ok');
  utimesSync(file, new Date(Date.now() - STALE_AFTER_MS - 60000), new Date(Date.now() - STALE_AFTER_MS - 60000));
  assert.equal(fresh.check().state, 'stale');
  for (const dir of [old, none, bare]) rmSync(dir, { recursive: true });
});

test('a failing mail does not stop the watch, and is tried again at the next check', async () => {
  const home = setup(null);
  let tries = 0;
  const watch = createBackupWatch({ home, now: () => T0 * 1000, alert: async () => { tries += 1; if (tries === 1) throw new Error('smtp down'); } });
  watch.check();
  await watch.idle();
  watch.check();
  await watch.idle();
  assert.equal(tries, 2);
  watch.check();
  await watch.idle();
  assert.equal(tries, 2, 'sent once it went through');
  rmSync(home, { recursive: true });
});
