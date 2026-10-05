import assert from 'node:assert/strict';
import {pbkdf2Sync, randomBytes} from 'node:crypto';
import {localDB} from './d1-local.mjs';
import {bootstrapAdministrator} from '../worker/bootstrap.js';
import {PASSWORD_VERSION} from '../worker/password.js';

const username = 'test-owner-' + randomBytes(6).toString('hex');
const password = randomBytes(32).toString('base64url') + '🔒é';
const input = {username, password};
const initial = {ADMIN_INITIAL_USERNAME: username, ADMIN_INITIAL_PASSWORD: password};
const nativeCrypto = globalThis.crypto, cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const record = database => database.prepare('SELECT username, salt, hash, hash_version FROM administrator WHERE id = 1').first();
const count = database => database.prepare('SELECT COUNT(*) AS count FROM administrator').first();
function check(value, message) { assert.ok(value, message); }

await assert.rejects(bootstrapAdministrator({}, input), /storage is unavailable/);
await assert.rejects(bootstrapAdministrator(null, input), /storage is unavailable/);
const empty = localDB();
try {
  for (const settings of [
    {}, {ADMIN_INITIAL_USERNAME: username}, {ADMIN_INITIAL_PASSWORD: password},
    {...initial, ADMIN_INITIAL_USERNAME: ''}, {...initial, ADMIN_INITIAL_USERNAME: ' ' + username},
    {...initial, ADMIN_INITIAL_USERNAME: 'owner\0'}, {...initial, ADMIN_INITIAL_USERNAME: 'x'.repeat(81)},
    {...initial, ADMIN_INITIAL_USERNAME: 1}, {...initial, ADMIN_INITIAL_PASSWORD: ''},
    {...initial, ADMIN_INITIAL_PASSWORD: 'x'.repeat(1025)}, {...initial, ADMIN_INITIAL_PASSWORD: 1}
  ]) {
    assert.equal(await bootstrapAdministrator({DB: empty, ...settings}, input), null);
  }
  for (const attempted of [null, {}, {username}, {password}, {...input, username: 'wrong'}, {...input, password: 'wrong'}, {...input, username: username + ' '}, {...input, password: password + ' '}, {...input, password: 12}]) {
    assert.equal(await bootstrapAdministrator({DB: empty, ...initial}, attempted), null);
  }
  check((await count(empty)).count === 0, 'Invalid settings/input never insert an account');

  // Both credential pairs are compared even when the username is already wrong.
  let digests = 0, saltCalls = 0, kdfCalls = 0;
  Object.defineProperty(globalThis, 'crypto', {configurable: true, value: {
    getRandomValues() { saltCalls++; throw new Error('Wrong credentials must not generate salt'); },
    subtle: {
      async digest(...args) { digests++; return nativeCrypto.subtle.digest(...args); },
      async importKey() { kdfCalls++; throw new Error('Wrong credentials must not run the password KDF'); }
    }
  }});
  try { assert.equal(await bootstrapAdministrator({DB: empty, ...initial}, {...input, username: 'wrong'}), null); }
  finally { Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); }
  assert.equal(digests, 4); assert.equal(saltCalls, 0); assert.equal(kdfCalls, 0);

  const created = await bootstrapAdministrator({DB: empty, ...initial}, input);
  assert.equal(created.username, username); assert.equal(created.hash_version, PASSWORD_VERSION);
  assert.match(created.salt, /^[a-f0-9]{64}$/); assert.match(created.hash, /^[a-f0-9]{64}$/);
  assert.equal(created.hash, pbkdf2Sync(password, created.salt, 600000, 32, 'sha256').toString('hex'));
  check((await count(empty)).count === 1, 'Only administrator 1 exists');
  check(!JSON.stringify(created).includes(password), 'Plaintext password is absent from stored result');

  // Removing or changing temporary presets cannot reset an existing account.
  for (const environment of [{DB: empty}, {DB: empty, ...initial, ADMIN_INITIAL_PASSWORD: 'different'}]) {
    assert.deepEqual(await bootstrapAdministrator(environment, {username: 'other', password: 'other'}), created);
  }
  assert.deepEqual(await record(empty), created);
} finally { empty.close(); }

// Two genuine first-login requests race through hashing and INSERT OR IGNORE.
const concurrent = localDB();
try {
  const env = {DB: concurrent, ...initial};
  const [first, second] = await Promise.all([bootstrapAdministrator(env, input), bootstrapAdministrator(env, input)]);
  assert.deepEqual(first, second); assert.deepEqual(first, await record(concurrent));
  check((await count(concurrent)).count === 1, 'Concurrent first logins produce exactly one account');
  assert.equal(first.hash, pbkdf2Sync(password, first.salt, 600000, 32, 'sha256').toString('hex'));
} finally { concurrent.close(); }

// A different administrator installed after the initial read must win unchanged.
const raced = localDB();
try {
  const winner = {username: 'external-owner', salt: randomBytes(32).toString('hex'), hash: randomBytes(32).toString('hex'), hash_version: PASSWORD_VERSION};
  let injected = false;
  const wrapped = {prepare(sql) {
    const statement = raced.prepare(sql);
    if (!sql.startsWith('INSERT OR IGNORE INTO administrator')) return statement;
    return {bind(...values) {
      statement.bind(...values);
      return {async run() {
        if (!injected) {
          injected = true;
          await raced.prepare('INSERT INTO administrator (id, username, salt, hash, hash_version) VALUES (1, ?, ?, ?, ?)').bind(winner.username, winner.salt, winner.hash, winner.hash_version).run();
        }
        return statement.run();
      }};
    }};
  }};
  assert.deepEqual({...await bootstrapAdministrator({DB: wrapped, ...initial}, input)}, winner);
  assert.deepEqual({...await record(raced)}, winner); check((await count(raced)).count === 1, 'A concurrent existing record is never overwritten');
} finally { raced.close(); }

// Re-query before inspecting presets, and never return guessed credential material.
const existingRow = {username: 'already-created', salt: randomBytes(32).toString('hex'), hash: randomBytes(32).toString('hex'), hash_version: PASSWORD_VERSION};
const existingDB = {prepare(sql) {
  assert.match(sql, /^SELECT username, salt, hash, hash_version FROM administrator WHERE id = 1$/);
  return {async first() { return existingRow; }};
}};
assert.equal(await bootstrapAdministrator({DB: existingDB, get ADMIN_INITIAL_USERNAME() { throw new Error('Existing account must bypass presets'); }}, null), existingRow);
const failure = new Error('Synthetic database failure');
await assert.rejects(bootstrapAdministrator({DB: {prepare() { return {async first() { throw failure; }}; }}, ...initial}, input), error => error === failure);
assert.equal(globalThis.crypto, nativeCrypto);
console.log('PASS: bootstrap disabled without valid presets, exact credential checks, fixed-byte comparison without early exit, 600,000-round hash, existing-account protection, concurrent first logins, winning-record requery and database-error propagation. Random test credentials only; no secrets logged.');
