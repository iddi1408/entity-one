import {randomUUID} from 'node:crypto';
import {mkdir, lstat, realpath, readdir, readFile, writeFile, unlink} from 'node:fs/promises';
import path from 'node:path';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const FILE = new RegExp(`^(${UUID})\\.(png|jpg|webp)$`);
const META = new RegExp(`^${UUID}\\.json$`);
const TYPES = {png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp'};

export class PreviewError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Ordinary files only; lexical escapes, symlinks and junctions are rejected. */
export async function safeFile(root, relative) {
  const parts = relative.split(/[\\/]/);
  if (!parts.length || parts.some(part => !part || part.startsWith('.') || /[. ]$/.test(part) || /[:\x00-\x1f\x7f]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new PreviewError(403, 'This path is not available.');
  let candidate = root;
  for (let index = 0; index < parts.length; index += 1) {
    candidate = path.join(candidate, parts[index]);
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) || (index === parts.length - 1 && !stat.isFile())) throw new PreviewError(403, 'This path is not available.');
  }
  const resolved = await realpath(candidate);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new PreviewError(403, 'This path is not available.');
  return resolved;
}

export async function ordinaryDirectory(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PreviewError(403, 'The storage directory must not be a link.');
  return realpath(directory);
}

/** Format comes from bytes, never the submitted filename or MIME type. */
export function imageFormat(bytes) {
  if (bytes.length > MAX_IMAGE_BYTES) throw new PreviewError(413, 'Images must be 8 MiB or smaller.');
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(8) === 13) {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > 20000 || height > 20000 || width * height > 100000000) throw new PreviewError(415, 'The image dimensions are not supported.');
    return 'png';
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'jpg';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)) && bytes.readUInt32LE(4) + 8 === bytes.length) return 'webp';
  throw new PreviewError(415, 'Choose a PNG, JPEG or WebP image.');
}

const safeName = (name, extension) => path.posix.basename(String(name || '').replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 160) || `image.${extension}`;

export async function createMediaStore(runtimeDirectory) {
  await mkdir(runtimeDirectory, {recursive: true, mode: 0o700});
  const runtime = await ordinaryDirectory(runtimeDirectory);
  const directory = path.join(runtime, 'uploads');
  await mkdir(directory, {mode: 0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const root = await ordinaryDirectory(directory);

  async function readRecord(filename) {
    const match = FILE.exec(filename);
    if (!match) throw new PreviewError(404, 'Image not found.');
    const metadataPath = await safeFile(root, `${match[1]}.json`);
    if ((await lstat(metadataPath)).size > 4096) throw new PreviewError(404, 'Image not found.');
    const value = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (value.id !== match[1] || value.url !== `/assets/uploads/${filename}` || typeof value.name !== 'string' || value.name.length > 160 || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_IMAGE_BYTES || typeof value.uploadedAt !== 'string' || !Number.isFinite(Date.parse(value.uploadedAt))) throw new PreviewError(404, 'Image not found.');
    const imagePath = await safeFile(root, filename);
    if ((await lstat(imagePath)).size !== value.size) throw new PreviewError(404, 'Image not found.');
    return {item: {id: value.id, url: value.url, name: safeName(value.name, match[2]), size: value.size, uploadedAt: value.uploadedAt}, imagePath, contentType: TYPES[match[2]]};
  }

  return {
    async save(bytes, originalName) {
      const extension = imageFormat(bytes), id = randomUUID(), filename = `${id}.${extension}`;
      const item = {id, url: `/assets/uploads/${filename}`, name: safeName(originalName, extension), size: bytes.length, uploadedAt: new Date().toISOString()};
      const imagePath = path.join(root, filename), metadataPath = path.join(root, `${id}.json`);
      await writeFile(imagePath, bytes, {flag: 'wx', mode: 0o600});
      try { await writeFile(metadataPath, JSON.stringify(item) + '\n', {flag: 'wx', mode: 0o600}); }
      catch (error) { await unlink(imagePath).catch(() => {}); throw error; }
      return item;
    },
    async list() {
      const records = [];
      for (const entry of await readdir(root, {withFileTypes: true})) {
        if (!entry.isFile() || !META.test(entry.name)) continue;
        try {
          const metadataPath = await safeFile(root, entry.name);
          if ((await lstat(metadataPath)).size > 4096) continue;
          const value = JSON.parse(await readFile(metadataPath, 'utf8'));
          if (typeof value.url !== 'string' || !value.url.startsWith('/assets/uploads/')) continue;
          records.push((await readRecord(value.url.slice('/assets/uploads/'.length))).item);
        } catch { /* Never advertise incomplete or invalid files. */ }
      }
      return records.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || b.id.localeCompare(a.id));
    },
    async read(filename, head = false) {
      const record = await readRecord(filename);
      return {...record, bytes: head ? null : await readFile(record.imagePath)};
    },
  };
}
