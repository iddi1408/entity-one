const chatIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8 9 9 0 0 1-3.5-.7L4 20l1.2-4.5a8 8 0 1 1 14.8-4Z"/><path d="M8 10h8M8 14h5"/></svg>';
const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
const sendIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>';
let root, launcher, panel, form, input, feed, status, error, intro, prompts, count, submit, retry;
let available = null, checking = false, opened = false, busy = false, messages = [], controller, generation = 0;

function restricted() {
  return /^\/(admin|exclusive)(?:\/|$)/.test(location.pathname) || document.body.classList.contains('navigation-open') || !!document.querySelector('dialog[open]');
}

function updateControls() {
  input.disabled = available !== true || busy;
  submit.disabled = input.disabled || !input.value.trim();
  prompts.hidden = messages.length > 0 || available !== true || busy;
  intro.hidden = messages.length > 0 || busy;
  retry.hidden = checking || available === true;
  count.textContent = `${input.value.length} / 600`;
  form.setAttribute('aria-busy', String(busy));
}

function closeChat(restoreFocus = true) {
  opened = false;
  panel.hidden = true;
  launcher.hidden = false;
  launcher.setAttribute('aria-expanded', 'false');
  if (restoreFocus && !root.hidden) launcher.focus({preventScroll: true});
}

function addMessage(message) {
  const bubble = document.createElement('div');
  bubble.className = `e1-chat-message e1-chat-${message.role}`;
  const label = document.createElement('span');
  label.className = 'e1-chat-speaker';
  label.textContent = message.role === 'user' ? 'YOU' : 'ENTITY-1 · AI';
  const content = document.createElement('p');
  content.textContent = message.content;
  bubble.append(label, content);
  feed.append(bubble);
}

function drawConversation(pending) {
  feed.replaceChildren();
  for (const message of pending ? messages.slice(-9) : messages) addMessage(message);
  if (pending) addMessage({role: 'user', content: pending});
  const scroll = root.querySelector('.e1-chat-scroll');
  scroll.scrollTop = scroll.scrollHeight;
  updateControls();
}

async function checkAvailability() {
  if (checking) return;
  checking = true;
  status.textContent = 'Connecting to the concierge…';
  error.textContent = '';
  updateControls();
  const checkController = new AbortController();
  const timeout = setTimeout(() => checkController.abort(), 10000);
  try {
    const response = await fetch('/api/chat/status', {credentials: 'same-origin', cache: 'no-store', signal: checkController.signal});
    const data = await response.json();
    available = response.ok && data.available === true;
    status.textContent = available ? 'Ask about our collection or private sourcing.' : 'Our AI concierge is currently unavailable. Our team can still help.';
  } catch {
    available = false;
    status.textContent = 'We couldn’t connect. Try again or contact our team.';
  } finally {
    clearTimeout(timeout);
    checking = false;
    updateControls();
  }
}

function buildContext(history, draft) {
  const context = [...history, {role: 'user', content: draft}].slice(-5).map(message => ({role: message.role, content: message.content.slice(0, message.role === 'user' ? 600 : 1200)}));
  // Keep complete conversation pairs within the server's total input budget.
  while (context.length > 1 && context.reduce((length, message) => length + message.content.length, 0) > 3000) context.splice(0, 2);
  return context;
}

async function sendMessage(event) {
  event.preventDefault();
  if (busy || available !== true || restricted()) return;
  const draft = input.value.trim().slice(0, 600);
  if (!draft) return;
  busy = true;
  error.textContent = '';
  input.value = '';
  status.textContent = 'The concierge is preparing a reply…';
  const requestGeneration = ++generation;
  const requestController = new AbortController();
  controller = requestController;
  const timeout = setTimeout(() => requestController.abort(), 35000);
  drawConversation(draft);
  const context = buildContext(messages, draft);
  try {
    const response = await fetch('/api/chat', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({messages: context}), signal: requestController.signal});
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.reply !== 'string' || !data.reply.trim()) {
      throw new Error(response.status === 429 ? 'The concierge is busy. Wait a moment, then send your message again.' : response.status === 503 ? 'The concierge is temporarily unavailable. Please contact our team or try again later.' : 'Your message couldn’t be answered. Please try again or contact our team.');
    }
    if (requestGeneration !== generation) return;
    messages = [...messages, {role: 'user', content: draft}, {role: 'assistant', content: data.reply.slice(0, 2000)}].slice(-10);
    status.textContent = 'AI answers are a guide. Our team confirms availability and details.';
  } catch (failure) {
    if (requestGeneration !== generation) return;
    input.value = draft;
    error.textContent = failure.name === 'AbortError' ? 'This reply took too long. Your message is ready to send again.' : failure.message || 'Unable to connect. Your message is ready to send again.';
    status.textContent = 'Your message has been kept below. Nothing is resent automatically.';
  } finally {
    clearTimeout(timeout);
    if (requestGeneration === generation) {
      busy = false;
      controller = null;
      drawConversation();
      if (opened && !restricted()) input.focus({preventScroll: true});
    }
  }
}

