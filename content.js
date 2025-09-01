(function () {
    const SCRIPT_VERSION = '0.1.0';
    const STOP_BUTTON_SELECTOR = '#composer-submit-button[data-testid="stop-button"], button[data-testid="stop-button"][aria-label="Stop streaming"]';
    const ASSISTANT_MESSAGE_SELECTORS = [
        'article[data-turn="assistant"]',
        'article[data-message-author-role="assistant"]',
        'article[data-role="assistant"]',
        '[data-message-author-role="assistant"]'
    ].join(', ');

    let currentlyHiddenElement = null;
    let scheduled = false;
    let wasStopPresent = false;
    let scrollLockActive = false;
    let scrollLockUntil = 0;
    let savedScrollY = 0;
    let lockRafId = 0;
    let scrollLockContainer = null;
    let savedScrollTop = 0;
    let scrollLockOnScroll = null;

    try {
        console.log('[ZenGPT] Content script loaded v' + SCRIPT_VERSION);
    } catch (_) { }

    function getAssistantArticle() {
        // 1) Prefer explicit assistant articles by data-turn
        const byTurn = document.querySelectorAll('article[data-turn="assistant"]');
        if (byTurn && byTurn.length > 0) return byTurn[byTurn.length - 1];

        // 2) Any assistant-marked article
        const articleAssistant = document.querySelectorAll('article[data-message-author-role="assistant"], article[data-role="assistant"]');
        if (articleAssistant && articleAssistant.length > 0) return articleAssistant[articleAssistant.length - 1];

        // 3) Find an inner assistant node and bubble to its containing article
        const inner = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (inner && inner.length > 0) {
            for (let i = inner.length - 1; i >= 0; i--) {
                const art = inner[i].closest('article');
                if (art) return art;
            }
        }
        return null;
    }

    function isStopStreamingPresent() {
        return Boolean(document.querySelector(STOP_BUTTON_SELECTOR));
    }

    function getScrollableContainer(start) {
        let node = start;
        while (node && node !== document.documentElement) {
            try {
                const style = node instanceof Element ? getComputedStyle(node) : null;
                const overflowY = style ? style.overflowY : '';
                const canScroll = node.scrollHeight > node.clientHeight + 1;
                if (canScroll && (overflowY === 'auto' || overflowY === 'scroll')) {
                    return node;
                }
                node = node.parentElement;
            } catch (_) {
                break;
            }
        }
        return document.scrollingElement || document.documentElement;
    }

    function createOverlay() {
        const overlay = document.createElement('div');
        overlay.className = 'zen-gpt-overlay';
        const text = document.createElement('div');
        text.className = 'zen-gpt-overlay-text';
        text.textContent = 'ZenGPT: The answer will appear once fully generated.';
        const illo = document.createElement('div');
        illo.className = 'zen-gpt-overlay-illustration';
        const img = document.createElement('img');
        try {
            img.src = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL('zen.png') : 'zen.png';
        } catch (_) {
            img.src = 'zen.png';
        }
        img.alt = 'ZenGPT illustration';
        img.decoding = 'async';
        img.loading = 'lazy';
        illo.appendChild(img);
        overlay.appendChild(text);
        overlay.appendChild(illo);
        return overlay;
    }

    function ensureOverlayBefore(target) {
        if (!target || !target.parentElement) return;
        const prev = target.previousElementSibling;
        if (prev && prev.classList && prev.classList.contains('zen-gpt-overlay')) return;
        const overlay = createOverlay();
        try { target.parentElement.insertBefore(overlay, target); } catch (_) { }
    }

    function removeOverlayBefore(target) {
        if (!target || !target.parentElement) return;
        const prev = target.previousElementSibling;
        if (prev && prev.classList && prev.classList.contains('zen-gpt-overlay')) {
            try { prev.remove(); } catch (_) { }
        }
    }

    function ensureOverlayVisibleFor(target) {
        try {
            if (!target) return;
            const overlay = target.previousElementSibling;
            if (!overlay || !overlay.classList || !overlay.classList.contains('zen-gpt-overlay')) return;
            const container = scrollLockContainer || getScrollableContainer(target);
            if (!container) return;

            // Compute overlay position relative to the container's viewport
            const overlayRect = overlay.getBoundingClientRect();
            const containerRect = (container === document.scrollingElement || container === document.documentElement || container === document.body)
                ? { top: 0, height: window.innerHeight }
                : container.getBoundingClientRect();

            const relativeTop = overlayRect.top - containerRect.top;
            const relativeBottom = relativeTop + overlayRect.height;
            let delta = 0;
            const margin = 12;
            const viewportHeight = (containerRect.height !== undefined ? containerRect.height : window.innerHeight);

            if (relativeTop < margin) {
                delta = relativeTop - margin;
            } else if (relativeBottom > viewportHeight - margin) {
                delta = relativeBottom - (viewportHeight - margin);
            }

            if (delta !== 0) {
                if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
                    const newY = Math.max(0, (window.scrollY || 0) + delta);
                    try { window.scrollTo(0, newY); } catch (_) { }
                    savedScrollY = newY;
                } else {
                    try { container.scrollTop = Math.max(0, container.scrollTop + delta); } catch (_) { }
                    savedScrollTop = container.scrollTop;
                }
            }
        } catch (_) { }
    }

    function hideElement(target) {
        if (!target) return;
        target.classList.add('zen-gpt-hidden');
        ensureOverlayBefore(target);
        currentlyHiddenElement = target;
    }

    function showElement(target) {
        if (!target) return;
        target.classList.remove('zen-gpt-hidden');
        removeOverlayBefore(target);
        if (currentlyHiddenElement === target) {
            currentlyHiddenElement = null;
        }
    }

    function updateHiddenState() {
        try {
            const stopPresent = isStopStreamingPresent();
            // Handle scroll lock on transition into/out of streaming
            if (stopPresent && !wasStopPresent) {
                try {
                    const target = getAssistantArticle();
                    scrollLockContainer = getScrollableContainer(target || document.body);
                } catch (_) {
                    scrollLockContainer = document.scrollingElement || document.documentElement;
                }
                startScrollLock(1800);
            } else if (!stopPresent && wasStopPresent) {
                stopScrollLock();
            }
            if (stopPresent) {
                const latestAssistantArticle = getAssistantArticle();
                hideElement(latestAssistantArticle);
                ensureOverlayVisibleFor(latestAssistantArticle);
                wasStopPresent = stopPresent;
                return;
            }

            // Stop button not present: reveal anything we hid
            if (currentlyHiddenElement) {
                showElement(currentlyHiddenElement);
            }
            // Remove any stray overlays just in case
            try {
                const allOverlays = document.querySelectorAll('.zen-gpt-overlay');
                for (const ov of allOverlays) { ov.remove(); }
            } catch (_) { }
            wasStopPresent = stopPresent;
        } catch (err) {
            try { console.debug('[ZenGPT] updateHiddenState error', err); } catch (_) { }
        }
    }

    function scheduleUpdate() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            try {
                updateHiddenState();
            } catch (err) {
                try { console.debug('[ZenGPT] scheduleUpdate error', err); } catch (_) { }
            }
        });
    }

    function startObserver() {
        const observer = new MutationObserver(() => {
            try {
                scheduleUpdate();
            } catch (err) {
                try { console.debug('[ZenGPT] observer error', err); } catch (_) { }
            }
        });
        observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-testid', 'aria-label', 'id', 'data-message-author-role', 'data-turn']
        });
    }

    function startScrollLock(durationMs) {
        try { document.documentElement.style.scrollBehavior = 'auto'; } catch (_) { }
        savedScrollY = window.scrollY || 0;
        if (!scrollLockContainer) scrollLockContainer = document.scrollingElement || document.documentElement;
        try { savedScrollTop = scrollLockContainer.scrollTop; } catch (_) { savedScrollTop = 0; }
        scrollLockUntil = Date.now() + (durationMs || 1200);
        if (scrollLockActive) return;
        scrollLockActive = true;
        const cancel = () => stopScrollLock();
        try {
            window.addEventListener('wheel', cancel, { passive: true, once: true });
            window.addEventListener('touchstart', cancel, { passive: true, once: true });
            window.addEventListener('keydown', cancel, { passive: true, once: true });
        } catch (_) { }
        // Keep the container's scrollTop locked as well
        try {
            scrollLockOnScroll = () => {
                if (!scrollLockActive) return;
                try { scrollLockContainer.scrollTop = savedScrollTop; } catch (_) { }
            };
            scrollLockContainer.addEventListener('scroll', scrollLockOnScroll, { passive: true });
        } catch (_) { }
        const tick = () => {
            if (!scrollLockActive) return;
            if (Date.now() > scrollLockUntil) { stopScrollLock(); return; }
            const y = window.scrollY || 0;
            if (Math.abs(y - savedScrollY) > 1) {
                try { window.scrollTo(0, savedScrollY); } catch (_) { }
            }
            try {
                if (Math.abs(scrollLockContainer.scrollTop - savedScrollTop) > 1) {
                    scrollLockContainer.scrollTop = savedScrollTop;
                }
            } catch (_) { }
            lockRafId = window.requestAnimationFrame(tick);
        };
        lockRafId = window.requestAnimationFrame(tick);
    }

    function stopScrollLock() {
        if (!scrollLockActive) return;
        scrollLockActive = false;
        try { lockRafId && window.cancelAnimationFrame(lockRafId); } catch (_) { }
        lockRafId = 0;
        try { scrollLockOnScroll && scrollLockContainer && scrollLockContainer.removeEventListener('scroll', scrollLockOnScroll); } catch (_) { }
        scrollLockOnScroll = null;
        scrollLockContainer = null;
        try { document.documentElement.style.scrollBehavior = ''; } catch (_) { }
    }

    function init() {
        try { updateHiddenState(); } catch (_) { }
        try { startObserver(); } catch (_) { }
        // Also update on visibility changes just in case
        try { document.addEventListener('visibilitychange', scheduleUpdate, { passive: true }); } catch (_) { }
        try { window.addEventListener('focus', scheduleUpdate, { passive: true }); } catch (_) { }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();


