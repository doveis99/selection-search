// Tests for background/capture.js. Run with: node --test "tests/*.test.js"

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'background', 'capture.js'), 'utf8');

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

// A tiny stand-in for the image apis of the service worker. Blobs of the type
// image/svg+xml can't be decoded, like in a real service worker.
class FakeCanvas {
    constructor(width, height) {this.width = width; this.height = height;}
    getContext() {return {drawImage() {}, fillRect() {}};}
    async convertToBlob({type}) {return new Blob(['canvas'], {type});}
}

function harness({options = {}, sessionFails = false} = {}) {
    const session = new Map();
    const state = {
        notifications: [], injected: [], created: [], updated: [], fetched: [], now: 1000000, sessionFails, executeFails: false,
        // Answers of fetch() for urls that are not data urls
        remote: {}, captureFails: false, clipboardFails: false,
    };
    const sessionStorage = {
        async get(keys) {
            const result = {};
            for (const key of [].concat(keys)) if (session.has(key)) result[key] = structuredClone(session.get(key));
            return result;
        },
        async set(values) {
            if (state.sessionFails) throw new Error('QUOTA_BYTES quota exceeded');
            for (const [key, value] of Object.entries(values)) session.set(key, structuredClone(value));
        },
        async remove(keys) {
            for (const key of [].concat(keys)) session.delete(key);
        },
    };
    const context = vm.createContext({
        console: {log() {}, warn() {}},
        URL, btoa, Blob, structuredClone, Promise, Uint8Array, Object, Math, Array,
        AbortController, setTimeout, clearTimeout, OffscreenCanvas: FakeCanvas,
        async fetch(url, init) {
            state.fetched.push({url, init});
            if (url.startsWith('data:')) return {ok: true, blob: async () => new Blob(['screenshot'], {type: 'image/png'})};
            const answer = state.remote[url];
            if (!answer) throw new TypeError('Failed to fetch');
            return {ok: answer.ok !== false, blob: async () => new Blob([answer.body], {type: answer.type})};
        },
        async createImageBitmap(blob) {
            if (blob.type === 'image/svg+xml') throw new Error('The source image could not be decoded.');
            return {width: 200, height: 100, close() {}};
        },
        Date: class extends Date {static now() {return state.now;}},
        crypto: {randomUUID: () => ID_A},
        i18n: key => key,
        BrowserSupport: {hasLastError: () => false},
        Storage: {getOptions: () => ({capture_question: '', ai_chat_claude_incognito: true, ...options})},
        chrome: {
            runtime: {lastError: undefined},
            storage: {session: sessionStorage, local: {get(key, callback) {callback({});}, set() {}}},
            notifications: {create: details => state.notifications.push(details)},
            scripting: {
                async executeScript(details) {
                    if (state.executeFails) throw new Error('Cannot access a chrome:// URL');
                    state.injected.push(details);
                    if (details.func) return [{frameId: 0, result: !state.clipboardFails}];
                },
            },
            tabs: {
                async captureVisibleTab() {
                    if (state.captureFails) throw new Error('Cannot capture');
                    return 'data:image/png;base64,AAAA';
                },
                async create(properties) {
                    state.created.push(properties);
                    return {id: 40 + state.created.length, ...properties};
                },
                async update(id, properties) {
                    state.updated.push({id, ...properties});
                    return {id, ...properties};
                },
                get(id, callback) {callback({id, url: 'https://example.com/'});},
            },
        },
    });
    vm.runInContext(source, context);
    const api = vm.runInContext(`({
        getCropArea, sanitizeCaptureRect, isCapturableUrl, buildTargetUrl, blobToDataUrl, startCapture,
        saveCaptureTask, getCaptureTask, deleteCaptureTask, purgeCaptureTasks, getCaptureTaskForSender,
        finishCaptureTask, openCaptureTarget, getLensTask, CAPTURE_TASK_TTL,
        isImageSourceUrl, loadSourceImage, startImageCapture, processCaptureSubmit, processCaptureCopy
    })`, context);
    return {...api, state, session};
}

