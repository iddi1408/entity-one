import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pbkdf2Sync, randomBytes, createHash} from 'node:crypto';
import {localDB} from './d1-local.mjs';

const source = await readFile('dist/server/index.js', 'utf8');
const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const bundled = JSON.parse(await readFile('.sites-runtime/deploy-assets.json', 'utf8'));
const BUCKET = {async get(key) {
  const asset = bundled.find(item => 'site-assets/' + item.hash === key);
  if (!asset) return null;
  const bytes = await readFile(asset.filename);
  return {body:bytes, size:bytes.length, httpEtag:'"' + asset.hash + '"'};
}};
const worker = module.default, DB = localDB(), env = {DB, BUCKET}, origin = 'https://entity-one.test';
const credentials = {username: 'test-administrator', password: randomBytes(32).toString('base64url')};
const salt = randomBytes(32).toString('hex');
const hash = pbkdf2Sync(credentials.password, salt, 600000, 32, 'sha256').toString('hex');
const sha = value => createHash('sha256').update(value).digest('hex');
const seconds = () => Math.floor(Date.now() / 1000);
async function request(path, method = 'GET', value, extra = {}, targetEnv = env) {
  const headers = {Origin: origin, 'Content-Type': 'application/json', ...extra};
  for (const [name, value] of Object.entries(headers)) if (value === null) delete headers[name];
  const response = await worker.fetch(new Request(origin + path, {method, headers, ...(value === undefined ? {} : {body: JSON.stringify(value)})}), targetEnv, {});
  return {response, data: response.headers.get('Content-Type')?.includes('json') ? await response.json() : null};
}
function access(result) {
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  const cookie = result.response.headers.get('Set-Cookie').split(';')[0];
  return {cookie, csrf: result.data.csrfToken, session: result.data.session, headers: {Cookie: cookie, 'X-CSRF-Token': result.data.csrfToken}};
}
const count = async table => (await DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count;
const login = async extra => access(await request('/api/login', 'POST', credentials, extra));
const sessionRow = auth => DB.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(sha(auth.cookie.split('=')[1])).first();

try {
  for (const route of ['/', '/inventory', '/wanted', '/about', '/contact', '/exclusive', '/admin', '/app.js', '/pages.css', '/assets/chrome-ribbon.png', '/favicon.svg']) assert.equal((await request(route)).response.status, 200, route);
  assert.equal((await request('/missing')).response.status, 404);
  assert.equal((await request('/content.json')).data.settings.github, undefined);
  assert.deepEqual((await request('/api/session')).data, {authenticated: false});
  for (const path of ['/api/setup', '/api/commit']) assert.equal((await request(path, 'POST', {})).response.status, 404);
  for (const path of ['/api/admin/overview', '/api/backups']) assert.equal((await request(path)).response.status, 401);
  const before = (await request('/api/content')).data;
  assert.equal(before.revision, 0);
  assert.equal(before.content.settings.github, undefined);
  assert.ok(before.content.listings.every(item => item.status === (item.type === 'inventory' ? 'available' : 'active')));
  assert.equal((await request('/api/content', 'PUT', {content: before.content, revision: 0})).response.status, 401);
  for (const path of ['/api/backups/restore', '/api/sessions/revoke', '/api/sessions/rotate', '/api/logout']) assert.equal((await request(path, 'POST', {})).response.status, 401);
  assert.equal((await request('/api/login', 'POST', credentials)).response.status, 401, 'No online provisioning');
  assert.equal(module.PASSWORD_VERSION, 'pbkdf2-sha256-600000-v1');
  assert.equal(module.PASSWORD_ITERATIONS, 600000);
  assert.equal(await module.passwordHash(credentials.password, salt), hash, 'Independent Node crypto matches provisioning recipe');
  await DB.prepare('INSERT INTO administrator (id, username, salt, hash, hash_version) VALUES (1, ?, ?, ?, ?)').bind(credentials.username, salt, hash, module.PASSWORD_VERSION).run();
  await assert.rejects(DB.prepare('INSERT INTO administrator (id, username, salt, hash) VALUES (2, ?, ?, ?)').bind('other', salt, hash).run(), /CHECK/);
  const wrongPassword = await request('/api/login', 'POST', {...credentials, password: randomBytes(20).toString('hex')});
  const wrongName = await request('/api/login', 'POST', {...credentials, username: 'unknown-user'});
  assert.equal(wrongPassword.response.status, 401); assert.deepEqual(wrongName.data, wrongPassword.data);
  const initial = await request('/api/login', 'POST', credentials); let auth = access(initial);
  assert.match(initial.response.headers.get('Set-Cookie'), /^__Host-e1=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/);
  assert.match(auth.csrf, /^[a-f0-9]{64}$/); assert.equal(initial.data.canSetup, undefined);
  const storedSession = await sessionRow(auth);
  assert.notEqual(storedSession.token_hash, auth.cookie.split('=')[1]); assert.equal(storedSession.expires - storedSession.created_at, 28800);
  assert.equal((await request('/api/session', 'GET', undefined, auth.headers)).data.authenticated, true);
  assert.equal((await request('/api/session', 'GET', undefined, {Cookie: auth.cookie + '; ' + auth.cookie})).data.authenticated, false, 'Ambiguous duplicate cookie rejected');
  for (const path of ['/api/setup', '/api/commit']) assert.equal((await request(path, 'POST', {}, auth.headers)).response.status, 404);

  const update = {content: structuredClone(before.content), revision: 0};
  for (const originValue of ['https://evil.test', 'null', null]) assert.equal((await request('/api/content', 'PUT', update, {...auth.headers, Origin: originValue})).response.status, 403);
  assert.equal((await request('/api/content', 'PUT', update, {...auth.headers, 'Sec-Fetch-Site': 'cross-site'})).response.status, 403);
  for (const type of ['text/plain', 'application/jsonp', 'application/json; charset=utf-16', null]) assert.equal((await request('/api/content', 'PUT', update, {...auth.headers, 'Content-Type': type})).response.status, 415);
  assert.equal((await request('/api/content', 'PUT', update, {Cookie: auth.cookie})).response.status, 403);
  assert.equal((await request('/api/content', 'PUT', update, {...auth.headers, 'X-CSRF-Token': 'wrong'})).response.status, 403);
  assert.equal((await request('/api/content', 'PUT', [], auth.headers)).response.status, 400);
  assert.equal((await request('/api/content', 'PUT', {padding: '€'.repeat(210000)}, auth.headers)).response.status, 413, 'Byte bound, not character count');
  assert.equal((await request('/api/content', 'PUT', update, {...auth.headers, 'Content-Length': '600001'})).response.status, 413);
  assert.equal((await request('/api/content', 'DELETE', undefined, auth.headers)).response.status, 405);
  const malformed = await worker.fetch(new Request(origin + '/api/content', {method: 'PUT', headers: {Origin: origin, 'Content-Type': 'application/json', ...auth.headers}, body: '{'}), env, {});
  assert.equal(malformed.status, 400);
  const insecure = await worker.fetch(new Request('http://external.example/api/login', {method: 'POST', headers: {Origin: 'http://external.example', 'Content-Type': 'application/json'}, body: JSON.stringify(credentials)}), env, {});
  assert.equal(insecure.status, 403);

  const content = structuredClone(before.content), privateMarker = 'PRIVATE-NOTES-MUST-NOT-LEAK';
  content.settings.headline = '  Verified private collection.  ';
  content.settings.heroHeading = 'Extraordinary automobiles'; content.settings.heroDescription = 'Selected for you';
  content.settings.heroImage = '/assets/chrome-ribbon.png'; content.settings.heroImageAlt = 'Silver sculpture'; content.settings.heroCaption = 'Private access'; content.settings.aboutImage = 'https://example.test/about.jpg';
  content.settings.partners[0].image = '/assets/chrome-ribbon.png';
  content.settings.secretToken = privateMarker; content.settings.socials['<img src=x onerror=alert(1)>'] = privateMarker;
  content.settings.offices[0].privateContact = privateMarker; content.extraSecret = privateMarker;
  content.listings[0].internalNotes = privateMarker; content.listings[0].unknownSecret = privateMarker;
  content.listings[0].gallery = ['/assets/chrome-ribbon.png', 'https://example.test/car.jpg'];
  for (const status of ['reserved', 'sold', 'draft']) content.listings.push({...content.listings[0], id: `test-inventory-${status}`, status});
  const wanted = content.listings.find(item => item.type === 'wanted');
  for (const status of ['fulfilled', 'draft']) content.listings.push({...wanted, id: `test-wanted-${status}`, status, internalNotes: privateMarker});
  const saved = await request('/api/content', 'PUT', {content, revision: 0}, auth.headers);
  assert.equal(saved.response.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.revision, 1);
  const publicView = (await request('/api/content')).data.content;
  assert.equal(publicView.settings.headline, 'Verified private collection.');
  assert.ok(publicView.listings.some(item => item.id === 'test-inventory-reserved'));
  assert.ok(publicView.listings.every(item => !['draft', 'sold', 'fulfilled'].includes(item.status)));
  assert.ok(!JSON.stringify(publicView).includes(privateMarker));
  assert.equal(publicView.settings.secretToken, undefined); assert.equal(publicView.extraSecret, undefined);
  assert.equal(Object.keys(publicView.settings.socials).length, 5); assert.equal(publicView.settings.offices[0].privateContact, undefined);
  const adminView = (await request('/api/content', 'GET', undefined, auth.headers)).data;
  assert.equal(adminView.content.listings[0].internalNotes, privateMarker);
  assert.equal(adminView.content.listings[0].unknownSecret, undefined); assert.equal(adminView.content.settings.secretToken, undefined);
  assert.equal(adminView.content.listings.length, content.listings.length); assert.equal(adminView.content.listings[0].gallery.length, 2);
  // Older/imported DB bodies also cross the allowlist on reads, not just on new saves.
  await DB.prepare("UPDATE site_content SET body = ? WHERE id = 'main'").bind(JSON.stringify(content)).run();
  assert.ok(!JSON.stringify((await request('/api/content')).data).includes(privateMarker));
  assert.equal((await request('/api/content', 'GET', undefined, auth.headers)).data.content.settings.secretToken, undefined);
  assert.equal((await request('/api/content', 'PUT', {content, revision: 0}, auth.headers)).response.status, 409);
  let overview = (await request('/api/admin/overview', 'GET', undefined, auth.headers)).data;
  assert.equal(overview.counts.inventory.sold, 1); assert.equal(overview.counts.inventory.draft, 1); assert.equal(overview.counts.wanted.fulfilled, 1);
  assert.equal(overview.lastSave.revision, 1); assert.equal(overview.activeSessions.length, 1); assert.equal(overview.activeSessions[0].current, true);
  assert.ok(!JSON.stringify(overview).includes(privateMarker));
  const backups = (await request('/api/backups', 'GET', undefined, auth.headers)).data.backups;
  assert.equal(backups.length, 1); assert.equal(backups[0].revision, 0); assert.equal(backups[0].body, undefined);
  assert.equal((await request('/api/backups/restore', 'POST', {backupRevision: 0, revision: 0}, auth.headers)).response.status, 409);
  assert.equal((await request('/api/backups/restore', 'POST', {backupRevision: 999, revision: 1}, auth.headers)).response.status, 404);
  const restored = await request('/api/backups/restore', 'POST', {backupRevision: 0, revision: 1}, auth.headers);
  assert.equal(restored.response.status, 200); assert.equal(restored.data.revision, 2);
  assert.deepEqual((await request('/api/content')).data.content, before.content, 'Restore produces a new revision containing the old public content');
  assert.equal((await request('/api/backups', 'GET', undefined, auth.headers)).data.backups[0].revision, 1);
  overview = (await request('/api/admin/overview', 'GET', undefined, auth.headers)).data;
  assert.deepEqual(overview.recentAudit.find(event => event.action === 'content.restore').detail, {revision: 2, restoredFrom: 0});

  for (const change of [
    c => { c.settings.heroVideo = 'javascript:alert(1)'; },
    c => { c.settings.heroImage = '/assets/../secret'; },
    c => { c.settings.heroImageAlt = 'x'.repeat(201); },
    c => { c.listings[0].gallery = Array(13).fill('/assets/car.jpg'); },
    c => { c.listings[0].gallery = ['http://example.test/car.jpg']; },
    c => { c.listings[0].status = 'active'; },
    c => { c.listings.push({...c.listings[0]}); }
  ]) {
    const invalid = structuredClone(before.content); change(invalid);
    assert.equal((await request('/api/content', 'PUT', {content: invalid, revision: 2}, auth.headers)).response.status, 400);
  }
  assert.equal((await request('/api/content')).data.revision, 2);

  // The CMS supports adding/removing records within explicit limits.
  const flexible = structuredClone(before.content);
  flexible.settings.offices = [flexible.settings.offices[0]];
  flexible.settings.members = []; flexible.settings.partners = [];
  assert.equal((await request('/api/content', 'PUT', {content: flexible, revision: 2}, auth.headers)).response.status, 200);
  const flexibleSaved = (await request('/api/content', 'GET', undefined, auth.headers)).data.content;
  assert.equal(flexibleSaved.settings.offices.length, 1); assert.equal(flexibleSaved.settings.members.length, 0); assert.equal(flexibleSaved.settings.partners.length, 0);
  for (const [key, amount] of [['offices', 0], ['offices', 13], ['members', 25], ['partners', 25]]) {
    const invalid = structuredClone(before.content); invalid.settings[key] = Array.from({length: amount}, () => ({...before.content.settings[key][0]}));
    assert.equal((await request('/api/content', 'PUT', {content: invalid, revision: 3}, auth.headers)).response.status, 400);
  }
  const maximum = structuredClone(before.content);
  for (const [key, amount] of [['offices', 12], ['members', 24], ['partners', 24]]) maximum.settings[key] = Array.from({length: amount}, () => ({...before.content.settings[key][0]}));
  assert.equal((await request('/api/content', 'PUT', {content: maximum, revision: 3}, auth.headers)).response.status, 200);

  // Simulate a second writer committing between the read and the compare-and-swap.
  const auditCount = await count('audit_log'), backupCount = await count('content_backups');
  const racingDB = {...DB, async batch(statements) {
    await DB.prepare("UPDATE site_content SET revision = revision + 1 WHERE id = 'main'").run();
    return DB.batch(statements);
  }};
  assert.equal((await request('/api/content', 'PUT', {content: before.content, revision: 4}, auth.headers, {DB: racingDB})).response.status, 409);
  assert.equal(await count('audit_log'), auditCount); assert.equal(await count('content_backups'), backupCount);
  assert.equal((await request('/api/content')).data.revision, 5);
  // A downstream failure must roll back content, audit, and backup together.
  await DB.prepare("CREATE TRIGGER fail_backup BEFORE INSERT ON content_backups BEGIN SELECT RAISE(ABORT, 'test rollback'); END").run();
  const previousError = console.error; console.error = () => {};
  try { assert.equal((await request('/api/content', 'PUT', {content: before.content, revision: 5}, auth.headers)).response.status, 503); }
  finally { console.error = previousError; }
  await DB.prepare('DROP TRIGGER fail_backup').run();
  assert.equal((await request('/api/content')).data.revision, 5); assert.equal(await count('audit_log'), auditCount); assert.equal(await count('content_backups'), backupCount);
  for (let currentRevision = 5; currentRevision < 26; currentRevision++) {
    const result = await request('/api/content', 'PUT', {content: before.content, revision: currentRevision}, auth.headers);
    assert.equal(result.data.revision, currentRevision + 1);
  }
  const retained = (await request('/api/backups', 'GET', undefined, auth.headers)).data.backups;
  assert.equal(retained.length, 20); assert.equal(retained[0].revision, 25); assert.equal(retained.at(-1).revision, 6);
  assert.equal((await request('/api/backups/restore', 'POST', {backupRevision: 0, revision: 26}, auth.headers)).response.status, 404);

  // Exercise actual overlapping requests through the local adapter, not only a simulated CAS race.
  const concurrentDB = localDB();
  try {
    await concurrentDB.prepare('INSERT INTO administrator (id, username, salt, hash, hash_version) VALUES (1, ?, ?, ?, ?)').bind(credentials.username, salt, hash, module.PASSWORD_VERSION).run();
    const concurrentEnv = {DB: concurrentDB};
    const concurrentAuth = access(await request('/api/login', 'POST', credentials, {}, concurrentEnv));
    const firstWrites = await Promise.all([
      request('/api/content', 'PUT', {content: before.content, revision: 0}, concurrentAuth.headers, concurrentEnv),
      request('/api/content', 'PUT', {content: before.content, revision: 0}, concurrentAuth.headers, concurrentEnv)
    ]);
    assert.deepEqual(firstWrites.map(result => result.response.status).sort(), [200, 409]);
    const nextWrites = await Promise.all([
      request('/api/content', 'PUT', {content: before.content, revision: 1}, concurrentAuth.headers, concurrentEnv),
      request('/api/content', 'PUT', {content: before.content, revision: 1}, concurrentAuth.headers, concurrentEnv)
    ]);
    assert.deepEqual(nextWrites.map(result => result.response.status).sort(), [200, 409]);
    assert.equal((await concurrentDB.prepare('SELECT COUNT(*) AS count FROM content_backups').first()).count, 2);
    assert.equal((await concurrentDB.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'content.save'").first()).count, 2);
  } finally { concurrentDB.close(); }

  const second = await login();
  assert.equal((await request('/api/admin/overview', 'GET', undefined, auth.headers)).data.activeSessions.length, 2);
  assert.equal((await request('/api/sessions/revoke', 'POST', {}, auth.headers)).data.revoked, 1);
  assert.equal((await request('/api/session', 'GET', undefined, second.headers)).data.authenticated, false);
  assert.equal((await request('/api/session', 'GET', undefined, auth.headers)).data.authenticated, true);
  const oldAuth = auth; auth = access(await request('/api/sessions/rotate', 'POST', {}, auth.headers));
  assert.notEqual(auth.cookie, oldAuth.cookie); assert.notEqual(auth.csrf, oldAuth.csrf);
  assert.equal(auth.session.expiresAt, oldAuth.session.expiresAt, 'Rotation cannot extend absolute lifetime');
  assert.equal((await request('/api/session', 'GET', undefined, oldAuth.headers)).data.authenticated, false);
  for (const path of ['/api/sessions/rotate', '/api/content', '/api/sessions/revoke']) {
    const revokedDuringRequest = await login(), auditBeforeRace = await count('audit_log'), backupsBeforeRace = await count('content_backups');
    const revokingDB = {...DB, async batch(statements) {
      await DB.prepare('DELETE FROM sessions WHERE session_id = ?').bind(revokedDuringRequest.session.id).run();
      return DB.batch(statements);
    }};
    const result = await request(path, path === '/api/content' ? 'PUT' : 'POST', path === '/api/content' ? {content: before.content, revision: 26} : {}, revokedDuringRequest.headers, {DB: revokingDB});
    assert.equal(result.response.status, 401, 'In-flight requests cannot undo revocation');
    assert.equal(await count('sessions'), 1); assert.equal(await count('audit_log'), auditBeforeRace); assert.equal(await count('content_backups'), backupsBeforeRace);
    assert.equal((await request('/api/content')).data.revision, 26);
  }
  const previous = auth; auth = await login({Cookie: auth.cookie});
  assert.equal((await request('/api/session', 'GET', undefined, previous.headers)).data.authenticated, false, 'Login rotates presented session');
  const absoluteDeadline = auth.session.expiresAt;
  await DB.prepare('UPDATE sessions SET last_seen = ? WHERE session_id = ?').bind(seconds() - 60, auth.session.id).run();
  const touched = (await request('/api/session', 'GET', undefined, auth.headers)).data.session;
  assert.ok(touched.lastSeen >= seconds() - 2); assert.equal(touched.expiresAt, absoluteDeadline);
  await DB.prepare('UPDATE sessions SET last_seen = ? WHERE session_id = ?').bind(seconds() - 1801, auth.session.id).run();
  assert.equal((await request('/api/session', 'GET', undefined, auth.headers)).data.authenticated, false, 'Idle expiry');
  auth = await login();
  await DB.prepare('UPDATE sessions SET expires = ? WHERE session_id = ?').bind(seconds() - 1, auth.session.id).run();
  assert.equal((await request('/api/session', 'GET', undefined, auth.headers)).data.authenticated, false, 'Absolute expiry');
  auth = await login();
  await DB.prepare("UPDATE administrator SET hash = 'credential-change' WHERE id = 1").run();
  assert.equal((await request('/api/session', 'GET', undefined, auth.headers)).data.authenticated, false, 'Credential changes revoke sessions');
  await DB.prepare('UPDATE administrator SET hash = ? WHERE id = 1').bind(hash).run();
  auth = await login();
  const loggedOut = await request('/api/logout', 'POST', {}, auth.headers);
  assert.equal(loggedOut.data.authenticated, false); assert.match(loggedOut.response.headers.get('Set-Cookie'), /Max-Age=0; Secure$/);
  assert.equal((await request('/api/session', 'GET', undefined, auth.headers)).data.authenticated, false);
  const auditRows = (await DB.prepare('SELECT action, detail, session_id FROM audit_log').all()).results;
  for (const event of ['login.failed', 'login.succeeded', 'content.save', 'content.restore', 'sessions.revoked', 'session.rotated', 'session.expired', 'session.logged_out']) assert.ok(auditRows.some(row => row.action === event), event);
  for (const sensitive of [credentials.password, salt, hash, auth.csrf, auth.cookie.split('=')[1], privateMarker]) assert.ok(!JSON.stringify(auditRows).includes(sensitive), 'Audit must not contain secrets');

  await DB.prepare('DELETE FROM rate_limits').run();
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await request('/api/login', 'POST', {...credentials, password: 'invalid-test-only'})).response.status, 401);
  const limited = await request('/api/login', 'POST', credentials);
  assert.equal(limited.response.status, 429); assert.equal(limited.response.headers.get('Retry-After'), '900');
  await DB.prepare('DELETE FROM rate_limits').run();
  await DB.prepare('INSERT INTO rate_limits (bucket, attempts, expires) VALUES (?, ?, ?)').bind('login:administrator', 40, seconds() + 900).run();
  assert.equal((await request('/api/login', 'POST', credentials, {'CF-Connecting-IP': '198.51.100.9'})).response.status, 429, 'Global single-account limit survives IP changes');
  console.log('PASS: password-only fixed administrator, PBKDF2 recipe, secure cookies, CSRF/origin/body bounds, public allowlists/status filtering, atomic optimistic saves, backup restore/retention/rollback, safe audit, rotation/revocation/expiry and login limits.');
} finally { DB.close(); }
