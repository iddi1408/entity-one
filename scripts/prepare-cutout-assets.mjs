import {mkdir, readFile, writeFile, copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, join} from 'node:path';
import {build} from 'esbuild';

// Generated large assets stay out of Git. Exact versions and the upstream model hash
// make fresh builds reproducible; browsers only load these when an admin requests a cutout.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'public/assets/cutout-runtime');
const runtime = join(root, 'node_modules/onnxruntime-web');
const model = {
  url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
  bytes: 4574861,
  sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8'
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const version = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).version;
if (version !== '1.30.0') throw new Error('Cutout runtime requires the pinned onnxruntime-web 1.30.0.');
await mkdir(output, {recursive: true});
const target = join(output, 'u2netp.onnx');
let bytes;
try { bytes = await readFile(target); } catch { /* Fetch only when missing or invalid. */ }
if (bytes?.length !== model.bytes || digest(bytes) !== model.sha256) {
  const response = await fetch(model.url, {signal: AbortSignal.timeout(60000)});
  if (!response.ok) throw new Error(`U2NETp download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== model.bytes || digest(bytes) !== model.sha256) throw new Error('U2NETp model integrity check failed.');
  await writeFile(target, bytes);
}
for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await copyFile(join(runtime, 'dist', name), join(output, name));
}
await build({
  entryPoints: [join(root, 'public/cutout-worker.js')], outfile: join(output, 'cutout-worker.mjs'),
  bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true,
  legalComments: 'inline', sourcemap: false
});
console.log('Prepared background-removal assets: U2NETp verified, ONNX Runtime 1.30.0, same-origin worker.');
