import {brandAssets} from '../public/brand-assets.js';

const DAY = 86400, RETENTION = 90, MAX_EVENTS = 20, RATE_LIMIT = 300;
const PATHS = new Map([['/', 'Home'], ['/inventory', 'Inventory'], ['/wanted', 'Wanted'], ['/about', 'About'], ['/contact', 'Contact']]);
const TYPES = new Set(['page_view', 'click', 'car_view', 'region_click', 'brand_click', 'enquiry']);
const REGIONS = new Set(['America', 'Europe', 'Gulf and Asia']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COUNTRIES = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
const DEVICES = new Set(['desktop', 'mobile', 'tablet', 'unknown']);
export const ANALYTICS_CLICK_TARGETS = Object.freeze(['navigation', 'inventory', 'wanted', 'about', 'contact', 'browse_inventory', 'browse_wanted', 'view_all_inventory', 'view_all_wanted', 'social_instagram', 'social_tiktok', 'social_x', 'social_linkedin', 'social_reddit', 'outbound_instagram', 'outbound_tiktok', 'outbound_x', 'outbound_linkedin', 'outbound_reddit', 'email', 'phone', 'whatsapp', 'copy_link', 'share', 'pause_motion', 'resume_motion', 'partner', 'gallery']);
const CLICKS = new Set(ANALYTICS_CLICK_TARGETS), ENQUIRIES = new Set(['contact', 'email', 'phone', 'whatsapp']);
const BOT = /bot\b|spider|crawler|headlesschrome|lighthouse|pagespeed|slurp|facebookexternalhit|bingpreview|curl\/|wget\/|python-requests|uptimerobot/i;
const now = () => Math.floor(Date.now() / 1000);
const date = timestamp => new Date(timestamp * 1000).toISOString().slice(0, 10);
const start = timestamp => Math.floor(timestamp / DAY) * DAY;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');

function agentDimensions(ua) {
  const device = !ua ? 'unknown' : /ipad|tablet|kindle|silk|playbook|android(?!.*mobile)/i.test(ua) ? 'tablet' : /mobi|iphone|ipod|android|windows phone/i.test(ua) ? 'mobile' : /windows|macintosh|x11|linux|cros/i.test(ua) ? 'desktop' : 'unknown';
  const browser = /edg(?:e|a|ios)?\//i.test(ua) ? 'edge' : /opr\/|opera/i.test(ua) ? 'opera' : /samsungbrowser\//i.test(ua) ? 'samsung' : /firefox\/|fxios\//i.test(ua) ? 'firefox' : /chrome\/|crios\//i.test(ua) ? 'chrome' : /safari\//i.test(ua) ? 'safari' : 'unknown';
  return {device, browser};
}
function sourceHostname(value, request, HttpError) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 253 || value !== value.trim() || !/^[A-Za-z0-9.-]+$/.test(value)) throw new HttpError(400, 'Referrer must be a hostname only.');
  const host = value.toLowerCase().replace(/\.$/, ''), labels = host.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels.at(-1)) || /(?:^|\.)(localhost|local|internal)$/.test(host)) throw new HttpError(400, 'Referrer must be a public hostname.');
  const normalized = host.replace(/^www\./, '');
  return normalized === new URL(request.url).hostname.toLowerCase().replace(/^www\./, '') ? '' : normalized;
}
function publicListings(content) {
  return (content?.listings || []).filter(listing => listing && (listing.type === 'inventory' ? ['available', 'reserved'].includes(listing.status ?? 'available') : listing.type === 'wanted' && (listing.status ?? 'active') === 'active'));
}
function preparedEvent(event, listings, brands) {
  let target = event.target, car = null;
  if (event.type === 'page_view') { if (target !== '') return null; }
  else if (event.type === 'click') { if (!CLICKS.has(target)) return null; }
  else if (event.type === 'region_click') { if (!REGIONS.has(target)) return null; }
  else if (event.type === 'brand_click') { if (!brands.has(target)) return null; }
  else if (event.type === 'car_view' || event.type === 'enquiry') {
    car = listings.get(target);
    if (!car && !(event.type === 'enquiry' && ENQUIRIES.has(target))) return null;
  }
  return {id: event.id.toLowerCase(), type: event.type, path: event.path, target, carLabel: car ? `${car.brand} ${car.model}`.slice(0, 300) : '', carBrand: car?.brand || '', carRegion: car?.region || '', carType: car?.type || ''};
}

