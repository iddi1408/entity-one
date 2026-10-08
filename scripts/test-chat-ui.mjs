import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// No provider or browser calls. Exercise request boundaries, retries and resets.
let checks = 0;
const check = (actual, expected, description) => {assert.deepEqual(actual, expected, description); checks++;};
const plain = value => JSON.parse(JSON.stringify(value));
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.value = ''; this.children = []; this.hidden = false;
    this.attributes = {}; this.ownText = ''; this.scrollHeight = 100; this.scrollTop = 0; this.clientHeight = 100;
    this.dataset = {}; this.style = {setProperty() {}}; this.listeners = {};
    const classes = new Set();
    this.classList = {add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle: (value, force) => force === false ? classes.delete(value) : classes.add(value)};
  }
  append(...children) {this.children.push(...children); for (const child of children) if (child && typeof child === 'object') child.parentElement = this;}
  replaceChildren(...children) {this.ownText = ''; this.children = []; this.append(...children);}
  set textContent(value) {this.children = []; this.ownText = String(value);}
  get textContent() {return this.ownText + this.children.map(child => typeof child === 'string' ? child : child.textContent).join('');}
  setAttribute(name, value) {this.attributes[name] = value;}
  getAttribute(name) {return this.attributes[name] ?? this[name] ?? null;}
  removeAttribute(name) {delete this.attributes[name];}
  toggleAttribute(name, force) {if (force === false) delete this.attributes[name]; else this.attributes[name] = '';}
  addEventListener(name, callback) {(this.listeners[name] ||= []).push(callback);}
  dispatch(name, event = {}) {return Promise.all((this.listeners[name] || []).map(callback => callback({target: this, preventDefault() {}, ...event})));}
  closest(selector) {if (selector === 'a' && this.tagName === 'A' || selector === 'button' && this.tagName === 'BUTTON' || selector === 'button[data-prompt]' && this.tagName === 'BUTTON' && this.dataset.prompt) return this; return this.parentElement?.closest(selector) || null;}
  focus() {this.focused = true; sandbox.document.activeElement = this;}
  scrollIntoView() {}
  set innerHTML(value) {throw Error('Conversation content must never be rendered as HTML');}
}
const elements = Object.fromEntries(['root', 'launcher', 'panel', 'form', 'input', 'feed', 'status', 'error', 'intro', 'prompts', 'count', 'submit', 'retry', 'stop', 'messageRetry', 'jump', 'announcer', 'scroll'].map(name => [name, new Element()]));
elements.root.querySelector = selector => selector === '.e1-chat-scroll' ? elements.scroll : new Element();
let menuOpen = false, modalOpen = false, coarsePointer = false, fetchImpl;
const requests = [], location = {pathname: '/', search: '', origin: 'https://entity-one.test'};
const sandbox = {console, AbortController, URL, URLSearchParams, setTimeout, clearTimeout, requestAnimationFrame: callback => callback(), matchMedia: () => ({matches: coarsePointer}), location, document: {
  body: {classList: {contains: () => menuOpen}, append() {}},
  querySelector: () => modalOpen ? {} : null,
  createElement: tag => new Element(tag),
  createTextNode: text => {const node = new Element('#text'); node.textContent = text; return node;}
}, fetch: async (...args) => {requests.push(args); return fetchImpl(...args);}, elements};
const source = (await readFile(new URL('../public/chat.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
vm.createContext(sandbox);
vm.runInContext(source + `
({root, launcher, panel, form, input, feed, status, error, intro, prompts, count, submit, retry, stop, messageRetry, jump, announcer} = elements);
globalThis.chat = {buildContext, sendMessage, clearConversation, refreshChat, closeChat, checkAvailability, usePrompt, stopReply, safeChatHref, safeChatImage, safeCards, safeActions, addMessage, scrollToLatest,
  seed(history = [], usable = true) { messages = history; available = usable; busy = false; opened = true; pendingDraft = ''; lastFailedDraft = ''; },
  state() {return {messages, busy, available, opened, pendingDraft, lastFailedDraft};},
  initialize() {root = null; initChat();}};`, sandbox);
const chat = sandbox.chat, event = {preventDefault() {}};
const response = (data, status = 200) => ({ok: status < 400, status, json: async () => data});
const longHistory = Array.from({length: 10}, (_, i) => ({role: i % 2 ? 'assistant' : 'user', content: String(i).repeat(i % 2 ? 2000 : 600)}));
const tree = node => [node, ...node.children.flatMap(child => typeof child === 'string' ? [] : tree(child))];
const sampleCar = {id: 'porsche-1', brand: 'Porsche', model: '911 GT3 RS', year: '2024', region: 'Europe', status: 'available', price: 'Price on application', image: '/assets/porsche.jpg', href: '/inventory?car=porsche-1'};

for (const href of ['/inventory', '/inventory?view=all', '/inventory?car=porsche-1', '/wanted?view=all', '/about', '/contact', '/contact?intent=source', '/contact?car=porsche-1']) {
  check(chat.safeChatHref(href), href, 'Known public navigation remains usable');
}
for (const href of ['javascript:alert(1)', 'https://evil.example/inventory', '//evil.example/inventory', '/\\evil.example/inventory', '/admin', '/exclusive', '/api/users', '/inventory/../admin', '/inventory/%2e%2e/admin', '/contact?redirect=https://evil.example', '/contact?intent=delete', '/contact?car=%0a', '/about#evil', '/contact?car=' + 'a'.repeat(201)]) {
  check(chat.safeChatHref(href), '', 'Untrusted navigation cannot leave approved public routes');
}
for (const image of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'http://evil.example/car.jpg', '//evil.example/car.jpg', 'https://user:secret@evil.example/car.jpg', '/api/admin', '/assets/../../api/users']) {
  check(chat.safeChatImage(image), '', 'Unsafe or non-asset image URLs are rejected');
}
check(chat.safeChatImage('/assets/porsche.jpg'), location.origin + '/assets/porsche.jpg', 'Local collection image remains usable');
check(chat.safeChatImage('https://cdn.example/car.jpg'), 'https://cdn.example/car.jpg', 'Public HTTPS vehicle imagery remains usable');
check(plain(chat.safeCards([sampleCar])).length, 1, 'A valid public inventory card is accepted');
check(plain(chat.safeCards([sampleCar, sampleCar])).length, 1, 'Duplicate vehicle cards are removed');
check(plain(chat.safeCards(Array.from({length: 8}, (_, index) => ({...sampleCar, id: String(index), href: '/inventory?car=' + index})))).length, 3, 'Vehicle suggestions stay bounded');
for (const invalid of [null, {...sampleCar, status: 'draft'}, {...sampleCar, status: 'sold'}, {...sampleCar, href: '/inventory?car=another-car'}, {...sampleCar, href: '/contact?car=porsche-1'}, {...sampleCar, href: 'https://evil.example'}]) {
  check(plain(chat.safeCards([invalid])).length, 0, 'Invalid or mismatched vehicle cards never render');
}
check(plain(chat.safeActions([{label: 'Contact', href: '/contact'}, {label: 'Duplicate', href: '/contact'}, {label: 'Bad', href: '//evil.example'}, {label: 'Inventory', href: '/inventory'}, {label: 'About', href: '/about'}])).length, 2, 'Navigation actions are validated, deduplicated and bounded');
elements.feed.replaceChildren();
chat.addMessage({role: 'assistant', content: '**<img src=x onerror=alert(1)>**\n- [Bad link](javascript:alert(1))', cars: [{...sampleCar, model: '<svg onload=alert(1)>'}], actions: [{label: '<script>alert(1)</script>', href: '/contact'}]});
const renderedNodes = tree(elements.feed);
check(renderedNodes.some(node => node.tagName === 'STRONG' && node.textContent.includes('<img')), true, 'Safe emphasis keeps suspicious markup as literal text');
check(renderedNodes.filter(node => node.tagName === 'A').map(node => node.href), ['/inventory?car=porsche-1', '/contact'], 'Model-generated markdown cannot create links');
check(renderedNodes.some(node => node.tagName === 'SCRIPT' || node.tagName === 'SVG'), false, 'Response and card text never create executable markup');
check(elements.feed.textContent.includes('<svg onload=alert(1)>'), true, 'Untrusted vehicle metadata is displayed as plain text');

const trimmed = plain(chat.buildContext(longHistory, 'q'.repeat(600)));
check(trimmed.length, 3, 'Drops the oldest pair when the last five messages exceed the total budget');
check(trimmed.reduce((sum, item) => sum + item.content.length, 0) <= 3000, true, 'Total context stays within server limit');
check(trimmed.map(item => item.role), ['user', 'assistant', 'user'], 'Alternation and final user message are preserved');
check(trimmed.at(-1).content, 'q'.repeat(600), 'Current question is never discarded');
check(plain(chat.buildContext(longHistory.map(item => ({...item, content: 'short'})), 'question')).length, 5, 'Short history retains the maximum useful context');
const projected = plain(chat.buildContext([{role: 'user', content: 'Ferrari', privateNotes: 'Do not send'}, {role: 'assistant', content: 'A public reply', cars: [{image: 'not-provider-context'}], actions: [{href: '/contact'}]}], 'Details?'));
check(projected.every(message => Object.keys(message).sort().join(',') === 'content,role'), true, 'Only conversational text enters the provider context');
check(JSON.stringify(projected).includes('not-provider-context'), false, 'Card images and actions never consume provider tokens');

chat.seed(longHistory);
elements.input.value = 'q'.repeat(600);
let resolveRequest;
fetchImpl = () => new Promise(resolve => {resolveRequest = resolve;});
const sending = chat.sendMessage(event);
check(requests.length, 1, 'An explicit submit starts one request');
check(elements.feed.children.filter(child => child.className?.startsWith('e1-chat-message ')).length <= 10, true, 'Pending displayed messages remain bounded');
check(elements.stop.hidden, false, 'The visitor can stop a pending reply');
check(elements.input.disabled, true, 'Input is disabled during a request');
elements.input.value = 'duplicate';
await chat.sendMessage(event);
check(requests.length, 1, 'Repeated submits cannot duplicate the provider request');
const outbound = JSON.parse(requests[0][1].body).messages;
check(outbound.reduce((sum, item) => sum + item.content.length, 0) <= 3000, true, 'Actual outbound request observes the total budget');
resolveRequest(response({reply: '<img src=x onerror=alert(1)> Plain text only.'}));
await sending;
check(chat.state().messages.length, 10, 'Completed conversation retains only ten messages');
check(elements.feed.children.at(-1).children.at(-1).textContent.startsWith('<img'), true, 'Potential HTML is displayed as literal text');

chat.clearConversation();
elements.input.value = 'Do you have a Ferrari?';
fetchImpl = async () => response({}, 503);
await chat.sendMessage(event);
check(elements.input.value, 'Do you have a Ferrari?', 'Failure restores the question for a manual retry');
check(chat.state().messages.length, 0, 'Unanswered questions never enter conversation context');
check(elements.error.textContent.includes('temporarily unavailable'), true, 'Failure gives a useful safe error');
const beforeFailureWait = requests.length;
await Promise.resolve();
check(requests.length, beforeFailureWait, 'Failures do not automatically resend');

for (const [failureResponse, expectedError] of [
  [() => response({}, 429), /busy|limit|moment|later/i],
  [() => {throw new TypeError('Network connection lost');}, /connect|send|again|network/i],
  [() => {const failure = new Error('Timed out'); failure.name = 'AbortError'; throw failure;}, /long|again|time/i],
  [() => response({reply: ''}), /answered|try|again/i]
]) {
  elements.input.value = 'Please help me source an SVJ.';
  fetchImpl = async () => failureResponse();
  await chat.sendMessage(event);
  check(elements.input.value, 'Please help me source an SVJ.', 'Each failure preserves the original question');
  check(chat.state().messages.length, 0, 'Failures leave no unanswered user entry in history');
  check(expectedError.test(elements.error.textContent), true, 'Each failure has a useful recovery message');
  check(chat.state().busy, false, 'Each failure releases the sending state');
}

fetchImpl = async () => response({reply: 'Our team can help you source an SVJ.'});
const beforeRetry = requests.length;
await chat.sendMessage(event);
check(requests.length, beforeRetry + 1, 'A manual retry sends exactly once');
check(chat.state().messages.length, 2, 'Successful retry adds one question and one answer');
check(elements.input.value, '', 'Successful retry clears the draft');
chat.clearConversation();
const beforeBlank = requests.length;
elements.input.value = '   ';
await chat.sendMessage(event);
check(requests.length, beforeBlank, 'Whitespace cannot trigger a provider request');
elements.input.value = 'Question before private navigation';

fetchImpl = () => new Promise(resolve => {resolveRequest = resolve;});
const pending = chat.sendMessage(event);
location.pathname = '/admin';
chat.refreshChat();
check(elements.root.hidden, true, 'Private routes hide the entire widget');
check(chat.state().messages.length, 0, 'Private routes clear conversation memory');
check(requests.at(-1)[1].signal.aborted, true, 'Private navigation aborts the pending request');
resolveRequest(response({reply: 'Late response'}));
await pending;
check(chat.state().messages.length, 0, 'Late responses cannot restore a cleared conversation');
location.pathname = '/inventory';
chat.refreshChat();
check(elements.root.hidden, false, 'Launcher is available again on a public route');
check(elements.launcher.hidden, false, 'Launcher does not remain hidden after private navigation');
menuOpen = true;
chat.refreshChat();
check(elements.root.hidden, true, 'Open navigation hides the widget');
menuOpen = false; modalOpen = true;
chat.refreshChat();
check(elements.root.hidden, true, 'A site modal hides the widget');
modalOpen = false;

fetchImpl = async () => response({available: false});
await chat.checkAvailability();
check(elements.input.disabled, true, 'Unavailable configuration disables message submission');
const beforeUnavailable = requests.length;
elements.input.value = 'Hello';
await chat.sendMessage(event);
check(requests.length, beforeUnavailable, 'Unavailable service cannot trigger a chat request');
check(elements.retry.hidden, false, 'A manual availability retry remains available');

for (const privatePath of ['/exclusive', '/admin', '/admin/settings']) {
  chat.seed([], true);
  location.pathname = privatePath;
  elements.input.value = 'A private-page draft must not be transmitted';
  const beforePrivate = requests.length;
  await chat.sendMessage(event);
  check(requests.length, beforePrivate, 'No chat request is sent from a private route');
  chat.refreshChat();
  check(elements.input.value, '', 'Entering a private route clears an unsent draft');
  check(elements.root.hidden, true, 'Private routes conceal chat controls');
}
location.pathname = '/';
chat.refreshChat();

chat.clearConversation();
fetchImpl = async () => response({reply: 'Here is a car from the collection.', cars: [sampleCar], actions: [{label: 'Speak to the team', href: '/contact'}]});
const beforePrompt = requests.length;
await chat.usePrompt('Show me the cars currently listed in your inventory.');
check(requests.length, beforePrompt + 1, 'One prompt click submits exactly one request');
check(JSON.parse(requests.at(-1)[1].body).messages.at(-1).content, 'Show me the cars currently listed in your inventory.', 'The selected prompt is the outbound question');
check(chat.state().messages.at(-1).cars.length, 1, 'Confirmed replies retain safe public vehicle suggestions');
check(tree(elements.feed).filter(node => node.tagName === 'A').map(node => node.href), ['/inventory?car=porsche-1', '/contact'], 'A successful reply exposes working vehicle and contact destinations');

chat.clearConversation();
const pendingRequests = [];
fetchImpl = () => new Promise(resolve => pendingRequests.push(resolve));
const cancelled = chat.usePrompt('Find a white SVJ.');
const cancelSignal = requests.at(-1)[1].signal;
const beforeBusyPrompt = requests.length;
await chat.usePrompt('Do not submit a second prompt.');
check(requests.length, beforeBusyPrompt, 'Prompt clicks cannot duplicate a pending request');
chat.stopReply();
check(cancelSignal.aborted, true, 'Stopping cancels the browser request');
check(elements.input.value, 'Find a white SVJ.', 'Stopping restores the question for editing');
check(chat.state().busy, false, 'Stopping releases the composer immediately');
check(chat.state().messages.length, 0, 'Stopped questions are excluded from future context');
const replacement = chat.usePrompt('Show me a Porsche instead.');
pendingRequests[0](response({reply: 'Late cancelled reply'}));
await cancelled;
check(chat.state().busy, true, 'An old response cannot finish a newer request');
check(chat.state().messages.length, 0, 'An old response cannot restore stopped history');
pendingRequests[1](response({reply: 'This is the replacement reply.'}));
await replacement;
check(chat.state().messages.at(-1).content, 'This is the replacement reply.', 'Only the current request can update the conversation');

const cleared = chat.usePrompt('Question that will be cleared.');
const clearSignal = requests.at(-1)[1].signal;
chat.clearConversation();
check(clearSignal.aborted, true, 'Starting fresh aborts any in-flight request');
check(elements.input.value, '', 'Starting fresh removes the draft');
check(elements.feed.children.length, 0, 'Starting fresh removes all conversation and vehicle cards');
pendingRequests[2](response({reply: 'Late cleared reply', cars: [sampleCar]}));
await cleared;
check(chat.state().messages.length, 0, 'A late response cannot repopulate a new conversation');
check(elements.feed.children.length, 0, 'A late response cannot redraw cleared cards');

chat.closeChat();
check(elements.panel.hidden, true, 'Closing hides the conversation');
check(elements.launcher.attributes['aria-expanded'], 'false', 'Closing resets the accessible launcher state');
check(elements.launcher.focused, true, 'Closing returns keyboard focus to the launcher');

// Bind the real initialization handlers to a small document fixture. Provider
// replies stay mocked; this covers the visitor's clicks rather than helper-only calls.
const initialRoot = new Element('aside'), closeButton = new Element('button'), clearButton = new Element('button');
let shellMarkup = '';
Object.defineProperty(initialRoot, 'innerHTML', {set(value) {shellMarkup = value;}});
const selectors = {'.e1-chat-launcher': 'launcher', '.e1-chat-panel': 'panel', form: 'form', textarea: 'input', '.e1-chat-feed': 'feed', '.e1-chat-status': 'status', '.e1-chat-error': 'error', '.e1-chat-intro': 'intro', '.e1-chat-prompts': 'prompts', '.e1-chat-count': 'count', '.e1-chat-send': 'submit', '.e1-chat-retry': 'retry', '.e1-chat-stop': 'stop', '.e1-chat-message-retry': 'messageRetry', '.e1-chat-jump': 'jump', '.e1-chat-announcer': 'announcer', '.e1-chat-scroll': 'scroll'};
initialRoot.querySelector = selector => selector === '.e1-chat-close' ? closeButton : selector === '.e1-chat-clear' ? clearButton : elements[selectors[selector]];
sandbox.document.createElement = tag => tag === 'aside' ? initialRoot : new Element(tag);
sandbox.window = {addEventListener() {}};
sandbox.MutationObserver = class {observe() {}};
elements.form.requestSubmit = () => elements.form.dispatch('submit');
chat.seed([], true);
chat.initialize();
await elements.launcher.dispatch('click');
check(elements.panel.hidden, false, 'Launcher opens the bound panel');
check(closeButton.focused, true, 'Opening places keyboard focus inside the panel');
check(shellMarkup.includes('aria-label="Stop reply"') && shellMarkup.includes('aria-label="Start a new conversation"'), true, 'Icon-only conversation controls have accessible labels');

fetchImpl = async () => response({reply: 'I can help you source that car.'});
const promptButton = new Element('button'), promptLabel = new Element('strong');
promptButton.dataset.prompt = 'How can ENTITY-1 help me source a specific car?';
promptButton.append(promptLabel);
const beforePromptClick = requests.length;
await elements.prompts.dispatch('click', {target: promptLabel});
await new Promise(resolve => setTimeout(resolve, 0));
check(requests.length, beforePromptClick + 1, 'Clicking a nested prompt label immediately sends its question');
check(chat.state().messages.at(-1).content, 'I can help you source that car.', 'Bound prompt click completes a conversation turn');
const contactLink = new Element('a'); contactLink.href = '/contact?intent=source';
await elements.form.dispatch('click', {target: contactLink});
check(chat.state().opened, false, 'Contact navigation closes the overlay so the form is visible');

await elements.launcher.dispatch('click');
let keyboardSubmits = 0;
elements.form.requestSubmit = () => {keyboardSubmits++;};
for (const [keyEvent, coarse, expected] of [
  [{key: 'Enter'}, false, 1],
  [{key: 'Enter', shiftKey: true}, false, 1],
  [{key: 'Enter', isComposing: true}, false, 1],
  [{key: 'Enter'}, true, 1]
]) {
  coarsePointer = coarse;
  await elements.form.dispatch('keydown', {target: elements.input, ...keyEvent});
  check(keyboardSubmits, expected, 'Enter sends on desktop while multiline, IME and mobile typing remain safe');
}
coarsePointer = false;
await elements.form.dispatch('keydown', {key: 'Escape'});
check(elements.panel.hidden, true, 'Escape closes the panel using its bound keyboard handler');

const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
check(css.includes('[hidden]{display:none!important}'), true, 'Global hidden rule overrides chat display rules');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const stylesheets = [...html.matchAll(/rel="stylesheet" href="([^"]+)"/g)].map(match => match[1]);
check(stylesheets.indexOf('/mobile.css') > stylesheets.indexOf('/chat.css'), true, 'Mobile refinements follow chat base styles');
console.log(`Chat UI: ${checks} checks passed; no external API calls.`);
