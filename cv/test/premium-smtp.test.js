// 6.11 (2026-11-23): premium sends its links by SMTP (PREMIUM_SMTP_URL), so
// the verified-address gate can be on. A fake server records the dialogue.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createSmtpMailer, encodeHeader, mailerFromEnv, smtpConfig } from '../premium/smtp.js';

/** A fake SMTP server: `ehlo` lists its extensions, `fail` maps a verb to a reply. */
function fakeServer({ ehlo = ['AUTH PLAIN LOGIN'], fail = {} } = {}) {
  const sessions = [];
  const server = createServer((socket) => {
    const lines = [];
    sessions.push(lines);
    let data = false;
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at;
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        lines.push(line);
        if (data) {
          if (line === '.') { data = false; socket.write('250 queued\r\n'); }
          continue;
        }
        const verb = line.split(/[ :]/)[0].toUpperCase();
        if (fail[verb]) { socket.write(`${fail[verb]}\r\n`); continue; }
        if (verb === 'EHLO') socket.write(['250-fake', ...ehlo.map((e, i) => `250${i === ehlo.length - 1 ? ' ' : '-'}${e}`)].join('\r\n') + (ehlo.length ? '' : '250 fake') + '\r\n');
        else if (verb === 'AUTH') socket.write('235 ok\r\n');
        else if (verb === 'DATA') { data = true; socket.write('354 go\r\n'); }
        else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, sessions, port: server.address().port })));
}

test('a mail goes out: EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA dot-stuffed, UTF-8 subject encoded', async () => {
  const { server, sessions, port } = await fakeServer();
  try {
    const mailer = createSmtpMailer(smtpConfig(`smtp://user%40x.org:p%C3%A4ss@127.0.0.1:${port}`, 'itsaresume <noreply@x.org>'));
    await mailer.send({ to: 'Ana@Example.org', subject: 'itsaresume : confirmez', text: 'Lien :\n.caché\nfin' });
    const lines = sessions[0];
    assert.match(lines[0], /^EHLO /);
    const auth = lines.find((line) => line.startsWith('AUTH PLAIN '));
    assert.equal(Buffer.from(auth.slice(11), 'base64').toString('utf8'), '\0user@x.org\0päss');
    assert.ok(lines.includes('MAIL FROM:<noreply@x.org>'));
    assert.ok(lines.includes('RCPT TO:<Ana@Example.org>'));
    assert.ok(lines.includes(`Subject: ${encodeHeader('itsaresume : confirmez')}`));
    assert.ok(lines.includes('Content-Type: text/plain; charset=utf-8'));
    assert.ok(lines.some((line) => /^Message-ID: <.+@x\.org>$/.test(line)));
    const body = lines.slice(lines.indexOf('') + 1, lines.lastIndexOf('.'));
    assert.equal(Buffer.from(body.join(''), 'base64').toString('utf8'), 'Lien :\r\n.caché\r\nfin');
    assert.equal(lines.at(-1), 'QUIT');
  } finally {
    server.close();
  }
});

test('a refused recipient is an error that names the reply', async () => {
  const { server, port } = await fakeServer({ fail: { RCPT: '550 no such user' } });
  try {
    const mailer = createSmtpMailer(smtpConfig(`smtp://u:p@127.0.0.1:${port}`, 'noreply@x.org'));
    await assert.rejects(mailer.send({ to: 'a@b.org', subject: 's', text: 't' }), /550 no such user/);
  } finally {
    server.close();
  }
});

test('the password never crosses an unencrypted link to another host: no STARTTLS, no AUTH', async () => {
  const { server, sessions, port } = await fakeServer({ ehlo: ['AUTH PLAIN'] });
  try {
    // 127.0.0.1 is let through in clear (a local relay); "localhost.test" stands for any other host.
    const config = { ...smtpConfig(`smtp://u:p@127.0.0.1:${port}`, 'noreply@x.org'), host: '127.0.0.1', servername: 'mail.example.org', local: false };
    await assert.rejects(createSmtpMailer(config).send({ to: 'a@b.org', subject: 's', text: 't' }), /STARTTLS/);
    assert.ok(!sessions[0].some((line) => line.startsWith('AUTH')));
  } finally {
    server.close();
  }
});

test('a header line cannot be injected through the address or the subject', async () => {
  const mailer = createSmtpMailer(smtpConfig('smtp://u:p@127.0.0.1:1', 'noreply@x.org'));
  await assert.rejects(mailer.send({ to: 'a@b.org\r\nBcc: c@d.org', subject: 's', text: 't' }), /address/);
  assert.doesNotMatch(encodeHeader('a\r\nBcc: x'), /[\r\n]/);
});

test('the configuration: smtps or smtp with a sender; nothing set is the demo outbox', () => {
  assert.equal(mailerFromEnv({}), null);
  assert.throws(() => mailerFromEnv({ PREMIUM_SMTP_URL: 'smtp://u:p@mail.example.org' }), /PREMIUM_MAIL_FROM/);
  assert.throws(() => smtpConfig('http://mail.example.org', 'a@b.org'), /smtp/);
  const tls = smtpConfig('smtps://u:p@mail.example.org', 'a@b.org');
  assert.deepEqual([tls.secure, tls.port, tls.local], [true, 465, false]);
  const plain = smtpConfig('smtp://u:p@mail.example.org', 'a@b.org');
  assert.deepEqual([plain.secure, plain.port], [false, 587]);
  assert.equal(typeof mailerFromEnv({ PREMIUM_SMTP_URL: 'smtps://u:p@mail.example.org', PREMIUM_MAIL_FROM: 'a@b.org' }).send, 'function');
});
