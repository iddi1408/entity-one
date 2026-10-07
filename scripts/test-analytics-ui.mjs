import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the dashboard's public entry points and delegated controls without a
// browser, live credentials, production data, or access to external services.
const source = (await readFile(new URL('../public/analytics.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
  + '\n globalThis.ui={analyticsPanel,ensureAnalyticsData,clearAnalyticsData,bindAnalytics};';
const DAY = 86400000, NOW = Date.parse('2026-10-07T15:30:00Z');
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
const day = ago => new Date(NOW - ago * DAY).toISOString().slice(0, 10);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const contains = (text, part, message) => ok(text.includes(part), message || `Expected ${part}`);
const omits = (text, part, message) => ok(!text.includes(part), message || `Unexpected ${part}`);
function fixture(overrides = {}) {
  return {
    range: {from:day(6),to:day(0),days:7,previousFrom:day(13),previousTo:day(7),timezone:'UTC'},
    totals:{visits:3,pageViews:4,clicks:16,carViews:2,enquiries:1,regionClicks:1,brandClicks:1},
    previous:{visits:0,pageViews:0,clicks:0,carViews:0,enquiries:0,regionClicks:0,brandClicks:0},
    trend:Array.from({length:7},(_,index)=>({date:day(6-index),visits:index<4?0:1,pageViews:index===6?2:index<4?0:1,clicks:index===6?16:0,carViews:index===6?2:0,enquiries:index===6?1:0})),
    countries:[{key:'GB',label:'United Kingdom',visits:2},{key:'XX',label:'Unknown',visits:1}],
    devices:[{key:'mobile',label:'Mobile',visits:3}], browsers:[{key:'safari',label:'Safari',visits:3}],
    sources:[{key:'',label:'Not shared / direct',visits:2},{key:'instagram.com',label:'instagram.com',visits:1}],
    pages:[{key:'/inventory',label:'Inventory',views:4,clicks:16}],
    cars:[{id:'ferrari-one',label:'Ferrari F50',brand:'Ferrari',region:'Europe',type:'inventory',views:2,enquiries:1}],
    regions:[{key:'Europe',label:'Europe',clicks:1}], brands:[{key:'Ferrari',label:'Ferrari',clicks:1}],
    actions:[{key:'outbound_instagram',label:'Instagram link clicks',clicks:4},{key:'social_instagram',label:'Instagram icon (legacy)',clicks:7},{key:'navigation',label:'Navigation',clicks:2}],
    meta:{startedAt:day(2)+'T12:00:00.000Z',generatedAt:'2026-10-07T15:00:00.000Z',lastEventAt:'2026-10-07T14:58:00.000Z',sourceKnownVisits:1,sourceUnknownVisits:2,retentionDays:90,comparisonAvailable:false,comparisonUnavailableReason:'The selected period includes today, which is not yet complete in UTC.'},
    ...overrides
  };
}
function harness() {
  const state = {adminTab:'analytics',session:{authenticated:true,user:{id:'owner',permissions:['analytics.read']},session:{id:'session-one'}}};
  const listeners = new Map(), requests = [], downloads = [], notifications = [], blobs = new Map();
  const nodes = {error:{hidden:true,textContent:''},draft:{hidden:true},export:{disabled:true},details:{open:false},from:{focus(){}}};
  let renders = 0;
  const document = {
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(listener); },
    querySelector(selector) { if(selector.includes('.form-error'))return nodes.error;if(selector.includes('data-analytics-draft'))return nodes.draft;if(selector.includes('data-analytics-export'))return nodes.export;if(selector.includes('analytics-filter-details'))return nodes.details;if(selector.includes('[name=from]'))return nodes.from;return null; },
    querySelectorAll() { return []; },
    body:{append(){}},
    createElement(tag) { assert.equal(tag,'a');return {click(){downloads.push({blob:blobs.get(this.href),filename:this.download});},remove(){}}; }
  };
  class TestURL extends URL {
    static createObjectURL(blob) { const id='blob:test-'+blobs.size;blobs.set(id,blob);return id; }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    state, h:escape, render(){renders++;},notify(message){notifications.push(message);},
    api(url,options={}) { return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})); },
    can(permission){return state.session.authenticated&&state.session.user?.permissions?.includes(permission);},
    needsPasswordChange(){return !!state.session.mustChangePassword;},
    location:{pathname:'/admin'},document,URL:TestURL,URLSearchParams,AbortController,Blob,Intl,Date:Clock,
    setTimeout(){return 1;},clearTimeout(){},console
  });
  vm.runInContext(source,context,{filename:'public/analytics.js'});
  context.ui.bindAnalytics();
  const dispatch = async (name,event) => { for(const listener of listeners.get(name)||[]) await listener(event); };
  const button = attrs => ({dataset:Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,char)=>char.toUpperCase()),value])),disabled:false,hasAttribute(key){return Object.hasOwn(attrs,key);},closest(selector){return selector==='button'?this:null;}});
  const input = (name,value) => ({name,value,closest(selector){return selector==='#analytics-filters'?{id:'analytics-filters'}:null;},matches(){return false;}});
  return {
    ...context.ui,state,requests,downloads,nodes,notifications,
    get renders(){return renders;},
    async click(attrs){await dispatch('click',{target:button(attrs)});},
    async input(name,value){await dispatch('input',{target:input(name,value)});await dispatch('change',{target:input(name,value)});},
    async submit(){await dispatch('submit',{target:{id:'analytics-filters'},preventDefault(){}});},
    async metric(value){await dispatch('change',{target:{value,matches(selector){return selector==='[data-analytics-metric]';},closest(){return null;}}});}
  };
}
const exportDisabled = html => /<button\b[^>]*data-analytics-export[^>]*\bdisabled\b/.test(html);
async function load(h, data = fixture()) { const pending=h.ensureAnalyticsData();h.requests.at(-1).resolve(data);await pending;return h.analyticsPanel(); }

