import {state,h,api,render,notify} from './app.js';
import {can,needsPasswordChange} from './access.js';

const DAY=86400000;
const metricLabels={visits:'Page-load visits',pageViews:'Page views',clicks:'Recorded clicks',carViews:'Car opens',enquiries:'Contact clicks'};
const metricHelp={visits:'Reloads and new tabs count again. Not unique people.',pageViews:'Public pages opened, including navigation within a visit.',clicks:'Tracked buttons and links. Includes car opens and contact clicks.',carViews:'Times someone opened a car’s details.',enquiries:'Contact or enquiry links selected. Not confirmed messages.'};
const utcDay=()=>new Date().toISOString().slice(0,10);
const presetRange=days=>({from:new Date(Date.parse(utcDay()+'T00:00:00Z')-(days-1)*DAY).toISOString().slice(0,10),to:utcDay()});
const defaults=()=>({...presetRange(7),country:'',device:'',preset:'7'});
let filters=defaults(),applied={...filters},report=null,reportError='',busy=false,attemptedKey='',requestVersion=0,controller=null,section='overview',metric='visits',bound=false;
let knownCountries=new Map(),updatedAt=null,reportKey='',filtersOpen=false;
const count=value=>Math.max(0,Number.isFinite(Number(value))?Number(value):0);
const number=value=>new Intl.NumberFormat(undefined,{maximumFractionDigits:0}).format(count(value));
const shortDate=value=>{const date=new Date(String(value)+'T00:00:00Z');return Number.isNaN(date.getTime())?'—':date.toLocaleDateString(undefined,{day:'numeric',month:'short',timeZone:'UTC'});};
const dateText=value=>{if(!value)return '';const date=new Date(typeof value==='number'?value*1000:value);return Number.isNaN(date.getTime())?'':date.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});};
const requestKey=()=>JSON.stringify([state.session.user?.id,state.session.session?.id,applied.from,applied.to,applied.country,applied.device]);
const authorized=()=>state.session.authenticated&&!needsPasswordChange()&&can('analytics.read');
const hasDraft=()=>['from','to','country','device'].some(key=>filters[key]!==applied[key]);
const exportReady=()=>authorized()&&report&&reportKey===requestKey()&&!busy&&!reportError&&!hasDraft();
const timeText=value=>{const date=new Date(value);return value&&!Number.isNaN(date.getTime())?date.toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'UTC'})+' UTC':'Not recorded yet';};
const collectionDay=()=>report?.meta?.startedAt?.slice(0,10)||null;
const measured=row=>!!collectionDay()&&row.date>=collectionDay();
const dayStatus=row=>!measured(row)?'Not collected':row.date===utcDay()?'Today · incomplete':row.date===collectionDay()&&report.meta.startedAt.slice(11,19)!=='00:00:00'?'Collection began during this day':'Recorded';
export function clearAnalyticsData(){requestVersion++;controller?.abort();controller=null;filters=defaults();applied={...filters};report=null;reportKey='';reportError='';busy=false;attemptedKey='';section='overview';metric='visits';knownCountries=new Map();updatedAt=null;filtersOpen=false;}
export async function ensureAnalyticsData(force=false){
 if(state.adminTab!=='analytics'||!authorized())return;
 const key=requestKey();if(!force&&attemptedKey===key)return;
 controller?.abort();const abort=new AbortController();controller=abort;const version=++requestVersion;attemptedKey=key;busy=true;reportError='';if(reportKey!==key){report=null;updatedAt=null;}
 const query=new URLSearchParams({from:applied.from,to:applied.to});if(applied.country)query.set('country',applied.country);if(applied.device)query.set('device',applied.device);
 const current=()=>version===requestVersion&&authorized()&&key===requestKey();
 if(location.pathname==='/admin'&&state.adminTab==='analytics')render();
 try{const result=await api('/analytics?'+query,{signal:abort.signal});if(!current())return;report=result;reportKey=key;updatedAt=new Date();for(const country of result.countries||[])if(/^(?:[A-Z]{2}|XX)$/.test(country.key))knownCountries.set(country.key,country.label||country.key);}
 catch(error){if(current()&&error.name!=='AbortError')reportError=error.message||'Analytics could not be loaded.';}
 finally{if(current()){busy=false;controller=null;if(location.pathname==='/admin'&&state.adminTab==='analytics')render();}}
}
function validateRange(values){const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;try{if(!valid(values.from)||!valid(values.to))return 'Choose a valid start and end date.';}catch{return 'Choose a valid start and end date.';}const days=(Date.parse(values.to)-Date.parse(values.from))/DAY+1;if(days<1)return 'The end date must be on or after the start date.';if(days>90)return 'Choose a range of 90 days or fewer.';if(values.to>utcDay())return 'Choose dates up to today.';if(values.from<presetRange(90).from)return 'Choose dates within the last 90 days.';if(values.country&&!/^(?:[A-Z]{2}|XX)$/.test(values.country))return 'Choose a country from the list.';if(values.device&&!['desktop','mobile','tablet','unknown'].includes(values.device))return 'Choose a device from the list.';return '';}
function filterControls(){
 const countries=[...knownCountries].sort((a,b)=>a[1].localeCompare(b[1]));
 if(filters.country&&!knownCountries.has(filters.country))countries.push([filters.country,filters.country]);
 const audience=[applied.country?(knownCountries.get(applied.country)||applied.country):'All countries',applied.device||'All devices'].join(' · ');
 return `<form id="analytics-filters" class="adm-form an-filters">
  <div class="an-filter-top"><div class="an-presets" role="group" aria-label="Date range">${[['1','Today'],['7','7 days'],['30','30 days'],['90','90 days'],['custom','Custom']].map(([value,label])=>`<button type="button" data-analytics-preset="${value}" aria-pressed="${filters.preset===value}">${label}</button>`).join('')}</div>
  <div class="an-tools"><button type="button" class="adm-text" data-analytics-refresh ${busy?'disabled':''}>Refresh ↻</button><button type="button" class="adm-text" data-analytics-export ${exportReady()?'':'disabled'}>Export CSV ↓</button></div></div>
  <details class="an-filter-details" id="analytics-filter-details" ${filtersOpen?'open':''}><summary>Dates & audience filters <span class="an-filter-summary">${h(audience)}</span></summary>
  <div class="an-filter-fields"><label>From<input type="date" name="from" required value="${h(filters.from)}" min="${presetRange(90).from}" max="${utcDay()}"></label><label>To<input type="date" name="to" required value="${h(filters.to)}" min="${presetRange(90).from}" max="${utcDay()}"></label>
  <label>Visitor country<select name="country"><option value="">All countries</option>${countries.map(([key,label])=>`<option value="${h(key)}" ${filters.country===key?'selected':''}>${h(label)}</option>`).join('')}</select></label>
  <label>Device<select name="device"><option value="">All devices</option>${[['desktop','Desktop'],['mobile','Mobile'],['tablet','Tablet'],['unknown','Unknown']].map(([key,label])=>`<option value="${key}" ${filters.device===key?'selected':''}>${label}</option>`).join('')}</select></label><button type="submit" class="adm-primary">Apply filters ↗</button><button type="button" class="adm-secondary" data-analytics-clear>Reset</button></div>
  <p class="an-filter-note">Dates include both days and use UTC. History is kept for 90 days.</p><p class="an-filter-note" data-analytics-draft ${hasDraft()?'':'hidden'}>Filters changed. Apply them to update the report and export.</p><p class="form-error" role="alert" hidden></p></details>
  <p class="an-filter-summary">Showing ${h(shortDate(applied.from))} – ${h(shortDate(applied.to))} · ${h(audience)} · UTC</p></form>`;
}
function comparison(key){
 if(!report.meta?.comparisonAvailable)return '';
 const current=count(report.totals?.[key]),previous=count(report.previous?.[key]);
 if(previous===0)return `<span class="an-compare">${current?'No previous activity to compare':'No change from previous period'}</span>`;
 const percent=Math.round((current-previous)/previous*100);
 return `<span class="an-compare"><b>${percent>0?'+':''}${percent}%</b> vs previous period</span>`;
}
function kpis(){return `<div class="an-kpis">${['visits','pageViews','clicks','enquiries'].map(key=>`<article><button class="an-kpi-button" data-analytics-metric-button="${key}" aria-pressed="${section==='overview'&&metric===key}"><span>${metricLabels[key]}</span><strong>${number(report.totals?.[key])}</strong><small>${metricHelp[key]}</small>${comparison(key)}</button></article>`).join('')}</div>`;}
function emptyAnalytics(title,copy){return `<div class="an-empty"><span aria-hidden="true">◷</span><h3>${h(title)}</h3><p>${h(copy)}</p></div>`;}
function trendChart(){
 const rows=(report.trend||[]).filter(measured),values=rows.map(row=>count(row[metric])),maximum=Math.max(0,...values),width=700,height=235,left=42,right=20,top=20,bottom=35,plotWidth=width-left-right,plotHeight=height-top-bottom;
 const total=count(report.totals?.[metric]),niceMax=maximum?Math.ceil(maximum/(10**Math.floor(Math.log10(maximum))))*(10**Math.floor(Math.log10(maximum))):1;
 const summary=`${number(total)} ${metricLabels[metric].toLowerCase()} recorded in the selected period.`;
 let chart='';
 if(maximum>0){
  const points=values.map((value,index)=>[left+(values.length===1?.5:index/(values.length-1))*plotWidth,top+(1-value/niceMax)*plotHeight]);
  const line=points.map(point=>point.join(',')).join(' '),area=`${points[0][0]},${top+plotHeight} ${line} ${points.at(-1)[0]},${top+plotHeight}`,labels=[...new Set([0,Math.floor((rows.length-1)/2),rows.length-1])];
  chart=`<svg class="an-trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="an-chart-title an-chart-description"><title id="an-chart-title">Daily ${h(metricLabels[metric].toLowerCase())}</title><desc id="an-chart-description">${h(summary)} Dates before collection are omitted. Today is incomplete.</desc><defs><linearGradient id="an-chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#dedede" stop-opacity=".2"/><stop offset="100%" stop-color="#dedede" stop-opacity=".01"/></linearGradient></defs>
  ${[0,.5,1].map(fraction=>`<line x1="${left}" y1="${top+fraction*plotHeight}" x2="${width-right}" y2="${top+fraction*plotHeight}" stroke="#303236" stroke-dasharray="3 5"/><text x="${left-10}" y="${top+fraction*plotHeight+4}" text-anchor="end">${new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(niceMax*(1-fraction))}</text>`).join('')}
  <polygon points="${area}" fill="url(#an-chart-fill)"/><polyline points="${line}" fill="none" stroke="#e0e0e0" stroke-width="2.5" stroke-linejoin="round"/>
  ${points.map(([x,y],index)=>`<circle cx="${x}" cy="${y}" r="${rows.length>31?2:3.5}" fill="${rows[index].date===utcDay()?'#111315':'#e0e0e0'}" stroke="#e0e0e0" stroke-width="1.5"><title>${h(shortDate(rows[index].date))}: ${number(values[index])} · ${h(dayStatus(rows[index]))}</title></circle>`).join('')}
  ${labels.map(index=>`<text x="${points[index][0]}" y="${height-7}" text-anchor="${index===0?'start':index===rows.length-1?'end':'middle'}">${h(shortDate(rows[index].date))}</text>`).join('')}</svg>`;
 }else chart=emptyAnalytics(rows.length?'No matching activity':'No collected data for these dates',rows.length?'Nothing was recorded for this metric and these filters.':'Choose dates after collection began. Earlier traffic is unavailable.');
 const coverage=collectionDay()&&report.range.from<collectionDay()?`History begins ${dateText(report.meta.startedAt)}. Earlier dates are unavailable. `:'';
 return `<section class="adm-panel an-trend"><div class="adm-panel-head"><div><h2>Activity over time</h2><p class="adm-muted">${h(metricHelp[metric])}</p></div><label class="an-metric-label">Show<select aria-label="Chart metric" data-analytics-metric>${Object.entries(metricLabels).map(([key,label])=>`<option value="${key}" ${metric===key?'selected':''}>${label}</option>`).join('')}</select></label></div>${chart}
  <div class="an-trend-summary"><span>${h(summary)}</span><small>${h(coverage)}${report.range.to===utcDay()?'Today is still in progress. ':''}${metric==='visits'?'One visit crossing midnight can appear on both days.':''}</small></div>
  <details class="an-data-table"><summary>View daily numbers</summary><div class="an-table-wrap"><table class="an-table"><thead><tr><th scope="col">Date · UTC</th><th scope="col">Coverage</th>${Object.values(metricLabels).map(label=>`<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${(report.trend||[]).map(row=>`<tr><th scope="row">${h(row.date)}</th><td>${h(dayStatus(row))}</td>${Object.keys(metricLabels).map(key=>`<td>${measured(row)?number(row[key]):'—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details></section>`;
}
function breakdown(title,items,valueKey='visits',limit=7,unit='visits',note=''){
 const rows=(items||[]).filter(row=>count(row[valueKey])>0).slice(0,limit),max=Math.max(1,...rows.map(row=>count(row[valueKey])));
 return `<section class="adm-panel an-breakdown"><div class="adm-panel-head"><h2>${h(title)}</h2><span class="adm-muted">${h(unit)}</span></div>${note?`<p class="an-panel-note">${h(note)}</p>`:''}
 ${!rows.length?emptyAnalytics('Nothing recorded here yet','Matching activity will appear here as it is recorded.'):`<ol class="an-rankings">${rows.map(row=>`<li><div><span title="${h(row.label||row.key)}">${h(row.label||row.key||'Unknown')}</span><strong>${number(row[valueKey])}</strong></div><svg viewBox="0 0 100 3" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="3" fill="#2b2d31"/><rect width="${count(row[valueKey])/max*100}" height="3" fill="#bfc2c8"/></svg></li>`).join('')}</ol>`}
 ${(items||[]).length>limit?`<p class="an-panel-note">Showing the top ${limit}. Export CSV for the full available breakdown.</p>`:''}</section>`;
}
function sourceCoverage(){
 const known=count(report.meta?.sourceKnownVisits),unknown=count(report.meta?.sourceUnknownVisits),total=known+unknown,share=total?known/total*100:0;
 return `<section class="adm-panel an-coverage"><div class="adm-panel-head"><h2>Where visits came from</h2><span class="adm-badge">Browser reported</span></div>
 <div class="an-coverage-body"><strong>${number(known)} <small>/ ${number(total)}</small></strong><p>visits shared a referring website</p><svg viewBox="0 0 100 5" preserveAspectRatio="none" role="img" aria-label="${number(known)} of ${number(total)} visits shared a referrer"><rect width="100" height="5" fill="#313338"/><rect width="${share}" height="5" fill="#d0d2d6"/></svg><p><b>${number(unknown)}</b> not shared / direct</p></div>
 <p class="an-panel-note">A browser may name Instagram or Google as the previous website. This is not verified by those platforms. Missing referrers stay unknown.</p><button class="adm-text" data-analytics-section="audience">Explore audience & sources ↗</button></section>`;
}
function pagesTable(){const rows=report.pages||[];return `<section class="adm-panel"><div class="adm-panel-head"><h2>Pages people opened</h2><span class="adm-muted">Recorded activity</span></div>${!rows.length?emptyAnalytics('No page activity yet','Public page views will appear here.'):`<div class="an-table-wrap"><table class="an-table"><thead><tr><th scope="col">Page</th><th scope="col">Page views</th><th scope="col">Clicks</th></tr></thead><tbody>${rows.map(row=>`<tr><th scope="row"><strong>${h(row.label||row.key)}</strong><small>${h(row.key)}</small></th><td>${number(row.views)}</td><td>${number(row.clicks)}</td></tr>`).join('')}</tbody></table></div>`}</section>`;}
function carsTable(){const rows=report.cars||[];return `<section class="adm-panel"><div class="adm-panel-head"><div><h2>Cars attracting attention</h2><p class="adm-muted">Top 50 by car opens. Contact clicks show intent, not completed enquiries.</p></div></div>${!rows.length?emptyAnalytics('No car interest recorded yet','Opening a car or selecting its enquiry link will appear here.'):`<div class="an-table-wrap"><table class="an-table an-cars-table"><thead><tr><th scope="col">Automobile</th><th scope="col">Listing region</th><th scope="col">Car opens</th><th scope="col">Contact clicks</th></tr></thead><tbody>${rows.map(row=>`<tr><th scope="row"><strong>${h(row.label||'Automobile')}</strong><small>${h(row.brand||'')} · ${row.type==='wanted'?'Wanted':'Inventory'}</small></th><td>${h(row.region||'—')}</td><td>${number(row.views)}</td><td>${number(row.enquiries)}</td></tr>`).join('')}</tbody></table></div>`}</section>`;}
function carInterest(){const top=(report.cars||[]).find(car=>count(car.views)>0);return `<section class="an-insight"><div><span class="adm-eyebrow">INTEREST IN THE COLLECTION</span><h3>${number(report.totals.carViews)} car opens</h3><p>${top?`${h(top.label)} leads this period with ${number(top.views)} opens.`:'Car opens will show which listings draw attention.'}</p></div><button class="adm-secondary" data-analytics-section="cars">Explore cars & clicks ↗</button></section>`;}
const socialRows=kind=>(report.actions||[]).filter(row=>row.key.startsWith(kind));
function overviewContent(){return `<div class="an-chart-layout">${trendChart()}${sourceCoverage()}</div>${carInterest()}<div class="an-two-col">${pagesTable()}${breakdown('Visitor countries',report.countries,'visits',5,'visits','Approximate network location. This is separate from the region cards people select.')}</div>`;}
function audienceContent(){return `<p class="an-section-intro">Incoming traffic and approximate audience details. Outgoing social clicks are in Cars & clicks.</p><div class="an-two-col">${sourceCoverage()}${breakdown('Incoming referrer websites',report.sources,'visits',15,'visits','Literal domains supplied by the browser, not platform-confirmed referrals. “Not shared / direct” includes hidden sources and direct visits. Top 50 available in CSV.')}${breakdown('Visitor countries',report.countries,'visits',15,'visits','Estimated from the connection. VPNs and network routing can change the country; unknown stays unknown.')}${breakdown('Devices',report.devices,'visits',8,'visits','Inferred from the browser’s request. A visit changing device details may appear in more than one row.')}${breakdown('Browsers',report.browsers,'visits',10,'visits','Inferred from browser headers; not a verified device identity.')}</div>`;}
function carsContent(){return `<p class="an-section-intro">Actions taken on your website. These are recorded interactions, not unique people or confirmed sales.</p>
 <div class="an-engagement-strip">${[['carViews','Car opens'],['regionClicks','Region selections'],['brandClicks','Brand selections']].map(([key,label])=>`<div><span>${label}</span><strong>${number(report.totals[key])}</strong></div>`).join('')}</div>${carsTable()}
 <div class="an-two-col">${breakdown('Regions selected',report.regions,'clicks',10,'clicks','Location cards selected in Inventory or Wanted. These are not visitor locations.')}${breakdown('Brands selected',report.brands,'clicks',12,'clicks','Marque selectors clicked. Up to 50 brands are included in the export.')}
 ${breakdown('Outgoing social links',socialRows('outbound_'),'clicks',8,'link clicks','Clicks on configured social links on this website. A click does not confirm the destination loaded, and does not mean the visit came from that platform.')}
 ${breakdown('Other website actions',(report.actions||[]).filter(row=>!row.key.startsWith('social_')&&!row.key.startsWith('outbound_')),'clicks',12,'clicks','Navigation, contact links and other tracked controls. Car, region and brand actions are shown separately.')}</div>
 ${socialRows('social_').length?`<details class="an-legacy"><summary>Historical social icon clicks · ${number(socialRows('social_').reduce((sum,row)=>sum+count(row.clicks),0))}</summary><p>Older tracking also counted placeholder buttons. These records are preserved separately and cannot confirm an outgoing link was used.</p>${breakdown('Legacy icon activity',socialRows('social_'),'clicks',8,'icon clicks')}</details>`:''}`;}
function guide(){return `<details class="an-guide"><summary>What these numbers mean</summary><div class="an-guide-grid">${Object.entries(metricLabels).map(([key,label])=>`<dl><dt>${label}</dt><dd>${h(metricHelp[key])}</dd></dl>`).join('')}<dl><dt>Incoming sources</dt><dd>Browser-reported referrer domains. No Instagram/Meta integration or UTM campaign attribution. Missing information stays unknown.</dd></dl><dl><dt>Outgoing social links</dt><dd>Clicks on your configured social links. Older icon counts may include placeholders and appear separately.</dd></dl><dl><dt>Coverage & accuracy</dt><dd>Staff sessions, known bots and privacy opt-outs are excluded. Blockers and network failures can miss events; some automated traffic can still be counted. Devices and countries are estimates.</dd></dl><dl><dt>Time & retention</dt><dd>UTC dates, up to 90 days of history. Earlier dates are uncollected, not measured zeroes. Growth needs two completed periods with enough collection history.</dd></dl></div></details>`;}
export function analyticsPanel(){
 if(!authorized())return '';
 const available=report&&reportKey===requestKey();
 return `<div class="an-dashboard" ${busy?'aria-busy="true"':''}><div class="an-intro"><div><span class="adm-eyebrow">YOUR WEBSITE, AT A GLANCE</span><h2>Understand the interest.</h2><p>Follow recorded activity. See what brings people closer to the collection.</p></div><span class="an-live-state">${busy?'Updating report…':reportError?'Refresh needed':updatedAt?'Report loaded':'Waiting for data'}</span></div>
 ${filterControls()}${reportError?`<div class="adm-error" role="alert">${available?'Refresh failed. The numbers below are from the last successful report. ':''}${h(reportError)} <button data-analytics-refresh>Try again</button></div>`:''}
 ${!available?`<section class="adm-panel">${busy?'<div class="an-loading" role="status"><span></span>Loading recorded activity…</div>':emptyAnalytics(reportError?'Report unavailable':'Your report will appear here',reportError?'Try refreshing. Missing data is not shown as zero.':'Open a date range to see recorded activity.')}</section>`:`
 ${kpis()}<div class="an-subnav" role="group" aria-label="Analytics reports">${[['overview','Overview'],['audience','Audience & sources'],['cars','Cars & clicks']].map(([key,label])=>`<button data-analytics-section="${key}" aria-pressed="${section===key}">${label}</button>`).join('')}</div>
 ${({overview:overviewContent,audience:audienceContent,cars:carsContent})[section]()}
 <div class="an-status-grid"><div class="an-status-item"><small>Collection started</small><strong>${h(timeText(report.meta?.startedAt))}</strong></div><div class="an-status-item"><small>Last recorded activity · whole site</small><strong>${h(timeText(report.meta?.lastEventAt))}</strong></div><div class="an-status-item"><small>${reportError?'Last successful report':'Report generated'}</small><strong>${h(timeText(report.meta?.generatedAt||updatedAt))}</strong></div></div>
 ${report.meta?.comparisonAvailable?`<p class="an-notice">Compared with ${h(shortDate(report.range.previousFrom))} – ${h(shortDate(report.range.previousTo))}, using the same audience filters.</p>`:`<p class="an-notice">${h(report.meta?.comparisonUnavailableReason||'A comparison needs two completed periods with enough history.')}</p>`}${guide()}
 <p class="an-filter-note">No tracking cookies · Staff browsing excluded · ${number(report.meta?.retentionDays||90)}-day history · Counts reflect recorded activity, not every visitor.</p>`}</div>`;
}

function exportCell(value){let text=String(value??'');if(/^[\s\u0000-\u001f]*[=+\-@]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}
function exportCsv(){
 if(!exportReady())return;
 const rows=[['ENTITY-1 website analytics'],['From (UTC)',report.range.from,'To (UTC)',report.range.to],['Country',applied.country||'All','Device',applied.device||'All'],['Report generated (UTC)',report.meta?.generatedAt||updatedAt?.toISOString()],['Collection started (UTC)',report.meta?.startedAt||'Not recorded'],['Last recorded activity sitewide (UTC)',report.meta?.lastEventAt||'Not recorded'],[],['Metric','Definition']];
 for(const [key,label] of Object.entries(metricLabels))rows.push([label,metricHelp[key]]);
 rows.push(['Incoming sources','Browser-reported domains; no platform verification. Missing sources remain unknown.'],['Outgoing social links','Clicks on configured social links, not incoming referrals or confirmed destination loads.'],['Historical icon clicks','Legacy records may include placeholder buttons.'],['Coverage','Staff, known bots and privacy opt-outs excluded. Blockers can miss activity; automation may still be counted.'],['Breakdowns','Top 50 cars, sources, brands and actions; countries limited to 100. Summary and source coverage totals include all matching records.'],[],['Summary','Current','Previous']);
 for(const [key,label] of Object.entries(metricLabels))rows.push([label,count(report.totals?.[key]),report.meta?.comparisonAvailable?count(report.previous?.[key]):'Not comparable']);
 rows.push(['Comparison note',report.meta?.comparisonUnavailableReason||'Completed periods'],['Visits with a referrer',count(report.meta?.sourceKnownVisits)],['Visits without a referrer',count(report.meta?.sourceUnknownVisits)],[],['Daily activity (UTC)','Coverage',...Object.values(metricLabels)]);
 for(const day of report.trend||[])rows.push([day.date,dayStatus(day),...Object.keys(metricLabels).map(key=>measured(day)?count(day[key]):'Not collected')]);
 for(const [title,key,value] of [['Visitor countries (approximate)','countries','visits'],['Devices (inferred)','devices','visits'],['Browsers (inferred)','browsers','visits'],['Incoming referrer websites (browser reported)','sources','visits'],['Regions selected on website','regions','clicks'],['Brands selected on website','brands','clicks']]){rows.push([],[title,value==='visits'?'Page-load visits':'Clicks']);for(const row of report[key]||[])rows.push([row.label||row.key,count(row[value])]);}
 for(const [title,items] of [['Outgoing social link clicks',socialRows('outbound_')],['Historical social icon clicks (may include placeholders)',socialRows('social_')],['Other website actions',(report.actions||[]).filter(row=>!row.key.startsWith('social_')&&!row.key.startsWith('outbound_'))]]){rows.push([],[title,'Clicks']);for(const row of items)rows.push([row.label||row.key,count(row.clicks)]);}
 rows.push([],['Pages','Page views','Recorded clicks']);for(const row of report.pages||[])rows.push([row.label||row.key,count(row.views),count(row.clicks)]);
 rows.push([],['Cars','Brand','Listing region','Type','Car opens','Contact clicks']);for(const row of report.cars||[])rows.push([row.label,row.brand,row.region,row.type,count(row.views),count(row.enquiries)]);
 const blob=new Blob(['\ufeff'+rows.map(row=>row.map(exportCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`entity-one-analytics-${report.range.from}-${report.range.to}.csv`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('Analytics CSV downloaded.');
}
async function applyFilters(){
 const error=validateRange(filters);if(error){filtersOpen=true;const node=document.querySelector('#analytics-filters .form-error');if(node){node.textContent=error;node.hidden=false;}return;}
 applied={...filters};report=null;reportKey='';reportError='';const pending=ensureAnalyticsData(true);render();await pending;
}
function syncDraftState(){
 const button=document.querySelector('[data-analytics-export]');if(button)button.disabled=!exportReady();
 const note=document.querySelector('[data-analytics-draft]');if(note)note.hidden=!hasDraft();
}
export function bindAnalytics(){if(bound)return;bound=true;
 document.addEventListener('toggle',event=>{if(event.target.id==='analytics-filter-details')filtersOpen=event.target.open;},true);
 document.addEventListener('input',event=>{if(!event.target.closest('#analytics-filters'))return;const {name,value}=event.target;if(['from','to','country','device'].includes(name)){filters[name]=value;if(name==='from'||name==='to'){filters.preset='custom';for(const button of document.querySelectorAll('[data-analytics-preset]'))button.setAttribute('aria-pressed',String(button.dataset.analyticsPreset==='custom'));}syncDraftState();}});
 document.addEventListener('change',event=>{if(!authorized())return;if(event.target.matches('[data-analytics-metric]')&&Object.hasOwn(metricLabels,event.target.value)){metric=event.target.value;render();}if(event.target.closest('#analytics-filters')&&['country','device'].includes(event.target.name)){filters[event.target.name]=event.target.value;syncDraftState();}});
 document.addEventListener('submit',async event=>{if(event.target.id!=='analytics-filters')return;event.preventDefault();if(!authorized())return;await applyFilters();});
 document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||button.disabled||!authorized())return;try{
  if(button.dataset.analyticsSection&&['overview','audience','cars'].includes(button.dataset.analyticsSection)){section=button.dataset.analyticsSection;render();}
  if(Object.hasOwn(metricLabels,button.dataset.analyticsMetricButton||'')){metric=button.dataset.analyticsMetricButton;section='overview';render();}
  if(button.hasAttribute('data-analytics-preset')){const value=button.dataset.analyticsPreset;if(value==='custom'){filters.preset='custom';filtersOpen=true;render();document.querySelector('#analytics-filters [name=from]')?.focus();}else if(['1','7','30','90'].includes(value)){filters={...filters,...presetRange(Number(value)),preset:value};await applyFilters();}}
  if(button.hasAttribute('data-analytics-clear')){filters=defaults();await applyFilters();}
  if(button.hasAttribute('data-analytics-refresh'))await ensureAnalyticsData(true);
  if(button.hasAttribute('data-analytics-export'))exportCsv();
 }catch(error){notify(error.message||'The analytics action could not be completed.');}});
}
