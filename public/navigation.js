const menu=document.querySelector('#navigation');
const toggle=document.querySelector('#menu-toggle');
const compact=matchMedia('(max-width: 900px)');

export function closeNavigation(returnFocus=false){
  menu.classList.remove('open');
  menu.inert=compact.matches;
  menu.setAttribute('aria-hidden',String(compact.matches));
  toggle.setAttribute('aria-expanded','false');
  toggle.setAttribute('aria-label','Open navigation');
  document.body.classList.remove('navigation-open');
  document.querySelector('#main').inert=false;
  document.querySelector('.site-footer').inert=false;
  if(returnFocus)toggle.focus();
}

export function bindNavigation(){
  compact.addEventListener('change',()=>closeNavigation());
  toggle.addEventListener('click',()=>{
    if(menu.classList.contains('open'))return closeNavigation(true);
    menu.inert=false;
    menu.setAttribute('aria-hidden','false');
    menu.classList.add('open');
    toggle.setAttribute('aria-expanded','true');
    toggle.setAttribute('aria-label','Close navigation');
    document.body.classList.add('navigation-open');
    document.querySelector('#main').inert=true;
    document.querySelector('.site-footer').inert=true;
    requestAnimationFrame(()=>{if(menu.classList.contains('open'))menu.querySelector('a').focus({preventScroll:true});});
  });
  document.addEventListener('keydown',event=>{
    if(!menu.classList.contains('open'))return;
    if(event.key==='Escape'){event.preventDefault();closeNavigation(true);}
    if(event.key==='Tab'){
      const focusable=[document.querySelector('.site-header .wordmark'),...menu.querySelectorAll('a:not([hidden])'),toggle];
      const first=focusable[0],last=focusable.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
  });
}
