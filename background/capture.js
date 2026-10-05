
// Search by capturing an area of the page.
//
// The context menu item and the toolbar popup button call startCapture(), which
// injects capture/overlay.js into the active tab. Both are invoked by the user
// and therefore grant the activeTab permission, so no host permissions are
// needed for the injection and the screenshot.
//
// The "search this image" context menu item calls startImageCapture(), which
// starts the same overlay with the image already selected.
//
// The overlay lets the user drag an area or click an element and choose a target,
// hides itself and reports the area with a "captureSubmit" message. The visible
// tab is then captured, cropped and handed to the target. For an image the
// original is used instead of the screenshot when it can be loaded:
//   lens   - capture/lens_upload.js puts the image into the upload box of Google Lens
//   gemini - sites/ai_chat.js attaches the image to the prompt box and sends the
//   claude   question if there is one
// The image is kept in chrome.storage.session under a random task id until the
// target page has taken it.
//
// The copy button of the overlay sends a "captureCopy" message instead, the same
// image is then copied to the clipboard and nothing is searched.

const CAPTURE_TASK_PREFIX = 'capture_task_';
const CAPTURE_INDEX_KEY = 'capture_task_index';
const CAPTURE_LAST_TARGET_KEY = 'capture_last_target';
const CAPTURE_TASK_TTL = 30 * 60 * 1000;
// The session storage is limited to 10 MB and the images are stored as base64
const CAPTURE_MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const CAPTURE_MIN_SIZE = 8;
// Original images that are downloaded and decoded, bigger ones use the screenshot
const CAPTURE_MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const CAPTURE_IMAGE_TIMEOUT = 10000;

const CAPTURE_TARGETS = {
    lens: {label: 'Google Lens', url: 'https://lens.google.com/'},
    gemini: {label: 'Gemini', url: 'https://gemini.google.com/app', host: 'gemini.google.com'},
    claude: {label: 'Claude', url: 'https://claude.ai/new', host: 'claude.ai'},
};

// Used when the session storage is full, lost when the service worker restarts
let _captureMemoryTasks = {};
// Resolves when the Lens tab is registered, so the Lens page never asks too early
let _captureLensPending = null;


function isCapturableUrl(url){
    // An unknown url is tried anyway, the injection reports the real error
    if(!url)
        return true;
    return /^(https?|file|ftp):/i.test(url);
}

function captureError(messageKey){
    var err = new Error(messageKey);
    err.captureMessage = messageKey;
    return err;
}

function showCaptureError(messageKey){
    chrome.notifications.create({
        type: 'basic',
        iconUrl: '/img/icon48.png',
        title: i18n('extName'),
        message: i18n(messageKey)
    });
}


// ---------------------------------------------------------------- Start

// imageUrl is the image of the context menu item, the overlay starts with it selected
async function startCapture(tab, imageUrl){

    if(!tab || tab.id == undefined || !isCapturableUrl(tab.url)){
        showCaptureError('capture_error_unavailable');
        return;
    }

    try{
        await chrome.scripting.executeScript({
            target: {tabId: tab.id},
            files: ['capture/overlay.js']
        });

        if(imageUrl){
            await chrome.scripting.executeScript({
                target: {tabId: tab.id},
                func: function(url){
                    var capture = window.__selectionSearchCapture;
                    if(capture)
                        capture.pickImage(url);
                },
                args: [imageUrl]
            });
        }
    }catch(err){
        // chrome:// pages, the Chrome Web Store and other pages extensions can't access
        console.warn('SelectionSearch: could not start the area capture.', err);
        showCaptureError('capture_error_unavailable');
    }
}

function startImageCapture(info, tab){
    return startCapture(tab, info && isImageSourceUrl(info.srcUrl) ? info.srcUrl : '');
}

// Used by the toolbar popup, which only knows the id of the active tab
function startCaptureFromMessage(request, sendResponse){
    chrome.tabs.get(request.tabId, function(tab){
        if(BrowserSupport.hasLastError()){
            showCaptureError('capture_error_unavailable');
            sendResponse({});
            return;
        }
        startCapture(tab).then(function(){
            sendResponse({});
        });
    });
}

