import {build} from 'esbuild';
import path from 'node:path';

export async function compileWorker({applicationPath = path.resolve('worker/application.js'), assets = {}, content}) {
  const result = await build({
    entryPoints: [applicationPath], bundle: true, write: false, format: 'esm',
    platform: 'browser', target: 'es2022', legalComments: 'inline',
    banner: {js: `const STATIC_ASSETS=${JSON.stringify(assets)};\nconst DEFAULT_CONTENT=${JSON.stringify(content)};`},
  });
  return result.outputFiles[0].text;
}
