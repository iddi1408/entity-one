import {brandAssets} from './brand-assets.js';
import {brandMatches} from './brands.js';

const paths = new Set(['/', '/inventory', '/wanted', '/about', '/contact']);
const regions = new Set(['America', 'Europe', 'Gulf and Asia']);
const clickTargets = new Set(['navigation', 'inventory', 'wanted', 'about', 'contact', 'browse_inventory', 'browse_wanted', 'view_all_inventory', 'view_all_wanted', 'email', 'phone', 'whatsapp', 'gallery', 'copy_link', 'share', 'pause_motion', 'resume_motion']);
const socialHosts = new Map([['instagram', ['instagram.com']], ['tiktok', ['tiktok.com']], ['x', ['x.com', 'twitter.com']], ['linkedin', ['linkedin.com']], ['reddit', ['reddit.com']]]);
const pagePath = value => value.replace(/\/$/, '') || '/';
const MAX_QUEUE = 60, MAX_BATCH = 20, DELAY = 1500;

/** First-party, memory-only measurement. Unknown sessions always fail closed. */
export function createTelemetry({getSession, getContent}, scope = globalThis) {
  const document = scope.document;
  let settled = false, staffTab = false, visitId = null, lastRoute = null;
  let queue = [], timer = null, sending = false, stopped = false;
  function clearQueue() {
    queue = [];
    if (timer !== null) scope.clearTimeout(timer);
    timer = null;
  }
  function eligible() {
    let session;
    try { session = getSession(); } catch { return false; }
    if (session?.authenticated === true) staffTab = true;
    const optedOut = scope.navigator?.globalPrivacyControl === true || [scope.navigator?.doNotTrack, scope.navigator?.msDoNotTrack, scope.doNotTrack].some(value => value === '1' || value === 'yes');
    const allowed = !stopped && settled && !staffTab && !optedOut && session?.authenticated === false && !session.unavailable && paths.has(pagePath(scope.location.pathname)) && typeof scope.crypto?.randomUUID === 'function';
    if (!allowed) clearQueue();
    return allowed;
  }
  function publicListings() {
    try { return (getContent()?.listings || []).filter(car => !['draft', 'sold', 'fulfilled'].includes(car.status)); } catch { return []; }
  }
  function listingId(value) {
    return typeof value === 'string' && value.length <= 200 && publicListings().some(car => car.id === value) ? value : null;
  }
  function brandName(value) {
    if (typeof value !== 'string' || value.length > 200) return null;
    return [...brandAssets.map(brand => brand.name), ...publicListings().map(car => car.brand)].find(name => brandMatches(name, value)) || null;
  }
  function referrerHost() {
    try {
      const url = new URL(document.referrer);
      const host = url.hostname.toLowerCase().replace(/\.$/, ''), labels = host.split('.');
      if (!['https:', 'http:'].includes(url.protocol) || host.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels.at(-1)) || /(?:^|\.)(localhost|local|internal)$/.test(host)) return '';
      return host.replace(/^www\./, '') === scope.location.hostname.toLowerCase().replace(/^www\./, '') ? '' : host;
    } catch { return ''; }
  }
  function schedule(delay = DELAY) {
    if (timer !== null) scope.clearTimeout(timer);
    timer = scope.setTimeout(() => { timer = null; void flush(); }, delay);
  }
  function record(type, target = '') {
    if (!eligible()) return;
    if (!visitId) visitId = scope.crypto.randomUUID();
    queue.push({event: {id: scope.crypto.randomUUID(), type, path: pagePath(scope.location.pathname), target}, attempts: 0});
    if (queue.length > MAX_QUEUE) queue.shift();
    if (queue.length >= MAX_BATCH) void flush(); else schedule();
  }
  async function flush() {
    if (!eligible() || sending || !queue.length) return;
    if (timer !== null) scope.clearTimeout(timer);
    timer = null;
    const batch = queue.splice(0, MAX_BATCH);
    sending = true;
    let retry = false, retryDelay = DELAY * 2;
    try {
      const response = await scope.fetch('/api/analytics/events', {method: 'POST', credentials: 'same-origin', keepalive: true, referrerPolicy: 'no-referrer',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({visitId, referrer: referrerHost(), events: batch.map(item => item.event)})});
      retry = !response.ok && (response.status === 429 || response.status >= 500);
      if (response.status === 429) {
        const after = Number(response.headers?.get('Retry-After'));
        if (Number.isFinite(after) && after > 0) retryDelay = Math.min(60000, Math.max(retryDelay, after * 1000));
      }
    } catch { retry = true; }
    finally {
      sending = false;
      if (eligible()) {
        if (retry) queue = [...batch.filter(item => ++item.attempts <= 2), ...queue].slice(0, MAX_QUEUE);
        if (queue.length) {
          if (document.hidden && !retry) void flush();
          else schedule(retry ? retryDelay : DELAY);
        }
      }
    }
  }
  function routeChanged() {
    const path = pagePath(scope.location.pathname);
    if (!paths.has(path)) lastRoute = null;
    if (!eligible()) return;
    // Query filters distinguish navigation in memory, but no query is transmitted.
    const route = path + scope.location.search;
    if (lastRoute === route) return;
    lastRoute = route;
    record('page_view');
  }
  function click(event) {
    if (event.isTrusted === false || event.button > 0 || !eligible()) return;
    const element = event.target?.closest?.('a, button, [data-car], [data-marque], [data-telemetry-click]');
    if (!element || element.closest('form, input, textarea, select, [contenteditable], [disabled], [aria-disabled="true" i]') || element.hasAttribute('download')) return;
    const anchor = element.closest('a');
    let destination;
    const href = anchor?.getAttribute('href')?.trim();
    try { if (href && !href.startsWith('#')) destination = new URL(href, scope.location.href); } catch { return; }
    // Private destinations never produce navigation or interaction events.
    if (destination?.origin === scope.location.origin && !paths.has(pagePath(destination.pathname))) return;
    const controls = anchor && anchor !== element ? [element, anchor] : [element];
    const annotation = element.getAttribute('data-telemetry-click');
    const socialNames = controls.flatMap(control => {
      const tag = control.getAttribute('data-social'), annotated = /^(?:social_|outbound_)(.*)$/.exec(control.getAttribute('data-telemetry-click') || '');
      return [...(tag === null ? [] : [tag]), ...(annotated ? [annotated[1]] : [])];
    });
    const hostname = destination?.hostname.toLowerCase().replace(/\.$/, '');
    const externalHTTPS = !!anchor && destination?.protocol === 'https:' && !destination.username && !destination.password && hostname !== scope.location.hostname.toLowerCase().replace(/\.$/, '');
    // Destination checks precede annotations so placeholders cannot become real clicks.
    if (socialNames.length) {
      const social = socialNames[0], hosts = socialHosts.get(social);
      if (externalHTTPS && hosts && socialNames.every(name => name === social) && hosts.some(host => hostname === host || hostname.endsWith('.' + host))) record('click', 'outbound_' + social);
      return;
    }
    if (controls.some(control => control.matches('.partner-logo, [data-partner]') || control.getAttribute('data-telemetry-click') === 'partner')) {
      if (externalHTTPS) record('click', 'partner');
      return;
    }
    const enquiry = listingId(element.getAttribute('data-telemetry-enquiry'));
    if (enquiry) { record('enquiry', enquiry); return; }
    const car = listingId(element.getAttribute('data-car'));
    if (car) { record('car_view', car); return; }
    const marque = brandName(element.getAttribute('data-marque'));
    if (marque) { record('brand_click', marque); return; }
    if (clickTargets.has(annotation)) { record('click', annotation); return; }
    if (element.hasAttribute('data-gallery-image')) { record('click', 'gallery'); return; }
    if (element.matches('[data-motion-toggle], #film-toggle')) { record('click', element.getAttribute('aria-pressed') === 'true' ? 'resume_motion' : 'pause_motion'); return; }
    if (element.id === 'menu-toggle') { record('click', 'navigation'); return; }
    if (!destination) return;
    if (destination.protocol === 'mailto:') { record('enquiry', 'email'); return; }
    if (destination.protocol === 'tel:') { record('enquiry', 'phone'); return; }
    if (destination.protocol === 'https:' && ['wa.me', 'api.whatsapp.com', 'web.whatsapp.com'].includes(destination.hostname)) { record('enquiry', 'whatsapp'); return; }
    if (destination.origin !== scope.location.origin) return;
    const region = destination.searchParams.get('region');
    if (regions.has(region)) { record('region_click', region); return; }
    const brand = brandName(destination.searchParams.get('brand'));
    if (brand) { record('brand_click', brand); return; }
    const path = pagePath(destination.pathname), inNavigation = !!element.closest('nav');
    if (path === '/contact' && !inNavigation) { record('enquiry', 'contact'); return; }
    if (['/inventory', '/wanted'].includes(path)) {
      const type = path.slice(1), all = destination.searchParams.get('view') === 'all' || !!element.closest('.section-bottom-link');
      record('click', inNavigation ? type : (all ? 'view_all_' : 'browse_') + type); return;
    }
    record('click', path === '/' ? 'navigation' : path.slice(1));
  }
  const hidden = () => { if (document.hidden) void flush(); };
  const pagehide = () => { void flush(); };
  document.addEventListener('click', click, {capture: true});
  document.addEventListener('visibilitychange', hidden);
  scope.addEventListener('pagehide', pagehide);
  return {
    routeChanged,
    sessionSettled() { settled = true; routeChanged(); },
    stop() { stopped = true; clearQueue(); document.removeEventListener('click', click, {capture: true}); document.removeEventListener('visibilitychange', hidden); scope.removeEventListener('pagehide', pagehide); }
  };
}
