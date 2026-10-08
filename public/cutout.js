// Admin-only image preparation. Originals are never changed or uploaded by this module.
// API: prepareCutout(blob, {onProgress(message), signal}) and validateTransparentImage(blob, {signal})
// Both return {blob: PNG Blob, width, height, sourceWidth, sourceHeight}.
const MODEL_SIZE = 320;
const MAX_EDGE = 2400;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 90000;
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const abortError = () => new DOMException('Image preparation cancelled.', 'AbortError');
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
function progress(callback, message) { try { callback?.(message); } catch { /* A UI callback must not interrupt processing. */ } }
function makeCanvas(width, height) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', {willReadFrequently: true});
  if (!context) throw new Error('Image preparation is unavailable in this browser. Try another browser.');
  return {canvas, context};
}
function nextFrame() { return new Promise(resolve => setTimeout(resolve, 0)); }

async function readImage(source, signal) {
  checkAbort(signal);
  if (!(source instanceof Blob) || !MIME_TYPES.has(source.type) || !source.size || source.size > MAX_FILE_BYTES) {
    throw new Error('Choose a JPG, PNG or WebP image smaller than 20 MB.');
  }
  let bitmap;
  try { bitmap = await createImageBitmap(source); }
  catch { throw new Error('This image could not be opened. Try a different JPG, PNG or WebP.'); }
  try {
    checkAbort(signal);
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 80000000 || Math.max(bitmap.width, bitmap.height) > 16000) {
      throw new Error('This image is too large to prepare safely. Choose one smaller than 80 megapixels.');
    }
    const sourceWidth = bitmap.width, sourceHeight = bitmap.height;
    const scale = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
    const {canvas, context} = makeCanvas(width, height);
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    return {canvas, context, pixels, width, height, sourceWidth, sourceHeight};
  } finally { bitmap.close(); }
}

function hasTransparency(frame) {
  let clear = 0, visible = 0;
  const values = frame.pixels.data, count = frame.width * frame.height;
  for (let i = 3; i < values.length; i += 4) {
    if (values[i] <= 16) clear++;
    if (values[i] >= 128) visible++;
  }
  return clear >= count * 0.01 && visible >= count * 0.005;
}

function modelPixels(frame) {
  const {canvas, context} = makeCanvas(MODEL_SIZE, MODEL_SIZE);
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  context.drawImage(frame.canvas, 0, 0, MODEL_SIZE, MODEL_SIZE);
  const rgba = context.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const count = MODEL_SIZE * MODEL_SIZE, result = new Float32Array(count * 3);
  const means = [0.485, 0.456, 0.406], deviations = [0.229, 0.224, 0.225];
  let maximum = 1;
  for (let i = 0; i < count; i++) for (let channel = 0; channel < 3; channel++) maximum = Math.max(maximum, rgba[i * 4 + channel]);
  for (let i = 0; i < count; i++) for (let channel = 0; channel < 3; channel++) {
    result[channel * count + i] = (rgba[i * 4 + channel] / maximum - means[channel]) / deviations[channel];
  }
  canvas.width = canvas.height = 1;
  return result;
}

function infer(pixels, {onProgress, signal}) {
  checkAbort(signal);
  if (typeof Worker !== 'function' || typeof WebAssembly !== 'object') {
    throw new Error('Automatic background removal is unavailable in this browser. Upload a transparent PNG instead.');
  }
  return new Promise((resolve, reject) => {
    let worker, timer, finished = false;
    const finish = (error, value) => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); worker?.terminate();
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => finish(abortError());
    try {
      worker = new Worker('/assets/cutout-runtime/cutout-worker.mjs', {type: 'module', name: 'entity-one-cutout'});
      worker.onmessage = ({data}) => {
        if (data?.type === 'progress') progress(onProgress, data.message);
        else if (data?.type === 'diagnostic') console.error(`ENTITY-1 cutout ${data.stage}: ${data.detail}`);
        else if (data?.type === 'result' && data.mask instanceof Float32Array && data.mask.length === MODEL_SIZE * MODEL_SIZE) finish(null, data.mask);
        else if (data?.type === 'error') finish(new Error(data.message));
      };
      worker.onerror = () => finish(new Error('The background-removal tool could not load. Try again, or upload a transparent PNG.'));
      worker.onmessageerror = () => finish(new Error('Image preparation failed. Try again with a different photo.'));
      timer = setTimeout(() => finish(new Error('Image preparation took too long. Try again on a faster connection or upload a transparent PNG.')), TIMEOUT_MS);
      signal?.addEventListener('abort', cancel, {once: true});
      if (signal?.aborted) { cancel(); return; }
      worker.postMessage({pixels}, [pixels.buffer]);
    } catch { finish(new Error('Automatic background removal is unavailable in this browser. Upload a transparent PNG instead.')); }
  });
}