/** Caller enforces same-origin JSON and excludes authenticated sessions before invoking. */
export async function collectAnalytics({request, env, input, content, HttpError}) {
  const ua = (request.headers.get('User-Agent') || '').slice(0, 1024);
  if (request.headers.get('DNT') === '1' || request.headers.get('Sec-GPC') === '1' || request.cf?.botManagement?.verifiedBot || BOT.test(ua)) return {recorded: 0, ignored: Array.isArray(input?.events) ? Math.min(MAX_EVENTS, input.events.length) : 0};
  let length;
  try { length = new TextEncoder().encode(JSON.stringify(input)).length; } catch { throw new HttpError(400, 'Invalid analytics payload.'); }
  if (length > 16384) throw new HttpError(413, 'Analytics payload is too large.');
  if (!keys(input, ['visitId', 'referrer', 'events']) || !UUID.test(input.visitId || '') || !Array.isArray(input.events) || !input.events.length || input.events.length > MAX_EVENTS) throw new HttpError(400, 'Invalid analytics payload.');
  const source = sourceHostname(input.referrer, request, HttpError);
  for (const event of input.events) if (!keys(event, ['id', 'type', 'path', 'target']) || !UUID.test(event.id || '') || !TYPES.has(event.type) || !PATHS.has(event.path) || typeof event.target !== 'string' || event.target.length > 200) throw new HttpError(400, 'Invalid analytics event.');
  const time = now(), day = date(time), minute = Math.floor(time / 60), visitId = input.visitId.toLowerCase();
  const ip = (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 80);
  const bucket = await digest(`analytics:${day}:${minute}:${ip}`);
  const budget = await env.DB.prepare('INSERT INTO analytics_rate_limits (bucket, event_count, expires) VALUES (?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET event_count = event_count + excluded.event_count WHERE event_count + excluded.event_count <= ? RETURNING event_count').bind(bucket, input.events.length, time + 120, RATE_LIMIT).first();
  if (!budget) { const error = new HttpError(429, 'Analytics event limit reached.'); error.retryAfter = 60; throw error; }
  const listings = new Map(publicListings(content).map(listing => [listing.id, listing]));
  const brands = new Set([...brandAssets.map(brand => brand.name), ...[...listings.values()].map(listing => listing.brand)]);
  const accepted = input.events.map(event => preparedEvent(event, listings, brands)).filter(Boolean);
  const country = COUNTRIES.has(request.cf?.country) ? request.cf.country : 'XX';
  const {device, browser} = agentDimensions(ua);
  const statements = [
    env.DB.prepare('DELETE FROM analytics_events WHERE at < ?').bind(start(time) - (RETENTION - 1) * DAY),
    env.DB.prepare('DELETE FROM analytics_rate_limits WHERE expires <= ?').bind(time)
  ];
  if (accepted.length) statements.push(env.DB.prepare("INSERT OR IGNORE INTO analytics_metadata (id, started_at) VALUES ('main', ?)").bind(time));
  const offset = statements.length;
  for (const event of accepted) statements.push(env.DB.prepare('INSERT OR IGNORE INTO analytics_events (id, visit_id, at, day, type, path, target, country, device, browser, source, car_label, car_brand, car_region, car_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(event.id, visitId, time, day, event.type, event.path, event.target, country, device, browser, source, event.carLabel, event.carBrand, event.carRegion, event.carType));
  const results = await env.DB.batch(statements);
  const recorded = results.slice(offset).reduce((sum, result) => sum + result.meta.changes, 0);
  return {recorded, ignored: input.events.length - recorded};
}

function parseDate(value, HttpError) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'Choose dates in YYYY-MM-DD format.');
  const timestamp = Date.parse(value + 'T00:00:00Z') / 1000;
  if (!Number.isFinite(timestamp) || date(timestamp) !== value) throw new HttpError(400, 'Choose valid calendar dates.');
  return timestamp;
}
const TOTALS = "COUNT(DISTINCT CASE WHEN type = 'page_view' THEN visit_id END) AS visits, SUM(type = 'page_view') AS pageViews, SUM(type <> 'page_view') AS clicks, SUM(type = 'car_view') AS carViews, SUM(type = 'region_click') AS regionClicks, SUM(type = 'brand_click') AS brandClicks, SUM(type = 'enquiry') AS enquiries";
const numeric = row => Object.fromEntries(['visits', 'pageViews', 'clicks', 'carViews', 'regionClicks', 'brandClicks', 'enquiries'].map(key => [key, Number(row?.[key] || 0)]));
const label = key => key.replace(/_/g, ' ').replace(/\b[a-z]/g, character => character.toUpperCase());
const socialNames = {instagram: 'Instagram', tiktok: 'TikTok', x: 'X', linkedin: 'LinkedIn', reddit: 'Reddit'};
function actionLabel(key) {
  const match = /^(outbound|social)_(instagram|tiktok|x|linkedin|reddit)$/.exec(key);
  return match ? `${socialNames[match[2]]} ${match[1] === 'outbound' ? 'link clicks' : 'icon (legacy)'}` : label(key);
}
const browserLabels = {chrome: 'Chrome', safari: 'Safari', firefox: 'Firefox', edge: 'Edge', opera: 'Opera', samsung: 'Samsung Internet', unknown: 'Unknown'};
let regionNames;
function countryLabel(country) { if (country === 'XX') return 'Unknown'; try { regionNames ||= new Intl.DisplayNames(['en'], {type: 'region'}); return regionNames.of(country); } catch { return country; } }

