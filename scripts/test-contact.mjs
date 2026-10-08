import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileWorker} from './compile-worker.mjs';
import {contactConfig} from '../worker/contact.js';

const origin = 'https://entity-one.test';
const key = '12345678-1234-4321-abcd-123456789abc';
let checks = 0;
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
for (const value of [undefined, null, 42, {}, '', '  ', 'sk-private-not-a-form-key', key + '\nInjected: true', 'https://invalid.example/form']) {
  equal(contactConfig({WEB3FORMS_ACCESS_KEY: value}), {available: false, key: ''}, 'Only UUID form identifiers can be public');
}
equal(contactConfig({WEB3FORMS_ACCESS_KEY: ` ${key} `}), {available: true, key}, 'Configured UUID is trimmed');

const content = JSON.parse(await readFile('public/content.json', 'utf8'));
const {default: application} = await import('data:text/javascript;base64,' + Buffer.from(await compileWorker({content})).toString('base64'));
const runtimeSecrets = {ANTHROPIC_API_KEY: 'PRIVATE-CLAUDE-SECRET', DISCORD_AUDIT_WEBHOOK_URL: 'PRIVATE-DISCORD-SECRET', ADMIN_INITIAL_PASSWORD: 'PRIVATE-ADMIN-SECRET'};
let deferred = 0, outbound = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { outbound++; throw new Error('This test must not send email or contact any external service.'); };
async function request(path, {method = 'GET', env = {}, originHeader = origin} = {}) {
  const result = await application.fetch(new Request(origin + path, {method, headers: {'Content-Type': 'application/json', Origin: originHeader}, ...(method === 'GET' ? {} : {body: '{}'})}), {...runtimeSecrets, ...env}, {waitUntil() { deferred++; }});
  return {result, data: await result.json()};
}

try {
  const inactive = await request('/api/contact/config');
  equal(inactive.result.status, 200);
  equal(inactive.data, {available: false, key: ''}, 'No key means visibly unavailable, never fake success');
  const configured = await request('/api/contact/config', {env: {WEB3FORMS_ACCESS_KEY: key}});
  equal(configured.data, {available: true, key}, 'Only the intentionally public form identifier is returned');
  equal(configured.result.headers.get('Cache-Control'), 'no-store', 'Activation changes are not cached');
  equal(configured.result.headers.get('Content-Security-Policy').split(';').find(value => value.trim().startsWith('connect-src')).trim(), "connect-src 'self' https://api.web3forms.com", 'Browser transport allows just the required HTTPS provider');
  equal(JSON.stringify(configured.data).includes('PRIVATE'), false, 'Other runtime secrets remain private');
  const invalid = await request('/api/contact/config', {env: {WEB3FORMS_ACCESS_KEY: runtimeSecrets.ANTHROPIC_API_KEY}});
  equal(invalid.data, {available: false, key: ''}, 'Mistaken secret configuration stays private');
  equal((await request('/api/contact', {method: 'POST', env: {WEB3FORMS_ACCESS_KEY: key}})).result.status, 404, 'No unsupported server email proxy exists');
  equal((await request('/api/contact/config', {method: 'POST', originHeader: 'https://foreign.example'})).result.status, 403, 'Existing same-origin policy remains enforced on writes');
  equal(deferred, 0, 'Contact configuration never schedules Discord audit delivery');
  equal(outbound, 0, 'Configuration and rejected proxy requests make no provider calls');
  console.log(`PASS: ${checks} contact configuration checks; no real email sent.`);
} finally {
  globalThis.fetch = realFetch;
}
