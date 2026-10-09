import {passwordHash, PASSWORD_VERSION} from './password.js';

export const PERMISSIONS = Object.freeze([
  ['inventory.read', 'View inventory'], ['inventory.write', 'Edit inventory'],
  ['wanted.read', 'View wanted cars'], ['wanted.write', 'Edit wanted cars'],
  ['content.read', 'View site content'], ['content.write', 'Edit site content'],
  ['media.read', 'View media'], ['media.write', 'Upload & delete media'],
  ['backups.read', 'View backups'], ['backups.restore', 'Restore backups'],
  ['logs.read', 'View activity'], ['analytics.read', 'View website analytics'], ['access.manage', 'Manage staff access']
].map(([id, label]) => Object.freeze({id, label})));
const permissionIds = PERMISSIONS.map(permission => permission.id);
const permissionSet = new Set(permissionIds);
export const ROLES = Object.freeze([
  {id: 'owner', label: 'Owner', permissions: permissionIds},
  {id: 'admin', label: 'Administrator', permissions: permissionIds},
  {id: 'manager', label: 'Manager', permissions: permissionIds.filter(id => id !== 'access.manage')},
  {id: 'editor', label: 'Editor', permissions: permissionIds.filter(id => /^(inventory|wanted|content|media)\./.test(id))},
  {id: 'viewer', label: 'Viewer', permissions: ['inventory.read', 'wanted.read', 'content.read']}
].map(role => Object.freeze({...role, permissions: Object.freeze([...role.permissions])})));
const roleFor = id => ROLES.find(role => role.id === id);
const now = () => Math.floor(Date.now() / 1000);
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const random = bytes => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
const credentialVersion = user => digest(`${user.salt}:${user.hash}:${user.hash_version}`);
const SESSION_IDLE = 30 * 60, TEMPORARY_LIFETIME = 7 * 24 * 60 * 60;

function normalizedPermissions(values) {
  const selected = new Set(Array.isArray(values) ? values.filter(value => permissionSet.has(value)) : []);
  if (selected.has('backups.restore')) {
    selected.add('backups.read');
    for (const section of ['inventory', 'wanted', 'content']) selected.add(section + '.write');
  }
  if (selected.has('backups.read')) for (const section of ['inventory', 'wanted', 'content']) selected.add(section + '.read');
  for (const value of [...selected]) if (value.endsWith('.write')) selected.add(value.replace(/\.write$/, '.read'));
  return permissionIds.filter(value => selected.has(value));
}
function account(row) {
  if (!row) return null;
  let permissions;
  try { permissions = JSON.parse(row.permissions); } catch { permissions = []; }
  return {...row, permissions: normalizedPermissions(permissions)};
}
function owner(row) {
  return row ? {...row, id: 'owner', role: 'owner', permissions: [...permissionIds], must_change_password: 0, disabled: 0, created_at: null, updated_at: null, temp_expires_at: null} : null;
}
export function can(user, permission) {
  return !!user && !user.disabled && permissionSet.has(permission) && (user.role === 'owner' || Array.isArray(user.permissions) && user.permissions.includes(permission));
}
export function publicUser(user) {
  if (!user) return null;
  return {id: user.id, username: user.username, role: user.role, permissions: user.role === 'owner' ? [...permissionIds] : normalizedPermissions(user.permissions),
    mustChangePassword: !!user.must_change_password, disabled: !!user.disabled,
    createdAt: user.created_at ?? null, updatedAt: user.updated_at ?? null, tempExpiresAt: user.temp_expires_at ?? null};
}
export async function getAccount(env, id) {
  if (id === 'owner') return owner(await env.DB.prepare('SELECT username, salt, hash, hash_version FROM administrator WHERE id = 1').first());
  if (typeof id !== 'string') return null;
  return account(await env.DB.prepare('SELECT * FROM staff_users WHERE id = ?').bind(id).first());
}
export async function findAccount(env, username) {
  if (typeof username !== 'string') return null;
  const primary = await env.DB.prepare('SELECT username, salt, hash, hash_version FROM administrator WHERE id = 1 AND username = ? COLLATE NOCASE').bind(username).first();
  return primary ? owner(primary) : account(await env.DB.prepare('SELECT * FROM staff_users WHERE username = ? COLLATE NOCASE').bind(username).first());
}

