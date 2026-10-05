import {pbkdf2Async} from '@noble/hashes/pbkdf2.js';
import {sha256} from '@noble/hashes/sha2.js';

export const PASSWORD_VERSION = 'pbkdf2-sha256-600000-v1';
export const PASSWORD_ITERATIONS = 600000;
export const PASSWORD_BYTES = 32;

const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');

function nativeUnsupported(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'NotSupportedError') return true;
  if (typeof error.message !== 'string' || !/\bpbkdf2\b/i.test(error.message)) return false;
  // Cloudflare's explicit iteration-cap rejection is an Error, not necessarily NotSupportedError.
  // Do not turn unrelated crypto, input, resource, or programming errors into a fallback.
  return /\b(?:iteration counts?|iterations?)\s+(?:(?:above|over)\s+[\d,]+\s+are not supported|exceed(?:s|ed)?\s+(?:the\s+)?(?:supported\s+)?(?:limit|maximum))\b/i.test(error.message);
}

/**
 * Keep the existing credential format exactly: raw UTF-8 password, UTF-8 salt
 * STRING (the hex characters, not decoded salt bytes), 600,000 SHA-256 rounds,
 * 32 output bytes encoded as lowercase hex. Neither path normalizes Unicode.
 */
export async function passwordHash(password, salt) {
  if (typeof password !== 'string' || typeof salt !== 'string') throw new TypeError('Password and salt must be strings.');
  const passwordBytes = encoder.encode(password), saltBytes = encoder.encode(salt);
  let derived;
  try {
    try {
      const key = await globalThis.crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveBits']);
      derived = new Uint8Array(await globalThis.crypto.subtle.deriveBits({name: 'PBKDF2', salt: saltBytes, iterations: PASSWORD_ITERATIONS, hash: 'SHA-256'}, key, PASSWORD_BYTES * 8));
    } catch (error) {
      if (!nativeUnsupported(error)) throw error;
      // Preserve the full work factor; this is the same PBKDF2, implemented by noble.
      derived = await pbkdf2Async(sha256, passwordBytes, saltBytes, {c: PASSWORD_ITERATIONS, dkLen: PASSWORD_BYTES, asyncTick: 10});
    }
    return hex(derived);
  } finally {
    // Best-effort cleanup of the mutable copies owned by this call.
    passwordBytes.fill(0); saltBytes.fill(0); derived?.fill(0);
  }
}
