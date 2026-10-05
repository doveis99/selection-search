
// Area selection for "search by capturing an area".
//
// Injected on demand into the top frame of the active tab by background/capture.js.
// The user drags an area, or clicks an element of the page, and chooses where to
// search. The overlay only draws the selection: it hides itself and reports the
// area, the background script takes the screenshot afterwards, so the overlay never
// ends up in the image.
//
// When an image is chosen (a clicked <img>, or the image of the "search this image"
// menu item) its url is sent as well and the original image is used instead of the
// screenshot if it can be loaded.
//
// The copy button (or Ctrl+C) copies the same image to the clipboard instead of
// searching it.
//
// This script does not use the globals of the other content scripts, they are not
// available in tabs that were opened before the extension was updated.

(function(){
    'use strict';

    // Injected again while the overlay exists, e.g. when the menu item is used twice
    if(window.__selectionSearchCapture){
        window.__selectionSearchCapture.start();
        return;
    }

    const MIN_SIZE = 8;
    // A press that moves further than this is a drag, otherwise it picks the element
    const DRAG_THRESHOLD = 5;
    // Images read by the page itself, bigger ones are left to the background script
    const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
    const IMAGE_FETCH_TIMEOUT = 5000;
    // The copy button, it copies the image to the clipboard instead of searching it
    const COPY_TARGET = 'clipboard';
    const TOAST_DURATION = 2000;

    // Used until the background script answers, or if it does not
    const FALLBACK_CONFIG = {
        targets: [
            {id: 'lens', label: 'Google Lens'},
            {id: 'gemini', label: 'Gemini'},
            {id: 'claude', label: 'Claude'}
        ],
        question: '',
        lastTarget: 'gemini'
    };

    // Keeps the events of the overlay away from the page and from the popup of this extension
    const STOP_EVENTS = [
        'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
        'pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend',
        'keydown', 'keyup', 'keypress', 'wheel', 'dragstart'
    ];

    const CSS = `
        [hidden] { display: none !important; }
        .layer {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            cursor: crosshair; user-select: none; -webkit-user-select: none; touch-action: none;
            font: 13px/1.4 system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif;
        }
        .hint {
            position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
            padding: 8px 16px; border-radius: 999px; pointer-events: none;
            max-width: calc(100vw - 32px); box-sizing: border-box; text-align: center;
            background: rgba(24, 24, 27, 0.92); color: #fff;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        }
        .box {
            position: fixed; box-sizing: border-box; pointer-events: none;
            border: 2px solid #4f8cff;
            box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.45);
        }
        .box.empty { border: 0; }
        .hover {
            position: fixed; box-sizing: border-box; pointer-events: none;
            border: 2px dashed #4f8cff; background: rgba(79, 140, 255, 0.12);
        }
        .hover-label {
            position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px;
            padding: 1px 6px; border-radius: 4px; white-space: nowrap;
            background: #4f8cff; color: #fff; font-size: 11px;
        }
        .hover.inside .hover-label { bottom: auto; top: 2px; left: 2px; margin: 0; }
        .bar {
            position: fixed; box-sizing: border-box; width: 380px; max-width: calc(100vw - 16px);
            display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px;
            border-radius: 12px; cursor: default; user-select: text; -webkit-user-select: text;
            background: rgba(24, 24, 27, 0.97); color: #fff;
            box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
        }
        .bar.busy { cursor: progress; opacity: 0.7; }
        .bar.busy .btn { pointer-events: none; }
        .thumb {
            flex: 0 0 auto; width: 44px; height: 44px; object-fit: cover; border-radius: 6px;
            background: rgba(255, 255, 255, 0.08);
        }
        .question {
            box-sizing: border-box; flex: 1 1 100%; min-width: 0; padding: 7px 10px;
            border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.25);
            background: rgba(255, 255, 255, 0.08); color: #fff; font: inherit; outline: none;
        }
        .thumb:not([hidden]) + .question { flex: 1 1 200px; }
        .question::placeholder { color: rgba(255, 255, 255, 0.55); }
        .question:focus { border-color: #4f8cff; }
        .btn {
            padding: 6px 12px; border: 0; border-radius: 8px; cursor: pointer;
            background: #3b82f6; color: #fff; font: inherit; font-weight: 600;
        }
        .btn:hover { background: #2563eb; }
        .btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .btn.copy { background: rgba(255, 255, 255, 0.14); font-weight: 500; }
        .btn.copy:hover { background: rgba(255, 255, 255, 0.24); }
        .btn.cancel { margin-left: auto; background: rgba(255, 255, 255, 0.14); font-weight: 500; }
        .btn.cancel:hover { background: rgba(255, 255, 255, 0.24); }
    `;

    let host = null;      // the element added to the page
    let ui = null;        // the elements inside the shadow root
    let config = FALLBACK_CONFIG;
    let pressed = false;  // the pointer is down, it is not a drag yet
    let dragging = false;
    let anchor = null;    // where the press started
    let rect = null;      // the selected area, css pixels of the viewport
    let imageUrl = '';    // the url of the selected image, empty for an area
    let sending = false;

    // The element under the pointer. The wheel moves the highlight to the parents
    // of the element and back, the elements it came from are kept in hoverPath.
    let hoverBase = null; // the element that is really under the pointer
    let hoverTarget = null;
    let hoverPath = [];
    let lastWheel = 0;


    function t(key, fallback){
        try{
            return chrome.i18n.getMessage(key) || fallback;
        }catch(err){
            return fallback;
        }
    }

    function el(tag, className, text){
        const node = document.createElement(tag);
        if(className)
            node.className = className;
        if(text)
            node.textContent = text;
        return node;
    }

    function inBar(ev){
        return !!(ui && ev.target && ev.target.closest && ev.target.closest('.bar'));
    }

    function point(ev){
        return {
            x: Math.min(Math.max(ev.clientX, 0), window.innerWidth),
            y: Math.min(Math.max(ev.clientY, 0), window.innerHeight)
        };
    }


    // ------------------------------------------------------------ Elements

    // The topmost element of the page at a point, looking into open shadow roots
    function elementAt(x, y){
        let found = null;
        let scope = document;

        for(let depth = 0; depth < 10 && scope; depth++){
            const next = scope.elementsFromPoint(x, y).find(function(node){
                return node !== host && (scope === document || scope.contains(node));
            });
            if(!next || next === found)
                break;
            found = next;
            scope = next.shadowRoot || null;
        }

        return found;
    }

    function parentOf(node){
        if(node.parentElement)
            return node.parentElement;
        const root = node.getRootNode && node.getRootNode();
        return root && root.host ? root.host : null;
    }

    // The part of the element inside the viewport, null if too little of it is visible
    function visibleRect(node){
        const box = node.getBoundingClientRect();
        const x = Math.max(0, box.left);
        const y = Math.max(0, box.top);
        const right = Math.min(window.innerWidth, box.right);
        const bottom = Math.min(window.innerHeight, box.bottom);

        if(right - x < MIN_SIZE || bottom - y < MIN_SIZE)
            return null;

        return {x: x, y: y, width: right - x, height: bottom - y};
    }

    function sameRect(a, b){
        return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 &&
            Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
    }

    // Tiny elements like icons in text are replaced by the first parent that is big enough
    function pickable(node){
        while(node && !visibleRect(node))
            node = parentOf(node);
        return node;
    }

    function isImageUrl(url){
        return typeof url === 'string' && /^(https?:|data:image\/|blob:)/i.test(url);
    }

    // The url of the image an element shows, if the element is an image or only wraps one
    function imageSourceOf(node){
        let img = null;

        if(node instanceof HTMLImageElement){
            img = node;
        }else{
            const images = node.querySelectorAll ? node.querySelectorAll('img') : [];
            if(images.length === 1){
                const own = visibleRect(node);
                const inner = visibleRect(images[0]);
                if(own && inner && Math.abs(own.width - inner.width) <= 4 && Math.abs(own.height - inner.height) <= 4)
                    img = images[0];
            }
        }

        const url = img ? (img.currentSrc || img.src) : '';
        return isImageUrl(url) ? url : '';
    }

    // The image of the context menu item. The largest visible one wins if the same
    // url is used more than once.
    function findImage(url){
        let best = null;
        let bestArea = 0;

        Array.prototype.forEach.call(document.images, function(img){
            if(img.currentSrc !== url && img.src !== url)
                return;
            const area = visibleRect(img);
            if(area && area.width * area.height > bestArea){
                best = img;
                bestArea = area.width * area.height;
            }
        });

        return best;
    }

    function tagLabel(node, area){
        return node.tagName.toLowerCase() + ' · ' + Math.round(area.width) + ' × ' + Math.round(area.height);
    }


    // ------------------------------------------------------------ UI

    function build(){
        host = document.createElement('selection-search-capture');
        host.style.cssText = 'all: initial !important; position: fixed !important; top: 0 !important; ' +
            'left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important;';
        STOP_EVENTS.forEach(function(type){
            host.addEventListener(type, function(ev){ ev.stopPropagation(); });
        });

        const root = host.attachShadow({mode: 'closed'});
        const style = document.createElement('style');
        style.textContent = CSS;
        root.appendChild(style);

        ui = {};
        ui.layer = el('div', 'layer');
        ui.hint = el('div', 'hint', t('capture_hint', 'Drag an area or click an element · Wheel: surrounding element · Esc: cancel'));
        ui.hover = el('div', 'hover');
        ui.hover.hidden = true;
        ui.hoverLabel = el('div', 'hover-label');
        ui.hover.appendChild(ui.hoverLabel);
        ui.box = el('div', 'box');
        ui.box.hidden = true;
        ui.bar = el('div', 'bar');
        ui.bar.hidden = true;
        ui.layer.appendChild(ui.box);
        ui.layer.appendChild(ui.hover);
        ui.layer.appendChild(ui.hint);
        ui.layer.appendChild(ui.bar);
        root.appendChild(ui.layer);

        buildBar();

        ui.layer.addEventListener('pointerdown', onPointerDown);
        ui.layer.addEventListener('pointermove', onPointerMove);
        ui.layer.addEventListener('pointerup', onPointerUp);
        ui.layer.addEventListener('pointercancel', onPointerCancel);
        ui.layer.addEventListener('pointerleave', function(){
            if(!pressed && !dragging)
                clearHover();
        });
        // Keep the page from starting a text selection or a drag under the overlay
        ui.layer.addEventListener('mousedown', function(ev){ if(!inBar(ev)) ev.preventDefault(); });
        ui.layer.addEventListener('selectstart', function(ev){ if(!inBar(ev)) ev.preventDefault(); });
        ui.layer.addEventListener('dragstart', function(ev){ ev.preventDefault(); });
        ui.layer.addEventListener('contextmenu', function(ev){ ev.preventDefault(); });
        ui.layer.addEventListener('wheel', onWheel, {passive: false});

        document.documentElement.appendChild(host);
    }

    function buildBar(){
        // Keeps what was typed when the bar is built again after the settings arrived
        const typedQuestion = ui.question ? ui.question.value : '';

        while(ui.bar.firstChild)
            ui.bar.removeChild(ui.bar.firstChild);

        // Shows the image when it is not highlighted on the page, e.g. in a frame
        ui.thumb = el('img', 'thumb');
        ui.thumb.alt = '';
        ui.thumb.hidden = true;
        ui.thumb.addEventListener('error', function(){ ui.thumb.hidden = true; });
        ui.bar.appendChild(ui.thumb);

        ui.question = el('input', 'question');
        ui.question.type = 'text';
        ui.question.maxLength = 4000;
        ui.question.setAttribute('autocomplete', 'off');
        ui.question.placeholder = t('capture_question_placeholder', 'Question (optional, sent with the image to Gemini / Claude)');
        ui.question.value = typedQuestion || config.question || '';
        ui.question.addEventListener('keydown', function(ev){
            // Enter also confirms the composition of Korean, Japanese and Chinese input
            if(ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229){
                ev.preventDefault();
                submit(config.lastTarget);
            }
            // Ctrl+C copies the image unless text of the question is selected
            if((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.code === 'KeyC' &&
                    ui.question.selectionStart === ui.question.selectionEnd){
                ev.preventDefault();
                submit(COPY_TARGET);
            }
        });
        ui.bar.appendChild(ui.question);

        config.targets.forEach(function(target){
            const button = el('button', 'btn', target.label);
            button.type = 'button';
            button.addEventListener('click', function(){ submit(target.id); });
            ui.bar.appendChild(button);
        });

        const copyButton = el('button', 'btn copy', t('capture_copy', 'Copy'));
        copyButton.type = 'button';
        copyButton.title = t('capture_copy_title', 'Copy the image to the clipboard (Ctrl+C)');
        copyButton.addEventListener('click', function(){ submit(COPY_TARGET); });
        ui.bar.appendChild(copyButton);

        const cancelButton = el('button', 'btn cancel', t('capture_cancel', 'Cancel'));
        cancelButton.type = 'button';
        cancelButton.addEventListener('click', cancel);
        ui.bar.appendChild(cancelButton);

        updateThumb();
    }

    function updateThumb(){
        if(imageUrl && !rect){
            ui.thumb.src = imageUrl;
            ui.thumb.hidden = false;
        }else{
            ui.thumb.hidden = true;
            ui.thumb.removeAttribute('src');
        }
    }

    function drawBox(area){
        const style = ui.box.style;
        style.left = area.x + 'px';
        style.top = area.y + 'px';
        style.width = area.width + 'px';
        style.height = area.height + 'px';
    }

    function setRect(a, b){
        rect = {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            width: Math.abs(a.x - b.x),
            height: Math.abs(a.y - b.y)
        };
        drawBox(rect);
    }

    function placeBar(){
        // It has to be laid out to be measured
        ui.bar.hidden = false;

        const margin = 8;
        const width = ui.bar.offsetWidth;
        const height = ui.bar.offsetHeight;

        // In the middle when the image is not on the page
        if(!rect){
            ui.bar.style.left = Math.max(margin, (window.innerWidth - width) / 2) + 'px';
            ui.bar.style.top = Math.max(margin, (window.innerHeight - height) / 2) + 'px';
            return;
        }

        const left = Math.max(margin, Math.min(rect.x, window.innerWidth - width - margin));

        // Below the area, or above it, or inside its lower part when there is no room
        let top = rect.y + rect.height + margin;
        if(top + height > window.innerHeight - margin){
            top = rect.y - height - margin;
            if(top < margin){
                top = Math.max(margin, Math.min(rect.y + rect.height - height - margin, window.innerHeight - height - margin));
            }
        }

        ui.bar.style.left = left + 'px';
        ui.bar.style.top = top + 'px';
    }

    // Shows the bar for the current selection
    function showSelection(){
        clearHover();
        ui.hint.hidden = true;
        ui.box.hidden = false;
        // Without an area the whole page is dimmed behind the bar
        ui.box.classList.toggle('empty', !rect);
        drawBox(rect || {x: window.innerWidth / 2, y: window.innerHeight / 2, width: 0, height: 0});
        updateThumb();
        placeBar();
        ui.question.focus({preventScroll: true});
    }

    function resetSelection(){
        pressed = false;
        dragging = false;
        rect = null;
        imageUrl = '';
        if(ui){
            ui.box.hidden = true;
            ui.bar.hidden = true;
            ui.hint.hidden = false;
            clearHover();
        }
    }


    // ------------------------------------------------------------ Hover

    function clearHover(){
        hoverBase = null;
        hoverTarget = null;
        hoverPath = [];
        if(ui)
            ui.hover.hidden = true;
    }

    function drawHover(){
        const area = hoverTarget && visibleRect(hoverTarget);
        if(!area){
            ui.hover.hidden = true;
            return;
        }

        const style = ui.hover.style;
        style.left = area.x + 'px';
        style.top = area.y + 'px';
        style.width = area.width + 'px';
        style.height = area.height + 'px';
        ui.hoverLabel.textContent = tagLabel(hoverTarget, area);
        ui.hover.classList.toggle('inside', area.y < 24);
        ui.hover.hidden = false;
    }

    function updateHover(p){
        const base = elementAt(p.x, p.y);

        // Keeps the level chosen with the wheel while the pointer stays on the same element
        if(base === hoverBase && hoverTarget)
            return;

        hoverBase = base;
        hoverTarget = base ? pickable(base) : null;
        hoverPath = [];
        drawHover();
    }

    function onWheel(ev){
        ev.preventDefault();

        if(pressed || dragging || sending || inBar(ev) || !hoverTarget || Math.abs(ev.deltaY) < 1)
            return;

        // Touchpads send many small events
        const now = Date.now();
        if(now - lastWheel < 120)
            return;
        lastWheel = now;

        if(ev.deltaY < 0){
            const current = visibleRect(hoverTarget);
            let parent = parentOf(hoverTarget);
            // Parents with the same size would not show any change
            while(parent && parent !== document.documentElement && current && visibleRect(parent) && sameRect(visibleRect(parent), current))
                parent = parentOf(parent);
            if(parent && visibleRect(parent)){
                hoverPath.push(hoverTarget);
                hoverTarget = parent;
            }
        }else if(hoverPath.length){
            hoverTarget = hoverPath.pop();
        }

        drawHover();
    }


    // ------------------------------------------------------------ Events

    function onPointerDown(ev){
        if(ev.button !== 0 || sending || inBar(ev))
            return;

        ev.preventDefault();

        pressed = true;
        anchor = point(ev);

        // A touch has no hover before it
        if(ev.pointerType !== 'mouse')
            updateHover(anchor);

        try{
            ui.layer.setPointerCapture(ev.pointerId);
        }catch(err){}
    }

    function onPointerMove(ev){
        const p = point(ev);

        if(pressed && !dragging && (Math.abs(p.x - anchor.x) > DRAG_THRESHOLD || Math.abs(p.y - anchor.y) > DRAG_THRESHOLD)){
            // The press becomes a drag of a free area
            dragging = true;
            imageUrl = '';
            clearHover();
            ui.bar.hidden = true;
            ui.hint.hidden = true;
            ui.box.classList.remove('empty');
            ui.box.hidden = false;
        }

        if(dragging){
            setRect(anchor, p);
            return;
        }

        if(!pressed && !sending){
            if(inBar(ev))
                clearHover();
            else
                updateHover(p);
        }
    }

    function onPointerUp(ev){
        if(!pressed)
            return;

        try{
            ui.layer.releasePointerCapture(ev.pointerId);
        }catch(err){}

        pressed = false;

        if(dragging){
            dragging = false;
            if(rect.width < MIN_SIZE || rect.height < MIN_SIZE){
                resetSelection();
                return;
            }
            showSelection();
            return;
        }

        // A click selects the highlighted element
        const p = point(ev);
        if(elementAt(p.x, p.y) !== hoverBase)
            updateHover(p);

        if(hoverTarget)
            selectElement(hoverTarget);
    }

    function onPointerCancel(){
        if(dragging)
            resetSelection();
        pressed = false;
        dragging = false;
    }

    function selectElement(node, url){
        const area = visibleRect(node);
        if(!area)
            return;
        rect = area;
        imageUrl = url || imageSourceOf(node);
        showSelection();
    }

    function onKeyDown(ev){
        if(ev.key === 'Escape'){
            ev.preventDefault();
            ev.stopImmediatePropagation();
            cancel();
            return;
        }

        // The page must not scroll under the overlay, the area would no longer match.
        // Typing inside the overlay reaches the window with the overlay as its target.
        if(ev.target !== host && [' ', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].indexOf(ev.key) !== -1){
            ev.preventDefault();
        }
    }

    // The area is relative to the viewport, so it is dropped when the page scrolls.
    // An image that is not on the page does not depend on it.
    function onScroll(ev){
        if(sending || ev.target !== document)
            return;
        if(imageUrl && !rect && !ui.bar.hidden){
            clearHover();
            return;
        }
        resetSelection();
    }

    function onResize(){
        if(!sending)
            cancel();
    }


    // ------------------------------------------------------------ Actions

    function afterPaint(){
        return new Promise(function(resolve){
            requestAnimationFrame(function(){
                requestAnimationFrame(function(){
                    setTimeout(resolve, 60);
                });
            });
        });
    }

    function blobToDataUrl(blob){
        return new Promise(function(resolve, reject){
            const reader = new FileReader();
            reader.onload = function(){ resolve(reader.result); };
            reader.onerror = function(){ reject(reader.error); };
            reader.readAsDataURL(blob);
        });
    }

    // Reads the image with the cookies of the page. Only same origin images are read
    // here, the background script tries the others, which would log CORS errors on the page.
    function readImageInPage(url){
        if(!url)
            return Promise.resolve('');
        if(/^data:image\//i.test(url))
            return Promise.resolve(url);

        let sameOrigin = false;
        try{
            sameOrigin = new URL(url, location.href).origin === location.origin;
        }catch(err){}
        if(!sameOrigin)
            return Promise.resolve('');

        const controller = new AbortController();
        const timer = setTimeout(function(){ controller.abort(); }, IMAGE_FETCH_TIMEOUT);

        return fetch(url, {cache: 'force-cache', signal: controller.signal}).then(function(response){
            if(!response.ok)
                return '';
            return response.blob().then(function(blob){
                if(blob.size > MAX_IMAGE_BYTES || (blob.type && !/^image\//i.test(blob.type)))
                    return '';
                return blobToDataUrl(blob);
            });
        }).catch(function(){
            return '';
        }).finally(function(){
            clearTimeout(timer);
        });
    }

    function submit(targetId){
        if((!rect && !imageUrl) || sending)
            return;

        sending = true;
        ui.bar.classList.add('busy');
        // A new overlay may be started while the image is read
        const own = host;

        const copy = targetId === COPY_TARGET;
        const message = {
            action: copy ? 'captureCopy' : 'captureSubmit',
            target: targetId,
            question: ui.question.value.trim(),
            rect: rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null,
            viewport: {width: window.innerWidth, height: window.innerHeight},
            // The background script can't read the blob urls of the page
            imageUrl: /^blob:/i.test(imageUrl) ? '' : imageUrl,
            imageData: ''
        };

        readImageInPage(imageUrl).then(function(data){
            message.imageData = data;
            if(data)
                message.imageUrl = '';

            // The overlay must not be part of the screenshot
            if(host === own)
                host.style.setProperty('display', 'none', 'important');
            return afterPaint();
        }).then(function(){
            if(host !== own)
                return; // cancelled meanwhile
            try{
                chrome.runtime.sendMessage(message, function(response){
                    void chrome.runtime.lastError;
                    cleanup();
                    // Errors are shown by the background script
                    if(copy && response && response.ok)
                        showToast(t('capture_copied', 'The image was copied to the clipboard.'));
                    if(response && response.ok && response.link)
                        openLink(response.link, response.taskId);
                });
            }catch(err){
                // The extension was reloaded or removed
                cleanup();
            }
        });
    }

    // Opens the target in a new tab with a link, like the searches of the popup,
    // so it opens in the installed app of the site (PWA) when there is one. A
    // link needs the user activation of the click on the target, which expires
    // after a few seconds. The background script opens the tab then instead.
    function openLink(url, taskId){
        const activation = navigator.userActivation;
        if(activation && !activation.isActive){
            try{
                chrome.runtime.sendMessage({action: 'captureOpenTarget', taskId: taskId}, function(){
                    void chrome.runtime.lastError;
                });
            }catch(err){
                // The extension was reloaded or removed
            }
            return;
        }

        // Not added to the page, so the click doesn't reach the scripts of the page
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.click();
    }

    // A short message on the page after the overlay is gone
    function showToast(text){
        const toast = document.createElement('selection-search-capture-toast');
        toast.style.cssText = 'all: initial !important; position: fixed !important; z-index: 2147483647 !important; ' +
            'left: 50% !important; bottom: 32px !important; transform: translateX(-50%) !important; ' +
            'padding: 8px 16px !important; border-radius: 999px !important; pointer-events: none !important; ' +
            'background: rgba(24, 24, 27, 0.92) !important; color: #fff !important; ' +
            'font: 13px/1.4 system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif !important; ' +
            'box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3) !important;';
        toast.textContent = text;
        document.documentElement.appendChild(toast);
        setTimeout(function(){ toast.remove(); }, TOAST_DURATION);
    }

    function cancel(){
        cleanup();
    }

    function cleanup(){
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize, true);

        if(host){
            host.remove();
            host = null;
        }
        ui = null;
        pressed = false;
        dragging = false;
        rect = null;
        imageUrl = '';
        sending = false;
        hoverBase = null;
        hoverTarget = null;
        hoverPath = [];
    }

    function start(){
        cleanup();
        config = FALLBACK_CONFIG;

        build();

        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize, true);

        try{
            window.getSelection().removeAllRanges();
        }catch(err){}

        try{
            chrome.runtime.sendMessage({action: 'getCaptureConfig'}, function(response){
                void chrome.runtime.lastError;
                if(!response || !response.targets || !ui)
                    return;

                config = response;
                buildBar();
                // The image of the context menu item is selected before the settings arrive
                if(!ui.bar.hidden){
                    placeBar();
                    ui.question.focus({preventScroll: true});
                }
            });
        }catch(err){
            // The extension was reloaded or removed
        }
    }

    // Starts with the image of the "search this image" menu item selected. It is
    // highlighted if it is found in this document, images in frames are only shown
    // in the bar.
    function pickImage(url){
        if(!ui)
            start();
        if(!isImageUrl(url))
            return;

        const img = findImage(url);
        if(img && visibleRect(img)){
            selectElement(img, url);
        }else{
            rect = null;
            imageUrl = url;
            showSelection();
        }
    }

    window.__selectionSearchCapture = {start: start, cancel: cancel, pickImage: pickImage};
    start();
})();
