import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {visibleBounds, cutoutPadding, subjectBounds, fitCutoutToFrame} from '../public/cutout-frame.js';

// Exercise cancellation/resource cleanup and alpha composition without downloading
// a model or making a network call. Real model/image quality is checked in browser QA.
const source = (await readFile('public/cutout.js', 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') +
  '\nglobalThis.cutout = {prepareCutout, validateTransparentImage, infer, applyMask, hasTransparency, finishImage};';
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
function harness() {
  const workers = [], canvases = [], timers = new Map(); let sequence = 0;
  class Worker {
    constructor(url, options) { this.url = url; this.options = options; this.terminated = false; workers.push(this); }
    postMessage(value) { this.input = value; }
    terminate() { this.terminated = true; }
    message(data) { this.onmessage?.({data}); }
  }
  const context = vm.createContext({Blob, DOMException, Float32Array, Uint8ClampedArray, Number, Math, Worker,
    WebAssembly: {}, console, visibleBounds, cutoutPadding,
    document: {createElement() {
      const canvas = {width:0, height:0, getContext:() => ({putImageData(pixels, x, y) { canvas.written = {pixels, x, y}; }}),
        toBlob(callback, type) { canvas.exported = {width:canvas.width, height:canvas.height}; callback(new Blob(['cutout'], {type})); }};
      canvases.push(canvas); return canvas;
    }},
    setTimeout(callback, delay) { const id = ++sequence; if (delay) timers.set(id, callback); else queueMicrotask(callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(source, context, {filename: 'public/cutout.js'});
  return {...context.cutout, workers, timers, canvases};
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
// Fit equal visible cars identically despite very different PNG canvases.
// Scaling keeps the tyres on the same stage baseline, including narrow screens.
const subject = {left:0, top:0, width:600, height:240};
const paddedSubject = {...subject, left:900, top:400};
const close = (actual, expected, message) => check(Math.abs(actual - expected) < .00001, message);
for (const frame of [{width:980,height:395},{width:306,height:235},{width:230,height:130}]) {
  const baseline = frame.height * .93;
  const normal = fitCutoutToFrame({width:600,height:240}, subject, frame);
  for (const requestedScale of [.65,1,1.15]) {
    const snug = fitCutoutToFrame({width:600,height:240}, subject, frame, requestedScale);
    const padded = fitCutoutToFrame({width:2400,height:1200}, paddedSubject, frame, requestedScale);
    const snugScale = snug.width / 600, paddedScale = padded.width / 2400;
    close(snugScale, paddedScale, 'Transparent source margins do not change visible car size');
    close(snug.left, padded.left + paddedSubject.left * paddedScale, 'Visible car is centred regardless of original canvas offset');
    close(snug.top, padded.top + paddedSubject.top * paddedScale, 'Transparent top padding does not move the visible car');
    close(snug.width / normal.width, requestedScale, 'Size adjustment scales the visible car predictably');
    close(snug.top + subject.height * snugScale, baseline, 'Changing size leaves the car on the stage baseline');
    for (const shape of [{width:950,height:300},{width:400,height:700},{width:1800,height:110}]) {
      const data = {left:130,top:45,...shape}, source = {width:2100,height:900};
      const fit = fitCutoutToFrame(source, data, frame, requestedScale), scale = fit.width / source.width;
      close(fit.height / source.height, scale, 'Tall and wide cutouts keep their original proportions');
      close(fit.left + (data.left + data.width / 2) * scale, frame.width / 2, 'Each silhouette stays horizontally centred');
      close(fit.top + (data.top + data.height) * scale, baseline, 'Tall and wide cars share the same stage baseline');
      check(fit.left + data.left * scale > 0 && fit.left + (data.left + data.width) * scale < frame.width, 'Full subject fits horizontally with breathing room at every allowed size');
      check(fit.top + data.top * scale > 0 && fit.top + (data.top + data.height) * scale < frame.height, 'Full subject fits vertically without clipping at every allowed size');
    }
  }
}
{
  const source = {width:600,height:240}, frame = {width:980,height:395};
  const normal = fitCutoutToFrame(source, subject, frame);
  const widthLimitedFrame = {width:600,height:1000};
  const defaultFit = fitCutoutToFrame(source, subject, widthLimitedFrame);
  close(defaultFit.width + cutoutPadding(subject) * 2 * defaultFit.width / source.width, widthLimitedFrame.width * .82, 'Default presentation reserves breathing room instead of filling the entire stage');
  for (const malformed of [undefined,null,NaN,Infinity,-Infinity,'1.15',{},[]]) {
    assert.deepEqual(fitCutoutToFrame(source, subject, frame, malformed), normal, 'Non-numeric or non-finite size values use the default presentation'); checks++;
  }
  for (const tooSmall of [-100,0,.1,.64]) {
    assert.deepEqual(fitCutoutToFrame(source, subject, frame, tooSmall), fitCutoutToFrame(source, subject, frame, .65), 'Finite undersized values stop at the smallest permitted size'); checks++;
  }
  for (const tooLarge of [1.16,2,Number.MAX_VALUE]) {
    assert.deepEqual(fitCutoutToFrame(source, subject, frame, tooLarge), fitCutoutToFrame(source, subject, frame, 1.15), 'Finite oversized values cannot enlarge the car beyond the permitted frame'); checks++;
  }
}
check(fitCutoutToFrame({width:600,height:240}, subject, {width:0,height:200}) === null, 'Hidden zero-size frames defer sizing until layout');
{
  const width=220,height=130,pixels=new Uint8ClampedArray(width*height*4);
  const paint=(left,top,w,h,alpha=255)=>{for(let y=top;y<top+h;y++)for(let x=left;x<left+w;x++)pixels[(y*width+x)*4+3]=alpha;};
  paint(40,35,120,55); // body
  paint(165,40,2,3); // detached mirror close to the main body
  paint(60,94,10,5); // wheel separated by a gap in the mask
  paint(2,3,1,1);paint(219,129,1,1); // isolated segmentation specks
  paint(0,0,220,1,16); // faint mask haze
  const measured=subjectBounds(pixels,width,height);
  assert.deepEqual({left:measured.left,top:measured.top,width:measured.width,height:measured.height},{left:40,top:35,width:127,height:64});checks++;
  check(subjectBounds(new Uint8ClampedArray(16),2,2) === null, 'Empty transparent images safely fall back');
  paint(180,105,10,8); // substantial disconnected part is retained
  check(subjectBounds(pixels,width,height).width === 150, 'Substantial disconnected subject parts are not discarded');
}
{
  const h=harness(),pixels={data:new Uint8ClampedArray([32,64,96,255,0,0,0,0,0,0,0,0,0,0,0,0])};
  const finished=await h.finishImage({width:2,height:2,sourceWidth:2,sourceHeight:2,pixels});
  check(finished.width === 5 && finished.height === 5, 'Edge-touching source gets equal new transparent padding');
  check(h.canvases[0].written.x === 2 && h.canvases[0].written.y === 2, 'Visible subject is centred even at the source edge');
  check(h.canvases[0].written.pixels === pixels, 'Framing preserves the original subject pixels');
  check(h.canvases[0].width === 1 && h.canvases[0].height === 1, 'Export canvas releases memory after saving');
}
console.log(`PASS: ${checks} cutout checks covering input validation, cancellation, lifecycle, transparency, RGB preservation, padding-independent sizing, scale limits, stable stage baseline, responsive contain geometry and alpha specks.`);
