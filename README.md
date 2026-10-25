# Nightingale Reader

A light Windows browser that reads web novels aloud. Paste a chapter link, press play, and a natural voice reads the chapter, highlights each paragraph as it goes, then opens the next chapter on its own and keeps reading.

The voice ([Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)) runs entirely on your PC, on the graphics card when it can. Nothing you read is sent anywhere.

The app shows itself as **Reader Browser**; Nightingale Reader is the project name.

## Features

- **Hands-free chapters.** Finds the chapter text, reads it, clicks Next, and carries on. If a site has no Next button, it follows the chapter numbers (`…/chapter-41` → `…/chapter-42`).
- **Learns each site.** A tiny local learner remembers each site's Next button, where the text sits, and repeated lines to skip ("Translator: …", "Read at …"). It only learns from verified results, is capped at 400 KB, and can be wiped from the start page.
- **No gaps.** About 25 seconds of speech is prepared ahead, and the next chapter loads while the current one finishes.
- **Player controls.** Seek bar with time, paragraph back and skip, pause, stop, three voices, speed from 0.8× to 1.5×.
- **Read from here.** Select text, or right-click a paragraph, to start reading from that point.
- **Picks up where you stopped** in every chapter.
- **Reading list and favourite sites** on the start page.
- **Light and dark themes.**
- **Light on your PC.** The voice uses the graphics card (DirectML) or as few CPU threads as it can at low priority, sleeps after 4 idle minutes, and the app's panels share one process. There's built-in ad blocking and a capped cache.

## Shortcuts

| Key | Action |
| --- | --- |
| F9 | Read selection or page |
| F8 | Pause / resume |
| F7 | Stop |
| F10 | Skip to next chapter |
| Alt+↑ / Alt+↓ | Back / skip a paragraph |
| Ctrl+L | Address bar |
| F5 | Reload |
| Alt+← / Alt+→ | Back / forward |

## Run from source

Needs [Node.js](https://nodejs.org) 20 or newer, on Windows.

```
npm install
npm start
```

On first start the app downloads the voice (about 90 MB) into your user folder. Interrupted downloads resume, and a damaged file is repaired automatically.

## How it's put together

| File | What it does |
| --- | --- |
| `main.js` | Window, page view, floating panels, next-chapter logic, ad blocking |
| `renderer.js` | Reading engine: text to sentences, buffering, playback, skipping and seeking |
| `tts-worker.mjs` | Voice process: safe resumable model download, GPU or CPU choice, speech generation |
| `brain.js` | The local learner (per-site memory and Next-button scorer) |
| `library.js` | Reading list, favourite sites, preferences |
| `page-scripts.js` | Small functions run inside web pages (find text, highlight, find Next) |
| `index.html` | Top bar |
| `overlay-*.html/js` | Floating player, tool rail, theme button |
| `start.html/js` | Start page |
| `preload-*.js` | Safe bridges between the pages and the app |

## Privacy

Everything stays on your computer: the voice, what it learns about sites, your reading list and positions. The only network traffic is the web pages you open and the one-time voice download from Hugging Face.
