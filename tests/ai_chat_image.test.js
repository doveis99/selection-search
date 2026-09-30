// Tests for the images of "search by capturing an area" in sites/ai_chat.js.
// Run with: node --test "tests/*.test.js"

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'sites', 'ai_chat.js'), 'utf8');

const TASK_ID = '0123abcd-4567-89ab-cdef-0123456789ab';
const TASK_KEY = '__selection_search_ai_chat_task__';
const PNG = 'data:image/png;base64,' + Buffer.from('fake image bytes').toString('base64');
const CLAUDE_ACCEPT = '.pdf,.docx,.doc,.txt,.py,.js,.jpg,.jpeg,.png,.gif,.webp,.bmp,.xlsx';

const makeTask = (extra = {}) => ({imageDataUrl: PNG, mimeType: 'image/png', filename: 'selection-search-capture.png', question: '', ...extra});

// A page with an editor, a send button, an attach button that creates the file input
// (like Gemini) or a file input that is there from the start (like Claude).
function harness({
    url = `https://gemini.google.com/app?ss_task=${TASK_ID}`,
    options = {},
    task = makeTask(),
    active = false,
    missingPrivate = false,
    hasInput = false,
    inputAccept = 'image/*',
    hasTrigger = true,
    triggerDisabled = false,
    ignoreClicks = 0,   // clicks on the attach button the page does not react to yet
    ignoreSends = 0,    // clicks on the send button the page ignores
    modelDelay = 0,     // ms until the page has taken over typed text (the editor stays "blank" until then)
    chipDelay = 0,      // ms until the preview of an attached image is rendered
    works = {input: true, paste: false, drop: false},
    clipboard = true,
    storage: initialStorage = {},
} = {}) {
    const observers = new Set(), storage = new Map(Object.entries(initialStorage)), timers = new Map();
    const requirePrivate = url.includes('claude.ai')
        ? options.ai_chat_claude_incognito !== false : options.ai_chat_gemini_temp_chat !== false;
    const state = {
        active, now: 100, replaced: null, privateClicks: 0, sends: 0, sentText: null,
        inputPresent: hasInput, menuOpen: false, triggerClicks: 0, changes: 0, pasted: 0, dropped: 0,
        chips: 0, uploading: false, focused: false, toasts: [], finished: [], clipboardItems: null, filesSeen: null,
        triggerDisabled, ignoredClicks: ignoreClicks, documentEvents: [],
        ignoredSends: ignoreSends, sendClicks: 0, typedAt: 0, attachedAt: 0,
    };
    // The preview of an attached image is rendered a moment after the image was handed over
    const visibleChips = () => state.chips > 0 && state.now >= state.attachedAt + chipDelay ? state.chips : 0;
    const wake = () => {for (const observer of [...observers]) observer.callback();};
    class MutationObserver {
        constructor(callback) {this.callback = callback;}
        observe() {observers.add(this);}
        disconnect() {observers.delete(this);}
    }
    const element = (extra = {}) => Object.assign({
        getBoundingClientRect: () => ({width: 10, height: 10}),
        getAttribute: () => null, hasAttribute: () => false,
        matches: () => true, querySelector: () => null, closest: () => null,
        className: '', classList: {contains: () => false}, focus() {}, dispatchEvent() {wake(); return true;},
    }, extra);
    const addAttachment = () => {
        if (state.chips === 0) state.attachedAt = state.now;
        state.chips++;
    };

    const editor = element({textContent: '', focus() {state.focused = true;}});
    Object.defineProperty(editor, 'innerText', {get: () => editor.textContent});
    // Gemini marks an editor blank until it has taken over text, Claude has a placeholder
    editor.matches = selector => (selector === '.ql-blank' || selector === '.is-editor-empty')
        && (editor.textContent.length === 0 || state.now < state.typedAt + modelDelay);
    editor.dispatchEvent = ev => {
        if (ev.type === 'paste') {state.pasted++; state.filesSeen = ev.clipboardData.files; if (works.paste) addAttachment();}
        wake();
        return true;
    };
    const zone = element();
    zone.dispatchEvent = ev => {
        if (ev.type === 'drop') {state.dropped++; state.filesSeen = ev.dataTransfer.files; if (works.drop) addAttachment();}
        wake();
        return true;
    };
    editor.closest = () => zone;

    const fileInput = element({disabled: false, files: null});
    fileInput.getAttribute = name => name === 'accept' ? inputAccept : null;
    fileInput.dispatchEvent = ev => {
        if (ev.type === 'change') {
            state.changes++;
            state.filesSeen = fileInput.files;
            if (works.input) addAttachment();
        }
        wake();
        return true;
    };

    const trigger = element();
    Object.defineProperty(trigger, 'disabled', {get: () => state.triggerDisabled});
    trigger.getAttribute = name => name === 'aria-expanded' ? String(state.menuOpen) : null;
    trigger.click = () => {
        state.triggerClicks++;
        if (state.ignoredClicks > 0) {
            state.ignoredClicks--;
            wake();
            return;
        }
        state.menuOpen = !state.menuOpen;
        if (state.menuOpen) state.inputPresent = true;
        wake();
    };

    const send = element();
    Object.defineProperty(send, 'disabled', {get: () => !(state.chips > 0 || editor.textContent.length > 0)});
    send.click = () => {
        assert.ok(!requirePrivate || state.active, 'sent outside the private chat');
        state.sendClicks++;
        if (state.ignoredSends > 0) {
            state.ignoredSends--;
            wake();
            return;
        }
        state.sends++;
        state.sentText = editor.textContent;
        state.sentWithImages = state.chips;
        editor.textContent = '';
        wake();
    };

    const tempChat = element();
    tempChat.classList.contains = name => name === 'temp-chat-on' && state.active;
    tempChat.click = () => {state.privateClicks++; state.active = true; wake();};

    const document = new EventTarget();
    // The events of the script are not real events, so they are only recorded
    document.dispatchEvent = ev => {state.documentEvents.push(`${ev.type}:${ev.key}`); return true;};
    document.readyState = 'complete';
    document.documentElement = {};
    document.body = {appendChild(node) {state.toasts.push(node.textContent);}};
    document.getElementById = () => null;
    document.createElement = () => ({style: {}, remove() {}});
    document.querySelector = selector => {
        if ((selector.includes('.is-temporary-chat') || selector.includes('incognito-frame')) && state.active) return tempChat;
        if (state.uploading && (selector.includes('mat-spinner') || selector.includes('progressbar'))) return element();
        // The attachment element of the site, its upload indicator selector has the same words
        if (!selector.includes('mat-spinner') && !selector.includes('progressbar')
                && (selector.includes('uploader-file-preview') || selector.includes('file-thumbnail')) && visibleChips() > 0) return element();
        return null;
    };
    document.querySelectorAll = selector => {
        assert.doesNotMatch(selector, /mode-option|bard-mode|menuitem|side-nav|hamburger/i);
        if (selector === 'input[type="file"]') return state.inputPresent ? [fileInput] : [];
        if (selector.startsWith('img[src^="blob:"]')) return [];
        if (selector.includes('temp-chat')) return missingPrivate ? [] : [tempChat];
        if (selector.includes('contenteditable')) return [editor];
        if (selector.includes('send')) return [send];
        if (selector.includes('chat-input-attach') || selector.includes('업로드')) return hasTrigger ? [trigger] : [];
        if (selector.includes('uploader-file-preview') || selector.includes('file-thumbnail')) {
            return Array.from({length: visibleChips()}, () => element());
        }
        return [];
    };
    document.execCommand = (command, ui, value) => {
        if (command === 'delete') editor.textContent = '';
        if (command === 'insertText') {
            editor.textContent = value;
            state.typedAt = state.now;
        }
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

    class Event_ {constructor(type, init = {}) {this.type = type; Object.assign(this, init);}}
    class File {constructor(parts, name, init = {}) {this.parts = parts; this.name = name; this.type = init.type; this.size = parts.reduce((n, p) => n + p.length, 0);}}
    class DataTransfer {constructor() {this.files = []; this.items = {add: file => this.files.push(file)};}}
    class ClipboardItem {constructor(items) {this.items = items;}}

    let nextTimer = 0;
    const context = vm.createContext({
        document, window, MutationObserver, queueMicrotask, URL, URLSearchParams, console, atob, Uint8Array,
        Event: Event_, InputEvent: Event_, ClipboardEvent: Event_, DragEvent: Event_, KeyboardEvent: Event_,
        File, DataTransfer, ClipboardItem,
        navigator: {clipboard: {async write(items) {
            if (!clipboard) throw new Error('not allowed');
            state.clipboardItems = items;
        }}},
        sessionStorage: {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
        chrome: {
            runtime: {
                lastError: undefined,
                sendMessage(message, callback) {
                    if (message.action === 'getCaptureTask') {
                        const found = task && message.taskId === TASK_ID ? task : null;
                        Promise.resolve().then(() => callback({task: found}));
                    } else if (message.action === 'finishCaptureTask') {
                        state.finished.push(message.taskId);
                        Promise.resolve().then(() => callback({}));
                    }
                },
            },
            i18n: {getMessage: (key, substitutions) => key + (substitutions ? ':' + [].concat(substitutions).join(',') : '')},
            storage: {local: {get(key, callback) {Promise.resolve().then(() => callback({options}));}}},
        },
        Date: class extends Date {static now() {return state.now;}},
        setTimeout(callback) {timers.set(++nextTimer, callback); return nextTimer;}, clearTimeout: id => timers.delete(id),
    });
    const startup = source.lastIndexOf('    init();');
    assert.ok(startup > 0);
    vm.runInContext(source.slice(0, startup) + `
        globalThis.api = {init, processCurrentState, getPendingQuery, getPendingTask, getState: () => currentState};
    })();`, context);

    const drain = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};
    // Lets the DOM changes of the page wake the machine until nothing is left to do
    const settle = async (rounds = 12) => {for (let i = 0; i < rounds; i++) {wake(); await drain();}};
    return {...context.api, state, editor, fileInput, observers, storage, window, wake, drain, settle,
        async start() {context.api.init(); await drain();},
        async advance(ms) {state.now += ms; context.api.processCurrentState(); await drain();},
        // The text needs a moment to be taken over by the page before a message with an image is sent
        async ready() {await this.advance(600); await settle();},
    };
}


test('gemini: temporary chat, then the upload menu creates the input, the image is attached, the question is sent once', async () => {
    const h = harness({task: makeTask({question: 'what is this?'})});
    await h.start();
    await h.settle();
    await h.ready();

    assert.equal(h.state.privateClicks, 1);
    assert.equal(h.state.changes, 1);
    assert.equal(h.fileInput.files.length, 1);
    assert.equal(h.fileInput.files[0].name, 'selection-search-capture.png');
    assert.equal(h.fileInput.files[0].type, 'image/png');
    assert.equal(h.state.sends, 1);
    assert.equal(h.state.sentText, 'what is this?');
    assert.equal(h.state.sentWithImages, 1);
    assert.equal(h.getState(), 'COMPLETED');
    // The menu opened for the input is closed again
    assert.equal(h.state.menuOpen, false);
    assert.equal(h.state.triggerClicks, 2);
    assert.deepEqual(h.state.finished, [TASK_ID]);
    assert.equal(h.getPendingTask(), null);
    assert.equal(h.observers.size, 0);
    assert.equal(h.window.location.href, 'https://gemini.google.com/app');
    assert.equal(h.state.toasts.at(-1), 'ai_chat_sent');

    for (let i = 0; i < 5; i++) h.wake();
    await h.drain();
    assert.equal(h.state.sends, 1);
});

test('the image is attached only after the private chat is confirmed', async () => {
    const h = harness({missingPrivate: true});
    await h.start();
    await h.settle();
    await h.advance(20001);
    assert.equal(h.getState(), 'FAILED');
    assert.equal(h.state.triggerClicks, 0);
    assert.equal(h.state.changes, 0);
    assert.equal(h.state.sends, 0);
    // The task is kept so the page can try again when it is reloaded
    assert.equal(h.getPendingTask(), TASK_ID);
    assert.deepEqual(h.state.finished, []);
});

test('claude: the file input that lists only image extensions is used without opening a menu', async () => {
    const h = harness({
        url: `https://claude.ai/new?ss_task=${TASK_ID}&incognito=true`,
        task: makeTask({question: 'read this'}), active: true, hasInput: true, inputAccept: CLAUDE_ACCEPT,
    });
    await h.start();
    await h.settle();
    await h.ready();

    assert.equal(h.state.triggerClicks, 0);
    assert.equal(h.state.changes, 1);
    assert.equal(h.fileInput.files.length, 1);
    assert.equal(h.state.sends, 1);
    assert.equal(h.state.sentText, 'read this');
    assert.equal(h.state.replaced, null);
    assert.equal(h.window.location.href, 'https://claude.ai/new?incognito=true');
    assert.deepEqual(h.state.finished, [TASK_ID]);
});

test('without a question only the image is attached and the editor gets the focus', async () => {
    const h = harness();
    await h.start();
    await h.settle();

    assert.equal(h.state.changes, 1);
    assert.equal(h.state.sends, 0);
    assert.equal(h.editor.textContent, '');
    assert.equal(h.state.focused, true);
    assert.equal(h.getState(), 'COMPLETED');
    assert.equal(h.state.toasts.at(-1), 'ai_chat_image_attached');
    assert.deepEqual(h.state.finished, [TASK_ID]);
});

test('with automatic sending turned off the question is typed but not sent', async () => {
    const h = harness({options: {ai_chat_autosend: false}, task: makeTask({question: 'later'})});
    await h.start();
    await h.settle();

    assert.equal(h.state.changes, 1);
    assert.equal(h.editor.textContent, 'later');
    assert.equal(h.state.sends, 0);
    assert.equal(h.getState(), 'COMPLETED');
    assert.equal(h.state.toasts.at(-1), 'ai_chat_image_question_ready');
});

test('turning off automatic sending does not stop the queries in the url from being ignored', async () => {
    const h = harness({url: 'https://gemini.google.com/app?q=hello', options: {ai_chat_autosend: false}});
    await h.start();
    await h.settle();
    assert.equal(h.state.sends, 0);
    assert.equal(h.state.changes, 0);
    assert.equal(h.getPendingQuery(), null);
    assert.equal(h.window.location.href, 'https://gemini.google.com/app?q=hello');
});

test('an attach button that is not usable yet is waited for and then clicked once', async () => {
    const h = harness({triggerDisabled: true, task: makeTask({question: 'hi'})});
    await h.start();
    await h.settle();
    // The page is still starting up: nothing is clicked, pasted or dropped yet
    assert.equal(h.state.triggerClicks, 0);
    assert.equal(h.state.pasted, 0);
    assert.equal(h.state.changes, 0);

    h.state.triggerDisabled = false;
    await h.settle();
    await h.ready();
    assert.equal(h.state.changes, 1);
    assert.equal(h.state.pasted, 0);
    assert.equal(h.state.dropped, 0);
    assert.equal(h.state.sends, 1);
    // One click to open the menu and one to close it again
    assert.equal(h.state.triggerClicks, 2);
});

test('a click on the attach button that the page ignores is repeated until the menu opens', async () => {
    const h = harness({ignoreClicks: 1, task: makeTask({question: 'hi'})});
    await h.start();
    await h.settle();
    assert.equal(h.state.triggerClicks, 1);
    assert.equal(h.state.menuOpen, false);
    assert.equal(h.state.changes, 0);

    await h.advance(1201);
    await h.settle();
    await h.ready();
    assert.equal(h.state.changes, 1);
    assert.equal(h.state.pasted, 0);
    assert.equal(h.state.sends, 1);
    // The ignored click, the click that opened the menu and the click that closed it
    assert.equal(h.state.triggerClicks, 3);
});

test('the attach button is clicked at most three times before the image is pasted instead', async () => {
    const h = harness({ignoreClicks: 99, works: {input: false, paste: true, drop: false}, task: makeTask({question: 'hi'})});
    await h.start();
    await h.settle();
    for (let i = 0; i < 4; i++) {
        await h.advance(1201);
        await h.settle();
    }
    await h.ready();
    assert.equal(h.state.triggerClicks, 3);
    assert.equal(h.state.pasted, 1);
    assert.equal(h.state.sends, 1);
});

test('when there is no input and no menu the image is pasted after waiting for the menu', async () => {
    const h = harness({hasTrigger: false, works: {input: false, paste: true, drop: false}, task: makeTask({question: 'hi'})});
    await h.start();
    await h.settle();
    assert.equal(h.state.pasted, 0);

    await h.advance(6001);
    await h.settle();
    await h.ready();
    assert.equal(h.state.pasted, 1);
    assert.equal(h.state.filesSeen.length, 1);
    assert.equal(h.state.dropped, 0);
    assert.equal(h.state.sends, 1);
});

test('a way that shows no result is followed by the next one', async () => {
    const h = harness({hasTrigger: false, works: {input: false, paste: false, drop: true}, task: makeTask({question: 'hi'})});
    await h.start();
    await h.settle();
    // Gives up on the menu first
    await h.advance(6001);
    await h.settle();
    assert.equal(h.state.pasted, 1);
    assert.equal(h.state.dropped, 0);
    assert.equal(h.state.sends, 0);

    await h.advance(6001);
    await h.settle();
    await h.ready();
    assert.equal(h.state.dropped, 1);
    assert.equal(h.state.sends, 1);
    // The paste that showed no result did not leave a second attachment behind
    assert.equal(h.state.chips, 1);
    assert.equal(h.state.sentWithImages, 1);
});

test('when nothing works the image goes to the clipboard and nothing is sent', async () => {
    const h = harness({hasTrigger: false, works: {input: false, paste: false, drop: false}, task: makeTask({question: 'hi'})});
    await h.start();
    await h.settle();
    await h.advance(6001);
    await h.settle();
    await h.advance(6001);
    await h.settle();
    await h.advance(6001);
    await h.settle();

    assert.equal(h.getState(), 'FAILED');
    assert.equal(h.state.sends, 0);
    assert.equal(h.state.pasted, 1);
    assert.equal(h.state.dropped, 1);
    assert.ok(h.state.clipboardItems, 'the image was not copied');
    assert.equal(h.state.clipboardItems[0].items['image/png'].name, 'selection-search-capture.png');
    assert.equal(h.state.toasts.at(-1), 'ai_chat_attach_failed:Gemini capture_copied_hint');
    assert.equal(h.getPendingTask(), TASK_ID);
    assert.equal(h.observers.size, 0);
});

test('a clipboard that can not be written only reports the failure', async () => {
    const h = harness({hasTrigger: false, clipboard: false, works: {input: false, paste: false, drop: false}});
    await h.start();
    for (let i = 0; i < 4; i++) {
        await h.settle();
        await h.advance(6001);
    }
    await h.settle();
    assert.equal(h.getState(), 'FAILED');
    assert.equal(h.state.toasts.at(-1), 'ai_chat_attach_failed:Gemini');
});

test('the question waits while the image is still uploading', async () => {
    const h = harness({task: makeTask({question: 'hi'})});
    h.state.uploading = true;
    await h.start();
    await h.settle();
    await h.ready();

    assert.equal(h.state.changes, 1);
    assert.equal(h.editor.textContent, 'hi');
    assert.equal(h.state.sends, 0);

    h.state.uploading = false;
    await h.settle();
    assert.equal(h.state.sends, 1);
});

test('an upload indicator that never goes away does not hold the message back for ever', async () => {
    const h = harness({task: makeTask({question: 'hi'})});
    h.state.uploading = true;
    await h.start();
    await h.settle();
    await h.ready();
    assert.equal(h.state.sends, 0);

    await h.advance(15000);
    await h.settle();
    assert.equal(h.state.sends, 1);
    assert.equal(h.state.sentText, 'hi');
});

test('the message waits until the page has taken over the typed text', async () => {
    // The send button is already enabled by the image, but the editor of the page still counts as blank
    const h = harness({modelDelay: 1000, task: makeTask({question: 'hi'})});
    await h.start();
    await h.settle();
    await h.ready();
    assert.equal(h.editor.textContent, 'hi');
    assert.equal(h.state.sends, 0);
    assert.equal(h.state.sendClicks, 0);

    await h.advance(500);
    await h.settle();
    assert.equal(h.state.sends, 1);
    assert.equal(h.state.sentText, 'hi');
    assert.equal(h.state.sendClicks, 1);
});

test('the message needs a moment even when the page takes over the text at once', async () => {
    const h = harness({task: makeTask({question: 'hi'})});
    await h.start();
    await h.settle();
    assert.equal(h.editor.textContent, 'hi');
    assert.equal(h.state.sendClicks, 0);
    await h.ready();
    assert.equal(h.state.sends, 1);
});

test('gemini waits for the preview of the image before it sends', async () => {
    // The image counts as attached at once, its preview is rendered 1.5 seconds later
    const h = harness({chipDelay: 1500, task: makeTask({question: 'hi'})});
    await h.start();
    await h.settle();
    await h.ready();
    assert.equal(h.state.chips, 1);
    assert.equal(h.state.sends, 0);
    assert.equal(h.state.sendClicks, 0);

    await h.advance(1000);
    await h.settle();
    assert.equal(h.state.sends, 1);
    assert.equal(h.state.sentWithImages, 1);
});

test('claude does not need the preview element of the image to send', async () => {
    const h = harness({
        url: `https://claude.ai/new?ss_task=${TASK_ID}&incognito=true`, chipDelay: 60000,
        task: makeTask({question: 'read this'}), active: true, hasInput: true, inputAccept: CLAUDE_ACCEPT,
    });
    await h.start();
    await h.settle();
    await h.ready();
    assert.equal(h.state.sends, 1);
    assert.equal(h.state.sentText, 'read this');
});

test('text that the page dropped before the message was sent is typed again', async () => {
    const h = harness({task: makeTask({question: 'hi'})});
    await h.start();
    await h.settle();
    assert.equal(h.editor.textContent, 'hi');

    // The page rebuilt its editor once the image was processed
    h.editor.textContent = '';
    await h.settle();
    assert.equal(h.editor.textContent, 'hi');
    assert.equal(h.state.sends, 0);

    await h.ready();
    assert.equal(h.state.sends, 1);
    assert.equal(h.state.sentText, 'hi');
});

test('text that the page keeps dropping is typed again only three times', async () => {
    const h = harness({task: makeTask({question: 'hi'})});
    await h.start();
    await h.settle();
    for (let i = 0; i < 4; i++) {
        h.editor.textContent = '';
        await h.settle();
    }
    assert.equal(h.editor.textContent, '');
    assert.equal(h.state.sends, 0);

    await h.advance(30001);
    assert.equal(h.getState(), 'FAILED');
    assert.equal(h.state.toasts.at(-1), 'ai_chat_no_send_button');
});

test('a send click that the page ignored is repeated once, and only if the text is still there', async () => {
    const h = harness({ignoreSends: 1, task: makeTask({question: 'hi'})});
    await h.start();
    await h.settle();
    await h.ready();
    assert.equal(h.state.sendClicks, 1);
    assert.equal(h.state.sends, 0);

    // Not repeated right away: the page may just be slow
    await h.advance(1000);
    await h.settle();
    assert.equal(h.state.sendClicks, 1);

    await h.advance(2100);
    await h.settle();
    assert.equal(h.state.sendClicks, 2);
    assert.equal(h.state.sends, 1);
    assert.equal(h.getState(), 'COMPLETED');

    // A message that was sent is never sent again
    await h.advance(5000);
    await h.settle();
    assert.equal(h.state.sendClicks, 2);
    assert.equal(h.state.sends, 1);
});

test('an ignored send click is repeated at most three times', async () => {
    const h = harness({ignoreSends: 99, task: makeTask({question: 'hi'})});
    await h.start();
    await h.settle();
    await h.ready();
    for (let i = 0; i < 4; i++) {
        await h.advance(3100);
        await h.settle();
    }
    assert.equal(h.state.sendClicks, 3);
    assert.equal(h.state.sends, 0);

    await h.advance(30001);
    assert.equal(h.getState(), 'FAILED');
    assert.equal(h.state.toasts.at(-1), 'ai_chat_send_unconfirmed');
    assert.equal(h.state.sendClicks, 3);
});

test('an expired task shows a message and does not start anything', async () => {
    const h = harness({task: null});
    await h.start();
    assert.equal(h.getState(), 'INITIAL');
    assert.equal(h.getPendingTask(), null);
    assert.equal(h.observers.size, 0);
    assert.equal(h.state.toasts.at(-1), 'ai_chat_task_expired');
    assert.equal(h.window.location.href, 'https://gemini.google.com/app');
});

test('a task id that is not an id is ignored', async () => {
    const h = harness({url: 'https://gemini.google.com/app?ss_task=../../evil'});
    await h.start();
    assert.equal(h.getPendingTask(), null);
    assert.equal(h.state.toasts.length, 0);
});

test('claude ignores tasks outside the new chat page', async () => {
    const h = harness({url: `https://claude.ai/recents?ss_task=${TASK_ID}`, hasInput: true, inputAccept: CLAUDE_ACCEPT, active: true});
    await h.start();
    await h.settle();
    assert.equal(h.getPendingTask(), null);
    assert.equal(h.state.changes, 0);
});

test('a task that survives a reload goes on from the session storage', async () => {
    const h = harness({
        url: 'https://claude.ai/new?incognito=true', storage: {[TASK_KEY]: TASK_ID},
        task: makeTask({question: 'again'}), active: true, hasInput: true, inputAccept: CLAUDE_ACCEPT,
    });
    await h.start();
    await h.settle();
    await h.ready();
    assert.equal(h.state.changes, 1);
    assert.equal(h.state.sends, 1);
    assert.deepEqual(h.state.finished, [TASK_ID]);
});

test('claude reopens the page in incognito mode once before attaching', async () => {
    const h = harness({
        url: `https://claude.ai/new?ss_task=${TASK_ID}`,
        task: makeTask({question: 'x'}), hasInput: true, inputAccept: CLAUDE_ACCEPT,
    });
    await h.start();
    assert.equal(h.state.replaced, 'https://claude.ai/new?incognito=true');
    assert.equal(h.getPendingTask(), TASK_ID);
    assert.equal(h.state.changes, 0);
    assert.equal(h.state.sends, 0);
});
