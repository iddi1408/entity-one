import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual access UI with synthetic accounts and an in-memory API.
// No production credentials, account mutations or network calls are used.
const source=(await readFile(new URL('../public/access.js',import.meta.url),'utf8'))
  .replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')
  +'\nglobalThis.ui={bindAccess,ensureAccessData,accessPanel,logsPanel,can,isOwner};';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let checks=0;
const ok=(value,message)=>{assert.ok(value,message);checks++;};
const equal=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
const contains=(text,part)=>ok(text.includes(part),`Expected ${part}`);
const omits=(text,part)=>ok(!text.includes(part),`Unexpected ${part}`);
const permissionIds=['inventory.read','inventory.write','content.read','content.write','logs.read','access.manage'];
const account=(id,role,permissions=[])=>({id,username:id,role,permissions,createdAt:1700000000,disabled:false,mustChangePassword:false});
const roles=[
  {id:'owner',label:'Owner',permissions:permissionIds},
  {id:'admin',label:'Administrator',permissions:permissionIds},
  {id:'editor',label:'Editor',permissions:['inventory.read','inventory.write']},
  {id:'viewer',label:'Viewer',permissions:['inventory.read']}
];
function harness(actor=account('owner','owner')){
  const state={adminTab:'access',session:{authenticated:true,user:actor}};
  const listeners=new Map(),nodes=new Map(),requests=[],notices=[],dirty=[];
  let modalHtml='',closed=0,deleteFailure=false;
  const server={roles,permissions:permissionIds.map(id=>({id,label:id})),users:[
    account('owner','owner'),account('staff-owner','owner'),account('other-owner','owner'),
    account('admin','admin',permissionIds),account('editor','editor',['inventory.read','inventory.write']),
    account('viewer','viewer',['inventory.read'])
  ]};
  const add=(name,listener)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(listener);};
  function node(attrs={}){
    const children=new Map();
    return {hidden:false,disabled:false,value:'',innerHTML:'',textContent:'',dataset:{},...attrs,
      addEventListener(){},closest(){return null;},matches(){return false;},
      hasAttribute(name){return Object.hasOwn(attrs,name);},
      querySelector(selector){if(!children.has(selector))children.set(selector,node());return children.get(selector);},
      querySelectorAll(){return [];},replaceChildren(){},reset(){this.resetCalled=true;}
    };
  }
  for(const id of ['dialog','dialog-content','confirm-staff-action'])nodes.set('#'+id,node());
  class TestFormData{
    constructor(form){this.values=form.values||{};}
    get(name){return this.values[name]??null;}
    getAll(name){const value=this.values[name];return Array.isArray(value)?value:value==null?[]:[value];}
  }
  const context=vm.createContext({
    state,h:escape,document:{addEventListener:add,querySelector:selector=>nodes.get(selector)||null},
    location:{pathname:'/admin'},render(){},navigate(){},clearAdminData(){},async loadContent(){},
    notify:message=>notices.push(message),markAdminDirty:value=>dirty.push(value),mayDiscard:()=>true,
    modal(html){modalHtml=html;nodes.set('#confirm-staff-action',node());nodes.set('#dialog-content',node());},
    closeModal(){closed++;nodes.delete('#staff-form');},
    async api(url,options={}){
      requests.push({url,...options});
      if(url==='/users'&&!options.method)return structuredClone(server);
      if(url.startsWith('/logs?'))return {events:[{action:'account.deleted',at:1700000000,actor:{username:'owner',role:'owner'},detail:{username:'former-staff'}}],actors:[],delivery:{configured:false},nextCursor:null};
      if(url.startsWith('/users/')&&options.method==='DELETE'){
        if(deleteFailure)throw Error('Synthetic deletion failure');
        const id=decodeURIComponent(url.slice('/users/'.length));server.users=server.users.filter(user=>user.id!==id);return {deleted:true,id};
      }
      if(url==='/users'&&options.method==='POST'){
        const body=JSON.parse(options.body),user=account('created-user',body.role,body.permissions);user.username=body.username;server.users.push(user);return {user,temporaryPassword:'Synthetic-Temporary-Password-Only!'};
      }
      if(url.startsWith('/users/')&&options.method==='PUT'){
        const id=decodeURIComponent(url.slice('/users/'.length)),body=JSON.parse(options.body),user=server.users.find(user=>user.id===id);Object.assign(user,body);return {user};
      }
      throw Error('Unexpected synthetic API call: '+url);
    },
    FormData:TestFormData,URLSearchParams,Date,console,navigator:{clipboard:{async writeText(){}}}
  });
  vm.runInContext(source,context,{filename:'public/access.js'});context.ui.bindAccess();
  const dispatch=async(name,event)=>{for(const listener of listeners.get(name)||[])await listener(event);};
  function button(attrs){
    const item=node(attrs);item.dataset=Object.fromEntries(Object.entries(attrs).filter(([name])=>name.startsWith('data-')).map(([name,value])=>[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),value]));
    item.closest=selector=>selector==='button'?item:null;return item;
  }
  function form(values={}){
    const item=node({id:'staff-form',values,dataset:{id:''}}),inputs=permissionIds.map(value=>node({value,checked:false})),submit=node();
    const query=item.querySelector.bind(item);
    item.querySelectorAll=selector=>selector==='[name=permissions]'?inputs:selector==='[type=submit]'?[submit]:[];
    item.querySelector=selector=>query(selector);
    nodes.set('#staff-form',item);return {element:item,inputs,submit};
  }
  return {...context.ui,state,server,requests,notices,nodes,node,dirty,form,
    get modalHtml(){return modalHtml;},get closed(){return closed;},
    failDeletion(value=true){deleteFailure=value;},
    async load(){await context.ui.ensureAccessData(true);},
    async click(attrs){await dispatch('click',{target:button(attrs)});},
    async chooseRole(form,value){await dispatch('change',{target:{value,form:form.element,matches:selector=>selector==='#staff-form [name=role]'}});},
    async submit(form){await dispatch('submit',{target:form.element,preventDefault(){}});},
    async confirm(){const target=nodes.get('#confirm-staff-action');await target.onclick?.({target});}
  };
}
const mutations=h=>h.requests.filter(request=>['POST','PUT','DELETE'].includes(request.method));