async function applyMask(frame, mask, signal) {
  const {width, height} = frame, pixels = frame.pixels.data;
  // Update alpha only; keep each original RGB pixel rather than synthesising the car.
  for (let y = 0; y < height; y++) {
    if (y % 96 === 0) { checkAbort(signal); await nextFrame(); }
    const my = Math.max(0, Math.min(MODEL_SIZE - 1, (y + 0.5) * MODEL_SIZE / height - 0.5));
    const y0 = Math.floor(my), y1 = Math.min(MODEL_SIZE - 1, y0 + 1), fy = my - y0;
    for (let x = 0; x < width; x++) {
      const mx = Math.max(0, Math.min(MODEL_SIZE - 1, (x + 0.5) * MODEL_SIZE / width - 0.5));
      const x0 = Math.floor(mx), x1 = Math.min(MODEL_SIZE - 1, x0 + 1), fx = mx - x0;
      const top = mask[y0 * MODEL_SIZE + x0] * (1 - fx) + mask[y0 * MODEL_SIZE + x1] * fx;
      const bottom = mask[y1 * MODEL_SIZE + x0] * (1 - fx) + mask[y1 * MODEL_SIZE + x1] * fx;
      const alpha = Math.max(0, Math.min(1, ((top * (1 - fy) + bottom * fy) - 0.02) / 0.96));
      const index = (y * width + x) * 4 + 3;
      pixels[index] = Math.round(pixels[index] * alpha);
    }
  }
}

async function finishImage(frame, signal) {
  checkAbort(signal);
  const pixels = frame.pixels.data, {width, height} = frame;
  let left = width, right = -1, top = height, bottom = -1, visible = 0;
  for (let y = 0; y < height; y++) {
    if (y % 128 === 0) { checkAbort(signal); await nextFrame(); }
    for (let x = 0; x < width; x++) if (pixels[(y * width + x) * 4 + 3] > 16) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); visible++;
    }
  }
  if (visible < width * height * 0.003 || right < left || bottom < top) {
    throw new Error('No clear car was found. Try a clearer photo or upload a transparent PNG.');
  }
  const pad = Math.max(12, Math.round(Math.max(right - left + 1, bottom - top + 1) * 0.035));
  const cropLeft = Math.max(0, left - pad), cropTop = Math.max(0, top - pad);
  const cropRight = Math.min(width - 1, right + pad), cropBottom = Math.min(height - 1, bottom + pad);
  const resultWidth = cropRight - cropLeft + 1, resultHeight = cropBottom - cropTop + 1;
  const {canvas, context} = makeCanvas(resultWidth, resultHeight);
  context.putImageData(frame.pixels, -cropLeft, -cropTop);
  try {
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('The cutout could not be saved. Try a smaller photo.')), 'image/png'));
    checkAbort(signal);
    if (blob.size > 8 * 1024 * 1024) throw new Error('The finished image is larger than 8 MB. Try a smaller source photo.');
    return {blob, width: resultWidth, height: resultHeight, sourceWidth: frame.sourceWidth, sourceHeight: frame.sourceHeight};
  } finally { canvas.width = canvas.height = 1; }
}

export async function validateTransparentImage(source, {signal} = {}) {
  const frame = await readImage(source, signal);
  try {
    if (!hasTransparency(frame)) throw new Error('This image has no transparent background. Choose a cutout PNG or WebP, or use automatic removal.');
    return await finishImage(frame, signal);
  } finally { frame.canvas.width = frame.canvas.height = 1; }
}

export async function prepareCutout(source, {onProgress, signal} = {}) {
  progress(onProgress, 'Preparing the source image…');
  const frame = await readImage(source, signal);
  try {
    if (!hasTransparency(frame)) {
      const mask = await infer(modelPixels(frame), {onProgress, signal});
      progress(onProgress, 'Finishing the transparent image…');
      await applyMask(frame, mask, signal);
    } else progress(onProgress, 'Keeping the existing transparent background…');
    return await finishImage(frame, signal);
  } finally { frame.canvas.width = frame.canvas.height = 1; }
}
