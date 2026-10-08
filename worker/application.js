import {passwordHash, PASSWORD_VERSION, PASSWORD_ITERATIONS} from './password.js';
import {bootstrapAdministrator} from './bootstrap.js';
import {createHostedMediaRoutes} from './media.js';
import {createHostedAssetRoutes} from './site-assets.js';
import {getAccount, findAccount, publicUser, can, handleAccountRoutes} from './accounts.js';
import {writeAudit, readAudit, flushAudit, retryAudit, sanitizeAuditDetail} from './audit.js';
import {collectAnalytics, readAnalytics} from './analytics.js';
import {chatAvailable, replyToChat} from './chat.js';
export {passwordHash, PASSWORD_VERSION, PASSWORD_ITERATIONS};

const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const random = (length = 32) => hex(crypto.getRandomValues(new Uint8Array(length)));
const digest = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const now = () => Math.floor(Date.now() / 1000);
const SESSION_LIFETIME = 8 * 60 * 60, SESSION_IDLE = 30 * 60, MAX_BODY = 600000;
const allowedPages = new Set(['/', '/inventory', '/wanted', '/about', '/contact', '/exclusive', '/admin']);
const security = {'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https: data:; media-src 'self' https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com"};
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers: {...security, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers}});
const db = env => { if (!env.DB) throw new HttpError(503, 'The private service is unavailable. Please try again shortly.'); return env.DB; };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

