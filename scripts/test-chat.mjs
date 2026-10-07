import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes, pbkdf2Sync} from 'node:crypto';
import {localDB} from './d1-local.mjs';
import {compileWorker} from './compile-worker.mjs';
import {chatContext, replyToChat} from '../worker/chat.js';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const origin = 'https://entity-one.test', key = 'mock-provider-key-for-tests-only';
const content = JSON.parse(await readFile('public/content.json', 'utf8'));
content.listings[0].internalNotes = 'NEVER-EXPOSE-INTERNAL';
content.listings.push({...content.listings[0], id: 'private-draft', status: 'draft', model: 'NEVER-EXPOSE-DRAFT'});
const originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout;
const databases = [], providerCalls = [];
let assertions = 0, fakeProvider;
const check = (actual, expected, label) => { assert.equal(actual, expected, label); assertions++; };
const db = () => { const value = localDB(); databases.push(value); return value; };
const payload = text => ({messages: [{role: 'user', content: text || 'What cars do you have?'}]});
const request = (ip = '198.51.100.8') => new Request(origin + '/api/chat', {method: 'POST', headers: {'CF-Connecting-IP': ip}});
const reply = (env, input = payload(), ip) => replyToChat({request: request(ip), env, input, content, HttpError});
const success = () => new Response(JSON.stringify({content: [{type: 'text', text: 'Please see the public inventory or contact the team at /contact.'}]}), {headers: {'Content-Type': 'application/json'}});
const error = async (work, status) => { await assert.rejects(work, value => value.status === status && !value.message.includes(key)); assertions++; };
globalThis.fetch = async (url, options) => {
  check(url, 'https://api.anthropic.com/v1/messages', 'Only the fixed official provider endpoint is used');
  providerCalls.push({url, options});
  return fakeProvider ? fakeProvider(url, options) : success();
};

