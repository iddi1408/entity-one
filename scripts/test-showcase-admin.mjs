import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {defaultShowcase,stockCutout} from '../public/showcase-config.js';

// Run the actual editor with deterministic DOM, image-engine and API boundaries.
// Image segmentation/alpha validation are separately exercised by cutout tests.
const source=(await readFile(new URL('../public/admin-showcase.js',import.meta.url),'utf8'))
 .replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'').replace("import('./cutout.js')",'loadCutout()')
 +'\nglobalThis.ui={renderShowcaseEditor,bindShowcaseAdmin,readShowcaseSettings,clearShowcaseAdmin,syncShowcaseSaveState};';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let checks=0;
const ok=(condition,message)=>{assert.ok(condition,message);checks++;};
const equal=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
const contains=(value,part)=>ok(value.includes(part),`Expected ${part}`);
const omits=(value,part)=>ok(!value.includes(part),`Unexpected ${part}`);
const throws=(callback,pattern)=>{assert.throws(callback,pattern);checks++;};
const car=(id,brand,extra={})=>({id,brand,model:'Example',year:'2024',type:'inventory',status:'available',image:'/assets/example.jpg',...extra});
function fixture(){return {settings:{},listings:[
 car('porsche','Porsche',{model:'911 GT3 RS',image:'/assets/porsche-911-gt3-rs.jpg'}),
 car('ferrari','Ferrari',{model:'488',image:'/assets/ferrari-488.jpg'}),
 car('ferrari-other','Ferrari',{model:'F50'}),car('custom','McLaren'),
 car('reserved','Aston Martin',{status:'reserved'}),car('draft','Pagani',{status:'draft'}),
 car('sold','Lamborghini',{status:'sold'}),car('wanted','Bugatti',{type:'wanted',status:'active'})
]};}
function harness({content=fixture(),permissions=['content.write','media.write']}={}){
 const state={adminData:content,session:{authenticated:true,user:{id:'reviewer',role:'editor',permissions}}};
 const listeners=new Map(),requests=[],fetches=[],progress=[],observers=[];
 let markup='',form=null,root=null,dirty=0,engineCalls=0,validationCalls=0,engine=async()=>({blob:new Blob(['transparent'],{type:'image/png'})}),validation=async()=>({blob:new Blob(['validated'],{type:'image/png'})});
 const add=(name,fn)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);};
 function node(attrs={}){
  const children=new Map();
  return {isConnected:true,dataset:{},disabled:false,hidden:false,value:'',textContent:'',innerHTML:'',...attrs,
   classList:{toggle(){}},replaceChildren(value){this.textContent=String(value);},focus(){},
   querySelector(selector){if(!children.has(selector))children.set(selector,node());return children.get(selector);},
   querySelectorAll(){return [];},closest(){return null;},hasAttribute(name){return Object.hasOwn(attrs,name);}
  };
 }
 const saveButtons=[node(),node()],controls=[node(),node({disabled:true})];
 const document={
  body:{},createTextNode:value=>value,addEventListener:add,
  querySelector:selector=>selector==='#showcase-editor'?root:selector==='.adm-save-state'?node():null
 };
 class TestFormData{constructor(){this.fields=new Map();}set(name,value,filename){this.fields.set(name,{value,filename});}get(name){return this.fields.get(name)?.value;}}
 const context=vm.createContext({
  state,h:escape,safeUrl:value=>value,defaultShowcase,stockCutout,document,location:{origin:'https://example.test'},
  can:permission=>state.session.authenticated&&state.session.user.permissions.includes(permission),
  MutationObserver:class{constructor(callback){observers.push(callback);}observe(){}},
  async fetch(url,options){fetches.push({url,...options});return {ok:true,headers:{get:()=>null},blob:async()=>new Blob(['source'],{type:'image/jpeg'})};},
  async api(url,options){requests.push({url,...options});return {media:{url:'/assets/uploads/showcase-ready.png'}};},
  async loadCutout(){return {
   async prepareCutout(blob,options){engineCalls++;progress.push(options);return engine(blob,options);},
   async validateTransparentImage(blob,options){validationCalls++;return validation(blob,options);}
  };},
  URL,FormData:TestFormData,AbortController,Blob,DOMException,console
 });
 vm.runInContext(source,context,{filename:'public/admin-showcase.js'});context.ui.bindShowcaseAdmin({markDirty:()=>dirty++});
 function mount(){
  markup=context.ui.renderShowcaseEditor(content);
  form=node({dataset:{}});root=node({dataset:{showcaseSession:markup.match(/data-showcase-session="(\d+)"/)[1]}});
  root.closest=selector=>selector==='#settings-form'?form:null;
  const query=form.querySelector.bind(form);
  form.querySelector=selector=>selector==='#showcase-editor'?root:query(selector);
  form.querySelectorAll=selector=>selector==='button[type=submit]'?saveButtons:selector==='#showcase-editor button,#showcase-editor input,#showcase-editor select'?controls:[];
  context.ui.syncShowcaseSaveState(form);return markup;
 }
 const dispatch=async(name,target)=>{for(const handler of listeners.get(name)||[])await handler({target});};
 function button(attrs){
  const item=node(attrs);item.dataset=Object.fromEntries(Object.entries(attrs).filter(([name])=>name.startsWith('data-')).map(([name,value])=>[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
  item.closest=selector=>selector==='button'?item:selector==='#settings-form'?form:null;return item;
 }
 return {...context.ui,state,content,requests,fetches,saveButtons,controls,progress,
  mount,get form(){return form;},get root(){return root;},get markup(){return root.innerHTML||markup;},
  get dirty(){return dirty;},get engineCalls(){return engineCalls;},get validationCalls(){return validationCalls;},
  keys(){return [...(root.innerHTML||markup).matchAll(/data-showcase-row="([^"]+)"/g)].map(match=>match[1]);},
  read(){return JSON.parse(JSON.stringify(context.ui.readShowcaseSettings(form)));},
  async click(attrs){await dispatch('click',button(attrs));},
  async choose(key,value){const target=node({value,dataset:{showcaseCar:key}});target.closest=selector=>selector==='#settings-form'?form:null;await dispatch('change',target);},
  async upload(key,file,transparent=false){const target=node({files:[file],dataset:{[transparent?'showcaseCutout':'showcaseSource']:key}});target.closest=selector=>selector==='#settings-form'?form:null;await dispatch('change',target);},
  setEngine(callback){engine=callback;},setValidation(callback){validation=callback;},
  detach(){form.isConnected=false;root=null;for(const callback of observers)callback();},
  flush(){for(const callback of observers)callback();}
 };
}
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function until(predicate){for(let attempt=0;attempt<30&&!predicate();attempt++)await Promise.resolve();ok(predicate(),'Expected asynchronous boundary to be reached');}

// Legacy defaults only reuse exact stock cutouts. Explicit empty configuration
// hides the feature and is never replaced with automatic defaults.
{
 const h=harness();const html=h.mount();contains(html,'Homepage showcase');contains(html,'separate featured inventory grid');
 equal(h.read(),defaultShowcase(h.content));equal(h.read().length,2);equal(h.saveButtons.every(button=>!button.disabled),true);
 contains(html,'value="reserved"');omits(html,'value="draft"');omits(html,'value="sold"');omits(html,'value="wanted"');
 equal(h.requests.length,0);equal(h.engineCalls,0);
 const empty=fixture();empty.settings.showcase=[];const off=harness({content:empty});off.mount();equal(off.read(),[]);contains(off.markup,'showcase is hidden');
}
// Ordered rows can move and be removed without editing inventory or writing
// settings. Empty rows and duplicate brands never reach the save payload.
{
 const h=harness();h.mount();const original=JSON.stringify(h.content.listings),[first,second]=h.keys();
 await h.click({'data-showcase-up':second});equal(h.read().map(entry=>entry.listingId),['ferrari','porsche']);
 await h.click({'data-showcase-down':second});equal(h.read().map(entry=>entry.listingId),['porsche','ferrari']);
 await h.choose(second,'porsche');equal(h.read().map(entry=>entry.listingId),['porsche','ferrari'],'Duplicate brand selection is ignored');
 await h.click({'data-showcase-add':''});throws(()=>h.read(),/Choose a car/);equal(h.saveButtons.every(button=>button.disabled),true);
 await h.click({'data-showcase-remove':h.keys().at(-1)});equal(h.read().length,2);equal(h.saveButtons.every(button=>!button.disabled),true);
 await h.click({'data-showcase-remove':first});await h.click({'data-showcase-remove':second});equal(h.read(),[]);equal(JSON.stringify(h.content.listings),original);equal(h.requests.length,0);ok(h.dirty>0);
}
{
 const content=fixture();content.settings.showcase=[{listingId:'ferrari',image:'/assets/a.png'},{listingId:'ferrari-other',image:'/assets/b.png'}];
 const h=harness({content});h.mount();throws(()=>h.read(),/one Ferrari/);equal(h.saveButtons[0].disabled,true);
 content.settings.showcase=[{listingId:'sold',image:'/assets/a.png'}];h.mount();throws(()=>h.read(),/no longer available/);
 content.settings.showcase=[{listingId:'custom',image:''}];h.mount();throws(()=>h.read(),/background-free image/);
 const many=fixture();many.settings.showcase=[];const limit=harness({content:many});limit.mount();for(let count=0;count<14;count++)await limit.click({'data-showcase-add':''});equal(limit.keys().length,12,'Even forged add clicks stop at twelve rows');
}

// Content-read users get previews only. Content writers without media access
// can reuse exact stock cutouts but cannot start image processing or uploads.
{
 const h=harness({permissions:[]});const html=h.mount();omits(html,'data-showcase-add');omits(html,'data-showcase-remove');omits(html,'data-showcase-prepare');
 await h.click({'data-showcase-add':''});equal(h.keys().length,2);throws(()=>h.read(),/Open Website again/);equal(h.requests.length,0);
}
{
 const h=harness({permissions:['content.write']});h.mount();const key=h.keys()[0];await h.choose(key,'custom');equal(h.engineCalls,0);equal(h.requests.length,0);throws(()=>h.read(),/background-free image/);contains(h.markup,'image-upload permission');
 await h.upload(key,new Blob(['fake'],{type:'image/png'}),true);equal(h.requests.length,0);
 await h.choose(key,'porsche');equal(h.read()[0].image,'/assets/porsche-cutout.png');equal(h.requests.length,0);
}

// New non-stock selections automatically prepare then upload an image; the
// result remains a draft until the surrounding settings form explicitly saves.
{
 const h=harness();h.mount();const pending=deferred();h.setEngine(()=>pending.promise);const choice=h.choose(h.keys()[0],'custom');
 await until(()=>h.engineCalls===1);equal(h.saveButtons[0].disabled,true);throws(()=>h.read(),/Finish or cancel/);equal(h.requests.length,0);
 pending.resolve({blob:new Blob(['cutout'],{type:'image/png'})});await choice;
 equal(h.requests.length,1);equal(h.requests[0].url,'/media');equal(h.requests[0].method,'POST');equal(h.read()[0],{listingId:'custom',image:'/assets/uploads/showcase-ready.png'});equal(h.saveButtons[0].disabled,false);
 omits(JSON.stringify(h.content.settings),'showcase','Processing alone never publishes a setting');contains(h.markup,'Review the cutout');
}
{
 const h=harness();h.mount();const key=h.keys()[0];await h.upload(key,new Blob(['transparent'],{type:'image/png'}),true);equal(h.validationCalls,1);equal(h.engineCalls,0);equal(h.requests.length,1);
 h.setValidation(async()=>{throw Error('Choose an image with transparent pixels.');});await h.upload(key,new Blob(['opaque'],{type:'image/png'}),true);
 equal(h.requests.length,1,'Rejected opaque uploads do not reach media storage');contains(h.markup,'transparent pixels');contains(h.markup,'existing cutout is unchanged');equal(h.read()[0].image,'/assets/uploads/showcase-ready.png');
}
{
 const content=fixture();content.listings.find(car=>car.id==='custom').image='https://elsewhere.test/car.jpg';const h=harness({content});h.mount();await h.choose(h.keys()[0],'custom');
 equal(h.fetches.length,0,'External listing images are not fetched through a server proxy');equal(h.engineCalls,0);contains(h.markup,'Choose photo to upload');throws(()=>h.read(),/background-free image/);
 await h.upload(h.keys()[0],new Blob(['source'],{type:'image/jpeg'}));equal(h.engineCalls,1);equal(h.requests.length,1);equal(h.read()[0].listingId,'custom');
}

// Cancelled, detached and logged-out forms cannot receive or publish stale work.
// The AbortSignal also reaches the segmentation engine and media request.
{
 const h=harness();h.mount();const pending=deferred();h.setEngine(()=>pending.promise);const key=h.keys()[0],choice=h.choose(key,'custom');await until(()=>h.engineCalls===1);
 await h.click({'data-showcase-cancel':key});equal(h.progress[0].signal.aborted,true);contains(h.markup,'Image processing cancelled');
 pending.resolve({blob:new Blob(['late'],{type:'image/png'})});await choice;equal(h.requests.length,0);throws(()=>h.read(),/background-free image/);
}
{
 const h=harness();h.mount();const pending=deferred();h.setEngine(()=>pending.promise);const choice=h.choose(h.keys()[0],'custom');await until(()=>h.engineCalls===1);h.detach();equal(h.progress[0].signal.aborted,true);
 pending.resolve({blob:new Blob(['late'],{type:'image/png'})});await choice;equal(h.requests.length,0);
}
{
 const h=harness();h.mount();const pending=deferred();h.setEngine(()=>pending.promise);const choice=h.choose(h.keys()[0],'custom');await until(()=>h.engineCalls===1);h.state.session.authenticated=false;
 pending.resolve({blob:new Blob(['late'],{type:'image/png'})});await choice;equal(h.requests.length,0,'Logout prevents upload even if a worker resolves after auth changed');
}
{
 const h=harness();h.mount();h.form.dataset.showcaseSaving='true';h.syncShowcaseSaveState(h.form);equal(h.saveButtons.every(button=>button.disabled),true);equal(h.controls.every(control=>control.disabled),true);
 await h.click({'data-showcase-add':''});equal(h.keys().length,2,'Save in progress locks editing');
 delete h.form.dataset.showcaseSaving;h.syncShowcaseSaveState(h.form);equal(h.saveButtons.every(button=>!button.disabled),true);equal(h.controls.map(control=>control.disabled),[false,true],'Failed saves restore each control’s prior disabled state');
 h.flush();h.flush();equal(h.requests.length,0,'Observer-driven state updates never save anything');
}

console.log(`PASS: ${checks} showcase admin checks covering defaults, ordered selection, permissions, explicit-save boundaries, image uploads and async cancellation/stale guards.`);