async function body(request, limit = MAX_BODY) {
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new HttpError(413, 'This request is too large.');
  if (!request.body) throw new HttpError(400, 'A JSON object is required.');
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'This request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { throw new HttpError(400, 'Please check the submitted JSON.'); }
  if (!object(value)) throw new HttpError(400, 'A JSON object is required.');
  return value;
}
function sameOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403, 'Please submit this request from the ENTITY-1 website.');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'A JSON request is required.');
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return mismatch === 0;
}
function cookieName(request) { return new URL(request.url).protocol === 'https:' ? '__Host-e1' : 'e1-local'; }
function cookie(request, token, age) { return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`; }
function tokenFrom(request) {
  const name = cookieName(request);
  const values = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
const credentialVersion = admin => digest(`${admin.salt}:${admin.hash}:${admin.hash_version}`);
const csrfToken = token => digest('csrf:' + token);
async function audit(env, action, sessionId = null, detail = {}, actor = null) {
  await writeAudit(env, action, sessionId, detail, actor);
}
function sessionInfo(row, current = undefined) {
  return {id: row.session_id, createdAt: row.created_at, lastSeen: row.last_seen, idleExpiresAt: Math.min(row.last_seen + SESSION_IDLE, row.expires), expiresAt: row.expires, ...(current === undefined ? {} : {current})};
}
async function authenticated(request, env) {
  const token = tokenFrom(request); if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await digest(token);
  const row = await db(env).prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(tokenHash).first();
  if (!row) return null;
  const time = now(), admin = await getAccount(env, row.user_id);
  if (row.expires <= time || row.last_seen + SESSION_IDLE <= time || !admin || admin.disabled || (admin.must_change_password && (!Number.isSafeInteger(admin.temp_expires_at) || admin.temp_expires_at <= time)) || admin.hash_version !== PASSWORD_VERSION || !equal(row.credential_version, await credentialVersion(admin))) {
    await db(env).batch([
      db(env).prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash),
      db(env).prepare('INSERT INTO audit_log (at, action, session_id, detail, actor_id, actor_username, actor_role) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(time, 'session.expired', row.session_id, '{}', row.user_id, admin?.username || 'Former user', admin?.role || 'staff')
    ]);
    return null;
  }
  // Never resurrect a session revoked by a concurrent request.
  const updated = await db(env).prepare('UPDATE sessions SET last_seen = MAX(last_seen, ?) WHERE token_hash = ? AND expires > ? AND last_seen > ?').bind(time, tokenHash, time, time - SESSION_IDLE).run();
  if (updated.meta.changes !== 1) return null;
  row.last_seen = Math.max(row.last_seen, time);
  return {row, admin, token, tokenHash};
}
async function requireAdmin(request, env, mutation = false, permission = null, allowPending = false) {
  const session = await authenticated(request, env);
  if (!session) throw new HttpError(401, 'Please log in to manage the collection.');
  if (mutation && !equal(request.headers.get('X-CSRF-Token'), await csrfToken(session.token))) throw new HttpError(403, 'Your security token is missing or expired. Refresh the page and try again.');
  if (!allowPending && session.admin.must_change_password) throw new HttpError(403, 'Choose your new password before accessing the dashboard.');
  if (permission && !can(session.admin, permission)) throw new HttpError(403, 'Your account does not have permission for this action.');
  return session;
}
async function sessionPayload(session) {
  return {authenticated: true, csrfToken: await csrfToken(session.token), user: publicUser(session.admin), mustChangePassword: !!session.admin.must_change_password, session: sessionInfo(session.row)};
}
async function newSession(request, env, admin, previous = null, rotated = false) {
  const token = random(), time = now(), tokenHash = await digest(token);
  // Explicit rotation retains the original absolute deadline; reauthentication starts a new one.
  const row = {session_id: random(16), user_id: admin.id, created_at: rotated ? previous.row.created_at : time, last_seen: time, expires: rotated ? previous.row.expires : time + SESSION_LIFETIME};
  const presented = tokenFrom(request), statements = [db(env).prepare('DELETE FROM sessions WHERE expires <= ? OR last_seen <= ?').bind(time, time - SESSION_IDLE)];
  if (rotated) {
    // Recheck the old token inside the transaction: a concurrent revoke cannot be undone by rotation.
    statements.push(db(env).prepare('INSERT INTO sessions (token_hash, session_id, created_at, last_seen, expires, credential_version, user_id) SELECT ?, ?, ?, ?, ?, ?, ? FROM sessions WHERE token_hash = ? AND expires > ? AND last_seen > ?').bind(tokenHash, row.session_id, row.created_at, row.last_seen, row.expires, await credentialVersion(admin), admin.id, previous.tokenHash, time, time - SESSION_IDLE));
    statements.push(db(env).prepare('DELETE FROM sessions WHERE token_hash = ? AND changes() = 1').bind(previous.tokenHash));
    statements.push(db(env).prepare("INSERT INTO audit_log (at, action, session_id, detail, actor_id, actor_username, actor_role) SELECT ?, 'session.rotated', ?, '{}', ?, ?, ? WHERE changes() = 1").bind(time, row.session_id, admin.id, admin.username, admin.role));
    const results = await db(env).batch(statements);
    if (results[1].meta.changes !== 1) throw new HttpError(401, 'Your session has expired. Please log in again.');
    return json(await sessionPayload({row, admin, token}), 200, {'Set-Cookie': cookie(request, token, row.expires - time)});
  }
  if (presented) statements.push(db(env).prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await digest(presented)));
  statements.push(db(env).prepare('INSERT INTO sessions (token_hash, session_id, created_at, last_seen, expires, credential_version, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(tokenHash, row.session_id, row.created_at, row.last_seen, row.expires, await credentialVersion(admin), admin.id));
  statements.push(db(env).prepare("INSERT INTO audit_log (at, action, session_id, detail, actor_id, actor_username, actor_role) VALUES (?, 'login.succeeded', ?, '{}', ?, ?, ?)").bind(time, row.session_id, admin.id, admin.username, admin.role));
  await db(env).batch(statements);
  return json(await sessionPayload({row, admin, token}), 200, {'Set-Cookie': cookie(request, token, row.expires - time)});
}
async function throttle(request, env, username) {
  const buckets = [await digest('login:ip:' + (request.headers.get('CF-Connecting-IP') || 'local')), await digest('login:account:' + username.toLowerCase())];
  const time = now();
  for (const [index, bucket] of buckets.entries()) {
    await db(env).prepare('INSERT INTO rate_limits (bucket, attempts, expires) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = CASE WHEN expires <= ? THEN 1 ELSE attempts + 1 END, expires = CASE WHEN expires <= ? THEN ? ELSE expires END').bind(bucket, time + 900, time, time, time + 900).run();
    const row = await db(env).prepare('SELECT attempts FROM rate_limits WHERE bucket = ?').bind(bucket).first();
    if (row.attempts > (index === 0 ? 10 : 40)) {
      if (row.attempts === (index === 0 ? 11 : 41)) await audit(env, 'login.rate_limited');
      throw new HttpError(429, 'Too many login attempts. Please try again in 15 minutes.');
    }
  }
  return buckets[0];
}
function credentialInput(data) {
  if (typeof data.username !== 'string' || !data.username.trim() || data.username.length > 80 || typeof data.password !== 'string' || !data.password || data.password.length > 1024) throw new HttpError(400, 'Enter your username and password.');
  return {username: data.username.trim(), password: data.password};
}
function text(value, name, max = 4000, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new HttpError(400, `Please check ${name}.`);
  return value.trim();
}
function url(value, name, local = false) {
  const clean = text(value, name, 2048, false); if (!clean) return '';
  if (local && /^\/assets\/[a-zA-Z0-9._/-]+$/.test(clean) && !clean.includes('..')) return clean;
  try { const u = new URL(clean); if (u.protocol === 'https:' && !u.username && !u.password) return u.href; } catch {}
  throw new HttpError(400, `${name} must be a secure HTTPS URL${local ? ' or an /assets/ path' : ''}.`);
}
// Copy only documented fields. The same normalization is applied when reading older records.
function validateContent(data) {
  if (!object(data) || !object(data.settings) || !Array.isArray(data.listings) || data.listings.length > 300) throw new HttpError(400, 'Please check the collection.');
  const source = data.settings, settings = {};
  for (const key of ['headline', 'introduction', 'about', 'email']) settings[key] = text(source[key], key, 12000);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.email)) throw new HttpError(400, 'Enter a valid email address.');
  for (const key of ['heroVideo', 'aboutVideo']) settings[key] = url(source[key] ?? '', key);
  for (const [key, max] of [['heroHeading', 200], ['heroDescription', 500], ['heroImageAlt', 200], ['heroCaption', 200], ['networkCities', 500]]) if (source[key] !== undefined) settings[key] = text(source[key], key, max, false);
  for (const key of ['heroImage', 'aboutImage']) if (source[key] !== undefined) settings[key] = url(source[key], key, true);
  if (!object(source.socials)) throw new HttpError(400, 'Social settings are missing.');
  settings.socials = {};
  for (const key of ['instagram', 'tiktok', 'x', 'linkedin']) settings.socials[key] = url(source.socials[key] ?? '', key);
  for (const [key, fields] of [['offices', ['region', 'city', 'country', 'phone']], ['members', ['name', 'position']], ['partners', ['name', 'mark']]]) {
    const minimum = 0, maximum = key === 'offices' ? 12 : 24;
    if (!Array.isArray(source[key]) || source[key].length < minimum || source[key].length > maximum) throw new HttpError(400, `Please provide ${minimum}–${maximum} ${key}.`);
    settings[key] = source[key].map(row => {
      if (!object(row)) throw new HttpError(400, `Please check ${key}.`);
      const clean = {}; for (const field of fields) {
        const optional = key === 'offices' && field === 'phone';
        clean[field] = text(optional && row[field] === undefined ? '' : row[field], field, 200, !optional);
      }
      if (key === 'partners') { clean.url = url(row.url ?? '', 'Partner website'); if (row.image !== undefined) clean.image = url(row.image, 'Partner image', true); }
      return clean;
    });
  }
  const ids = new Set();
  const listings = data.listings.map(listing => {
    if (!object(listing)) throw new HttpError(400, 'Please check the listing.');
    const clean = {};
    for (const key of ['id', 'type', 'brand', 'model', 'year', 'location', 'mileage', 'spec', 'price', 'description']) clean[key] = text(listing[key], key, key === 'description' ? 5000 : 200);
    if (ids.has(clean.id)) throw new HttpError(400, 'Listing IDs must be unique.'); ids.add(clean.id);
    if (!['inventory', 'wanted'].includes(clean.type) || !['America', 'Europe', 'Gulf and Asia'].includes(listing.region) || typeof listing.featured !== 'boolean') throw new HttpError(400, 'Please check the listing type and region.');
    clean.region = listing.region; clean.featured = listing.featured;
    clean.image = url(listing.image, 'Car image', true); if (!clean.image) throw new HttpError(400, 'Add an image for each car.');
    clean.status = listing.status ?? (clean.type === 'inventory' ? 'available' : 'active');
    if (!(clean.type === 'inventory' ? ['available', 'reserved', 'sold', 'draft'] : ['active', 'fulfilled', 'draft']).includes(clean.status)) throw new HttpError(400, 'Please check the listing status.');
    if (listing.gallery !== undefined) {
      if (!Array.isArray(listing.gallery) || listing.gallery.length > 12) throw new HttpError(400, 'Choose up to 12 gallery images.');
      clean.gallery = listing.gallery.map(value => { const image = url(value, 'Gallery image', true); if (!image) throw new HttpError(400, 'Gallery images cannot be empty.'); return image; });
    }
    if (listing.internalNotes !== undefined) clean.internalNotes = text(listing.internalNotes, 'Internal notes', 5000, false);
    return clean;
  });
  return {settings, listings};
}
async function readContent(env) {
  const row = await db(env).prepare('SELECT body, revision FROM site_content WHERE id = ?').bind('main').first();
  return {content: validateContent(row ? JSON.parse(row.body) : structuredClone(DEFAULT_CONTENT)), revision: row ? row.revision : 0};
}
function publicContent(content) {
  const result = validateContent(content);
  result.listings = result.listings.filter(listing => listing.type === 'inventory' ? ['available', 'reserved'].includes(listing.status) : listing.status === 'active').map(({internalNotes, ...listing}) => listing);
  return result;
}
function visibleContent(content, account) {
  if (!account || account.must_change_password) return publicContent(content);
  const result = validateContent(content);
  result.listings = result.listings.flatMap(listing => {
    if (can(account, listing.type + '.read')) return [listing];
    const visible = listing.type === 'inventory' ? ['available', 'reserved'].includes(listing.status) : listing.status === 'active';
    const {internalNotes, ...safe} = listing;
    return visible ? [safe] : [];
  });
  return result;
}
function permittedContent(input, existing, account) {
  const clean = validateContent(input), visible = visibleContent(existing, account);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!can(account, 'content.write')) {
    if (!same(clean.settings, visible.settings)) throw new HttpError(403, 'You cannot change site content.');
    clean.settings = existing.settings;
  }
  for (const type of ['inventory', 'wanted']) {
    if (can(account, type + '.write')) continue;
    if (!same(clean.listings.filter(item => item.type === type), visible.listings.filter(item => item.type === type))) throw new HttpError(403, `You cannot change ${type} listings.`);
    clean.listings = [...clean.listings.filter(item => item.type !== type), ...existing.listings.filter(item => item.type === type)];
  }
  return validateContent(clean);
}
function contentChanges(before, after) {
  const previous = new Map(before.listings.map(item => [item.id, item]));
  const next = new Map(after.listings.map(item => [item.id, item]));
  const changes = [];
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    const a = previous.get(id), b = next.get(id), item = b || a;
    const fields = a && b ? [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key])) : [];
    if (!a || !b || fields.length) changes.push({id, type:item.type, brand:item.brand, model:item.model, status:item.status, action:!a ? 'created' : !b ? 'removed' : 'updated', fields});
  }
  return {changes, settingsFields:Object.keys(after.settings).filter(key => JSON.stringify(before.settings[key]) !== JSON.stringify(after.settings[key]))};
}
function revision(value) { if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, 'Invalid content version.'); return value; }
async function saveContent(env, input, session, action = 'content.save', restoredFrom = undefined) {
  const expected = revision(input.revision), existing = await readContent(env);
  if (!['inventory.write','wanted.write','content.write'].some(permission => can(session.admin, permission))) throw new HttpError(403, 'Your account cannot edit content.');
  const content = permittedContent(input.content, existing.content, session.admin);
  if (existing.revision !== expected) throw new HttpError(409, 'The collection changed in another session. Refresh the page before saving.');
  const store = db(env), time = now(), next = expected + 1;
  const write = expected === 0
    ? store.prepare('INSERT OR IGNORE INTO site_content (id, body, revision) SELECT ?, ?, 1 WHERE EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND expires > ? AND last_seen > ?)').bind('main', JSON.stringify(content), session.tokenHash, time, time - SESSION_IDLE)
    : store.prepare('UPDATE site_content SET body = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND expires > ? AND last_seen > ?)').bind(JSON.stringify(content), 'main', expected, session.tokenHash, time, time - SESSION_IDLE);
  // D1 batch is transactional. changes() ties audit and backup writes to the successful CAS.
  const results = await store.batch([
    write,
    store.prepare('INSERT INTO audit_log (at, action, session_id, detail, actor_id, actor_username, actor_role) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1').bind(time, action, session.row.session_id, JSON.stringify(sanitizeAuditDetail({revision: next, ...contentChanges(existing.content, content), ...(restoredFrom === undefined ? {} : {restoredFrom})})), session.admin.id, session.admin.username, session.admin.role),
    store.prepare('INSERT INTO content_backups (revision, body, created_at, action) SELECT ?, ?, ?, ? WHERE changes() = 1').bind(expected, JSON.stringify(existing.content), time, action),
    store.prepare('DELETE FROM content_backups WHERE revision NOT IN (SELECT revision FROM content_backups ORDER BY revision DESC LIMIT 20)')
  ]);
  if (results[0].meta.changes !== 1) {
    const active = await store.prepare('SELECT session_id FROM sessions WHERE token_hash = ? AND expires > ? AND last_seen > ?').bind(session.tokenHash, time, time - SESSION_IDLE).first();
    if (!active) throw new HttpError(401, 'Your session has expired. Please log in again.');
    throw new HttpError(409, 'The collection changed. Refresh the page before saving.');
  }
  return json({revision: next});
}
async function overview(env, session) {
  const current = await readContent(env), time = now(), version = await credentialVersion(session.admin);
  const rows = (await db(env).prepare('SELECT session_id, created_at, last_seen, expires FROM sessions WHERE user_id = ? AND expires > ? AND last_seen > ? AND credential_version = ? ORDER BY created_at DESC').bind(session.admin.id, time, time - SESSION_IDLE, version).all()).results;
  const recent = can(session.admin, 'logs.read') ? (await db(env).prepare('SELECT id, at, action, session_id, detail, actor_id, actor_username, actor_role FROM audit_log ORDER BY id DESC LIMIT 50').all()).results : [];
  const last = await db(env).prepare("SELECT at, action, detail FROM audit_log WHERE action IN ('content.save', 'content.restore') ORDER BY id DESC LIMIT 1").first();
  const counts = {total: current.content.listings.length, inventory: {total: 0, available: 0, reserved: 0, sold: 0, draft: 0}, wanted: {total: 0, active: 0, fulfilled: 0, draft: 0}};
  const visible = visibleContent(current.content, session.admin); counts.total = visible.listings.length;
  for (const listing of visible.listings) { counts[listing.type].total++; counts[listing.type][listing.status]++; }
  return json({user: publicUser(session.admin), session: sessionInfo(session.row), activeSessions: rows.map(row => sessionInfo(row, row.session_id === session.row.session_id)), revision: current.revision, lastSave: last ? {revision: JSON.parse(last.detail).revision, at: last.at, action: last.action} : null, counts, recentAudit: recent.map(row => ({id: row.id, at: row.at, action: row.action, actor:{id:row.actor_id,username:row.actor_username || 'Legacy administrator',role:row.actor_role},sessionId: row.session_id, detail: JSON.parse(row.detail)}))});
}
async function changePassword(request, env) {
  const session = await requireAdmin(request, env, true, null, true);
  const input = await body(request, 8192);
  if (typeof input.currentPassword !== 'string' || !input.currentPassword || input.currentPassword.length > 1024 || typeof input.newPassword !== 'string' || input.newPassword.length < 12 || input.newPassword.length > 128 || input.newPassword !== input.confirmPassword) throw new HttpError(400, 'Choose a password of 12–128 characters and confirm it.');
  if (input.newPassword.toLowerCase() === session.admin.username.toLowerCase()) throw new HttpError(400, 'Your password cannot be your username.');
  await throttle(request, env, 'password:' + session.admin.id);
  if (!equal(await passwordHash(input.currentPassword, session.admin.salt), session.admin.hash)) throw new HttpError(400, 'Your current password is incorrect.');
  if (equal(await passwordHash(input.newPassword, session.admin.salt), session.admin.hash)) throw new HttpError(400, 'Choose a different password from your temporary or current password.');
  const salt = random(), hash = await passwordHash(input.newPassword, salt), time = now(), store = db(env);
  const constraint = ' AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ? AND expires > ? AND last_seen > ?)';
  const write = session.admin.id === 'owner'
    ? store.prepare('UPDATE administrator SET salt = ?, hash = ?, hash_version = ? WHERE id = 1 AND hash = ?' + constraint).bind(salt, hash, PASSWORD_VERSION, session.admin.hash, session.tokenHash, session.admin.id, time, time - SESSION_IDLE)
    : store.prepare('UPDATE staff_users SET salt = ?, hash = ?, hash_version = ?, must_change_password = 0, temp_expires_at = NULL, updated_at = ? WHERE id = ? AND hash = ? AND disabled = 0 AND (must_change_password = 0 OR temp_expires_at > ?)' + constraint).bind(salt, hash, PASSWORD_VERSION, time, session.admin.id, session.admin.hash, time, session.tokenHash, session.admin.id, time, time - SESSION_IDLE);
  const results = await store.batch([
    write,
    store.prepare("INSERT INTO audit_log (at, action, session_id, detail, actor_id, actor_username, actor_role) SELECT ?, 'account.password_changed', ?, '{}', ?, ?, ? WHERE changes() = 1").bind(time, session.row.session_id, session.admin.id, session.admin.username, session.admin.role),
    store.prepare('DELETE FROM sessions WHERE user_id = ? AND changes() > 0').bind(session.admin.id),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'Your account changed. Please sign in again.');
  return newSession(request, env, await getAccount(env, session.admin.id));
}
export default {
  async fetch(request, env, ctx) {
    try {
      const address = new URL(request.url), path = address.pathname.replace(/\/$/, '') || '/';
      const mediaAuth = async () => {
        const session = await authenticated(request, env);
        const permission = request.method === 'POST' ? 'media.write' : 'media.read';
        if (!session || (!path.startsWith('/api/') && (session.admin.must_change_password || !can(session.admin, permission)))) return null;
        if (session.admin.must_change_password || !can(session.admin, permission)) throw new HttpError(403, 'You do not have permission to manage media.');
        return session;
      };
      const mediaResponse = await createHostedMediaRoutes({request, env, path, authenticated: mediaAuth, readContent: () => readContent(env), publicContent, json, audit: async (action, id, detail) => { const row = await db(env).prepare('SELECT user_id FROM sessions WHERE session_id = ?').bind(id).first(); await audit(env, action, id, detail, row ? await getAccount(env, row.user_id) : null); }, HttpError});
      if (mediaResponse) return mediaResponse;
      const assetResponse = await createHostedAssetRoutes({request, env, path, assets: STATIC_ASSETS, authenticated: () => authenticated(request, env), requireAdmin: mutation => requireAdmin(request, env, mutation, 'access.manage'), security, json, HttpError});
      if (assetResponse) return assetResponse;
      if (path.startsWith('/api/')) {
        if (address.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) throw new HttpError(403, 'A secure connection is required.');
        // These capabilities intentionally do not exist, including for authenticated users.
        if (path === '/api/setup' || path === '/api/commit') throw new HttpError(404, 'This service does not exist.');
        if (!['GET', 'POST', 'PUT'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
        if (request.method !== 'GET') sameOrigin(request);
        if (path === '/api/chat/status' && request.method === 'GET') return json({available: chatAvailable(env)});
        if (path === '/api/chat' && request.method === 'POST') {
          const input = await body(request, 6000);
          const content = publicContent((await readContent(env)).content);
          return json(await replyToChat({request, env, input, content, HttpError}));
        }
        if (path === '/api/analytics/events' && request.method === 'POST') {
          // Staff browsing must never inflate the public audience figures.
          if (await authenticated(request, env)) return json({recorded: 0, ignored: true}, 202);
          const input = await body(request, 16384);
          const content = publicContent((await readContent(env)).content);
          return json(await collectAnalytics({request, env, input, content, HttpError}), 202);
        }
        if (path === '/api/analytics' && request.method === 'GET') {
          await requireAdmin(request, env, false, 'analytics.read');
          return json(await readAnalytics(env, address.searchParams, HttpError));
        }
        if (path === '/api/session' && request.method === 'GET') {
          const session = await authenticated(request, env);
          return json(session ? await sessionPayload(session) : {authenticated: false});
        }
        if (path === '/api/content' && request.method === 'GET') {
          const result = await readContent(env), session = await authenticated(request, env); result.content = visibleContent(result.content, session?.admin); return json(result);
        }
        if (path === '/api/login' && request.method === 'POST') {
          const input = credentialInput(await body(request, 8192)), bucket = await throttle(request, env, input.username);
          let admin = await findAccount(env, input.username);
          if (!admin) { await bootstrapAdministrator(env, input); admin = await findAccount(env, input.username); }
          const hash = await passwordHash(input.password, admin?.salt || '0000000000000000000000000000000000000000000000000000000000000000');
          if (!admin || admin.disabled || (admin.must_change_password && (!Number.isSafeInteger(admin.temp_expires_at) || admin.temp_expires_at <= now())) || !equal(hash, admin.hash) || !equal(input.username.toLowerCase(), admin.username.toLowerCase()) || admin.hash_version !== PASSWORD_VERSION) {
            await audit(env, 'login.failed', null, {username:input.username}, {id:null,username:input.username,role:'Unverified sign-in'}); throw new HttpError(401, 'The username or password is incorrect.');
          }
          await db(env).prepare('DELETE FROM rate_limits WHERE bucket = ?').bind(bucket).run();
          return await newSession(request, env, admin);
        }
        if (path === '/api/account/password' && request.method === 'POST') return await changePassword(request, env);
        if (path === '/api/users' || path.startsWith('/api/users/')) {
          const session = await requireAdmin(request, env, request.method !== 'GET', 'access.manage');
          const result = await handleAccountRoutes({request, env, path, session, body, json, HttpError, audit:(action,id,detail,actor) => audit(env,action,id,detail,actor)});
          if (result) return result;
        }
        if (path === '/api/logs' && request.method === 'GET') {
          await requireAdmin(request, env, false, 'logs.read'); return json(await readAudit(env, address.searchParams));
        }
        if (path === '/api/logs/retry' && request.method === 'POST') {
          const session = await requireAdmin(request, env, true, 'access.manage');
          if (!can(session.admin, 'logs.read')) throw new HttpError(403, 'Your account cannot read logs.');
          await body(request, 4096); const result = await retryAudit(env);
          await audit(env, 'logs.delivery_retried', session.row.session_id, {}, session.admin);
          await flushAudit(env); return json(result);
        }
        if (path === '/api/admin/overview' && request.method === 'GET') return await overview(env, await requireAdmin(request, env));
        if (path === '/api/backups' && request.method === 'GET') {
          await requireAdmin(request, env, false, 'backups.read');
          const rows = (await db(env).prepare('SELECT revision, body, created_at, action FROM content_backups ORDER BY revision DESC LIMIT 20').all()).results;
          return json({backups: rows.map(row => ({revision: row.revision, createdAt: row.created_at, action: row.action, listingsCount: validateContent(JSON.parse(row.body)).listings.length}))});
        }
        if (path === '/api/content' && request.method === 'PUT') {
          const session = await requireAdmin(request, env, true); return await saveContent(env, await body(request), session);
        }
        if (path === '/api/backups/restore' && request.method === 'POST') {
          const session = await requireAdmin(request, env, true, 'backups.restore'), input = await body(request, 4096), selected = revision(input.backupRevision);
          revision(input.revision);
          const backup = await db(env).prepare('SELECT body FROM content_backups WHERE revision = ?').bind(selected).first();
          if (!backup) throw new HttpError(404, 'That backup is no longer available.');
          return await saveContent(env, {revision: input.revision, content: JSON.parse(backup.body)}, session, 'content.restore', selected);
        }
        if (path === '/api/sessions/revoke' && request.method === 'POST') {
          const session = await requireAdmin(request, env, true); await body(request, 4096);
          const time = now();
          const results = await db(env).batch([
            db(env).prepare('DELETE FROM sessions WHERE token_hash != ? AND user_id = ? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND expires > ? AND last_seen > ?)').bind(session.tokenHash, session.admin.id, session.tokenHash, time, time - SESSION_IDLE),
            db(env).prepare("INSERT INTO audit_log (at, action, session_id, detail, actor_id, actor_username, actor_role) SELECT ?, 'sessions.revoked', ?, json_object('count', changes()), ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND expires > ? AND last_seen > ?)").bind(time, session.row.session_id, session.admin.id, session.admin.username, session.admin.role, session.tokenHash, time, time - SESSION_IDLE)
          ]);
          if (results[1].meta.changes !== 1) throw new HttpError(401, 'Your session has expired. Please log in again.');
          return json({revoked: results[0].meta.changes});
        }
        if (path === '/api/sessions/rotate' && request.method === 'POST') {
          const session = await requireAdmin(request, env, true); await body(request, 4096); return await newSession(request, env, session.admin, session, true);
        }
        if (path === '/api/logout' && request.method === 'POST') {
          const session = await requireAdmin(request, env, true, null, true); await body(request, 4096);
          await db(env).batch([
            db(env).prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.tokenHash),
            db(env).prepare("INSERT INTO audit_log (at, action, session_id, detail, actor_id, actor_username, actor_role) VALUES (?, 'session.logged_out', ?, '{}', ?, ?, ?)").bind(now(), session.row.session_id, session.admin.id, session.admin.username, session.admin.role)
          ]);
          return json({authenticated: false}, 200, {'Set-Cookie': cookie(request, '', 0)});
        }
        throw new HttpError(404, 'This service does not exist.');
      }
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', {status: 405, headers: security});
      // The embedded source content is private: serve its normalized public projection.
      if (path === '/content.json') {
        const publicDefaults = JSON.stringify(publicContent((await readContent(env)).content));
        return new Response(request.method === 'HEAD' ? null : publicDefaults, {headers: {...security, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}});
      }
      const file = allowedPages.has(path) ? '/index.html' : path, asset = STATIC_ASSETS[file];
      if (!asset) return new Response('Not found', {status: 404, headers: security});
      const bytes = Uint8Array.from(atob(asset.bytes), c => c.charCodeAt(0));
      return new Response(request.method === 'HEAD' ? null : bytes, {headers: {...security, 'Content-Type': asset.type, 'Cache-Control': file.startsWith('/assets/') ? 'public, max-age=3600' : 'no-cache'}});
    } catch (error) {
      if (error instanceof HttpError) return json({error: error.message}, error.status, error.status === 429 ? {'Retry-After': String(error.retryAfter || 900)} : {});
      console.error('ENTITY-1 request failed', error?.name);
      return json({error: 'The service is temporarily unavailable. Please try again.'}, 503);
    } finally {
      if (env.DISCORD_AUDIT_WEBHOOK_URL && new URL(request.url).pathname.startsWith('/api/') && !/^\/api\/(?:analytics\/events|chat(?:\/status)?)\/?$/.test(new URL(request.url).pathname) && ctx?.waitUntil) ctx.waitUntil(flushAudit(env).catch(() => {}));
    }
  }
};
