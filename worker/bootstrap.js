import {passwordHash, PASSWORD_VERSION} from './password.js';

const encoder = new TextEncoder();
const administrator = database => database.prepare('SELECT username, salt, hash, hash_version FROM administrator WHERE id = 1').first();
const validUsername = value => typeof value === 'string' && value.length > 0 && value.length <= 80 && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const validPassword = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;

async function matchingCredentials(input, username, password) {
  const bytes = [input.username, username, input.password, password].map(value => encoder.encode(value));
  const hashes = [];
  try {
    // Hash both pairs before comparison, then compare every byte without an early exit.
    for (const value of bytes) hashes.push(new Uint8Array(await crypto.subtle.digest('SHA-256', value)));
    let difference = 0;
    for (let index = 0; index < 32; index++) {
      difference |= hashes[0][index] ^ hashes[1][index];
      difference |= hashes[2][index] ^ hashes[3][index];
    }
    return difference === 0;
  } finally {
    for (const value of [...bytes, ...hashes]) value.fill(0);
  }
}

/**
 * Server-provisioned, one-time administrator initialization. This returns the
 * stored credential record; it does NOT authenticate the caller. The login
 * handler must still verify the input against the returned record normally.
 * Existing records always win, including another request's concurrent insert.
 */
export async function bootstrapAdministrator(env, input) {
  if (!env?.DB || typeof env.DB.prepare !== 'function') throw new Error('Administrator storage is unavailable.');
  const existing = await administrator(env.DB);
  if (existing) return existing;
  const username = env.ADMIN_INITIAL_USERNAME, password = env.ADMIN_INITIAL_PASSWORD;
  if (!validUsername(username) || !validPassword(password) || !validUsername(input?.username) || !validPassword(input?.password)) return null;
  if (!await matchingCredentials(input, username, password)) return null;

  const randomSalt = crypto.getRandomValues(new Uint8Array(32));
  const salt = Array.from(randomSalt, value => value.toString(16).padStart(2, '0')).join('');
  randomSalt.fill(0);
  const hash = await passwordHash(password, salt);
  await env.DB.prepare('INSERT OR IGNORE INTO administrator (id, username, salt, hash, hash_version) VALUES (1, ?, ?, ?, ?)').bind(username, salt, hash, PASSWORD_VERSION).run();
  return administrator(env.DB);
}
