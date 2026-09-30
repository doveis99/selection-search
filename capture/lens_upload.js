
// Puts a captured image into the upload box of Google Lens.
//
// background/capture.js opens https://lens.google.com/ in a new tab. Google
// redirects it to the Google start page, where the Lens upload dialog is already
// open and has a hidden file input. Setting the image on that input makes the page
// upload it like a picked file. Posting the image to the Lens upload url from
// another origin is rejected by Google (403), so it has to happen on the page.

(function(){
    'use strict';

    if(window.top !== window)
        return;

    // The upload dialog is on the start page, other Google pages have nothing to do here
    if(window.location.pathname !== '/')
        return;

    if(window.__selectionSearchLensUpload)
        return;
    window.__selectionSearchLensUpload = true;

    const DEBUG_MODE = false;
    const startedAt = Date.now();

    function logDebug(...args) {
        if (DEBUG_MODE) console.log(`[Selection Search Lens +${Date.now() - startedAt}ms]`, ...args);
    }

    // The page has other file inputs (they accept several files) that belong to other parts
    // of the dialog and exist from the start. The one that uploads a single image is
    // added later, the others are only tried if it never shows up.
    const INPUT_SELECTOR = 'input[type="file"][name="encoded_image"]';
    const FALLBACK_INPUT_SELECTOR = 'input[type="file"][accept*="image/"]:not([multiple])';
    const FALLBACK_DELAY = 8000;
    const INPUT_TIMEOUT = 20000;


    function i18n(key){
        try{
            return chrome.i18n.getMessage(key) || key;
        }catch(err){
            return key;
        }
    }

    function showToast(message, type){
        const toastId = 'selection-search-lens-toast';
        let toast = document.getElementById(toastId);
        if(toast)
            toast.remove();
        toast = document.createElement('div');
        toast.id = toastId;
        Object.assign(toast.style, {
            position: 'fixed', top: '20px', right: '20px', maxWidth: '360px', padding: '15px 25px',
            borderRadius: '8px', color: 'white', fontSize: '15px', lineHeight: '1.4', zIndex: '2147483647',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)', transition: 'opacity 0.5s',
            backgroundColor: type === 'error' ? '#f44336' : '#2196F3'
        });
        toast.textContent = message;
        document.documentElement.appendChild(toast);
        setTimeout(function(){
            toast.style.opacity = '0';
            setTimeout(function(){ toast.remove(); }, 500);
        }, 8000);
    }

    function dataUrlToFile(dataUrl, filename, mimeType){
        const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
        const bytes = new Uint8Array(binary.length);
        for(let i = 0; i < binary.length; i++)
            bytes[i] = binary.charCodeAt(i);
        return new File([bytes], filename, {type: mimeType});
    }

    function findInput(allowFallback){
        return document.querySelector(INPUT_SELECTOR) ||
            (allowFallback ? document.querySelector(FALLBACK_INPUT_SELECTOR) : null);
    }

    function waitForInput(){
        return new Promise(function(resolve){
            const waitStarted = Date.now();
            let observer = null;
            let timer = null;

            function finish(input){
                if(observer)
                    observer.disconnect();
                clearInterval(timer);
                clearTimeout(timeout);
                resolve(input);
            }

            function check(){
                const input = findInput(Date.now() - waitStarted >= FALLBACK_DELAY);
                if(input)
                    finish(input);
            }

            const timeout = setTimeout(function(){ finish(null); }, INPUT_TIMEOUT);
            observer = new MutationObserver(check);
            observer.observe(document.documentElement, {childList: true, subtree: true});
            timer = setInterval(check, 500);
            check();
        });
    }

    // The clipboard is the way out when the upload box could not be filled, both
    // the Lens dialog and the AI chats accept a pasted image.
    async function copyImageToClipboard(file){
        try{
            let blob = file;
            if(file.type !== 'image/png'){
                const bitmap = await createImageBitmap(file);
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                canvas.getContext('2d').drawImage(bitmap, 0, 0);
                blob = await new Promise(function(resolve){ canvas.toBlob(resolve, 'image/png'); });
            }
            await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
            return true;
        }catch(err){
            return false;
        }
    }

    function finishTask(taskId){
        try{
            chrome.runtime.sendMessage({action: 'finishCaptureTask', taskId: taskId}, function(){
                void chrome.runtime.lastError;
            });
        }catch(err){
            // The extension was reloaded or removed
        }
    }

    async function upload(task){
        logDebug('got the task', task.filename, task.size, 'bytes');
        const file = dataUrlToFile(task.imageDataUrl, task.filename, task.mimeType);
        const input = await waitForInput();
        logDebug('input', input ? `${input.name || '(no name)'} accept=${input.getAttribute('accept')} multiple=${input.multiple}` : 'not found');

        if(!input){
            const copied = await copyImageToClipboard(file);
            showToast(i18n('capture_lens_failed') + (copied ? ' ' + i18n('capture_copied_hint') : ''), 'error');
            finishTask(task.id);
            return;
        }

        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        logDebug('files set:', input.files.length);
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
        logDebug('change dispatched');

        finishTask(task.id);
    }

    try{
        chrome.runtime.sendMessage({action: 'getLensTask'}, function(response){
            if(chrome.runtime.lastError || !response || !response.task)
                return;
            upload(response.task);
        });
    }catch(err){
        // The extension was reloaded or removed
    }
})();
