import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createTelemetry} from '../public/telemetry.js';

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, callback) { const handlers = this.listeners.get(name) || []; handlers.push(callback); this.listeners.set(name, handlers); }
  removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(handler => handler !== callback)); }
  emit(name, event = {}) { for (const handler of this.listeners.get(name) || []) handler(event); }
}
class Element {
  constructor(tag = 'button', attributes = {}, ancestors = []) { this.tag = tag; this.attributes = attributes; this.ancestors = ancestors; this.id = attributes.id || ''; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  matches(selector) {
    return selector.split(',').some(part => {
      const value = part.trim();
      if (value.startsWith('[')) return this.hasAttribute(value.slice(1, -1));
      if (value.startsWith('#')) return this.id === value.slice(1);
      if (value.startsWith('.')) return (this.attributes.class || '').split(' ').includes(value.slice(1));
      return this.tag === value;
    });
  }
  closest(selector) { return [this, ...this.ancestors].find(element => element.matches(selector)) || null; }
}
function setup({url = 'https://example.test/', session = {authenticated: false}, navigator = {}, referrer = 'https://search.example/results?private=query', fetch} = {}) {
  const document = new Events(), scope = new Events(), timers = new Map(), sent = [];
  let timerId = 0, currentSession = session;
  Object.assign(document, {referrer, hidden: false});
  Object.assign(scope, {document, navigator, location: new URL(url), crypto: webcrypto,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, {callback, delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) { const payload = JSON.parse(options.body); sent.push({url, options, payload}); return fetch ? fetch(url, options) : {ok: true, status: 202}; }
  });
  const tracker = createTelemetry({getSession: () => currentSession, getContent: () => ({listings: [
    {id: 'public-car', brand: 'Lamborghini', type: 'inventory', status: 'available'},
    {id: 'private-car', brand: 'Private Marque', type: 'inventory', status: 'draft'}
  ]})}, scope);
  const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return {tracker, scope, document, timers, sent, tick,
    setSession(value) { currentSession = value; },
    click(element, overrides = {}) { document.emit('click', {target: element, isTrusted: true, button: 0, ...overrides}); },
    async runTimer() { const first = timers.entries().next().value; if (first) { timers.delete(first[0]); first[1].callback(); await tick(); } },
    async flush() { scope.emit('pagehide'); await tick(); },
    navigate(url) { scope.location = new URL(url, scope.location); tracker.routeChanged(); }
  };
}
const events = test => test.sent.flatMap(batch => batch.payload.events);
const car = () => new Element('button', {'data-car': 'public-car'});

// Nothing is queued before the session query resolves, even on a public page.
const ordinary = setup();
ordinary.tracker.routeChanged(); ordinary.click(car()); await ordinary.flush();
assert.equal(ordinary.sent.length, 0);
ordinary.tracker.sessionSettled(); ordinary.tracker.routeChanged(); ordinary.tracker.routeChanged();
await ordinary.runTimer();
assert.equal(events(ordinary).length, 1); assert.equal(events(ordinary)[0].type, 'page_view');
assert.equal(ordinary.sent[0].payload.referrer, 'search.example');
assert.equal(ordinary.sent[0].options.credentials, 'same-origin'); assert.equal(ordinary.sent[0].options.keepalive, true);
assert.equal(ordinary.sent[0].options.referrerPolicy, 'no-referrer');
assert.equal(ordinary.sent[0].url, '/api/analytics/events');
ordinary.navigate('/inventory?region=Europe&private=do-not-send'); ordinary.tracker.routeChanged();
ordinary.navigate('/inventory?region=America'); await ordinary.flush();
assert.equal(events(ordinary).filter(event => event.type === 'page_view').length, 3);
assert.equal(events(ordinary).at(-1).path, '/inventory');
assert.equal(JSON.stringify(ordinary.sent.map(batch => batch.payload)).includes('do-not-send'), false);
ordinary.navigate('/about'); ordinary.navigate('/inventory?region=America'); await ordinary.flush();
assert.equal(events(ordinary).filter(event => event.type === 'page_view').length, 5);

// Exactly one specialized event for each physical activation, even on nested images.
ordinary.click(new Element('img', {}, [car()]));
ordinary.click(new Element('a', {href: '/inventory?region=Gulf%20and%20Asia&extra=secret'}));
ordinary.click(new Element('a', {href: '/inventory?view=brand&brand=Mercedes-Benz'}));
ordinary.click(new Element('button', {'data-marque': 'Lamborghini'}));
ordinary.click(new Element('a', {'data-telemetry-enquiry': 'public-car', href: 'mailto:private@example.test?subject=secret'}));
ordinary.click(new Element('a', {'data-telemetry-enquiry': 'public-car', href: '/contact'}));
ordinary.click(new Element('button', {'data-car': 'private-car'}));
ordinary.click(car(), {isTrusted: false});
ordinary.click(car(), {button: 1});
await ordinary.flush();
const interactions = events(ordinary).filter(event => event.type !== 'page_view');
assert.deepEqual(interactions.map(({type, target}) => [type, target]), [
  ['car_view','public-car'], ['region_click','Gulf and Asia'], ['brand_click','Mercedes-Benz'],
  ['brand_click','Lamborghini'], ['enquiry','public-car'], ['enquiry','public-car']
]);

// Controlled categories retain useful signals without raw hrefs or form content.
const safe = setup(); safe.tracker.sessionSettled();
safe.click(new Element('a', {href: 'mailto:secret-address@example.test?body=secret-message'}));
safe.click(new Element('a', {href: 'tel:+441234567890'}));
safe.click(new Element('a', {href: 'https://wa.me/441234567890?text=private-text'}));
safe.click(new Element('a', {'data-telemetry-click': 'social_instagram', href: 'https://social.example/private-profile'}));
safe.click(new Element('a', {class: 'partner-logo', href: 'https://partner.example/secret-token'}));
safe.click(new Element('button', {'data-gallery-image': '/assets/private-filename.png'}));
safe.click(new Element('button', {'data-motion-toggle': '', 'aria-pressed': 'false'}));
safe.click(new Element('button', {'data-motion-toggle': '', 'aria-pressed': 'true'}));
safe.click(new Element('button', {id: 'menu-toggle'}));
safe.click(new Element('button', {'data-telemetry-click': 'secret-value'}));
safe.click(new Element('button', {'data-car': 'public-car'}, [new Element('form', {name: 'credentials'})]));
safe.click(new Element('a', {href: '/exclusive?username=private'}));
safe.click(new Element('a', {href: '/admin'}));
safe.click(new Element('a', {href: '/analytics-notice.html'}));
safe.click(new Element('a', {href: '/image-credits.html'}));
await safe.flush();
assert.deepEqual(events(safe).filter(event => event.type !== 'page_view').map(event => event.target), ['email','phone','whatsapp','social_instagram','partner','gallery','pause_motion','resume_motion','navigation']);
const serialized = JSON.stringify(safe.sent.map(batch => batch.payload));
for (const value of ['secret-address', 'secret-message', '441234567890', 'private-text', 'private-profile', 'secret-token', 'private-filename', 'credentials', '/admin', '/exclusive']) assert.equal(serialized.includes(value), false);
for (const event of events(safe)) {
  assert.deepEqual(Object.keys(event).sort(), ['id','type','path','target'].sort());
  assert.match(event.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
}
assert.equal(new Set(events(safe).map(event => event.id)).size, events(safe).length);

// Public route allowlist, staff exclusion, unknown-session suppression and opt-outs.
for (const options of [
  {url:'https://example.test/admin'}, {url:'https://example.test/exclusive'},
  {url:'https://example.test/analytics-notice.html'}, {session:{authenticated:true}},
  {session:{authenticated:false,unavailable:true}}, {session:{}},
  {navigator:{doNotTrack:'1'}}, {navigator:{msDoNotTrack:'1'}}, {navigator:{globalPrivacyControl:true}}
]) {
  const test = setup(options); test.tracker.sessionSettled(); test.click(car()); await test.flush(); assert.equal(test.sent.length, 0);
}
const becameStaff = setup(); becameStaff.tracker.sessionSettled();
becameStaff.setSession({authenticated:true}); await becameStaff.flush();
becameStaff.setSession({authenticated:false}); becameStaff.navigate('/inventory'); becameStaff.click(car()); await becameStaff.flush();
assert.equal(becameStaff.sent.length, 0);
const privateRoute = setup(); privateRoute.tracker.sessionSettled(); privateRoute.navigate('/exclusive'); await privateRoute.flush();
assert.equal(privateRoute.sent.length, 0);
const privacyChange = setup(); privacyChange.tracker.sessionSettled(); privacyChange.scope.navigator.globalPrivacyControl = true; await privacyChange.flush();
assert.equal(privacyChange.sent.length, 0);

// Retry reuses event/visit IDs, stays bounded, and does not retry permanent errors.
const retry = setup({fetch: async () => { throw new Error('synthetic network failure'); }});
retry.tracker.sessionSettled(); await retry.runTimer(); await retry.runTimer(); await retry.runTimer(); await retry.runTimer();
assert.equal(retry.sent.length, 3); assert.equal(retry.timers.size, 0);
assert.deepEqual(retry.sent[0].payload, retry.sent[1].payload); assert.deepEqual(retry.sent[1].payload, retry.sent[2].payload);
const permanent = setup({fetch: async () => ({ok:false,status:400})}); permanent.tracker.sessionSettled(); await permanent.flush();
assert.equal(permanent.timers.size, 0);
const limited = setup({fetch: async () => ({ok:false,status:429,headers:new Headers({'Retry-After':'60'})})}); limited.tracker.sessionSettled(); await limited.flush();
assert.equal([...limited.timers.values()][0].delay, 60000);
for (const referrer of ['http://localhost/private', 'https://127.0.0.1/private', 'https://office.internal/private', 'https://example.test/private?secret=value', 'https://www.example.test/private', 'not-a-url']) {
  const test = setup({referrer}); test.tracker.sessionSettled(); await test.flush(); assert.equal(test.sent[0].payload.referrer, '');
}
const large = setup(); large.tracker.sessionSettled();
for (let i = 0; i < 100; i++) large.click(car());
await large.tick();
for (let i = 0; i < 5; i++) await large.runTimer();
assert.ok(large.sent.length <= 4); assert.ok(large.sent.every(batch => batch.payload.events.length <= 20));
assert.equal(new Set(large.sent.map(batch => batch.payload.visitId)).size, 1);
const hidden = setup(); hidden.tracker.sessionSettled(); hidden.document.hidden = true; hidden.document.emit('visibilitychange'); await hidden.tick();
assert.equal(hidden.sent.length, 1);
const stopped = setup(); stopped.tracker.sessionSettled(); stopped.tracker.stop(); stopped.click(car()); await stopped.flush(); assert.equal(stopped.sent.length, 0);
console.log('PASS: session-gated memory-only telemetry; public route/query dedup; single specialized events; safe categories and payloads; staff/private/form exclusions; DNT/GPC; stable IDs, bounded batching/retries and hidden/pagehide flushing.');
