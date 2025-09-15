(function () {
    const SCRIPT_VERSION = '0.1.0';
    const STOP_BUTTON_SELECTOR = [
        '#composer-submit-button[data-testid="stop-button"]',
        'button[data-testid="stop-button"][aria-label="Stop streaming"]',
        'button[aria-label*="stop streaming" i]',
        'button[aria-label*="stop generating" i]',
        'button:has(svg.lucide-square)',
        'button:has(svg[aria-hidden="true"].lucide-square)'
    ].join(', ');
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
        console.log('[ZenGPT] Extension loaded (v' + SCRIPT_VERSION + ')');
    } catch (_) { }

    function getAssistantArticle() {
        // 1) Prefer explicit assistant articles by data-turn
        const byTurn = document.querySelectorAll('article[data-turn="assistant"]');
        if (byTurn && byTurn.length > 0) {
            const found = byTurn[byTurn.length - 1];
            try { console.debug('[ZenGPT] assistant via data-turn:', found); } catch (_) { }
            return found;
        }

        // 2) Any assistant-marked article
        const articleAssistant = document.querySelectorAll('article[data-message-author-role="assistant"], article[data-role="assistant"]');
        if (articleAssistant && articleAssistant.length > 0) {
            const found = articleAssistant[articleAssistant.length - 1];
            try { console.debug('[ZenGPT] assistant via role/author:', found); } catch (_) { }
            return found;
        }

        // 3) Find an inner assistant node and bubble to its containing article
        const inner = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (inner && inner.length > 0) {
            for (let i = inner.length - 1; i >= 0; i--) {
                const art = inner[i].closest('article');
                if (art) {
                    try { console.debug('[ZenGPT] assistant via inner node:', art); } catch (_) { }
                    return art;
                }
                // Mistral path: no <article>; use the assistant block itself (or its answer part)
                const answer = inner[i].querySelector('[data-message-part-type="answer"]') || inner[i];
                try { console.debug('[ZenGPT] assistant via direct assistant node:', answer); } catch (_) { }
                return answer;
            }
        }
        try { console.debug('[ZenGPT] assistant article not found'); } catch (_) { }
        return null;
    }

    function getComposerElement() {
        const selectors = [
            'form textarea',
            'form [contenteditable="true"]',
            'footer textarea',
            '[data-testid="composer"] textarea',
            '[role="textbox"][contenteditable="true"]'
        ];
        for (const s of selectors) {
            const el = document.querySelector(s);
            if (el) return el;
        }
        return null;
    }

    function getElementAboveComposer() {
        const composer = getComposerElement();
        if (!composer) return null;
        let node = composer.closest('form') || composer.parentElement;
        if (!node) return null;
        let sibling = node.previousElementSibling;
        while (sibling) {
            try {
                const style = getComputedStyle(sibling);
                if (sibling.offsetHeight > 10 && style.display !== 'none' && style.visibility !== 'hidden') return sibling;
            } catch (_) { }
            sibling = sibling.previousElementSibling;
        }
        return null;
    }

    function isStopStreamingPresent() {
        try {
            const direct = document.querySelector(STOP_BUTTON_SELECTOR);
            if (direct) { try { console.debug('[ZenGPT] stop via selector:', direct); } catch (_) { } return true; }
            const candidates = document.querySelectorAll('button, [role="button"]');
            for (const el of candidates) {
                try {
                    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                    if (aria.includes('stop')) { try { console.debug('[ZenGPT] stop via aria-label on', el); } catch (_) { } return true; }
                    const text = (el.textContent || '').toLowerCase();
                    if (text.includes('stop')) { try { console.debug('[ZenGPT] stop via text on', el); } catch (_) { } return true; }
                    const svgs = el.querySelectorAll('svg');
                    for (const svg of svgs) {
                        if (svg.classList && svg.classList.contains('lucide-square')) { try { console.debug('[ZenGPT] stop via lucide-square on', el); } catch (_) { } return true; }
                    }
                } catch (_) { }
            }
            try { console.debug('[ZenGPT] stop not detected'); } catch (_) { }
        } catch (err) {
            try { console.debug('[ZenGPT] isStopStreamingPresent error', err); } catch (_) { }
        }
        return false;
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
        try { console.debug('[ZenGPT] overlay inserted before', target); } catch (_) { }
    }

    function removeOverlayBefore(target) {
        if (!target || !target.parentElement) return;
        const prev = target.previousElementSibling;
        if (prev && prev.classList && prev.classList.contains('zen-gpt-overlay')) {
            try { prev.remove(); } catch (_) { }
            try { console.debug('[ZenGPT] overlay removed before', target); } catch (_) { }
        }
    }

    function ensureOverlayVisibleFor(target) {
        // No-op on purpose to avoid any scroll movement
        try { if (!target) return; } catch (_) { }
    }

    function hideElement(target) {
        if (!target) return;
        target.classList.add('zen-gpt-hidden');
        ensureOverlayBefore(target);
        currentlyHiddenElement = target;
        try { console.debug('[ZenGPT] hideElement', target); } catch (_) { }
    }

    function showElement(target) {
        if (!target) return;
        target.classList.remove('zen-gpt-hidden');
        removeOverlayBefore(target);
        if (currentlyHiddenElement === target) {
            currentlyHiddenElement = null;
        }
        try { console.debug('[ZenGPT] showElement', target); } catch (_) { }
    }

    function revealAll() {
        try {
            const hidden = document.querySelectorAll('.zen-gpt-hidden');
            for (const el of hidden) {
                try { el.classList.remove('zen-gpt-hidden'); } catch (_) { }
            }
        } catch (_) { }
        try {
            const overlays = document.querySelectorAll('.zen-gpt-overlay');
            for (const ov of overlays) {
                try { ov.remove(); } catch (_) { }
            }
        } catch (_) { }
        currentlyHiddenElement = null;
        try { console.debug('[ZenGPT] revealAll done'); } catch (_) { }
    }

    function dbg() {
        try { console.debug('[ZenGPT]', ...arguments); } catch (_) { }
    }

    function updateHiddenState() {
        try { console.debug('[ZenGPT] updateHiddenState start'); } catch (_) { }
        // If disabled, undo and exit
        try {
            // Read enable flag lazily; default to true if unavailable
            // chrome.storage is async; to keep it responsive we use a cached value updated via messages
            if (typeof window.__zengpt_enabled === 'boolean' && !window.__zengpt_enabled) {
                if (currentlyHiddenElement) { showElement(currentlyHiddenElement); }
                try {
                    const allOverlays = document.querySelectorAll('.zen-gpt-overlay');
                    for (const ov of allOverlays) { ov.remove(); }
                } catch (_) { }
                return;
            }
        } catch (err) { dbg('updateHiddenState:pre-check error', err); }
        try {
            const stopPresent = isStopStreamingPresent();
            try { console.debug('[ZenGPT] stopPresent=', stopPresent, 'wasStopPresent=', wasStopPresent); } catch (_) { }
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
                const target = getAssistantArticle() || getElementAboveComposer();
                try { console.debug('[ZenGPT] target to hide =', target); } catch (_) { }
                hideElement(target);
                ensureOverlayVisibleFor(target);
                wasStopPresent = stopPresent;
                return;
            }

            // Stop button not present: reveal everything we might have hidden
            revealAll();
            wasStopPresent = stopPresent;
            try { console.debug('[ZenGPT] updateHiddenState end; revealed'); } catch (_) { }
        } catch (err) { dbg('updateHiddenState:main error', err); }
    }

    function scheduleUpdate() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            try {
                try { console.debug('[ZenGPT] scheduleUpdate -> run updateHiddenState'); } catch (_) { }
                updateHiddenState();
            } catch (err) {
                try { console.debug('[ZenGPT] scheduleUpdate error', err); } catch (_) { }
            }
        });
    }

    function startObserver() {
        const observer = new MutationObserver(() => {
            try {
                try { console.debug('[ZenGPT] mutation observed'); } catch (_) { }
                scheduleUpdate();
                // Continuously attempt arming composer listeners in dynamic UIs
                try { armComposerPreLock(); } catch (_) { }
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
        try {
            if (scrollLockActive) return;
            scrollLockActive = true;
            scrollLockUntil = Date.now() + (durationMs || 1500);
            // Capture current positions; do NOT change scroll immediately
            savedScrollY = window.scrollY || 0;
            if (!scrollLockContainer) scrollLockContainer = document.scrollingElement || document.documentElement;
            try { savedScrollTop = scrollLockContainer.scrollTop; } catch (_) { savedScrollTop = 0; }

            const cancel = () => stopScrollLock();
            try {
                // If the user interacts, stop locking so they can scroll freely
                window.addEventListener('wheel', cancel, { passive: true, once: true });
                window.addEventListener('touchstart', cancel, { passive: true, once: true });
                window.addEventListener('keydown', cancel, { passive: true, once: true });
            } catch (_) { }

            // Block programmatic scroll calls during lock (but allow user scrolling if lock is cancelled)
            enableProgrammaticScrollBlock();
            const tick = () => {
                if (!scrollLockActive) return;
                if (Date.now() > scrollLockUntil) { stopScrollLock(); return; }
                lockRafId = window.requestAnimationFrame(tick);
            };
            lockRafId = window.requestAnimationFrame(tick);
        } catch (_) {
            // fail open
        }
    }

    function stopScrollLock() {
        if (!scrollLockActive) return;
        scrollLockActive = false;
        scrollLockUntil = 0;
        try { lockRafId && window.cancelAnimationFrame(lockRafId); } catch (_) { }
        lockRafId = 0;
        // Restore original programmatic scroll behavior
        disableProgrammaticScrollBlock();
        scrollLockOnScroll = null;
        scrollLockContainer = null;
    }

    // --- Programmatic scroll blocking ---
    let scrollPatchEnabled = false;
    let origWindowScrollTo = null;
    let origWindowScrollBy = null;
    let origElementScrollTo = null;
    let origElementScrollIntoView = null;

    function enableProgrammaticScrollBlock() {
        if (scrollPatchEnabled) return;
        scrollPatchEnabled = true;
        try {
            origWindowScrollTo = window.scrollTo;
            origWindowScrollBy = window.scrollBy;
            origElementScrollTo = Element.prototype.scrollTo;
            origElementScrollIntoView = Element.prototype.scrollIntoView;

            window.scrollTo = function () {
                if (scrollLockActive) return; return origWindowScrollTo.apply(window, arguments);
            };
            window.scrollBy = function () {
                if (scrollLockActive) return; return origWindowScrollBy.apply(window, arguments);
            };
            Element.prototype.scrollTo = function () {
                if (scrollLockActive) return; return origElementScrollTo.apply(this, arguments);
            };
            Element.prototype.scrollIntoView = function () {
                if (scrollLockActive) return; return origElementScrollIntoView.apply(this, arguments);
            };
        } catch (_) { }
    }

    function disableProgrammaticScrollBlock() {
        if (!scrollPatchEnabled) return;
        scrollPatchEnabled = false;
        try { if (origWindowScrollTo) window.scrollTo = origWindowScrollTo; } catch (_) { }
        try { if (origWindowScrollBy) window.scrollBy = origWindowScrollBy; } catch (_) { }
        try { if (origElementScrollTo) Element.prototype.scrollTo = origElementScrollTo; } catch (_) { }
        try { if (origElementScrollIntoView) Element.prototype.scrollIntoView = origElementScrollIntoView; } catch (_) { }
        origWindowScrollTo = origWindowScrollBy = null;
        origElementScrollTo = origElementScrollIntoView = null;
    }

    // Pre-arm scroll lock slightly before streaming begins by listening to composer actions
    function armComposerPreLock() {
        const composer = getComposerElement();
        if (!composer || composer.__zengptArmed) return;
        composer.__zengptArmed = true;
        try {
            composer.addEventListener('keydown', (e) => {
                try {
                    if ((e.key === 'Enter' || e.keyCode === 13) && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                        // Arm lock for a short window; if streaming doesn't start soon, it expires harmlessly
                        startScrollLock(3000);
                    }
                } catch (_) { }
            }, true);
        } catch (_) { }
        try {
            const form = composer.closest('form');
            if (form && !form.__zengptArmed) {
                form.__zengptArmed = true;
                form.addEventListener('submit', () => { try { startScrollLock(3000); } catch (_) { } }, true);
            }
        } catch (_) { }
        try {
            const submitBtn = document.querySelector('#composer-submit-button, button[type="submit"][aria-label*="send" i], button[aria-label*="submit" i]');
            if (submitBtn && !submitBtn.__zengptArmed) {
                submitBtn.__zengptArmed = true;
                submitBtn.addEventListener('click', () => { try { startScrollLock(3000); } catch (_) { } }, true);
            }
        } catch (_) { }
    }

    function init() {
        // Seed enabled flag and setup message listener
        try {
            chrome.storage?.local?.get({ zengpt_enabled: true }, (data) => {
                window.__zengpt_enabled = Boolean(data?.zengpt_enabled);
                scheduleUpdate();
            });
            chrome.runtime?.onMessage?.addListener?.((msg) => {
                if (msg && msg.type === 'zengpt-toggle') {
                    window.__zengpt_enabled = Boolean(msg.enabled);
                    scheduleUpdate();
                }
            });
        } catch (_) { window.__zengpt_enabled = true; }
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


