import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes, pbkdf2Sync, createHash} from 'node:crypto';
import {once} from 'node:events';
import {createPreviewServer} from './preview.mjs';
import {localDB} from './d1-local.mjs';

// Entirely isolated: no real administrator, live listener, or runtime database.
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'e1-preview-test-'));
const publicDirectory = path.join(temporaryRoot, 'public'), runtimeDirectory = path.join(temporaryRoot, 'runtime');
const outsideDirectory = path.join(temporaryRoot, 'outside');
const DB = localDB();
let server;
try {
  await Promise.all([mkdir(publicDirectory), mkdir(outsideDirectory)]);
  const seed = JSON.parse(await readFile('public/content.json', 'utf8'));
  const secret = 'ISOLATED-PRIVATE-NOTES', draft = {...seed.listings.find(item => item.type === 'inventory'), id: 'preview-private-draft', status: 'draft', internalNotes: secret};
  seed.listings.push(draft);
  seed.listings[0].internalNotes = secret;
  seed.settings.github = {token: secret};
  await Promise.all([
    writeFile(path.join(publicDirectory, 'content.json'), JSON.stringify(seed)),
    writeFile(path.join(publicDirectory, 'index.html'), '<!doctype html><title>Isolated preview test</title>'),
    writeFile(path.join(publicDirectory, 'app.js'), 'export const isolated = true;'),
    writeFile(path.join(outsideDirectory, 'probe.js'), secret),
    symlink(outsideDirectory, path.join(publicDirectory, 'linked'), 'junction')
  ]);
  const credentials = {username: 'isolated-test-admin', password: randomBytes(32).toString('base64url')};
  const salt = randomBytes(32).toString('hex');
  const hash = pbkdf2Sync(credentials.password, salt, 600000, 32, 'sha256').toString('hex');
  await DB.prepare('INSERT INTO administrator (id, username, salt, hash, hash_version) VALUES (1, ?, ?, ?, ?)').bind(credentials.username, salt, hash, 'pbkdf2-sha256-600000-v1').run();
  server = await createPreviewServer({publicDirectory, runtimeDirectory, database: DB});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let checks = 0;
  async function request(route, {method = 'GET', value, headers = {}, body} = {}) {
    const response = await fetch(origin + route, {method, headers: {Origin: origin, ...(value === undefined ? {} : {'Content-Type': 'application/json'}), ...headers}, body: value === undefined ? body : JSON.stringify(value)});
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    assert.match(response.headers.get('Content-Security-Policy'), /script-src 'self' 'wasm-unsafe-eval';/);
    assert.match(response.headers.get('Content-Security-Policy'), /worker-src 'self';/);
    assert.doesNotMatch(response.headers.get('Content-Security-Policy'), /(?:^|\s)'unsafe-eval'(?:\s|;|$)/);
    assert.match(response.headers.get('Content-Security-Policy'), /style-src 'self';/);
    assert.doesNotMatch(response.headers.get('Content-Security-Policy'), /unsafe-inline/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    checks++;
    return {response, bytes, data: response.headers.get('Content-Type')?.includes('application/json') && bytes.length ? JSON.parse(bytes) : null};
  }
  async function raw(route, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request(origin, {path: route, method, headers}, res => {
        const bytes = []; res.on('data', chunk => bytes.push(chunk));
        res.on('end', () => resolve({status: res.statusCode, headers: res.headers, bytes: Buffer.concat(bytes)}));
      }); req.on('error', reject); req.end();
    });
  }
  assert.deepEqual((await request('/api/session')).data, {authenticated: false, localOnly: true});
  assert.equal((await request('/api/media')).response.status, 401);
  assert.equal((await request('/api/media', {headers: {'OAI-Authenticated-User-Id': 'owner', 'X-Authenticated-User': 'owner'}})).response.status, 401);
  for (const route of ['/content.json', '/CONTENT.JSON', '/content.JSON']) {
    const result = await request(route);
    assert.equal(result.response.status, 200); assert.ok(!result.bytes.includes(secret));
    assert.ok(!result.data.listings.some(item => item.id === draft.id));
  }
  for (const route of ['/', '/app.js', '/not-found.png', '/.sites-runtime/preview.sqlite', '/api/commit/', '/api/setup/']) await request(route);
  assert.equal((await raw('/', {Host: 'evil.example'})).status, 403);
  for (const route of ['/linked/probe.js', '/%2e%2e/probe.js', '/..%5cprobe.js', '/content.json%20', '/assets/nul.js']) {
    const result = await raw(route); assert.ok([403, 404].includes(result.status), `${route}: ${result.status}`);
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.ok(!result.bytes.includes(secret));
  }
  assert.equal((await request('/', {method: 'POST'})).response.status, 405);
  const login = await request('/api/login', {method: 'POST', value: credentials});
  assert.equal(login.response.status, 200, JSON.stringify(login.data));
  const cookie = login.response.headers.get('Set-Cookie').split(';')[0];
  assert.match(cookie, /^e1-local=[a-f0-9]{64}$/);
  const session = await request('/api/session', {headers: {Cookie: cookie}});
  assert.equal(session.data.localOnly, true); assert.equal(session.data.authenticated, true);
  const csrf = session.data.csrfToken, auth = {Cookie: cookie, 'X-CSRF-Token': csrf};
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV4sAAAAASUVORK5CYII=', 'base64');
  function multipart(bytes = png, name = 'photo.jpg', type = 'image/jpeg') { const form = new FormData(); form.set('file', new Blob([bytes], {type}), name); return form; }
  const upload = (headers, bytes, name, type) => request('/api/media', {method: 'POST', headers, body: multipart(bytes, name, type)});
  assert.equal((await upload({})).response.status, 401);
  assert.equal((await upload({Cookie: cookie})).response.status, 403);
  assert.equal((await upload({...auth, 'X-CSRF-Token': 'wrong'})).response.status, 403);
  assert.equal((await upload({...auth, Origin: 'https://evil.example'})).response.status, 403);
  assert.equal((await upload({...auth, 'Sec-Fetch-Site': 'cross-site'})).response.status, 403);
  assert.equal((await upload(auth, Buffer.from('<svg><script>alert(1)</script></svg>'), 'photo.png', 'image/png')).response.status, 415);
  assert.equal((await upload(auth, Buffer.alloc(8 * 1024 * 1024 + 1), 'large.png', 'image/png')).response.status, 413);
  const saved = await upload(auth, png, '../../photo.jpg');
  assert.equal(saved.response.status, 201, JSON.stringify(saved.data));
  const item = saved.data.media;
  assert.match(item.url, /^\/assets\/uploads\/[0-9a-f-]+\.png$/);
  assert.equal(item.size, png.length); assert.equal(item.name, 'photo.jpg');
  assert.deepEqual(Object.keys(item).sort(), ['id', 'name', 'size', 'uploadedAt', 'url']);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'media.upload'").first()).count, 1);
  assert.deepEqual((await request('/api/media', {headers: auth})).data.media, [{...item, inUse: false}]);
  assert.equal((await request(item.url)).response.status, 404);
  const privateImage = await request(item.url, {headers: auth});
  assert.equal(privateImage.response.status, 200); assert.equal(privateImage.response.headers.get('Content-Type'), 'image/png'); assert.deepEqual(privateImage.bytes, png);
  const headImage = await request(item.url, {method: 'HEAD', headers: auth});
  assert.equal(headImage.response.status, 200); assert.equal(headImage.bytes.length, 0);
  const current = (await request('/api/content', {headers: auth})).data;
  let content = current.content, revision = current.revision;
  content.listings.find(listing => listing.id === draft.id).image = item.url;
  async function saveContent() {
    const result = await request('/api/content', {method: 'PUT', headers: auth, value: {content, revision}});
    assert.equal(result.response.status, 200, JSON.stringify(result.data)); revision = result.data.revision;
  }
  await saveContent();
  assert.equal((await request(item.url)).response.status, 404, 'Draft images stay private even when URL is known');
  for (const setReference of [
    value => { content.listings[0].image = value || seed.listings[0].image; },
    value => { content.listings[0].gallery = value ? [value] : []; },
    value => { content.settings.heroImage = value; },
    value => { content.settings.aboutImage = value; },
    value => { content.settings.partners[0].image = value; }
  ]) {
    setReference(item.url); await saveContent();
    assert.equal((await request(item.url)).response.status, 200, 'Public image references are served');
    setReference(''); await saveContent();
    assert.equal((await request(item.url)).response.status, 404, 'Removing public reference protects image again');
  }
  const projected = await request('/CONTENT.JSON', {headers: auth});
  assert.ok(!projected.bytes.includes(secret)); assert.ok(!projected.data.listings.some(item => item.id === draft.id));
  const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  const secondImage = await upload(auth, webp, 'photo.png', 'image/png');
  assert.equal(secondImage.response.status, 201);
  assert.ok(secondImage.data.media.url.endsWith('.webp'));
  assert.equal((await request(secondImage.data.media.url, {headers: auth})).response.headers.get('Content-Type'), 'image/webp');
  assert.equal((await request(secondImage.data.media.url)).response.status, 404);
  const manifest = (await request('/api/media', {headers: auth})).data.media;
  assert.deepEqual(manifest.map(entry => entry.id), [secondImage.data.media.id, item.id], 'Newest images come first');
  const removePath = '/api/media/' + secondImage.data.media.url.split('/').at(-1);
  assert.equal((await request(removePath, {method: 'DELETE'})).response.status, 401);
  assert.equal((await request(removePath, {method: 'DELETE', headers: {Cookie: cookie}})).response.status, 403);
  assert.equal((await request(removePath, {method: 'DELETE', headers: {...auth, Origin: 'https://evil.example'}})).response.status, 403);
  assert.equal((await request('/api/media/invalid.png', {method: 'DELETE', headers: auth})).response.status, 404);
  const invited = await request('/api/users', {method: 'POST', headers: auth, value: {username: 'media-reader', role: 'viewer', permissions: ['media.read']}});
  assert.equal(invited.response.status, 201);
  const readerLogin = await request('/api/login', {method: 'POST', value: {username: 'media-reader', password: invited.data.temporaryPassword}});
  const readerTemp = {Cookie: readerLogin.response.headers.get('Set-Cookie').split(';')[0], 'X-CSRF-Token': readerLogin.data.csrfToken};
  assert.equal((await request(removePath, {method: 'DELETE', headers: readerTemp})).response.status, 403, 'Password-change gate protects delete');
  const readerPassword = randomBytes(28).toString('base64url');
  const readerChanged = await request('/api/account/password', {method: 'POST', headers: readerTemp, value: {currentPassword: invited.data.temporaryPassword, newPassword: readerPassword, confirmPassword: readerPassword}});
  assert.equal(readerChanged.response.status, 200);
  const readerAuth = {Cookie: readerChanged.response.headers.get('Set-Cookie').split(';')[0], 'X-CSRF-Token': readerChanged.data.csrfToken};
  assert.equal((await request('/api/media', {headers: readerAuth})).response.status, 200);
  assert.equal((await request(removePath, {method: 'DELETE', headers: readerAuth})).response.status, 403, 'Media read permission cannot delete uploads');
  content.listings.find(listing => listing.id === draft.id).image = secondImage.data.media.url; await saveContent();
  assert.equal((await request('/api/media', {headers: auth})).data.media.find(m => m.id === secondImage.data.media.id).inUse, true);
  assert.equal((await request(removePath, {method: 'DELETE', headers: auth})).response.status, 409, 'Private draft reference prevents deletion');
  content.listings.find(listing => listing.id === draft.id).image = item.url; await saveContent();
  assert.equal((await request(removePath, {method: 'DELETE', headers: auth})).response.status, 200);
  assert.equal((await request(removePath, {method: 'DELETE', headers: auth})).response.status, 404);
  assert.equal((await request(secondImage.data.media.url, {headers: auth})).response.status, 404);
  const deletionLog = await DB.prepare("SELECT actor_username, actor_role FROM audit_log WHERE action = 'media.delete'").first();
  assert.equal(deletionLog.actor_username, credentials.username); assert.equal(deletionLog.actor_role, 'owner');
  // Pause a valid multipart request after authentication, then revoke its session.
  const delayedLogin = await request('/api/login', {method: 'POST', value: credentials});
  const delayedCookie = delayedLogin.response.headers.get('Set-Cookie').split(';')[0];
  const delayedForm = new Request(origin + '/api/media', {method: 'POST', body: multipart()});
  const delayedBytes = Buffer.from(await delayedForm.arrayBuffer());
  let observed;
  const authenticated = new Promise(resolve => { observed = resolve; });
  const prepare = DB.prepare;
  DB.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith('UPDATE sessions SET last_seen')) {
      const run = statement.run;
      statement.run = async () => { const result = await run(); observed(); return result; };
    }
    return statement;
  };
  let delayedRequest;
  const delayedResult = new Promise((resolve, reject) => {
    delayedRequest = http.request(origin + '/api/media', {method: 'POST', headers: {Origin: origin, Cookie: delayedCookie, 'X-CSRF-Token': delayedLogin.data.csrfToken, 'Content-Type': delayedForm.headers.get('Content-Type'), 'Content-Length': delayedBytes.length}}, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }); delayedRequest.on('error', reject); delayedRequest.write(delayedBytes.subarray(0, 32));
  });
  await authenticated; DB.prepare = prepare;
  await DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(createHash('sha256').update(delayedCookie.split('=')[1]).digest('hex')).run();
  delayedRequest.end(delayedBytes.subarray(32));
  assert.equal(await delayedResult, 401, 'An upload cannot finish using a session revoked during buffering');
  const previousBuckets = (await DB.prepare('SELECT bucket FROM rate_limits').all()).results.map(row => row.bucket);
  for (const address of ['198.51.100.1', '198.51.100.2']) await request('/api/login', {method: 'POST', value: {...credentials, password: randomBytes(32).toString('hex')}, headers: {'CF-Connecting-IP': address, 'X-Forwarded-For': address}});
  const rateLimits = (await DB.prepare('SELECT bucket FROM rate_limits').all()).results.map(row => row.bucket);
  const localBucket = createHash('sha256').update('login:ip:127.0.0.1').digest('hex');
  const accountBucket = createHash('sha256').update('login:account:' + credentials.username.toLowerCase()).digest('hex');
  assert.deepEqual(rateLimits.sort(), [...new Set([...previousBuckets, localBucket, accountBucket])].sort(), 'Client headers cannot choose the rate-limit identity');
  assert.equal((await request('/api/logout', {method: 'POST', headers: auth, value: {}})).response.status, 200);
  assert.equal((await upload(auth)).response.status, 401);
  assert.equal((await request('/api/media', {headers: auth})).response.status, 401);
  const files = await readdir(path.join(runtimeDirectory, 'uploads'));
  assert.equal(files.length, 2, 'Only the remaining image and metadata remain after deletion');
  console.log(`Preview adapter passed ${checks} HTTP response checks plus isolated storage, CSRF, media visibility, Windows path, and trusted-IP assertions.`);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  DB.close();
  const resolved = path.resolve(temporaryRoot), allowed = path.resolve(tmpdir()) + path.sep;
  if (!resolved.startsWith(allowed) || !path.basename(resolved).startsWith('e1-preview-test-')) throw new Error('Unsafe test cleanup path');
  await rm(resolved, {recursive: true, force: true});
}
