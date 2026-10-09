import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

// Test user-visible permissions, navigation, filtering and destructive-action
// guards without browser credentials, production data or network requests.
const source=(await readFile(new URL('../public/admin.js',import.meta.url),'utf8'))
  .replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')
  +'\nglobalThis.ui={admin,bindForms,markAdminDirty,mayDiscard,clearAdminData,ensureAdminData};';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let checks=0;
const ok=(value,message)=>{assert.ok(value,message);checks++;};
const equal=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
const contains=(text,part,message)=>ok(text.includes(part),message||`Expected ${part}`);
const omits=(text,part,message)=>ok(!text.includes(part),message||`Unexpected ${part}`);
const allPermissions=['inventory.read','inventory.write','wanted.read','wanted.write','content.read','content.write','media.read','media.write','backups.read','backups.restore','logs.read','analytics.read','users.read','users.write'];
function fixture(){return {settings:{heroHeading:'Rare cars.\nPrivate access.',email:'sales@example.test',offices:[],members:[],partners:[],socials:{instagram:'https://instagram.com/entityone',reddit:'https://reddit.com/r/example'}},listings:[
  {id:'porsche-live',type:'inventory',brand:'Porsche',model:'911 GT3 RS',year:'2024',mileage:'800 km',price:'On application',region:'Europe',location:'London',status:'available',featured:true,image:'/assets/porsche.png',gallery:[]},
  {id:'ferrari-draft',type:'inventory',brand:'Ferrari',model:'F50',year:'1995',mileage:'4,000 km',price:'On application',region:'America',location:'Miami',status:'draft',image:'/assets/ferrari.png',gallery:[]},
  {id:'bugatti-sold',type:'inventory',brand:'Bugatti',model:'Chiron',year:'2020',mileage:'1,500 km',price:'On application',region:'Europe',location:'Monaco',status:'sold',image:'/assets/bugatti.png',gallery:[]},
  {id:'mclaren-reserved',type:'inventory',brand:'McLaren',model:'P1',year:'2015',mileage:'2,000 km',price:'On application',region:'Gulf and Asia',location:'Dubai',status:'reserved',image:'/assets/mclaren.png',gallery:[]},
  {id:'wanted-active',type:'wanted',brand:'Lamborghini',model:'SVJ',year:'2020',mileage:'Low mileage',price:'Budget on request',region:'Europe',location:'Munich',status:'active',image:'/assets/svj.png',gallery:[]},
  {id:'wanted-fulfilled',type:'wanted',brand:'Pagani',model:'Huayra',year:'2016',mileage:'Any',price:'Budget on request',region:'America',location:'Texas',status:'fulfilled',image:'/assets/pagani.png',gallery:[]}
]};}
function harness(permissions=allPermissions,media=[]){
  const state={adminTab:'dashboard',revision:12,session:{authenticated:true,localOnly:false,user:{username:'reviewer',role:'owner',permissions:[...permissions]}},adminData:fixture()};
  const listeners=new Map(),windowListeners=new Map(),nodes=new Map(),dialogs=[],requests=[],saves=[],notifications=[];
  let renders=0,modalHtml='',scrolls=0,submissions=0;
  const add=(map,name,listener)=>{if(!map.has(name))map.set(name,[]);map.get(name).push(listener);};
  function node(attrs={}){
    const own=new Map(),events=new Map();
    const element={value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,isConnected:true,open:false,...attrs,
      dataset:attrs.dataset||{},classList:{add(){},remove(){},contains(){return false;}},
      setAttribute(name,value){this[name]=value;},getAttribute(name){return this[name]??null;},
      hasAttribute(name){return Object.hasOwn(attrs,name);},
      querySelector(selector){if(!own.has(selector))own.set(selector,node());return own.get(selector);},
      querySelectorAll(){return [];},
      addEventListener(name,listener){add(events,name,listener);},
      async dispatch(name,event={}){for(const fn of events.get(name)||[])await fn(event);},
      showModal(){this.open=true;},close(){this.open=false;},focus(){document.activeElement=this;},
      remove(){this.isConnected=false;for(const [key,value]of nodes)if(value===this)nodes.delete(key);},
      replaceChildren(value){this.textContent=String(value);},
      closest(){return null;},matches(){return false;},after(){},getClientRects(){return [1];},
      requestSubmit(){submissions++;}
    };return element;
  }
  const document={
    activeElement:null,
    addEventListener(name,listener){add(listeners,name,listener);},
    querySelector(selector){if(nodes.has(selector))return nodes.get(selector);return null;},
    querySelectorAll(selector){return [...nodes.values()].filter(n=>n.matches(selector));},
    createTextNode(value){return value;},
    createElement(tag){const item=node({tagName:tag.toUpperCase()});if(tag==='dialog')dialogs.push(item);return item;},
    body:{append(item){if(item.className)nodes.set('.'+item.className,item);}}
  };
  for(const id of ['dialog','admin-results','admin-search','admin-status','admin-region','admin-sort','admin-mobile-nav','admin-section'])nodes.set('#'+id,node({id,value:id==='admin-search'?'':id==='admin-sort'?'default':'all'}));
  const context=vm.createContext({
    state,h:escape,safeUrl:value=>value||'',document,location:{pathname:'/admin'},
    window:{addEventListener(name,listener){add(windowListeners,name,listener);},scrollTo(){scrolls++;}},
    can(permission){return state.session.authenticated&&state.session.user.permissions.includes(permission);},
    needsPasswordChange(){return !!state.session.mustChangePassword;},roleLabel:role=>role||'Viewer',
    render(){renders++;},notify(message){notifications.push(message);},navigate(path){context.location.pathname=path;},
    modal(html){modalHtml=html;nodes.set('#confirm-action',node());nodes.set('#dialog-content',node());},closeModal(){},
    async api(url,options={}){requests.push({url,options});return url==='/backups'?{backups:[]}:url==='/media'?{media}:{recentAudit:[]};},
    async loadContent(){},async saveContent(content){saves.push(structuredClone(content));state.adminData=content;},
    clearAccessData(){},clearAnalyticsData(){},async ensureAccessData(){},async ensureAnalyticsData(){},
    renderShowcaseEditor:()=>'<section id="showcase-editor">Homepage showcase</section>',
    bindShowcaseAdmin(){},readShowcaseSettings:()=>structuredClone(state.adminData.settings.showcase||[]),clearShowcaseAdmin(){},syncShowcaseSaveState(){},
    accessPanel:()=>'<div>Account access</div>',passwordGate:()=>'<div>Password change required</div>',logsPanel:()=>'<div>Activity logs</div>',analyticsPanel:()=>'<div>Measured analytics</div>',bindAccess(){},bindAnalytics(){},
    navigator:{clipboard:{async writeText(){}}},crypto:webcrypto,structuredClone,Blob,URL,FormData,Intl,Date,setTimeout(){},clearTimeout(){},console
  });
  vm.runInContext(source,context,{filename:'public/admin.js'});context.ui.bindForms();
  const dispatch=async(name,event)=>{for(const listener of listeners.get(name)||[])await listener(event);};
  const button=attrs=>{const result=node(attrs);result.dataset=Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),value]));result.closest=selector=>selector.includes('button')?result:null;result.click=()=>dispatch('click',{target:result,preventDefault(){}});return result;};
  return {...context.ui,state,requests,saves,notifications,nodes,dialogs,node,
    get renders(){return renders;},get modalHtml(){return modalHtml;},get scrolls(){return scrolls;},get submissions(){return submissions;},
    async click(attrs){await dispatch('click',{target:button(attrs),preventDefault(){}});},
    async input(id,value){const target=nodes.get('#'+id)||node({id});target.value=value;await dispatch('input',{target});},
    async change(id,value){const target=nodes.get('#'+id)||node({id});target.value=value;await dispatch('change',{target});},
    async event(name,target){await dispatch(name,{target,preventDefault(){}});},
    async key(key,extras={}){let prevented=false;await dispatch('keydown',{key,ctrlKey:false,metaKey:false,target:document.activeElement||node(),preventDefault(){prevented=true;},...extras});return prevented;},
    async unload(){let prevented=false;const event={returnValue:undefined,preventDefault(){prevented=true;}};for(const listener of windowListeners.get('beforeunload')||[])await listener(event);return prevented;},
    focus(form){document.activeElement=form;},
    async confirm(){const target=nodes.get('#confirm-action');await target.onclick?.({target});},
    async discard(){await dialogs.at(-1)?.querySelector('[data-discard-changes]').onclick?.();},
    async keep(){await dialogs.at(-1)?.querySelector('[data-keep-editing]').onclick?.();}
  };
}