// Permission failures cannot request, render or export private analytics.
for (const mutate of [h=>h.state.session.authenticated=false,h=>h.state.session.user.permissions=[],h=>h.state.session.mustChangePassword=true]) {
  const h=harness();mutate(h);equal(h.analyticsPanel(),'');await h.ensureAnalyticsData();equal(h.requests.length,0);await h.click({'data-analytics-export':''});equal(h.downloads.length,0);
}
{
  const h=harness();
  let html=h.analyticsPanel();ok(exportDisabled(html),'No report means no export');omits(html,'an-kpi-button','Missing report is not five fabricated zero counters');
  const pending=h.ensureAnalyticsData();html=h.analyticsPanel();contains(html,'Loading recorded activity');ok(exportDisabled(html),'Loading report cannot export');
  h.requests[0].reject(Error('Network unavailable'));await pending;html=h.analyticsPanel();contains(html,'Report unavailable');contains(html,'Missing data is not shown as zero');ok(exportDisabled(html));
  await h.click({'data-analytics-export':''});equal(h.downloads.length,0);
}
{
  const h=harness();let html=await load(h);
  contains(html,'Page-load visits');contains(html,'Not unique people');contains(html,'Contact clicks');contains(html,'Not confirmed messages');
  ok(!exportDisabled(html),'Successful current report can export');
  contains(html,'Browser reported');contains(html,'1 <small>/ 3</small>','Coverage separates the one known source from three visits');
  contains(html,'<b>2</b> not shared / direct');contains(html,'not verified by those platforms');
  contains(html,'Last recorded activity');contains(html,'Report generated');omits(html,'an-compare','Incomplete periods must not display growth');
  contains(html,'Dates before collection are omitted');
  const early=html.match(new RegExp(`<tr><th scope="row">${day(6)}</th>([\\s\\S]*?)</tr>`))?.[1]||'';
  contains(early,'Not collected');equal((early.match(/<td>—<\/td>/g)||[]).length,5,'All metrics before collection are unavailable, not zero');
  contains(html,'Collection began during this day');contains(html,'Today · incomplete');
  const svg=html.match(/<svg class="an-trend-svg"[\s\S]*?<\/svg>/)?.[0]||'';
  equal((svg.match(/<circle /g)||[]).length,3,'Only collected days are charted');
  await h.click({'data-analytics-section':'audience'});html=h.analyticsPanel();contains(html,'Incoming referrer websites');contains(html,'instagram.com');omits(html,'Instagram link clicks');omits(html,'Instagram icon (legacy)');
  await h.click({'data-analytics-section':'cars'});html=h.analyticsPanel();contains(html,'Outgoing social links');contains(html,'Instagram link clicks');contains(html,'Historical social icon clicks');contains(html,'Older tracking also counted placeholder buttons');omits(html,'instagram.com');
  await h.click({'data-analytics-export':''});equal(h.downloads.length,1);
  const csv=await h.downloads[0].blob.text();
  contains(csv,'Not collected','CSV cannot turn uncollected history into measured zeros');
  const csvEarly=csv.split('\r\n').find(row=>row.startsWith('"'+day(6)+'"'))||'';
  contains(csvEarly,'Not collected');omits(csvEarly,'"0"','Uncollected daily cells must be blank/unavailable in exports');
  contains(csv,'Instagram link clicks');contains(csv,'Instagram icon (legacy)');contains(csv,'instagram.com');
  const refresh=h.ensureAnalyticsData(true);ok(exportDisabled(h.analyticsPanel()));await h.click({'data-analytics-export':''});equal(h.downloads.length,1,'Handler enforces disabled export during refresh');
  h.requests.at(-1).reject(Error('Temporary network error'));await refresh;html=h.analyticsPanel();contains(html,'last successful report');contains(html,'Refresh needed');ok(exportDisabled(html));
  await h.click({'data-analytics-export':''});equal(h.downloads.length,1,'Failed refresh cannot export stale data as fresh');
  const retry=h.ensureAnalyticsData(true);h.requests.at(-1).resolve(fixture());await retry;ok(!exportDisabled(h.analyticsPanel()),'Retry restores fresh report export');
  await h.input('country','GB');html=h.analyticsPanel();contains(html,'Filters changed. Apply');ok(exportDisabled(html),'Draft filters disable export');
  await h.click({'data-analytics-export':''});equal(h.downloads.length,1,'Draft filters also block the export handler');
  const apply=h.submit();ok(h.requests.at(-1).url.includes('country=GB'));ok(exportDisabled(h.analyticsPanel()));h.requests.at(-1).resolve(fixture());await apply;ok(!exportDisabled(h.analyticsPanel()));
}
// An aborted request may still resolve. Only the latest report may win.
{
  const h=harness(),old=h.ensureAnalyticsData(),oldRequest=h.requests[0];
  const current=h.ensureAnalyticsData(true);ok(oldRequest.options.signal.aborted,'Superseded request is cancelled');
  h.requests[1].resolve(fixture({cars:[{label:'Current Ferrari',views:3}]}));await current;
  oldRequest.resolve(fixture({cars:[{label:'Stale Porsche',views:99}]}));await old;
  contains(h.analyticsPanel(),'Current Ferrari');omits(h.analyticsPanel(),'Stale Porsche');
  const pending=h.ensureAnalyticsData(true),request=h.requests.at(-1);h.clearAnalyticsData();ok(request.options.signal.aborted);request.resolve(fixture({cars:[{label:'After logout secret',views:99}]}));await pending;omits(h.analyticsPanel(),'After logout secret');ok(exportDisabled(h.analyticsPanel()));
}
for (const mutate of [h=>h.state.session.authenticated=false,h=>h.state.session.user.permissions=[],h=>h.state.session.mustChangePassword=true]) {
  const h=harness();await load(h);const pending=h.ensureAnalyticsData(true);mutate(h);h.requests.at(-1).resolve(fixture());await pending;equal(h.analyticsPanel(),'');await h.click({'data-analytics-export':''});equal(h.downloads.length,0,'Authorization loss blocks late-response export');
}
{
  const h=harness();await load(h);h.state.session.session.id='new-session';omits(h.analyticsPanel(),'an-kpi-button','Report belongs to the session which requested it');ok(exportDisabled(h.analyticsPanel()));
  const pending=h.ensureAnalyticsData();h.requests.at(-1).resolve(fixture());await pending;ok(!exportDisabled(h.analyticsPanel()));
}
{
  const h=harness();await load(h,fixture({meta:{startedAt:null,sourceKnownVisits:0,sourceUnknownVisits:0,comparisonAvailable:false},totals:{visits:0,pageViews:0,clicks:0,carViews:0,enquiries:0},trend:fixture().trend.map(row=>({...row,visits:0,pageViews:0,clicks:0,carViews:0,enquiries:0})),cars:[]}));
  const html=h.analyticsPanel();contains(html,'No collected data for these dates');omits(html,'an-trend-svg');contains(html,'Not recorded yet');contains(html,'Not collected');omits(html,'NaN');omits(html,'Infinity');
}
{
  const h=harness();await load(h,fixture({cars:[{id:'malicious',label:'<img src=x onerror=alert(1)>',brand:'=HYPERLINK("https://example.test")',region:'Europe',views:1}]}));
  const html=h.analyticsPanel();omits(html,'<img src=x');contains(html,'&lt;img src=x');
  await h.click({'data-analytics-export':''});const csv=await h.downloads[0].blob.text();contains(csv,"'=HYPERLINK",'CSV formulas are escaped');
}
console.log(`PASS: ${checks} analytics UI checks covering permissions, request races, stale/error/draft export guards, collection coverage, honest source/outbound/legacy labels, empty states and CSV safety.`);
