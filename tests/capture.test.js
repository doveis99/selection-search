// Tests for background/capture.js. Run with: node --test "tests/*.test.js"

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'background', 'capture.js'), 'utf8');

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function harness({options = {}, sessionFails = false} = {}) {
    const session = new Map();
    const state = {notifications: [], injected: [], created: [], now: 1000000, sessionFails, executeFails: false};
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
                },
            },
            tabs: {
                async create(properties) {
                    state.created.push(properties);
                    return {id: 40 + state.created.length, ...properties};
                },
                get(id, callback) {callback({id, url: 'https://example.com/'});},
            },
        },
    });
    vm.runInContext(source, context);
    const api = vm.runInContext(`({
        getCropArea, sanitizeCaptureRect, isCapturableUrl, buildTargetUrl, blobToDataUrl, startCapture,
        saveCaptureTask, getCaptureTask, deleteCaptureTask, purgeCaptureTasks, getCaptureTaskForSender,
        finishCaptureTask, openCaptureTarget, getLensTask, CAPTURE_TASK_TTL
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

test('the lens page finds its image by the id of its tab', async () => {
    const h = harness();
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
    const h = harness({sessionFails: true});
    await h.saveCaptureTask(task(ID_A, 'lens'));
    await h.openCaptureTarget(task(ID_A, 'lens'), {id: 3, index: 0});
    const own = respond();
    await h.getLensTask({tab: {id: 41}}, own);
    assert.equal(own.box.value.task.id, ID_A);
});

test('gemini and claude tabs open next to the opener and are not registered as lens tabs', async () => {
    const h = harness();
    await h.saveCaptureTask(task(ID_A, 'gemini'));
    await h.openCaptureTarget(task(ID_A, 'gemini'), {id: 8, index: 2});
    assert.equal(h.state.created[0].url, `https://gemini.google.com/app?ss_task=${ID_A}`);
    assert.equal(h.state.created[0].index, 3);
    const lens = respond();
    await h.getLensTask({tab: {id: 41}}, lens);
    assert.equal(lens.box.value.task, null);
});