function getCaptureConfig(sendResponse){
    chrome.storage.local.get(CAPTURE_LAST_TARGET_KEY, function(values){
        var last = values && values[CAPTURE_LAST_TARGET_KEY];
        sendResponse({
            targets: Object.keys(CAPTURE_TARGETS).map(function(id){
                return {id: id, label: CAPTURE_TARGETS[id].label};
            }),
            question: Storage.getOptions().capture_question || '',
            // The target that is used when Enter is pressed in the question box
            lastTarget: last === 'claude' ? 'claude' : 'gemini'
        });
    });
}


// ---------------------------------------------------------------- Image

// Returns the area of the screenshot that belongs to the area on the page.
// The rect is in css pixels of the viewport, the screenshot is in device pixels.
function getCropArea(rect, viewport, image){

    var scaleX = image.width / viewport.width;
    var scaleY = image.height / viewport.height;

    var x = Math.max(0, Math.floor(rect.x * scaleX));
    var y = Math.max(0, Math.floor(rect.y * scaleY));
    var right = Math.min(image.width, Math.ceil((rect.x + rect.width) * scaleX));
    var bottom = Math.min(image.height, Math.ceil((rect.y + rect.height) * scaleY));

    return {
        x: x,
        y: y,
        width: Math.max(1, right - x),
        height: Math.max(1, bottom - y)
    };
}

// Validates the area sent by the overlay and keeps it inside the viewport.
// Returns null if it is not usable.
function sanitizeCaptureRect(rect, viewport){

    if(!rect || !viewport)
        return null;

    var values = [rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height];
    if(!values.every(function(value){ return typeof value === 'number' && isFinite(value); }))
        return null;

    if(viewport.width <= 0 || viewport.height <= 0)
        return null;

    var x = Math.max(0, rect.x);
    var y = Math.max(0, rect.y);
    var width = Math.min(viewport.width, rect.x + rect.width) - x;
    var height = Math.min(viewport.height, rect.y + rect.height) - y;

    if(width < CAPTURE_MIN_SIZE || height < CAPTURE_MIN_SIZE)
        return null;

    return {x: x, y: y, width: width, height: height};
}

async function cropCapturedImage(dataUrl, rect, viewport){

    var source = await (await fetch(dataUrl)).blob();
    var bitmap = await createImageBitmap(source);

    try{
        var area = getCropArea(rect, viewport, {width: bitmap.width, height: bitmap.height});

        var canvas = new OffscreenCanvas(area.width, area.height);
        var ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);

        return await canvas.convertToBlob({type: 'image/png'});
    }finally{
        bitmap.close();
    }
}

// Urls of original images the background script may load. Blob urls belong to
// the page and are read there.
function isImageSourceUrl(url){
    return typeof url === 'string' && /^(https?:\/\/|data:image\/)/i.test(url);
}

async function fetchImageSource(url){

    if(/^data:/i.test(url))
        return await (await fetch(url)).blob();

    var controller = new AbortController();
    var timer = setTimeout(function(){ controller.abort(); }, CAPTURE_IMAGE_TIMEOUT);

    try{
        // Without host permissions this only works for images that allow CORS
        var response = await fetch(url, {credentials: 'omit', cache: 'force-cache', signal: controller.signal});
        if(!response.ok)
            return null;
        return await response.blob();
    }finally{
        clearTimeout(timer);
    }
}

// Returns the original image as png or jpeg, or null if it can't be loaded or
// decoded (e.g. svg, which can't be drawn in a service worker).
async function loadSourceImage(url){

    if(!isImageSourceUrl(url))
        return null;

    try{
        var blob = await fetchImageSource(url);
        if(!blob || !blob.size || blob.size > CAPTURE_MAX_SOURCE_BYTES)
            return null;

        var bitmap = await createImageBitmap(blob);

        try{
            // These are accepted everywhere and are kept as they are
            if(blob.type === 'image/png' || blob.type === 'image/jpeg')
                return blob;

            var canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            canvas.getContext('2d').drawImage(bitmap, 0, 0);
            return await canvas.convertToBlob({type: 'image/png'});
        }finally{
            bitmap.close();
        }
    }catch(err){
        console.warn('SelectionSearch: could not load the original image, the screenshot is used.', err);
        return null;
    }
}