function fields(input, allowed, HttpError) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new HttpError(400, 'Please check the account fields.');
}
function permissionsInput(values, HttpError) {
  if (!Array.isArray(values) || values.length > permissionIds.length || values.some(value => !permissionSet.has(value))) throw new HttpError(400, 'Choose valid account permissions.');
  return normalizedPermissions(values);
}
function proposed(input, previous, HttpError) {
  const role = input.role ?? previous?.role ?? 'viewer';
  if (!roleFor(role)) throw new HttpError(400, 'Choose a valid staff role.');
  const permissions = input.permissions !== undefined ? permissionsInput(input.permissions, HttpError)
    : input.role !== undefined || !previous ? [...roleFor(role).permissions] : [...previous.permissions];
  if (input.disabled !== undefined && typeof input.disabled !== 'boolean') throw new HttpError(400, 'The disabled setting must be true or false.');
  return {role, permissions: role === 'owner' ? [...permissionIds] : permissions, disabled: input.disabled === undefined ? previous?.disabled ?? 0 : Number(input.disabled)};
}
function authorizeTarget(actor, target, next, HttpError) {
  if (target?.id === 'owner') throw new HttpError(403, 'The owner account cannot be changed here.');
  if (target?.id === actor.id) throw new HttpError(403, 'Ask another owner to change your access.');
  if (actor.role === 'owner') return;
  if ([target, next].some(user => user && (['owner', 'admin'].includes(user.role) || user.permissions.includes('access.manage')))) throw new HttpError(403, 'Only owners can manage privileged accounts.');
  if (target && target.permissions.some(permission => !can(actor, permission))) throw new HttpError(403, 'You cannot manage accounts with permissions beyond your own.');
  if (next && next.permissions.some(permission => !can(actor, permission))) throw new HttpError(403, 'You can only grant permissions you already have.');
}
async function activeActor(env, session, HttpError) {
  if (!session?.admin?.id || !session.tokenHash) throw new HttpError(401, 'Please log in again.');
  const actor = await getAccount(env, session.admin.id), time = now();
  if (!actor || actor.disabled || actor.hash_version !== PASSWORD_VERSION) throw new HttpError(401, 'Please log in again.');
  const version = await credentialVersion(actor);
  const active = await env.DB.prepare('SELECT session_id FROM sessions WHERE token_hash = ? AND user_id = ? AND credential_version = ? AND expires > ? AND last_seen > ?').bind(session.tokenHash, actor.id, version, time, time - SESSION_IDLE).first();
  if (!active) throw new HttpError(401, 'Your session has expired. Please log in again.');
  if (actor.must_change_password) throw new HttpError(403, 'Change your temporary password before managing staff.');
  if (!can(actor, 'access.manage')) throw new HttpError(403, 'Your account cannot manage staff access.');
  return {actor, version};
}
// This predicate is re-evaluated inside the same transaction as the account change.
function actorGuard(actor, version, session, time) {
  const sql = 'EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ? AND credential_version = ? AND expires > ? AND last_seen > ?)';
  const params = [session.tokenHash, actor.id, version, time, time - SESSION_IDLE];
  if (actor.id === 'owner') return {sql: sql + ' AND EXISTS (SELECT 1 FROM administrator WHERE id = 1 AND salt = ? AND hash = ? AND hash_version = ?)', params: [...params, actor.salt, actor.hash, actor.hash_version]};
  return {sql: sql + ' AND EXISTS (SELECT 1 FROM staff_users WHERE id = ? AND disabled = 0 AND must_change_password = 0 AND salt = ? AND hash = ? AND hash_version = ? AND role = ? AND permissions = ?)',
    params: [...params, actor.id, actor.salt, actor.hash, actor.hash_version, actor.role, JSON.stringify(actor.permissions)]};
}
function targetGuard(target) {
  return {sql: 'id = ? AND role = ? AND permissions = ? AND salt = ? AND hash = ? AND hash_version = ? AND disabled = ? AND must_change_password = ? AND updated_at = ? AND temp_expires_at IS ?',
    params: [target.id, target.role, JSON.stringify(target.permissions), target.salt, target.hash, target.hash_version, target.disabled, target.must_change_password, target.updated_at, target.temp_expires_at]};
}
async function writeAccount({env, write, action, target, detail, actor, session, HttpError}) {
  let results;
  try {
    results = await env.DB.batch([
      write,
      env.DB.prepare('INSERT INTO audit_log (at, action, session_id, detail, actor_id, actor_username, actor_role) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1')
        .bind(now(), action, session.row.session_id, JSON.stringify(detail), actor.id, actor.username, actor.role),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND changes() = 1').bind(target.id)
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: staff_users\.username/i.test(error?.message || '')) throw new HttpError(409, 'That username is already in use.');
    throw error;
  }
  if (results[0].meta.changes !== 1) {
    await activeActor(env, session, HttpError);
    throw new HttpError(409, 'The account list changed. Refresh the page and try again.');
  }
  return publicUser(await getAccount(env, target.id));
}

/** Caller validates Origin/JSON/CSRF and provides its bounded body parser. */
export async function handleAccountRoutes({request, env, path, session, body, json, HttpError}) {
  const route = /^\/api\/users(?:\/([A-Za-z0-9-]{1,80})(\/reset-password)?)?$/.exec(path);
  if (!route) return null;
  const {actor, version} = await activeActor(env, session, HttpError);
  if (!route[1] && request.method === 'GET') {
    const primary = await getAccount(env, 'owner');
    const staff = (await env.DB.prepare('SELECT * FROM staff_users ORDER BY username COLLATE NOCASE, id LIMIT 100').all()).results.map(account);
    return json({users: [primary, ...staff].filter(Boolean).map(publicUser), permissions: PERMISSIONS, roles: ROLES});
  }
  const create = !route[1] && request.method === 'POST', update = route[1] && !route[2] && request.method === 'PUT';
  const reset = route[2] && request.method === 'POST';
  const remove = route[1] && !route[2] && request.method === 'DELETE';
  if (!create && !update && !reset && !remove) throw new HttpError(405, 'This account action is not supported.');
  if (remove && actor.role !== 'owner') throw new HttpError(403, 'Only owners can delete staff accounts.');
  const input = await body(request, 16384);
  fields(input, create ? ['username', 'role', 'permissions'] : update ? ['role', 'permissions', 'disabled'] : [], HttpError);
  if (update && Object.keys(input).length === 0) throw new HttpError(400, 'Choose an account setting to change.');
  const target = create ? null : await getAccount(env, route[1]);
  if (!create && !target) throw new HttpError(404, 'That account does not exist.');
  if (target?.id === 'owner') throw new HttpError(403, 'The owner account cannot be changed here.');
  const next = reset || remove ? target : proposed(input, target, HttpError);
  authorizeTarget(actor, target, next, HttpError);
  let username, temporaryPassword, salt, hash;
  if (create) {
    if (typeof input.username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,79}$/.test(input.username)) throw new HttpError(400, 'Use 1–80 letters, numbers, dots, underscores, @, + or hyphens for the username.');
    username = input.username;
    if (await findAccount(env, username)) throw new HttpError(409, 'That username is already in use.');
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM staff_users').first();
    if (count.count >= 100) throw new HttpError(409, 'The maximum of 100 staff accounts has been reached.');
  }
  if (create || reset) {
    temporaryPassword = 'E1!a' + random(24);
    salt = random(32); hash = await passwordHash(temporaryPassword, salt);
  }
  const time = now(), guard = actorGuard(actor, version, session, time);
  const id = create ? crypto.randomUUID() : target.id;
  const changed = {id, username: create ? username : target.username, ...next};
  const detail = {targetId: id, username: changed.username, role: changed.role, permissions: changed.permissions, disabled: !!changed.disabled};
  let write, action;
  if (create) {
    action = 'account.created';
    detail.mustChangePassword = true; detail.tempExpiresAt = time + TEMPORARY_LIFETIME;
    write = env.DB.prepare(`INSERT INTO staff_users (id, username, role, permissions, salt, hash, hash_version, must_change_password, disabled, created_at, updated_at, temp_expires_at) SELECT ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ? WHERE ${guard.sql} AND (SELECT COUNT(*) FROM staff_users) < 100 AND NOT EXISTS (SELECT 1 FROM administrator WHERE username = ? COLLATE NOCASE)`).bind(id, username, next.role, JSON.stringify(next.permissions), salt, hash, PASSWORD_VERSION, time, time, detail.tempExpiresAt, ...guard.params, username);
  } else {
    const expected = targetGuard(target);
    if (remove) {
      action = 'account.deleted';
      write = env.DB.prepare(`DELETE FROM staff_users WHERE ${expected.sql} AND ${guard.sql}`).bind(...expected.params, ...guard.params);
    } else if (reset) {
      action = 'account.password_reset';
      detail.mustChangePassword = true; detail.tempExpiresAt = time + TEMPORARY_LIFETIME;
      write = env.DB.prepare(`UPDATE staff_users SET salt = ?, hash = ?, hash_version = ?, must_change_password = 1, temp_expires_at = ?, updated_at = ? WHERE ${expected.sql} AND ${guard.sql}`).bind(salt, hash, PASSWORD_VERSION, detail.tempExpiresAt, time, ...expected.params, ...guard.params);
    } else {
      action = 'account.updated';
      write = env.DB.prepare(`UPDATE staff_users SET role = ?, permissions = ?, disabled = ?, updated_at = ? WHERE ${expected.sql} AND ${guard.sql}`).bind(next.role, JSON.stringify(next.permissions), next.disabled, time, ...expected.params, ...guard.params);
    }
  }
  const user = await writeAccount({env, write, action, target: changed, detail, actor, session, HttpError});
  if (remove) return json({deleted: true, id});
  return json({user, ...(temporaryPassword ? {temporaryPassword} : {})}, create ? 201 : 200);
}
