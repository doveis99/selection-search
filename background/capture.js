
// Search by capturing an area of the page.
//
// The context menu item and the toolbar popup button call startCapture(), which
// injects capture/overlay.js into the active tab. Both are invoked by the user
// and therefore grant the activeTab permission, so no host permissions are
// needed for the injection and the screenshot.
//
// The overlay lets the user drag an area and choose a target, hides itself and
// reports the area with a "captureSubmit" message. The visible tab is then
// captured, cropped and handed to the target:
//   lens   - capture/lens_upload.js puts the image into the upload box of Google Lens
//   gemini - sites/ai_chat.js attaches the image to the prompt box and sends the
//   claude   question if there is one
// The image is kept in chrome.storage.session under a random task id until the
// target page has taken it.

const CAPTURE_TASK_PREFIX = 'capture_task_';
const CAPTURE_INDEX_KEY = 'capture_task_index';
const CAPTURE_LAST_TARGET_KEY = 'capture_last_target';
const CAPTURE_TASK_TTL = 30 * 60 * 1000;
// The session storage is limited to 10 MB and the images are stored as base64
const CAPTURE_MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const CAPTURE_MIN_SIZE = 8;

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

async function startCapture(tab){

    if(!tab || tab.id == undefined || !isCapturableUrl(tab.url)){
        showCaptureError('capture_error_unavailable');
        return;
    }

    try{
        await chrome.scripting.executeScript({
            target: {tabId: tab.id},
            files: ['capture/overlay.js']
        });
    }catch(err){
        // chrome:// pages, the Chrome Web Store and other pages extensions can't access
        console.warn('SelectionSearch: could not start the area capture.', err);
        showCaptureError('capture_error_unavailable');
    }
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
            var index = await readCaptureIndex();
            var id = Object.keys(index).find(function(key){
                return index[key].target === 'lens' && index[key].tabId === sender.tab.id;
            });
            if(id){
                task = await getCaptureTask(id);
            }else{
                // Tasks that only exist in memory are not in the index
                task = Object.values(_captureMemoryTasks).find(function(memoryTask){
                    return memoryTask.target === 'lens' && memoryTask.tabId === sender.tab.id;
                }) || null;
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

async function openCaptureTarget(task, openerTab){

    var url = buildTargetUrl(task, Storage.getOptions());

    var createProperties = {url: url, active: true};
    if(openerTab && openerTab.id != undefined){
        createProperties.openerTabId = openerTab.id;
        createProperties.index = openerTab.index + 1;
    }

    if(task.target !== 'lens'){
        await chrome.tabs.create(createProperties);
        return;
    }

    _captureLensPending = (async function(){
        var tab = await chrome.tabs.create(createProperties);

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

async function processCaptureSubmit(request, sender){

    var tab = sender.tab;

    if(!tab || !CAPTURE_TARGETS.hasOwnProperty(request.target))
        throw captureError('capture_error_failed');

    var rect = sanitizeCaptureRect(request.rect, request.viewport);
    if(!rect)
        throw captureError('capture_error_too_small');

    var screenshot;
    try{
        screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'png'});
    }catch(err){
        console.warn('SelectionSearch: could not capture the tab.', err);
        throw captureError('capture_error_unavailable');
    }

    var blob = await cropCapturedImage(screenshot, rect, request.viewport);
    var image = await encodeCapturedImage(blob);

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

function captureSubmit(request, sender, sendResponse){
    processCaptureSubmit(request, sender).then(function(){
        sendResponse({ok: true});
    }, function(err){
        console.warn('SelectionSearch: the area capture failed.', err);
        showCaptureError(err && err.captureMessage ? err.captureMessage : 'capture_error_failed');
        sendResponse({ok: false});
    });
}
