const icon = paths => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const chatIcon = icon('<path d="M20 11.5a8 8 0 0 1-8 8 9 9 0 0 1-3.5-.7L4 20l1.2-4.5a8 8 0 1 1 14.8-4Z"/><path d="M8 10h8M8 14h5"/>');
const closeIcon = icon('<path d="m6 6 12 12M6 18 18 6"/>');
const sendIcon = icon('<path d="M12 19V5m-6 6 6-6 6 6"/>');
const resetIcon = icon('<path d="M4 10a8 8 0 1 1 2 8M4 4v6h6"/>');
const arrowIcon = icon('<path d="M5 12h14m-5-5 5 5-5 5"/>');
const carIcon = icon('<path d="m5 10 2-5h10l2 5M4 10h16v8H4zM7 18v2m10-2v2M7 13h2m6 0h2"/>');
const searchIcon = icon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>');
const keyIcon = icon('<circle cx="8" cy="9" r="4"/><path d="m11 12 8 8m-3-3 3-3m-6 0 3-3"/>');
let root, launcher, panel, form, input, feed, status, error, intro, prompts, count, submit, retry;
let stop, messageRetry, jump, announcer;
let available = null, checking = false, opened = false, busy = false, messages = [], controller, generation = 0;
let pendingDraft = '', lastFailedDraft = '', unread = false;
const TEXT_LIMIT = 2000;

function restricted() {
  return /^\/(admin|exclusive)(?:\/|$)/.test(location.pathname) || document.body.classList.contains('navigation-open') || !!document.querySelector('dialog[open]');
}

function updateControls() {
  input.disabled = available !== true || busy;
  submit.disabled = input.disabled || !input.value.trim();
  submit.hidden = busy;
  if (stop) stop.hidden = !busy;
  prompts.hidden = messages.length > 0 || available !== true || busy;
  intro.hidden = messages.length > 0 || busy;
  retry.hidden = checking || available === true;
  if (messageRetry) messageRetry.hidden = busy || !lastFailedDraft;
  count.textContent = input.value.length ? `${input.value.length} / 600` : '';
  form.setAttribute('aria-busy', String(busy));
}

function closeChat(restoreFocus = true) {
  opened = false;
  panel.hidden = true;
  launcher.hidden = false;
  launcher.setAttribute('aria-expanded', 'false');
  if (restoreFocus && !root.hidden) launcher.focus({preventScroll: true});
}

function safeChatHref(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 600 || /[\\\u0000-\u0020]/.test(value)) return '';
  try {
    const origin = location.origin || 'https://entity-one.invalid';
    const url = new URL(value, origin);
    const keys = {'/inventory': ['car', 'view', 'region', 'brand'], '/wanted': ['car', 'view', 'region', 'brand'], '/contact': ['car', 'intent'], '/about': []};
    if (url.origin !== origin || !keys[url.pathname] || url.pathname !== value.split('?')[0] || url.hash || url.username || url.password || [...url.searchParams].some(([key, text]) => !keys[url.pathname].includes(key) || text.length > 200 || /[\u0000-\u001f]/.test(text))) return '';
    if (url.searchParams.has('intent') && !['buy', 'sell', 'source', 'general'].includes(url.searchParams.get('intent'))) return '';
    return url.pathname + url.search;
  } catch { return ''; }
}

function safeChatImage(value) {
  if (typeof value !== 'string' || !value || value.length > 2000 || /[\\\u0000-\u0020]/.test(value) || value.startsWith('//')) return '';
  try {
    const origin = location.origin || 'https://entity-one.invalid';
    const url = new URL(value, origin);
    if (url.username || url.password) return '';
    if (url.origin === origin) return url.pathname.startsWith('/assets/') ? url.href : '';
    return url.protocol === 'https:' && !value.startsWith('/') ? url.href : '';
  } catch { return ''; }
}

const shortText = (value, length = 100) => typeof value === 'string' ? value.slice(0, length) : '';
function safeCards(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap(car => {
    if (!car || typeof car.id !== 'string' || !car.id || car.id.length > 200 || seen.has(car.id) || !['available', 'reserved'].includes(car.status) || !shortText(car.brand) || !shortText(car.model)) return [];
    const href = safeChatHref(car.href);
    if (!href || !href.startsWith('/inventory?')) return [];
    const url = new URL(href, location.origin || 'https://entity-one.invalid');
    if (url.searchParams.get('car') !== car.id) return [];
    seen.add(car.id);
    return [{id: car.id, href, brand: shortText(car.brand), model: shortText(car.model), year: shortText(car.year, 40), region: shortText(car.region, 60), price: shortText(car.price), status: car.status, image: safeChatImage(car.image)}];
  }).slice(0, 3);
}