export async function readAnalytics(env, searchParams = new URLSearchParams(), HttpError) {
  const generated = now(), today = start(generated), to = searchParams.get('to') ? parseDate(searchParams.get('to'), HttpError) : today;
  const from = searchParams.get('from') ? parseDate(searchParams.get('from'), HttpError) : to - 6 * DAY;
  const days = (to - from) / DAY + 1;
  const cutoff = today - (RETENTION - 1) * DAY;
  if (days < 1 || days > RETENTION || to > today || from < cutoff) throw new HttpError(400, 'Choose a range within the most recent 90 days.');
  const previousFrom = from - days * DAY, previousTo = from - DAY;
  const conditions = [], filters = [];
  const country = searchParams.get('country'), device = searchParams.get('device');
  if (country) { if (country !== 'XX' && !COUNTRIES.has(country)) throw new HttpError(400, 'Choose a valid country.'); conditions.push('country = ?'); filters.push(country); }
  if (device) { if (!DEVICES.has(device)) throw new HttpError(400, 'Choose a valid device.'); conditions.push('device = ?'); filters.push(device); }
  const extra = conditions.length ? ' AND ' + conditions.join(' AND ') : '';
  const where = 'at >= ? AND at < ?' + extra;
  const params = [from, to + DAY, ...filters];
  const all = async (sql, values = params) => (await env.DB.prepare(sql).bind(...values).all()).results;
  // Attribute each selected visit exactly once. Totals, coverage and the top sources
  // use one database snapshot, including when traffic arrives while a report loads.
  const sourceCounts = `WITH first_views AS (SELECT source, ROW_NUMBER() OVER (PARTITION BY visit_id ORDER BY at, id) AS position FROM analytics_events WHERE ${where} AND type = 'page_view'), source_counts AS (SELECT source AS key, COUNT(*) AS visits FROM first_views WHERE position = 1 GROUP BY source)`;
  const [totalsRow, previousRow, daily, countries, devices, browsers, pages, cars, regions, brands, actions, metadata] = await Promise.all([
    env.DB.prepare(`${sourceCounts} SELECT ${TOTALS}, (SELECT COALESCE(SUM(visits), 0) FROM source_counts WHERE key <> '') AS source_known_visits, (SELECT COALESCE(SUM(visits), 0) FROM source_counts WHERE key = '') AS source_unknown_visits, (SELECT json_group_array(json_object('key', key, 'visits', visits)) FROM (SELECT key, visits FROM source_counts ORDER BY visits DESC, key LIMIT 50)) AS sources FROM analytics_events WHERE ${where}`).bind(...params, ...params).first(),
    env.DB.prepare(`SELECT ${TOTALS} FROM analytics_events WHERE ${where}`).bind(Math.max(previousFrom, cutoff), from, ...filters).first(),
    all(`SELECT day AS date, ${TOTALS} FROM analytics_events WHERE ${where} GROUP BY day ORDER BY day`),
    all(`SELECT country AS key, COUNT(DISTINCT CASE WHEN type = 'page_view' THEN visit_id END) AS visits, SUM(type = 'page_view') AS pageViews, SUM(type <> 'page_view') AS clicks FROM analytics_events WHERE ${where} GROUP BY country ORDER BY visits DESC, pageViews DESC, country LIMIT 100`),
    all(`SELECT device AS key, COUNT(DISTINCT visit_id) AS visits FROM analytics_events WHERE ${where} AND type = 'page_view' GROUP BY device ORDER BY visits DESC, device LIMIT 10`),
    all(`SELECT browser AS key, COUNT(DISTINCT visit_id) AS visits FROM analytics_events WHERE ${where} AND type = 'page_view' GROUP BY browser ORDER BY visits DESC, browser LIMIT 20`),
    all(`SELECT path AS key, SUM(type = 'page_view') AS views, SUM(type <> 'page_view') AS clicks FROM analytics_events WHERE ${where} GROUP BY path ORDER BY views DESC, clicks DESC, path LIMIT 10`),
    all(`SELECT target AS id, MAX(car_label) AS label, MAX(car_brand) AS brand, MAX(car_region) AS region, MAX(car_type) AS type, SUM(type = 'car_view') AS views, SUM(type = 'enquiry') AS enquiries FROM analytics_events WHERE ${where} AND car_type <> '' AND type IN ('car_view','enquiry') GROUP BY target ORDER BY views DESC, enquiries DESC, target LIMIT 50`),
    all(`SELECT target AS key, COUNT(*) AS clicks FROM analytics_events WHERE ${where} AND type = 'region_click' GROUP BY target ORDER BY clicks DESC, target LIMIT 10`),
    all(`SELECT target AS key, COUNT(*) AS clicks FROM analytics_events WHERE ${where} AND type = 'brand_click' GROUP BY target ORDER BY clicks DESC, target LIMIT 50`),
    all(`SELECT target AS key, COUNT(*) AS clicks FROM analytics_events WHERE ${where} AND (type = 'click' OR (type = 'enquiry' AND car_type = '')) GROUP BY target ORDER BY clicks DESC, target LIMIT 50`),
    env.DB.prepare("SELECT (SELECT started_at FROM analytics_metadata WHERE id = 'main') AS started_at, (SELECT MAX(at) FROM analytics_events) AS last_event_at").first()
  ]);
  const sources = JSON.parse(totalsRow.sources || '[]');
  const startedAt = Number.isSafeInteger(metadata?.started_at) ? metadata.started_at : null;
  const firstCompleteDay = startedAt === null ? null : start(startedAt) + (startedAt % DAY === 0 ? 0 : DAY);
  let comparisonUnavailableReason = '';
  if (to === today) comparisonUnavailableReason = 'The selected period includes today, which is not yet complete in UTC.';
  else if (previousFrom < cutoff) comparisonUnavailableReason = 'The previous period falls outside the retained 90 days.';
  else if (firstCompleteDay === null || previousFrom < start(startedAt)) comparisonUnavailableReason = 'There is not enough complete collection history for the previous period.';
  else if (previousFrom < firstCompleteDay) comparisonUnavailableReason = 'The previous period includes the first, incomplete day of collection.';
  const byDate = new Map(daily.map(row => [row.date, numeric(row)]));
  const trend = Array.from({length: days}, (_, index) => { const key = date(from + index * DAY), item = byDate.get(key) || numeric(null); return {date: key, visits: item.visits, pageViews: item.pageViews, clicks: item.clicks, carViews: item.carViews, enquiries: item.enquiries}; });
  return {
    range: {from: date(from), to: date(to), days, previousFrom: date(previousFrom), previousTo: date(previousTo), timezone: 'UTC'},
    totals: numeric(totalsRow), previous: numeric(previousRow), trend,
    countries: countries.map(row => ({...row, label: countryLabel(row.key)})), devices: devices.map(row => ({...row, label: label(row.key)})), browsers: browsers.map(row => ({...row, label: browserLabels[row.key] || 'Unknown'})), sources: sources.map(row => ({...row, label: row.key || 'Not shared / direct'})),
    pages: pages.map(row => ({...row, label: PATHS.get(row.key) || row.key})), cars,
    regions: regions.map(row => ({...row, label: row.key})), brands: brands.map(row => ({...row, label: row.key})), actions: actions.map(row => ({...row, label: actionLabel(row.key)})),
    meta: {startedAt: startedAt === null ? null : new Date(startedAt * 1000).toISOString(), generatedAt: new Date(generated * 1000).toISOString(), lastEventAt: Number.isSafeInteger(metadata?.last_event_at) ? new Date(metadata.last_event_at * 1000).toISOString() : null, sourceKnownVisits: Number(totalsRow.source_known_visits), sourceUnknownVisits: Number(totalsRow.source_unknown_visits), retentionDays: RETENTION, cookieless: true, comparisonAvailable: !comparisonUnavailableReason, comparisonUnavailableReason}
  };
}
