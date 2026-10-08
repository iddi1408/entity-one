// Bundled by prepare-cutout-assets.mjs. Only the administration tool loads this worker.
import * as ort from 'onnxruntime-web/wasm';

const SIZE = 320;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('/assets/cutout-runtime/', self.location.origin).href;
ort.env.logLevel = 'error';

self.onmessage = async ({data}) => {
  let session, stage = 'input';
  try {
    if (!(data?.pixels instanceof Float32Array) || data.pixels.length !== SIZE * SIZE * 3) {
      throw new Error('Invalid image input.');
    }
    self.postMessage({type: 'progress', message: 'Loading the background-removal tool…'});
    stage = 'runtime';
    session = await ort.InferenceSession.create('/assets/cutout-runtime/u2netp.onnx', {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all'
    });
    self.postMessage({type: 'progress', message: 'Separating the car from its background…'});
    stage = 'inference';
    const input = new ort.Tensor('float32', data.pixels, [1, 3, SIZE, SIZE]);
    const outputName = session.outputNames[0];
    const outputs = await session.run({[session.inputNames[0]]: input}, [outputName]);
    const output = outputs[outputName];
    if (!output || output.data.length !== SIZE * SIZE) throw new Error('Invalid model output.');
    stage = 'mask';
    const mask = new Float32Array(SIZE * SIZE);
    let minimum = Infinity, maximum = -Infinity;
    for (const value of output.data) {
      if (!Number.isFinite(value)) throw new Error('Invalid model output.');
      minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
    }
    if (maximum - minimum < 0.0001) throw new Error('No foreground found.');
    let foreground = 0;
    for (let i = 0; i < mask.length; i++) {
      mask[i] = (output.data[i] - minimum) / (maximum - minimum);
      if (mask[i] > 0.5) foreground++;
    }
    if (foreground < mask.length * 0.003 || foreground > mask.length * 0.985) {
      throw new Error('No clear foreground found.');
    }
    input.dispose(); output.dispose();
    await session.release(); session = null;
    self.postMessage({type: 'result', mask}, [mask.buffer]);
  } catch (error) {
    // Static runtime/model diagnostics only; never log image pixels or source blobs.
    self.postMessage({type: 'diagnostic', stage, detail: String(error?.message || 'Unknown runtime error').slice(0, 500)});
    try { await session?.release(); } catch { /* Worker termination also releases its memory. */ }
    self.postMessage({type: 'error', message: stage === 'runtime' ? 'The background-removal tool could not load. Try again, or upload a transparent PNG.' : 'The car could not be separated cleanly. Try a clearer photo or upload a transparent PNG.'});
  }
};