function clearConversation() {
  generation++;
  controller?.abort();
  controller = null;
  busy = false;
  messages = [];
  input.value = '';
  error.textContent = '';
  status.textContent = available ? 'New conversation. How can we help?' : 'Our team is available through the contact page.';
  drawConversation();
  if (opened && available) input.focus({preventScroll: true});
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
  root.innerHTML = `<button type="button" class="e1-chat-launcher" aria-expanded="false" aria-controls="e1-chat-panel">${chatIcon}<span>Ask ENTITY-1</span></button>
    <section id="e1-chat-panel" class="e1-chat-panel" role="dialog" aria-modal="false" aria-labelledby="e1-chat-title" hidden>
      <form class="e1-chat-form" autocomplete="off">
        <header class="e1-chat-heading"><div class="e1-chat-emblem" aria-hidden="true">E1</div><div><h2 id="e1-chat-title">ENTITY-1 Concierge</h2><span>AI ASSISTANT</span></div><button type="button" class="e1-chat-close" aria-label="Close concierge">${closeIcon}</button></header>
        <div class="e1-chat-scroll"><div class="e1-chat-intro"><span class="e1-chat-eyebrow">EXCEPTIONAL CARS. PERSONAL GUIDANCE.</span><h3>A little guidance.<br>A world of possibilities.</h3><p>Explore the collection or find out how we source your next automobile.</p></div><div class="e1-chat-feed" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text"></div><div class="e1-chat-prompts"><button type="button">Explore inventory</button><button type="button">How does sourcing work?</button></div></div>
        <div class="e1-chat-status" role="status"></div><div class="e1-chat-error" role="alert"></div>
        <button class="e1-chat-retry" type="button" hidden>Check availability again</button>
        <div class="e1-chat-compose"><label for="e1-chat-input" class="e1-chat-sr">Your message</label><textarea id="e1-chat-input" name="message" maxlength="600" rows="2" placeholder="How can we help?" aria-describedby="e1-chat-privacy" disabled></textarea><button class="e1-chat-send" type="submit" aria-label="Send message" disabled>${sendIcon}</button></div>
        <div class="e1-chat-actions"><button class="e1-chat-clear" type="button">New conversation</button><span class="e1-chat-count" aria-hidden="true">0 / 600</span></div>
        <p id="e1-chat-privacy" class="e1-chat-privacy">Messages are sent to Claude AI. Please avoid sensitive information. <a href="/contact">Speak to our team ↗</a></p>
      </form>
    </section>`;
  document.body.append(root);
  launcher = root.querySelector('.e1-chat-launcher');
  panel = root.querySelector('.e1-chat-panel');
  form = root.querySelector('form');
  input = root.querySelector('textarea');
  feed = root.querySelector('.e1-chat-feed');
  status = root.querySelector('.e1-chat-status');
  error = root.querySelector('.e1-chat-error');
  intro = root.querySelector('.e1-chat-intro');
  prompts = root.querySelector('.e1-chat-prompts');
  count = root.querySelector('.e1-chat-count');
  submit = root.querySelector('.e1-chat-send');
  retry = root.querySelector('.e1-chat-retry');
  launcher.addEventListener('click', () => {
    if (restricted()) return;
    opened = true;
    panel.hidden = false;
    launcher.hidden = true;
    launcher.setAttribute('aria-expanded', 'true');
    root.querySelector('.e1-chat-close').focus({preventScroll: true});
    if (available === null) void checkAvailability();
  });
  root.querySelector('.e1-chat-close').addEventListener('click', () => closeChat());
  root.querySelector('.e1-chat-clear').addEventListener('click', clearConversation);
  retry.addEventListener('click', checkAvailability);
  form.addEventListener('submit', sendMessage);
  form.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeChat(); }
    if (event.target === input && event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', updateControls);
  prompts.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    input.value = button.textContent;
    updateControls();
    input.focus({preventScroll: true});
  });
  form.querySelector('a').addEventListener('click', () => closeChat(false));
  new MutationObserver(refreshChat).observe(document.body, {attributes: true, attributeFilter: ['class']});
  const dialog = document.querySelector('#dialog');
  if (dialog) new MutationObserver(refreshChat).observe(dialog, {attributes: true, attributeFilter: ['open']});
  window.addEventListener('popstate', refreshChat);
  const viewport = window.visualViewport;
  if (viewport) {
    const resize = () => {
      root.style.setProperty('--chat-height', `${Math.max(200, Math.floor(viewport.height - 24))}px`);
      root.style.setProperty('--chat-keyboard', `${Math.max(0, Math.floor(window.innerHeight - viewport.height - viewport.offsetTop))}px`);
      root.toggleAttribute('data-compact', viewport.height < 500);
    };
    viewport.addEventListener('resize', resize);
    viewport.addEventListener('scroll', resize);
    resize();
  }
  refreshChat();
}
