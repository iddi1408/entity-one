import {state,h,safeUrl,api} from './app.js';
import {can} from './access.js';
import {defaultShowcase,stockCutout} from './showcase-config.js';
import {bindCutoutFrames} from './cutout-frame.js';

const LIMIT=12,MAX_IMAGE_BYTES=8*1024*1024;
const liveCars=content=>(content?.listings||[]).filter(car=>car.type==='inventory'&&['available','reserved'].includes(car.status||'available'));
const brandKey=car=>String(car?.brand||'').trim().toLowerCase();
let draft=null,generation=0,activeJob=null,bound=false,markDirty=()=>{};

export function clearShowcaseAdmin(){
 generation++;activeJob?.controller.abort();activeJob=null;draft=null;
}
function ownerId(){return state.session.user?.id||state.session.user?.username||''}
function currentForm(){
 const root=document.querySelector('#showcase-editor');
 return draft&&root?.dataset.showcaseSession===String(draft.generation)?root.closest('#settings-form'):null;
}
function editable(form=currentForm()){
 return !!form?.isConnected&&form===currentForm()&&draft?.actor===ownerId()&&can('content.write')&&form.dataset.showcaseSaving!=='true';
}
function dirty(form){
 markDirty(true);
 form.querySelector('[data-unsaved]')?.replaceChildren(document.createTextNode('You have unsaved changes. Review the showcase, then save.'));
 document.querySelector('.adm-save-state')?.replaceChildren(document.createTextNode('Unsaved changes'));
}
function validationMessage(){
 if(!draft)return 'Open Website again to edit the homepage showcase.';
 if(activeJob)return 'Finish or cancel image processing before saving.';
 if(draft.rows.length>LIMIT)return `Choose no more than ${LIMIT} brands.`;
 const used=new Set(),cars=liveCars(state.adminData);
 for(const row of draft.rows){
  if(!row.listingId)return 'Choose a car for every showcase row, or remove the empty row.';
  const car=cars.find(car=>car.id===row.listingId);
  if(!car)return 'A selected car is no longer available or reserved. Replace it or remove it from the showcase.';
  const brand=brandKey(car);
  if(used.has(brand))return `Choose only one ${car.brand} for the showcase.`;
  used.add(brand);
  if(!row.image)return `Prepare a background-free image for ${car.brand} ${car.model}, or remove this row.`;
 }
 return '';
}
function rowHtml(row,index){
 const cars=liveCars(state.adminData),car=cars.find(car=>car.id===row.listingId),allCar=state.adminData?.listings?.find(car=>car.id===row.listingId);
 const usedBrands=new Set(draft.rows.filter(other=>other!==row).map(other=>brandKey(cars.find(car=>car.id===other.listingId))).filter(Boolean));
 const media=can('media.write'),write=can('content.write'),busy=!!activeJob,disabled=!write||busy;
 const image=row.image||car?.image||'',name=car?`${car.brand} ${car.model}`:allCar?`${allCar.brand} ${allCar.model}`:'Choose a car';
 const selectedMissing=row.listingId&&!car;
 return `<article class="adm-showcase-card" data-showcase-row="${h(row.key)}">
  <div class="adm-showcase-card-head"><span class="adm-showcase-order">${String(index+1).padStart(2,'0')}</span><div><strong>${h(name)}</strong><small>${row.image?'Cutout ready for review':car?'Prepare an image without its background':'One car per brand'}</small></div>${write?`<div class="adm-showcase-order-actions"><button type="button" class="adm-secondary" data-showcase-up="${h(row.key)}" aria-label="Move ${h(name)} up" ${disabled||index===0?'disabled':''}>↑</button><button type="button" class="adm-secondary" data-showcase-down="${h(row.key)}" aria-label="Move ${h(name)} down" ${disabled||index===draft.rows.length-1?'disabled':''}>↓</button><button type="button" class="adm-text" data-showcase-remove="${h(row.key)}" ${disabled?'disabled':''}>Remove</button></div>`:''}</div>
  <div class="adm-showcase-card-body"><div class="adm-showcase-preview ${row.image?'':'is-source'}">${image?`<div class="adm-showcase-image-frame ${row.image?'cutout-frame':''}"><img ${row.image?'data-cutout-fit':''} src="${h(safeUrl(image))}" alt="${h(row.image?'Background-free preview of '+name:'Original photo of '+name)}"></div><span>${row.image?'Showcase preview':'Original listing photo'}</span>`:'<span>Choose a car to see its preview</span>'}</div><div class="adm-showcase-controls">
   <label>Car from inventory<select data-showcase-car="${h(row.key)}" ${disabled?'disabled':''}><option value="">Choose an available car</option>${selectedMissing?`<option value="${h(row.listingId)}" selected>${h(name)} — no longer public</option>`:''}${cars.map(option=>`<option value="${h(option.id)}" ${option.id===row.listingId?'selected':''} ${usedBrands.has(brandKey(option))?'disabled':''}>${h(option.brand+' — '+option.model+' ('+option.year+')')}${usedBrands.has(brandKey(option))?' · brand already selected':''}</option>`).join('')}</select></label>
   ${write&&car?`<div class="adm-showcase-image-actions">${media?`<button type="button" class="adm-secondary" data-showcase-prepare="${h(row.key)}" ${busy?'disabled':''}>${row.error?'Retry background removal':row.image?'Redo background removal':'Prepare background-free image'}</button><label class="adm-secondary adm-file-button ${busy?'is-disabled':''}">Choose photo<input type="file" data-showcase-source="${h(row.key)}" accept="image/jpeg,image/png,image/webp" ${busy?'disabled':''}></label><label class="adm-secondary adm-file-button ${busy?'is-disabled':''}">Upload cutout<input type="file" data-showcase-cutout="${h(row.key)}" accept="image/png,image/webp" ${busy?'disabled':''}></label>`:'<p class="adm-muted">Image preparation needs image-upload permission. You can choose an existing stock cutout or ask a team member with access to prepare one.</p>'}</div>`:''}
   <p class="adm-showcase-status ${row.error?'is-error':''}" role="${row.error?'alert':'status'}" aria-live="polite" data-showcase-status="${h(row.key)}">${h(row.error||row.progress||(selectedMissing?'Replace or remove this unavailable car.':row.image?'Review the wheels, mirrors and edges before saving.':car?'Selecting a new car starts image preparation automatically.':'Only available and reserved inventory can appear here.'))}</p>
   ${activeJob?.key===row.key?`<button type="button" class="adm-text" data-showcase-cancel="${h(row.key)}">Cancel processing</button>`:''}
  </div></div></article>`;
}
function editorBody(){
 const cars=liveCars(state.adminData),used=new Set(draft.rows.map(row=>brandKey(cars.find(car=>car.id===row.listingId))).filter(Boolean));
 const canAdd=draft.rows.length<LIMIT&&cars.some(car=>!used.has(brandKey(car)));
 return `<div class="adm-showcase-toolbar"><span><strong>${draft.rows.length}</strong> / ${LIMIT} brand slots</span>${can('content.write')?`<button type="button" class="adm-secondary" data-showcase-add ${!canAdd||activeJob?'disabled':''}>Add a car ＋</button>`:''}</div><div class="adm-showcase-list">${draft.rows.length?draft.rows.map(rowHtml).join(''):`<div class="adm-showcase-empty"><strong>The homepage showcase is hidden.</strong><p>${cars.length?'Add a car to start a new selection.':'Add an available or reserved inventory listing first.'}</p></div>`}</div><p class="adm-showcase-save-help" data-showcase-save-help role="status" aria-live="polite"></p>`;
}
export function renderShowcaseEditor(content){
 clearShowcaseAdmin();
 const configured=Array.isArray(content.settings.showcase)?content.settings.showcase:defaultShowcase(content);
 draft={generation,actor:ownerId(),rows:configured.map((entry,index)=>({key:`showcase-${generation}-${index}`,listingId:entry.listingId,image:entry.image||'',sourceBlob:null,error:'',progress:''})),nextKey:configured.length};
 return `<details class="adm-settings-group adm-showcase-group" open><summary><span>01</span> Homepage showcase <b>＋</b></summary><div><p class="adm-showcase-intro">Choose the cars in the large homepage brand selector. Add one car per brand and arrange their order below. The separate featured inventory grid still uses each listing’s “Feature on the homepage” setting.</p><p class="adm-showcase-explainer">Background removal runs on this device. Cars are automatically centred and fitted to the frame. Review each cutout before saving. For the best result, use a clear photo with the whole car visible, or upload a transparent PNG or WebP.</p><div id="showcase-editor" data-showcase-session="${generation}">${editorBody()}</div><p class="adm-muted">Removing every car hides the showcase. Your inventory listings and their original photographs stay unchanged.</p></div></details>`;
}
function refresh(form,focusSelector){
 if(form!==currentForm())return;
 const root=form.querySelector('#showcase-editor');root.innerHTML=editorBody();syncShowcaseSaveState(form);
 if(focusSelector)root.querySelector(focusSelector)?.focus();
}
export function syncShowcaseSaveState(form=currentForm()){
 if(!form||form!==currentForm())return;
 const saving=form.dataset.showcaseSaving==='true',issue=validationMessage(),help=form.querySelector('[data-showcase-save-help]');
 if(help){const copy=saving?'Saving website changes…':issue||'Ready for review. Save website changes when you are happy with every cutout.';if(help.textContent!==copy)help.textContent=copy;help.classList.toggle('is-error',!!issue&&!activeJob)}
 const footer=form.querySelector('[data-unsaved]');
 if(footer&&issue){if(footer.textContent!==issue)footer.textContent=issue;footer.dataset.showcaseIssue='true'}
 else if(footer?.dataset.showcaseIssue){footer.textContent='You have unsaved changes. Review the showcase, then save.';delete footer.dataset.showcaseIssue}
 for(const button of form.querySelectorAll('button[type=submit]')){button.disabled=saving||!!issue||!can('content.write');button.title=issue||''}
 for(const input of form.querySelectorAll('#showcase-editor button,#showcase-editor input,#showcase-editor select')){
  if(saving){if(input.dataset.showcaseLocked===undefined)input.dataset.showcaseLocked=String(input.disabled);input.disabled=true}
  else if(input.dataset.showcaseLocked!==undefined){input.disabled=input.dataset.showcaseLocked==='true';delete input.dataset.showcaseLocked}
 }
}
export function readShowcaseSettings(form){
 if(form!==currentForm()||draft.actor!==ownerId()||!can('content.write'))throw Error('Open Website again before saving the showcase.');
 const issue=validationMessage();if(issue)throw Error(issue);
 return draft.rows.map(({listingId,image})=>({listingId,image}));
}
function validJob(job){
 return activeJob===job&&job.generation===generation&&draft?.actor===ownerId()&&job.form.isConnected&&job.form===currentForm()&&can('content.write')&&can('media.write')&&draft.rows.some(row=>row.key===job.key&&row.listingId===job.listingId)&&!job.controller.signal.aborted;
}
function progress(job,message){
 if(!validJob(job))return;
 const row=draft.rows.find(row=>row.key===job.key);row.progress=String(message).slice(0,200);
 const status=job.form.querySelector(`[data-showcase-status="${job.key}"]`);if(status)status.textContent=row.progress;
}
async function listingPhoto(car,signal){
 const url=new URL(car.image,location.origin);
 if(url.origin!==location.origin)throw Error('This photo is hosted elsewhere. Choose photo to upload the original here, or upload a transparent cutout.');
 if(!['http:','https:'].includes(url.protocol))throw Error('Choose photo to upload the original image.');
 const response=await fetch(url.href,{credentials:'same-origin',signal});
 if(!response.ok)throw Error('The listing photo could not be loaded. Choose photo to upload the original image.');
 if(Number(response.headers.get('content-length'))>MAX_IMAGE_BYTES)throw Error('Choose a photo smaller than 8 MB.');
 const blob=await response.blob();
 if(blob.size>MAX_IMAGE_BYTES)throw Error('Choose a photo smaller than 8 MB.');
 if(!['image/jpeg','image/png','image/webp'].includes(blob.type))throw Error('Choose a JPG, PNG or WebP photo.');
 return blob;
}
async function prepare(row,form,{file=null,transparent=false}={}){
 if(!editable(form)||!can('media.write')||activeJob)return;
 const car=liveCars(state.adminData).find(car=>car.id===row.listingId);if(!car)return;
 const controller=new AbortController(),job={controller,key:row.key,listingId:row.listingId,form,generation};activeJob=job;
 row.error='';row.progress=transparent?'Checking transparency…':'Preparing photo…';dirty(form);refresh(form);
 try{
  const source=file||row.sourceBlob||await listingPhoto(car,controller.signal);
  if(!validJob(job))return;
  if(source.size>MAX_IMAGE_BYTES)throw Error('Choose a photo smaller than 8 MB.');
  if(file&&!transparent)row.sourceBlob=file;
  const engine=await import('./cutout.js');if(!validJob(job))return;
  const result=transparent?await engine.validateTransparentImage(source,{signal:controller.signal}):await engine.prepareCutout(source,{onProgress:message=>progress(job,message),signal:controller.signal});
  if(!validJob(job))return;
  if(!result.blob||result.blob.size>MAX_IMAGE_BYTES)throw Error('The prepared image is too large. Try a smaller source photo.');
  progress(job,'Saving image to your media library…');
  const upload=new FormData();upload.set('file',result.blob,`showcase-${car.id.replace(/[^a-z0-9-]/gi,'').slice(0,60)}.png`);
  const response=await api('/media',{method:'POST',body:upload,signal:controller.signal});
  if(!validJob(job))return;
  if(!response.media?.url)throw Error('The prepared image could not be saved. Please try again.');
  row.image=response.media.url;row.progress='Image ready. Review the cutout, then save website changes to publish it.';row.error='';dirty(form);
 }catch(error){
  if(validJob(job)){row.progress='';row.error=(row.image?'Your existing cutout is unchanged. ':'')+(error?.name==='AbortError'?'Image processing cancelled.':error?.message||'Image preparation failed. Try again or upload a transparent cutout.')}
 }finally{
  if(activeJob===job){activeJob=null;if(form===currentForm()&&form.isConnected)refresh(form)}
 }
}
function rowFor(key){return draft?.rows.find(row=>row.key===key)}
export function bindShowcaseAdmin({markDirty:mark}={}){
 if(mark)markDirty=mark;if(bound)return;bound=true;bindCutoutFrames();
 document.addEventListener('change',async event=>{
  const target=event.target,form=target.closest('#settings-form');if(!editable(form))return;
  if(target.dataset.showcaseCar){
   const row=rowFor(target.dataset.showcaseCar),car=liveCars(state.adminData).find(car=>car.id===target.value);if(!row||activeJob)return;
   if(car&&draft.rows.some(other=>other!==row&&brandKey(liveCars(state.adminData).find(car=>car.id===other.listingId))===brandKey(car))){target.value=row.listingId;return}
   row.listingId=car?.id||'';row.image=car?stockCutout(car)||'':'';row.sourceBlob=null;row.error='';row.progress='';dirty(form);refresh(form,`[data-showcase-car="${row.key}"]`);
   if(car&&!row.image){if(can('media.write'))await prepare(row,form);else{row.error='Ask a team member with image-upload permission to prepare this photo.';refresh(form)}}
  }
  const key=target.dataset.showcaseSource||target.dataset.showcaseCutout;
  if(key){const row=rowFor(key),file=target.files?.[0];target.value='';if(row&&file)await prepare(row,form,{file,transparent:!!target.dataset.showcaseCutout})}
 });
 document.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button)return;
  const form=button.closest('#settings-form');if(!editable(form))return;
  if(button.dataset.showcaseCancel){const job=activeJob;if(job?.key===button.dataset.showcaseCancel){job.controller.abort();activeJob=null;const row=rowFor(job.key);if(row){row.progress='';row.error=(row.image?'Your existing cutout is unchanged. ':'')+'Image processing cancelled. Retry or upload a transparent cutout.'}refresh(form)}return}
  if(activeJob)return;
  if(button.hasAttribute('data-showcase-add')){
   if(draft.rows.length>=LIMIT)return;
   draft.rows.push({key:`showcase-${generation}-${draft.nextKey++}`,listingId:'',image:'',sourceBlob:null,error:'',progress:''});dirty(form);refresh(form,`[data-showcase-car="${draft.rows.at(-1).key}"]`);
  }
  const remove=button.dataset.showcaseRemove;if(remove){draft.rows=draft.rows.filter(row=>row.key!==remove);dirty(form);refresh(form,'[data-showcase-add]')}
  const up=button.dataset.showcaseUp,down=button.dataset.showcaseDown;
  if(up||down){const index=draft.rows.findIndex(row=>row.key===(up||down)),next=index+(up?-1:1);if(index>=0&&next>=0&&next<draft.rows.length){[draft.rows[index],draft.rows[next]]=[draft.rows[next],draft.rows[index]];dirty(form);refresh(form,`[data-showcase-${up?'up':'down'}="${up||down}"]`)}}
  const prepareKey=button.dataset.showcasePrepare;if(prepareKey){const row=rowFor(prepareKey);if(row)await prepare(row,form)}
 });
 const observer=new MutationObserver(()=>{
  if(activeJob&&(!activeJob.form.isConnected||activeJob.form!==currentForm()))clearShowcaseAdmin();
  const form=currentForm();if(form)syncShowcaseSaveState(form);
 });
 observer.observe(document.body,{childList:true,subtree:true});
}