function safeActions(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap(action => {
    const href = safeChatHref(action?.href), label = shortText(action?.label, 60);
    if (!href || !label || seen.has(href)) return [];
    seen.add(href);
    return [{href, label}];
  }).slice(0, 2);
}

// Model text is never HTML. Only simple emphasis and bullet lists are rendered;
// all links and listing cards originate in validated server fields.
function appendInline(element, value) {
  const pattern = /\*\*([^*\n]{1,240})\*\*/g;
  let start = 0, match;
  while ((match = pattern.exec(value))) {
    if (match.index > start) element.append(document.createTextNode(value.slice(start, match.index)));
    const strong = document.createElement('strong');
    strong.textContent = match[1];
    element.append(strong);
    start = pattern.lastIndex;
  }
  if (start < value.length) element.append(document.createTextNode(value.slice(start)));
}

function replyText(value) {
  const content = document.createElement('div');
  content.className = 'e1-chat-copy';
  let list;
  for (const line of value.slice(0, TEXT_LIMIT).replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) { list = null; continue; }
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    const part = document.createElement(bullet ? 'li' : 'p');
    appendInline(part, bullet ? bullet[1] : line);
    if (bullet) {
      if (!list) { list = document.createElement('ul'); content.append(list); }
      list.append(part);
    } else { list = null; content.append(part); }
  }
  return content;
}

function carCard(car) {
  const link = document.createElement('a');
  link.className = 'e1-chat-car';
  link.href = car.href;
  const media = document.createElement('div');
  media.className = 'e1-chat-car-media';
  if (car.image) {
    const image = document.createElement('img');
    image.src = car.image;
    image.alt = `${car.brand} ${car.model}`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => { image.hidden = true; }, {once: true});
    media.append(image);
  }
  const details = document.createElement('div');
  details.className = 'e1-chat-car-details';
  const meta = document.createElement('span');
  meta.textContent = [car.year, car.region].filter(Boolean).join(' · ');
  const name = document.createElement('strong');
  name.textContent = `${car.brand} ${car.model}`;
  const price = document.createElement('small');
  price.textContent = car.status === 'reserved' ? 'Reserved · view details' : car.price || 'Enquire for details';
  const arrow = document.createElement('span');
  arrow.className = 'e1-chat-card-arrow';
  arrow.textContent = '↗';
  arrow.setAttribute('aria-hidden', 'true');
  details.append(meta, name, price);
  link.append(media, details, arrow);
  return link;
}

function addMessage(message) {
  const bubble = document.createElement('div');
  bubble.className = `e1-chat-message e1-chat-${message.role}`;
  const label = document.createElement('span');
  label.className = 'e1-chat-speaker';
  label.textContent = message.role === 'user' ? 'YOU' : 'ENTITY-1 CONCIERGE';
  bubble.append(label);
  if (message.role === 'assistant') {
    bubble.append(replyText(message.content));
    const cars = safeCards(message.cars);
    if (cars.length) {
      const collection = document.createElement('div');
      collection.className = 'e1-chat-cars';
      const caption = document.createElement('span');
      caption.className = 'e1-chat-collection-label';
      caption.textContent = 'From the public collection';
      collection.append(caption);
      for (const car of cars) collection.append(carCard(car));
      bubble.append(collection);
    }
    const actions = safeActions(message.actions);
    if (actions.length) {
      const links = document.createElement('div');
      links.className = 'e1-chat-links';
      for (const action of actions) {
        const link = document.createElement('a');
        link.href = action.href;
        link.textContent = action.label + ' ↗';
        links.append(link);
      }
      bubble.append(links);
    }
  } else {
    const content = document.createElement('p');
    content.textContent = message.content;
    bubble.append(content);
  }
  feed.append(bubble);
}

function scrollToLatest(startOfReply = false) {
  const scroll = root.querySelector('.e1-chat-scroll');
  const latest = feed.lastElementChild;
  scroll.scrollTop = startOfReply && latest && Number.isFinite(latest.offsetTop) ? Math.max(0, latest.offsetTop - 14) : scroll.scrollHeight;
  unread = false;
  if (jump) jump.hidden = true;
}