async function blobToDataUrl(blob){

    var bytes = new Uint8Array(await blob.arrayBuffer());

    var binary = '';
    var chunkSize = 0x8000;
    for(var i = 0; i < bytes.length; i += chunkSize){
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }

    return 'data:' + blob.type + ';base64,' + btoa(binary);
}

// Keeps the png unless it is too big to be stored, then it is saved as jpeg and
// scaled down until it fits.
async function encodeCapturedImage(blob){

    var current = blob;

    if(current.size > CAPTURE_MAX_IMAGE_BYTES){

        var bitmap = await createImageBitmap(blob);
        var scale = 1;

        try{
            for(var attempt = 0; attempt < 8 && current.size > CAPTURE_MAX_IMAGE_BYTES; attempt++){

                var width = Math.max(1, Math.round(bitmap.width * scale));
                var height = Math.max(1, Math.round(bitmap.height * scale));

                var canvas = new OffscreenCanvas(width, height);
                var ctx = canvas.getContext('2d');
                // Jpeg has no transparency
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(bitmap, 0, 0, width, height);

                current = await canvas.convertToBlob({type: 'image/jpeg', quality: 0.92});
                scale *= 0.8;
            }
        }finally{
            bitmap.close();
        }
    }

    var isPng = current.type === 'image/png';

    return {
        imageDataUrl: await blobToDataUrl(current),
        mimeType: current.type,
        filename: 'selection-search-capture.' + (isPng ? 'png' : 'jpg'),
        size: current.size
    };
}


// ---------------------------------------------------------------- Clipboard

// The clipboard only takes png images
async function convertToPng(blob){

    if(blob.type === 'image/png')
        return blob;

    var bitmap = await createImageBitmap(blob);
    try{
        var canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        return await canvas.convertToBlob({type: 'image/png'});
    }finally{
        bitmap.close();
    }
}

// Runs in the page the capture was started on. The service worker and the
// offscreen documents can't write images to the clipboard, a focused page can.
async function writeImageToClipboard(dataUrl){
    try{
        var binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
        var bytes = new Uint8Array(binary.length);
        for(var i = 0; i < binary.length; i++){
            bytes[i] = binary.charCodeAt(i);
        }
        var blob = new Blob([bytes], {type: 'image/png'});
        await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
        return true;
    }catch(err){
        console.warn('SelectionSearch: could not copy the captured image to the clipboard.', err);
        return false;
    }
}

// Copies the image in full size into the clipboard of the page the overlay is in
async function copyCapturedImage(blob, sender){
    try{
        var dataUrl = await blobToDataUrl(await convertToPng(blob));
        var results = await chrome.scripting.executeScript({
            target: {tabId: sender.tab.id, frameIds: [sender.frameId || 0]},
            func: writeImageToClipboard,
            args: [dataUrl]
        });
        return !!(results && results[0] && results[0].result);
    }catch(err){
        console.warn('SelectionSearch: could not copy the captured image to the clipboard.', err);
        return false;
    }
}


// ---------------------------------------------------------------- Tasks

async function readCaptureIndex(){
    var values = await chrome.storage.session.get(CAPTURE_INDEX_KEY);
    return values[CAPTURE_INDEX_KEY] || {};
}

async function saveCaptureTask(task){

    try{
        await purgeCaptureTasks();
    }catch(err){
        console.warn('SelectionSearch: could not remove old captured images.', err);
    }

    var index = await readCaptureIndex();
    index[task.id] = {created: task.created, target: task.target};

    try{
        var data = {};
        data[CAPTURE_TASK_PREFIX + task.id] = task;
        data[CAPTURE_INDEX_KEY] = index;
        await chrome.storage.session.set(data);
    }catch(err){
        // Probably over the quota, keep it in memory instead
        console.warn('SelectionSearch: could not store the captured image in the session storage.', err);
        _captureMemoryTasks[task.id] = task;
    }
}

async function getCaptureTask(id){

    if(typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))
        return null;

    var key = CAPTURE_TASK_PREFIX + id;
    var task = _captureMemoryTasks[id];
    if(!task){
        var values = await chrome.storage.session.get(key);
        task = values[key];
    }

    // A tab that failed keeps its task id to try again after a reload, but not for ever
    if(!task || Date.now() - task.created > CAPTURE_TASK_TTL)
        return null;

    return task;
}

