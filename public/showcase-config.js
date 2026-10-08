const stock = {
  Porsche: {model:'911 GT3 RS', image:'/assets/porsche-911-gt3-rs.jpg', cutout:'/assets/porsche-cutout.png'},
  Lamborghini: {model:'Aventador S', image:'/assets/lamborghini-aventador-s.jpg', cutout:'/assets/lamborghini-yellow-cutout.png'},
  Ferrari: {model:'488', image:'/assets/ferrari-488.jpg', cutout:'/assets/ferrari-red-cutout.png'}
};
const available = car => car?.type === 'inventory' && ['available','reserved'].includes(car.status || 'available');
const brandKey = car => String(car.brand || '').trim().toLowerCase();
export function stockCutout(car) {
  const match = stock[car?.brand];
  return match && match.model === car.model && match.image === car.image ? match.cutout : null;
}
export function defaultShowcase(content) {
  const seen = new Set();
  return (content?.listings || []).filter(available).flatMap(car => {
    const image = stockCutout(car), brand = brandKey(car);
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
    seen.add(brandKey(car));return [{listingId:car.id,image:entry.image,car}];
  }).slice(0,12);
}