function drawConversation(pending, forceScroll = false, newReply = false) {
  const scroll = root.querySelector('.e1-chat-scroll');
  const previousTop = scroll.scrollTop, nearEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  feed.replaceChildren();
  for (const message of pending ? messages.slice(-9) : messages) addMessage(message);
  if (pending) {
    addMessage({role: 'user', content: pending});
    const thinking = document.createElement('div');
    thinking.className = 'e1-chat-thinking';
    thinking.setAttribute('aria-hidden', 'true');
    const dots = document.createElement('span');
    dots.className = 'e1-chat-dots';
    for (let index = 0; index < 3; index++) dots.append(document.createElement('i'));
    const label = document.createElement('span');
    label.textContent = 'Preparing your reply';
    thinking.append(dots, label);
    feed.append(thinking);
  }
  updateControls();
  if (forceScroll || nearEnd) scrollToLatest(newReply);
  else {
    scroll.scrollTop = previousTop;
    if (!busy) unread = true;
    if (jump) jump.hidden = !unread;
  }
}

async function checkAvailability() {
  if (checking) return;
  checking = true;
  status.textContent = 'Connecting to your concierge…';
  error.textContent = '';
  updateControls();
  const checkController = new AbortController();
  const timeout = setTimeout(() => checkController.abort(), 10000);
  try {
    const response = await fetch('/api/chat/status', {credentials: 'same-origin', cache: 'no-store', signal: checkController.signal});
    const data = await response.json();
    available = response.ok && data.available === true;
    status.textContent = available ? '' : 'The AI concierge is unavailable. Our team is still here to help.';
  } catch {
    available = false;
    status.textContent = 'Unable to connect. Try again or speak with our team.';
  } finally {
    clearTimeout(timeout);
    checking = false;
    updateControls();
  }
}

function buildContext(history, draft) {
  const context = [...history, {role: 'user', content: draft}].slice(-5).map(message => ({role: message.role, content: message.content.slice(0, message.role === 'user' ? 600 : 1200)}));
  while (context.length > 1 && context.reduce((length, message) => length + message.content.length, 0) > 3000) context.splice(0, 2);
  return context;
}

async function sendMessage(event) {
  event?.preventDefault();
  if (busy || available !== true || restricted()) return;
  const draft = input.value.trim().slice(0, 600);
  if (!draft) return;
  const hadInputFocus = document.activeElement === input;
  busy = true;
  pendingDraft = draft;
  lastFailedDraft = '';
  error.textContent = '';
  input.value = '';
  if (input.style) input.style.height = '';
  status.textContent = '';
  if (announcer) announcer.textContent = 'Preparing your reply.';
  const requestGeneration = ++generation;
  let delivered = false;
  const requestController = new AbortController();
  controller = requestController;
  const timeout = setTimeout(() => requestController.abort(), 35000);
  drawConversation(draft, true);
  try {
    const response = await fetch('/api/chat', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({messages: buildContext(messages, draft)}), signal: requestController.signal});
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.reply !== 'string' || !data.reply.trim()) {
      throw Object.assign(new Error(response.status === 429 ? 'The concierge has reached its message limit. Please try later or speak with our team.' : response.status === 503 ? 'The concierge is temporarily unavailable. Please try again or speak with our team.' : 'We couldn’t complete your reply. Please try again.'), {safe: true});
    }
    if (requestGeneration !== generation) return;
    const assistant = {role: 'assistant', content: data.reply.slice(0, TEXT_LIMIT), cars: safeCards(data.cars), actions: safeActions(data.actions)};
    messages = [...messages, {role: 'user', content: draft}, assistant].slice(-10);
    delivered = true;
    if (announcer) announcer.textContent = 'Concierge replied. ' + assistant.content;
  } catch (failure) {
    if (requestGeneration !== generation) return;
    input.value = draft;
    lastFailedDraft = draft;
    error.textContent = failure.name === 'AbortError' ? 'Your reply took too long. Please try again.' : failure.safe ? failure.message : 'Unable to connect. Your question is ready to send again.';
  } finally {
    clearTimeout(timeout);
    if (requestGeneration === generation) {
      busy = false;
      pendingDraft = '';
      controller = null;
      drawConversation(undefined, false, delivered);
      if (hadInputFocus && opened && !restricted() && document.activeElement === document.body && !matchMedia('(pointer: coarse)').matches) input.focus({preventScroll: true});
    }
  }
}