// Owner authority follows the role, while authentication and mandatory password
// changes still gate all permissions. Lower roles never receive Owner controls.
{
  const h=harness(account('staff-owner','owner'));equal(h.isOwner(),true);equal(h.can('content.write'),true);
  h.state.session.authenticated=false;equal(h.can('content.write'),false);h.state.session.authenticated=true;
  h.state.session.mustChangePassword=true;equal(h.can('content.write'),false);h.state.session.mustChangePassword=false;
  await h.load();contains(h.accessPanel(),'Owner · Full access');
  await h.click({'data-add-staff':''});contains(h.modalHtml,'value="owner"');contains(h.modalHtml,'value="admin"');contains(h.modalHtml,'id="staff-owner-help" hidden');
}
{
  const h=harness(account('admin','admin',permissionIds));await h.load();equal(h.isOwner(),false);
  await h.click({'data-add-staff':''});omits(h.modalHtml,'value="owner"');omits(h.modalHtml,'value="admin"');contains(h.modalHtml,'value="editor"');
  const html=h.accessPanel();omits(html,'data-delete-staff=');omits(html,'data-edit-staff="staff-owner"');omits(html,'data-reset-staff="staff-owner"');omits(html,'data-toggle-staff="staff-owner"');
  await h.click({'data-delete-staff':'viewer'});equal(mutations(h).length,0);omits(h.modalHtml,'Permanently delete');
}
{
  const h=harness(account('viewer','viewer',['inventory.read']));await h.load();equal(h.requests.length,0);
  omits(h.accessPanel(),'data-add-staff');await h.click({'data-delete-staff':'editor'});equal(mutations(h).length,0);
}

// Changing to Owner replaces granular permission editing with full-access
// guidance. Switching back restores the selected ordinary role's preset.
{
  const h=harness();await h.load();await h.click({'data-edit-staff':'other-owner'});
  contains(h.modalHtml,'value="owner" selected');contains(h.modalHtml,'class="adm-permission-grid" hidden disabled');contains(h.modalHtml,'including granting Owner access and deleting staff');
  const form=h.form();await h.chooseRole(form,'owner');
  equal(form.element.querySelector('#staff-owner-help').hidden,false);equal(form.element.querySelector('#staff-permission-help').hidden,true);
  equal(form.element.querySelector('.adm-permission-grid').hidden,true);equal(form.element.querySelector('.adm-permission-grid').disabled,true);
  ok(form.inputs.every(input=>input.checked),'Every permission is represented by the Owner role');
  await h.chooseRole(form,'editor');equal(form.element.querySelector('#staff-owner-help').hidden,true);
  equal(form.element.querySelector('.adm-permission-grid').hidden,false);equal(form.element.querySelector('.adm-permission-grid').disabled,false);
  equal(form.inputs.filter(input=>input.checked).map(input=>input.value),['inventory.read','inventory.write']);
}