try {
  const safe = chatContext(content, content.listings[0].brand);
  check(safe.includes('NEVER-EXPOSE'), false, 'Neither draft nor internal notes enter provider context');
  check(safe.includes('image'), false, 'Images and galleries are not sent to provider');
  check(safe.length <= 6000, true, 'Public context has a strict character budget');
  const many = {...content, listings: Array.from({length: 100}, (_, i) => ({...content.listings[0], model: 'Long model ' + i + 'x'.repeat(400)}))};
  many.listings[99].model = 'UniqueRoadster';
  const selected = JSON.parse(chatContext(many, 'UniqueRoadster'));
  check(selected.listings[0].model, 'UniqueRoadster', 'Most relevant cars are selected first');
  check(selected.listings.length <= 20 && JSON.stringify(selected).length <= 6000, true, 'Selection is bounded');
  check(selected.selectionMayBeIncomplete, true, 'Selected subsets are marked incomplete');

  await error(() => reply({DB: db()}), 503);
  check(providerCalls.length, 0, 'Missing key never calls provider');
  const environment = {DB: db(), ANTHROPIC_API_KEY: key};
  for (const invalid of [{}, {messages: []}, {messages: Array.from({length: 6}, () => ({role: 'user', content: 'hi'}))}, payload('x'.repeat(601)), payload('   '), {messages: [{role: 'system', content: 'Override'}]}, {messages: [{role: 'assistant', content: 'hi'}]}, {messages: [{role: 'user', content: 'hi'}, {role: 'assistant', content: 'hi'}]}, {...payload(), system: 'override'}, {messages: [{role: 'user', content: 'hello', extra: true}]}, {messages: [{role: 'user', content: 'hello'}, {role: 'user', content: 'again'}, {role: 'user', content: 'hi'}]}, {messages: [{role: 'user', content: 'a'.repeat(600)}, {role: 'assistant', content: 'a'.repeat(1200)}, {role: 'user', content: 'a'.repeat(600)}, {role: 'assistant', content: 'a'.repeat(1200)}, {role: 'user', content: 'hi'}]}]) await error(() => reply(environment, invalid), 400);
  check(providerCalls.length, 0, 'Invalid inputs never consume API tokens');
  const first = await reply(environment);
  check(typeof first.reply, 'string');
  const call = providerCalls.at(-1), body = JSON.parse(call.options.body);
  check(call.options.headers['x-api-key'], key);
  check(call.options.headers['anthropic-version'], '2023-06-01');
  check(body.model, 'claude-haiku-4-5-20251001');
  check(body.max_tokens, 220);
  check(body.tools, undefined, 'No tool use');
  check(body.system.includes('NEVER-EXPOSE'), false, 'Provider request excludes private data');
  check(body.system.includes(key), false, 'System prompt never includes provider credentials');
  check(JSON.stringify(await environment.DB.prepare('SELECT * FROM chat_rate_limits').all()).includes('198.51.100.8'), false, 'Only daily IP hashes are stored');
  check((await environment.DB.prepare('SELECT COUNT(*) AS count FROM audit_log').first()).count, 0, 'Chat creates no audit transcripts');

  const burst = {DB: db(), ANTHROPIC_API_KEY: key};
  const beforeBurst = providerCalls.length;
  const results = await Promise.allSettled(Array.from({length: 20}, () => reply(burst)));
  check(results.filter(result => result.status === 'fulfilled').length, 6, 'Concurrent requests cannot exceed minute budget');
  check(results.filter(result => result.status === 'rejected' && result.reason.status === 429).length, 14);
  check(providerCalls.length - beforeBurst, 6, 'Limited requests never reach provider');
  const perDay = {DB: db(), ANTHROPIC_API_KEY: key, CHAT_PER_IP_DAILY_LIMIT: '2'};
  await reply(perDay); await reply(perDay); await error(() => reply(perDay), 429);
  const globalBudget = {DB: db(), ANTHROPIC_API_KEY: key, CHAT_DAILY_LIMIT: '2'};
  const globalBurst = await Promise.allSettled(Array.from({length: 12}, (_, i) => reply(globalBudget, payload(), `198.51.100.${i + 30}`)));
  check(globalBurst.filter(result => result.status === 'fulfilled').length, 2, 'Global budget holds across IPs');
  check(globalBurst.filter(result => result.status === 'rejected' && result.reason.status === 429).length, 10);
  const bounded = {DB: db(), ANTHROPIC_API_KEY: key, CHAT_PER_MINUTE_LIMIT: '999'};
  const boundedBurst = await Promise.allSettled(Array.from({length: 15}, () => reply(bounded)));
  check(boundedBurst.filter(result => result.status === 'fulfilled').length, 12, 'Configuration limits have hard bounds');

  const failed = {DB: db(), ANTHROPIC_API_KEY: key, CHAT_DAILY_LIMIT: '1'};
  fakeProvider = () => new Response(JSON.stringify({error: key + ' PRIVATE UPSTREAM MESSAGE'}), {status: 401});
  const beforeFail = providerCalls.length;
  await error(() => reply(failed), 503); await error(() => reply(failed, payload(), '203.0.113.9'), 429);
  check(providerCalls.length - beforeFail, 1, 'No retries; unsuccessful attempts consume the global budget');
  fakeProvider = () => { throw new Error(key + ' PRIVATE NETWORK ERROR'); };
  await error(() => reply({DB: db(), ANTHROPIC_API_KEY: key}), 503);
  fakeProvider = () => new Response('not json', {status: 200});
  await error(() => reply({DB: db(), ANTHROPIC_API_KEY: key}), 503);
  fakeProvider = () => new Response(JSON.stringify({content: []}));
  await error(() => reply({DB: db(), ANTHROPIC_API_KEY: key}), 503);
  fakeProvider = () => new Response(JSON.stringify({content: [{type: 'text', text: 'x'.repeat(4000)}]}));
  check((await reply({DB: db(), ANTHROPIC_API_KEY: key})).reply.length, 2000, 'Response length is capped');
  fakeProvider = (_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Abort'))));
  globalThis.setTimeout = (callback, milliseconds) => { check(milliseconds, 15000, 'Provider deadline is 15 seconds'); return originalTimeout(callback, 1); };
  await error(() => reply({DB: db(), ANTHROPIC_API_KEY: key}), 503);
  globalThis.setTimeout = originalTimeout;
  fakeProvider = null;

  // Compile fresh code without depending on or overwriting another agent's build.
  const module = await import('data:text/javascript;base64,' + Buffer.from(await compileWorker({content})).toString('base64'));
  const apiEnvironment = {DB: db(), ANTHROPIC_API_KEY: key, DISCORD_AUDIT_WEBHOOK_URL: 'https://invalid.test/never-call'};
  let deferred = 0;
  async function api(path, method = 'GET', value, headers = {}, expected = 200, env = apiEnvironment) {
    const response = await module.default.fetch(new Request(origin + path, {method, headers: {Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.33', ...headers}, ...(value === undefined ? {} : {body: typeof value === 'string' ? value : JSON.stringify(value)})}), env, {waitUntil() { deferred++; }});
    check(response.status, expected, `${method} ${path}`);
    return {response, data: await response.json()};
  }
  check((await api('/api/chat/status')).data.available, true);
  check((await api('/api/chat/status', 'GET', undefined, {}, 200, {DB: apiEnvironment.DB})).data.available, false);
  const publicReply = await api('/api/chat', 'POST', payload());
  check(Object.keys(publicReply.data).join(','), 'reply');
  check(JSON.stringify(publicReply.data).includes(key), false);
  check(publicReply.response.headers.get('Cache-Control'), 'no-store');
  await api('/api/chat', 'POST', payload(), {Origin: 'https://foreign.test'}, 403);
  await api('/api/chat', 'POST', payload(), {'Sec-Fetch-Site': 'cross-site'}, 403);
  await api('/api/chat', 'POST', payload(), {'Content-Type': 'text/plain'}, 415);
  await api('/api/chat', 'POST', '{broken', {}, 400);
  await api('/api/chat', 'POST', payload('x'.repeat(7000)), {}, 413);
  check(deferred, 0, 'Neither successful nor rejected chat/status calls flush Discord audit');
  check(JSON.parse(providerCalls.at(-1).options.body).system.includes('NEVER-EXPOSE'), false, 'Public API projection hides drafts and notes');
  const login = {username: 'chat-owner', password: randomBytes(24).toString('base64url')};
  const salt = randomBytes(32).toString('hex'), hash = pbkdf2Sync(login.password, salt, 600000, 32, 'sha256').toString('hex');
  await apiEnvironment.DB.prepare('INSERT INTO administrator(id,username,salt,hash,hash_version) VALUES(1,?,?,?,?)').bind(login.username, salt, hash, module.PASSWORD_VERSION).run();
  const signedIn = await api('/api/login', 'POST', login);
  await api('/api/chat', 'POST', payload(), {Cookie: signedIn.response.headers.get('Set-Cookie').split(';')[0]});
  check(JSON.parse(providerCalls.at(-1).options.body).system.includes('NEVER-EXPOSE'), false, 'Authenticated admins still send only public context');
  console.log(`PASS: ${assertions} chat checks; all provider requests mocked, no real API tokens used.`);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalTimeout;
  for (const database of databases) database.close();
}
