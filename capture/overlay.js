
// Area selection for "search by capturing an area".
//
// Injected on demand into the top frame of the active tab by background/capture.js.
// The user drags an area and chooses where to search. The overlay only draws the
// selection: it hides itself and reports the area, the background script takes the
// screenshot afterwards, so the overlay never ends up in the image.
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
            padding: 8px 16px; border-radius: 999px; pointer-events: none; white-space: nowrap;
            background: rgba(24, 24, 27, 0.92); color: #fff;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        }
        .box {
            position: fixed; box-sizing: border-box; pointer-events: none;
            border: 2px solid #4f8cff;
            box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.45);
        }
        .bar {
            position: fixed; box-sizing: border-box; width: 380px; max-width: calc(100vw - 16px);
            display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px;
            border-radius: 12px; cursor: default; user-select: text; -webkit-user-select: text;
            background: rgba(24, 24, 27, 0.97); color: #fff;
            box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
        }
        .question {
            box-sizing: border-box; flex: 1 1 100%; min-width: 0; padding: 7px 10px;
            border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.25);
            background: rgba(255, 255, 255, 0.08); color: #fff; font: inherit; outline: none;
        }
        .question::placeholder { color: rgba(255, 255, 255, 0.55); }
        .question:focus { border-color: #4f8cff; }
        .btn {
            padding: 6px 12px; border: 0; border-radius: 8px; cursor: pointer;
            background: #3b82f6; color: #fff; font: inherit; font-weight: 600;
        }
        .btn:hover { background: #2563eb; }
        .btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .btn.cancel { margin-left: auto; background: rgba(255, 255, 255, 0.14); font-weight: 500; }
        .btn.cancel:hover { background: rgba(255, 255, 255, 0.24); }
    `;

    let host = null;      // the element added to the page
    let ui = null;        // the elements inside the shadow root
    let config = FALLBACK_CONFIG;
    let dragging = false;
    let anchor = null;    // where the drag started
    let rect = null;      // the selected area, css pixels of the viewport
    let sending = false;


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
        ui.hint = el('div', 'hint', t('capture_hint', 'Drag to select an area. Press Esc to cancel.'));
        ui.box = el('div', 'box');
        ui.box.hidden = true;
        ui.bar = el('div', 'bar');
        ui.bar.hidden = true;
        ui.layer.appendChild(ui.hint);
        ui.layer.appendChild(ui.box);
        ui.layer.appendChild(ui.bar);
        root.appendChild(ui.layer);

        buildBar();

        ui.layer.addEventListener('pointerdown', onPointerDown);
        ui.layer.addEventListener('pointermove', onPointerMove);
        ui.layer.addEventListener('pointerup', onPointerUp);
        ui.layer.addEventListener('pointercancel', onPointerUp);
        // Keep the page from starting a text selection or a drag under the overlay
        ui.layer.addEventListener('mousedown', function(ev){ if(!inBar(ev)) ev.preventDefault(); });
        ui.layer.addEventListener('selectstart', function(ev){ if(!inBar(ev)) ev.preventDefault(); });
        ui.layer.addEventListener('dragstart', function(ev){ ev.preventDefault(); });
        ui.layer.addEventListener('contextmenu', function(ev){ ev.preventDefault(); });
        ui.layer.addEventListener('wheel', function(ev){ ev.preventDefault(); }, {passive: false});

        document.documentElement.appendChild(host);
    }

    function buildBar(){
        // Keeps what was typed when the bar is built again after the settings arrived
        const typedQuestion = ui.question ? ui.question.value : '';

        while(ui.bar.firstChild)
            ui.bar.removeChild(ui.bar.firstChild);

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
        });
        ui.bar.appendChild(ui.question);

        config.targets.forEach(function(target){
            const button = el('button', 'btn', target.label);
            button.type = 'button';
            button.addEventListener('click', function(){ submit(target.id); });
            ui.bar.appendChild(button);
        });

        const cancelButton = el('button', 'btn cancel', t('capture_cancel', 'Cancel'));
        cancelButton.type = 'button';
        cancelButton.addEventListener('click', cancel);
        ui.bar.appendChild(cancelButton);
    }

    function setRect(a, b){
        rect = {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            width: Math.abs(a.x - b.x),
            height: Math.abs(a.y - b.y)
        };

        const style = ui.box.style;
        style.left = rect.x + 'px';
        style.top = rect.y + 'px';
        style.width = rect.width + 'px';
        style.height = rect.height + 'px';
    }

    function placeBar(){
        // It has to be laid out to be measured
        ui.bar.hidden = false;

        const margin = 8;
        const width = ui.bar.offsetWidth;
        const height = ui.bar.offsetHeight;

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

    function resetSelection(){
        dragging = false;
        rect = null;
        if(ui){
            ui.box.hidden = true;
            ui.bar.hidden = true;
            ui.hint.hidden = false;
        }
    }


    // ------------------------------------------------------------ Events

    function onPointerDown(ev){
        if(ev.button !== 0 || sending || inBar(ev))
            return;

        ev.preventDefault();

        dragging = true;
        anchor = point(ev);
        setRect(anchor, anchor);

        ui.bar.hidden = true;
        ui.hint.hidden = true;
        ui.box.hidden = false;

        try{
            ui.layer.setPointerCapture(ev.pointerId);
        }catch(err){}
    }

    function onPointerMove(ev){
        if(dragging)
            setRect(anchor, point(ev));
    }

    function onPointerUp(ev){
        if(!dragging)
            return;

        dragging = false;

        try{
            ui.layer.releasePointerCapture(ev.pointerId);
        }catch(err){}

        if(rect.width < MIN_SIZE || rect.height < MIN_SIZE){
            resetSelection();
            return;
        }

        placeBar();
        ui.question.focus({preventScroll: true});
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

    // The area is relative to the viewport, so it is dropped when the page scrolls
    function onScroll(ev){
        if(!sending && ev.target === document)
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

    function submit(targetId){
        if(!rect || sending)
            return;

        sending = true;

        const message = {
            action: 'captureSubmit',
            target: targetId,
            question: ui.question.value.trim(),
            rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
            viewport: {width: window.innerWidth, height: window.innerHeight}
        };

        // The overlay must not be part of the screenshot
        host.style.setProperty('display', 'none', 'important');

        afterPaint().then(function(){
            try{
                chrome.runtime.sendMessage(message, function(){
                    void chrome.runtime.lastError;
                    cleanup();
                });
            }catch(err){
                // The extension was reloaded or removed
                cleanup();
            }
        });
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
        dragging = false;
        rect = null;
        sending = false;
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
                if(rect && !dragging)
                    placeBar();
            });
        }catch(err){
            // The extension was reloaded or removed, the fallback is used
        }
    }

    window.__selectionSearchCapture = {start: start, cancel: cancel};
    start();
})();
