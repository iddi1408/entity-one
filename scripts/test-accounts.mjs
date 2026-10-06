import assert from 'node:assert/strict';
import {randomBytes, createHash, pbkdf2Sync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {localDB} from './d1-local.mjs';
import {PERMISSIONS, ROLES, can, publicUser, getAccount, findAccount, handleAccountRoutes} from '../worker/accounts.js';
import {PASSWORD_VERSION} from '../worker/password.js';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const now = () => Math.floor(Date.now() / 1000);
const random = () => randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const rolePermissions = id => [...ROLES.find(role => role.id === id).permissions];
const db = localDB(), env = {DB: db};
const ownerRecord = {username: 'TestOwner', salt: random(), hash: random(), hash_version: PASSWORD_VERSION};
await db.prepare('INSERT INTO administrator (id,username,salt,hash,hash_version) VALUES (1,?,?,?,?)').bind(ownerRecord.username, ownerRecord.salt, ownerRecord.hash, ownerRecord.hash_version).run();
async function sessionFor(id) {
  const admin = await getAccount(env, id), time = now(), tokenHash = random(), session_id = random();
  const version = hash(`${admin.salt}:${admin.hash}:${admin.hash_version}`);
  await db.prepare('INSERT INTO sessions (token_hash,session_id,created_at,last_seen,expires,credential_version,user_id) VALUES (?,?,?,?,?,?,?)').bind(tokenHash, session_id, time, time, time + 3600, version, id).run();
  return {admin, tokenHash, row: {session_id}};
}
async function seedUser(username, role = 'viewer', permissions = rolePermissions(role), flags = {}) {
  const id = crypto.randomUUID(), time = now();
  await db.prepare('INSERT INTO staff_users (id,username,role,permissions,salt,hash,hash_version,must_change_password,disabled,created_at,updated_at,temp_expires_at) VALUES (?,?,?,?,?,?,?, ?,?,?,?,NULL)').bind(id, username, role, JSON.stringify(permissions), random(), random(), PASSWORD_VERSION, flags.mustChange ?? 0, flags.disabled ?? 0, time, time).run();
  return getAccount(env, id);
}
async function invoke(session, method, path, input = {}, options = {}) {
  const request = new Request('https://example.test' + path, {method, headers: {'Content-Type': 'application/json', Origin: 'https://example.test'}, ...(['GET', 'HEAD'].includes(method) ? {} : {body: JSON.stringify(input)})});
  try {
    const response = await handleAccountRoutes({request, env: options.env || env, path, session,
      body: async (request, limit) => { assert.equal(limit, 16384); if (options.afterBody) await options.afterBody(); return request.json(); },
      json: (data, status = 200) => new Response(JSON.stringify(data), {status}), HttpError});
    return response ? {status: response.status, data: await response.json()} : null;
  } catch (error) { if (error instanceof HttpError) return {status: error.status}; throw error; }
}
async function auditCount() { return (await db.prepare('SELECT COUNT(*) AS count FROM audit_log').first()).count; }
async function sessionsCount(id) { return (await db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').bind(id).first()).count; }

try {
  const owner = await getAccount(env, 'owner'), ownerSession = await sessionFor('owner');
  assert.deepEqual(await findAccount(env, 'testowner'), owner);
  assert.equal(owner.id, 'owner'); assert.equal(owner.role, 'owner');
  assert.ok(PERMISSIONS.every(permission => can(owner, permission.id)));
  assert.equal(can(owner, 'unknown'), false); assert.equal(can(null, 'content.read'), false);
  assert.deepEqual(Object.keys(publicUser(owner)).sort(), ['id','username','role','permissions','mustChangePassword','disabled','createdAt','updatedAt','tempExpiresAt'].sort());
  assert.equal(await invoke(null, 'GET', '/unrelated'), null);
  assert.equal((await invoke(null, 'GET', '/api/users')).status, 401);
  const viewer = await seedUser('viewer'), viewerSession = await sessionFor(viewer.id);
  assert.equal((await invoke(viewerSession, 'GET', '/api/users')).status, 403);
  const temporary = await seedUser('temporary', 'admin', rolePermissions('admin'), {mustChange: 1});
  assert.equal((await invoke(await sessionFor(temporary.id), 'GET', '/api/users')).status, 403);
  const disabled = await seedUser('disabled', 'admin', rolePermissions('admin'), {disabled: 1});
  assert.equal((await invoke(await sessionFor(disabled.id), 'GET', '/api/users')).status, 401);

  for (const input of [
    {username: 'testowner'}, {username: 'VIEWER'}, {username: 'bad name'},
    {username: 'bad\0name'}, {username: 'ok', permissions: ['secrets.read']},
    {username: 'ok', role: 'owner'}, {username: 'ok', password: 'not-accepted'}
  ]) assert.ok([400,409].includes((await invoke(ownerSession, 'POST', '/api/users', input)).status));
  const created = await invoke(ownerSession, 'POST', '/api/users', {username: 'EditorOne', role: 'editor', permissions: ['inventory.write']});
  assert.equal(created.status, 201);
  const {user, temporaryPassword} = created.data, stored = await getAccount(env, user.id);
  assert.deepEqual(user.permissions, ['inventory.read','inventory.write']);
  assert.ok(user.mustChangePassword); assert.equal(user.disabled, false);
  assert.ok(temporaryPassword.length >= 24); assert.ok(temporaryPassword.length <= 1024);
  assert.match(stored.salt, /^[a-f0-9]{64}$/); assert.equal(stored.hash_version, PASSWORD_VERSION);
  assert.equal(stored.hash, pbkdf2Sync(temporaryPassword, stored.salt, 600000, 32, 'sha256').toString('hex'));
  assert.ok(Math.abs(user.tempExpiresAt - now() - 7 * 86400) <= 2);
  const listed = await invoke(ownerSession, 'GET', '/api/users');
  assert.equal(listed.status, 200); assert.equal(listed.data.users[0].id, 'owner');
  const safeList = JSON.stringify(listed.data);
  for (const secret of [temporaryPassword, stored.salt, stored.hash, ownerRecord.salt, ownerRecord.hash]) assert.equal(safeList.includes(secret), false);
  assert.equal((await findAccount(env, 'editorone')).id, user.id);
  assert.equal((await invoke(ownerSession, 'POST', '/api/users', {username: 'EDITORONE'})).status, 409);
  assert.equal((await invoke(ownerSession, 'PUT', '/api/users/owner', {disabled: true})).status, 403);
  assert.equal((await invoke(ownerSession, 'POST', '/api/users/owner/reset-password')).status, 403);
  assert.deepEqual(await getAccount(env, 'owner'), owner);

  await sessionFor(user.id); await sessionFor(user.id);
  const modified = await invoke(ownerSession, 'PUT', '/api/users/' + user.id, {permissions: ['backups.restore']});
  assert.equal(modified.status, 200);
  for (const permission of ['inventory.read','inventory.write','wanted.read','wanted.write','content.read','content.write','backups.read','backups.restore']) assert.ok(modified.data.user.permissions.includes(permission));
  assert.equal(await sessionsCount(user.id), 0);
  assert.equal((await invoke(ownerSession, 'PUT', '/api/users/' + user.id, {username: 'new-name'})).status, 400);
  assert.equal((await invoke(ownerSession, 'PUT', '/api/users/' + user.id, {disabled: 'false'})).status, 400);
  await sessionFor(user.id);
  const reset = await invoke(ownerSession, 'POST', '/api/users/' + user.id + '/reset-password');
  assert.equal(reset.status, 200); assert.notEqual(reset.data.temporaryPassword, temporaryPassword);
  const afterReset = await getAccount(env, user.id);
  assert.notEqual(afterReset.hash, stored.hash); assert.notEqual(afterReset.salt, stored.salt);
  assert.equal(afterReset.hash, pbkdf2Sync(reset.data.temporaryPassword, afterReset.salt, 600000, 32, 'sha256').toString('hex'));
  assert.equal(await sessionsCount(user.id), 0);
  await sessionFor(user.id);
  assert.equal((await invoke(ownerSession, 'PUT', '/api/users/' + user.id, {disabled: true})).status, 200);
  assert.equal(await sessionsCount(user.id), 0);
  assert.equal((await getAccount(env, user.id)).disabled, 1);

  const delegated = await seedUser('delegated', 'editor', [...rolePermissions('viewer'), 'access.manage']);
  const delegatedSession = await sessionFor(delegated.id);
  assert.equal((await invoke(delegatedSession, 'GET', '/api/users')).status, 200);
  assert.equal((await invoke(delegatedSession, 'PUT', '/api/users/' + delegated.id, {permissions: []})).status, 403);
  assert.equal((await invoke(delegatedSession, 'POST', '/api/users/' + delegated.id + '/reset-password')).status, 403);
  for (const proposed of [
    {username: 'blockedadmin', role: 'admin', permissions: []},
    {username: 'blockedaccess', role: 'viewer', permissions: ['access.manage']},
    {username: 'blockedwrite', role: 'viewer', permissions: ['inventory.write']},
    {username: 'blockedbackup', role: 'viewer', permissions: ['backups.restore']}
  ]) assert.equal((await invoke(delegatedSession, 'POST', '/api/users', proposed)).status, 403);
  const privileged = await seedUser('privileged', 'viewer', ['access.manage']);
  assert.equal((await invoke(delegatedSession, 'PUT', '/api/users/' + privileged.id, {disabled: true})).status, 403);
  assert.equal((await invoke(delegatedSession, 'POST', '/api/users/' + privileged.id + '/reset-password')).status, 403);
  const higherAccess = await seedUser('higheraccess', 'editor', rolePermissions('editor'));
  const higherAccessSession = await sessionFor(higherAccess.id), beforeDenied = await auditCount();
  for (const change of [{permissions: []}, {role: 'viewer', permissions: rolePermissions('viewer')}, {disabled: true}]) {
    assert.equal((await invoke(delegatedSession, 'PUT', '/api/users/' + higherAccess.id, change)).status, 403);
  }
  assert.equal((await invoke(delegatedSession, 'POST', '/api/users/' + higherAccess.id + '/reset-password')).status, 403);
  assert.deepEqual(await getAccount(env, higherAccess.id), higherAccess);
  assert.equal(await sessionsCount(higherAccess.id), 1); assert.equal(await auditCount(), beforeDenied);
  assert.ok(await db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').bind(higherAccessSession.tokenHash).first());
  const delegatedCreate = await invoke(delegatedSession, 'POST', '/api/users', {username: 'delegatedviewer', role: 'viewer'});
  assert.equal(delegatedCreate.status, 201);
  assert.equal((await invoke(delegatedSession, 'PUT', '/api/users/' + delegatedCreate.data.user.id, {disabled: true})).status, 200);

  const auditBeforeRace = await auditCount();
  const staleSession = await sessionFor('owner');
  assert.equal((await invoke(staleSession, 'PUT', '/api/users/' + viewer.id, {disabled: true}, {afterBody: () => db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(staleSession.tokenHash).run()})).status, 401);
  assert.equal((await getAccount(env, viewer.id)).disabled, 0); assert.equal(await auditCount(), auditBeforeRace);
  const raceActor = await seedUser('raceactor', 'editor', [...rolePermissions('viewer'), 'access.manage']);
  const raceSession = await sessionFor(raceActor.id);
  assert.equal((await invoke(raceSession, 'PUT', '/api/users/' + viewer.id, {disabled: true}, {afterBody: () => db.prepare('UPDATE staff_users SET permissions=? WHERE id=?').bind('[]', raceActor.id).run()})).status, 403);
  assert.equal((await getAccount(env, viewer.id)).disabled, 0);
  const cas = await invoke(ownerSession, 'PUT', '/api/users/' + viewer.id, {disabled: true}, {env: {DB: {
    prepare: sql => db.prepare(sql), async batch(statements) {
      await db.prepare('UPDATE staff_users SET role=?,permissions=? WHERE id=?').bind('admin', JSON.stringify(rolePermissions('admin')), viewer.id).run();
      return db.batch(statements);
    }
  }}});
  assert.equal(cas.status, 409); assert.equal((await getAccount(env, viewer.id)).disabled, 0);

  // The audit and account change roll back together if either cannot be stored.
  const beforeRollback = await getAccount(env, user.id), countBeforeRollback = await auditCount();
  await db.prepare("CREATE TRIGGER reject_account_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'account.updated' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END").run();
  await assert.rejects(invoke(ownerSession, 'PUT', '/api/users/' + user.id, {disabled: false}), /synthetic audit failure/);
  assert.deepEqual(await getAccount(env, user.id), beforeRollback); assert.equal(await auditCount(), countBeforeRollback);
  await db.prepare('DROP TRIGGER reject_account_audit').run();
  const events = (await db.prepare('SELECT * FROM audit_log').all()).results;
  assert.ok(events.length >= 6);
  for (const event of events) {
    assert.ok(event.actor_id); assert.ok(event.actor_username); assert.ok(event.actor_role);
    const detail = JSON.parse(event.detail);
    assert.ok(detail.targetId); assert.ok(detail.username);
    assert.equal(/password|salt|hash|token/i.test(Object.keys(detail).filter(key => key !== 'mustChangePassword').join(',')), false);
    assert.equal(event.detail.includes(temporaryPassword), false); assert.equal(event.detail.includes(reset.data.temporaryPassword), false);
  }
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM audit_delivery').first()).count, events.length);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM audit_delivery WHERE attempts=0 AND next_attempt_at=0 AND sent_at IS NULL AND lease_until=0').first()).count, events.length);

  // The 100-account bound is enforced inside the insert, including concurrent creates.
  let staffCount = (await db.prepare('SELECT COUNT(*) AS count FROM staff_users').first()).count;
  while (staffCount < 99) await seedUser('filler' + staffCount++);
  const limitRace = await Promise.all(['lastone', 'lasttwo'].map(username => invoke(ownerSession, 'POST', '/api/users', {username, role: 'viewer'})));
  assert.deepEqual(limitRace.map(result => result.status).sort(), [201,409]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM staff_users').first()).count, 100);
  assert.equal((await invoke(ownerSession, 'POST', '/api/users', {username: 'overflow'})).status, 409);
} finally { db.close(); }

// Upgrade preserves credentials and existing owner sessions; historical events are not enqueued.
const legacy = new DatabaseSync(':memory:');
try {
  for (const name of ['0000_jazzy_marvel_zombies.sql','0001_private_administrator.sql']) legacy.exec(readFileSync('drizzle/' + name, 'utf8'));
  legacy.prepare('INSERT INTO administrator (id,username,salt,hash,hash_version) VALUES (1,?,?,?,?)').run(ownerRecord.username, ownerRecord.salt, ownerRecord.hash, ownerRecord.hash_version);
  legacy.prepare("INSERT INTO sessions (token_hash,session_id,created_at,last_seen,expires,credential_version) VALUES ('legacy-token','legacy-session',1,1,2,'legacy-version')").run();
  legacy.prepare("INSERT INTO audit_log (at,action,detail) VALUES (1,'historic','{}')").run();
  legacy.exec(readFileSync('drizzle/0002_staff_accounts.sql', 'utf8'));
  assert.deepEqual({...legacy.prepare('SELECT username,salt,hash,hash_version FROM administrator WHERE id=1').get()}, ownerRecord);
  assert.equal(legacy.prepare('SELECT user_id FROM sessions').get().user_id, 'owner');
  assert.equal(legacy.prepare('SELECT COUNT(*) AS count FROM audit_delivery').get().count, 0);
  legacy.prepare("INSERT INTO audit_log (at,action,detail,actor_id,actor_username,actor_role) VALUES (2,'new-event','{}','owner','TestOwner','owner')").run();
  assert.equal(legacy.prepare('SELECT COUNT(*) AS count FROM audit_delivery').get().count, 1);
} finally { legacy.close(); }
console.log('PASS: owner preservation, safe staff DTOs, temporary password hashing/expiry, permission dependencies, delegated privilege limits, session revocation, stale-session/actor/target races, transactional audit rollback, delivery enqueue and concurrent 100-account limit. Random synthetic credentials only.');
