import {brandAssets} from './brand-assets.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const key=value=>String(value).toLowerCase().replace(/[^a-z0-9]/g,'');
const aliases={mercedes:'mercedesbenz',mercedesamg:'mercedesbenz',rangerover:'landrover'};
const canonical=value=>aliases[key(value)]||key(value);
let logoSequence=0;
export function brandMatches(actual,selected){return canonical(actual)===canonical(selected)}
export function brandLogo(name){const brand=brandAssets.find(b=>brandMatches(b.name,name));if(!brand)return `<span class="brand-logo logo-unknown">${escape(name)}</span>`;const [x,y,width,height]=brand.viewBox.split(' ').map(Number),clip='brand-art-'+(++logoSequence);return `<span class="brand-logo logo-${brand.slug}${brand.invert?' logo-invert':''}" aria-hidden="true"><svg viewBox="${brand.viewBox}" preserveAspectRatio="xMidYMid meet" focusable="false"><defs><clipPath id="${clip}" clipPathUnits="userSpaceOnUse"><rect x="${x}" y="${y}" width="${width}" height="${height}"/></clipPath></defs><image href="${escape(brand.logo)}" width="${brand.width}" height="${brand.height}" clip-path="url(#${clip})"/></svg></span>`}
export function availableBrands(listings){const brands=brandAssets.map(b=>b.name);for(const car of listings)if(!brands.some(b=>brandMatches(b,car.brand)))brands.push(car.brand);return brands}
export function brandSelector(listings,selected,type='inventory'){
 if(selected)return `<div class="selected-marque">${brandLogo(selected)}<div><span class="micro">SELECTED MARQUE</span><h2>${escape(selected)}</h2></div><a href="/${type}?view=brand" class="underlined-link">ALL MARQUES</a></div>`;
 return `<div class="brand-grid">${availableBrands(listings).map(name=>{const count=listings.filter(c=>brandMatches(c.brand,name)).length;return `<a class="brand-card" href="/${type}?view=brand&brand=${encodeURIComponent(name)}" aria-label="Browse ${escape(name)} ${type}">${brandLogo(name)}<h2>${escape(name)}</h2><span class="micro ${count?'has-stock':''}">${count?`${String(count).padStart(2,'0')} ${count===1?'automobile':'automobiles'}`:'Enquire to source'}</span></a>`}).join('')}</div>`;
}
