import assert from 'node:assert/strict';
import {pbkdf2Sync, randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {passwordHash, PASSWORD_VERSION, PASSWORD_ITERATIONS, PASSWORD_BYTES} from '../worker/password.js';

assert.equal(PASSWORD_VERSION, 'pbkdf2-sha256-600000-v1');
assert.equal(PASSWORD_ITERATIONS, 600000);
assert.equal(PASSWORD_BYTES, 32);
const nativeCrypto = globalThis.crypto;
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const benchmarks = [];
const vectors = [
  {label: 'random ASCII', password: randomBytes(32).toString('base64url'), salt: randomBytes(32).toString('hex')},
  {label: 'Unicode password', password: `${randomBytes(24).toString('base64url')} é🏎️車العربية`, salt: randomBytes(32).toString('hex')},
  {label: 'NUL, decomposed Unicode and UTF-8 salt', password: `${randomBytes(24).toString('base64url')}\0e\u0301`, salt: `${randomBytes(32).toString('hex')}🔒`}
];
const reference = vector => pbkdf2Sync(vector.password, vector.salt, 600000, 32, 'sha256').toString('hex');
async function withSubtle(subtle, operation) {
  Object.defineProperty(globalThis, 'crypto', {value: {subtle}, configurable: true});
  try { return await operation(); }
  finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
}
const importKey = (...args) => nativeCrypto.subtle.importKey(...args);
const capError = () => new Error('Pbkdf2 failed: iteration counts above 100000 are not supported (requested 600000).');

for (const vector of vectors) {
  let start = performance.now(); const expected = reference(vector); const nodeMs = performance.now() - start;
  let imports = 0, derives = 0, borrowedPassword, borrowedSalt;
  start = performance.now();
  const native = await withSubtle({
    async importKey(...args) {
      imports++;
      assert.equal(args[0], 'raw'); assert.equal(args[2], 'PBKDF2'); assert.equal(args[3], false);
      assert.deepEqual(args[4], ['deriveBits']);
      borrowedPassword = args[1]; assert.deepEqual(Buffer.from(args[1]), Buffer.from(vector.password, 'utf8'));
      return importKey(...args);
    },
    async deriveBits(...args) {
      derives++; const [algorithm, , bits] = args;
      assert.equal(algorithm.name, 'PBKDF2'); assert.equal(algorithm.hash, 'SHA-256');
      assert.equal(algorithm.iterations, 600000); assert.equal(bits, 256);
      borrowedSalt = algorithm.salt; assert.deepEqual(Buffer.from(algorithm.salt), Buffer.from(vector.salt, 'utf8'));
      return nativeCrypto.subtle.deriveBits(...args);
    }
  }, () => passwordHash(vector.password, vector.salt));
  const nativeMs = performance.now() - start;
  assert.equal(native, expected, vector.label); assert.match(native, /^[a-f0-9]{64}$/);
  assert.equal(imports, 1); assert.equal(derives, 1);
  assert.ok(borrowedPassword.every(value => value === 0)); assert.ok(borrowedSalt.every(value => value === 0));

  derives = 0; start = performance.now();
  const fallback = await withSubtle({importKey, async deriveBits(algorithm) {
    derives++; assert.equal(algorithm.iterations, 600000); throw capError();
  }}, () => passwordHash(vector.password, vector.salt));
  const fallbackMs = performance.now() - start;
  assert.equal(fallback, expected, `${vector.label}: genuine 600,000-round fallback must match Node`);
  assert.equal(derives, 1, 'The native operation is attempted before fallback');
  benchmarks.push({case: vector.label, nodeMs: Math.round(nodeMs), nativeMs: Math.round(nativeMs), fallbackMs: Math.round(fallbackMs)});
}

// Explicit algorithm unavailability may be reported while importing the key.
const sample = vectors[0]; let attemptedDerive = false;
const unsupported = await withSubtle({
  async importKey() { throw new DOMException('PBKDF2 is unavailable.', 'NotSupportedError'); },
  async deriveBits() { attemptedDerive = true; throw new Error('Must not reach deriveBits'); }
}, () => passwordHash(sample.password, sample.salt));
assert.equal(unsupported, reference(sample)); assert.equal(attemptedDerive, false);

// Only explicit runtime compatibility errors may trigger the slower path.
for (const failure of [
  new DOMException('The operation failed.', 'OperationError'),
  new TypeError('Invalid algorithm parameters.'),
  new Error('PBKDF2 iterations must be positive.'),
  new Error('PBKDF2 memory limit exceeded.'),
  new Error('The request was aborted.'),
  new Error('iteration counts above 100000 are not supported'),
  'NotSupportedError'
]) {
  await withSubtle({importKey, async deriveBits() { throw failure; }}, () =>
    assert.rejects(passwordHash(sample.password, sample.salt), error => error === failure));
}
for (const [password, salt] of [[undefined, sample.salt], [sample.password, null], [42, sample.salt], [sample.password, new Uint8Array(32)]]) {
  await assert.rejects(passwordHash(password, salt), TypeError);
}

// The stored salt is its UTF-8 hex representation, never decoded hex bytes.
assert.notEqual(await passwordHash(sample.password, sample.salt), pbkdf2Sync(sample.password, Buffer.from(sample.salt, 'hex'), 600000, 32, 'sha256').toString('hex'));
assert.equal(globalThis.crypto, nativeCrypto, 'Tests restore the native crypto implementation');
console.log('PASS: native and noble PBKDF2-SHA256 parity at 600,000 iterations, Unicode/NUL encoding, explicit-cap fallback, unchanged credential version, input validation, and unrelated-error propagation.');
console.log('Local benchmark milliseconds (random ephemeral inputs; no credentials or hashes logged):');
console.table(benchmarks);
