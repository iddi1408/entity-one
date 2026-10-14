import assert from 'node:assert/strict';
import {mediaBucket} from '../worker/storage.js';

const entries = new Map();
const namespace = {
  async getWithMetadata(key) {
    const row = entries.get(key);
    return row ? {value: new Response(row.bytes).body, metadata: row.metadata} : {value: null, metadata: null};
  },
  async put(key, value, {metadata}) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
    entries.set(key, {bytes, metadata});
  },
  async delete(key) { entries.delete(key); },
  async list({prefix, limit}) {
    const keys = [...entries].filter(([name]) => name.startsWith(prefix)).slice(0, limit).map(([name, row]) => ({name, metadata: row.metadata}));
    return {keys, list_complete: true};
  },
};

assert.equal(mediaBucket({}), null);
const bucket = mediaBucket({MEDIA: namespace});
const image = new Uint8Array([137, 80, 78, 71]);
const inserted = await bucket.put('uploads/one.png', image, {
  httpMetadata: {contentType: 'image/png', cacheControl: 'private, no-store'},
  customMetadata: {name: 'front.png', uploadedAt: '2026-10-14T10:00:00.000Z'},
});
assert.equal(inserted.size, image.byteLength);
const listed = await bucket.list({prefix: 'uploads/', limit: 10});
assert.equal(listed.truncated, false);
assert.equal(listed.objects[0].customMetadata.name, 'front.png');
const object = await bucket.get('uploads/one.png');
assert.deepEqual(new Uint8Array(await new Response(object.body).arrayBuffer()), image);
assert.equal(object.httpMetadata.contentType, 'image/png');
assert.equal(await bucket.put('uploads/one.png', image, {onlyIf: {etagDoesNotMatch: '*'}}), null);
assert.equal(await bucket.put('uploads/one.png', image, {onlyIf: {etagMatches: 'stale'}}), null);
await bucket.put('uploads/one.png', image, {onlyIf: {etagMatches: object.etag}, customMetadata: {name: 'renamed.png'}});
assert.equal((await bucket.head('uploads/one.png')).customMetadata.name, 'renamed.png');
await bucket.delete('uploads/one.png');
assert.equal(await bucket.head('uploads/one.png'), null);
console.log('Cloudflare KV media adapter checks passed');