// Rendering and delegated navigation must obey the current account permissions.
{
  const h=harness();h.state.session.authenticated=false;const html=h.admin();contains(html,'LOG IN');omits(html,'data-admin-tab=');await h.ensureAdminData();equal(h.requests.length,0);
  h.state.session.authenticated=true;h.state.session.mustChangePassword=true;contains(h.admin(),'Password change required');await h.ensureAdminData();equal(h.requests.length,0);
}
{
  const h=harness(['inventory.read']);let html=h.admin();contains(html,'data-admin-tab="inventory"');omits(html,'data-admin-tab="analytics"');omits(html,'data-admin-tab="content"');omits(html,'data-admin-tab="wanted"');omits(html,'data-admin-tab="media"');omits(html,'data-admin-tab="activity"');omits(html,'data-admin-tab="backups"');
  await h.click({'data-admin-tab':'analytics'});equal(h.state.adminTab,'dashboard','Forged section controls cannot open unauthorized reports');
  await h.click({'data-admin-tab':'inventory'});html=h.admin();contains(html,'Porsche 911 GT3 RS');omits(html,'data-new=');omits(html,'data-duplicate=');omits(html,'data-archive=');
  await h.click({'data-duplicate':'porsche-live'});await h.click({'data-archive':'porsche-live'});equal(h.saves.length,0,'Read-only accounts cannot mutate listings using delegated controls');
  await h.click({'data-edit':'porsche-live'});contains(h.modalHtml,'read-only');contains(h.modalHtml,'disabled');
  h.state.adminTab='content';h.admin();equal(h.state.adminTab,'dashboard','Revoked or unavailable sections return to overview');
}
{
  const h=harness();h.state.adminTab='content';const html=h.admin();omits(html,'social-reddit','Removed social platform has no editable field');contains(html,'social-instagram');contains(html,'social-linkedin');
  for(const tab of ['dashboard','inventory','wanted','content','media','backups','activity','access','analytics']){h.state.adminTab=tab;const panel=h.admin();omits(panel,'undefined');omits(panel,'NaN');}
}
// Filters act on the chosen catalogue, expose accurate totals and do not alter
// the saved order or silently edit any listing.
{
  const h=harness();await h.click({'data-admin-tab':'inventory'});let html=h.admin();contains(html,'4 of 4 cars');omits(html,'Lamborghini SVJ');
  const original=h.state.adminData.listings.map(c=>c.id).join(',');
  await h.input('admin-search','  PORSCHE  ');html=h.nodes.get('#admin-results').innerHTML;contains(html,'1 of 4 cars');contains(html,'Porsche 911 GT3 RS');omits(html,'Ferrari F50');
  await h.change('admin-region','America');html=h.nodes.get('#admin-results').innerHTML;contains(html,'0 of 4 cars');contains(html,'No matching listings');contains(html,'Clear filters');
  await h.click({'data-clear-listing-filters':''});html=h.admin();contains(html,'4 of 4 cars');equal(h.nodes.get('#admin-search').value,'');equal(h.nodes.get('#admin-region').value,'all');
  await h.change('admin-status','draft');html=h.nodes.get('#admin-results').innerHTML;contains(html,'1 of 4 cars');contains(html,'Ferrari F50');omits(html,'Porsche 911 GT3 RS');
  await h.click({'data-clear-listing-filters':''});await h.change('admin-sort','brand');html=h.nodes.get('#admin-results').innerHTML;
  ok(html.indexOf('Bugatti Chiron')<html.indexOf('Ferrari F50')&&html.indexOf('Ferrari F50')<html.indexOf('McLaren P1')&&html.indexOf('McLaren P1')<html.indexOf('Porsche 911 GT3 RS'),'Alphabetical sort orders the visible results');
  await h.change('admin-sort','year');html=h.nodes.get('#admin-results').innerHTML;
  ok(html.indexOf('Porsche 911 GT3 RS')<html.indexOf('Bugatti Chiron')&&html.indexOf('Bugatti Chiron')<html.indexOf('McLaren P1')&&html.indexOf('McLaren P1')<html.indexOf('Ferrari F50'),'Year sort orders exact years newest first');
  equal(h.state.adminData.listings.map(c=>c.id).join(','),original,'Sorting never changes the saved collection order');equal(h.saves.length,0);
  await h.input('admin-search','<img src=x onerror=alert(1)>');html=h.nodes.get('#admin-results').innerHTML;contains(html,'&lt;img src=x');omits(html,'<img src=x','Search summary escapes user text');
  await h.click({'data-admin-tab':'wanted'});html=h.admin();contains(html,'2 of 2 requests');contains(html,'Lamborghini SVJ');omits(html,'Search:');omits(html,'Ferrari F50');
}
// Navigating away must not silently discard changes, including on a phone.
{
  const h=harness();h.markAdminDirty();equal(await h.unload(),true,'Browser navigation warns while edits are unsaved');
  await h.click({'data-admin-tab':'inventory'});equal(h.state.adminTab,'dashboard');equal(h.dialogs.length,1);contains(h.dialogs[0].innerHTML,'Keep editing');
  await h.keep();equal(h.state.adminTab,'dashboard');equal(await h.unload(),true,'Keep editing preserves unsaved status');
  await h.click({'data-admin-tab':'inventory'});await h.discard();equal(h.state.adminTab,'inventory');equal(await h.unload(),false,'Explicit discard clears the warning');equal(h.saves.length,0);
}
{
  const h=harness(['inventory.read']);let html=h.admin();contains(html,'adm-nav-group');contains(html,'Workspace');contains(html,'Manage');contains(html,'Administration');
  const mobile=html.match(/<select id="admin-section">([\s\S]*?)<\/select>/)?.[1]||'';
  contains(mobile,'value="dashboard"');contains(mobile,'value="inventory"');contains(mobile,'value="access"');omits(mobile,'value="content"');omits(mobile,'value="analytics"');
  h.markAdminDirty();await h.change('admin-section','inventory');equal(h.state.adminTab,'dashboard');equal(h.nodes.get('#admin-section').value,'dashboard','Cancelled mobile selection stays on the current section');
  await h.keep();await h.change('admin-section','inventory');await h.discard();equal(h.state.adminTab,'inventory');equal(h.saves.length,0);
  await h.change('admin-section','analytics');equal(h.state.adminTab,'inventory','Mobile selector cannot bypass permission gating');
}
// Each status describes its actual public visibility, not just an internal code.
{
  const h=harness();
  for(const [id,copy]of [['porsche-live','Public: shown in inventory'],['mclaren-reserved','as reserved'],['ferrari-draft','Private: only authorised'],['bugatti-sold','Hidden from the public catalogue'],['wanted-active','Public: shown in wanted requests'],['wanted-fulfilled','Hidden from public wanted requests']]){
    await h.click({'data-edit':id});contains(h.modalHtml,'Publication status');contains(h.modalHtml,'aria-describedby="listing-publication-help"');contains(h.modalHtml,copy);
  }
  const help=h.node();h.nodes.set('#listing-publication-help',help);
  const status=h.node({name:'status',value:'draft'});status.closest=selector=>selector==='#listing-form'?{}:null;
  await h.event('change',status);contains(help.textContent,'Private: only authorised');equal(await h.unload(),true,'Changing publication status counts as an unsaved edit');
  await h.click({'data-new':'inventory'});contains(h.modalHtml,'value="draft" selected');contains(h.modalHtml,'Private: only authorised');equal(h.saves.length,0,'Opening a new draft never publishes it');
}
// A tap on a status or delete action opens a clear confirmation and does not
// mutate content until the user explicitly confirms it.
{
  const h=harness();await h.click({'data-archive':'porsche-live','data-status':'sold'});equal(h.saves.length,0);equal(h.state.adminData.listings[0].status,'available');contains(h.modalHtml,'Mark Porsche 911 GT3 RS as sold?');contains(h.modalHtml,'removes the listing from the public catalogue');
  await h.confirm();equal(h.saves.length,1);equal(h.state.adminData.listings[0].status,'sold');equal(h.state.adminData.listings.length,6,'Sold cars remain in administrative records');
  await h.click({'data-archive':'porsche-live','data-status':'draft'});equal(h.saves.length,1);contains(h.modalHtml,'Move this listing to drafts?');await h.confirm();equal(h.state.adminData.listings[0].status,'draft');
  await h.click({'data-archive':'wanted-active','data-status':'fulfilled'});equal(h.saves.length,2);await h.confirm();equal(h.state.adminData.listings.find(c=>c.id==='wanted-active').status,'fulfilled');
  await h.click({'data-remove':'ferrari-draft'});equal(h.saves.length,3);contains(h.modalHtml,'Delete Ferrari F50?');contains(h.modalHtml,'recover the previous content');await h.confirm();equal(h.saves.length,4);ok(!h.state.adminData.listings.some(c=>c.id==='ferrari-draft'));
}
// Save shortcuts must use the form's normal submit/validation path and must not
// save from unrelated, hidden, read-only or already-submitting panels.
{
  const h=harness();equal(await h.key('s',{ctrlKey:true}),false);equal(h.submissions,0);
  const form=h.node({id:'settings-form'});form.matches=selector=>selector.split(',').includes('#settings-form');h.nodes.set('#settings-form',form);
  equal(await h.key('s',{ctrlKey:true}),true);equal(h.submissions,1,'Ctrl+S invokes native form submission');
  equal(await h.key('S',{metaKey:true}),true);equal(h.submissions,2,'Command+S works on Apple keyboards');
  equal(await h.key('s'),false);equal(await h.key('s',{ctrlKey:true,altKey:true}),false);equal(h.submissions,2);
  form.hidden=true;equal(await h.key('s',{ctrlKey:true}),false);form.hidden=false;
  form.querySelector('fieldset').disabled=true;equal(await h.key('s',{ctrlKey:true}),false);form.querySelector('fieldset').disabled=false;
  h.nodes.set('.adm-discard-confirmation[open]',h.node());equal(await h.key('s',{ctrlKey:true}),false,'Discard prompt blocks submission of the form behind it');h.nodes.delete('.adm-discard-confirmation[open]');
  const dialog=h.node();dialog.contains=()=>false;h.nodes.set('#dialog[open]',dialog);equal(await h.key('s',{ctrlKey:true}),false,'An open unrelated modal blocks saving the underlying page');
  dialog.contains=candidate=>candidate===form;equal(await h.key('s',{ctrlKey:true}),true,'The visible form inside an open modal remains saveable');h.nodes.delete('#dialog[open]');
  const original=form.querySelector;form.querySelector=selector=>selector.includes('button[type="submit"]')?null:original(selector);
  equal(await h.key('s',{ctrlKey:true}),false);equal(h.submissions,3,'No enabled submit control means no shortcut submission');
}

