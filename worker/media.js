const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 65536;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UPLOAD = new RegExp(`^uploads/(${UUID})\\.(png|jpg|webp)$`);
const TYPES = {png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp'};
const PRIVATE_HEADERS = {'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin'};
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const tokenFor = async token => hex(await crypto.subtle.digest('SHA-256', encoder.encode('csrf:' + token)));

function equalToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  let difference = 0;
  for (let index = 0; index < 64; index++) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

function safeName(name, extension) {
  return String(name || '').replaceAll('\\', '/').split('/').at(-1).replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 160) || `image.${extension}`;
}

function format(bytes, HttpError) {
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) && ascii(12, 16) === 'IHDR' && view.getUint32(8) === 13) {
    const width = view.getUint32(16), height = view.getUint32(20);
    if (!width || !height || width > 20000 || height > 20000 || width * height > 100000000) throw new HttpError(415, 'The image dimensions are not supported.');
    return 'png';
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'jpg';
  if (bytes.length >= 20 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 16)) && view.getUint32(4, true) + 8 === bytes.length) return 'webp';
  throw new HttpError(415, 'Choose a PNG, JPEG or WebP image.');
}

async function boundedBody(request, HttpError) {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) throw new HttpError(413, 'Images must be 8 MiB or smaller.');
  if (!request.body) throw new HttpError(400, 'An image upload is required.');
  const reader = request.body.getReader(), chunks = [];
  let size = 0, timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new HttpError(408, 'The image upload timed out.')), 15000); });
  try {
    while (true) {
      const {done, value} = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new HttpError(413, 'Images must be 8 MiB or smaller.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'The image upload could not be read.');
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function mediaItem(object) {
  const match = UPLOAD.exec(object?.key || ''), metadata = object?.customMetadata;
  if (!match || !metadata || typeof metadata.name !== 'string' || metadata.name.length > 160 || typeof metadata.uploadedAt !== 'string' || !Number.isFinite(Date.parse(metadata.uploadedAt)) || !Number.isSafeInteger(object.size) || object.size < 1 || object.size > MAX_IMAGE_BYTES) return null;
  return {id: match[1], url: '/assets/' + object.key, name: safeName(metadata.name, match[2]), size: object.size, uploadedAt: metadata.uploadedAt};
}

function referenced(content, pathname, origin) {
  const images = [content?.settings?.heroImage, content?.settings?.aboutImage];
  for (const listing of content?.listings || []) {
    images.push(listing.image);
    if (Array.isArray(listing.gallery)) images.push(...listing.gallery);
  }
  for (const partner of content?.settings?.partners || []) images.push(partner.image);
  for (const item of content?.settings?.showcase || []) images.push(item.image);
  return images.some(value => {
    if (typeof value !== 'string' || !value) return false;
    try { const image = new URL(value, origin); return image.origin === origin && image.pathname === pathname; }
    catch { return false; }
  });
}

/**
 * Closures supplied by application.js preserve its authentication and public projection.
 * readContent() returns {content, revision}; audit(action, sessionId, detail) records safe metadata.
 * Unrelated paths return null. HttpError is intentionally handled by the caller's normal catch.
 */
export async function createHostedMediaRoutes({request, env, path, authenticated, readContent, publicContent, json, audit, HttpError}) {
  const isManifest = path === '/api/media', isImage = path.startsWith('/assets/uploads/');
  if (!isManifest && !isImage) return null;
  if (!env.BUCKET) throw new HttpError(503, 'The media service is unavailable.');
  const address = new URL(request.url), origin = address.origin;
  if (address.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) throw new HttpError(403, 'A secure connection is required.');
  if (isManifest) {
    if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
    const session = await authenticated();
    if (!session) throw new HttpError(401, 'Log in to manage media.');
    if (request.method === 'GET') {
      const listed = await env.BUCKET.list({prefix: 'uploads/', limit: 1000, include: ['customMetadata']});
      const media = listed.objects.map(mediaItem).filter(Boolean).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || b.id.localeCompare(a.id));
      return json({media, ...(listed.truncated ? {truncated: true} : {})}, 200, PRIVATE_HEADERS);
    }
    if (request.headers.get('Origin') !== origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403, 'Use this website to submit changes.');
    const csrf = await tokenFor(session.token);
    if (!equalToken(request.headers.get('X-CSRF-Token'), csrf)) throw new HttpError(403, 'Your security token is missing or expired. Refresh the page.');
    if (!/^multipart\/form-data\s*;/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'A multipart image upload is required.');
    const body = await boundedBody(request, HttpError);
    let form;
    try { form = await new Request(request.url, {method: 'POST', headers: {'Content-Type': request.headers.get('Content-Type')}, body}).formData(); }
    catch { throw new HttpError(400, 'The image upload could not be read.'); }
    const entries = [...form.entries()];
    if (entries.length !== 1 || entries[0][0] !== 'file' || typeof entries[0][1] === 'string' || typeof entries[0][1].arrayBuffer !== 'function') throw new HttpError(400, 'Upload one image using the file field.');
    const file = entries[0][1];
    if (!file.size || file.size > MAX_IMAGE_BYTES) throw new HttpError(413, 'Images must be 8 MiB or smaller.');
    const bytes = new Uint8Array(await file.arrayBuffer()), extension = format(bytes, HttpError);
    const latest = await authenticated();
    if (!latest || !equalToken(await tokenFor(latest.token), csrf)) throw new HttpError(401, 'Your session has expired. Log in again.');
    const id = crypto.randomUUID(), key = `uploads/${id}.${extension}`;
    const item = {id, url: '/assets/' + key, name: safeName(file.name, extension), size: bytes.length, uploadedAt: new Date().toISOString()};
    const saved = await env.BUCKET.put(key, bytes, {onlyIf: {etagDoesNotMatch: '*'}, httpMetadata: {contentType: TYPES[extension], cacheControl: 'private, no-store'}, customMetadata: {name: item.name, uploadedAt: item.uploadedAt}});
    if (!saved) throw new HttpError(409, 'The image could not be stored. Please try again.');
    try { await audit('media.upload', latest.row.session_id, {id: item.id, size: item.size}); }
    catch (error) { await env.BUCKET.delete(key).catch(() => {}); throw error; }
    return json({media: item}, 201, PRIVATE_HEADERS);
  }
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
  const key = path.slice('/assets/'.length), match = UPLOAD.exec(key);
  if (!match) throw new HttpError(404, 'Image not found.');
  if (!await authenticated()) {
    const stored = await readContent();
    if (!referenced(publicContent(stored.content), path, origin)) throw new HttpError(404, 'Image not found.');
  }
  const object = await env.BUCKET[request.method === 'HEAD' ? 'head' : 'get'](key);
  if (!object || !mediaItem(object)) { await object?.body?.cancel().catch(() => {}); throw new HttpError(404, 'Image not found.'); }
  return new Response(request.method === 'HEAD' ? null : object.body, {headers: {...PRIVATE_HEADERS, 'Content-Type': TYPES[match[2]], 'Content-Length': String(object.size), 'Content-Disposition': `inline; filename="${match[1]}.${match[2]}"`, 'Content-Security-Policy': "default-src 'none'; sandbox"}});
}
