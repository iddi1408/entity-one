import http from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {createHash, timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {localDB} from './d1-local.mjs';
import {compileWorker} from './compile-worker.mjs';
import {createMediaStore, MAX_IMAGE_BYTES, ordinaryDirectory, PreviewError, safeFile} from './media-store.mjs';

const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; script-src-attr 'none'; style-src 'self'; font-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self' https://api.web3forms.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf'};
const JSON_LIMIT = 600000, UPLOAD_REQUEST_LIMIT = MAX_IMAGE_BYTES + 65536;

function bodyBytes(request, limit) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) return Promise.reject(new PreviewError(413, 'This request is too large.'));
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const clean = () => { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('aborted', aborted); request.off('error', failed); };
    const fail = error => { clean(); request.pause(); reject(error); };
    const data = chunk => { size += chunk.length; if (size > limit) return fail(new PreviewError(413, 'This request is too large.')); chunks.push(chunk); };
    const end = () => { clean(); resolve(Buffer.concat(chunks, size)); };
    const aborted = () => fail(new PreviewError(400, 'The request was interrupted.'));
    const failed = () => fail(new PreviewError(400, 'The request could not be read.'));
    const timer = setTimeout(() => fail(new PreviewError(408, 'The request timed out.')), 12000);
    timer.unref();
    request.on('data', data); request.on('end', end); request.on('aborted', aborted); request.on('error', failed);
  });
}

function trustedHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (/^(oai-authenticated-|x-authenticated-|x-forwarded-)/i.test(name) || ['forwarded', 'x-real-ip', 'true-client-ip', 'cf-connecting-ip', 'connection', 'transfer-encoding', 'accept-encoding'].includes(name)) continue;
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else if (value !== undefined) headers.set(name, value);
  }
  headers.set('CF-Connecting-IP', (request.socket.remoteAddress || '').replace(/^::ffff:/, ''));
  return headers;
}

function exactOrigin(request, origin) {
  if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') throw new PreviewError(403, 'Use this local website to submit changes.');
}

function equalToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !actual || !expected || actual.length > 256 || expected.length > 256) return false;
  return timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}

function pathName(request, origin) {
  if (typeof request.url !== 'string' || request.url.length > 8192 || !request.url.startsWith('/') || request.url.startsWith('//') || request.url.includes('#')) throw new PreviewError(400, 'Invalid request path.');
  let decoded;
  try { decoded = decodeURIComponent(request.url.split('?')[0]); } catch { throw new PreviewError(400, 'Invalid request path.'); }
  if (/[\\:\x00-\x1f\x7f]/.test(decoded) || decoded.split('/').some(segment => segment.startsWith('.') || /[. ]$/.test(segment))) throw new PreviewError(403, 'This path is not available.');
  const address = new URL(request.url, origin);
  const normalized = decoded.replace(/\/+$/, '') || '/';
  address.pathname = normalized;
  return {address, pathname: normalized};
}

function isReferenced(content, uploadPath, origin) {
  const candidates = [];
  for (const listing of content?.listings || []) {
    candidates.push(listing.image);
    if (Array.isArray(listing.gallery)) candidates.push(...listing.gallery);
  }
  candidates.push(content?.settings?.heroImage, content?.settings?.aboutImage);
  for (const partner of content?.settings?.partners || []) candidates.push(partner.image);
  for (const item of content?.settings?.showcase || []) candidates.push(item.image);
  return candidates.some(value => {
    if (typeof value !== 'string' || !value) return false;
    try { const address = new URL(value, origin); return address.origin === origin && address.pathname === uploadPath; } catch { return false; }
  });
}