// Only uploaded files can be deleted; in-use state, read-only access and confirmation are explicit.
{
  const uploaded={id:'00000000-0000-4000-8000-000000000001',url:'/assets/uploads/00000000-0000-4000-8000-000000000001.png',name:'spare-photo.png',size:1024,inUse:false};
  const used={...uploaded,id:'00000000-0000-4000-8000-000000000002',url:'/assets/uploads/00000000-0000-4000-8000-000000000002.png',name:'showcase.png',inUse:true};
  const h=harness(allPermissions,[uploaded,used]);await h.ensureAdminData();h.state.adminTab='media';const html=h.admin();
  contains(html,'data-delete-media="'+uploaded.url+'"');contains(html,'aria-label="Delete showcase.png" disabled');omits(html,'data-delete-media="/assets/porsche.png"');contains(html,'must first be removed');
  await h.click({'data-delete-media':uploaded.url});contains(h.modalHtml,'cannot restore deleted image files');contains(h.modalHtml,'Delete image');equal(h.requests.filter(r=>r.options.method==='DELETE').length,0,'Opening confirmation does not delete');
  await h.confirm();equal(h.requests.filter(r=>r.options.method==='DELETE').length,1);equal(h.requests.find(r=>r.options.method==='DELETE').url,'/media/00000000-0000-4000-8000-000000000001.png');contains(h.notifications.at(-1),'Image deleted');
  await h.click({'data-delete-media':used.url});equal(h.requests.filter(r=>r.options.method==='DELETE').length,1,'In-use guard does not send delete');
  const reader=harness(['media.read'],[uploaded]);await reader.ensureAdminData();reader.state.adminTab='media';omits(reader.admin(),'data-delete-media');await reader.click({'data-delete-media':uploaded.url});equal(reader.requests.filter(r=>r.options.method==='DELETE').length,0,'Read-only account cannot initiate delete');
}
console.log(`PASS: ${checks} admin UI checks covering permission-gated/mobile navigation, filters, unsaved changes, confirmed media/listing deletion and form-only save shortcuts.`);
