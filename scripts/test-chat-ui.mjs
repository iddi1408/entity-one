import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// No provider or browser calls. Exercise request boundaries, retries and resets.
let checks = 0;
const check = (actual, expected, description) => {assert.deepEqual(actual, expected, description); checks++;};
const plain = value => JSON.parse(JSON.stringify(value));
class Element {
  constructor() {this.value = ''; this.children = []; this.hidden = false; this.attributes = {}; this.textContent = ''; this.scrollHeight = 100;}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children = children;}
  setAttribute(name, value) {this.attributes[name] = value;}
  focus() {this.focused = true;}
  set innerHTML(value) {throw Error('Conversation content must never be rendered as HTML');}
}
const elements = Object.fromEntries(['root', 'launcher', 'panel', 'form', 'input', 'feed', 'status', 'error', 'intro', 'prompts', 'count', 'submit', 'retry'].map(name => [name, new Element()]));
elements.root.querySelector = () => new Element();
let menuOpen = false, modalOpen = false, fetchImpl;
const requests = [], location = {pathname: '/'};
const sandbox = {console, AbortController, setTimeout, clearTimeout, location, document: {
  body: {classList: {contains: () => menuOpen}},
  querySelector: () => modalOpen ? {} : null,
  createElement: () => new Element()
}, fetch: async (...args) => {requests.push(args); return fetchImpl(...args);}, elements};
const source = (await readFile(new URL('../public/chat.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
vm.createContext(sandbox);
vm.runInContext(source + `
({root, launcher, panel, form, input, feed, status, error, intro, prompts, count, submit, retry} = elements);
globalThis.chat = {buildContext, sendMessage, clearConversation, refreshChat, closeChat, checkAvailability,
  seed(history = [], usable = true) { messages = history; available = usable; busy = false; opened = true; },
  state() {return {messages, busy, available, opened};}};`, sandbox);
const chat = sandbox.chat, event = {preventDefault() {}};
const response = (data, status = 200) => ({ok: status < 400, status, json: async () => data});
const longHistory = Array.from({length: 10}, (_, i) => ({role: i % 2 ? 'assistant' : 'user', content: String(i).repeat(i % 2 ? 2000 : 600)}));

const trimmed = plain(chat.buildContext(longHistory, 'q'.repeat(600)));
check(trimmed.length, 3, 'Drops the oldest pair when the last five messages exceed the total budget');
check(trimmed.reduce((sum, item) => sum + item.content.length, 0) <= 3000, true, 'Total context stays within server limit');
check(trimmed.map(item => item.role), ['user', 'assistant', 'user'], 'Alternation and final user message are preserved');
check(trimmed.at(-1).content, 'q'.repeat(600), 'Current question is never discarded');
check(plain(chat.buildContext(longHistory.map(item => ({...item, content: 'short'})), 'question')).length, 5, 'Short history retains the maximum useful context');

chat.seed(longHistory);
elements.input.value = 'q'.repeat(600);
let resolveRequest;
fetchImpl = () => new Promise(resolve => {resolveRequest = resolve;});
const sending = chat.sendMessage(event);
check(requests.length, 1, 'An explicit submit starts one request');
check(elements.feed.children.length <= 10, true, 'Pending display remains bounded');
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

const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
check(css.includes('[hidden]{display:none!important}'), true, 'Global hidden rule overrides chat display rules');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
check([...html.matchAll(/rel="stylesheet" href="([^"]+)"/g)].at(-1)?.[1], '/mobile.css', 'Mobile refinements are the final stylesheet');
console.log(`Chat UI: ${checks} checks passed; no external API calls.`);