function usePrompt(value) {
  if (busy || available !== true || restricted() || typeof value !== 'string') return;
  input.value = value.slice(0, 600);
  return sendMessage();
}

function stopReply() {
  if (!busy) return;
  generation++;
  controller?.abort();
  controller = null;
  busy = false;
  input.value = pendingDraft;
  pendingDraft = '';
  lastFailedDraft = '';
  error.textContent = '';
  status.textContent = 'Reply stopped. Your question is ready to edit or send again.';
  if (announcer) announcer.textContent = status.textContent;
  drawConversation();
  if (opened && !restricted()) input.focus({preventScroll: true});
}

function clearConversation() {
  generation++;
  controller?.abort();
  controller = null;
  busy = false;
  messages = [];
  pendingDraft = '';
  lastFailedDraft = '';
  input.value = '';
  if (input.style) input.style.height = '';
  error.textContent = '';
  status.textContent = available ? '' : 'Our team is available through the contact page.';
  if (announcer) announcer.textContent = 'New conversation started.';
  drawConversation(undefined, true);
  root.querySelector('.e1-chat-scroll').scrollTop = 0;
  if (opened && available && !restricted()) input.focus({preventScroll: true});
}

export function refreshChat() {
  if (!root) return;
  const hidden = restricted();
  root.hidden = hidden;
  if (hidden && opened) closeChat(false);
  if (/^\/(admin|exclusive)(?:\/|$)/.test(location.pathname) && (messages.length || busy || input.value)) clearConversation();
}

