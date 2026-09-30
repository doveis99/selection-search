
// Sends queries passed in the url to AI chat sites.
//
// A search engine url like https://gemini.google.com/app?q=%s or
// https://claude.ai/new?q=%s opens the chat, types the query into the prompt
// editor and submits it. The query can also be passed as "prompt" or
// "custom_query". When enabled in the options, the query is only sent in
// Gemini's temporary chat / Claude's incognito mode. The model selection and
// the sidebar are never touched.
//
// It also takes the images of "search by capturing an area" (background/capture.js).
// The url of such a chat has a ss_task parameter, and the image and the question
// are requested from the background script with that id. The image is attached to
// the prompt box first, then the question is typed and, if there is one, sent.
//
// Based on the "Gemini 질의 자동 입력" userscript.

(function(){
    'use strict';

    const DEBUG_MODE = false;
    const STATE = {
        INITIAL: 'INITIAL',
        PREPARE_PRIVATE_CHAT: 'PREPARE_PRIVATE_CHAT',
        ATTACH_IMAGE: 'ATTACH_IMAGE',
        INJECT_QUERY: 'INJECT_QUERY',
        SENDING: 'SENDING',
        COMPLETED: 'COMPLETED',
        FAILED: 'FAILED'
    };
    const QUERY_PARAMS = ['custom_query', 'q', 'prompt'];
    const TASK_PARAM = 'ss_task';
    const PENDING_QUERY_KEY = '__selection_search_ai_chat_pending__';
    const PENDING_TASK_KEY = '__selection_search_ai_chat_task__';
    const PRIVATE_REDIRECT_KEY = '__selection_search_ai_chat_private_redirect__';

    // How long a way of attaching the image gets to show a result
    const ATTACH_WAIT_TIMEOUT = 4000;
    // Long enough for a slow upload to show up, or the next way would attach the image twice
    const ATTACH_VERIFY_TIMEOUT = 6000;
    const ATTACH_TOTAL_TIMEOUT = 60000;
    // A click on the attach button can be lost while the page is still starting up,
    // it is repeated if the menu did not open
    const ATTACH_CLICK_RETRY = 1200;
    const ATTACH_MAX_CLICKS = 3;

    // The send button of a chat is enabled by an attached image alone, so it can be clicked
    // before the page has taken over the typed text or before the image is shown. The click
    // is then ignored or only the image is sent. The text gets a moment to be taken over, and
    // a click that was ignored is repeated a few times.
    const SEND_SETTLE_DELAY = 500;
    const SEND_RETRY_AFTER = 3000;
    const SEND_MAX_CLICKS = 3;
    // An upload indicator that does not go away must not hold the message back for ever
    const SEND_UPLOAD_WAIT_MAX = 15000;
    // The page can rebuild its editor when the image has been processed, and the text is gone
    // with it. It is typed again a few times.
    const SEND_MAX_RETYPES = 3;

    // Must match the defaults in background/storage.js
    const DEFAULT_OPTIONS = {
        ai_chat_autosend: true,
        ai_chat_gemini_temp_chat: true,
        ai_chat_claude_incognito: true,
    };

    let site = null;
    let options = DEFAULT_OPTIONS;
    let currentState = STATE.INITIAL;
    let targetQuery = null;
    let mainObserver = null;
    let stateTimeout = null;
    let wakeQueued = false;
    let stateStartedAt = 0;
    let privateRequested = false;
    let sendRequested = false;
    let lastSent = null;
    let queryEnabled = false;   // the "type and send queries automatically" option
    let targetTask = null;      // the image of an area capture: {id, file}
    let taskStarting = false;
    let attach = null;          // progress of attaching the image
    let textTypedAt = 0;        // when the question was put into the editor
    let sendClicks = 0;
    let lastSendClickAt = 0;
    let retypes = 0;


    // ---------------------------------------------------------------- Gemini

    const GEMINI_TEMP_CHAT_SELECTOR = [
        'gem-icon-button[data-test-id="temp-chat-button"]',
        'gem-icon-button[data-test-id="temporary-chat-button"]',
        '[data-test-id*="temp-chat"]',
        '[data-test-id*="temporary-chat"]',
        'gem-icon-button.temp-chat-button',
        'button.temp-chat-button',
        '[aria-label="임시 채팅"]',
        '[aria-label*="임시 채팅"]',
        'button[aria-label*="Temporary chat"]',
        'button[aria-label*="Temporary Chat"]',
        '[aria-label*="temporary chat"]'
    ].join(', ');

    function getGeminiTempChatRoot() {
        return findFirstVisible(GEMINI_TEMP_CHAT_SELECTOR);
    }

    function isGeminiTempChatOn() {
        const root = getGeminiTempChatRoot();
        return !!document.querySelector('chat-window.is-temporary-chat, .is-temporary-chat')
            || !!(root && (
                root.classList.contains('temp-chat-on')
                || root.closest('.temp-chat-on')
                || root.querySelector('.temp-chat-on')
                || root.getAttribute('aria-pressed') === 'true'
                || getClickableElement(root)?.getAttribute('aria-pressed') === 'true'
            ));
    }

    // Clicks the temporary chat button. Returns true when it was clicked.
    function enableGeminiTempChat() {
        const button = getClickableElement(getGeminiTempChatRoot());
        if (!button || isDisabledElement(button)) return false;
        button.click();
        return true;
    }


    // ---------------------------------------------------------------- Claude

    function isClaudeIncognitoOn() {
        return !!document.querySelector('[data-testid="incognito-frame"]')
            || !!findFirstVisible('button[aria-label="시크릿 모드 종료"], button[aria-label*="Exit incognito" i]');
    }

    // Incognito mode is opened with the url https://claude.ai/new?incognito=true
    // The page is reloaded with that url, the pending query is kept in the
    // session storage. Returns true when the page is reloaded.
    function enableClaudeIncognito() {
        const url = new URL(window.location.href);
        if (url.searchParams.has('incognito')) return false;
        // Only reload once per query, so a changed url format can't cause a reload loop
        const guardKey = targetTask ? targetTask.id : targetQuery;
        if (sessionStorage.getItem(PRIVATE_REDIRECT_KEY) === guardKey) return false;
        sessionStorage.setItem(PRIVATE_REDIRECT_KEY, guardKey);
        url.searchParams.set('incognito', 'true');
        window.location.replace(url.toString());
        return true;
    }


    const SITES = {
        'gemini.google.com': {
            name: 'Gemini',
            privateOption: 'ai_chat_gemini_temp_chat',
            privateModeName: 'ai_chat_mode_gemini',
            isEntryPage: () => true,
            isPrivateOn: isGeminiTempChatOn,
            enablePrivate: enableGeminiTempChat,
            editorSelectors: [
                'div[aria-label="Gemini 프롬프트 입력"][contenteditable="true"]',
                'div[aria-label="Enter a prompt here"][contenteditable="true"]',
                '[data-placeholder="Gemini에게 물어보기"][contenteditable="true"]',
                '[role="textbox"][contenteditable="true"]',
                'rich-textarea [contenteditable="true"]',
                '.ql-editor[contenteditable="true"]'
            ],
            sendSelector: [
                'gem-icon-button.send-button',
                '.send-button',
                'button[aria-label="메시지 보내기"]',
                'button[aria-label="프롬프트 보내기"]',
                'button[aria-label="Send message"]',
                'button[aria-label*="Send"]',
                'button[data-test-id*="send"]',
                'button[data-testid*="send"]'
            ].join(', '),
            stopSelector: [
                'button[aria-label*="중지"]',
                'button[aria-label*="Stop"]',
                'button[aria-label*="생성 중지"]',
                'gem-icon-button[aria-label*="Stop"]',
                'gem-icon-button[aria-label*="중지"]',
                '[data-test-id*="stop"]',
                '.stop-button'
            ].join(', '),
            // Gemini creates its file inputs when the upload menu is opened. While the
            // page starts up it shows placeholder buttons that do nothing, so only the
            // button that opens a menu is taken.
            attachTriggerSelector: [
                'button[aria-haspopup="menu"][aria-label*="업로드"]',
                'button[aria-haspopup="menu"][aria-label*="Upload" i]'
            ].join(', '),
            attachmentSelector: 'uploader-file-preview, .file-preview-chip, .gem-attachment',
            uploadingSelector: 'uploader-file-preview mat-spinner, .gem-attachment-content.loading, .gem-attachment-loading-container',
            // The preview of the image is rendered a moment after it was handed over, and
            // there is no upload indicator before that, so the message waits for it
            attachmentRequiredToSend: true,
            // The class of the editor while the page still thinks that it is empty
            blankEditorSelector: '.ql-blank',
        },
        'claude.ai': {
            name: 'Claude',
            privateOption: 'ai_chat_claude_incognito',
            privateModeName: 'ai_chat_mode_claude',
            // Queries are only accepted on the new chat page, other pages use "q" for searching
            isEntryPage: () => /^\/new\/?$/.test(window.location.pathname),
            isPrivateOn: isClaudeIncognitoOn,
            enablePrivate: enableClaudeIncognito,
            editorSelectors: [
                '[data-testid="chat-input"][contenteditable="true"]',
                'div.ProseMirror[contenteditable="true"]',
                '[role="textbox"][contenteditable="true"]'
            ],
            sendSelector: [
                'button[data-testid="chat-input-send"]',
                'button[aria-label="메시지 보내기"]',
                'button[aria-label="Send message"]',
                'button[aria-label="Send Message"]'
            ].join(', '),
            stopSelector: [
                'button[aria-label*="중지"]',
                'button[aria-label*="Stop"]'
            ].join(', '),
            // Claude has a file input in the page all the time, the button is only a fallback
            attachTriggerSelector: [
                'button[data-testid="chat-input-attach"]',
                'button[aria-haspopup="menu"][aria-label*="파일, 커넥터"]',
                'button[aria-haspopup="menu"][aria-label*="Add files" i]'
            ].join(', '),
            attachmentSelector: '[data-testid="file-thumbnail"], [data-testid*="attachment" i], [data-testid*="thumbnail" i]',
            uploadingSelector: '[data-testid="file-thumbnail"] [role="progressbar"], [data-testid*="thumbnail" i] [role="progressbar"]',
            // The placeholder of the editor, it is removed when the editor has taken over text
            blankEditorSelector: '.is-editor-empty',
        },
    };


    // ---------------------------------------------------------------- DOM helpers

    function isVisibleElement(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function findFirstVisible(selector) {
        return Array.from(document.querySelectorAll(selector)).find(isVisibleElement) || null;
    }

    function getClickableElement(el) {
        if (!el) return null;
        if (el.matches('button, a, [role="button"], [role="menuitem"], [role="menuitemradio"]')) {
            return el;
        }
        return el.querySelector('button, [role="button"], [role="menuitem"], [role="menuitemradio"]') || el;
    }

    function isDisabledElement(el) {
        const target = getClickableElement(el);
        return [el, target].filter(Boolean).some(node =>
            node.disabled === true || node.hasAttribute('disabled') ||
            node.getAttribute('aria-disabled') === 'true' ||
            /(^|\s)(?:disabled|gem-button-disabled)(?:\s|$)/.test(node.className || '')
        );
    }

    // Whitespace is compared loosely, because the editors turn newlines into
    // paragraphs that are read back with extra blank lines.
    function normalizeText(text) {
        return text.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
    }

    function getEditorText(editor) {
        if (!editor) return '';
        return normalizeText(typeof editor.value === 'string'
            ? editor.value
            : (editor.innerText || editor.textContent || ''));
    }

    function getPromptEditor() {
        for (const selector of site.editorSelectors) {
            const editor = findFirstVisible(selector);
            if (editor) return editor;
        }
        return null;
    }

    function isPrivateRequired() {
        return !!options[site.privateOption];
    }

    function getSendButton() {
        const candidates = Array.from(document.querySelectorAll(site.sendSelector));
        return candidates.find(el => isVisibleElement(el) && !isDisabledElement(el))
            || candidates.find(isVisibleElement)
            || null;
    }

    function getStopButton() {
        return findFirstVisible(site.stopSelector);
    }

    function logDebug(message, ...args) {
        if (DEBUG_MODE) {
            console.log(`[Selection Search AI chat][${currentState}]`, message, ...args);
        }
    }

    function i18n(key, substitutions) {
        try {
            return chrome.i18n.getMessage(key, substitutions) || key;
        } catch (error) {
            // The extension was reloaded or removed
            return key;
        }
    }


    // ---------------------------------------------------------------- Query from the url

    function getTargetQuery() {
        if (!site.isEntryPage()) return null;
        const urlParams = new URLSearchParams(window.location.search);
        for (const paramName of QUERY_PARAMS) {
            const value = urlParams.get(paramName);
            if (value && value.trim()) return value.trim();
        }
        return null;
    }

    function cleanQueryParams() {
        const url = new URL(window.location.href);
        let changed = false;
        for (const paramName of QUERY_PARAMS) {
            if (url.searchParams.has(paramName)) {
                url.searchParams.delete(paramName);
                changed = true;
            }
        }
        if (changed) window.history.replaceState(window.history.state, '', url.toString());
    }

    function getPendingQuery() {
        return sessionStorage.getItem(PENDING_QUERY_KEY);
    }

    // Moves the query from the url to the session storage, so it is not sent
    // again when the page is reloaded after it was sent.
    function stageUrlQuery() {
        const query = getTargetQuery();
        if (!query) return;
        sessionStorage.setItem(PENDING_QUERY_KEY, query);
        sessionStorage.removeItem(PRIVATE_REDIRECT_KEY);
        cleanQueryParams();
    }

    // ---------------------------------------------------------------- Image of an area capture

    function getUrlTaskId() {
        if (!site.isEntryPage()) return null;
        const taskId = new URLSearchParams(window.location.search).get(TASK_PARAM);
        return taskId && /^[0-9a-f-]{36}$/.test(taskId) ? taskId : null;
    }

    function getPendingTask() {
        return sessionStorage.getItem(PENDING_TASK_KEY);
    }

    // Moves the task id from the url to the session storage, so the task also
    // survives a reload of the page, e.g. the one that switches to incognito mode.
    function stageUrlTask() {
        const taskId = getUrlTaskId();
        if (!taskId) return;
        sessionStorage.setItem(PENDING_TASK_KEY, taskId);
        sessionStorage.removeItem(PRIVATE_REDIRECT_KEY);
        const url = new URL(window.location.href);
        url.searchParams.delete(TASK_PARAM);
        window.history.replaceState(window.history.state, '', url.toString());
    }

    function requestTask(taskId) {
        return new Promise(resolve => {
            try {
                chrome.runtime.sendMessage({action: 'getCaptureTask', taskId: taskId}, response => {
                    if (chrome.runtime.lastError) {
                        resolve(null);
                        return;
                    }
                    resolve(response && response.task ? response.task : null);
                });
            } catch (error) {
                // The extension was reloaded or removed
                resolve(null);
            }
        });
    }

    // Lets the background script forget the image
    function finishTask() {
        if (!targetTask) return;
        sessionStorage.removeItem(PENDING_TASK_KEY);
        try {
            chrome.runtime.sendMessage({action: 'finishCaptureTask', taskId: targetTask.id}, () => {
                void chrome.runtime.lastError;
            });
        } catch (error) {
            // The extension was reloaded or removed
        }
        targetTask = null;
    }

    function dataUrlToFile(dataUrl, filename, mimeType) {
        const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new File([bytes], filename, {type: mimeType});
    }

    // The clipboard is the way out when the image can't be attached, both chats
    // accept a pasted image.
    async function copyImageToClipboard(file) {
        try {
            let blob = file;
            if (file.type !== 'image/png') {
                const bitmap = await createImageBitmap(file);
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                canvas.getContext('2d').drawImage(bitmap, 0, 0);
                blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            }
            await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
            return true;
        } catch (error) {
            return false;
        }
    }


    // ---------------------------------------------------------------- Attaching the image

    // Claude lists only the extensions of the images in accept, the other pages use image/*
    function findFileInput() {
        const accepted = input => (input.getAttribute('accept') || '').toLowerCase();
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
            .filter(input => !input.disabled && !input.hasAttribute('webkitdirectory'));
        return inputs.find(input => /image\/\*/.test(accepted(input)))
            || inputs.find(input => /image\/|\.(png|jpe?g|webp|gif)\b/.test(accepted(input)))
            || inputs.find(input => !accepted(input) || accepted(input) === '*/*')
            || null;
    }

    function isSendEnabled() {
        const button = getSendButton();
        return !!button && !isDisabledElement(button);
    }

    // What shows that an image is attached: preview images, the attachment element
    // of the site, or a send button that is enabled while there is no text.
    function getAttachmentSignal() {
        return {
            images: document.querySelectorAll('img[src^="blob:"]').length,
            chips: site.attachmentSelector ? document.querySelectorAll(site.attachmentSelector).length : 0,
            sendable: isSendEnabled()
        };
    }

    function hasAttachmentEvidence(baseline) {
        const current = getAttachmentSignal();
        return current.images > baseline.images
            || current.chips > baseline.chips
            || (current.sendable && !baseline.sendable);
    }

    function setInputFiles(input, file) {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
    }

    // The ways to hand the image to the page, tried in this order. Each returns
    // 'done' when it handed the image over, 'wait' when it needs more time and
    // 'skip' when it does not apply to the page.
    const ATTACH_WAYS = [
        function fileInput(file) {
            const input = findFileInput();
            if (input) {
                setInputFiles(input, file);
                return 'done';
            }
            // Give the menu time to open and create the input after a click
            if (attach.triggerClicked && Date.now() - attach.lastClickAt < ATTACH_CLICK_RETRY) return 'wait';
            if (attach.clicks >= ATTACH_MAX_CLICKS) return 'wait';
            const trigger = getClickableElement(findFirstVisible(site.attachTriggerSelector));
            logAttach(() => `attach button: ${trigger ? (isDisabledElement(trigger) ? 'disabled' : 'found') : 'missing'}` +
                (trigger ? ` <${trigger.tagName.toLowerCase()} aria-label="${trigger.getAttribute('aria-label')}">` : ''));
            // The page may still be starting up, a missing or disabled button is waited for
            if (!trigger || isDisabledElement(trigger)) return 'wait';
            // Clicking again would close the menu that is already open
            if (trigger.getAttribute('aria-expanded') === 'true') return 'wait';
            // Opens the menu that creates the input
            attach.triggerClicked = true;
            attach.clicks += 1;
            attach.lastClickAt = Date.now();
            attach.trigger = trigger;
            trigger.click();
            logAttach(() => `attach button clicked (${attach.clicks}), aria-expanded=${trigger.getAttribute('aria-expanded')}`);
            return 'wait';
        },
        function paste(file) {
            const editor = getPromptEditor();
            if (!editor) return 'skip';
            const transfer = new DataTransfer();
            transfer.items.add(file);
            editor.focus();
            editor.dispatchEvent(new ClipboardEvent('paste', {clipboardData: transfer, bubbles: true, cancelable: true}));
            return 'done';
        },
        function drop(file) {
            const editor = getPromptEditor();
            if (!editor) return 'skip';
            const transfer = new DataTransfer();
            transfer.items.add(file);
            const zone = editor.closest('form, fieldset') || editor;
            ['dragenter', 'dragover', 'drop'].forEach(type => {
                zone.dispatchEvent(new DragEvent(type, {dataTransfer: transfer, bubbles: true, cancelable: true}));
            });
            return 'done';
        }
    ];

    // The menu that was opened to get the file input would stay open on the page
    function closeAttachMenu() {
        if (!attach || !attach.trigger) return;
        const trigger = attach.trigger;
        attach.trigger = null;
        if (trigger.getAttribute('aria-expanded') === 'true') {
            trigger.click();
        } else if (typeof KeyboardEvent === 'function') {
            document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true}));
        }
    }

    function nextAttachWay() {
        closeAttachMenu();
        attach.index += 1;
        attach.phase = 'run';
        attach.phaseStartedAt = Date.now();
        attach.triggerClicked = false;
        attach.clicks = 0;
        attach.baseline = getAttachmentSignal();
    }


    function showToast(message, type = 'info') {
        const toastId = 'selection-search-ai-chat-toast';
        let toast = document.getElementById(toastId);
        if (toast) toast.remove();
        toast = document.createElement('div');
        toast.id = toastId;
        Object.assign(toast.style, {
            position: 'fixed', top: '20px', right: '20px', padding: '15px 25px',
            borderRadius: '8px', color: 'white', fontSize: '16px', zIndex: '99999',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)', transition: 'opacity 0.5s, transform 0.3s'
        });
        toast.textContent = message;
        const colors = { success: '#4CAF50', error: '#f44336', warning: '#ff9800', info: '#2196F3' };
        toast.style.backgroundColor = colors[type] || colors.info;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            setTimeout(() => toast.remove(), 500);
        }, 3000);
    }


    // ---------------------------------------------------------------- State machine

    function scheduleProcess(delay = 250) {
        if (stateTimeout !== null) clearTimeout(stateTimeout);
        stateTimeout = setTimeout(() => {
            stateTimeout = null;
            processCurrentState();
        }, delay);
    }

    function transitionTo(newState) {
        if (currentState === newState) return;
        logDebug(`Transition: ${currentState} -> ${newState}`);
        currentState = newState;
        stateStartedAt = Date.now();
        if (stateTimeout !== null) clearTimeout(stateTimeout);
        stateTimeout = null;
        processCurrentState();
    }

    function processCurrentState() {
        switch (currentState) {
            case STATE.PREPARE_PRIVATE_CHAT:
                handlePreparePrivateChat();
                break;
            case STATE.ATTACH_IMAGE:
                handleAttachImage();
                break;
            case STATE.INJECT_QUERY:
                handleInjectQuery();
                break;
            case STATE.SENDING:
                handleSending();
                break;
        }
    }

    // The image is attached first, the private chat has to be active by then because
    // switching to it starts a new chat and would drop the attachment.
    function nextStateAfterPrivate() {
        return targetTask ? STATE.ATTACH_IMAGE : STATE.INJECT_QUERY;
    }

    // Queries from the url are always sent. The question of an image is only sent
    // if there is one and sending queries automatically is turned on.
    function shouldSend() {
        return !targetTask || (queryEnabled && !!targetQuery);
    }

    function handlePreparePrivateChat() {
        if (site.isPrivateOn()) {
            transitionTo(nextStateAfterPrivate());
            return;
        }
        if (Date.now() - stateStartedAt >= 20000) {
            fail(i18n('ai_chat_private_failed', [i18n(site.privateModeName)]));
            return;
        }
        // Only switch once and wait for the private chat to become active,
        // switching again could turn it off.
        if (!privateRequested && site.enablePrivate()) {
            privateRequested = true;
        }
        scheduleProcess();
    }

    function handleAttachImage() {
        if (Date.now() - stateStartedAt >= ATTACH_TOTAL_TIMEOUT) {
            attachFailed();
            return;
        }

        const editor = getPromptEditor();
        if (!editor) {
            if (Date.now() - stateStartedAt >= 30000) {
                fail(i18n('ai_chat_no_editor', [site.name]));
            } else {
                scheduleProcess();
            }
            return;
        }

        if (!attach) {
            attach = {
                index: 0,
                phase: 'run',
                phaseStartedAt: Date.now(),
                baseline: getAttachmentSignal(),
                trigger: null,
                triggerClicked: false,
                clicks: 0,
                lastClickAt: 0
            };
        }

        const way = ATTACH_WAYS[attach.index];
        if (!way) {
            attachFailed();
            return;
        }

        if (attach.phase === 'run') {
            const result = way(targetTask.file);
            logAttach(() => `way ${attach.index} (${way.name}): ${result}`);
            if (result === 'done') {
                attach.phase = 'verify';
                attach.phaseStartedAt = Date.now();
            } else if (result === 'skip' || Date.now() - attach.phaseStartedAt >= ATTACH_WAIT_TIMEOUT) {
                nextAttachWay();
            }
        } else if (hasAttachmentEvidence(attach.baseline)) {
            logAttach(() => `way ${attach.index} (${way.name}): the image is attached`);
            attachSucceeded();
            return;
        } else if (Date.now() - attach.phaseStartedAt >= ATTACH_VERIFY_TIMEOUT) {
            // Nothing showed up, try the next way
            logAttach(() => `way ${attach.index} (${way.name}): nothing showed up, trying the next way`);
            nextAttachWay();
        }

        scheduleProcess(150);
    }

    // The progress of the attaching is polled, so only changes are logged. The message
    // is a function because building it is not needed when the logging is off.
    let lastAttachLog = '';
    function logAttach(getMessage) {
        if (!DEBUG_MODE) return;
        const message = getMessage();
        if (message === lastAttachLog) return;
        lastAttachLog = message;
        logDebug(message);
    }

    function attachSucceeded() {
        closeAttachMenu();
        attach = null;

        if (targetQuery) {
            transitionTo(STATE.INJECT_QUERY);
            return;
        }

        // Only the image, the question is typed by the user
        const editor = getPromptEditor();
        if (editor) editor.focus();
        complete('ai_chat_image_attached');
    }

    function attachFailed() {
        closeAttachMenu();
        attach = null;
        stopWatching();
        // Already queued DOM events must not start the attaching again while the clipboard is written
        currentState = STATE.FAILED;

        copyImageToClipboard(targetTask.file).then(copied => {
            fail(i18n('ai_chat_attach_failed', [site.name]) + (copied ? ' ' + i18n('capture_copied_hint') : ''));
        });
    }

    function handleInjectQuery() {
        const editor = getPromptEditor();
        if (!editor) {
            if (Date.now() - stateStartedAt >= 30000) {
                fail(i18n('ai_chat_no_editor', [site.name]));
            } else {
                scheduleProcess();
            }
            return;
        }

        const expected = normalizeText(targetQuery);
        editor.focus();
        let inserted = getEditorText(editor) === expected;
        if (!inserted) {
            try {
                document.execCommand('selectAll', false, null);
                document.execCommand('delete', false, null);
                inserted = document.execCommand('insertText', false, targetQuery)
                    && getEditorText(editor) === expected;
            } catch (error) {
                logDebug('execCommand failed, using fallback', error);
            }
        }
        if (!inserted) {
            editor.textContent = targetQuery;
            inserted = getEditorText(editor) === expected;
        }
        editor.dispatchEvent(new InputEvent('input', {
            bubbles: true, inputType: 'insertText', data: targetQuery
        }));
        if (!inserted) {
            fail(i18n('ai_chat_insert_failed', [site.name]));
            return;
        }
        textTypedAt = Date.now();
        if (shouldSend()) {
            transitionTo(STATE.SENDING);
        } else {
            // The image and the question are in place, sending is left to the user
            complete('ai_chat_image_question_ready');
        }
    }

    // The message with an image may only be sent when the page has taken over the text and
    // shows the image, which is not uploading anymore. Queries from the url have no image, and
    // their send button is only enabled once the page has taken over the text.
    function isReadyToSend(editor) {
        if (!targetTask) return true;
        if (Date.now() - textTypedAt < SEND_SETTLE_DELAY) return false;
        if (site.blankEditorSelector && (editor.matches(site.blankEditorSelector) || editor.querySelector(site.blankEditorSelector))) return false;
        if (site.attachmentRequiredToSend && !document.querySelector(site.attachmentSelector)) return false;
        if (site.uploadingSelector && document.querySelector(site.uploadingSelector)
                && Date.now() - textTypedAt < SEND_UPLOAD_WAIT_MAX) return false;
        return true;
    }

    function handleSending() {
        const editor = getPromptEditor();
        if (sendRequested) {
            // A temporarily missing editor is not taken as a successful send
            if (getStopButton() || (editor && getEditorText(editor) === '')) {
                complete();
                return;
            }
            // A click of an image chat can be ignored by the page. The text is still there and
            // nothing is being generated then, so the button is clicked again a few times.
            if (targetTask && sendClicks < SEND_MAX_CLICKS && Date.now() - lastSendClickAt >= SEND_RETRY_AFTER
                    && editor && getEditorText(editor) === normalizeText(targetQuery)) {
                logDebug('The click was ignored, sending again');
                sendRequested = false;
            }
        }
        if (!sendRequested) {
            if (isPrivateRequired() && !site.isPrivateOn()) {
                fail(i18n('ai_chat_private_lost', [i18n(site.privateModeName)]));
                return;
            }
            // The text was typed before, so an empty editor means that the page dropped it
            if (targetTask && editor && getEditorText(editor) === '' && retypes < SEND_MAX_RETYPES) {
                retypes += 1;
                logDebug('The page dropped the text, typing it again');
                transitionTo(STATE.INJECT_QUERY);
                return;
            }
            const sendButton = getSendButton();
            if (editor && getEditorText(editor) === normalizeText(targetQuery) && sendButton && !isDisabledElement(sendButton) && isReadyToSend(editor)) {
                // Never click twice for the same query, even if the DOM observer runs again
                sendRequested = true;
                sendClicks += 1;
                lastSendClickAt = Date.now();
                stateStartedAt = Date.now();
                getClickableElement(sendButton).click();
            }
        }
        if (Date.now() - stateStartedAt >= 30000) {
            fail(i18n(sendRequested ? 'ai_chat_send_unconfirmed' : 'ai_chat_no_send_button'));
            return;
        }
        scheduleProcess();
    }

    function stopWatching() {
        if (mainObserver) mainObserver.disconnect();
        mainObserver = null;
        if (stateTimeout !== null) clearTimeout(stateTimeout);
        stateTimeout = null;
    }

    function complete(messageKey = 'ai_chat_sent') {
        stopWatching();
        currentState = STATE.COMPLETED;
        if (getPendingQuery() === targetQuery) sessionStorage.removeItem(PENDING_QUERY_KEY);
        sessionStorage.removeItem(PRIVATE_REDIRECT_KEY);
        finishTask();
        lastSent = { query: targetQuery, at: Date.now() };
        targetQuery = null;
        showToast(i18n(messageKey), 'success');
        queueMicrotask(startPendingQuery);
    }

    function fail(message) {
        stopWatching();
        currentState = STATE.FAILED;
        logDebug(message);
        showToast(message, 'error');
        // The pending query is kept, so it is tried again when the page is reloaded
    }

    function setupObserver() {
        mainObserver = new MutationObserver(() => {
            if (wakeQueued) return;
            wakeQueued = true;
            queueMicrotask(() => {
                wakeQueued = false;
                processCurrentState();
            });
        });
        mainObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'disabled', 'aria-pressed', 'aria-disabled', 'aria-label']
        });
    }

    // Loads the image of an area capture and starts with it
    function startPendingTask(taskId) {
        taskStarting = true;
        requestTask(taskId).then(task => {
            taskStarting = false;

            let file = null;
            try {
                file = task ? dataUrlToFile(task.imageDataUrl, task.filename, task.mimeType) : null;
            } catch (error) {
                logDebug('The image could not be read', error);
            }

            if (!file) {
                sessionStorage.removeItem(PENDING_TASK_KEY);
                showToast(i18n('ai_chat_task_expired'), 'error');
                return;
            }

            targetTask = {id: taskId, file: file};
            targetQuery = task.question || '';
            privateRequested = false;
            sendRequested = false;
            sendClicks = 0;
            retypes = 0;
            attach = null;
            currentState = STATE.INITIAL;
            setupObserver();
            transitionTo(isPrivateRequired() ? STATE.PREPARE_PRIVATE_CHAT : STATE.ATTACH_IMAGE);
        });
    }

    function startPendingQuery() {
        if (mainObserver || taskStarting || !site.isEntryPage()) return;

        const taskId = getPendingTask();
        if (taskId) {
            startPendingTask(taskId);
            return;
        }

        if (!queryEnabled) return;
        const query = getPendingQuery();
        if (!query) return;
        targetQuery = query;
        privateRequested = false;
        sendRequested = false;
        currentState = STATE.INITIAL;
        setupObserver();
        transitionTo(isPrivateRequired() ? STATE.PREPARE_PRIVATE_CHAT : STATE.INJECT_QUERY);
    }

    function onNavigate() {
        const query = getTargetQuery();
        if (!query) return;
        // Some single page apps put the removed query back into the url when
        // they update it, so the query that was just sent is not sent again.
        if (lastSent && lastSent.query === query && Date.now() - lastSent.at < 10000) {
            cleanQueryParams();
            return;
        }
        stageUrlQuery();
        startPendingQuery();
    }

    function watchNavigation() {
        // Detects navigations inside the single page app, e.g. when a search is
        // opened in an installed web app that routes the url itself. The
        // navigation api also reports history.pushState calls made by the page.
        if (window.navigation) {
            window.navigation.addEventListener('currententrychange', () => queueMicrotask(onNavigate));
        } else {
            window.addEventListener('popstate', () => queueMicrotask(onNavigate));
        }
    }

    function loadOptions(callback) {
        try {
            chrome.storage.local.get('options', function(values){
                if (chrome.runtime.lastError) return;
                callback({...DEFAULT_OPTIONS, ...(values && values.options)});
            });
        } catch (error) {
            // The extension was reloaded or removed
        }
    }

    function init() {
        site = SITES[window.location.hostname] || null;
        if (!site) return;

        loadOptions(function(loadedOptions){
            options = loadedOptions;
            // Turning off the automatic sending only stops the queries from the url,
            // images of an area capture are still attached
            queryEnabled = !!options.ai_chat_autosend;

            if (queryEnabled) {
                stageUrlQuery();
                watchNavigation();
            }
            stageUrlTask();
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', startPendingQuery, { once: true });
            } else {
                startPendingQuery();
            }
        });
    }

    init();
})();