async function deleteCaptureTask(id){

    if(typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))
        return;

    delete _captureMemoryTasks[id];

    var index = await readCaptureIndex();
    if(index[id]){
        delete index[id];
        await chrome.storage.session.set({[CAPTURE_INDEX_KEY]: index});
    }
    await chrome.storage.session.remove(CAPTURE_TASK_PREFIX + id);
}

// Removes the tasks nobody took, so old screenshots don't stay around
async function purgeCaptureTasks(){

    var now = Date.now();

    Object.keys(_captureMemoryTasks).forEach(function(id){
        if(now - _captureMemoryTasks[id].created > CAPTURE_TASK_TTL)
            delete _captureMemoryTasks[id];
    });

    var index = await readCaptureIndex();
    var stale = Object.keys(index).filter(function(id){
        return now - index[id].created > CAPTURE_TASK_TTL;
    });

    if(stale.length){
        stale.forEach(function(id){ delete index[id]; });
        await chrome.storage.session.set({[CAPTURE_INDEX_KEY]: index});
        await chrome.storage.session.remove(stale.map(function(id){
            return CAPTURE_TASK_PREFIX + id;
        }));
    }
}

// Tasks of gemini and claude are requested by the page with the id from the url
async function getCaptureTaskForSender(request, sender, sendResponse){

    var task = null;

    try{
        task = await getCaptureTask(request.taskId);

        if(task){
            var target = CAPTURE_TARGETS[task.target];
            var host = sender.url ? new URL(sender.url).hostname : '';
            // Only the page of the target gets the image
            if(!target || !target.host || host !== target.host)
                task = null;
        }
    }catch(err){
        task = null;
    }

    sendResponse({task: task});
}

async function finishCaptureTask(request, sender, sendResponse){
    try{
        await deleteCaptureTask(request.taskId);
    }catch(err){
        console.warn('SelectionSearch: could not remove the captured image.', err);
    }
    sendResponse({});
}

// The Lens page can't be given an id in the url, because Google redirects
// lens.google.com to its start page. It is found by the id of its tab instead.
async function getLensTask(sender, sendResponse){

    var task = null;

    try{
        if(_captureLensPending){
            await _captureLensPending;
        }

        if(sender.tab){
            // A tab opened in the current tab keeps its id, so a task that failed
            // before can be registered to the same tab. The newest one wins.
            var isNewer = function(candidate, created){
                return !candidate || created > candidate.created;
            };

            var index = await readCaptureIndex();
            var newest = null;
            Object.keys(index).forEach(function(key){
                if(index[key].target === 'lens' && index[key].tabId === sender.tab.id && isNewer(newest, index[key].created))
                    newest = {id: key, created: index[key].created};
            });

            // Tasks that only exist in memory are not in the index
            Object.values(_captureMemoryTasks).forEach(function(memoryTask){
                if(memoryTask.target === 'lens' && memoryTask.tabId === sender.tab.id && isNewer(newest, memoryTask.created))
                    newest = {id: memoryTask.id, created: memoryTask.created};
            });

            if(newest){
                task = await getCaptureTask(newest.id);
            }
        }
    }catch(err){
        task = null;
    }

    sendResponse({task: task});
}


// ---------------------------------------------------------------- Target

function buildTargetUrl(task, options){

    var target = CAPTURE_TARGETS[task.target];

    if(task.target === 'lens')
        return target.url;

    var url = new URL(target.url);
    url.searchParams.set('ss_task', task.id);

    // Opens claude.ai in incognito mode right away, so it is not reloaded later
    if(task.target === 'claude' && options.ai_chat_claude_incognito)
        url.searchParams.set('incognito', 'true');

    return url.toString();
}