export function initChat() {
  if (root) return;
  root = document.createElement('aside');
  root.id = 'e1-chat';
  root.setAttribute('aria-label', 'ENTITY-1 concierge');
  root.innerHTML = `<button type="button" class="e1-chat-launcher" aria-expanded="false" aria-controls="e1-chat-panel">${chatIcon}<span>Ask ENTITY-1</span><span class="e1-chat-launcher-arrow" aria-hidden="true">↗</span></button>
    <section id="e1-chat-panel" class="e1-chat-panel" role="dialog" aria-modal="false" aria-labelledby="e1-chat-title" hidden>
      <form class="e1-chat-form" autocomplete="off">
        <header class="e1-chat-heading"><div class="e1-chat-emblem"><img src="/assets/e1-logo.png" width="38" height="38" alt=""></div><div class="e1-chat-heading-copy"><span>YOUR PRIVATE CONCIERGE</span><h2 id="e1-chat-title">ENTITY-1 <small>AI</small></h2></div><button type="button" class="e1-chat-clear e1-chat-icon-button" aria-label="Start a new conversation" title="New conversation">${resetIcon}</button><button type="button" class="e1-chat-close e1-chat-icon-button" aria-label="Close concierge">${closeIcon}</button></header>
        <div class="e1-chat-scroll"><div class="e1-chat-intro"><span class="e1-chat-eyebrow">THE EXTRAORDINARY STARTS HERE</span><h3>What moves you?</h3><p>Discover the collection, find something exceptional, or begin your next chapter.</p></div><div class="e1-chat-prompts"><button type="button" data-prompt="Show me the cars currently listed in your inventory."><span class="e1-chat-prompt-icon">${carIcon}</span><span><strong>Explore the collection</strong><small>Discover our available automobiles</small></span>${arrowIcon}</button><button type="button" data-prompt="How can ENTITY-1 help me source a specific car?"><span class="e1-chat-prompt-icon">${searchIcon}</span><span><strong>Find a specific car</strong><small>Tell us what you’re looking for</small></span>${arrowIcon}</button><button type="button" data-prompt="I would like to sell my automobile. How do I get started?"><span class="e1-chat-prompt-icon">${keyIcon}</span><span><strong>Sell my automobile</strong><small>Start a conversation with our team</small></span>${arrowIcon}</button></div><div class="e1-chat-feed" role="log" aria-label="Conversation" aria-live="off"></div></div>
        <button type="button" class="e1-chat-jump" hidden>New reply <span aria-hidden="true">↓</span></button>
        <div class="e1-chat-status" role="status"></div><div class="e1-chat-error" role="alert"></div>
        <button class="e1-chat-retry" type="button" hidden>Reconnect</button><button class="e1-chat-message-retry" type="button" hidden>Try again ↗</button>
        <div class="e1-chat-composer"><div class="e1-chat-compose"><label for="e1-chat-input" class="e1-chat-sr">Your message</label><textarea id="e1-chat-input" name="message" maxlength="600" rows="1" placeholder="Ask about a car…" aria-describedby="e1-chat-privacy" disabled></textarea><button class="e1-chat-send" type="submit" aria-label="Send message" disabled>${sendIcon}</button><button class="e1-chat-stop" type="button" aria-label="Stop reply" title="Stop reply" hidden><span aria-hidden="true"></span></button></div><div class="e1-chat-compose-meta"><span>AI guidance. Our team confirms every detail.</span><span class="e1-chat-count" aria-hidden="true"></span></div></div>
        <a class="e1-chat-team" href="/contact"><span>Prefer a personal conversation?</span><strong>Speak to our team ${arrowIcon}</strong></a>
        <p id="e1-chat-privacy" class="e1-chat-privacy">Powered by Claude. Messages are sent to AI.<br>Keep personal and payment details out of chat.</p><div class="e1-chat-announcer e1-chat-sr" role="status" aria-live="polite" aria-atomic="true"></div>
      </form>
    </section>`;
  document.body.append(root);
  launcher = root.querySelector('.e1-chat-launcher'); panel = root.querySelector('.e1-chat-panel');
  form = root.querySelector('form'); input = root.querySelector('textarea'); feed = root.querySelector('.e1-chat-feed');
  status = root.querySelector('.e1-chat-status'); error = root.querySelector('.e1-chat-error');
  intro = root.querySelector('.e1-chat-intro'); prompts = root.querySelector('.e1-chat-prompts');
  count = root.querySelector('.e1-chat-count'); submit = root.querySelector('.e1-chat-send'); retry = root.querySelector('.e1-chat-retry');
  stop = root.querySelector('.e1-chat-stop'); messageRetry = root.querySelector('.e1-chat-message-retry');
  jump = root.querySelector('.e1-chat-jump'); announcer = root.querySelector('.e1-chat-announcer');
  launcher.addEventListener('click', () => {
    if (restricted()) return;
    opened = true; panel.hidden = false; launcher.hidden = true;
    launcher.setAttribute('aria-expanded', 'true');
    root.querySelector('.e1-chat-close').focus({preventScroll: true});
    if (available === null) void checkAvailability();
  });
  root.querySelector('.e1-chat-close').addEventListener('click', () => closeChat());
  root.querySelector('.e1-chat-clear').addEventListener('click', clearConversation);
  retry.addEventListener('click', checkAvailability);
  messageRetry.addEventListener('click', () => { if (lastFailedDraft) void usePrompt(input.value.trim() || lastFailedDraft); });
  stop.addEventListener('click', stopReply);
  jump.addEventListener('click', () => scrollToLatest(true));
  form.addEventListener('submit', sendMessage);
  form.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeChat(); }
    if (event.target === input && event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => {
    updateControls();
    input.style.height = 'auto';
    input.style.height = `${Math.min(88, input.scrollHeight)}px`;
  });
  prompts.addEventListener('click', event => {
    const button = event.target.closest('button[data-prompt]');
    if (button) void usePrompt(button.dataset.prompt);
  });
  form.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (link && safeChatHref(link.getAttribute('href'))) closeChat(false);
  });
  root.querySelector('.e1-chat-scroll').addEventListener('scroll', event => {
    const scroll = event.currentTarget;
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80) { unread = false; jump.hidden = true; }
  }, {passive: true});
  new MutationObserver(refreshChat).observe(document.body, {attributes: true, attributeFilter: ['class']});
  const dialog = document.querySelector('#dialog');
  if (dialog) new MutationObserver(refreshChat).observe(dialog, {attributes: true, attributeFilter: ['open']});
  window.addEventListener('popstate', refreshChat);
  const viewport = window.visualViewport;
  if (viewport) {
    const resize = () => {
      root.style.setProperty('--chat-height', `${Math.max(180, Math.floor(viewport.height - 24))}px`);
      root.style.setProperty('--chat-keyboard', `${Math.max(0, Math.floor(window.innerHeight - viewport.height - viewport.offsetTop))}px`);
      root.toggleAttribute('data-compact', viewport.height < 500);
    };
    viewport.addEventListener('resize', resize);
    viewport.addEventListener('scroll', resize);
    resize();
  }
  refreshChat();
}
