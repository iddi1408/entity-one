import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHostedMediaRoutes} from '../worker/media.js';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
class FakeBucket {
  objects = new Map(); calls = [];
  record(key, value) { return {key, size: value.bytes.byteLength, customMetadata: {...value.customMetadata}, httpMetadata: {...value.httpMetadata}}; }
  async put(key, bytes, options) {
    this.calls.push(['put', key]);
    if (options?.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const value = {bytes: new Uint8Array(bytes), customMetadata: {...options.customMetadata}, httpMetadata: {...options.httpMetadata}};
    this.objects.set(key, value); return this.record(key, value);
  }
  async list(options) {
    this.calls.push(['list', options]);
    const keys = [...this.objects.keys()].filter(key => key.startsWith(options.prefix)).sort();
    return {objects: keys.slice(0, options.limit).map(key => this.record(key, this.objects.get(key))), truncated: keys.length > options.limit};
  }
  async get(key) { this.calls.push(['get', key]); const value = this.objects.get(key); return value ? {...this.record(key, value), body: new Response(value.bytes).body} : null; }
  async head(key) { this.calls.push(['head', key]); const value = this.objects.get(key); return value ? this.record(key, value) : null; }
  async delete(key) { this.calls.push(['delete', key]); this.objects.delete(key); }
}

const origin = 'https://entity-one.example', bucket = new FakeBucket(), audit = [];
const token = 'a'.repeat(64), session = {token, tokenHash: createHash('sha256').update(token).digest('hex'), row: {session_id: 'isolated-session'}};
const csrf = createHash('sha256').update('csrf:' + token).digest('hex');
const auth = {Cookie: 'isolated=true', 'X-CSRF-Token': csrf};
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV4sAAAAASUVORK5CYII=', 'base64'));
const webp = Uint8Array.from(Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'));
let content = {settings: {partners: [{}]}, listings: [{id: 'live', type: 'inventory', status: 'available', image: '/assets/demo.jpg'}, {id: 'draft', type: 'inventory', status: 'draft', image: '/assets/demo.jpg', internalNotes: 'private'}]};
let authOverride, auditFailure = false, afterAudit, checks = 0;
function multipart(bytes = png, name = 'image.png', type = 'image/png') { const form = new FormData(); form.set('file', new Blob([bytes], {type}), name); return form; }
function publicContent(value) { return {...value, listings: value.listings.filter(item => item.type === 'inventory' ? ['available', 'reserved'].includes(item.status) : item.status === 'active').map(({internalNotes, ...item}) => item)}; }
async function call(path, options = {}, env = {BUCKET: bucket}) {
  checks++;
  const request = new Request((options.origin || origin) + path, {method: options.method || 'GET', headers: {Origin: origin, ...options.headers}, ...(options.body === undefined ? {} : {body: options.body}), ...(options.body instanceof ReadableStream ? {duplex: 'half'} : {})});
  const response = await createHostedMediaRoutes({request, env, path,
    authenticated: authOverride || (async () => request.headers.get('Cookie') === auth.Cookie ? session : null),
    readContent: async () => ({content, revision: 5}), publicContent,
    json: (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json', ...headers}}),
    audit: async (action, sessionId, detail) => { if (auditFailure) throw new Error('Synthetic audit failure'); audit.push({action, sessionId, detail}); await afterAudit?.(action); }, HttpError
  });
  return response;
}
const status = async (expected, path, options, env) => {
  try { const response = await call(path, options, env); assert.equal(response?.status, expected); return response; }
  catch (error) { assert.ok(error instanceof HttpError, String(error)); assert.equal(error.status, expected, error.message); }
};
const upload = (headers = auth, bytes = png, name, type) => call('/api/media', {method: 'POST', headers, body: multipart(bytes, name, type)});

assert.equal(await call('/api/content'), null);
await status(503, '/api/media', {}, {});
await status(401, '/api/media');
await status(401, '/api/media', {method: 'POST', body: multipart()});
await status(405, '/api/media', {method: 'DELETE', headers: auth});
await status(403, '/api/media', {origin: 'http://entity-one.example', headers: auth});
for (const headers of [{Cookie: auth.Cookie}, {...auth, Origin: 'null'}, {...auth, Origin: 'https://evil.example'}, {...auth, 'Sec-Fetch-Site': 'cross-site'}, {...auth, 'X-CSRF-Token': '0'.repeat(64)}]) {
  await status(403, '/api/media', {method: 'POST', headers, body: multipart()});
}
await status(415, '/api/media', {method: 'POST', headers: {...auth, 'Content-Type': 'application/json'}, body: '{}'});
await status(400, '/api/media', {method: 'POST', headers: {...auth, 'Content-Type': 'multipart/form-data; boundary=missing'}, body: 'broken'});
const extra = multipart(); extra.set('unexpected', 'field');
await status(400, '/api/media', {method: 'POST', headers: auth, body: extra});
const textField = new FormData(); textField.set('file', 'fake');
await status(400, '/api/media', {method: 'POST', headers: auth, body: textField});
await status(415, '/api/media', {method: 'POST', headers: auth, body: multipart(new TextEncoder().encode('<svg><script>bad()</script></svg>'), 'pretend.png')});
await status(413, '/api/media', {method: 'POST', headers: auth, body: multipart(new Uint8Array(8 * 1024 * 1024 + 1))});
await status(413, '/api/media', {method: 'POST', headers: {...auth, 'Content-Length': String(9 * 1024 * 1024)}, body: multipart()});
const oversizedPng = png.slice(); new DataView(oversizedPng.buffer).setUint32(16, 21000);
await status(415, '/api/media', {method: 'POST', headers: auth, body: multipart(oversizedPng)});
assert.equal(bucket.objects.size, 0, 'Rejected requests write nothing');

const uploaded = await upload(auth, png, '../../sample.jpg', 'image/jpeg');
assert.equal(uploaded.status, 201);
const item = (await uploaded.json()).media;
assert.match(item.url, /^\/assets\/uploads\/[a-f0-9-]+\.png$/);
assert.equal(item.name, 'sample.jpg'); assert.equal(item.size, png.length);
assert.deepEqual(Object.keys(item).sort(), ['id', 'name', 'size', 'uploadedAt', 'url']);
assert.match(uploaded.headers.get('Cache-Control'), /no-store/);
assert.deepEqual(audit, [{action: 'media.upload', sessionId: session.row.session_id, detail: {id: item.id, size: item.size}}]);
assert.deepEqual((await (await call('/api/media', {headers: auth})).json()).media, [{...item, inUse: false}]);
assert.equal(bucket.calls.at(-1)[1].limit, 1000);
await status(404, item.url);
const image = await call(item.url, {headers: auth});
assert.equal(image.headers.get('Content-Type'), 'image/png');
assert.equal(image.headers.get('X-Content-Type-Options'), 'nosniff');
assert.match(image.headers.get('Cache-Control'), /no-store/);
assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
const head = await call(item.url, {method: 'HEAD', headers: auth});
assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0); assert.equal(bucket.calls.at(-1)[0], 'head');
for (const unsafe of ['/assets/uploads/../site-assets/file.png', '/assets/uploads/fake.png', '/assets/uploads/' + item.id + '.svg', item.url + '/extra']) await status(404, unsafe, {headers: auth});
await status(405, item.url, {method: 'POST', headers: auth});
content.listings[1].image = item.url;
await status(404, item.url);
for (const set of [
  value => { content.listings[0].image = value || '/assets/demo.jpg'; },
  value => { content.listings[0].gallery = value ? [value] : []; },
  value => { content.settings.heroImage = value; },
  value => { content.settings.aboutImage = value; },
  value => { content.settings.partners[0].image = value; }
]) {
  set(item.url); const publicImage = await call(item.url); assert.equal(publicImage.status, 200); await publicImage.body.cancel();
  set(''); await status(404, item.url);
}
content.settings.heroImage = 'https://evil.example' + item.url;
await status(404, item.url); content.settings.heroImage = '';

bucket.objects.get(item.url.slice('/assets/'.length)).customMetadata.uploadedAt = '2025-01-01T00:00:00.000Z';
const second = (await (await upload(auth, webp, 'wrong.png', 'image/png')).json()).media;
assert.ok(second.url.endsWith('.webp'));
const webpImage = await call(second.url, {headers: auth}); assert.equal(webpImage.headers.get('Content-Type'), 'image/webp'); await webpImage.body.cancel();
assert.deepEqual((await (await call('/api/media', {headers: auth})).json()).media.map(value => value.id), [second.id, item.id]);
let authenticatedCalls = 0;
authOverride = async () => ++authenticatedCalls === 1 ? session : null;
await status(401, '/api/media', {method: 'POST', headers: auth, body: multipart()});
authOverride = undefined;
assert.equal(bucket.objects.size, 2, 'Post-buffer revocation stops the upload');
auditFailure = true;
await assert.rejects(upload(auth), /Synthetic audit failure/);
auditFailure = false;
assert.equal(bucket.objects.size, 2, 'An unaudited object is rolled back');

// Destructive operations stay within uploaded UUID paths and recheck current private content.
const removePath = '/api/media/' + second.url.split('/').at(-1);
await status(401, removePath, {method: 'DELETE'});
for (const headers of [{Cookie: auth.Cookie}, {...auth, Origin: 'https://evil.example'}, {...auth, 'Sec-Fetch-Site': 'cross-site'}, {...auth, 'X-CSRF-Token': 'wrong'}]) await status(403, removePath, {method: 'DELETE', headers});
authOverride = async () => { throw new HttpError(403, 'Media write permission required'); };
await status(403, removePath, {method: 'DELETE', headers: auth}); authOverride = undefined;
for (const path of ['/api/media/not-an-upload.png', '/api/media/../content.json', '/api/media/%2e%2e%2fcontent.json', '/api/media/uploads/' + second.url.split('/').at(-1), removePath + '/extra', removePath.replace('.webp', '.svg')]) await status(404, path, {method: 'DELETE', headers: auth});
await status(405, removePath, {method: 'POST', headers: auth});
await status(405, removePath, {headers: auth});
for (const set of [
  value => { content.listings[1].image = value || '/assets/demo.jpg'; },
  value => { content.listings[1].gallery = value ? [value] : []; },
  value => { content.settings.heroImage = value; },
  value => { content.settings.aboutImage = value; },
  value => { content.settings.partners[0].image = value; },
  value => { content.settings.showcase = value ? [{listingId: 'draft', image: value}] : []; }
]) {
  set(second.url);
  assert.equal((await (await call('/api/media', {headers: auth})).json()).media.find(m => m.id === second.id).inUse, true);
  await status(409, removePath, {method: 'DELETE', headers: auth});
  assert.ok(bucket.objects.has(second.url.slice('/assets/'.length))); set('');
}
content.settings.heroImage = 'https://previous-site-host.example' + second.url + '?v=1';
await status(409, removePath, {method: 'DELETE', headers: auth}); content.settings.heroImage = '';
authenticatedCalls = 0; authOverride = async () => ++authenticatedCalls === 1 ? session : null;
await status(401, removePath, {method: 'DELETE', headers: auth}); authOverride = undefined;
auditFailure = true; await assert.rejects(call(removePath, {method: 'DELETE', headers: auth}), /Synthetic audit failure/); auditFailure = false;
assert.ok(bucket.objects.has(second.url.slice('/assets/'.length)), 'Failed audit attempt leaves image untouched');
afterAudit = action => { if (action === 'media.delete_requested') content.settings.heroImage = second.url; };
await status(409, removePath, {method: 'DELETE', headers: auth}); afterAudit = undefined; content.settings.heroImage = '';
const deleteMethod = bucket.delete;
bucket.delete = async () => { throw new Error('Synthetic storage failure'); };
await status(503, removePath, {method: 'DELETE', headers: auth}); bucket.delete = deleteMethod;
const removed = await call(removePath, {method: 'DELETE', headers: auth});
assert.deepEqual(await removed.json(), {deleted: true, id: second.id});
assert.deepEqual(audit.at(-1), {action: 'media.delete', sessionId: session.row.session_id, detail: {id: second.id, filename: second.name, size: second.size}});
await status(404, removePath, {method: 'DELETE', headers: auth});
await status(404, second.url, {headers: auth});
assert.equal((await (await call('/api/media', {headers: auth})).json()).media.length, 1);

// Only the uploads prefix is listed; malformed metadata is not advertised.
bucket.objects.set('site-assets/public-art.png', {bytes: png, customMetadata: {}, httpMetadata: {}});
bucket.objects.set('uploads/00000000-0000-4000-8000-000000000000.png', {bytes: png, customMetadata: {name: 'bad', uploadedAt: 'invalid'}, httpMetadata: {}});
assert.equal((await (await call('/api/media', {headers: auth})).json()).media.length, 1);
await status(404, '/assets/uploads/00000000-0000-4000-8000-000000000000.png', {headers: auth});
for (let index = 1; index <= 1001; index++) bucket.objects.set(`uploads/00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}.png`, {bytes: png, customMetadata: {name: 'fixture.png', uploadedAt: '2025-01-01T00:00:00.000Z'}, httpMetadata: {}});
const bounded = await (await call('/api/media', {headers: auth})).json();
assert.equal(bounded.truncated, true); assert.ok(bounded.media.length <= 1000);
console.log(`Hosted media passed ${checks} route responses plus authentication, CSRF, in-use deletion protection, traversal, revocation, audit/storage failures, private/public references, and manifest checks.`);
