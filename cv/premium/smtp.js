// 6.11: the premium links (address check, new password) by SMTP, no
// dependency. PREMIUM_SMTP_URL=smtps://user:password@host[:465] (implicit
// TLS) or smtp://...[:587] (STARTTLS, required before AUTH unless the relay
// is on this machine); PREMIUM_MAIL_FROM="itsaresume <noreply@example.org>".
// Both live in $DATA/.env on the VM, never in the repository.

import { randomBytes } from 'node:crypto';
import { connect as plainConnect } from 'node:net';
import { hostname } from 'node:os';
import { connect as tlsConnect } from 'node:tls';

const LOCAL = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const ADDRESS = /^[^\s<>@",;:\\]+@[^\s<>@",;:\\]+$/;

/** A header value: kept when plain printable ASCII, else RFC 2047 base64 (no line break can survive). */
export function encodeHeader(value) {
  const text = String(value);
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function addressOf(value) {
  const text = String(value ?? '').trim();
  const address = /<([^>]*)>\s*$/.exec(text)?.[1] ?? text;
  if (!ADDRESS.test(address)) throw new Error(`not a mail address: ${JSON.stringify(text).slice(0, 80)}`);
  return address;
}

export function smtpConfig(url, from) {
  const parsed = new URL(url);
  if (!['smtp:', 'smtps:'].includes(parsed.protocol)) throw new Error('PREMIUM_SMTP_URL must start with smtp:// or smtps://');
  const secure = parsed.protocol === 'smtps:';
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const sender = addressOf(from);
  return {
    host,
    servername: host,
    port: Number(parsed.port) || (secure ? 465 : 587),
    secure,
    local: LOCAL.has(parsed.hostname),
    user: decodeURIComponent(parsed.username),
    pass: decodeURIComponent(parsed.password),
    from: String(from).trim(),
    sender,
    domain: sender.split('@')[1],
  };
}

/** The mailer from the environment, or null (the demo outbox stays). */
export function mailerFromEnv(env = process.env) {
  if (!env.PREMIUM_SMTP_URL) return null;
  if (!env.PREMIUM_MAIL_FROM) throw new Error('PREMIUM_SMTP_URL needs PREMIUM_MAIL_FROM (the sender address)');
  return createSmtpMailer(smtpConfig(env.PREMIUM_SMTP_URL, env.PREMIUM_MAIL_FROM));
}

/** Replies read line by line; `next()` resolves one whole (multi-line) reply. */
function replies(socket) {
  let buffer = '';
  let lines = [];
  const ready = [];
  const waiting = [];
  let failure = null;
  const push = (item) => (waiting.length ? waiting.shift()(item) : ready.push(item));
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let at;
    while ((at = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      lines.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        push({ code: Number(line.slice(0, 3)), lines });
        lines = [];
      }
    }
  };
  const onEnd = (error) => {
    failure = error ?? new Error('the SMTP server closed the connection');
    while (waiting.length) waiting.shift()({ error: failure });
  };
  socket.on('data', onData);
  socket.on('error', onEnd);
  socket.on('close', () => onEnd());
  return {
    next: () => new Promise((resolve) => (ready.length ? resolve(ready.shift()) : failure ? resolve({ error: failure }) : waiting.push(resolve))),
    detach: () => { socket.off('data', onData); socket.removeAllListeners('error'); socket.removeAllListeners('close'); },
  };
}

function message(config, to, subject, text) {
  const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  const headers = [
    `From: ${config.from.replace(/[\r\n]/g, '')}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${config.domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  // Dot-stuffing: base64 never starts a line with ".", kept for safety.
  return `${headers.join('\r\n')}\r\n\r\n${body}`.replace(/^\./gm, '..');
}

export function createSmtpMailer(config, { timeoutMs = 30000 } = {}) {
  return {
    async send({ to, subject, text }) {
      const recipient = addressOf(to);
      let socket = config.secure
        ? tlsConnect({ host: config.host, port: config.port, servername: config.servername })
        : plainConnect({ host: config.host, port: config.port });
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('the SMTP server did not answer in time')));
      let reader = replies(socket);
      const expect = async (codes, said) => {
        const reply = await reader.next();
        if (reply.error) throw reply.error;
        if (!codes.includes(reply.code)) throw new Error(`SMTP ${said ?? 'greeting'}: ${reply.lines.join(' | ')}`);
        return reply;
      };
      const say = (line, codes, shown = line) => { socket.write(`${line}\r\n`); return expect(codes, shown); };
      try {
        await expect([220]);
        const helo = `EHLO ${hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost'}`;
        let extensions = (await say(helo, [250])).lines.map((line) => line.slice(4).toUpperCase());
        let encrypted = config.secure;
        if (!encrypted && extensions.includes('STARTTLS')) {
          await say('STARTTLS', [220]);
          reader.detach();
          socket = tlsConnect({ socket, servername: config.servername });
          await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
          reader = replies(socket);
          encrypted = true;
          extensions = (await say(helo, [250])).lines.map((line) => line.slice(4).toUpperCase());
        }
        if (config.user) {
          if (!encrypted && !config.local) throw new Error('the SMTP server offers no STARTTLS: the password would cross in clear, refused');
          await say(`AUTH PLAIN ${Buffer.from(`\0${config.user}\0${config.pass}`, 'utf8').toString('base64')}`, [235], 'AUTH');
        }
        await say(`MAIL FROM:<${config.sender}>`, [250]);
        await say(`RCPT TO:<${recipient}>`, [250, 251]);
        await say('DATA', [354]);
        await say(`${message(config, recipient, subject, text)}.`, [250], 'DATA end');
        await say('QUIT', [221]).catch(() => {});
      } finally {
        socket.end();
      }
    },
  };
}
