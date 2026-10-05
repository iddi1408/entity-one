#!/usr/bin/env node
/**
 * LOCAL single-administrator provisioning for .sites-runtime/preview.sqlite.
 * Pipe UTF-8 JSON containing { "username": "...", "password": "..." } to:
 *   node --experimental-sqlite scripts/provision-admin.mjs
 * Provide the JSON through stdin; no credentials or default secret are accepted
 * as command-line arguments. The password is used exactly as supplied.
 * Applies local migrations, replaces administrator 1, removes other admin rows,
 * and revokes all local sessions. Never connects to a remote database.
 */
import {randomBytes, pbkdf2Sync} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {localDB as localDatabase} from './d1-local.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HASH_VERSION = 'pbkdf2-sha256-600000-v1';
const MAX_INPUT_BYTES = 8192;
let database;

try {
  if (process.argv.length !== 2 || process.stdin.isTTY) {
    throw new Error('Supply the administrator JSON through stdin.');
  }

  const chunks = [];
  let inputBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    inputBytes += bytes.length;
    if (inputBytes > MAX_INPUT_BYTES) throw new Error('Input is too large.');
    chunks.push(bytes);
  }

  const input = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.username !== 'string' || !input.username.trim() || input.username.length > 80
      || /[\u0000-\u001f\u007f-\u009f]/u.test(input.username)
      || typeof input.password !== 'string' || !input.password || input.password.length > 1024) {
    throw new Error('A valid username and password are required.');
  }

  const username = input.username.trim();
  const salt = randomBytes(32).toString('hex');
  // Match the worker: salt is the UTF-8 hex string, not decoded random bytes.
  const hash = pbkdf2Sync(input.password, salt, 600000, 32, 'sha256').toString('hex');

  process.chdir(ROOT);
  mkdirSync(path.join(ROOT, '.sites-runtime'), {recursive: true});
  database = localDatabase(path.join(ROOT, '.sites-runtime', 'preview.sqlite'));
  await database.batch([
    database.prepare('DELETE FROM administrator WHERE id != 1'),
    database.prepare(`INSERT INTO administrator (id, username, salt, hash, hash_version)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET username = excluded.username, salt = excluded.salt,
        hash = excluded.hash, hash_version = excluded.hash_version`)
      .bind(username, salt, hash, HASH_VERSION),
    database.prepare('DELETE FROM sessions')
  ]);

  process.stdout.write(JSON.stringify({success: true, username}) + '\n');
} catch {
  process.stderr.write('Administrator provisioning failed. Check the stdin JSON and local database setup.\n');
  process.exitCode = 1;
} finally {
  database?.close();
}
