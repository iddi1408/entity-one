import {readFile, writeFile, mkdir, readdir, cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {compileWorker} from './compile-worker.mjs';
await import('./prepare-cutout-assets.mjs');

const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.wasm':'application/wasm','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png','.ttf':'font/ttf'};
const assets = {}, external = [];
async function collect(dir, prefix = '') {
  for (const entry of await readdir(dir, {withFileTypes:true})) {
    const key = prefix + '/' + entry.name, filename = path.join(dir, entry.name);
    if (entry.isDirectory()) { await collect(filename, key); continue; }
    const bytes = await readFile(filename), type = mime[path.extname(entry.name)] || 'application/octet-stream';
    // Preserve original image quality without loading photographs into every Worker isolate.
    if (bytes.length > 32768 && key.startsWith('/assets/')) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      assets[key] = {type, hash, size:bytes.length, storage:'r2'};
      external.push({path:key, filename:path.resolve(filename), hash, size:bytes.length, type});
    } else assets[key] = {type, bytes:bytes.toString('base64')};
  }
}
await collect('public');
await mkdir('dist/server', {recursive:true});
await mkdir('dist/.openai', {recursive:true});
await mkdir('.sites-runtime', {recursive:true});
const content = JSON.parse(await readFile('public/content.json', 'utf8'));
await writeFile('dist/server/index.js', await compileWorker({assets, content}));
await writeFile('.sites-runtime/deploy-assets.json', JSON.stringify(external));
await cp('.openai/hosting.json', 'dist/.openai/hosting.json');
await cp('drizzle', 'dist/.openai/drizzle', {recursive:true});
console.log(`Built ENTITY-1: ${Object.keys(assets).length} assets, ${external.length} full-quality assets backed by R2.`);
