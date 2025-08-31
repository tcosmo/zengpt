(() => {
    'use strict';

    const OVERLAY_CLASS_NAME = 'zengpt-overlay';
    const PARENT_RELATIVE_CLASS_NAME = 'zengpt-relative';
    const DEBUG_BADGE_CLASS_NAME = 'zengpt-debug-badge';
    const STORAGE_KEY_DEBUG = 'zengpt:debugEnabled';
    const SCRIPT_VERSION = '0.1.0';
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const GENERATING_CLASS_NAME = 'zengpt-generating';
    const USE_OVERLAY = true; // prefer overlay strategy

    let lastAssistantMutationAt = 0; // reserved
    let lastAssistantTextLen = 0;
    let lastAssistantTextLenAt = 0;

    function getDebugEnabled() {
        try {
            return localStorage.getItem(STORAGE_KEY_DEBUG) === '1';
        } catch (_) {
            return false;
        }
    }

    function setDebugEnabled(enabled) {
        try {
            localStorage.setItem(STORAGE_KEY_DEBUG, enabled ? '1' : '0');
        } catch (_) { }
    }

    function log(...args) {
        if (getDebugEnabled()) {
            // Use a consistent prefix for easy filtering
            console.log('[ZenGPT]', ...args);
        }
    }

    // Always show a startup log so we know the script is active
    try {
        console.log('[ZenGPT] Content script loaded v' + SCRIPT_VERSION);
        console.log('[ZenGPT] Toggle debug with ' + (isMac ? 'Cmd+Shift+Z' : 'Ctrl+Shift+Z') + ' (Alt+Shift+Z fallback).');
    } catch (_) { }

    function debounce(fn, wait) {
        let timeoutId = null;
        return function debounced(...args) {
            if (timeoutId) window.clearTimeout(timeoutId);
            timeoutId = window.setTimeout(() => fn.apply(this, args), wait);
        };
    }

    function isGenerating() {
        try {
            const buttons = document.querySelectorAll('button');
            for (const button of buttons) {
                const text = (button.textContent || '').trim().toLowerCase();
                const aria = (button.getAttribute('aria-label') || '').trim().toLowerCase();
                if (text.includes('stop generating') || text === 'stop' || aria.includes('stop generating') || aria === 'stop') {
                    log('Detected generating via Stop button');
                    return true;
                }
            }
            if (document.querySelector('[data-testid="gizmo-result-streaming"], .result-streaming')) {
                log('Detected generating via streaming testid/class');
                return true;
            }

            const container = getLastAssistantMessageContainer();
            if (container) {
                if (container.getAttribute('aria-busy') === 'true') {
                    log('Detected generating via aria-busy=true');
                    return true;
                }

                // Heuristic: infer streaming if assistant text is actively growing
                const messageEl = container.querySelector('.text-message, .markdown, [data-message-author-role="assistant"]') || container;
                const now = Date.now();
                let len = 0;
                try { len = (messageEl.textContent || '').length; } catch (_) { len = 0; }
                if (len !== lastAssistantTextLen) {
                    lastAssistantTextLen = len;
                    lastAssistantTextLenAt = now;
                }
                // If text changed within the last 700ms and is non-trivial, assume streaming
                if (len > 5 && (now - lastAssistantTextLenAt) < 700) {
                    log('Detected generating via growing text len');
                    return true;
                }
            }
        } catch (_) { }
        return false;
    }

    function getLastAssistantMessageContainer() {
        // Prefer the message content container inside the assistant turn
        const assistantTurns = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (assistantTurns && assistantTurns.length > 0) {
            const lastTurn = assistantTurns[assistantTurns.length - 1];
            const textMessage = lastTurn.querySelector('.text-message') || lastTurn;
            return textMessage;
        }

        // Fallback: target container following the screen-reader header "ChatGPT said:"
        const headers = Array.from(document.querySelectorAll('h6.sr-only'));
        for (let i = headers.length - 1; i >= 0; i--) {
            const h = headers[i];
            const label = (h.textContent || '').trim().toLowerCase();
            if (label.includes('chatgpt said')) {
                // The assistant content is typically within the next sibling turn container
                let sibling = h.nextElementSibling;
                while (sibling && sibling.tagName === 'H6') sibling = sibling.nextElementSibling;
                if (sibling) return sibling;
            }
        }

        // Broader fallbacks
        const conversationTurns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
        for (let i = conversationTurns.length - 1; i >= 0; i--) {
            const turn = conversationTurns[i];
            const hasAssistantIcon = !!turn.querySelector('svg[aria-label*="Assistant" i], svg[aria-label*="ChatGPT" i]');
            if (hasAssistantIcon) return turn;
        }
        return null;
    }

    function ensureOverlay(container) {
        if (!container) return;
        if (!USE_OVERLAY) return;
        if (container.querySelector(`.${OVERLAY_CLASS_NAME}`)) return;

        container.classList.add(PARENT_RELATIVE_CLASS_NAME);

        const overlay = document.createElement('div');
        overlay.className = OVERLAY_CLASS_NAME;
        overlay.setAttribute('role', 'note');
        overlay.setAttribute('aria-live', 'polite');
        overlay.setAttribute('aria-label', 'ZenGPT is hiding the response until generation completes');

        const message = document.createElement('div');
        message.className = 'zengpt-overlay-message';
        message.textContent = 'ZenGPT: Response hidden until generation completes.';

        overlay.appendChild(message);
        container.appendChild(overlay);

        log('Overlay added to container', container);
    }

    function removeAllOverlays() {
        const overlays = document.querySelectorAll(`.${OVERLAY_CLASS_NAME}`);
        overlays.forEach(node => {
            const parent = node.parentElement;
            node.remove();
            if (parent) parent.classList.remove(PARENT_RELATIVE_CLASS_NAME);
        });

        if (overlays.length > 0) log('Removed overlays:', overlays.length);
    }

    function clearGeneratingClasses() {
        const nodes = document.querySelectorAll(`.${GENERATING_CLASS_NAME}`);
        nodes.forEach(n => n.classList.remove(GENERATING_CLASS_NAME));
    }

    function updateOverlayState() {
        try {
            const generating = isGenerating();
            if (getDebugEnabled()) log('updateOverlayState: generating =', generating);
            if (generating) {
                const container = getLastAssistantMessageContainer();
                if (container) {
                    container.classList.add(GENERATING_CLASS_NAME);
                    ensureOverlay(container);
                }
            } else {
                clearGeneratingClasses();
                removeAllOverlays();
            }
        } catch (_) {
            // no-op
        }
    }

    const debouncedUpdate = debounce(updateOverlayState, 100);

    updateOverlayState();

    const observer = new MutationObserver(() => { debouncedUpdate(); });
    observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-message-author-role', 'aria-busy', 'class']
    });

    const intervalId = window.setInterval(updateOverlayState, 500);

    let lastUrl = location.href;
    const urlCheckId = window.setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            updateOverlayState();
        }
    }, 1000);

    window.addEventListener('beforeunload', () => {
        window.clearInterval(intervalId);
        window.clearInterval(urlCheckId);
        observer.disconnect();
    });

    // Debug badge
    function renderDebugBadge() {
        let badge = document.querySelector(`.${DEBUG_BADGE_CLASS_NAME}`);
        const enabled = getDebugEnabled();
        if (!enabled) {
            if (badge) badge.remove();
            return;
        }
        if (!badge) {
            badge = document.createElement('div');
            badge.className = DEBUG_BADGE_CLASS_NAME;
            badge.textContent = 'ZenGPT Debug ON (' + (isMac ? 'Cmd+Shift+Z' : 'Ctrl+Shift+Z') + ' to toggle)';
            badge.addEventListener('click', () => {
                try { toggleDebug(); } catch (_) { }
            });
            document.documentElement.appendChild(badge);
        }
    }

    function toggleDebug() {
        const next = !getDebugEnabled();
        setDebugEnabled(next);
        log('Toggled debug to', next);
        renderDebugBadge();
        updateOverlayState();
    }

    // Keyboard toggle: Cmd+Shift+Z (mac) / Ctrl+Shift+Z (others). Fallback Alt+Shift+Z.
    window.addEventListener('keydown', (e) => {
        try {
            const key = (e.key || '').toLowerCase();
            const primaryCombo = (isMac ? (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey) : (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey));
            const fallbackCombo = (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey);
            if ((primaryCombo && key === 'z') || (fallbackCombo && key === 'z')) {
                toggleDebug();
                e.preventDefault();
            }
        } catch (_) { }
    }, true);

    renderDebugBadge();

    // Listen for page->content messages to control debug from page context
    window.addEventListener('message', (event) => {
        try {
            if (event.source !== window) return;
            const data = event.data || {};
            if (!data || typeof data !== 'object' || !data.__zengpt) return;
            if (data.action === 'enable') {
                setDebugEnabled(true); renderDebugBadge(); updateOverlayState();
            } else if (data.action === 'disable') {
                setDebugEnabled(false); renderDebugBadge(); updateOverlayState();
            } else if (data.action === 'toggle') {
                toggleDebug();
            } else if (data.action === 'ping') {
                // no-op; just used to verify listener is attached
                if (getDebugEnabled()) log('Received ping from page');
            }
        } catch (_) { }
    });

    // Define page-visible API directly (works when running in MAIN world). Fallback: attempt injection if not set.
    try {
        if (!window.__zengpt) {
            Object.defineProperty(window, '__zengpt', {
                value: {
                    enableDebug: () => window.postMessage({ __zengpt: true, action: 'enable' }, '*'),
                    disableDebug: () => window.postMessage({ __zengpt: true, action: 'disable' }, '*'),
                    toggleDebug: () => window.postMessage({ __zengpt: true, action: 'toggle' }, '*'),
                    version: SCRIPT_VERSION
                },
                writable: false,
                enumerable: false,
                configurable: true
            });
        }
        console.log('[ZenGPT] API available as window.__zengpt');
    } catch (_) {
        try {
            const script = document.createElement('script');
            script.textContent = `(() => {
                try {
                    if (!window.__zengpt) {
                        const api = {
                            enableDebug: () => window.postMessage({ __zengpt: true, action: 'enable' }, '*'),
                            disableDebug: () => window.postMessage({ __zengpt: true, action: 'disable' }, '*'),
                            toggleDebug: () => window.postMessage({ __zengpt: true, action: 'toggle' }, '*'),
                            version: ${JSON.stringify(SCRIPT_VERSION)}
                        };
                        Object.defineProperty(window, '__zengpt', { value: api, writable: false, enumerable: false, configurable: true });
                    }
                    window.postMessage({ __zengpt: true, action: 'ping' }, '*');
                } catch (e) { /* ignore */ }
            })();`;
            (document.documentElement || document.head || document.body).appendChild(script);
            script.remove();
            console.log('[ZenGPT] API available as window.__zengpt (injected)');
        } catch (_) { }
    }
})();