// Submit through the real delegated handler: Owner gets every permission even
// though its hidden fieldset is absent from browser FormData. Ordinary roles
// retain chosen custom permissions, and a forged Owner selection is rejected.
{
  const h=harness(account('staff-owner','owner'));await h.load();
  const form=h.form({username:'new-owner',role:'owner',permissions:[]});await h.submit(form);
  const request=mutations(h)[0];equal(request.method,'POST');equal(request.url,'/users');
  const payload=JSON.parse(request.body);equal(payload.role,'owner');equal(payload.username,'new-owner');equal(payload.permissions,permissionIds);
  contains(h.modalHtml,'SHOWN ONCE');contains(h.modalHtml,'new-owner');equal(form.submit.disabled,false);
}
{
  const h=harness();await h.load();const form=h.form({role:'owner',permissions:['inventory.read']});form.element.dataset.id='editor';await h.submit(form);
  const request=mutations(h)[0];equal(request.method,'PUT');equal(request.url,'/users/editor');equal(JSON.parse(request.body).permissions,permissionIds);
  equal(h.closed,1);contains(h.notices.join(' '),'Staff access saved.');
}
{
  const h=harness();await h.load();const form=h.form({role:'editor',permissions:['inventory.read']});form.element.dataset.id='other-owner';await h.submit(form);
  const payload=JSON.parse(mutations(h)[0].body);equal(payload.role,'editor');equal(payload.permissions,['inventory.read'],'Demotion preserves the selected custom permissions');
}
{
  const h=harness(account('admin','admin',permissionIds));await h.load();const form=h.form({username:'forged-owner',role:'owner',permissions:permissionIds});await h.submit(form);
  equal(mutations(h).length,0);contains(form.element.querySelector('.form-error').textContent,'cannot assign this role');equal(form.submit.disabled,false);
}

// Deletion is owner-only, explicitly confirmed, and unavailable for either the
// current account or the protected primary owner. Merely opening it never writes.
{
  const h=harness(account('staff-owner','owner'));await h.load();const html=h.accessPanel();
  contains(html,'data-delete-staff="viewer"');contains(html,'data-delete-staff="other-owner"');
  omits(html,'data-delete-staff="staff-owner"');omits(html,'data-delete-staff="owner"');
  omits(html,'data-edit-staff="staff-owner"');omits(html,'data-edit-staff="owner"');
  await h.click({'data-delete-staff':'staff-owner'});await h.click({'data-delete-staff':'owner'});await h.click({'data-delete-staff':'missing'});equal(mutations(h).length,0);equal(h.modalHtml,'');
  await h.click({'data-delete-staff':'other-owner'});equal(mutations(h).length,0);contains(h.modalHtml,'Delete other-owner?');contains(h.modalHtml,'other-owner (Owner)');contains(h.modalHtml,'end all their sessions');contains(h.modalHtml,'Past activity logs remain');contains(h.modalHtml,'This cannot be undone');contains(h.modalHtml,'class="adm-danger" id="confirm-staff-action">Delete account');
  await h.confirm();equal(mutations(h).length,1);const request=mutations(h)[0];equal(request.method,'DELETE');equal(request.url,'/users/other-owner');equal(request.body,'{}');
  equal(h.closed,1);contains(h.notices.join(' '),'sessions ended');omits(h.accessPanel(),'data-delete-staff="other-owner"');
}
{
  const h=harness();await h.load();h.failDeletion();await h.click({'data-delete-staff':'viewer'});await h.confirm();
  equal(h.closed,0);contains(h.nodes.get('#dialog-content').querySelector('.form-error').textContent,'Synthetic deletion failure');
  equal(h.nodes.get('#confirm-staff-action').disabled,false,'A failed request lets the user retry');contains(h.accessPanel(),'data-delete-staff="viewer"');
}
{
  const h=harness();await h.load();h.state.adminTab='activity';await h.load();contains(h.logsPanel(),'Deleted a staff account');
}

console.log(`PASS: ${checks} access UI checks covering actual Owner controls, full-permission submission, role boundaries, protected accounts and confirmed staff deletion.`);
