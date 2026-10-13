import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {brandAssets} from '../public/brand-assets.js';

// Self-contained image documents avoid external SVG image requests on Safari.
// Preserve the original raster resolution and the approved logo crop.
await mkdir('public/assets/brands/display', {recursive:true});
for (const brand of brandAssets) {
  const bytes = await readFile('public' + brand.logo);
  const mime = brand.logo.endsWith('.png') ? 'image/png' : 'image/jpeg';
  await writeFile(`public/assets/brands/display/${brand.slug}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${brand.viewBox}"><image width="${brand.width}" height="${brand.height}" xlink:href="data:${mime};base64,${bytes.toString('base64')}"/></svg>`);
}