/** Testable factory; normal invocation retains the loopback-only project layout. */
export async function createPreviewServer({publicDirectory = path.resolve('public'), runtimeDirectory = path.resolve('.sites-runtime'), applicationPath = path.resolve('worker/application.js'), database} = {}) {
  const root = await ordinaryDirectory(publicDirectory);
  await mkdir(runtimeDirectory, {recursive: true, mode: 0o700});
  const runtime = await ordinaryDirectory(runtimeDirectory);
  const ownsDatabase = !database;
  const DB = database || localDB(path.join(runtime, 'preview.sqlite'));
  const media = await createMediaStore(runtime);
  const code = await compileWorker({applicationPath, content: JSON.parse(await readFile(await safeFile(root, 'content.json'), 'utf8'))});
  const worker = (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))).default;
  const environment = {DB, WEB3FORMS_ACCESS_KEY: process.env.WEB3FORMS_ACCESS_KEY};

  const server = http.createServer({maxHeaderSize: 16384}, async (request, response) => {
    function send(status, bytes, headers = {}) {
      if (response.destroyed || response.writableEnded) return;
      const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
      for (const [key, value] of Object.entries(SECURITY)) normalized[key.toLowerCase()] = value;
      response.writeHead(status, normalized);
      response.end(request.method === 'HEAD' ? undefined : bytes);
    }
    function json(value, status = 200, headers = {}) { send(status, JSON.stringify(value), {'Content-Type': 'application/json; charset=utf-8', ...headers}); }
    async function forward(result, transform) {
      const headers = Object.fromEntries(result.headers);
      const cookies = result.headers.getSetCookie?.();
      if (cookies?.length) { delete headers['set-cookie']; headers['Set-Cookie'] = cookies; }
      if (transform && result.ok) return json(transform(await result.json()), result.status, headers);
      send(result.status, Buffer.from(await result.arrayBuffer()), headers);
    }
    try {
      const port = server.address()?.port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const host = request.headers.host;
      const hostCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host').length;
      if (hostCount !== 1 || typeof host !== 'string' || !hosts.includes(host.toLowerCase()) || !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(request.socket.remoteAddress)) throw new PreviewError(403, 'Use the local preview address.');
      const origin = `http://${host.toLowerCase()}`;
      const {address, pathname} = pathName(request, origin);
      const headers = trustedHeaders(request);
      const internal = async (pathname, anonymous = false) => {
        const copy = new Headers(headers);
        for (const name of ['content-length', 'content-type']) copy.delete(name);
        if (anonymous) { copy.delete('cookie'); copy.delete('authorization'); }
        return worker.fetch(new Request(new URL(pathname, origin), {headers: copy}), environment, {});
      };
      const session = async () => {
        const result = await internal('/api/session');
        if (!result.ok) throw new PreviewError(503, 'The private service is unavailable.');
        return result.json();
      };
      const publicContent = async () => {
        const result = await internal('/api/content', true);
        if (!result.ok) throw new PreviewError(503, 'The public content is unavailable.');
        return (await result.json()).content;
      };

      if (['GET', 'HEAD'].includes(request.method) && (request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) > 0)) throw new PreviewError(400, 'This request must not contain a body.');
      if (pathname === '/api/setup' || pathname === '/api/commit') throw new PreviewError(404, 'This service does not exist.');
      if (pathname === '/api/media') {
        if (!['GET', 'POST'].includes(request.method)) throw new PreviewError(405, 'Method not allowed.');
        const current = await session();
        if (!current.authenticated) throw new PreviewError(401, 'Log in to manage media.');
        const permission = request.method === 'POST' ? 'media.write' : 'media.read';
        if (current.mustChangePassword || !current.user?.permissions?.includes(permission)) throw new PreviewError(403, 'You do not have permission to manage media.');
        if (request.method === 'GET') return json({media: await media.list()});
        exactOrigin(request, origin);
        if (!equalToken(request.headers['x-csrf-token'], current.csrfToken)) throw new PreviewError(403, 'Your security token is missing or expired. Refresh the page.');
        if (!/^multipart\/form-data\s*;/i.test(request.headers['content-type'] || '')) throw new PreviewError(415, 'A multipart image upload is required.');
        const bytes = await bodyBytes(request, UPLOAD_REQUEST_LIMIT);
        let form;
        try { form = await new Request(address, {method: 'POST', headers: {'Content-Type': request.headers['content-type']}, body: bytes}).formData(); }
        catch { throw new PreviewError(400, 'The image upload could not be read.'); }
        const entries = [...form.entries()];
        if (entries.length !== 1 || entries[0][0] !== 'file' || typeof entries[0][1] === 'string' || typeof entries[0][1].arrayBuffer !== 'function') throw new PreviewError(400, 'Upload one image using the file field.');
        const file = entries[0][1];
        if (!file.size || file.size > MAX_IMAGE_BYTES) throw new PreviewError(413, 'Images must be 8 MiB or smaller.');
        const latest = await session();
        if (!latest.authenticated || latest.mustChangePassword || !latest.user?.permissions?.includes('media.write') || !equalToken(current.csrfToken, latest.csrfToken)) throw new PreviewError(401, 'Your session has expired. Log in again.');
        const item = await media.save(Buffer.from(await file.arrayBuffer()), file.name);
        await DB.prepare('INSERT INTO audit_log (at, action, session_id, detail, actor_id, actor_username, actor_role) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(Math.floor(Date.now() / 1000), 'media.upload', latest.session.id, JSON.stringify({id: item.id, size: item.size}), latest.user.id, latest.user.username, latest.user.role).run();
        return json({media: item}, 201);
      }
      if (pathname.startsWith('/api/')) {
        if (!['GET', 'POST', 'PUT'].includes(request.method)) throw new PreviewError(405, 'Method not allowed.');
        let bytes;
        if (request.method !== 'GET') { exactOrigin(request, origin); bytes = await bodyBytes(request, pathname === '/api/login' ? 8192 : JSON_LIMIT); }
        const result = await worker.fetch(new Request(address, {method: request.method, headers, ...(bytes ? {body: bytes} : {})}), environment, {});
        return forward(result, pathname === '/api/session' ? value => ({...value, localOnly: true}) : undefined);
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new PreviewError(405, 'Method not allowed.');
      // Windows serves names case-insensitively; every spelling must use the public projection.
      if (pathname.toLowerCase() === '/content.json') return json(await publicContent());
      if (pathname.startsWith('/assets/uploads/')) {
        const filename = pathname.slice('/assets/uploads/'.length);
        const current = await session();
        if ((!current.authenticated || current.mustChangePassword || !current.user?.permissions?.includes('media.read')) && !isReferenced(await publicContent(), pathname, origin)) throw new PreviewError(404, 'Image not found.');
        const record = await media.read(filename, request.method === 'HEAD');
        return send(200, record.bytes, {'Content-Type': record.contentType, 'Content-Length': record.item.size, 'Content-Disposition': `inline; filename="${filename}"`});
      }
      const relative = path.extname(pathname) ? pathname.slice(1) : 'index.html';
      const extension = path.extname(relative).toLowerCase();
      if (!MIME[extension] || extension === '.json') throw new PreviewError(404, 'Not found.');
      const filename = await safeFile(root, relative);
      const bytes = await readFile(filename);
      send(200, bytes, {'Content-Type': MIME[extension], 'Content-Length': bytes.length});
    } catch (error) {
      const status = error instanceof PreviewError ? error.status : ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404 : 500;
      if (!request.complete) { response.setHeader('Connection', 'close'); response.once('finish', () => request.destroy()); }
      json({error: error instanceof PreviewError ? error.message : status === 404 ? 'Not found.' : 'The local service could not complete this request.'}, status);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.timeout = 30000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
  server.on('timeout', socket => socket.destroy());
  server.on('clientError', (_error, socket) => {
    if (!socket.writable) return;
    const body = JSON.stringify({error: 'Invalid HTTP request.'});
    socket.end('HTTP/1.1 400 Bad Request\r\n' + Object.entries({...SECURITY, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), Connection: 'close'}).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n' + body);
  });
  if (ownsDatabase) server.once('close', () => DB.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = await createPreviewServer();
  server.listen(4174, '127.0.0.1', () => console.log('ENTITY-1 local workspace: http://127.0.0.1:4174\nPrivate media and content stay local. Public registration and GitHub publishing are disabled.'));
}
