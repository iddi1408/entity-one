/**
 * Small R2-shaped adapter for Cloudflare KV. KV is used only when an R2
 * binding is absent (for example, on the no-subscription Cloudflare plan).
 * Images remain byte-for-byte intact; metadata lives beside each KV value.
 */
async function bytesOf(value, limit = 16 * 1024 * 1024) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value && typeof value.getReader === 'function') {
    const reader = value.getReader(), chunks = [];
    let length = 0;
    try {
      while (true) {
        const {done, value: chunk} = await reader.read();
        if (done) break;
        length += chunk.byteLength;
        if (length > limit) throw new Error('The file exceeds the storage limit.');
        chunks.push(chunk);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function kvBucket(namespace) {
  const head = async key => {
    const {value, metadata} = await namespace.getWithMetadata(key, {type: 'stream'});
    await value?.cancel?.().catch(() => {});
    if (!metadata || !Number.isSafeInteger(metadata.size) || metadata.size < 0) return null;
    return {key, size: metadata.size, etag: metadata.etag, customMetadata: metadata.customMetadata || {}, httpMetadata: metadata.httpMetadata || {}};
  };
  return {
    async list({prefix = '', limit = 1000} = {}) {
      const result = await namespace.list({prefix, limit});
      return {objects: result.keys.map(key => ({
        key: key.name, size: key.metadata?.size,
        customMetadata: key.metadata?.customMetadata || {},
        httpMetadata: key.metadata?.httpMetadata || {}, etag: key.metadata?.etag,
      })), truncated: !result.list_complete};
    },
    head,
    async get(key) {
      const {value, metadata} = await namespace.getWithMetadata(key, {type: 'stream'});
      if (value === null || !metadata || !Number.isSafeInteger(metadata.size)) return null;
      return {key, body: value, size: metadata.size, etag: metadata.etag, customMetadata: metadata.customMetadata || {}, httpMetadata: metadata.httpMetadata || {}};
    },
    async put(key, value, options = {}) {
      const previous = await head(key);
      if (options.onlyIf?.etagMatches && previous?.etag !== options.onlyIf.etagMatches) return null;
      if (options.onlyIf?.etagDoesNotMatch === '*' && previous) return null;
      const bytes = await bytesOf(value);
      const metadata = {
        size: bytes.byteLength,
        etag: crypto.randomUUID(),
        customMetadata: options.customMetadata || {},
        httpMetadata: options.httpMetadata || {},
      };
      await namespace.put(key, bytes, {metadata});
      return {key, ...metadata};
    },
    delete: key => namespace.delete(key),
  };
}

export function mediaBucket(env) {
  if (env.BUCKET) return env.BUCKET;
  return env.MEDIA ? kvBucket(env.MEDIA) : null;
}
