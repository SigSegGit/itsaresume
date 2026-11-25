#!/usr/bin/env node
// 2026-11-25: age v1 files (https://age-encryption.org/v1), X25519 recipients
// only, with node:crypto alone: what the premium backup writes is opened by
// the official `age` tool and the owner's identity, never by this server.
//   node premium/age.js keygen      prints a new identity file (keep it offline)
//   node premium/age.js decrypt <identity file> <file.age> <out>

import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INTRO = 'age-encryption.org/v1';
const CHUNK = 65536;
const TAG = 16;
const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');

// --- bech32 (BIP 173), without the 90-character limit, as age uses it ---

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) check ^= GEN[i];
  }
  return check >>> 0;
}

const expand = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));

function convert(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & ((1 << to) - 1));
    }
  }
  if (pad && bits) out.push((acc << (to - bits)) & ((1 << to) - 1));
  else if (!pad && (bits >= from || ((acc << (to - bits)) & ((1 << to) - 1)))) throw new Error('bech32: bad padding');
  return out;
}

function bech32Encode(hrp, bytes) {
  const data = convert(bytes, 8, 5, true);
  const mod = polymod([...expand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...check].map((v) => ALPHABET[v]).join('')}`;
}

function bech32Decode(text, hrp, what) {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) throw new Error(`${what}: mixed case`);
  const lower = text.toLowerCase();
  const at = lower.lastIndexOf('1');
  if (lower.slice(0, at) !== hrp || lower.length - at < 8) throw new Error(`${what}: not one`);
  const values = [...lower.slice(at + 1)].map((c) => ALPHABET.indexOf(c));
  if (values.includes(-1) || polymod([...expand(hrp), ...values]) !== 1) throw new Error(`${what}: bad checksum`);
  const bytes = Buffer.from(convert(values.slice(0, -6), 5, 8, false));
  if (bytes.length !== 32) throw new Error(`${what}: not 32 bytes`);
  return bytes;
}

// --- keys ---

const publicKey = (raw) => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
const privateKey = (raw) => createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8' });
const rawPublic = (key) => key.export({ format: 'der', type: 'spki' }).subarray(SPKI.length);

/** The 32 bytes of an `age1…` recipient; throws when it is not one. */
export function parseRecipient(text) {
  return bech32Decode(String(text).trim(), 'age', 'an age recipient');
}

/** The 32 bytes of the `AGE-SECRET-KEY-1…` line of an identity (file text accepted). */
export function parseIdentity(text) {
  const line = String(text).split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith('AGE-SECRET-KEY-1'));
  if (!line) throw new Error('an age identity: no AGE-SECRET-KEY-1 line');
  return bech32Decode(line, 'age-secret-key-', 'an age identity');
}

/** The recipient (public key) of an identity. */
export function recipientOf(identity) {
  return bech32Encode('age', rawPublic(publicKey(rawPublic(createPublicKey(privateKey(parseIdentity(identity)))))));
}

export function generateIdentity() {
  const { privateKey: secret, publicKey: open } = generateKeyPairSync('x25519');
  const raw = secret.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8.length);
  return { identity: bech32Encode('age-secret-key-', raw).toUpperCase(), recipient: bech32Encode('age', rawPublic(open)) };
}

// --- the format ---

const b64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/=+$/, '');
const unb64 = (text) => {
  if (!/^[A-Za-z0-9+/]*$/.test(text)) throw new Error('age: bad base64');
  return Buffer.from(text, 'base64');
};
const hkdf = (ikm, salt, info) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));

function seal(key, nonce, plain) {
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function open(key, nonce, sealed) {
  if (sealed.length < TAG) throw new Error('age: truncated');
  const decipher = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG)), decipher.final()]);
}

/** A stanza body: base64 lines of 64 columns, the last one shorter (maybe empty). */
function bodyLines(bytes) {
  const text = b64(bytes);
  const lines = [];
  for (let i = 0; i <= text.length; i += 64) lines.push(text.slice(i, i + 64));
  return lines.join('\n');
}

const ZERO_NONCE = Buffer.alloc(12);
const streamNonce = (counter, last) => {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(counter), 3);
  nonce[11] = last ? 1 : 0;
  return nonce;
};

function x25519Stanza(fileKey, recipient) {
  const them = parseRecipient(recipient);
  const { privateKey: ephemeral, publicKey: share } = generateKeyPairSync('x25519');
  const shareRaw = rawPublic(share);
  const shared = diffieHellman({ privateKey: ephemeral, publicKey: publicKey(them) });
  const wrap = hkdf(shared, Buffer.concat([shareRaw, them]), 'age-encryption.org/v1/X25519');
  return `-> X25519 ${b64(shareRaw)}\n${bodyLines(seal(wrap, ZERO_NONCE, fileKey))}\n`;
}

/** `plain` encrypted for every recipient (`age1…`), as an age v1 file. */
export function encrypt(plain, recipients) {
  if (!recipients.length) throw new Error('age: no recipient');
  const fileKey = randomBytes(16);
  const head = `${INTRO}\n${recipients.map((recipient) => x25519Stanza(fileKey, recipient)).join('')}---`;
  const mac = createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(head).digest();
  const nonce = randomBytes(16);
  const key = hkdf(fileKey, nonce, 'payload');
  const chunks = [];
  const count = Math.max(1, Math.ceil(plain.length / CHUNK));
  for (let i = 0; i < count; i += 1) chunks.push(seal(key, streamNonce(i, i === count - 1), plain.subarray(i * CHUNK, (i + 1) * CHUNK)));
  return Buffer.concat([Buffer.from(`${head} ${b64(mac)}\n`, 'latin1'), nonce, ...chunks]);
}

/** The plain bytes of an age v1 file, for an identity of one of its X25519 recipients. */
export function decrypt(sealed, identity) {
  const secretRaw = parseIdentity(identity);
  const ours = rawPublic(createPublicKey(privateKey(secretRaw)));
  const end = sealed.indexOf('\n--- ');
  if (end < 0 || sealed.subarray(0, INTRO.length + 1).toString('latin1') !== `${INTRO}\n`) throw new Error('age: not an age v1 file');
  const macEnd = sealed.indexOf('\n', end + 5);
  if (macEnd < 0) throw new Error('age: truncated header');
  const head = sealed.subarray(0, end + 4).toString('latin1');
  const lines = head.split('\n').slice(1, -1);
  let fileKey = null;
  for (let i = 0; i < lines.length;) {
    const args = lines[i].split(' ');
    if (args[0] !== '->') throw new Error('age: bad stanza');
    let body = '';
    for (i += 1; ; i += 1) {
      if (i >= lines.length) throw new Error('age: bad stanza body');
      body += lines[i];
      if (lines[i].length < 64) break;
    }
    i += 1;
    if (fileKey || args[1] !== 'X25519' || args.length !== 3) continue;
    const share = unb64(args[2]);
    if (share.length !== 32) throw new Error('age: bad X25519 share');
    const shared = diffieHellman({ privateKey: privateKey(secretRaw), publicKey: publicKey(share) });
    try {
      fileKey = open(hkdf(shared, Buffer.concat([share, ours]), 'age-encryption.org/v1/X25519'), ZERO_NONCE, unb64(body));
    } catch {
      // another recipient's stanza
    }
  }
  if (!fileKey) throw new Error('age: no identity matched any recipient');
  const mac = createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(head).digest();
  const given = unb64(sealed.subarray(end + 5, macEnd).toString('latin1'));
  if (given.length !== mac.length || !timingSafeEqual(given, mac)) throw new Error('age: header MAC mismatch');
  const nonce = sealed.subarray(macEnd + 1, macEnd + 17);
  if (nonce.length !== 16) throw new Error('age: truncated');
  const key = hkdf(fileKey, nonce, 'payload');
  const payload = sealed.subarray(macEnd + 17);
  const parts = [];
  const size = CHUNK + TAG;
  const count = Math.max(1, Math.ceil(payload.length / size));
  for (let i = 0; i < count; i += 1) {
    const part = open(key, streamNonce(i, i === count - 1), payload.subarray(i * size, (i + 1) * size));
    if (i < count - 1 && part.length !== CHUNK) throw new Error('age: short chunk');
    if (i === count - 1 && count > 1 && part.length === 0) throw new Error('age: empty last chunk');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function main([command, ...args]) {
  if (command === 'keygen') {
    const { identity, recipient } = generateIdentity();
    process.stdout.write(`# created: ${new Date().toISOString()}\n# public key: ${recipient}\n${identity}\n`);
  } else if (command === 'decrypt' && args.length === 3) {
    writeFileSync(args[2], decrypt(readFileSync(args[1]), readFileSync(args[0], 'utf8')), { mode: 0o600 });
  } else {
    process.stderr.write('usage: node premium/age.js keygen | decrypt <identity file> <file.age> <out>\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
