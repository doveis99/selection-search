// Tests for sites/ai_chat.js. Run with: node --test "tests/*.test.js"

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'sites', 'ai_chat.js'), 'utf8');

const PENDING_KEY = '__selection_search_ai_chat_pending__';
const REDIRECT_KEY = '__selection_search_ai_chat_private_redirect__';

function harness({url = 'https://gemini.google.com/app?custom_query=test&keep=1', options = {},
        active = false, missing = false, storage: initialStorage = {}, readBack = text => text} = {}) {
    const observers = new Set(), storage = new Map(Object.entries(initialStorage)), timers = new Map();
    const requirePrivate = url.includes('claude.ai')
        ? options.ai_chat_claude_incognito !== false : options.ai_chat_gemini_temp_chat !== false;
    const state = {active, clicks: 0, sends: 0, editorPresent: true, now: 100, replaced: null};
    const wake = () => {for (const observer of [...observers]) observer.callback();};
    class MutationObserver {
        constructor(callback) {this.callback = callback;}
        observe() {observers.add(this);}
        disconnect() {observers.delete(this);}
    }
    const element = () => ({
        getBoundingClientRect: () => ({width: 10, height: 10}),
        getAttribute: () => null, hasAttribute: () => false,
        matches: () => true, querySelector: () => null, closest: () => null,
        className: '', classList: {contains: () => false}, focus() {}, dispatchEvent() {wake();},
    });
    const editor = Object.assign(element(), {textContent: ''});
    Object.defineProperty(editor, 'innerText', {get: () => readBack(editor.textContent)});
    const tempChat = element();
    tempChat.classList.contains = name => name === 'temp-chat-on' && state.active;
    tempChat.click = () => {state.clicks++; state.active = true; wake();};
    const send = element();
    send.click = () => {assert.ok(!requirePrivate || state.active); state.sends++; wake();};
    const document = new EventTarget();
    document.readyState = 'complete';
    document.documentElement = {};
    document.body = {appendChild() {}};
    document.getElementById = () => null;
    document.createElement = () => ({style: {}, remove() {}});
    document.querySelector = selector =>
        (selector.includes('.is-temporary-chat') || selector.includes('incognito-frame')) && state.active ? tempChat : null;
    document.querySelectorAll = selector => {
        assert.doesNotMatch(selector, /mode-option|bard-mode|menuitem|side-nav|hamburger/i);
        if (selector.includes('temp-chat')) return missing ? [] : [tempChat];
        if (selector.includes('contenteditable')) return state.editorPresent ? [editor] : [];
        if (selector.includes('send')) return [send];
        return [];
    };
    document.execCommand = (command, ui, value) => {
        if (command === 'delete') editor.textContent = '';
        if (command === 'insertText') editor.textContent = value;
        return true;
    };
    const setUrl = href => {
        const parsed = new URL(href);
        Object.assign(window.location, {href, search: parsed.search, hostname: parsed.hostname, pathname: parsed.pathname});
    };
    const window = new EventTarget();
    window.location = {replace(href) {state.replaced = href;}};
    setUrl(url);
    window.history = {state: {marker: 1}, replaceState(value, title, href) {
        this.state = value; setUrl(href); window.navigation.dispatchEvent(new Event('currententrychange'));
    }};
    window.navigation = new EventTarget();
    window.getComputedStyle = () => ({display: 'block', visibility: 'visible'});
    class UIEvent {constructor(type, init) {this.type = type; Object.assign(this, init);}}
    let nextTimer = 0;
    const context = vm.createContext({
        document, window, MutationObserver, queueMicrotask, URL, URLSearchParams, console,
        sessionStorage: {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
        chrome: {
            runtime: {lastError: undefined},
            i18n: {getMessage: key => key},
            storage: {local: {get(key, callback) {Promise.resolve().then(() => callback({options}));}}},
        },
        Date: class extends Date {static now() {return state.now;}},
        setTimeout(callback) {timers.set(++nextTimer, callback); return nextTimer;}, clearTimeout: id => timers.delete(id),
        InputEvent: UIEvent,
    });
    const startup = source.lastIndexOf('    init();');
    assert.ok(startup > 0);
    vm.runInContext(source.slice(0, startup) + `
        globalThis.api = {init, processCurrentState, getPendingQuery, getState: () => currentState};
    })();`, context);
    const drain = async () => {for (let i = 0; i < 10; i++) await Promise.resolve();};
    return {...context.api, state, editor, observers, storage, window, wake, drain,
        async start() {context.api.init(); await drain();},
        async advance(ms) {state.now += ms; context.api.processCurrentState(); await drain();},
        async navigate(href) {
            setUrl(href);
            window.navigation.dispatchEvent(new Event('currententrychange'));
            await drain();
        },
    };
}

test('temporary chat and auto-send run once despite repeated DOM changes', async () => {
    const h = harness();
    await h.start();
    assert.equal(h.state.clicks, 1);
    assert.equal(h.state.sends, 1);
    assert.equal(h.editor.textContent, 'test');
    assert.equal(h.getState(), 'SENDING');
    for (let i = 0; i < 10; i++) h.wake();
    await h.drain();
    assert.equal(h.state.sends, 1);
    h.editor.textContent = '';
    h.wake(); await h.drain();
    assert.equal(h.getState(), 'COMPLETED');
    assert.equal(h.getPendingQuery(), null);
    assert.equal(h.observers.size, 0);
    assert.equal(h.window.location.href, 'https://gemini.google.com/app?keep=1');
    assert.equal(h.window.history.state.marker, 1);
});

test('an already active temporary chat is not toggled off', async () => {
    const h = harness({active: true});
    await h.start();
    assert.equal(h.state.clicks, 0);
    assert.equal(h.state.sends, 1);
});

test('missing temporary chat stops without sending in a normal chat', async () => {
    const h = harness({missing: true});
    await h.start();
    await h.advance(20001);
    assert.equal(h.getState(), 'FAILED');
    assert.equal(h.getPendingQuery(), 'test');
    assert.equal(h.state.sends, 0);
    assert.equal(h.observers.size, 0);
});

test('unconfirmed submission times out instead of repeatedly sending', async () => {
    const h = harness();
    await h.start();
    await h.advance(30001);
    assert.equal(h.getState(), 'FAILED');
    assert.equal(h.state.sends, 1);
    assert.equal(h.getPendingQuery(), 'test');
    assert.equal(h.observers.size, 0);
});

test('a temporarily missing editor does not clear the pending query', async () => {
    const h = harness();
    await h.start();
    h.state.editorPresent = false;
    h.wake(); await h.drain();
    assert.equal(h.getState(), 'SENDING');
    assert.equal(h.getPendingQuery(), 'test');
});

test('idle tabs have no DOM observer and a later SPA query starts normally', async () => {
    const h = harness({url: 'https://gemini.google.com/app'});
    await h.start();
    assert.equal(h.observers.size, 0);
    await h.navigate('https://gemini.google.com/app?q=test');
    assert.equal(h.state.sends, 1);
    assert.equal(h.window.location.href, 'https://gemini.google.com/app');
});

test('a sent query restored into the url by the page is not sent again', async () => {
    const h = harness();
    await h.start();
    h.editor.textContent = '';
    h.wake(); await h.drain();
    assert.equal(h.getState(), 'COMPLETED');
    await h.navigate('https://gemini.google.com/app?q=test');
    assert.equal(h.state.sends, 1);
    assert.equal(h.window.location.href, 'https://gemini.google.com/app');
});

test('multi-line queries read back with blank lines are still sent', async () => {
    const h = harness({url: 'https://gemini.google.com/app?q=line1%0Aline2', readBack: text => text.replace(/\n/g, '\n\n')});
    await h.start();
    assert.equal(h.editor.textContent, 'line1\nline2');
    assert.equal(h.state.sends, 1);
});

test('without the temporary chat option the query is sent in the current chat', async () => {
    const h = harness({options: {ai_chat_gemini_temp_chat: false}});
    await h.start();
    assert.equal(h.state.clicks, 0);
    assert.equal(h.state.sends, 1);
});

test('nothing happens when auto send is disabled', async () => {
    const h = harness({options: {ai_chat_autosend: false}});
    await h.start();
    assert.equal(h.state.sends, 0);
    assert.equal(h.observers.size, 0);
    assert.equal(h.getPendingQuery(), null);
    assert.equal(h.window.location.href, 'https://gemini.google.com/app?custom_query=test&keep=1');
});

test('claude reopens the new chat page in incognito mode before sending', async () => {
    const h = harness({url: 'https://claude.ai/new?q=test'});
    await h.start();
    assert.equal(h.state.replaced, 'https://claude.ai/new?incognito=true');
    assert.equal(h.getPendingQuery(), 'test');
    assert.equal(h.state.sends, 0);
});

test('claude sends once incognito mode is confirmed', async () => {
    const h = harness({url: 'https://claude.ai/new?incognito=true', storage: {[PENDING_KEY]: 'test'}});
    await h.start();
    assert.equal(h.state.sends, 0);
    h.state.active = true;
    h.wake(); await h.drain();
    assert.equal(h.state.replaced, null);
    assert.equal(h.state.sends, 1);
});

test('claude keeps the incognito parameter when the query is removed from the url', async () => {
    const h = harness({url: 'https://claude.ai/new?incognito=true&q=test', active: true});
    await h.start();
    assert.equal(h.state.replaced, null);
    assert.equal(h.state.sends, 1);
    assert.equal(h.window.location.href, 'https://claude.ai/new?incognito=true');
});

test('claude does not reload again when incognito mode is not confirmed', async () => {
    const h = harness({url: 'https://claude.ai/new', storage: {[PENDING_KEY]: 'test', [REDIRECT_KEY]: 'test'}});
    await h.start();
    await h.advance(20001);
    assert.equal(h.state.replaced, null);
    assert.equal(h.getState(), 'FAILED');
    assert.equal(h.state.sends, 0);
});

test('claude sends in a normal chat without the incognito option', async () => {
    const h = harness({url: 'https://claude.ai/new?q=test', options: {ai_chat_claude_incognito: false}});
    await h.start();
    assert.equal(h.state.replaced, null);
    assert.equal(h.state.sends, 1);
});

test('claude ignores the q parameter outside the new chat page', async () => {
    const h = harness({url: 'https://claude.ai/recents?q=test', active: true});
    await h.start();
    assert.equal(h.state.sends, 0);
    assert.equal(h.getPendingQuery(), null);
    assert.equal(h.window.location.href, 'https://claude.ai/recents?q=test');
});
