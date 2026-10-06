import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {writeAudit, readAudit, flushAudit, retryAudit, sanitizeAuditDetail} from '../worker/audit.js';

const migrations = await Promise.all(['0000_jazzy_marvel_zombies.sql', '0001_private_administrator.sql', '0002_staff_accounts.sql'].map(name => readFile('drizzle/' + name, 'utf8')));
const databases = [], originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('External network is forbidden in audit tests'); };
const webhook = 'https://discord.com/api/webhooks/123456789012345678/UNIT_TEST_ONLY_WEBHOOK_TOKEN_123456789';
const identity = {id: 'owner', username: 'test-owner', role: 'owner'};
const marker = 'PRIVATE-CONTENT-MUST-NOT-LEAK';
let checks = 0;
function fixture(configured = true) {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  sqlite.exec(migrations[0]); sqlite.exec(migrations[1]);
  sqlite.prepare('INSERT INTO audit_log (at,action,session_id,detail) VALUES (?,?,?,?)').run(1700000000, 'content.save', null, JSON.stringify({revision: 1, internalNotes: marker}));
  sqlite.exec(migrations[2]);
  const DB = {prepare(sql) { let values = []; const statement = {bind(...args) { values = args; return statement; }, async first() { return sqlite.prepare(sql).get(...values) || null; }, async all() { return {results: sqlite.prepare(sql).all(...values)}; }, async run() { const result = sqlite.prepare(sql).run(...values); return {meta: {changes: Number(result.changes)}}; }}; return statement; }};
  return {DB, ...(configured ? {DISCORD_AUDIT_WEBHOOK_URL: webhook} : {}), sqlite};
}
const row = (env, id) => env.sqlite.prepare('SELECT * FROM audit_delivery WHERE audit_id=?').get(id);
const count = env => env.sqlite.prepare('SELECT COUNT(*) AS total FROM audit_log').get().total;
const log = (env, action = 'content.save', detail = {}) => writeAudit(env, action, 'safe-session-id', detail, identity);
const good = async () => new Response('{}', {status: 200});
const check = (condition, message) => { assert.ok(condition, message); checks++; };

