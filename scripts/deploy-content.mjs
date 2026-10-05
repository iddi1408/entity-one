import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import assert from 'node:assert/strict';

// Secrets enter through hidden stdin and are never persisted or printed.
async function input() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  console.log('Ready for deployment JSON on stdin (input is hidden).');
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      value += chunk;
      if (value.length > 24000) return reject(new Error('Input too large.'));
      if (value.includes('\u0003')) process.exit(130);
      if (/[\r\n]/.test(value)) {
        process.stdin.pause();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        try { resolve(JSON.parse(value.trim())); } catch { reject(new Error('Invalid deployment input.')); }
      }
    });
  });
}

try {
  const config = await input(), origin = new URL(config.url).origin;
  assert.equal(new URL(origin).protocol, 'https:', 'HTTPS required');
  assert.ok(['migrate', 'verify'].includes(config.mode));
  let cookie = '', csrf = '';
  async function call(route, {method = 'GET', value, bytes, form, anonymous = false, omitCsrf = false} = {}) {
    assert.ok(route.startsWith('/') && !route.startsWith('//'));
    const headers = {Origin:origin};
    if (config.bypassBearer) headers['OAI-Sites-Authorization'] = 'Bearer ' + config.bypassBearer;
    if (!anonymous && cookie) headers.Cookie = cookie;
    if (!anonymous && csrf && !omitCsrf) headers['X-CSRF-Token'] = csrf;
    if (value !== undefined) headers['Content-Type'] = 'application/json';
    if (bytes) headers['Content-Type'] = 'application/octet-stream';
    return fetch(new URL(route, origin), {method, headers, redirect:'manual', body:form || bytes || (value === undefined ? undefined : JSON.stringify(value)), signal:AbortSignal.timeout(60000)});
  }
  async function json(route, options) {
    const response = await call(route, options);
    if (!response.ok) throw new Error(`${route.split('?')[0]} returned HTTP ${response.status}.`);
    return response.json();
  }
  const login = await call('/api/login', {method:'POST', value:{username:config.username, password:config.password}});
  if (!login.ok) throw new Error(`Admin login returned HTTP ${login.status}.`);
  cookie = (login.headers.get('Set-Cookie') || '').split(';')[0];
  csrf = (await login.json()).csrfToken;
  assert.match(cookie, /^__Host-e1=/); assert.ok(csrf);
  console.log('Hosted administrator authenticated.');
  const assets = JSON.parse(await readFile('.sites-runtime/deploy-assets.json', 'utf8'));
  if (config.mode === 'migrate') {
    let count = 0;
    for (const asset of assets) {
      const response = await call('/api/admin/site-assets/' + asset.hash, {method:'PUT', bytes:await readFile(asset.filename)});
      if (!response.ok) throw new Error(`Asset upload failed: ${asset.path} (${response.status}).`);
      if (++count % 5 === 0 || count === assets.length) console.log(`Stored ${count}/${assets.length} full-quality assets.`);
    }
    const database = new DatabaseSync(path.resolve('.sites-runtime/preview.sqlite'), {readOnly:true});
    const row = database.prepare("SELECT body FROM site_content WHERE id = 'main'").get();
    database.close();
    const content = row ? JSON.parse(row.body) : JSON.parse(await readFile('public/content.json', 'utf8'));
    const references = new Set();
    function find(value) {
      if (typeof value === 'string' && /^\/assets\/uploads\/[a-f0-9-]+\.(png|jpg|webp)$/.test(value)) references.add(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(find);
    }
    find(content);
    const replacements = new Map();
    const existing = (await json('/api/media')).media;
    for (const reference of references) {
      const name = path.posix.basename(reference), data = await readFile(path.resolve('.sites-runtime/uploads', name));
      const found = existing.find(item => item.name === name && item.size === data.length);
      if (found) { replacements.set(reference, found.url); continue; }
      const form = new FormData();
      form.set('file', new Blob([data], {type: name.endsWith('.png') ? 'image/png' : name.endsWith('.jpg') ? 'image/jpeg' : 'image/webp'}), name);
      const uploaded = await json('/api/media', {method:'POST', form});
      replacements.set(reference, uploaded.media.url);
    }
    function replace(value) {
      if (typeof value === 'string') return replacements.get(value) || value;
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
      return value;
    }
    const next = replace(content), remote = await json('/api/content');
    if (remote.revision === 0) await json('/api/content', {method:'PUT', value:{revision:0, content:next}});
    else assert.deepEqual(remote.content, next, 'Hosted content has changed; refusing to overwrite it.');
    console.log(`Migrated current collection and ${references.size} uploaded images; local sessions and history remain private.`);
  }
  for (const route of ['/api/admin/overview', '/api/backups', '/api/media']) await json(route);
  assert.equal((await call('/api/content', {method:'PUT', value:{}, omitCsrf:true})).status, 403);
  const publicData = await json('/api/content', {anonymous:true});
  for (const listing of publicData.content.listings) {
    assert.ok(!('internalNotes' in listing));
    assert.ok(!['draft','sold','fulfilled'].includes(listing.status));
  }
  for (const route of ['/api/media','/api/admin/overview','/api/backups']) assert.equal((await call(route, {anonymous:true})).status, 401);
  for (const asset of assets) {
    const response = await call(asset.path, {method:'HEAD', anonymous:true});
    assert.equal(response.status, 200, asset.path);
    assert.equal(response.headers.get('Content-Type'), asset.type, asset.path);
  }
  for (const route of ['/', '/inventory', '/wanted', '/about', '/contact', '/exclusive', '/admin', '/app.js', '/favicon.svg']) assert.equal((await call(route, {anonymous:true})).status, 200, route);
  if (publicData.content.settings.heroImage) assert.equal((await call(publicData.content.settings.heroImage, {method:'HEAD', anonymous:true})).status, 200, 'Hero image');
  await json('/api/logout', {method:'POST', value:{}});
  assert.equal((await json('/api/session')).authenticated, false);
  console.log(`PASS: hosted login, protected admin APIs, CSRF, content, hero and ${assets.length} full-quality assets.`);
} catch (error) {
  console.error(error instanceof assert.AssertionError ? 'Deployment verification failed: ' + error.message.split('\n')[0] : error.message);
  process.exitCode = 1;
}
