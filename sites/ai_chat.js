
// Sends queries passed in the url to AI chat sites.
//
// A search engine url like https://gemini.google.com/app?q=%s or
// https://claude.ai/new?q=%s opens the chat, types the query into the prompt
// editor and submits it. The query can also be passed as "prompt" or
// "custom_query". When enabled in the options, the query is only sent in
// Gemini's temporary chat / Claude's incognito mode. The model selection and
// the sidebar are never touched.
//
// Based on the "Gemini 질의 자동 입력" userscript.

(function(){
    'use strict';

    const DEBUG_MODE = false;
    const STATE = {
        INITIAL: 'INITIAL',
        PREPARE_PRIVATE_CHAT: 'PREPARE_PRIVATE_CHAT',
        INJECT_QUERY: 'INJECT_QUERY',
        SENDING: 'SENDING',
        COMPLETED: 'COMPLETED',
        FAILED: 'FAILED'
    };
    const QUERY_PARAMS = ['custom_query', 'q', 'prompt'];
    const PENDING_QUERY_KEY = '__selection_search_ai_chat_pending__';
    const PRIVATE_REDIRECT_KEY = '__selection_search_ai_chat_private_redirect__';

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
        if (sessionStorage.getItem(PRIVATE_REDIRECT_KEY) === targetQuery) return false;
        sessionStorage.setItem(PRIVATE_REDIRECT_KEY, targetQuery);
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
            case STATE.INJECT_QUERY:
                handleInjectQuery();
                break;
            case STATE.SENDING:
                handleSending();
                break;
        }
    }

    function handlePreparePrivateChat() {
        if (site.isPrivateOn()) {
            transitionTo(STATE.INJECT_QUERY);
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
        transitionTo(STATE.SENDING);
    }

    function handleSending() {
        const editor = getPromptEditor();
        if (sendRequested) {
            // A temporarily missing editor is not taken as a successful send
            if (getStopButton() || (editor && getEditorText(editor) === '')) {
                complete();
                return;
            }
        } else {
            if (isPrivateRequired() && !site.isPrivateOn()) {
                fail(i18n('ai_chat_private_lost', [i18n(site.privateModeName)]));
                return;
            }
            const sendButton = getSendButton();
            if (editor && getEditorText(editor) === normalizeText(targetQuery) && sendButton && !isDisabledElement(sendButton)) {
                // Never click twice for the same query, even if the DOM observer runs again
                sendRequested = true;
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

    function complete() {
        stopWatching();
        currentState = STATE.COMPLETED;
        if (getPendingQuery() === targetQuery) sessionStorage.removeItem(PENDING_QUERY_KEY);
        sessionStorage.removeItem(PRIVATE_REDIRECT_KEY);
        lastSent = { query: targetQuery, at: Date.now() };
        targetQuery = null;
        showToast(i18n('ai_chat_sent'), 'success');
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

    function startPendingQuery() {
        if (mainObserver || !site.isEntryPage()) return;
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
            if (!options.ai_chat_autosend) return;

            stageUrlQuery();
            watchNavigation();
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', startPendingQuery, { once: true });
            } else {
                startPendingQuery();
            }
        });
    }

    init();
})();
