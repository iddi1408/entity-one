import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise cancellation/resource cleanup and alpha composition without downloading
// a model or making a network call. Real model/image quality is checked in browser QA.
const source = (await readFile('public/cutout.js', 'utf8')).replace(/^export /gm, '') +
  '\nglobalThis.cutout = {prepareCutout, validateTransparentImage, infer, applyMask, hasTransparency};';
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
function harness() {
  const workers = [], timers = new Map(); let sequence = 0;
  class Worker {
    constructor(url, options) { this.url = url; this.options = options; this.terminated = false; workers.push(this); }
    postMessage(value) { this.input = value; }
    terminate() { this.terminated = true; }
    message(data) { this.onmessage?.({data}); }
  }
  const context = vm.createContext({Blob, DOMException, Float32Array, Uint8ClampedArray, Number, Math, Worker,
    WebAssembly: {}, console,
    setTimeout(callback, delay) { const id = ++sequence; if (delay) timers.set(id, callback); else queueMicrotask(callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(source, context, {filename: 'public/cutout.js'});
  return {...context.cutout, workers, timers};
}

{
  const h = harness();
  for (const blob of [new Blob(['<svg/>'], {type: 'image/svg+xml'}), new Blob([], {type: 'image/png'}), 'https://example.test/car.jpg']) {
    await assert.rejects(h.prepareCutout(blob), /JPG, PNG or WebP/); checks++;
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.prepareCutout(new Blob(['x'], {type: 'image/png'}), {signal: controller.signal}), {name: 'AbortError'}); checks++;
  check(h.workers.length === 0, 'Invalid and cancelled inputs never create a worker');
}
{
  const h = harness(), controller = new AbortController();
  const job = h.infer(new Float32Array(320 * 320 * 3), {signal: controller.signal});
  check(h.workers[0].url === '/assets/cutout-runtime/cutout-worker.mjs', 'Inference loads the self-hosted worker');
  check(h.workers[0].options.type === 'module', 'Worker is a module');
  controller.abort();
  await assert.rejects(job, {name: 'AbortError'}); checks++;
  check(h.workers[0].terminated, 'Aborting terminates inference and releases its memory');
  check(h.timers.size === 0, 'Aborting clears the timeout');
  h.workers[0].message({type: 'result', mask: new Float32Array(320 * 320)});
}
{
  const h = harness(), updates = [];
  const job = h.infer(new Float32Array(320 * 320 * 3), {onProgress: value => updates.push(value)});
  h.workers[0].message({type: 'progress', message: 'Separating the car…'});
  check(updates[0] === 'Separating the car…', 'Progress reaches the caller');
  const mask = new Float32Array(320 * 320).fill(0.5);
  h.workers[0].message({type: 'result', mask});
  assert.equal(await job, mask); checks++;
  check(h.workers[0].terminated && h.timers.size === 0, 'Successful completion releases worker/timer');
}
for (const failure of ['timeout', 'load', 'model']) {
  const h = harness(), job = h.infer(new Float32Array(320 * 320 * 3), {});
  if (failure === 'timeout') [...h.timers.values()][0]();
  else if (failure === 'load') h.workers[0].onerror();
  else h.workers[0].message({type: 'error', message: 'No clear car was found.'});
  await assert.rejects(job); checks++;
  check(h.workers[0].terminated && h.timers.size === 0, `${failure} releases worker/timer`);
}
{
  const h = harness(), rgba = new Uint8ClampedArray([10, 20, 30, 255, 90, 80, 70, 128, 150, 170, 190, 255, 3, 2, 1, 0]);
  const original = rgba.slice(), frame = {width: 2, height: 2, pixels: {data: rgba}};
  await h.applyMask(frame, new Float32Array(320 * 320).fill(0.5));
  for (let i = 0; i < rgba.length; i++) if (i % 4 !== 3) check(rgba[i] === original[i], 'Mask composition preserves each RGB channel');
  assert.deepEqual([rgba[3], rgba[7], rgba[11], rgba[15]], [128, 64, 128, 0]); checks++;
  check(h.hasTransparency(frame), 'Meaningful existing transparency is detected');
  check(!h.hasTransparency({width: 2, height: 2, pixels: {data: new Uint8ClampedArray(16).fill(255)}}), 'Opaque photos are not accepted as transparent');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.applyMask(frame, new Float32Array(320 * 320), controller.signal), {name: 'AbortError'}); checks++;
}
console.log(`PASS: ${checks} cutout checks covering input validation, cancellation, worker lifecycle, timeout/load/model failures, transparency and RGB preservation.`);