function respond() {
    const box = {value: undefined, called: 0};
    const fn = value => {box.value = value; box.called++;};
    return Object.assign(fn, {box});
}

const task = (id, target = 'gemini', created = 1000000) => ({
    id, target, created, question: 'q', imageDataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png', filename: 'a.png', size: 3,
});


test('the crop area follows the device pixel ratio of the screenshot', () => {
    const h = harness();
    const area = h.getCropArea({x: 100, y: 50, width: 200, height: 100}, {width: 1000, height: 600}, {width: 1500, height: 900});
    assert.deepEqual({...area}, {x: 150, y: 75, width: 300, height: 150});
});

test('the crop area rounds outwards and stays inside the screenshot', () => {
    const h = harness();
    const area = h.getCropArea({x: 333.3, y: 10.2, width: 700, height: 20}, {width: 1000, height: 600}, {width: 1250, height: 750});
    assert.equal(area.x, Math.floor(333.3 * 1.25));
    assert.equal(area.x + area.width, 1250);
    assert.equal(area.y, Math.floor(10.2 * 1.25));
    assert.equal(area.y + area.height, Math.ceil(30.2 * 1.25));
});

test('an area outside the viewport is clamped and a tiny or invalid one is rejected', () => {
    const h = harness();
    const viewport = {width: 800, height: 600};
    assert.deepEqual({...h.sanitizeCaptureRect({x: -20, y: -5, width: 100, height: 100}, viewport)}, {x: 0, y: 0, width: 80, height: 95});
    assert.deepEqual({...h.sanitizeCaptureRect({x: 700, y: 500, width: 500, height: 500}, viewport)}, {x: 700, y: 500, width: 100, height: 100});
    assert.equal(h.sanitizeCaptureRect({x: 10, y: 10, width: 7, height: 100}, viewport), null);
    assert.equal(h.sanitizeCaptureRect({x: 10, y: 10, width: NaN, height: 100}, viewport), null);
    assert.equal(h.sanitizeCaptureRect({x: 10, y: 10, width: 50, height: 50}, {width: 0, height: 600}), null);
    assert.equal(h.sanitizeCaptureRect(null, viewport), null);
    assert.equal(h.sanitizeCaptureRect({x: 900, y: 10, width: 50, height: 50}, viewport), null);
});

test('only pages an extension can inject into are capturable', () => {
    const h = harness();
    assert.equal(h.isCapturableUrl('https://example.com/'), true);
    assert.equal(h.isCapturableUrl('http://localhost:3000/'), true);
    assert.equal(h.isCapturableUrl('file:///C:/a.html'), true);
    assert.equal(h.isCapturableUrl(undefined), true);
    assert.equal(h.isCapturableUrl('chrome://extensions/'), false);
    assert.equal(h.isCapturableUrl('chrome-extension://abc/page.html'), false);
    assert.equal(h.isCapturableUrl('about:blank'), false);
});

test('starting on an unavailable page shows a notification instead of injecting', async () => {
    const h = harness();
    await h.startCapture({id: 5, url: 'chrome://extensions/'});
    assert.equal(h.state.injected.length, 0);
    assert.equal(h.state.notifications.length, 1);
    assert.equal(h.state.notifications[0].message, 'capture_error_unavailable');

    await h.startCapture({id: 6, url: 'https://example.com/'});
    assert.deepEqual(h.state.injected.map(details => details.target.tabId), [6]);
    assert.deepEqual([...h.state.injected[0].files], ['capture/overlay.js']);

    h.state.executeFails = true;
    await h.startCapture({id: 7, url: 'https://example.com/'});
    assert.equal(h.state.notifications.length, 2);
});

