import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {compileWorker} from './compile-worker.mjs';
import {localDB} from './d1-local.mjs';
import {createPreviewServer} from './preview.mjs';
import {PASSWORD_VERSION} from '../worker/password.js';

// Synthetic data and in-memory storage only. No production account, model call,
// external message or uploaded customer image is used by this regression suite.
const seed=JSON.parse(await readFile('public/content.json','utf8'));
const code=await compileWorker({content:seed});
const worker=(await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).default;
const DB=localDB(),origin='https://showcase.test';
const hash=value=>createHash('sha256').update(value).digest('hex');
const random=()=>randomBytes(32).toString('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV4sAAAAASUVORK5CYII=','base64');
const images=Object.fromEntries(['live','reserved','draft','sold','missing','wanted'].map(key=>[key,'/assets/uploads/'+randomUUID()+'.png']));
const objects=new Map(Object.values(images).map(url=>[url.slice('/assets/'.length),{key:url.slice('/assets/'.length),size:png.length,customMetadata:{name:'Synthetic image.png',uploadedAt:new Date().toISOString()},body:null}]));
const BUCKET={async get(key){const object=objects.get(key);return object?{...object,body:new Response(png).body}:null;},async head(key){return objects.get(key)||null;}};
const env={DB,BUCKET};let checks=0,server,temporaryRoot;
const ok=(value,message)=>{assert.ok(value,message);checks++;};
const equal=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
async function actor(username,permissions,primary=false){
  const id=primary?'owner':randomUUID(),salt=random(),passwordHash=random(),token=random(),time=Math.floor(Date.now()/1000);
  if(primary)await DB.prepare('INSERT INTO administrator (id,username,salt,hash,hash_version) VALUES (1,?,?,?,?)').bind(username,salt,passwordHash,PASSWORD_VERSION).run();
  else await DB.prepare('INSERT INTO staff_users (id,username,role,permissions,salt,hash,hash_version,must_change_password,disabled,created_at,updated_at,temp_expires_at) VALUES (?,?,?,?,?,?,?,0,0,?,?,NULL)').bind(id,username,'editor',JSON.stringify(permissions),salt,passwordHash,PASSWORD_VERSION,time,time).run();
  await DB.prepare('INSERT INTO sessions (token_hash,session_id,created_at,last_seen,expires,credential_version,user_id) VALUES (?,?,?,?,?,?,?)').bind(hash(token),random(),time,time,time+3600,hash(`${salt}:${passwordHash}:${PASSWORD_VERSION}`),id).run();
  return {Cookie:'__Host-e1='+token+'; e1-local='+token,'X-CSRF-Token':hash('csrf:'+token)};
}
async function call(route,method='GET',value,auth={},expected=200){
  const response=await worker.fetch(new Request(origin+route,{method,headers:{Origin:origin,'Content-Type':'application/json',...auth},...(value===undefined?{}:{body:JSON.stringify(value)})}),env,{});
  const type=response.headers.get('Content-Type')||'',data=type.includes('application/json')?await response.json():await response.arrayBuffer();
  equal(response.status,expected,route+': '+(type.includes('application/json')?JSON.stringify(data):'image response'));
  return {response,data};
}
const contentFor=async auth=>(await call('/api/content','GET',undefined,auth)).data;
async function replace(content){await DB.prepare('INSERT INTO site_content (id,body,revision) VALUES (?,?,1) ON CONFLICT(id) DO UPDATE SET body=excluded.body,revision=site_content.revision+1').bind('main',JSON.stringify(content)).run();}
const stored=async()=>JSON.parse((await DB.prepare("SELECT body FROM site_content WHERE id='main'").first()).body);
const base=structuredClone(seed);
const template=seed.listings.find(car=>car.type==='inventory');
base.listings=[
  {...template,id:'live',brand:'Porsche',status:'available',featured:true},
  {...template,id:'reserved',brand:'Ferrari',status:'reserved',featured:false},
  {...template,id:'draft',brand:'Bugatti',status:'draft',featured:false,internalNotes:'PRIVATE DRAFT'},
  {...template,id:'sold',brand:'Pagani',status:'sold',featured:false},
  {...template,id:'wanted',type:'wanted',brand:'McLaren',status:'active',featured:false},
  {...template,id:'second-porsche',brand:'Porsche',status:'available',featured:false}
];
const config=['live','reserved','draft','sold','missing','wanted'].map(listingId=>({listingId,image:images[listingId]}));
try{
  const owner=await actor('owner-showcase',[],true);
  const inventory=await actor('inventory-editor',['inventory.read','inventory.write']);
  const website=await actor('website-editor',['content.read','content.write']);
  const viewer=await actor('restricted-viewer',['content.read']);
  await replace(base);
  let result=await contentFor();ok(!Object.hasOwn(result.content.settings,'showcase'),'Omission retains the legacy showcase default');
  result=await contentFor(owner);result.content.settings.showcase=[];await call('/api/content','PUT',result,owner);equal((await contentFor()).content.settings.showcase,[],'Explicit empty selection stays empty');

  for(const invalid of [null,{},'live',Array.from({length:13},()=>({listingId:'live',image:images.live})),[{}],[{listingId:'',image:images.live}],[{listingId:4,image:images.live}],[{listingId:'x'.repeat(201),image:images.live}],[{listingId:'bad\u0000id',image:images.live}],[{listingId:'live',image:''}],[{listingId:'live',image:'http://example.com/car.png'}],[{listingId:'live',image:'https://name:secret@example.com/car.png'}],[{listingId:'live',image:'javascript:alert(1)'}],[{listingId:'live',image:'data:image/png;base64,abc'}],[{listingId:'live',image:'/assets/../secret.png'}],[{listingId:'live',image:'//example.com/car.png'}],[{listingId:'live',image:images.live,unexpected:true}]]){
    const before=await stored(),draft=await contentFor(owner);draft.content.settings.showcase=invalid;await call('/api/content','PUT',draft,owner,400);equal(await stored(),before,'Invalid showcase data never changes saved content');
  }
  result=await contentFor(owner);result.content.settings.showcase=[{listingId:' live ',image:' https://images.example.com/car.png '},{listingId:'live',image:images.live}];
  await call('/api/content','PUT',result,owner);equal((await stored()).settings.showcase,[{listingId:'live',image:'https://images.example.com/car.png'}],'Repeated IDs keep the first normalized selection');
  result=await contentFor(owner);result.content.listings.push({...template,id:'car. with spaces',status:'available',featured:false});result.content.settings.showcase=[{listingId:'car. with spaces',image:images.live}];
  await call('/api/content','PUT',result,owner);equal((await contentFor()).content.settings.showcase[0].listingId,'car. with spaces','Existing listing IDs are supported without a stricter ID alphabet');
  result=await contentFor(owner);result.content.settings.showcase=Array.from({length:12},(_,i)=>({listingId:'historical-'+i,image:images.missing}));
  await call('/api/content','PUT',result,owner);equal((await contentFor(owner)).content.settings.showcase.length,12);equal((await contentFor()).content.settings.showcase,[],'Stale selections are kept for administration but never exposed publicly');

  const mixed={...structuredClone(base),settings:{...structuredClone(base.settings),showcase:config}};await replace(mixed);
  for(const auth of [{},viewer,website]){
    const projection=(await contentFor(auth)).content;equal(projection.settings.showcase,config.slice(0,2),'Public and inventory-restricted accounts only receive published inventory selections');
    const serialized=JSON.stringify(projection);for(const key of ['draft','sold','missing'])ok(!serialized.includes(images[key]),'Hidden showcase image is not leaked');
  }
  equal((await contentFor(owner)).content.settings.showcase,config,'Owners retain private, sold, missing and stale wanted selections');
  equal((await contentFor(inventory)).content.settings.showcase,config.slice(0,5),'Authorised inventory staff retain stale/private inventory configuration');
  for(const route of ['/content.json','/api/chat/status'])await call(route);
  const publicJson=(await call('/content.json')).data;equal(publicJson.settings.showcase,config.slice(0,2));

  // Inventory-only saves preserve the original homepage configuration, even
  // when listing status or brand changes make some selections no longer public.
  result=await contentFor(inventory);result.content.listings.find(car=>car.id==='live').brand='Ferrari';result.content.listings.find(car=>car.id==='live').status='sold';
  await call('/api/content','PUT',result,inventory);equal((await stored()).settings.showcase,config,'Unrelated inventory edits do not drop hidden or duplicate-brand configuration');
  equal((await contentFor()).content.settings.showcase,[config[1]]);
  result=await contentFor(inventory);result.content.settings.showcase=[];await call('/api/content','PUT',result,inventory,403);
  await replace(mixed);
  result=await contentFor(website);result.content.settings.headline='Updated website headline';await call('/api/content','PUT',result,website);equal((await stored()).settings.showcase,config,'Website-only edits keep unseen configuration in original order');
  result=await contentFor(website);result.content.settings.showcase=[{listingId:'reserved',image:'https://images.example.com/new-showcase.png'}];await call('/api/content','PUT',result,website);
  const afterWebsiteSave=(await stored()).settings.showcase;for(const hidden of config.slice(2))ok(afterWebsiteSave.some(row=>row.listingId===hidden.listingId&&row.image===hidden.image),'Replacing public selections preserves unseen rows');
  equal((await contentFor()).content.settings.showcase,[{listingId:'reserved',image:'https://images.example.com/new-showcase.png'}]);
  result=await contentFor(website);result.content.settings.showcase=[{listingId:'draft',image:'https://images.example.com/guessed-private.png'}];await call('/api/content','PUT',result,website,403);
  result=await contentFor(website);result.content.settings.showcase=[];await call('/api/content','PUT',result,website);equal((await contentFor()).content.settings.showcase,[]);equal((await stored()).settings.showcase,config.slice(2),'Hiding the public showcase does not erase unseen private configuration');
  const event=await DB.prepare("SELECT detail FROM audit_log WHERE action='content.save' ORDER BY id DESC LIMIT 1").first();ok(JSON.parse(event.detail).settingsFields.includes('showcase'),'Showcase edits appear in the audit field list');ok(!event.detail.includes('images.example.com'),'Image URLs do not enter audit details');

  // Hosted uploaded cutouts are public only while selected for public stock.
  await replace(mixed);
  for(const key of ['live','reserved'])await call(images[key]);
  for(const key of ['draft','sold','missing','wanted'])await call(images[key],'GET',undefined,{},404);
  await call(images.draft,'GET',undefined,website,404);await call(images.draft,'GET',undefined,owner);
  result=await contentFor(owner);result.content.listings.find(car=>car.id==='live').status='draft';await call('/api/content','PUT',result,owner);await call(images.live,'GET',undefined,{},404);
  const csp=(await call('/api/content')).response.headers.get('Content-Security-Policy');
  ok(csp.includes("script-src 'self' 'wasm-unsafe-eval';"));ok(csp.includes("worker-src 'self';"));ok(csp.includes("img-src 'self' https: data: blob:;"));ok(!csp.includes("'unsafe-eval'"));ok(csp.includes("connect-src 'self';"));

  // The local preview applies the same publication rules and serves the local
  // WebAssembly runtime with executable-safe MIME/CSP rather than relaxing JS.
  temporaryRoot=await mkdtemp(path.join(tmpdir(),'entity-showcase-test-'));
  const publicDirectory=path.join(temporaryRoot,'public'),runtimeDirectory=path.join(temporaryRoot,'runtime');await mkdir(publicDirectory);
  const modelBytes=Buffer.from([8,9,18,14,115,121,110,116,104,101,116,105,99,45,111,110,110,120]);
  await Promise.all([writeFile(path.join(publicDirectory,'content.json'),JSON.stringify(base)),writeFile(path.join(publicDirectory,'index.html'),'<!doctype html><title>Showcase test</title>'),writeFile(path.join(publicDirectory,'runtime.mjs'),'export const ready = true;'),writeFile(path.join(publicDirectory,'runtime.wasm'),Buffer.from([0,97,115,109,1,0,0,0])),writeFile(path.join(publicDirectory,'model.onnx'),modelBytes)]);
  server=await createPreviewServer({publicDirectory,runtimeDirectory,database:DB});server.listen(0,'127.0.0.1');await once(server,'listening');const localOrigin='http://127.0.0.1:'+server.address().port;
  for(const [file,type]of [['runtime.wasm','application/wasm'],['runtime.mjs','text/javascript; charset=utf-8'],['model.onnx','application/octet-stream']]){const response=await fetch(localOrigin+'/'+file);equal(response.status,200);equal(response.headers.get('Content-Type'),type);ok(response.headers.get('Content-Security-Policy').includes("worker-src 'self';"));if(file==='model.onnx')equal(Buffer.from(await response.arrayBuffer()),modelBytes,'ONNX model assets are served intact rather than returning an HTML fallback or 404');}
  async function localUpload(){const form=new FormData();form.set('file',new Blob([png],{type:'image/png'}),'cutout.png');const response=await fetch(localOrigin+'/api/media',{method:'POST',headers:{Origin:localOrigin,...owner},body:form});equal(response.status,201);return (await response.json()).media.url;}
  const localLive=await localUpload(),localPrivate=await localUpload();await replace({...structuredClone(base),settings:{...structuredClone(base.settings),showcase:[{listingId:'live',image:localLive},{listingId:'draft',image:localPrivate}]}});
  equal((await fetch(localOrigin+localLive)).status,200);equal((await fetch(localOrigin+localPrivate)).status,404);equal((await fetch(localOrigin+localPrivate,{headers:website})).status,404);equal((await fetch(localOrigin+localPrivate,{headers:owner})).status,200);
  result=await contentFor(owner);result.content.settings.showcase=[];await call('/api/content','PUT',result,owner);equal((await fetch(localOrigin+localLive)).status,404,'Removing the last public showcase reference makes its cutout private');
  result=await contentFor(owner);delete result.content.settings.showcase;await call('/api/content','PUT',result,owner);ok(!Object.hasOwn((await contentFor()).content.settings,'showcase'),'Removing the override restores legacy defaults');
  const defaultEvent=await DB.prepare("SELECT detail FROM audit_log WHERE action='content.save' ORDER BY id DESC LIMIT 1").first();ok(JSON.parse(defaultEvent.detail).settingsFields.includes('showcase'),'Restoring default showcase is also recorded in audit history');
  console.log(`PASS: ${checks} showcase checks for validation, explicit empty/default modes, private/stale projections, permission-safe saves, audit fields, hosted/local media access and restricted WebAssembly CSP/MIME.`);
}finally{
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  DB.close();
  if(temporaryRoot){const resolved=path.resolve(temporaryRoot),parent=path.resolve(tmpdir());if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('entity-showcase-test-'))throw Error('Refusing to remove an unexpected test directory');await rm(resolved,{recursive:true,force:true});}
}
