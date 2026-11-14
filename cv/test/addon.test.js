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