test('target urls carry the task id and open claude in incognito mode when it is required', () => {
    const h = harness();
    assert.equal(h.buildTargetUrl(task(ID_A, 'lens'), {}), 'https://lens.google.com/');
    assert.equal(h.buildTargetUrl(task(ID_A, 'gemini'), {}), `https://gemini.google.com/app?ss_task=${ID_A}`);
    assert.equal(h.buildTargetUrl(task(ID_A, 'claude'), {ai_chat_claude_incognito: false}), `https://claude.ai/new?ss_task=${ID_A}`);
    assert.equal(h.buildTargetUrl(task(ID_A, 'claude'), {ai_chat_claude_incognito: true}), `https://claude.ai/new?ss_task=${ID_A}&incognito=true`);
});

test('blobs become data urls', async () => {
    const h = harness();
    const url = await h.blobToDataUrl(new Blob([new Uint8Array([1, 2, 3, 250])], {type: 'image/png'}));
    assert.equal(url, 'data:image/png;base64,' + Buffer.from([1, 2, 3, 250]).toString('base64'));

    // Bigger than one chunk of the conversion
    const big = new Uint8Array(100000).map((_, i) => i % 251);
    const bigUrl = await h.blobToDataUrl(new Blob([big], {type: 'image/jpeg'}));
    assert.equal(Buffer.from(bigUrl.split(',')[1], 'base64').equals(Buffer.from(big)), true);
});

test('tasks are stored, read and deleted', async () => {
    const h = harness();
    await h.saveCaptureTask(task(ID_A));
    assert.equal((await h.getCaptureTask(ID_A)).question, 'q');
    assert.equal(await h.getCaptureTask(ID_B), null);
    await h.deleteCaptureTask(ID_A);
    assert.equal(await h.getCaptureTask(ID_A), null);
    assert.equal(h.session.has('capture_task_' + ID_A), false);
    assert.deepEqual({...h.session.get('capture_task_index')}, {});
});

test('ids that are not uuids never reach the storage', async () => {
    const h = harness();
    assert.equal(await h.getCaptureTask('capture_task_index'), null);
    assert.equal(await h.getCaptureTask(undefined), null);
    assert.equal(await h.getCaptureTask({}), null);
});

test('tasks nobody took are removed when the next one is saved', async () => {
    const h = harness();
    await h.saveCaptureTask(task(ID_A, 'gemini', h.state.now));
    h.state.now += h.CAPTURE_TASK_TTL + 1;
    await h.saveCaptureTask(task(ID_B, 'claude', h.state.now));
    assert.equal(await h.getCaptureTask(ID_A), null);
    assert.notEqual(await h.getCaptureTask(ID_B), null);
});

test('a task that is too old is not handed out even if it was not removed yet', async () => {
    const h = harness();
    await h.saveCaptureTask(task(ID_A, 'gemini', h.state.now));
    assert.notEqual(await h.getCaptureTask(ID_A), null);
    h.state.now += h.CAPTURE_TASK_TTL + 1;
    assert.equal(await h.getCaptureTask(ID_A), null);
});

test('a full session storage falls back to memory', async () => {
    const h = harness({sessionFails: true});
    await h.saveCaptureTask(task(ID_A));
    assert.equal((await h.getCaptureTask(ID_A)).id, ID_A);
    await h.deleteCaptureTask(ID_A);
    assert.equal(await h.getCaptureTask(ID_A), null);
});

test('only the page of the target gets the image', async () => {
    const h = harness();
    await h.saveCaptureTask(task(ID_A, 'gemini'));

    const ok = respond();
    await h.getCaptureTaskForSender({taskId: ID_A}, {url: 'https://gemini.google.com/app?x=1'}, ok);
    assert.equal(ok.box.value.task.id, ID_A);

    const wrongHost = respond();
    await h.getCaptureTaskForSender({taskId: ID_A}, {url: 'https://claude.ai/new'}, wrongHost);
    assert.equal(wrongHost.box.value.task, null);

    const noUrl = respond();
    await h.getCaptureTaskForSender({taskId: ID_A}, {}, noUrl);
    assert.equal(noUrl.box.value.task, null);

    const lookalike = respond();
    await h.getCaptureTaskForSender({taskId: ID_A}, {url: 'https://gemini.google.com.evil.example/'}, lookalike);
    assert.equal(lookalike.box.value.task, null);
});

