// Frame the visible subject, not the transparent canvas around it. The same
// geometry is used for existing public cutouts and the editor's previews.
const ALPHA_THRESHOLD = 16;
const PADDING_RATIO = 0.035;
const SCAN_EDGE = 900;

export function visibleBounds(pixels, width, height) {
  let left = width, right = -1, top = height, bottom = -1, visible = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3] <= ALPHA_THRESHOLD) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y); visible++;
  }
  return right < left ? null : {left, top, width: right - left + 1, height: bottom - top + 1, visible};
}

export function cutoutPadding(bounds) {
  return Math.max(2, Math.ceil(Math.max(bounds.width, bounds.height) * PADDING_RATIO));
}

export function subjectBounds(pixels, width, height) {
  const seen = new Uint8Array(width * height), queue = new Int32Array(width * height), pieces = [];
  for (let start = 0; start < seen.length; start++) {
    if (seen[start] || pixels[start * 4 + 3] <= ALPHA_THRESHOLD) continue;
    let head = 0, tail = 1, left = width, right = 0, top = height, bottom = 0;
    queue[0] = start; seen[start] = 1;
    while (head < tail) {
      const index = queue[head++], x = index % width, y = Math.floor(index / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
          const next = ny * width + nx;
          if (!seen[next] && pixels[next * 4 + 3] > ALPHA_THRESHOLD) { seen[next] = 1; queue[tail++] = next; }
        }
      }
    }
    pieces.push({left, top, right, bottom, visible: tail});
  }
  if (!pieces.length) return null;
  const main = pieces.reduce((largest, piece) => piece.visible > largest.visible ? piece : largest);
  const proximity = Math.max(main.right - main.left + 1, main.bottom - main.top + 1) * .06;
  let left = main.left, right = main.right, top = main.top, bottom = main.bottom, visible = main.visible;
  for (const piece of pieces) {
    if (piece === main) continue;
    const nearby = piece.right >= main.left - proximity && piece.left <= main.right + proximity && piece.bottom >= main.top - proximity && piece.top <= main.bottom + proximity;
    // Keep disconnected details near the car, or any substantial component.
    // Only distant tiny fragments (a common segmentation artefact) are ignored.
    if (!nearby && piece.visible < Math.max(4, main.visible * .002)) continue;
    left = Math.min(left, piece.left); right = Math.max(right, piece.right);
    top = Math.min(top, piece.top); bottom = Math.max(bottom, piece.bottom); visible += piece.visible;
  }
  return {left, top, width: right - left + 1, height: bottom - top + 1, visible};
}

export function fitCutoutToFrame(source, bounds, frame, requestedScale = 1) {
  if (![source.width, source.height, bounds?.width, bounds?.height, frame.width, frame.height].every(value => Number.isFinite(value) && value > 0)) return null;
  const pad = cutoutPadding(bounds);
  const adjustment = Number.isFinite(requestedScale) ? Math.min(1.15, Math.max(.65, requestedScale)) : 1;
  const baseline = frame.height * .93;
  const scale = Math.min(frame.width / (bounds.width + pad * 2), baseline / (bounds.height + pad * 2)) * Math.min(1, .82 * adjustment);
  return {
    width: source.width * scale, height: source.height * scale,
    left: (frame.width - bounds.width * scale) / 2 - bounds.left * scale,
    top: baseline - (bounds.top + bounds.height) * scale
  };
}

const measurements = new Map(), prepared = new WeakMap();
let bound = false, resizeObserver;
function measure(image) {
  const source = {width: image.naturalWidth, height: image.naturalHeight};
  const fallback = {...source, left: 0, top: 0};
  // Cross-origin images without CORS remain usable with ordinary contain sizing.
  // Never reload an image or send it elsewhere just to inspect its alpha channel.
  let canvas;
  try {
    const ratio = Math.min(1, SCAN_EDGE / Math.max(source.width, source.height));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * ratio));
    canvas.height = Math.max(1, Math.round(source.height * ratio));
    const context = canvas.getContext('2d', {willReadFrequently: true});
    if (!context) return {source, bounds: fallback};
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const found = subjectBounds(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    if (!found || found.visible < canvas.width * canvas.height * 0.0005) return {source, bounds: fallback};
    // Include a scan pixel around each edge so downsampling cannot trim a mirror
    // or an anti-aliased body edge. Keep natural image pixels in the final render.
    const xRatio = source.width / canvas.width, yRatio = source.height / canvas.height;
    const left = Math.max(0, found.left - 1) * xRatio, top = Math.max(0, found.top - 1) * yRatio;
    const right = Math.min(canvas.width, found.left + found.width + 1) * xRatio;
    const bottom = Math.min(canvas.height, found.top + found.height + 1) * yRatio;
    return {source, bounds: {left, top, width: right - left, height: bottom - top}};
  } catch { return {source, bounds: fallback}; }
  finally { if (canvas) canvas.width = canvas.height = 1; }
}
function position(image) {
  const data = prepared.get(image), frame = image.parentElement;
  if (!data || !frame?.classList.contains('cutout-frame')) return;
  const requestedScale = frame.dataset.cutoutScale === undefined ? 1 : Number(frame.dataset.cutoutScale);
  const fit = fitCutoutToFrame(data.source, data.bounds, {width: frame.clientWidth, height: frame.clientHeight}, requestedScale);
  if (!fit) return;
  for (const key of ['width', 'height', 'left', 'top']) image.style[key] = `${fit[key]}px`;
}
function prepare(image) {
  if (!image.matches?.('img[data-cutout-fit]') || !image.complete || !image.naturalWidth) return;
  const key = image.currentSrc || image.src;
  if (prepared.get(image)?.key === key) { position(image); return; }
  let data = measurements.get(key);
  if (!data) {
    data = measure(image);
    // Bound the cache even after many admin image replacements.
    if (measurements.size >= 48) measurements.delete(measurements.keys().next().value);
    measurements.set(key, data);
  }
  prepared.set(image, {...data, key});
  resizeObserver?.observe(image.parentElement);
  position(image);
}

export function bindCutoutFrames() {
  if (bound) return; bound = true;
  if (typeof ResizeObserver === 'function') resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      if (!entry.target.isConnected) { resizeObserver.unobserve(entry.target); continue; }
      const image = entry.target.querySelector('img[data-cutout-fit]'); if (image) position(image);
    }
  });
  else window.addEventListener('resize', () => document.querySelectorAll('img[data-cutout-fit]').forEach(position), {passive: true});
  document.addEventListener('load', event => prepare(event.target), true);
  const scan = root => {
    if (root.nodeType !== 1) return;
    if (root.matches('img[data-cutout-fit]')) prepare(root);
    root.querySelectorAll('img[data-cutout-fit]').forEach(prepare);
  };
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const image = record.target.querySelector('img[data-cutout-fit]');
        if (image) position(image);
        continue;
      }
      record.addedNodes.forEach(scan);
      for (const root of record.removedNodes) {
        if (root.nodeType !== 1) continue;
        if (root.classList.contains('cutout-frame')) resizeObserver?.unobserve(root);
        root.querySelectorAll('.cutout-frame').forEach(frame => resizeObserver?.unobserve(frame));
      }
    }
  }).observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['data-cutout-scale']});
  document.querySelectorAll('img[data-cutout-fit]').forEach(prepare);
}
