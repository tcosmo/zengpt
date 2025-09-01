(() => {
    const checkbox = document.getElementById('enabled');
    const dot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    function load() {
        chrome.storage.local.get({ zengpt_enabled: true }, (data) => {
            checkbox.checked = Boolean(data.zengpt_enabled);
            renderStatus();
            updateActionIcon(checkbox.checked);
        });
    }
    function save() {
        const enabled = checkbox.checked;
        chrome.storage.local.set({ zengpt_enabled: enabled }, () => {
            renderStatus();
            // Notify active ChatGPT tabs to update immediately
            try {
                chrome.tabs.query({ url: ['https://chat.openai.com/*', 'https://chatgpt.com/*'] }, (tabs) => {
                    for (const tab of tabs) {
                        if (tab.id) {
                            chrome.tabs.sendMessage(tab.id, { type: 'zengpt-toggle', enabled }, () => {
                                // Swallow "Receiving end does not exist" when no content script is present
                                const err = chrome.runtime.lastError;
                                if (err && err.message && console && console.debug) {
                                    console.debug('[ZenGPT] sendMessage note:', err.message);
                                }
                            });
                        }
                    }
                });
            } catch (_) { }
            updateActionIcon(enabled);
        });
    }
    function renderStatus() {
        const enabled = checkbox.checked;
        if (!dot || !statusText) return;
        dot.style.background = enabled ? '#10B981' : '#6B7280';
        statusText.textContent = enabled ? 'Active' : 'Disabled';
    }

    // Generate grayscale icon on the fly and set as action icon
    function updateActionIcon(enabled) {
        try {
            const src = chrome.runtime.getURL('icon.png');
            const sizes = [16, 32, 48, 128];
            const img = new Image();
            img.onload = () => {
                const imageData = {};
                for (const size of sizes) {
                    const canvas = document.createElement('canvas');
                    canvas.width = size;
                    canvas.height = size;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(img, 0, 0, size, size);
                    if (!enabled) {
                        const data = ctx.getImageData(0, 0, size, size);
                        const arr = data.data;
                        for (let i = 0; i < arr.length; i += 4) {
                            const r = arr[i], g = arr[i + 1], b = arr[i + 2];
                            const gray = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
                            arr[i] = arr[i + 1] = arr[i + 2] = gray;
                        }
                        ctx.putImageData(data, 0, 0);
                    }
                    imageData[size] = ctx.getImageData(0, 0, size, size);
                }
                chrome.action.setIcon({ imageData });
            };
            img.src = src;
        } catch (_) { }
    }
    checkbox.addEventListener('change', save);
    document.addEventListener('DOMContentLoaded', load, { once: true });
})();