test('finishing a task removes the image', async () => {
    const h = harness();
    await h.saveCaptureTask(task(ID_A));
    const response = respond();
    await h.finishCaptureTask({taskId: ID_A}, {}, response);
    assert.equal(response.box.called, 1);
    assert.equal(await h.getCaptureTask(ID_A), null);
});

// Searches open in the current tab unless new tabs are enabled
const NEW_TAB = {newtab: true, background_tab: false};

test('the lens page finds its image by the id of its tab', async () => {
    const h = harness({options: NEW_TAB});
    await h.saveCaptureTask(task(ID_A, 'lens'));
    await h.openCaptureTarget(task(ID_A, 'lens'), {id: 3, index: 4});

    assert.deepEqual({...h.state.created[0]}, {url: 'https://lens.google.com/', active: true, openerTabId: 3, index: 5});

    const own = respond();
    await h.getLensTask({tab: {id: 41}}, own);
    assert.equal(own.box.value.task.id, ID_A);

    const other = respond();
    await h.getLensTask({tab: {id: 99}}, other);
    assert.equal(other.box.value.task, null);

    const noTab = respond();
    await h.getLensTask({}, noTab);
    assert.equal(noTab.box.value.task, null);
});

test('the lens image is found even when it only exists in memory', async () => {
    const h = harness({options: NEW_TAB, sessionFails: true});
    await h.saveCaptureTask(task(ID_A, 'lens'));
    await h.openCaptureTarget(task(ID_A, 'lens'), {id: 3, index: 0});
    const own = respond();
    await h.getLensTask({tab: {id: 41}}, own);
    assert.equal(own.box.value.task.id, ID_A);
});

test('gemini and claude tabs open next to the opener and are not registered as lens tabs', async () => {
    const h = harness({options: NEW_TAB});
    await h.saveCaptureTask(task(ID_A, 'gemini'));
    await h.openCaptureTarget(task(ID_A, 'gemini'), {id: 8, index: 2});
    assert.equal(h.state.created[0].url, `https://gemini.google.com/app?ss_task=${ID_A}`);
    assert.equal(h.state.created[0].index, 3);
    const lens = respond();
    await h.getLensTask({tab: {id: 41}}, lens);
    assert.equal(lens.box.value.task, null);
});

test('the target opens in the current tab when new tabs are disabled', async () => {
    const h = harness({options: {newtab: false}});
    await h.saveCaptureTask(task(ID_A, 'gemini'));
    await h.openCaptureTarget(task(ID_A, 'gemini'), {id: 8, index: 2});
    assert.equal(h.state.created.length, 0);
    assert.deepEqual({...h.state.updated[0]}, {id: 8, url: `https://gemini.google.com/app?ss_task=${ID_A}`});
});

test('a new target tab follows the background and tab position options', async () => {
    const h = harness({options: {newtab: true, background_tab: true, open_new_tab_last: true}});
    await h.openCaptureTarget(task(ID_A, 'claude'), {id: 8, index: 2});
    assert.equal(h.state.updated.length, 0);
    assert.equal(h.state.created[0].active, false);
    assert.equal(h.state.created[0].openerTabId, 8);
    assert.equal('index' in h.state.created[0], false);
});

test('a lens search in the current tab takes the newest task of the tab', async () => {
    const h = harness({options: {newtab: false}});
    await h.saveCaptureTask(task(ID_A, 'lens', 1000000));
    await h.openCaptureTarget(task(ID_A, 'lens'), {id: 3, index: 0});
    // The first search failed and the tab is used again
    h.state.now += 1000;
    await h.saveCaptureTask(task(ID_B, 'lens', h.state.now));
    await h.openCaptureTarget(task(ID_B, 'lens'), {id: 3, index: 0});

    assert.equal(h.state.created.length, 0);
    assert.deepEqual(h.state.updated.map(details => details.id), [3, 3]);
    const own = respond();
    await h.getLensTask({tab: {id: 3}}, own);
    assert.equal(own.box.value.task.id, ID_B);
});


