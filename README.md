# ZenGPT (Chrome Extension)

Hides ChatGPT responses until they are fully generated.

<p align="center">
  <img src="zen.png" alt="Image representing ZenGPT: person in meditative lotus pose." width="50%"/>
</p>

## Install (Developer Mode)

1. No build needed. This is a plain MV3 extension.
2. Open Chrome and go to `chrome://extensions`.
3. Enable "Developer mode" (top-right).
4. Click "Load unpacked" and select this folder: `/Users/cosmo/Documents/projects/zengpt`.
5. Go to `https://chatgpt.com` or `https://chat.openai.com` and use ChatGPT as usual.

The latest assistant message will be covered by an overlay while generation is in progress, and revealed automatically when finished.

## How it works

- A content script observes the page for ChatGPT generation signals (e.g., the presence of a "Stop generating" button).
- While generating, ZenGPT adds an overlay to the latest assistant message container.
- When generation completes, the overlay is removed.

## Notes

- Runs only on ChatGPT domains declared in `manifest.json`.
- No data leaves your browser. There is no background script or network access.
- If ChatGPT’s DOM changes significantly, detection heuristics may need updates.

## Uninstall

- Remove it from `chrome://extensions` at any time.