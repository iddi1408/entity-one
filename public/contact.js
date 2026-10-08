import {h} from './app.js';

const fields=['name','email','phone','country','intent','vehicle','message','website'];
const blank=()=>Object.fromEntries(fields.map(name=>[name,'']));
let draft=blank(),config=null,configLoading=false,busy=false;
let prefillIdentity='',prefilledVehicle='',feedback={kind:'',text:''};

function field(name,label,attributes='',optional=false){return `<label for="enquiry-${name}">${label}<span>${optional?'Optional':'Required'}</span></label><input id="enquiry-${name}" name="${name}" ${attributes} value="${h(draft[name])}">`}

export function contactForm(settings,listings,hasEmail){
 const selectedId=new URLSearchParams(location.search).get('car');
 const selected=listings.find(car=>car.id===selectedId&&!['draft','sold','fulfilled'].includes(car.status));
 if(selected&&prefillIdentity!=='car:'+selectedId){draft.vehicle=[selected.year,selected.brand,selected.model].filter(Boolean).join(' ');draft.intent=selected.type==='wanted'?'sell':'buy';prefillIdentity='car:'+selectedId;prefilledVehicle=draft.vehicle;feedback={kind:'',text:''};}
 const requestedIntent=new URLSearchParams(location.search).get('intent');
 const validIntent=['buy','sell','source','general'].includes(requestedIntent);
 if(!selected&&validIntent&&prefillIdentity!=='intent:'+requestedIntent){draft.intent=requestedIntent;if(prefilledVehicle&&draft.vehicle===prefilledVehicle)draft.vehicle='';prefilledVehicle='';prefillIdentity='intent:'+requestedIntent;feedback={kind:'',text:''};}
 if(!selected&&!validIntent)prefillIdentity='';
 const options=[...new Set(listings.filter(car=>car.type==='inventory'&&!['draft','sold','fulfilled'].includes(car.status)).map(car=>[car.year,car.brand,car.model].filter(Boolean).join(' ')))];
 return `<div class="contact-enquiry-layout"><div class="contact-enquiry-panel"><div class="contact-form-heading"><span class="micro">A DIRECT INTRODUCTION</span><h2>Tell us what<br>you have in mind.</h2><p>A particular car. A collection to sell. Something you haven’t found yet. Start here.</p></div><form id="contact-form" data-reply-email="${hasEmail?h(settings.email):''}" aria-label="Contact ENTITY-1"><fieldset class="contact-fields"><legend class="contact-sr-only">Your enquiry</legend><div class="contact-form-grid"><div>${field('name','Full name','required maxlength="120" autocomplete="name" placeholder="Your name"')}</div><div>${field('email','Email address','type="email" required maxlength="254" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="you@example.com"')}</div><div>${field('phone','Phone number','type="tel" maxlength="60" autocomplete="tel" placeholder="Include your country code"',true)}</div><div>${field('country','Country','maxlength="100" autocomplete="country-name" placeholder="Where are you based?"',true)}</div><div><label for="enquiry-intent">I’m interested in<span>Required</span></label><select id="enquiry-intent" name="intent" required><option value="" disabled ${!draft.intent?'selected':''}>Choose an enquiry type</option>${[['buy','Buying a car'],['sell','Selling a car'],['source','Sourcing a specific car'],['general','A general enquiry']].map(([value,label])=>`<option value="${value}" ${draft.intent===value?'selected':''}>${label}</option>`).join('')}</select></div><div>${field('vehicle','Car of interest','maxlength="200" list="enquiry-cars" placeholder="Choose a car or type any model"',true)}<datalist id="enquiry-cars">${options.map(label=>`<option value="${h(label)}"></option>`).join('')}</datalist></div><div class="contact-field-wide"><label for="enquiry-message">Your message<span>Required</span></label><textarea id="enquiry-message" name="message" required minlength="10" maxlength="5000" rows="5" placeholder="Tell us about the car, your requirements and anything else we should know.">${h(draft.message)}</textarea><div class="contact-field-hint"><span>A little detail helps us make the right introduction.</span><span data-contact-count>${draft.message.length.toLocaleString()} / 5,000</span></div></div></div><div class="contact-trap" aria-hidden="true"><label for="enquiry-website">Leave this field empty</label><input id="enquiry-website" name="website" tabindex="-1" autocomplete="off" value="${h(draft.website)}"></div></fieldset><div class="contact-form-status" id="contact-status" role="status" aria-live="polite" aria-atomic="true" tabindex="-1" hidden></div><div class="contact-send-row"><button type="submit" class="silver-button contact-submit" aria-describedby="contact-privacy contact-status" disabled><span>Send enquiry</span><span aria-hidden="true">↗</span></button><p id="contact-privacy">Your details are used to respond to your enquiry.<br><a href="/analytics-notice.html#contact-enquiries" target="_blank" rel="noopener">Privacy information ↗</a></p></div><div class="contact-delivery-note" data-contact-delivery><p>Checking online delivery…</p>${hasEmail?`<a href="mailto:${h(settings.email)}" data-contact-email>Send by email <span aria-hidden="true">↗</span></a>`:''}<button type="button" data-contact-retry hidden>Check again</button></div></form></div><aside class="contact-enquiry-aside" aria-label="Direct contact"><span class="contact-aside-mark" aria-hidden="true">↗</span><div class="contact-direct"><span class="micro">PREFER A DIRECT CONVERSATION?</span><h3>Always personal.</h3><p>Contact our team directly. We’ll connect you with the right person for your enquiry.</p>${hasEmail?`<a href="mailto:${h(settings.email)}">${h(settings.email)} <span aria-hidden="true">↗</span></a>`:`<p>${h(settings.email)}</p>`}</div><div class="contact-next"><span class="micro">WHAT HAPPENS NEXT</span><ol><li><span>01</span><div><strong>We read your enquiry.</strong><p>Your requirements give our team a place to start.</p></div></li><li><span>02</span><div><strong>A personal reply.</strong><p>We’ll get in touch using the details you share.</p></div></li><li><span>03</span><div><strong>The right connection.</strong><p>We discuss the possibilities and next steps together.</p></div></li></ol></div><span class="contact-aside-footer micro">PRIVATE. OFF-MARKET. WORLDWIDE.</span></aside></div>`;
}