try {
  const env = fixture(false);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS total FROM audit_delivery').get().total, 0, 'Migration does not queue legacy history');
  const safe = sanitizeAuditDetail({username: 'staff', role: 'manager', targetId: 'staff-id', disabled: false, mustChangePassword: true, tempExpiresAt: 1900000000, permissions: ['inventory.edit', 'logs.view'], password: marker, hash: marker, token: marker, webhook: marker, ip: '192.0.2.1', requestBody: marker, internalNotes: marker, filename: 'C:\\private\\photo.jpg', changes: [{id: 'listing-one', type: 'inventory', brand: 'Ferrari', model: '488', status: 'reserved', action: 'updated', fields: ['status', 'internalNotes', 'token'], internalNotes: marker, password: marker}], settingsFields: ['heroImage', 'token'], counts: {updated: 1, password: 20}});
  check(!JSON.stringify(safe).includes(marker), 'Strict detail allowlist omits secrets and private values');
  assert.equal(safe.filename, 'photo.jpg'); assert.deepEqual(safe.changes[0].fields, ['status', 'internalNotes']); assert.deepEqual(safe.settingsFields, ['heroImage']);
  assert.deepEqual(sanitizeAuditDetail({model: 'https://discord.com/api/webhooks/1/token', username: '192.0.2.4', id: 'a'.repeat(64)}), {model: '[redacted URL]', username: '[redacted address]', id: '[redacted value]'});
  const inserted = await log(env, 'listing.updated', safe);
  assert.equal(row(env, inserted.id).attempts, 0, 'New event trigger enqueues automatically');
  let view = await readAudit(env);
  assert.equal(view.events[0].actor.username, identity.username); assert.equal(view.events[1].actor.username, 'Legacy administrator');
  assert.equal(view.events[1].delivery.status, 'legacy'); assert.equal(view.delivery.configured, false); assert.equal(view.delivery.pending, 1);
  check(!JSON.stringify(view).includes(marker), 'Reads sanitize legacy rows too');
  assert.deepEqual((await readAudit(env, new URLSearchParams({action: 'listing.updated', actor: identity.username}))).events.map(event => event.id), [inserted.id]);
  assert.equal((await readAudit(env, new URLSearchParams({actor: "x' OR 1=1 --"}))).events.length, 0);
  assert.equal((await readAudit(env, new URLSearchParams({cursor: 'nonsense'}))).events.length, 0);
  assert.equal((await readAudit(env, new URLSearchParams({from: 'invalid-date'}))).events.length, 0);
  env.sqlite.prepare('UPDATE audit_log SET at=? WHERE id=?').run(1767225600, inserted.id);
  assert.equal((await readAudit(env, new URLSearchParams({from: '2026-01-01', to: '2026-01-01'}))).events.length, 1);
  assert.equal((await readAudit(env, new URLSearchParams({from: '2026-01-02'}))).events.length, 0);
  for (let i = 0; i < 55; i++) await log(env, 'staff.updated', {username: 'staff-' + i});
  view = await readAudit(env); assert.equal(view.events.length, 50); assert.ok(view.nextCursor);
  const page = await readAudit(env, new URLSearchParams({cursor: view.nextCursor}));
  assert.equal(page.events.length, 7); check(page.events.every(event => !view.events.some(other => other.id === event.id)), 'Cursor pages do not overlap');
  assert.equal((await flushAudit(env)).attempted, 0, 'Missing secret does not affect persistent records');

  for (const invalid of [webhook.replace('https:', 'http:'), webhook.replace('discord.com', 'discord.com.evil.test'), webhook.replace('discord.com', 'discordapp.com'), webhook.replace('discord.com', 'user:password@discord.com'), webhook + '?wait=false', webhook + '#fragment', webhook.replace('discord.com', 'discord.com:8443')]) {
    const invalidEnv = {...env, DISCORD_AUDIT_WEBHOOK_URL: invalid};
    assert.equal((await flushAudit(invalidEnv)).configured, false); assert.equal((await readAudit(invalidEnv)).delivery.configured, false);
  }

  const delivery = fixture();
  const deliveryId = (await log(delivery, 'listing.updated', {...safe, password: marker})).id;
  let sentPayload, sentUrl, sendCount = 0, release, reached;
  const ready = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const fakeSend = async (url, options) => {
    sendCount++; sentUrl = url; sentPayload = JSON.parse(options.body);
    assert.equal(options.redirect, 'manual'); assert.equal(options.method, 'POST'); assert.equal(options.signal.aborted, false);
    reached(); await gate; return new Response(JSON.stringify({content: marker}), {status: 200});
  };
  const inFlight = flushAudit(delivery, {fetch: fakeSend}); await ready;
  const competing = await flushAudit(delivery, {fetch: fakeSend}); assert.equal(competing.attempted, 0);
  release(); assert.equal((await inFlight).sent, 1); assert.equal(sendCount, 1);
  assert.equal(sentUrl, webhook + '?wait=true'); assert.deepEqual(sentPayload.allowed_mentions, {parse: []});
  assert.equal(sentPayload.embeds[0].color, 0x242628); assert.equal(sentPayload.embeds[0].fields[0].value, identity.username);
  check(sentPayload.embeds[0].timestamp.endsWith('Z'), 'Discord uses UTC timestamp');
  check(!JSON.stringify(sentPayload).includes(marker), 'Discord payload contains no private values or response data');
  assert.ok(row(delivery, deliveryId).sent_at); assert.equal(row(delivery, deliveryId).lease_until, 0);
  assert.equal((await readAudit(delivery)).delivery.sent, 1); assert.equal((await flushAudit(delivery, {fetch: fakeSend})).attempted, 0);
  assert.equal((await retryAudit(delivery)).queued, 0, 'Sent events never requeue');

  const retry = fixture(); const retryId = (await log(retry)).id; let now = Math.floor(Date.now() / 1000);
  assert.equal((await flushAudit(retry, {now: () => now, fetch: async () => new Response('not stored', {status: 503})})).failed, 1);
  assert.equal(row(retry, retryId).next_attempt_at, now + 30); assert.equal(row(retry, retryId).last_error, 'discord_http_503');
  assert.equal((await flushAudit(retry, {now: () => now, fetch: good})).attempted, 0);
  now += 30; assert.equal((await flushAudit(retry, {now: () => now, fetch: good})).sent, 1);
  assert.equal(row(retry, retryId).attempts, 2);

  const rate = fixture(); const rateId = (await log(rate)).id; const otherId = (await log(rate)).id;
  now = Math.floor(Date.now() / 1000);
  assert.equal((await flushAudit(rate, {now: () => now, fetch: async () => new Response(JSON.stringify({retry_after: 60.2, message: marker}), {status: 429})})).attempted, 1);
  assert.equal(row(rate, rateId).next_attempt_at, now + 61); assert.equal(row(rate, otherId).next_attempt_at, now + 61);
  await retryAudit(rate); assert.equal(row(rate, rateId).next_attempt_at, now + 61, 'Explicit retry honors active Discord cooldown');
  assert.equal((await flushAudit(rate, {now: () => now, fetch: good})).attempted, 0);
  now += 61; assert.equal((await flushAudit(rate, {now: () => now, fetch: good})).sent, 2);
  const headerRate = fixture(); const headerId = (await log(headerRate)).id;
  await flushAudit(headerRate, {now: () => now, fetch: async () => new Response('{}', {status: 429, headers: {'Retry-After': '999999'}})});
  assert.equal(row(headerRate, headerId).next_attempt_at, now + 86400, 'Retry delay is bounded');

  const permanent = fixture(); const permanentId = (await log(permanent)).id;
  await flushAudit(permanent, {fetch: async () => new Response(marker, {status: 403})});
  assert.equal(row(permanent, permanentId).next_attempt_at, -1);
  assert.equal((await flushAudit(permanent, {fetch: good})).attempted, 0);
  permanent.sqlite.prepare('UPDATE audit_delivery SET lease_until=? WHERE audit_id=?').run(Math.floor(Date.now() / 1000) + 60, permanentId);
  assert.equal((await retryAudit(permanent)).queued, 0, 'Explicit retry does not steal an active delivery lease');
  permanent.sqlite.prepare('UPDATE audit_delivery SET lease_until=0 WHERE audit_id=?').run(permanentId);
  assert.equal((await retryAudit(permanent)).queued, 1); assert.equal(row(permanent, permanentId).attempts, 0);
  assert.equal((await flushAudit(permanent, {fetch: good})).sent, 1);
  const redirect = fixture(); const redirectId = (await log(redirect)).id;
  await flushAudit(redirect, {fetch: async () => new Response(null, {status: 302, headers: {Location: 'https://evil.example'}})});
  assert.equal(row(redirect, redirectId).last_error, 'discord_redirect_refused'); assert.equal(row(redirect, redirectId).next_attempt_at, -1);

  const network = fixture(); const networkId = (await log(network)).id;
  await flushAudit(network, {fetch: async () => { throw new Error(webhook); }});
  assert.equal(row(network, networkId).last_error, 'discord_network_error'); check(!JSON.stringify(await readAudit(network)).includes(webhook), 'Network errors never expose webhook secrets');
  const timeout = fixture(); const timeoutId = (await log(timeout)).id;
  await flushAudit(timeout, {timeoutMs: 5, fetch: async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error(marker))))});
  assert.equal(row(timeout, timeoutId).last_error, 'discord_timeout');
  assert.equal(count(timeout), 2, 'Delivery failure preserves the audit event');
  timeout.sqlite.prepare('UPDATE audit_delivery SET attempts=7,next_attempt_at=0').run();
  await flushAudit(timeout, {fetch: async () => new Response(null, {status: 500})});
  assert.equal(row(timeout, timeoutId).attempts, 8); assert.equal(row(timeout, timeoutId).next_attempt_at, -1); assert.equal(row(timeout, timeoutId).last_error, 'discord_http_500_retry_exhausted');

  const batch = fixture(); for (let i = 0; i < 7; i++) await log(batch);
  assert.equal((await flushAudit(batch, {fetch: good})).sent, 5); assert.equal((await flushAudit(batch, {fetch: good})).sent, 2);
  const cooldown = fixture(); const cooldownId = (await log(cooldown)).id; const remainingId = (await log(cooldown)).id;
  now = Math.floor(Date.now() / 1000);
  assert.equal((await flushAudit(cooldown, {now: () => now, fetch: async () => new Response('{}', {headers: {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '4.2'}})})).sent, 1);
  assert.ok(row(cooldown, cooldownId).sent_at); assert.equal(row(cooldown, remainingId).next_attempt_at, now + 5);
  console.log(`Audit tests passed: schema trigger, actor snapshots, detail redaction (${checks} focused checks), pagination/filters, concurrent delivery leases, Discord payload, cooldowns, retries, permanent failures, timeouts, and bounded batches. No external messages sent.`);
} finally { globalThis.fetch = originalFetch; for (const database of databases) database.close(); }