// The image of the stored task as text, the fakes put their name into it
function storedImage(h) {
    const key = [...h.session.keys()].find(name => name.startsWith('capture_task_') && name !== 'capture_task_index');
    const stored = h.session.get(key);
    return {task: stored, content: Buffer.from(stored.imageDataUrl.split(',')[1], 'base64').toString()};
}

const submitRequest = fields => ({
    action: 'captureSubmit', target: 'gemini', question: '',
    rect: {x: 10, y: 10, width: 100, height: 50}, viewport: {width: 800, height: 600},
    imageUrl: '', imageData: '', ...fields,
});
const sender = {tab: {id: 3, index: 0, windowId: 1}};

test('only http and image data urls are loaded by the background script', () => {
    const h = harness();
    assert.equal(h.isImageSourceUrl('https://cdn.example/a.jpg'), true);
    assert.equal(h.isImageSourceUrl('http://example/a.png'), true);
    assert.equal(h.isImageSourceUrl('data:image/webp;base64,AAAA'), true);
    assert.equal(h.isImageSourceUrl('data:text/html;base64,AAAA'), false);
    assert.equal(h.isImageSourceUrl('blob:https://example/1234'), false);
    assert.equal(h.isImageSourceUrl('file:///C:/a.png'), false);
    assert.equal(h.isImageSourceUrl('javascript:alert(1)'), false);
    assert.equal(h.isImageSourceUrl(undefined), false);
});

test('"search this image" starts the overlay with the image selected', async () => {
    const h = harness();
    await h.startImageCapture({srcUrl: 'https://cdn.example/a.jpg'}, {id: 6, url: 'https://example.com/'});
    assert.equal(h.state.injected.length, 2);
    assert.deepEqual([...h.state.injected[0].files], ['capture/overlay.js']);
    assert.deepEqual([...h.state.injected[1].args], ['https://cdn.example/a.jpg']);
    assert.equal(h.state.injected[1].target.tabId, 6);

    // An image the background script can't use still gets the overlay, without a selection
    await h.startImageCapture({srcUrl: 'blob:https://example.com/1'}, {id: 7, url: 'https://example.com/'});
    assert.equal(h.state.injected.length, 3);
    assert.deepEqual([...h.state.injected[2].files], ['capture/overlay.js']);
});

test('the original image is used instead of the screenshot when it can be loaded', async () => {
    const h = harness();
    h.state.remote['https://cdn.example/a.jpg'] = {body: 'original', type: 'image/jpeg'};
    await h.processCaptureSubmit(submitRequest({imageUrl: 'https://cdn.example/a.jpg'}), sender);
    const {task: stored, content} = storedImage(h);
    assert.equal(content, 'original');
    assert.equal(stored.mimeType, 'image/jpeg');
    assert.equal(stored.filename, 'selection-search-capture.jpg');
    const remote = h.state.fetched.find(request => request.url === 'https://cdn.example/a.jpg');
    assert.equal(remote.init.credentials, 'omit');
});

test('images in other formats are converted to png', async () => {
    const h = harness();
    h.state.remote['https://cdn.example/a.webp'] = {body: 'webp', type: 'image/webp'};
    await h.processCaptureSubmit(submitRequest({imageUrl: 'https://cdn.example/a.webp'}), sender);
    const {task: stored, content} = storedImage(h);
    assert.equal(content, 'canvas');
    assert.equal(stored.mimeType, 'image/png');
});

test('the image read by the page is preferred over its url', async () => {
    const h = harness();
    await h.processCaptureSubmit(submitRequest({imageUrl: 'https://cdn.example/a.jpg', imageData: 'data:image/png;base64,AAAA'}), sender);
    assert.equal(h.state.fetched.some(request => request.url === 'https://cdn.example/a.jpg'), false);
    assert.equal(storedImage(h).content, 'screenshot');
});

