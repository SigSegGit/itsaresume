// 4.6 (ADR-12): the add-on reads only what the user shows it, on a click.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { offerText } from '../addon/extract.js';

const manifest = JSON.parse(readFileSync(new URL('../addon/manifest.json', import.meta.url), 'utf8'));

test('4.6: the add-on asks for the active tab on a click, nothing in the background', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'storage']);
  assert.equal(manifest.host_permissions, undefined, 'no site read without a click');
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.content_scripts, undefined);
});

const page = ({ selection = '', blocks = {}, body = '' }) => ({
  getSelection: () => ({ toString: () => selection }),
  querySelector: (selector) => (blocks[selector] ? { innerText: blocks[selector] } : null),
  body: { innerText: body },
});

test('4.6: the selection first, else the job description block, else the page', () => {
  assert.equal(offerText(page({ selection: '  Senior SRE  ', blocks: { '#job-details': 'x' } })), 'Senior SRE');
  assert.equal(offerText(page({ blocks: { '#job-details': 'Platform engineer, Kubernetes.' }, body: 'menu' })), 'Platform engineer, Kubernetes.');
  assert.equal(offerText(page({ body: 'An offer.' })), 'An offer.');
  assert.equal(offerText(page({ body: 'x'.repeat(70000) })).length, 60000, 'cut to what the generator takes');
});

test('4.7: the add-on may reach the generator only through hosts the user grants (optional)', () => {
  assert.deepEqual(manifest.optional_host_permissions, ['http://127.0.0.1/*', 'https://*/*']);
});

// 6.2: service mode. The candidate's profile stays in the browser
// (chrome.storage.local, never sync, never a server but the one run); the
// popup takes the public page's visitor token, posts offer + profile, polls,
// and offers the PDF.
import { tokenFromPage, packProfile, serviceJob, jobUrl, pdfUrl, PROFILE_KINDS } from '../addon/service.js';

test('6.2: the visitor token is read from the public page, nothing else', () => {
  const token = 'a'.repeat(48);
  assert.equal(tokenFromPage(`<meta name="csrf-token" content="${token}">`), token);
  assert.equal(tokenFromPage('<meta name="csrf-token" content="__CSRF_TOKEN__">'), null);
  assert.equal(tokenFromPage('<p>maintenance</p>'), null);
});

test('6.2: a profile is packed as the server takes it, and refused otherwise', () => {
  const bytes = (text) => new TextEncoder().encode(text);
  assert.deepEqual(PROFILE_KINDS, ['.zip', '.json', '.pdf', '.docx', '.txt', '.md']);
  assert.deepEqual(packProfile([{ name: 'cv.txt', bytes: bytes('Sam Doe') }]), [{ name: 'cv.txt', data: Buffer.from('Sam Doe').toString('base64') }]);
  const big = new Uint8Array(200000).fill(65);
  assert.equal(packProfile([{ name: 'Basic_LinkedInDataExport.zip', bytes: big }])[0].data, Buffer.from(big).toString('base64'), 'large files survive');
  assert.throws(() => packProfile([]), /aucun fichier/);
  assert.throws(() => packProfile([{ name: 'cv.exe', bytes: bytes('x') }]), /\.exe/);
  assert.throws(() => packProfile([{ name: '../cv.txt', bytes: bytes('x') }]), /nom/);
  assert.throws(() => packProfile([{ name: '.cv.txt', bytes: bytes('x') }]), /nom/);
  assert.throws(() => packProfile(Array.from({ length: 11 }, (_, i) => ({ name: `${i}.txt`, bytes: bytes('x') }))), /10/);
  assert.throws(() => packProfile([{ name: 'cv.pdf', bytes: new Uint8Array(400000) }]), /trop gros/);
});

test('6.2: the request carries the offer, the profile and the token, to the site’s own paths', () => {
  const sources = [{ name: 'cv.txt', data: 'U2Ft' }];
  const { url, init } = serviceJob({ site: 'https://cv.example.org/', token: 't0k', title: 'x'.repeat(100), text: 'Senior SRE', sources });
  assert.equal(url, 'https://cv.example.org/api/jobs');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit', 'the token rides in the header, no cookie');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': 't0k' });
  assert.deepEqual(JSON.parse(init.body), { offers: [{ title: 'x'.repeat(80), text: 'Senior SRE' }], sources });
  assert.throws(() => serviceJob({ site: 'http://cv.example.org/', token: 't', title: '', text: 'x', sources }), /https/);
  assert.equal(jobUrl('https://cv.example.org/', 'abc'), 'https://cv.example.org/api/jobs/abc');
  assert.equal(pdfUrl('https://cv.example.org/', 'abc'), 'https://cv.example.org/api/jobs/abc/files/cv.pdf');
});

test('6.2: the profile is kept in chrome.storage.local only, never synced', () => {
  const options = readFileSync(new URL('../addon/options.js', import.meta.url), 'utf8');
  const popup = readFileSync(new URL('../addon/popup.js', import.meta.url), 'utf8');
  assert.match(options, /chrome\.storage\.local\.set\(\{ profile/);
  assert.match(popup, /chrome\.storage\.local\.get\(\['profile'/);
  for (const code of [options, popup]) assert.doesNotMatch(code, /storage\.sync\.\w+\([^)]*profile/);
});
