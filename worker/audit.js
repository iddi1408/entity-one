const LEGACY = 'Legacy administrator';
const BATCH = 5, MAX_ATTEMPTS = 8;
const strings = new Set(['id', 'targetId', 'userId', 'listingId', 'username', 'targetUsername', 'previousUsername', 'role', 'targetRole', 'previousRole', 'brand', 'model', 'status', 'previousStatus', 'fromStatus', 'toStatus', 'type', 'listingType', 'filename']);
const numbers = new Set(['count', 'revision', 'restoredFrom', 'size', 'created', 'updated', 'removed', 'total', 'tempExpiresAt']);
const booleans = new Set(['disabled', 'enabled', 'mustChangePassword']);
const fieldNames = new Set(['id', 'type', 'brand', 'model', 'year', 'region', 'location', 'mileage', 'spec', 'price', 'description', 'image', 'gallery', 'featured', 'status', 'internalNotes', 'headline', 'introduction', 'about', 'email', 'heroVideo', 'aboutVideo', 'heroHeading', 'heroDescription', 'heroImageAlt', 'heroCaption', 'heroImage', 'aboutImage', 'socials', 'offices', 'members', 'partners', 'showcase', 'username', 'role', 'permissions', 'disabled', 'password', 'tempExpiresAt', 'mustChangePassword']);
const countNames = new Set(['total', 'created', 'updated', 'removed', 'inventory', 'wanted', 'available', 'reserved', 'sold', 'draft', 'active', 'fulfilled', 'sessions', 'files', 'users', 'media']);
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const seconds = () => Math.floor(Date.now() / 1000);

function text(value, max = 160) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[redacted URL]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted address]')
    .replace(/\b(?:[a-f0-9]{0,4}:){2,}[a-f0-9:]+\b/gi, '[redacted address]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted value]').trim().slice(0, max);
}
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fields = value => Array.isArray(value) ? [...new Set(value.filter(item => fieldNames.has(item)))].slice(0, 40) : [];
function permissions(value) {
  const permitted = name => typeof name === 'string' && /^[a-z][a-z0-9_.:-]{0,63}$/i.test(name);
  if (Array.isArray(value)) return [...new Set(value.filter(permitted))].slice(0, 40);
  if (plainObject(value)) return Object.fromEntries(Object.entries(value).filter(([key, enabled]) => permitted(key) && typeof enabled === 'boolean').slice(0, 40));
  return undefined;
}

/** Shared allowlist also sanitizes legacy/direct-SQL events before reading or sending. */
export function sanitizeAuditDetail(detail) {
  if (!plainObject(detail)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(detail)) {
    if (strings.has(key) && typeof value === 'string') clean[key] = text(key === 'filename' ? value.replaceAll('\\', '/').split('/').at(-1) : value, key === 'filename' ? 160 : 120);
    else if (numbers.has(key) && integer(value)) clean[key] = value;
    else if (booleans.has(key) && typeof value === 'boolean') clean[key] = value;
    else if (['fields', 'changedFields', 'settingsFields'].includes(key)) clean[key] = fields(value);
    else if (key === 'permissions') { const allowed = permissions(value); if (allowed !== undefined) clean[key] = allowed; }
    else if (key === 'filenames' && Array.isArray(value)) clean[key] = value.filter(item => typeof item === 'string').slice(0, 20).map(item => text(item.replaceAll('\\', '/').split('/').at(-1)));
    else if (key === 'counts' && plainObject(value)) clean[key] = Object.fromEntries(Object.entries(value).filter(([name, count]) => countNames.has(name) && integer(count)));
    else if (key === 'changes' && Array.isArray(value)) clean[key] = value.filter(plainObject).slice(0, 25).map(change => {
      const item = {};
      for (const name of ['type', 'id', 'brand', 'model', 'status']) if (typeof change[name] === 'string') item[name] = text(change[name], 120);
      if (['created', 'updated', 'removed'].includes(change.action)) item.action = change.action;
      if (change.fields !== undefined) item.fields = fields(change.fields);
      return item;
    });
  }
  return clean;
}

function actionName(action) { return typeof action === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/.test(action) ? action : 'audit.event'; }
function actorSnapshot(actor) {
  return {id: typeof actor?.id === 'string' || typeof actor?.id === 'number' ? text(String(actor.id), 96) || null : null, username: text(actor?.username, 80) || 'System', role: text(actor?.role, 40) || 'system'};
}
export async function writeAudit(env, action, sessionId = null, detail = {}, actor = null) {
  const identity = actorSnapshot(actor);
  const result = await env.DB.prepare('INSERT INTO audit_log (at, action, session_id, detail, actor_id, actor_username, actor_role) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id').bind(seconds(), actionName(action), typeof sessionId === 'string' ? text(sessionId, 96) : null, JSON.stringify(sanitizeAuditDetail(detail)), identity.id, identity.username, identity.role).first();
  return {id: result.id};
}