test('the screenshot is used when the original image can not be loaded or decoded', async () => {
    for (const remote of [undefined, {ok: false, body: 'x', type: 'image/png'}, {body: '<svg/>', type: 'image/svg+xml'}]) {
        const h = harness();
        if (remote) h.state.remote['https://cdn.example/a'] = remote;
        await h.processCaptureSubmit(submitRequest({imageUrl: 'https://cdn.example/a'}), sender);
        const {task: stored, content} = storedImage(h);
        // The crop of the screenshot
        assert.equal(content, 'canvas');
        assert.equal(stored.mimeType, 'image/png');
    }
});

test('an image without an area needs the original image', async () => {
    const h = harness();
    h.state.remote['https://frame.example/a.png'] = {body: 'original', type: 'image/png'};
    await h.processCaptureSubmit(submitRequest({rect: null, imageUrl: 'https://frame.example/a.png'}), sender);
    assert.equal(storedImage(h).content, 'original');

    const failing = harness();
    await assert.rejects(failing.processCaptureSubmit(submitRequest({rect: null, imageUrl: 'https://frame.example/b.png'}), sender),
        err => err.captureMessage === 'capture_error_image');
    assert.equal(failing.state.created.length, 0);
    assert.equal(failing.state.updated.length, 0);
});

test('a missing or tiny area without an image is rejected', async () => {
    const h = harness();
    await assert.rejects(h.processCaptureSubmit(submitRequest({rect: null}), sender), err => err.captureMessage === 'capture_error_failed');
    await assert.rejects(h.processCaptureSubmit(submitRequest({rect: {x: 0, y: 0, width: 3, height: 3}}), sender),
        err => err.captureMessage === 'capture_error_too_small');
    // A url the background script must not load is ignored
    await assert.rejects(h.processCaptureSubmit(submitRequest({rect: null, imageUrl: 'file:///C:/a.png'}), sender),
        err => err.captureMessage === 'capture_error_failed');
});

test('a failing screenshot does not matter when the original image loads', async () => {
    const h = harness();
    h.state.captureFails = true;
    h.state.remote['https://cdn.example/a.png'] = {body: 'original', type: 'image/png'};
    await h.processCaptureSubmit(submitRequest({imageUrl: 'https://cdn.example/a.png'}), sender);
    assert.equal(storedImage(h).content, 'original');

    const areaOnly = harness();
    areaOnly.state.captureFails = true;
    await assert.rejects(areaOnly.processCaptureSubmit(submitRequest({}), sender), err => err.captureMessage === 'capture_error_unavailable');
});


test('the copy button copies the image to the clipboard of the page and does not search', async () => {
    const h = harness();
    h.state.remote['https://cdn.example/a.webp'] = {body: 'webp', type: 'image/webp'};
    await h.processCaptureCopy(submitRequest({target: 'clipboard', imageUrl: 'https://cdn.example/a.webp'}), {...sender, frameId: 0});
    const copy = h.state.injected.find(details => details.func);
    assert.equal(copy.func.name, 'writeImageToClipboard');
    assert.equal(copy.target.tabId, 3);
    assert.deepEqual([...copy.target.frameIds], [0]);
    // Always png, the clipboard takes no other images
    assert.match(copy.args[0], /^data:image\/png;base64,/);
    assert.equal(h.state.created.length, 0);
    assert.equal(h.state.updated.length, 0);
    assert.equal([...h.session.keys()].some(key => key.startsWith('capture_task_') && key !== 'capture_task_index'), false);
});

test('a failing copy is reported and a search does not touch the clipboard', async () => {
    for (const field of ['clipboardFails', 'executeFails']) {
        const h = harness();
        h.state[field] = true;
        await assert.rejects(h.processCaptureCopy(submitRequest({target: 'clipboard'}), sender),
            err => err.captureMessage === 'capture_error_copy');
    }

    const tiny = harness();
    await assert.rejects(tiny.processCaptureCopy(submitRequest({target: 'clipboard', rect: {x: 0, y: 0, width: 3, height: 3}}), sender),
        err => err.captureMessage === 'capture_error_too_small');

    const search = harness();
    await search.processCaptureSubmit(submitRequest({}), sender);
    assert.equal(search.state.injected.length, 0);
    assert.equal(search.state.updated.length, 1);
});