function currentForm(){return document.querySelector('#contact-form')}
function captureDraft(form){
 draft=Object.fromEntries(fields.map(name=>[name,form.elements.namedItem(name)?.value||'']));
}
function emailUrl(address){
 const labels={buy:'Buying a car',sell:'Selling a car',source:'Sourcing a specific car',general:'General enquiry'};
 const body=[`Name: ${draft.name}`,`Email: ${draft.email}`,`Phone: ${draft.phone||'Not provided'}`,`Country: ${draft.country||'Not provided'}`,`Enquiry: ${labels[draft.intent]||'General enquiry'}`,`Car of interest: ${draft.vehicle||'Not specified'}`,'','Message:',draft.message].join('\n');
 return `mailto:${address}?subject=${encodeURIComponent('ENTITY-1 enquiry'+(draft.vehicle?' — '+draft.vehicle:''))}&body=${encodeURIComponent(body)}`;
}
function updateForm(){
 const form=currentForm();if(!form)return;
 form.querySelector('fieldset').disabled=busy;
 form.setAttribute('aria-busy',String(busy));
 const submit=form.querySelector('.contact-submit');submit.disabled=busy||config?.available!==true;
 submit.querySelector('span').textContent=busy?'Sending enquiry…':'Send enquiry';
 const status=form.querySelector('[data-contact-count]');status.textContent=`${draft.message.length.toLocaleString()} / 5,000`;
 const note=form.querySelector('[data-contact-delivery]');note.hidden=config?.available===true;
 note.querySelector('p').textContent=configLoading?'Checking online delivery…':config===null?'We couldn’t check online delivery. Your enquiry has not been sent.':'Online sending is not available yet. You can send your enquiry by email below.';
 note.querySelector('[data-contact-retry]').hidden=configLoading;
 const email=note.querySelector('[data-contact-email]');if(email)email.href=emailUrl(form.dataset.replyEmail);
 const message=form.querySelector('#contact-status');message.hidden=!feedback.text;message.dataset.kind=feedback.kind;message.textContent=feedback.text;
}
async function checkAvailability(){
 if(configLoading)return;
 configLoading=true;updateForm();
 try{
  const response=await fetch('/api/contact/config',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('Unavailable');
  const result=await response.json();config={key:typeof result.key==='string'?result.key:'',available:result.available===true&&typeof result.key==='string'&&!!result.key.trim()};
 }catch{config=null;}
 finally{configLoading=false;updateForm();}
}
async function sendEnquiry(event){
 event.preventDefault();const form=event.currentTarget;
 if(busy||config?.available!==true)return;
 for(const [name,min,message] of [['name',1,'Please enter your name.'],['message',10,'Please add a little more detail (at least 10 characters).']]){const input=form.elements.namedItem(name);input.setCustomValidity(input.value.trim().length<min?message:'');}
 if(!form.reportValidity())return;
 captureDraft(form);busy=true;feedback={kind:'',text:''};updateForm();
 const submitted={...draft};
 try{
  const response=await fetch('https://api.web3forms.com/submit',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(contactPayload(submitted,config.key)),signal:AbortSignal.timeout(20000)});
  let result;try{result=await response.json()}catch{throw Error('We couldn’t confirm your enquiry was sent. Your details are still here; please try again or email us.');}
  if(!response.ok||result.success!==true)throw Error(response.status===429?'There have been too many attempts. Please wait a little before trying again, or email us.':'Your enquiry could not be sent. Your details are still here. Please try again or email us.');
  feedback={kind:'success',text:`Thank you, ${submitted.name.trim()}. Your enquiry has been submitted. Our team will reply to ${submitted.email.trim()}.`};
  draft=blank();const visibleForm=currentForm();if(visibleForm)for(const name of fields)visibleForm.elements.namedItem(name).value='';
 }catch(error){
  feedback={kind:'error',text:error.name==='TimeoutError'||error.name==='AbortError'?'We couldn’t confirm delivery in time. Your details are still here. Please check your connection and try again, or email us.':error.name==='TypeError'?'We couldn’t reach the delivery service. Your details are still here. Check your connection and try again, or send your enquiry by email.':error.message||'Your enquiry could not be sent. Please try again or email us.'};
 }finally{busy=false;updateForm();currentForm()?.querySelector('#contact-status').focus({preventScroll:true});}
}
export function refreshContact(){
 const form=currentForm();if(!form)return;
 form.addEventListener('input',event=>{event.target.setCustomValidity?.('');captureDraft(form);if(feedback.kind==='success')feedback={kind:'',text:''};updateForm();});
 form.addEventListener('change',()=>{captureDraft(form);updateForm();});
 form.addEventListener('submit',sendEnquiry);
 form.querySelector('[data-contact-retry]').addEventListener('click',checkAvailability);
 updateForm();if(!config&&!configLoading)checkAvailability();
}

export function contactPayload(values,key){
 const labels={buy:'Buying a car',sell:'Selling a car',source:'Sourcing a specific car',general:'General enquiry'};
 return {access_key:key,subject:`ENTITY-1 — ${labels[values.intent]||'General enquiry'}`,from_name:'ENTITY-1 Enquiries',name:values.name.trim(),email:values.email.trim(),replyto:values.email.trim(),'Phone number':values.phone.trim()||'Not provided',Country:values.country.trim()||'Not provided','Enquiry type':labels[values.intent]||'General enquiry','Car of interest':values.vehicle.trim()||'Not specified',message:values.message.trim(),botcheck:Boolean(values.website)};
}
