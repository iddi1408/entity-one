import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHostedAssetRoutes} from '../worker/site-assets.js';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const origin = 'https://entity-one.example', bytes = new TextEncoder().encode('known build asset');
const hash = createHash('sha256').update(bytes).digest('hex');
const route = '/api/admin/site-assets/' + hash;
const assets = {'/assets/art.png': {type: 'image/png', size: bytes.length, hash, storage: 'r2'}, '/app.js': {type: 'text/javascript', bytes: 'embedded'}};
const objects = new Map(), calls = [];
const bucket = {
  async put(key, value, options) { calls.push(['put', key]); objects.set(key, {bytes: new Uint8Array(value), options}); return {key}; },
  async get(key) { calls.push(['get', key]); const object = objects.get(key); return object ? {size: object.bytes.length, body: new Response(object.bytes).body} : null; },
  async head(key) { calls.push(['head', key]); const object = objects.get(key); return object ? {size: object.bytes.length} : null; }
};
const auth = {Cookie: 'isolated=true', 'X-CSRF-Token': 'test-csrf', 'Content-Type': 'application/octet-stream'};
const session = {tokenHash: 'a'.repeat(64)};
let revoked = false, checks = 0, requirements = [];
async function call(path, options = {}, environment = {BUCKET: bucket}, manifest = assets) {
  checks++;
  const request = new Request(origin + path, {method: options.method || 'GET', headers: {Origin: origin, ...options.headers}, ...(options.body === undefined ? {} : {body: options.body}), ...(options.body instanceof ReadableStream ? {duplex: 'half'} : {})});
  return createHostedAssetRoutes({request, env: environment, path, assets: manifest,
    authenticated: async () => revoked ? null : session,
    requireAdmin: async mutation => { requirements.push(mutation); if (request.headers.get('Cookie') !== auth.Cookie) throw new HttpError(401, 'Authentication required'); if (request.headers.get('X-CSRF-Token') !== auth['X-CSRF-Token']) throw new HttpError(403, 'CSRF required'); return session; },
    security: {'Content-Security-Policy': "default-src 'self'", 'X-Content-Type-Options': 'nosniff'},
    json: (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json', ...headers}}), HttpError
  });
}
async function rejects(expected, path, options, environment, manifest) {
  await assert.rejects(call(path, options, environment, manifest), error => error instanceof HttpError && error.status === expected);
}
const put = (extra = {}) => ({method: 'PUT', headers: auth, body: bytes, ...extra});

assert.equal(await call('/unknown'), null); assert.equal(await call('/app.js'), null);
assert.equal(await call('/assets/uploads/private.png'), null);
await rejects(401, route, put({headers: {'Content-Type': 'application/octet-stream'}}));
await rejects(403, route, put({headers: {...auth, 'X-CSRF-Token': ''}}));
for (const headers of [{...auth, Origin: 'https://evil.example'}, {...auth, Origin: 'null'}, {...auth, 'Sec-Fetch-Site': 'cross-site'}]) await rejects(403, route, put({headers}));
await rejects(415, route, put({headers: {...auth, 'Content-Type': 'application/json'}}));
await rejects(405, route, {method: 'POST', headers: auth, body: bytes});
await rejects(404, '/api/admin/site-assets/' + '0'.repeat(64), put());
await rejects(404, '/api/admin/site-assets/../../private', put());
await rejects(503, route, put(), {});
await rejects(503, '/assets/art.png', {}, {});
await rejects(503, '/assets/art.png');
await rejects(503, route, put(), {BUCKET: bucket}, {'/too-big': {storage: 'r2', type: 'image/png', hash, size: 16 * 1024 * 1024 + 1}});
await rejects(413, route, put({body: new Uint8Array(bytes.length + 1)}));
await rejects(400, route, put({body: bytes.slice(1)}));
await rejects(413, route, put({headers: {...auth, 'Content-Length': String(bytes.length + 1)}}));
await rejects(400, route, put({body: new Uint8Array(bytes.length)}));
revoked = true; await rejects(401, route, put()); revoked = false;
assert.equal(objects.size, 0, 'Every failed upload leaves the bucket untouched');
const result = await call(route, put());
assert.deepEqual(await result.json(), {stored: true}); assert.equal(result.headers.get('Cache-Control'), 'no-store');
assert.deepEqual([...objects.keys()], ['site-assets/' + hash]);
assert.ok(requirements.length > 0 && requirements.every(Boolean), 'Every upload uses mutation authorization');
const image = await call('/assets/art.png');
assert.equal(image.status, 200); assert.deepEqual(new Uint8Array(await image.arrayBuffer()), bytes);
assert.equal(image.headers.get('Content-Type'), 'image/png');
assert.equal(image.headers.get('Cache-Control'), 'public, max-age=3600');
assert.equal(image.headers.get('Content-Security-Policy'), "default-src 'self'");
assert.equal(image.headers.get('ETag'), '"' + hash + '"');
assert.equal(image.headers.get('X-Content-Type-Options'), 'nosniff');
const head = await call('/assets/art.png', {method: 'HEAD'});
assert.equal((await head.arrayBuffer()).byteLength, 0); assert.equal(calls.at(-1)[0], 'head');
const cached = await call('/assets/art.png', {headers: {'If-None-Match': '"' + hash + '"'}});
assert.equal(cached.status, 304); assert.equal((await cached.arrayBuffer()).byteLength, 0);
await rejects(405, '/assets/art.png', {method: 'POST'});
assert.equal(await call('/api/private', {}, {BUCKET: bucket}, {'/api/private': assets['/assets/art.png']}), null);
assert.equal(await call('/assets/uploads/private.png', {}, {BUCKET: bucket}, {'/assets/uploads/private.png': assets['/assets/art.png']}), null);
objects.set('site-assets/' + hash, {bytes: new Uint8Array(1)});
await rejects(503, '/assets/art.png');
assert.ok(calls.every(([, key]) => key === 'site-assets/' + hash));
console.log(`Hosted build assets passed ${checks} route cases, including authorization, Origin/CSRF, manifest/size/hash constraints, revoked sessions, public reads, HEAD, and ETag.`);
