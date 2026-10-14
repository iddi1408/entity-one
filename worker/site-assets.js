const MAX_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ADMIN_PREFIX = '/api/admin/site-assets/';
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');

function validAsset(asset) {
  return ['r2', 'static'].includes(asset?.storage) && HASH.test(asset.hash) && Number.isSafeInteger(asset.size) && asset.size >= 0 && asset.size <= MAX_BYTES && typeof asset.type === 'string' && asset.type.length > 0 && !/[\x00-\x1f\x7f]/.test(asset.type);
}

async function readAsset(request, size, HttpError) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== size)) throw new HttpError(Number(declared) > size ? 413 : 400, 'The asset size does not match this build.');
  if (!request.body) {
    if (size === 0) return new Uint8Array();
    throw new HttpError(400, 'The asset body is missing.');
  }
  const reader = request.body.getReader(), bytes = new Uint8Array(size);
  let offset = 0, timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new HttpError(408, 'The asset upload timed out.')), 15000); });
  try {
    while (true) {
      const {done, value} = await Promise.race([reader.read(), timeout]);
      if (done) break;
      if (offset + value.byteLength > size) throw new HttpError(413, 'The asset exceeds its declared build size.');
      bytes.set(value, offset); offset += value.byteLength;
    }
    if (offset !== size) throw new HttpError(400, 'The asset size does not match this build.');
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'The asset upload could not be read.');
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

/** Pass closures for authenticated() and requireAdmin(mutation); errors use the caller's HttpError. */
export async function createHostedAssetRoutes({request, env, path, assets, authenticated, requireAdmin, security, json, HttpError}) {
  if (path.startsWith(ADMIN_PREFIX)) {
    if (request.method !== 'PUT') throw new HttpError(405, 'Method not allowed.');
    const session = await requireAdmin(true);
    const address = new URL(request.url);
    if (address.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) throw new HttpError(403, 'A secure connection is required.');
    if (request.headers.get('Origin') !== address.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403, 'Use this website to submit changes.');
    if (!/^application\/octet-stream$/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'Send the original asset bytes.');
    const hash = path.slice(ADMIN_PREFIX.length);
    const matches = HASH.test(hash) ? Object.values(assets).filter(asset => ['r2', 'static'].includes(asset?.storage) && asset.hash === hash) : [];
    if (!matches.length) throw new HttpError(404, 'This asset is not part of the current build.');
    const asset = matches[0];
    if (!validAsset(asset) || matches.some(candidate => !validAsset(candidate) || candidate.size !== asset.size)) throw new HttpError(503, 'The asset manifest is invalid.');
    const bucket = mediaBucket(env);
    if (!bucket) throw new HttpError(503, 'The asset service is unavailable.');
    const bytes = await readAsset(request, asset.size, HttpError);
    if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== hash) throw new HttpError(400, 'The asset checksum does not match this build.');
    const current = await authenticated();
    if (!current || typeof session.tokenHash !== 'string' || current.tokenHash !== session.tokenHash) throw new HttpError(401, 'Your session has expired. Log in again.');
    await bucket.put('site-assets/' + hash, bytes, {httpMetadata: {contentType: asset.type, cacheControl: 'public, max-age=3600'}, customMetadata: {sha256: hash}});
    return json({stored: true}, 200, {'Cache-Control': 'no-store'});
  }
  // Runtime uploads and private API routes belong to separate authorization handlers.
  if (path.startsWith('/api/') || path.startsWith('/assets/uploads/')) return null;
  const asset = Object.hasOwn(assets, path) ? assets[path] : null;
  if (!['r2', 'static'].includes(asset?.storage)) return null;
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
  if (!validAsset(asset)) throw new HttpError(503, 'The asset manifest is invalid.');
  const address = new URL(request.url);
  const etag = '"' + asset.hash + '"';
  const unchanged = (request.headers.get('If-None-Match') || '').split(',').some(value => value.trim().replace(/^W\//, '') === etag);
  const bucket = mediaBucket(env);
  const object = bucket ? await bucket[request.method === 'HEAD' || unchanged ? 'head' : 'get']('site-assets/' + asset.hash) : null;
  if (object && object.size === asset.size) {
    const headers = new Headers(security);
    headers.set('Content-Type', asset.type); headers.set('Cache-Control', 'public, max-age=3600'); headers.set('ETag', etag);
    headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Content-Length', String(asset.size));
    if (unchanged) return new Response(null, {status: 304, headers});
    return new Response(request.method === 'HEAD' ? null : object.body, {headers});
  }
  if (object && object.size !== asset.size) {
    await object?.body?.cancel().catch(() => {});
    throw new HttpError(503, 'This build asset override is invalid.');
  }
  if (asset.storage === 'r2') {
    if (!env.BUCKET) throw new HttpError(503, 'The asset service is unavailable.');
    const original = await env.BUCKET[request.method === 'HEAD' || unchanged ? 'head' : 'get']('site-assets/' + asset.hash);
    if (!original || original.size !== asset.size) { await original?.body?.cancel().catch(() => {}); throw new HttpError(503, 'This build asset is not available yet.'); }
    const headers = new Headers(security);
    headers.set('Content-Type', asset.type); headers.set('Cache-Control', 'public, max-age=3600'); headers.set('ETag', etag); headers.set('X-Content-Type-Options', 'nosniff');
    if (unchanged) return new Response(null, {status: 304, headers});
    headers.set('Content-Length', String(original.size));
    return new Response(request.method === 'HEAD' ? null : original.body, {headers});
  }
  if (!env.ASSETS) throw new HttpError(503, 'The static image service is unavailable.');
  const original = await env.ASSETS.fetch(new Request(new URL(path, address.origin), request));
  if (!original.ok) throw new HttpError(503, 'This build asset is not available yet.');
  const headers = new Headers(original.headers);
  for (const [key, value] of Object.entries(security)) if (!headers.has(key)) headers.set(key, value);
  headers.set('Content-Type', asset.type); headers.set('Cache-Control', 'public, max-age=3600'); headers.set('ETag', etag); headers.set('X-Content-Type-Options', 'nosniff');
  if (unchanged) return new Response(null, {status: 304, headers});
  return new Response(request.method === 'HEAD' ? null : original.body, {status: original.status, headers});
}
import {mediaBucket} from './storage.js';
