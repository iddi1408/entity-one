import assert from 'node:assert/strict';
import {applyCompanyDetails} from './company-details.mjs';

// Credentials stay in process memory and enter only through hidden stdin.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
console.log('Ready for company update JSON on stdin (input is hidden).');
let raw = '';
const config = await new Promise((resolve, reject) => {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.includes('\u0003')) process.exit(130);
    if (raw.length > 10000) return reject(new Error('Input too large.'));
    if (/[\r\n]/.test(raw)) {
      process.stdin.pause();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      try { resolve(JSON.parse(raw.trim())); } catch { reject(new Error('Invalid input.')); }
    }
  });
});
const origin = new URL(config.url).origin;
assert.equal(new URL(origin).protocol, 'https:');
let cookie = '', csrf = '';
async function request(route, method='GET', value) {
  const headers = {Origin: origin, ...(cookie ? {Cookie: cookie} : {}), ...(csrf ? {'X-CSRF-Token': csrf} : {})};
  if (value !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(origin+route, {method, headers, redirect:'error', body:value === undefined ? undefined : JSON.stringify(value), signal:AbortSignal.timeout(30000)});
}
async function json(route) {
  const response = await request(route);
  assert.equal(response.status, 200, `${route} response`);
  return response.json();
}
try {
  const login = await request('/api/login','POST',{username:config.username,password:config.password});
  assert.equal(login.status,200,'Administrator sign-in');
  cookie = (login.headers.get('Set-Cookie') || '').split(';')[0];
  csrf = (await login.json()).csrfToken;
  assert.ok(cookie && csrf);
  const before = await json('/api/content');
  const next = applyCompanyDetails(before.content);
  assert.deepEqual(next.listings, before.content.listings, 'All current listings are preserved');
  assert.deepEqual(next.settings.socials, before.content.settings.socials, 'Current social links are preserved');
  const saved = await request('/api/content','PUT',{revision:before.revision,content:next});
  assert.equal(saved.status,200,'Update must match the current revision; a conflict requires a fresh review');
  const after = await json('/api/content');
  assert.deepEqual(after.content, next, 'Saved company details match, with all other content preserved');
  console.log(`Company details updated and verified at revision ${after.revision}; ${after.content.listings.length} listings preserved.`);
} finally {
  if (csrf) await request('/api/logout','POST').catch(()=>{});
}
