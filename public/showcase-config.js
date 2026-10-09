const stock = {
  Porsche: {model:'911 GT3 RS', image:'/assets/porsche-911-gt3-rs.jpg', cutout:'/assets/porsche-cutout.png'},
  Lamborghini: {model:'Aventador S', image:'/assets/lamborghini-aventador-s.jpg', cutout:'/assets/lamborghini-yellow-cutout.png'},
  Ferrari: {model:'488', image:'/assets/ferrari-488.jpg', cutout:'/assets/ferrari-red-cutout.png'}
};
const available = car => car?.type === 'inventory' && ['available','reserved'].includes(car.status || 'available');
const brandKey = car => String(car.brand || '').trim().toLowerCase();
export function showcaseScale(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= .65 && value <= 1.15 ? Math.round(value * 100) / 100 : 1;
}
function defaultCutout(car) {
  const match = stock[car?.brand];
  return match && match.model === car.model && match.image === car.image ? match.cutout : null;
}
export function stockCutout(car) {
  if (car?.brand === 'Ferrari' && car.model === 'SF90' && car.image === '/assets/uploads/11bada7e-9700-4f61-b94c-1b7dc6c9bcc5.jpg') return '/assets/ferrari-sf90-cutout-clean.png';
  return defaultCutout(car);
}
export function defaultShowcase(content) {
  const seen = new Set();
  return (content?.listings || []).filter(available).flatMap(car => {
    const image = defaultCutout(car), brand = brandKey(car);
    if (!image || seen.has(brand)) return [];
    seen.add(brand);return [{listingId:car.id,image}];
  }).slice(0,12);
}
function validImage(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return false;
  if (/^\/assets\/[a-zA-Z0-9._/-]+$/.test(value) && !value.includes('..')) return true;
  try {const url = new URL(value);return url.protocol === 'https:' && !url.username && !url.password;} catch {return false;}
}
export function showcaseEntries(content) {
  const configured = Array.isArray(content?.settings?.showcase) ? content.settings.showcase : defaultShowcase(content);
  const cars = new Map((content?.listings || []).filter(available).map(car => [car.id,car]));
  const seen = new Set();
  return configured.flatMap(entry => {
    const car = cars.get(entry?.listingId);
    if (!car || !validImage(entry.image) || seen.has(brandKey(car))) return [];
    const scale = showcaseScale(entry.scale);
    seen.add(brandKey(car));return [{listingId:car.id,image:entry.image,...(scale === 1 ? {} : {scale}),car}];
  }).slice(0,12);
}