function webhook(env) {
  const value = env.DISCORD_AUDIT_WEBHOOK_URL;
  return typeof value === 'string' && /^https:\/\/discord\.com\/api\/webhooks\/[0-9]{1,22}\/[A-Za-z0-9_-]{20,200}$/.test(value) ? value + '?wait=true' : null;
}
function parsedDetail(value) { try { return sanitizeAuditDetail(JSON.parse(value)); } catch { return {}; } }
function safeError(value) { return typeof value === 'string' && /^(discord_http_[0-9]{3}|discord_rate_limited|discord_timeout|discord_network_error|discord_redirect_refused)(?:_retry_exhausted)?$/.test(value) ? value : value ? 'delivery_failed' : null; }
function event(row) {
  return {id: row.id, at: row.at, action: actionName(row.action), actor: {id: row.actor_id === null ? null : text(String(row.actor_id), 96), username: row.actor_username === null ? LEGACY : text(row.actor_username, 80), role: row.actor_role === null ? 'legacy' : text(row.actor_role, 40)}, detail: parsedDetail(row.detail), delivery: {status: row.delivery_id === null ? 'legacy' : row.sent_at !== null ? 'sent' : row.last_error ? 'failed' : 'pending', attempts: row.attempts || 0, error: safeError(row.last_error)}};
}
function timeFilter(value, end) {
  if (/^\d{1,12}$/.test(value)) return Number(value);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const timestamp = Date.parse(dateOnly ? value + (end ? 'T23:59:59Z' : 'T00:00:00Z') : value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : NaN;
}
export async function readAudit(env, search = new URLSearchParams()) {
  const where = [], values = [];
  const cursor = search.get('cursor');
  if (cursor) { if (/^[1-9][0-9]{0,15}$/.test(cursor) && Number.isSafeInteger(Number(cursor))) { where.push('a.id < ?'); values.push(Number(cursor)); } else where.push('0 = 1'); }
  const action = search.get('action');
  if (action) { where.push('a.action = ?'); values.push(action.slice(0, 80)); }
  const actor = search.get('actor');
  if (actor === LEGACY) where.push('a.actor_username IS NULL');
  else if (actor) { where.push('(a.actor_username = ? OR a.actor_id = ?)'); values.push(actor.slice(0, 96), actor.slice(0, 96)); }
  for (const [key, comparator] of [['from', '>='], ['to', '<=']]) {
    if (!search.get(key)) continue;
    const time = timeFilter(search.get(key), key === 'to');
    if (!integer(time)) where.push('0 = 1'); else { where.push(`a.at ${comparator} ?`); values.push(time); }
  }
  const rows = (await env.DB.prepare(`SELECT a.*, d.audit_id AS delivery_id, d.attempts, d.sent_at, d.last_error FROM audit_log a LEFT JOIN audit_delivery d ON d.audit_id = a.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 51`).bind(...values).all()).results;
  const summary = await env.DB.prepare('SELECT SUM(CASE WHEN sent_at IS NULL AND last_error IS NULL THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN sent_at IS NULL AND last_error IS NOT NULL THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent FROM audit_delivery').first();
  const actors = (await env.DB.prepare('SELECT DISTINCT actor_username FROM audit_log ORDER BY actor_username LIMIT 200').all()).results.map(row => row.actor_username === null ? LEGACY : text(row.actor_username, 80));
  return {events: rows.slice(0, 50).map(event), nextCursor: rows.length > 50 ? String(rows[49].id) : null, delivery: {configured: !!webhook(env), pending: summary.pending || 0, failed: summary.failed || 0, sent: summary.sent || 0}, actors};
}

const humanize = value => value.replace(/[._-]+/g, ' ').replace(/\b[a-z]/g, character => character.toUpperCase());
const discordText = value => text(value, 3000).replace(/([\\`*_~|<>\[\]()])/g, '\\$1').replaceAll('@', '@\u200b');
function discordMessage(row) {
  const identity = row.actor_username === null ? {username: LEGACY, role: 'legacy'} : {username: text(row.actor_username, 80), role: text(row.actor_role, 40)};
  const detail = parsedDetail(row.detail), lines = [];
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'changes') for (const item of value.slice(0, 8)) lines.push(`${humanize(item.action || 'changed')}: ${[item.brand, item.model].filter(Boolean).join(' ') || item.id || 'Listing'}${item.status ? ' · ' + item.status : ''}${item.fields?.length ? ' · fields: ' + item.fields.join(', ') : ''}`);
    else lines.push(`${humanize(key)}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  return {username: 'ENTITY-1 Audit', allowed_mentions: {parse: []}, embeds: [{title: 'E1 / ' + humanize(actionName(row.action)), color: 0x242628, description: lines.length ? lines.map(discordText).join('\n').slice(0, 3000) : 'Administrative activity recorded.', fields: [{name: 'Actor', value: discordText(identity.username) || 'System', inline: true}, {name: 'Role', value: discordText(identity.role) || 'system', inline: true}, {name: 'Event ID', value: '#' + row.id, inline: true}], timestamp: new Date(row.at * 1000).toISOString(), footer: {text: 'ENTITY-1 • PRIVATE OPERATIONS'}}]};
}
const retrySeconds = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.max(1, Math.min(86400, Math.ceil(Number(value)))) : null;
async function retryDelay(response) {
  const header = retrySeconds(response.headers.get('Retry-After')) || retrySeconds(response.headers.get('X-RateLimit-Reset-After'));
  if (header) { await response.body?.cancel().catch(() => {}); return header; }
  if (!response.body) return 60;
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) { const {done, value} = await reader.read(); if (done) break; length += value.byteLength; if (length > 4096) { await reader.cancel(); return 60; } chunks.push(value); }
    const bytes = new Uint8Array(length); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
    return retrySeconds(JSON.parse(new TextDecoder().decode(bytes)).retry_after) || 60;
  } catch { return 60; } finally { reader.releaseLock(); }
}

/** Injected fetch/clock are for isolated tests; never pass request-controlled options. */
export async function flushAudit(env, options = {}) {
  const url = webhook(env), result = {configured: !!url, attempted: 0, sent: 0, failed: 0};
  if (!url) return result;
  const clock = options.now || seconds, send = options.fetch || globalThis.fetch, started = Date.now();
  const rows = (await env.DB.prepare('SELECT a.* FROM audit_delivery d JOIN audit_log a ON a.id = d.audit_id WHERE d.sent_at IS NULL AND d.next_attempt_at >= 0 AND d.next_attempt_at <= ? AND d.lease_until <= ? ORDER BY d.audit_id LIMIT 5').bind(clock(), clock()).all()).results;
  for (const row of rows.slice(0, BATCH)) {
    if (Date.now() - started > 20000) break;
    const now = clock(), lease = now + 60;
    const claim = await env.DB.prepare('UPDATE audit_delivery SET attempts = attempts + 1, lease_until = ? WHERE audit_id = ? AND sent_at IS NULL AND next_attempt_at >= 0 AND next_attempt_at <= ? AND lease_until <= ? RETURNING attempts').bind(lease, row.id, now, now).first();
    if (!claim) continue;
    result.attempted++;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(8000, options.timeoutMs || 8000)));
    let error = null, retry = 0, permanent = false, cooldown = 0;
    try {
      const response = await send(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(discordMessage(row)), redirect: 'manual', signal: controller.signal});
      if (response.status >= 200 && response.status < 300) {
        if (response.headers.get('X-RateLimit-Remaining') === '0') cooldown = retrySeconds(response.headers.get('X-RateLimit-Reset-After')) || 1;
        await response.body?.cancel().catch(() => {});
      } else if (response.status === 429) { error = 'discord_rate_limited'; retry = await retryDelay(response); cooldown = retry; }
      else { error = response.status >= 300 && response.status < 400 ? 'discord_redirect_refused' : `discord_http_${response.status}`; permanent = response.status >= 300 && response.status < 500; await response.body?.cancel().catch(() => {}); }
    } catch { error = controller.signal.aborted ? 'discord_timeout' : 'discord_network_error'; }
    finally { clearTimeout(timer); }
    if (!error) {
      await env.DB.prepare('UPDATE audit_delivery SET sent_at = ?, last_error = NULL, lease_until = 0 WHERE audit_id = ? AND lease_until = ? AND attempts = ? AND sent_at IS NULL').bind(clock(), row.id, lease, claim.attempts).run(); result.sent++;
    } else {
      if (!permanent && claim.attempts >= MAX_ATTEMPTS) { permanent = true; error += '_retry_exhausted'; }
      const next = permanent ? -1 : clock() + (retry || Math.min(3600, 30 * 2 ** Math.min(claim.attempts - 1, 7)));
      await env.DB.prepare('UPDATE audit_delivery SET next_attempt_at = ?, last_error = ?, lease_until = 0 WHERE audit_id = ? AND lease_until = ? AND attempts = ? AND sent_at IS NULL').bind(next, error, row.id, lease, claim.attempts).run(); result.failed++;
    }
    if (cooldown) { await env.DB.prepare('UPDATE audit_delivery SET next_attempt_at = MAX(next_attempt_at, ?) WHERE sent_at IS NULL AND next_attempt_at >= 0').bind(clock() + cooldown).run(); break; }
  }
  return result;
}
export async function retryAudit(env) {
  const now = seconds();
  const result = await env.DB.prepare("UPDATE audit_delivery SET attempts = 0, next_attempt_at = CASE WHEN last_error = 'discord_rate_limited' AND next_attempt_at > ? THEN next_attempt_at ELSE 0 END, last_error = NULL, lease_until = 0 WHERE audit_id IN (SELECT audit_id FROM audit_delivery WHERE sent_at IS NULL AND last_error IS NOT NULL AND lease_until <= ? ORDER BY audit_id DESC LIMIT 250)").bind(now, now).run();
  return {queued: result.meta.changes};
}
