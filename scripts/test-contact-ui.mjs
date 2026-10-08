import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise submission boundaries with a fake provider. No email is sent.
const names=['name','email','phone','country','intent','vehicle','message','website'];
const valid={name:'Jane Smith',email:'jane@example.test',phone:'+44 7700 900000',country:'United Kingdom',intent:'buy',vehicle:'2024 Porsche 911 GT3 RS',message:'I would like more information about this car.',website:''};
const input=value=>({value,disabled:false,hidden:false,dataset:{},textContent:'',setCustomValidity(message){this.validationMessage=message},focus(){this.focused=true}});
const fields=Object.fromEntries(names.map(name=>[name,input('')]));
const button=input('');button.querySelector=()=>button.label;button.label=input('');
const status=input(''),count=input(''),fieldset=input(''),paragraph=input(''),retry=input(''),email=input('');
const note=input('');note.querySelector=selector=>({'p':paragraph,'[data-contact-retry]':retry,'[data-contact-email]':email}[selector]);
const form={dataset:{replyEmail:'sales@entity-1.com'},elements:{namedItem:name=>fields[name]},setAttribute(){},reportValidity:()=>!names.some(name=>fields[name].validationMessage),querySelector:selector=>({'fieldset':fieldset,'.contact-submit':button,'[data-contact-count]':count,'[data-contact-delivery]':note,'#contact-status':status}[selector])};
let fetchImpl,requests=[];
const context={console,AbortSignal,URLSearchParams,location:{search:''},document:{querySelector:()=>form},h:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),fetch:async (...args)=>{requests.push(args);return fetchImpl(...args)}};
vm.createContext(context);
const source=(await readFile(new URL('../public/contact.js',import.meta.url),'utf8')).replace(/^import .*?;\r?\n/gm,'').replace(/^export /gm,'');
vm.runInContext(source+`\nglobalThis.contact={contactForm,contactPayload,checkAvailability,sendEnquiry,emailUrl,seed(values,available=true){draft={...values};busy=false;config={available,key:available?'public-form-id':''};feedback={kind:'',text:''}},inspect(){return {draft,busy,config,feedback}}}`,context);
const contact=context.contact,event={preventDefault(){},currentTarget:form};
const response=(data,status=200)=>({ok:status<400,status,json:async()=>data});
const seed=(available=true)=>{contact.seed(valid,available);for(const name of names){fields[name].value=valid[name];fields[name].validationMessage=''}requests=[]};

seed(false);await contact.sendEnquiry(event);assert.equal(requests.length,0,'No request is attempted before delivery is configured');
assert.equal(contact.inspect().draft.name,'Jane Smith');

seed();fields.name.value='   ';await contact.sendEnquiry(event);assert.equal(requests.length,0,'Whitespace-only names do not submit');
assert.equal(fields.name.validationMessage,'Please enter your name.');

seed();let resolve;fetchImpl=()=>new Promise(done=>{resolve=done});
const pending=contact.sendEnquiry(event);assert.equal(requests.length,1);assert.equal(fieldset.disabled,true);
await contact.sendEnquiry(event);assert.equal(requests.length,1,'Concurrent submits cannot duplicate the request');
const [url,options]=requests[0],payload=JSON.parse(options.body);
assert.equal(url,'https://api.web3forms.com/submit');assert.equal(options.credentials,'omit');assert.equal(payload.email,valid.email);assert.equal(payload.replyto,valid.email);assert.equal(payload.botcheck,false);assert.equal(payload['Car of interest'],valid.vehicle);assert.equal(payload.access_key,'public-form-id');assert.ok(!('submissionId' in payload));
resolve(response({success:false,message:'Provider refused'},200));await pending;
assert.equal(contact.inspect().feedback.kind,'error','HTTP 200 alone is not treated as success');
assert.deepEqual(JSON.parse(JSON.stringify(contact.inspect().draft)),valid,'Failed sends preserve the complete draft');
assert.equal(fields.message.value,valid.message);assert.equal(fieldset.disabled,false);

seed();fetchImpl=async()=>response({success:false},429);await contact.sendEnquiry(event);
assert.match(contact.inspect().feedback.text,/too many attempts/);assert.equal(contact.inspect().draft.email,valid.email);
await Promise.resolve();assert.equal(requests.length,1,'Provider failures are never retried automatically');

seed();fetchImpl=async()=>{throw new TypeError('Failed to fetch')};await contact.sendEnquiry(event);
assert.equal(contact.inspect().feedback.kind,'error');assert.equal(contact.inspect().draft.message,valid.message);

seed();fetchImpl=async()=>response({success:true});await contact.sendEnquiry(event);
assert.equal(contact.inspect().feedback.kind,'success');assert.match(contact.inspect().feedback.text,/jane@example.test/);
assert.ok(names.every(name=>fields[name].value===''),'Only confirmed success clears displayed fields');
assert.ok(Object.values(contact.inspect().draft).every(value=>value===''),'Only confirmed success clears the in-memory draft');

fetchImpl=async()=>response({available:false,key:''});await contact.checkAvailability();assert.equal(button.disabled,true);assert.equal(note.hidden,false);assert.match(paragraph.textContent,/not available yet/);
fetchImpl=async()=>response({available:true,key:''});await contact.checkAvailability();assert.equal(button.disabled,true,'Malformed available configuration cannot enable sending');
fetchImpl=async()=>response({available:true,key:'public-form-id'});await contact.checkAvailability();assert.equal(button.disabled,false);assert.equal(note.hidden,true);

seed();const fallback=new URL(contact.emailUrl('sales@entity-1.com'));assert.equal(fallback.protocol,'mailto:');assert.match(fallback.searchParams.get('body'),/Jane Smith/);assert.match(fallback.searchParams.get('body'),/Car of interest: 2024 Porsche/);
context.location.search='?car=wanted-1';const html=contact.contactForm({email:'sales@entity-1.com'},[{id:'wanted-1',type:'wanted',brand:'Ferrari',model:'F40',internalNotes:'NEVER PUBLIC'},{id:'hidden',type:'inventory',status:'draft',brand:'SECRET',model:'PRIVATE'}],true);
assert.match(html,/Ferrari F40/);assert.match(html,/value="sell" selected/);assert.ok(!html.includes('NEVER PUBLIC'));assert.ok(!html.includes('SECRET'));
assert.match(html,/autocomplete="email"/);assert.match(html,/type="tel"/);assert.match(html,/analytics-notice.html#contact-enquiries/);
context.location.search='?intent=source';
assert.match(contact.contactForm({email:'sales@entity-1.com'},[],true),/value="source" selected/,'Concierge handoff preselects sourcing');
context.location.search='?intent=untrusted';
assert.equal(contact.inspect().draft.intent,'source','Unknown handoff intents do not change the draft');
contact.contactForm({email:'sales@entity-1.com'},[],true);
assert.equal(contact.inspect().draft.intent,'source');
context.location.search='?car=inventory-1';
contact.contactForm({email:'sales@entity-1.com'},[{id:'inventory-1',type:'inventory',brand:'Porsche',model:'911'}],true);
assert.equal(contact.inspect().draft.intent,'buy');
context.location.search='?intent=source';
contact.contactForm({email:'sales@entity-1.com'},[],true);
assert.equal(contact.inspect().draft.intent,'source','Repeated sourcing handoff replaces the intervening car intent');
assert.equal(contact.inspect().draft.vehicle,'','Generic handoff removes only the previous automatically selected vehicle');
console.log('PASS: contact form configuration, validation, provider failures, duplicate prevention, draft retention, success-only reset, email fallback and public car prefilling. No external requests.');
