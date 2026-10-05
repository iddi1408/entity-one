import {h,safeUrl} from './app.js';
const localPhotos=new Set(['porsche-911-gt3-rs','lamborghini-aventador-s','ferrari-488']);

// Keep authored/remote listings intact; supply responsive originals for the local collection.
export function photoAttributes(source,sizes='(max-width: 780px) 90vw, 32vw'){
  const url=safeUrl(source);
  let name='';
  try{const parsed=new URL(url);if(parsed.origin===location.origin)name=parsed.pathname.match(/^\/assets\/([^/]+)\.jpg$/)?.[1]||'';}catch{}
  if(!localPhotos.has(name))return `src="${h(url)}"`;
  return `src="/assets/${name}.jpg" srcset="/assets/${name}.jpg 1800w, /assets/${name}-3200.jpg 3200w" sizes="${h(sizes)}"`;
}
