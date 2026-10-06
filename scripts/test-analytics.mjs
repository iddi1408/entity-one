import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDB} from './d1-local.mjs';
import {collectAnalytics, readAnalytics, ANALYTICS_CLICK_TARGETS} from '../worker/analytics.js';

const DAY = 86400, origin = 'https://entity-one.test';
const baseTime = Date.parse('2026-10-06T12:00:00Z') / 1000;
let clock = baseTime, checks = 0;
const originalNow = Date.now, originalFetch = globalThis.fetch, databases = [];
Date.now = () => clock * 1000;
globalThis.fetch = async () => { throw new Error('External network forbidden in analytics tests'); };
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
const secret = 'PRIVATE-FORM-NOTE-MUST-NOT-LEAK';
const content = {listings: [
  {id: 'porsche-one', type: 'inventory', status: 'available', brand: 'Porsche', model: '911 GT3 RS', region: 'Europe', internalNotes: secret},
  {id: 'ferrari-wanted', type: 'wanted', status: 'active', brand: 'Ferrari', model: '488', region: 'America'},
  {id: 'private-draft', type: 'inventory', status: 'draft', brand: 'SecretBrand', model: secret, region: 'Europe'},
  {id: 'private-sold', type: 'inventory', status: 'sold', brand: 'SecretBrand', model: secret, region: 'Europe'},
  {id: 'wanted-closed', type: 'wanted', status: 'fulfilled', brand: 'SecretBrand', model: secret, region: 'Europe'},
  {id: 'custom-public', type: 'inventory', status: 'reserved', brand: 'Public Specialist', model: 'Roadster', region: 'Gulf and Asia'}
]};
const fixture = () => { const DB = localDB(); databases.push(DB); return {DB}; };
const event = (type = 'page_view', path = '/', target = '') => ({id: randomUUID(), type, path, target});
const packet = (...events) => ({visitId: randomUUID(), referrer: '', events});
function request({headers = {}, country = 'GB', cf = country === null ? undefined : {country}} = {}) {
  const value = new Request(origin + '/api/analytics/events', {method: 'POST', headers: {'User-Agent': chrome, 'CF-Connecting-IP': '198.51.100.19', ...headers}});
  if (cf) Object.defineProperty(value, 'cf', {value: cf});
  return value;
}
const collect = (env, input = packet(event()), options) => collectAnalytics({request: request(options), env, input, content, HttpError});
const read = (env, query = '') => readAnalytics(env, new URLSearchParams(query), HttpError);
const count = async (env, table = 'analytics_events') => (await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first()).total;
const rows = async (env, table = 'analytics_events') => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const check = (value, message) => { assert.ok(value, message); checks++; };
async function rejects(fn, status) { await assert.rejects(fn, error => error.status === status); checks++; }
async function insertEvent(env, {at = clock, visitId = randomUUID(), type = 'page_view', path = '/', target = '', country = 'GB', device = 'desktop', browser = 'chrome', source = ''} = {}) {
  await env.DB.prepare('INSERT INTO analytics_events(id,visit_id,at,day,type,path,target,country,device,browser,source) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(randomUUID(), visitId, at, new Date(at * 1000).toISOString().slice(0, 10), type, path, target, country, device, browser, source).run();
}

try {
  const emptyEnv = fixture(), empty = await read(emptyEnv);
  equal(empty.totals, {visits: 0, pageViews: 0, clicks: 0, carViews: 0, regionClicks: 0, brandClicks: 0, enquiries: 0});
  equal(empty.range, {from: '2026-09-30', to: '2026-10-06', days: 7, previousFrom: '2026-09-23', previousTo: '2026-09-29', timezone: 'UTC'});
  equal(empty.trend.length, 7); equal(empty.meta.startedAt, null); equal(empty.meta.comparisonAvailable, false);
  for (const options of [{headers: {DNT: '1'}}, {headers: {'Sec-GPC': '1'}}, {headers: {'User-Agent': 'Googlebot/2.1'}}, {headers: {'User-Agent': 'HeadlessChrome/130'}}, {cf: {country: 'GB', botManagement: {verifiedBot: true}}}]) equal(await collect(emptyEnv, packet(event()), options), {recorded: 0, ignored: 1});
  equal(await count(emptyEnv), 0); equal(await count(emptyEnv, 'analytics_metadata'), 0); equal(await count(emptyEnv, 'analytics_rate_limits'), 0, 'Opt-outs and bots create no tracking state');

  const env = fixture();
  const invalid = [
    null, {}, {...packet(event()), visitId: 'invalid'}, {...packet(event()), events: []}, packet(...Array.from({length: 21}, () => event())),
    {...packet(event()), formText: secret}, {...packet(event()), referrer: 'https://search.test/private?token=secret'},
    {...packet(event()), referrer: 'search.test/path'}, {...packet(event()), referrer: 'person@search.test'},
    {...packet(event()), referrer: 'search.test:443'}, {...packet(event()), referrer: '127.0.0.1'},
    {...packet(event()), referrer: 'localhost'}, {...packet(event()), referrer: 'private.internal'},
    {...packet(event()), referrer: 'bad-.example'}, {...packet(event()), referrer: ' search.test'},
    packet({...event(), id: 'bad'}), packet({...event(), type: 'form_submit'}), packet({...event(), text: secret}),
    packet(event('page_view', '/admin')), packet(event('page_view', '/exclusive')), packet(event('page_view', '/?password=secret')),
    packet({...event(), target: null}), packet({...event(), target: 'x'.repeat(201)})
  ];
  for (const input of invalid) await rejects(() => collect(env, input), 400);
  await rejects(() => collect(env, {...packet(event()), privateText: 'x'.repeat(17000)}), 413);
  equal(await count(env), 0); equal(await count(env, 'analytics_rate_limits'), 0, 'Malformed requests do not create rate buckets');

  const active = packet(event(), event('page_view', '/inventory'), event('car_view', '/inventory', 'porsche-one'), event('region_click', '/', 'Europe'), event('brand_click', '/', 'Bugatti'), event('click', '/', 'gallery'), event('enquiry', '/inventory', 'porsche-one'), event('enquiry', '/contact', 'email'));
  active.referrer = 'WWW.Search.Example.';
  equal(await collect(env, active), {recorded: 8, ignored: 0});
  const startedAt = (await read(env)).meta.startedAt;
  equal(startedAt, '2026-10-06T12:00:00.000Z');
  clock += 1;
  equal(await collect(env, active), {recorded: 0, ignored: 8}, 'Duplicate event UUIDs are idempotent');
  const uppercase = {...active, visitId: active.visitId.toUpperCase(), events: active.events.map(item => ({...item, id: item.id.toUpperCase()}))};
  equal(await collect(env, uppercase), {recorded: 0, ignored: 8}, 'UUID case does not bypass deduplication');
  equal((await read(env)).meta.startedAt, startedAt, 'Collection start persists across retries');
  const repeated = event('click', '/inventory', 'partner');
  equal(await collect(env, packet(repeated, repeated)), {recorded: 1, ignored: 1}, 'Duplicates within one batch count once');
  const stale = packet(event('car_view', '/', 'private-draft'), event('enquiry', '/', 'private-sold'), event('car_view', '/', 'wanted-closed'), event('car_view', '/', 'missing'), event('brand_click', '/', 'SecretBrand'), event('region_click', '/', 'Unpublished region'), event('click', '/', secret), event('page_view', '/', secret));
  equal(await collect(env, stale), {recorded: 0, ignored: 8}, 'Private, stale, or arbitrary targets are ignored');
  equal(await collect(env, packet(event('brand_click', '/', 'Public Specialist'), event('car_view', '/wanted', 'ferrari-wanted'), event('click', '/', 'pause_motion'))), {recorded: 3, ignored: 0});
  let report = await read(env);
  equal(report.totals, {visits: 1, pageViews: 2, clicks: 10, carViews: 2, regionClicks: 1, brandClicks: 2, enquiries: 2}, 'One specialized event contributes one click; click-only loads are not visits');
  equal({...report.cars.find(row => row.id === 'porsche-one')}, {id: 'porsche-one', label: 'Porsche 911 GT3 RS', brand: 'Porsche', region: 'Europe', type: 'inventory', views: 1, enquiries: 1});
  equal(report.cars.find(row => row.id === 'ferrari-wanted').type, 'wanted');
  equal(report.actions.find(row => row.key === 'gallery').clicks, 1);
  equal(report.actions.find(row => row.key === 'email').clicks, 1);
  check(report.brands.some(row => row.key === 'Bugatti'), 'Bundled marques are accepted even without current listings');
  equal(report.sources, [{key: 'search.example', visits: 1, label: 'search.example'}]);
  equal(report.pages.find(row => row.key === '/inventory'), {key: '/inventory', views: 1, clicks: 3, label: 'Inventory'});
  equal(report.countries, [{key: 'GB', visits: 1, pageViews: 2, clicks: 10, label: 'United Kingdom'}]);
  equal(report.trend.at(-1), {date: '2026-10-06', visits: 1, pageViews: 2, clicks: 10, carViews: 2, enquiries: 2});
  check(report.trend.slice(0, -1).every(row => row.visits === 0 && row.clicks === 0), 'Missing dates are zero-filled');
  equal(report.meta.comparisonAvailable, false);
  const stored = JSON.stringify(await rows(env));
  for (const forbidden of [secret, '198.51.100.19', chrome, 'private-draft', 'private-sold', 'wanted-closed', 'WWW.Search.Example']) check(!stored.includes(forbidden), 'Raw request and private listing fields never persist');
  equal(await count(env, 'audit_log'), 0); equal(await count(env, 'audit_delivery'), 0, 'Analytics never enqueues audit or Discord');
  check(ANALYTICS_CLICK_TARGETS.includes('gallery') && ANALYTICS_CLICK_TARGETS.includes('partner'));

  const dimensionEnv = fixture();
  await collect(dimensionEnv, {...packet(event()), referrer: 'www.entity-one.test'}, {country: 'FR', headers: {'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1'}});
  await collect(dimensionEnv, packet(event()), {country: null, headers: {'CF-IPCountry': 'US'}});
  await collect(dimensionEnv, packet(event()), {country: 'AA', headers: {'User-Agent': 'Mozilla/5.0 (Android 14; Mobile) Firefox/130.0'}});
  await collect(dimensionEnv, packet(event()), {country: 'US', headers: {'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Mobile) Chrome/130.0 EdgA/130.0'}});
  await collect(dimensionEnv, packet(event()), {country: 'T1', headers: {'User-Agent': ''}});
  const dimensions = await rows(dimensionEnv);
  equal(dimensions.map(row => [row.country, row.device, row.browser]), [['FR', 'tablet', 'safari'], ['XX', 'desktop', 'chrome'], ['XX', 'mobile', 'firefox'], ['US', 'mobile', 'edge'], ['XX', 'unknown', 'unknown']]);
  equal(dimensions[0].source, '', 'Own origin referrer becomes direct');
  report = await read(dimensionEnv);
  equal(report.countries.find(row => row.key === 'XX').label, 'Unknown');
  equal(report.sources[0], {key: '', visits: 5, label: 'Direct / unknown'});
  equal((await read(dimensionEnv, 'country=FR&device=tablet')).totals.visits, 1);
  equal((await read(dimensionEnv, 'country=XX&device=desktop')).totals.visits, 1);
  equal((await read(dimensionEnv, 'country=US&device=desktop')).totals.visits, 0);

  const history = fixture();
  clock = baseTime - 10 * DAY;
  const oldVisit = randomUUID();
  await collect(history, {visitId: oldVisit, referrer: '', events: [event(), event('click', '/', 'navigation')]});
  clock = baseTime - 3 * DAY;
  await collect(history, {visitId: oldVisit, referrer: '', events: [event()]});
  clock = baseTime;
  await collect(history, {visitId: oldVisit, referrer: '', events: [event()]});
  await collect(history, packet(event()), {country: 'US'});
  report = await read(history);
  equal(report.totals.visits, 2, 'One load ID across multiple days counts once in a period');
  equal(report.totals.pageViews, 3); equal(report.previous.visits, 1); equal(report.previous.clicks, 1);
  equal(report.trend.reduce((sum, row) => sum + row.visits, 0), 3, 'Daily visit totals may exceed distinct visits over the whole period');
  equal(report.meta.comparisonAvailable, false, 'Incomplete previous period suppresses comparisons');
  await history.DB.prepare("UPDATE analytics_metadata SET started_at=? WHERE id='main'").bind(baseTime - 30 * DAY).run();
  equal((await read(history)).meta.comparisonAvailable, true);
  equal((await read(history, 'country=US')).previous.visits, 0, 'Previous period applies the same filters');
  const invalidQueries = ['from=2026-02-30', 'from=not-a-date', 'from=2026-10-07&to=2026-10-06', 'to=2026-10-07', 'from=2026-07-08&to=2026-10-06', 'from=2020-01-01&to=2020-01-02', 'country=AA', 'country=gb', 'country=GB%27OR1=1', 'device=robot'];
  for (const query of invalidQueries) await rejects(() => read(history, query), 400);
  equal((await read(history, 'from=2026-07-09&to=2026-10-06')).range.days, 90);
  const oldestRetained = Date.parse('2026-07-09T00:00:00Z') / 1000;
  await insertEvent(history, {at: oldestRetained - 1});
  await insertEvent(history, {at: oldestRetained});
  const boundedPrevious = await read(history, 'from=2026-07-09&to=2026-07-09');
  equal(boundedPrevious.previous.pageViews, 0, 'Expired rows are excluded from previous reports before cleanup occurs');
  equal(boundedPrevious.totals.pageViews, 1);
  equal(boundedPrevious.meta.comparisonAvailable, false);
  await collect(history);
  equal((await history.DB.prepare('SELECT COUNT(*) AS total FROM analytics_events WHERE at < ?').bind(oldestRetained).first()).total, 0, 'Next collection removes expired event rows');
  equal((await history.DB.prepare('SELECT COUNT(*) AS total FROM analytics_events WHERE at = ?').bind(oldestRetained).first()).total, 1, 'UTC retention boundary remains');
  equal((await read(history)).meta.startedAt, new Date((baseTime - 30 * DAY) * 1000).toISOString(), 'Retention does not reset collection metadata');

  const rateEnv = fixture();
  for (let index = 0; index < 14; index++) await collect(rateEnv, packet(...Array.from({length: 20}, () => event())));
  const raced = await Promise.allSettled([collect(rateEnv, packet(...Array.from({length: 20}, () => event()))), collect(rateEnv, packet(...Array.from({length: 20}, () => event())))]);
  equal(raced.filter(result => result.status === 'fulfilled').length, 1, 'Atomic rate counter cannot be raced above the limit');
  const rejected = raced.find(result => result.status === 'rejected').reason;
  equal(rejected.status, 429); equal(rejected.retryAfter, 60);
  equal(await count(rateEnv), 300);
  const rateRows = await rows(rateEnv, 'analytics_rate_limits');
  equal(rateRows.length, 1); equal(rateRows[0].event_count, 300);
  check(/^[a-f0-9]{64}$/.test(rateRows[0].bucket) && !rateRows[0].bucket.includes('198.51.100.19'));
  equal(rateRows[0].expires, baseTime + 120);
  clock += 60;
  equal((await collect(rateEnv)).recorded, 1);
  equal(await count(rateEnv, 'analytics_rate_limits'), 2, 'Rate hashes rotate each minute');
  clock += 61;
  await collect(rateEnv);
  check((await rows(rateEnv, 'analytics_rate_limits')).every(row => row.expires > clock), 'Expired hash buckets are deleted on new traffic');
  clock = baseTime;
  const bounded = fixture();
  for (let index = 0; index < 55; index++) await insertEvent(bounded, {source: `source${index}.example`});
  report = await read(bounded);
  equal(report.sources.length, 50); equal(report.totals.visits, 55, 'Top-list limits do not truncate totals');
  equal(report.meta.cookieless, true); equal(report.meta.retentionDays, 90);
  console.log(`PASS: ${checks} analytics checks covering validation, public targets, deduplication, privacy, trusted geography, devices, reports, filters, retention, atomic rate limits and no audit delivery.`);
} finally {
  Date.now = originalNow; globalThis.fetch = originalFetch;
  for (const DB of databases) DB.close();
}