// Opens the target like a search: in the current tab, unless the options open
// searches in a new tab.
function openCaptureTargetTab(url, openerTab, options){

    var hasOpener = openerTab && openerTab.id >= 0;

    if(hasOpener && !options.newtab)
        return chrome.tabs.update(openerTab.id, {url: url});

    var createProperties = {url: url, active: !options.background_tab};
    if(hasOpener){
        createProperties.openerTabId = openerTab.id;
        if(!options.open_new_tab_last)
            createProperties.index = openerTab.index + 1;
    }
    return chrome.tabs.create(createProperties);
}

async function openCaptureTarget(task, openerTab){

    var options = Storage.getOptions();
    var url = buildTargetUrl(task, options);

    if(task.target !== 'lens'){
        await openCaptureTargetTab(url, openerTab, options);
        return;
    }

    _captureLensPending = (async function(){
        var tab = await openCaptureTargetTab(url, openerTab, options);

        if(_captureMemoryTasks[task.id]){
            _captureMemoryTasks[task.id].tabId = tab.id;
        }

        var index = await readCaptureIndex();
        if(index[task.id]){
            index[task.id].tabId = tab.id;
            try{
                await chrome.storage.session.set({[CAPTURE_INDEX_KEY]: index});
            }catch(err){
                console.warn('SelectionSearch: could not register the Lens tab.', err);
            }
        }
        return tab;
    })();

    try{
        await _captureLensPending;
    }finally{
        _captureLensPending = null;
    }
}


// ---------------------------------------------------------------- Submit

function newCaptureTaskId(){
    return crypto.randomUUID();
}

// Returns the image of the selection: the original image when an image is
// selected and it can be loaded, otherwise the selected area of the screenshot.
async function prepareCaptureImage(request, sender){

    var tab = sender.tab;

    // An image in a frame has no area, only the image
    var source = isImageSourceUrl(request.imageData) ? request.imageData :
        isImageSourceUrl(request.imageUrl) ? request.imageUrl : '';
    var rect = request.rect ? sanitizeCaptureRect(request.rect, request.viewport) : null;

    if(!rect && !source)
        throw captureError(request.rect ? 'capture_error_too_small' : 'capture_error_failed');

    // Taken first, the page may change while the original image is loaded
    var screenshot = null;
    if(rect){
        try{
            screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'png'});
        }catch(err){
            console.warn('SelectionSearch: could not capture the tab.', err);
            if(!source)
                throw captureError('capture_error_unavailable');
        }
    }

    var blob = source ? await loadSourceImage(source) : null;
    if(!blob && screenshot)
        blob = await cropCapturedImage(screenshot, rect, request.viewport);
    if(!blob)
        throw captureError('capture_error_image');

    return blob;
}

async function processCaptureSubmit(request, sender){

    var tab = sender.tab;

    if(!tab || !CAPTURE_TARGETS.hasOwnProperty(request.target))
        throw captureError('capture_error_failed');

    var image = await encodeCapturedImage(await prepareCaptureImage(request, sender));

    var question = typeof request.question === 'string' ? request.question.trim().slice(0, 4000) : '';

    var task = {
        id: newCaptureTaskId(),
        target: request.target,
        question: question,
        created: Date.now(),
        imageDataUrl: image.imageDataUrl,
        mimeType: image.mimeType,
        filename: image.filename,
        size: image.size
    };

    await saveCaptureTask(task);

    if(request.target !== 'lens'){
        chrome.storage.local.set({[CAPTURE_LAST_TARGET_KEY]: request.target});
    }

    await openCaptureTarget(task, tab);
}

async function processCaptureCopy(request, sender){

    if(!sender.tab)
        throw captureError('capture_error_failed');

    var blob = await prepareCaptureImage(request, sender);

    if(!await copyCapturedImage(blob, sender))
        throw captureError('capture_error_copy');
}

function respondToCapture(process, request, sender, sendResponse){
    process(request, sender).then(function(){
        sendResponse({ok: true});
    }, function(err){
        console.warn('SelectionSearch: the area capture failed.', err);
        showCaptureError(err && err.captureMessage ? err.captureMessage : 'capture_error_failed');
        sendResponse({ok: false});
    });
}

function captureSubmit(request, sender, sendResponse){
    respondToCapture(processCaptureSubmit, request, sender, sendResponse);
}

function captureCopy(request, sender, sendResponse){
    respondToCapture(processCaptureCopy, request, sender, sendResponse);
}
