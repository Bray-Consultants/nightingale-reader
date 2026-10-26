const { app, BrowserWindow, WebContentsView, ipcMain, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const Brain = require('./brain');
const Library = require('./library');
const { EXTRACT_FN, HL_FN, NEXT_CANDS_FN, CLICK_FN, LINK_NEXT_FN } = require('./page-scripts');

const TOP_H = 60;
const EDGE = 18;                       // gap between floating panels and the window edge
const MODE_D = 50;                     // round theme button, bottom-left
const IDLE_SLEEP_MS = 3 * 60 * 1000;   // voice engine sleeps after 3 idle minutes (frees its memory)
const CACHE_MAX = 48 * 1024 * 1024;    // browser cache cap
// 0.5: the app is now called Nightingale Reader. Carry the voice, settings and reading list over
// from the old "Reader Browser" folder so nothing has to be downloaded or set up again.
try {
  const appData = app.getPath('appData');
  const oldDir = path.join(appData, 'Reader Browser');
  const newDir = path.join(appData, 'Nightingale Reader');
  if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) {
    try { fs.renameSync(oldDir, newDir); }
    catch (_) {   // old folder busy: copy what matters instead
      const skip = /[\\/](Cache|Code Cache|GPUCache|DawnCache|Crashpad)([\\/]|$)/;
      fs.cpSync(oldDir, newDir, { recursive: true, filter: (src) => !skip.test(src) });
    }
  }
  app.setPath('userData', newDir);
} catch (_) {}
app.setAppUserModelId('com.brayconsultants.nightingalereader');
const ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

const HOME = 'file://' + path.join(__dirname, 'start.html').replace(/\\/g, '/');

// Keep audio and chapter-hopping alive when the window is minimized; switch off Chromium extras we never use.
// No spare renderer process kept waiting in the background (saves ~60-90 MB).
app.commandLine.appendSwitch('disable-features', [
  'CalculateNativeWinOcclusion', 'Translate', 'MediaRouter', 'OptimizationHints',
  'SpareRendererForSitePerProcess', 'BackForwardCache', 'Prerender2', 'InterestFeedContentSuggestions',
  // 0.6: sound plays from the app itself instead of a separate audio process (~40-60 MB less while reading)
  'AudioServiceOutOfProcess',
].join(','));
// All of the app's own panels (top bar, player, rail, theme button, start page) share ONE process
// instead of one each (saves ~200 MB).
app.commandLine.appendSwitch('process-per-site');
// Ad and widget frames on novel sites stay inside the page's process instead of spawning
// a new process each (novel sites can have 5-10 of them).
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('renderer-process-limit', '3');
// Smaller JavaScript memory budget for pages.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');
// Keep the browser cache small: novel pages are text, there is little worth caching.
app.commandLine.appendSwitch('disk-cache-size', String(CACHE_MAX));
// 0.3: page drawing and scrolling use the graphics card again, so they no longer load the CPU.

let win, view, brain, lib;
// Floating panels drawn above the page: player dock (bottom), tool rail (right), theme button (bottom-left).
const ov = { dock: null, rail: null, mode: null };
const ovSize = { dock: { w: 640, h: 84, r: 42 }, rail: { w: 60, h: 360, r: 30 }, mode: { w: MODE_D, h: MODE_D, r: MODE_D / 2 } };
let lastUIState = null;
let worker = null;
let workerAsleep = false;
let lastVoiceUse = Date.now();
let seq = 0;
let readyP = null;
let readyRes = null;
const waiting = new Map();
const fileProgress = {};
let engine = { state: 'loading', pct: 0, msg: '', info: null };
let workerStage = '';
let nextToken = 0;      // only the newest next-chapter jump may act
// Who changed the page? The reader itself (next chapter, playlist, start page) or you, by clicking
// a link. When you click to another chapter while it reads, the reader follows you there.
let appNav = 0, appNavOnce = false, userLoadPending = false;
let plActive = false;   // the playlist is playing

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (wc) => wc && !wc.isDestroyed();
const toUI = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
const toOverlays = (ch, data) => { for (const v of Object.values(ov)) if (v && alive(v.webContents)) v.webContents.send(ch, data); };
const setEngine = (s) => { engine = { ...engine, ...s }; toUI('tts:state', engine); };
const hostOf = (u) => { try { return new URL(u).hostname; } catch (_) { return ''; } };
const isHome = (u) => (u || '').split('#')[0].split('?')[0] === HOME;

/* ------------------------------------------------------------------ */
/*  Voice engine (separate process, sleeps when idle)                  */
/* ------------------------------------------------------------------ */
function startWorker(wake) {
  if (worker) { try { worker.removeAllListeners('exit'); worker.kill(); } catch (_) {} }
  for (const k of Object.keys(fileProgress)) delete fileProgress[k];
  workerAsleep = false;
  readyP = new Promise((r) => { readyRes = r; });
  setEngine({ state: 'loading', pct: 0, msg: wake ? 'Waking the voice…' : '' });

  workerStage = '';
  const device = lib.d.prefs.gpuBroken ? 'cpu' : (lib.d.prefs.voiceDevice || 'auto');
  worker = fork(path.join(__dirname, 'tts-worker.mjs'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TTS_CACHE: path.join(app.getPath('userData'), 'models'), TTS_DEVICE: device },
    execArgv: ['--max-old-space-size=160'],
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  worker.on('message', (m) => {
    if (m.type === 'progress') {
      fileProgress[m.file] = { loaded: m.loaded, total: m.total };
      let l = 0, t = 0;
      for (const f of Object.values(fileProgress)) { l += f.loaded; t += f.total; }
      setEngine({ state: 'loading', pct: t ? Math.round((l / t) * 100) : 0 });
    } else if (m.type === 'stage') {
      workerStage = m.stage;
      if (m.stage === 'gpu') setEngine({ state: 'loading', msg: 'Trying the graphics card for the voice…' });
    } else if (m.type === 'status') {
      setEngine({ state: 'loading', msg: m.message });
    } else if (m.type === 'ready') {
      workerStage = 'ready';
      setEngine({ state: 'ready', pct: 100, msg: '', info: m.info || null });
      lastVoiceUse = Date.now();
      readyRes();
    } else if (m.type === 'load-error') {
      setEngine({ state: 'error', msg: m.message });
    } else if (m.type === 'audio') {
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w.resolve({ audio: m.audio, sr: m.sr }); }
    } else if (m.type === 'error') {
      const w = waiting.get(m.id);
      // a request from a stopped reading ends quietly; real failures are errors
      if (w) { waiting.delete(m.id); if (m.message === 'cancelled') w.resolve({ cancelled: true }); else w.reject(new Error(m.message)); }
    }
  });

  const me = worker;
  worker.on('exit', () => {
    for (const [, w] of waiting) w.reject(new Error('Voice engine stopped'));
    waiting.clear();
    if (worker === me) worker = null;
    // The graphics driver took the voice down while being tried: remember, and use the processor.
    if (workerStage === 'gpu' && !workerAsleep) {
      lib.setPref('gpuBroken', true);
      startWorker();
      return;
    }
    if (engine.state !== 'error' && !workerAsleep) setEngine({ state: 'error', msg: 'The voice stopped unexpectedly. Press Retry' });
  });
}

// Frees the voice's memory (~300 MB) when nothing has been read for a while. It wakes on Play.
function sleepWorker() {
  if (!worker || engine.state !== 'ready') return;
  workerAsleep = true;
  try { worker.kill(); } catch (_) {}
  worker = null;
  readyP = null;
  setEngine({ state: 'sleeping', pct: 100, msg: '' });
}
setInterval(() => {
  const reading = lastUIState && lastUIState.running;
  if (!reading && engine.state === 'ready' && Date.now() - lastVoiceUse > IDLE_SLEEP_MS) sleepWorker();
}, 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/*  Window                                                             */
/* ------------------------------------------------------------------ */
const AD_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com', 'googletagservices.com',
  'google-analytics.com', 'googletagmanager.com', 'adnxs.com', 'taboola.com', 'outbrain.com', 'popads.net', 'popcash.net',
  'propellerads.com', 'exoclick.com', 'juicyads.com', 'adsterra.com', 'pubmatic.com', 'rubiconproject.com', 'criteo.com',
  'criteo.net', 'amazon-adsystem.com', 'adsco.re', 'clickadu.com', 'hilltopads.net', 'mgid.com', 'revcontent.com',
  'media.net', 'openx.net', 'casalemedia.com', 'smartadserver.com', 'yieldmo.com', 'adform.net', 'sharethrough.com',
  'teads.tv', 'moatads.com', 'scorecardresearch.com', 'quantserve.com', 'zedo.com', 'bidswitch.net', '33across.com',
  'lijit.com', 'sovrn.com', 'indexww.com', 'onclickads.net', 'onclickmax.com', 'adcash.com', 'a-ads.com', 'admaven.com',
  'galaksion.com', 'richpush.co', 'pushame.com', 'monetag.com', 'ad-maven.com', 'highperformanceformat.com',
  'profitablecpmrate.com', 'effectivegatecpm.com', 'vidoomy.com', 'aniview.com', 'connatix.com', 'primis.tech',
  'ezoic.net', 'ezojs.com', 'adthrive.com', 'mediavine.com', 'hotjar.com', 'facebook.net', 'clarity.ms',
];
// Frames from these look like ads even when the host is unknown
const AD_FRAME = /(^|[./-])(ads?|adserv|adserver|banner|pop(up|under)?|track(er|ing)?|pixel|sponsor)[0-9]*([./-]|$)/i;

function normalize(input) {
  input = (input || '').trim();
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) return input;
  if (!/\s/.test(input) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(input)) return 'https://' + input;
  return 'https://www.google.com/search?q=' + encodeURIComponent(input);
}

function layout() {
  if (!win || !view) return;
  const [w, h] = win.getContentSize();
  const pageH = Math.max(0, h - TOP_H);
  view.setBounds({ x: 0, y: TOP_H, width: w, height: pageH });

  // Player dock: centred at the bottom, never over the theme button.
  const d = ovSize.dock;
  const side = EDGE + MODE_D + 14;
  const dw = Math.min(d.w, Math.max(120, w - 2 * side));
  const dx = Math.round((w - dw) / 2);
  const dy = h - EDGE - d.h;
  if (ov.dock) { ov.dock.setBounds({ x: dx, y: dy, width: dw, height: d.h }); ov.dock.webContents.send('ov:width', dw); }

  // Theme button: bottom-left, centred on the dock's line.
  if (ov.mode) ov.mode.setBounds({ x: EDGE, y: dy + Math.round((d.h - MODE_D) / 2), width: MODE_D, height: MODE_D });

  // Tool rail: right edge, vertically centred on the page, never on top of the dock.
  const r = ovSize.rail;
  const rx = w - EDGE - r.w;
  let ry = TOP_H + Math.round((pageH - r.h) / 2);
  if (rx < dx + dw + 12) ry = Math.min(ry, dy - 12 - r.h);
  ry = Math.max(TOP_H + 12, ry);
  if (ov.rail) ov.rail.setBounds({ x: rx, y: ry, width: r.w, height: Math.min(r.h, Math.max(0, h - ry - 12)) });
}

function sendTheme() {
  const theme = lib.d.prefs.theme === 'light' ? 'light' : 'dark';
  toUI('theme', theme);
  toOverlays('theme', theme);
  if (view && alive(view.webContents) && isHome(view.webContents.getURL())) view.webContents.send('rb:theme', theme);
  if (win) win.setBackgroundColor(theme === 'light' ? '#f4f1ea' : '#15171f');
}

function makeOverlay(name) {
  const v = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  v.setBackgroundColor('#00000000');
  try { v.setBorderRadius(ovSize[name].r); } catch (_) {}
  v.webContents.loadFile(`overlay-${name}.html`);
  v.webContents.on('did-finish-load', () => {
    v.webContents.send('theme', lib.d.prefs.theme === 'light' ? 'light' : 'dark');
    if (lastUIState) v.webContents.send('state', lastUIState);
    layout();
  });
  v.webContents.on('will-navigate', (e) => e.preventDefault());
  v.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.contentView.addChildView(v);
  ov[name] = v;
  return v;
}

let pushNav = () => {};

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 760, minHeight: 520,
    backgroundColor: lib.d.prefs.theme === 'light' ? '#f4f1ea' : '#15171f',
    title: 'Nightingale Reader',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true, sandbox: true, backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');

  view = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-page.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.contentView.addChildView(view);
  makeOverlay('rail');
  makeOverlay('mode');
  makeOverlay('dock');
  layout();
  win.on('resize', layout);

  const wc = view.webContents;
  wc.setUserAgent(wc.getUserAgent().replace(/\s(Electron|reader-browser)\/\S+/g, ''));
  wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url); return { action: 'deny' }; });

  pushNav = () => {
    const u = wc.getURL();
    toUI('nav', {
      url: u.startsWith('file:') ? '' : u,
      title: wc.getTitle(),
      loading: wc.isLoading(),
      back: wc.navigationHistory.canGoBack(),
      fwd: wc.navigationHistory.canGoForward(),
      saved: lib.isSaved(u),
      canSave: !!Library.seriesOf(u),
    });
  };
  ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']
    .forEach((ev) => wc.on(ev, pushNav));
  wc.on('did-finish-load', () => {
    if (isHome(wc.getURL())) { sendStartData(); wc.send('rb:theme', lib.d.prefs.theme); }
    if (userLoadPending) { userLoadPending = false; toUI('page:user-loaded', { url: wc.getURL() }); }
  });
  wc.on('did-navigate', (_e, url) => {
    if (appNav > 0 || appNavOnce) { appNavOnce = false; userLoadPending = false; return; }
    if (isHome(url)) return;
    userLoadPending = true;
    toUI('page:user-nav', { url });
  });

  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.selectionText && p.selectionText.trim()) {
      items.push({ label: 'Read selection aloud', click: () => toUI('cmd', { type: 'read-selection' }) });
    }
    items.push({ label: 'Read aloud from here', click: () => toUI('cmd', { type: 'read-from', pt: { x: p.x, y: p.y } }) });
    items.push({ type: 'separator' });
    if (p.selectionText) items.push({ role: 'copy' });
    if (p.linkURL) items.push({ label: 'Open link', click: () => wc.loadURL(p.linkURL) });
    items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
    items.push({ label: 'Reload', click: () => wc.reload() });
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  wc.loadURL(HOME);
}

/* ------------------------------------------------------------------ */
/*  Reading: text, highlight, next chapter                             */
/* ------------------------------------------------------------------ */
const run = (code) => view.webContents.executeJavaScript(code, true);
const EMPTY = { title: '', paras: [], sig: '', startIndex: 0, url: '' };

async function extractNow(pt, learn) {
  const host = hostOf(view.webContents.getURL());
  const hints = brain.hintsFor(host);
  const ex = await run(`(${EXTRACT_FN})(${JSON.stringify(pt || null)}, ${JSON.stringify({ csel: hints.csel, junk: hints.junk })})`);
  if (learn !== false && ex && ex.paras && ex.paras.length) brain.learnPage(ex.host || host, ex);
  return ex;
}

ipcMain.handle('tts:extract', async (_e, pt) => {
  try {
    let ex = await extractNow(pt);
    if (!ex.paras.length) { await sleep(900); ex = await extractNow(pt); }
    ex.resumeAt = pt ? 0 : brain.getPos(ex.url);
    ex.isIndex = looksLikeIndex(ex, null);
    return ex;
  } catch (_) { return EMPTY; }
});

// Highlight paragraph i, but only if the page still shows that chapter (url).
ipcMain.on('tts:highlight', (_e, d) => {
  const i = d && typeof d === 'object' ? Number(d.i) : Number(d);
  if (d && d.url && i >= 0 && Brain.key(view.webContents.getURL()) !== Brain.key(d.url)) return;
  run(`(${HL_FN})(${i})`).catch(() => {});
});

// A novel's own page (synopsis + chapter list) is not a chapter. Sites often send "Next" on the
// newest chapter back to it, and before 0.6 that page was read out as if it were the next chapter.
const NAMED = /(?:chapter|chap|ch\.?|episode|ep\.?|part)\s*[-_#.:]?\s*(\d+)/i;
const pathOf = (u) => { try { return decodeURIComponent(new URL(u).pathname); } catch (_) { return ''; } };
const chapterNo = (title, url) => {
  const m = NAMED.exec(title || '') || NAMED.exec(pathOf(url).split('/').pop() || '');
  return m ? Number(m[1]) : null;
};
function looksLikeIndex(ex, fromUrl) {
  if (!ex || !ex.paras) return false;
  const chars = ex.paras.reduce((n, p) => n + p.length, 0);
  const numbered = chapterNo(ex.title, ex.url) != null || NAMED.test(ex.docTitle || '');
  if (fromUrl && hostOf(fromUrl) === hostOf(ex.url)) {
    const a = pathOf(ex.url).replace(/\/+$/, ''), b = pathOf(fromUrl).replace(/\/+$/, '');
    if (a && b.startsWith(a + '/')) return true;            // one level up from the chapter: the novel's page
    if (!a) return !numbered;                                 // the site's home page
  }
  const links = ex.chapLinks || 0;
  if (!numbered && links >= 3 && chars < 3000) return true;
  if (links >= 25 && chars < 5000) return true;
  return false;
}

// Waits until a new chapter (different from prevSig) has appeared on the page.
async function waitChapter(prevSig, fromUrl, ms, token, fromTitle) {
  const wc = view.webContents;
  const t0 = Date.now();
  await sleep(600);
  while (Date.now() - t0 < ms) {
    if (token !== nextToken) return { ok: false, reason: 'cancelled' };
    if (!wc.isLoading()) {
      try {
        const ex = await extractNow(null, false);
        const chars = ex.paras.reduce((n, p) => n + p.length, 0);
        if (ex.paras.length && ex.sig !== prevSig) {
          // very short pages are usually an error page, not a chapter
          if (chars < 300) return { ok: false, reason: 'not-a-chapter' };
          if (looksLikeIndex(ex, fromUrl)) return { ok: false, reason: 'index' };
          // landed on an earlier chapter (e.g. a "first chapter" link): not the next one
          const was = chapterNo(fromTitle, fromUrl), now = chapterNo(ex.title, ex.url);
          if (was != null && now != null && now < was) return { ok: false, reason: 'not-a-chapter' };
          brain.learnPage(ex.host, ex);
          return { ok: true, ex };
        }
      } catch (_) {}
    }
    await sleep(400);
  }
  return { ok: false, reason: 'timeout' };
}

function labelFor(href, text) {
  const num = (() => { try { const u = new URL(href); const m = /(\d+)(?!.*\d)/.exec(u.pathname + u.search); return m ? Number(m[1]) : null; } catch (_) { return null; } })();
  const t = (text || '').trim();
  const meaningful = t && !/^(next|next chapter|next ch\.?|next page|[›»>→]+)$/i.test(t.replace(/[›»>→\s]+$/, '').trim()) ? t : '';
  return [num != null ? `Ch. ${num}` : '', meaningful].filter(Boolean).join(' · ');
}

async function backTo(url) {
  const wc = view.webContents;
  if (wc.getURL() === url) return;
  try { await wc.loadURL(url); } catch (_) {}
  await sleep(300);
}

// Click "next chapter", or follow rel=next, or count the chapter number up. Learns from the result.
ipcMain.on('tts:next-cancel', () => { nextToken++; });
ipcMain.handle('tts:next', async (_e, arg) => {
  appNav++;
  try { return await nextChapter(arg); } finally { setTimeout(() => { appNav--; }, 300); }
});
async function nextChapter(arg) {
  const token = ++nextToken;
  const gone = () => token !== nextToken;
  const wc = view.webContents;
  const prevSig = arg && typeof arg === 'object' ? arg.sig : arg;
  const fromTitle = arg && arg.fromTitle ? String(arg.fromTitle) : '';
  // The page must show the chapter we are coming from (you may have clicked elsewhere meanwhile)
  if (arg && arg.fromUrl && Brain.key(wc.getURL()) !== Brain.key(arg.fromUrl)) {
    await backTo(arg.fromUrl);
    await sleep(500);
    try { await extractNow(null, false); } catch (_) {}
    if (gone()) return { ok: false, reason: 'cancelled' };
  }
  const fromUrl = wc.getURL();
  const host = hostOf(fromUrl);
  const hints = brain.hintsFor(host);
  const tried = new Set();
  let lastReason = 'no-button';

  // 1) the best-scoring button or link on the page
  let ranked = [];
  try { ranked = brain.rank(await run(`(${NEXT_CANDS_FN})(${JSON.stringify(hints.next)})`), host); } catch (_) {}
  const best = ranked.find((c) => c.z >= 0);
  if (best) {
    toUI('next:info', { label: labelFor(best.href, best.text) });
    tried.add(best.href || '#btn');
    try { await run(`(${CLICK_FN})(${best.i})`); } catch (_) { /* page navigated while returning: fine */ }
    const r = await waitChapter(prevSig, fromUrl, 12000, token, fromTitle);
    if (r.reason === 'cancelled') return r;
    // "Next" leading to the novel's page just means there is no newer chapter yet: the button was right
    if (r.reason !== 'index') brain.learnNext(host, best, ranked, r.ok);
    if (r.ok) return r;
    lastReason = r.reason;
    await backTo(fromUrl);
  }

  if (gone()) return { ok: false, reason: 'cancelled' };
  // 2) <link rel="next"> declared by the site
  let relHref = '';
  try { relHref = await run(`(${LINK_NEXT_FN})()`); } catch (_) {}
  if (relHref && !tried.has(relHref)) {
    tried.add(relHref);
    toUI('next:info', { label: labelFor(relHref, '') });
    wc.loadURL(relHref).catch(() => {});
    const r = await waitChapter(prevSig, fromUrl, 12000, token, fromTitle);
    if (r.ok) return r;
    lastReason = r.reason;
    await backTo(fromUrl);
  }

  if (gone()) return { ok: false, reason: 'cancelled' };
  // 3) chapter links that count up: …/chapter-41 -> …/chapter-42
  const guess = Brain.bumpUrl(fromUrl);
  if (guess && !tried.has(guess) && brain.urlGuessAllowed(host)) {
    toUI('next:info', { label: labelFor(guess, '') });
    wc.loadURL(guess).catch(() => {});
    const r = await waitChapter(prevSig, fromUrl, 12000, token, fromTitle);
    if (r.reason === 'cancelled') return r;
    brain.learnUrl(host, r.ok);
    if (r.ok) return r;
    lastReason = r.reason;
    await backTo(fromUrl);
  }
  return { ok: false, reason: lastReason === 'index' ? 'no-button' : lastReason };
}

/* ------------------------------------------------------------------ */
/*  IPC                                                                */
/* ------------------------------------------------------------------ */
ipcMain.handle('nav:go', (_e, input) => { const u = normalize(input); if (u) view.webContents.loadURL(u).catch(() => {}); });
ipcMain.on('nav:back', () => view.webContents.navigationHistory.goBack());
ipcMain.on('nav:forward', () => view.webContents.navigationHistory.goForward());
ipcMain.on('nav:reload', () => view.webContents.reload());
ipcMain.on('nav:home', () => view.webContents.loadURL(HOME));

ipcMain.handle('tts:engine', () => engine);
ipcMain.on('tts:retry', () => startWorker());

ipcMain.on('tts:cancel', (_e, gen) => { if (worker && worker.connected) worker.send({ type: 'cancel', gen: Number(gen) || 0 }); });
ipcMain.handle('tts:synth', async (_e, { text, voice, speed, gen }) => {
  lastVoiceUse = Date.now();
  if (!worker && engine.state !== 'error') startWorker(true);   // asleep: wake it up
  await readyP;
  if (!worker || !worker.connected) throw new Error('Voice engine is not running');
  lastVoiceUse = Date.now();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.send({ type: 'synth', id, gen: Number(gen) || 0, text, voice, speed });
  });
});

ipcMain.handle('tts:selection', async () => {
  try { return String(await run('String(window.getSelection())')); } catch (_) { return ''; }
});

ipcMain.on('page:read-selection', () => toUI('cmd', { type: 'read-selection' }));
ipcMain.on('page:read-from', (_e, pt) => {
  if (pt && isFinite(pt.x) && isFinite(pt.y)) toUI('cmd', { type: 'read-from', pt: { x: +pt.x, y: +pt.y }, snip: String(pt.snip || '').slice(0, 60) });
});

// Where you stopped, and reading-list progress
ipcMain.on('pos:save', (_e, { url, i }) => { if (url) brain.setPos(url, Number(i) || 0); });
ipcMain.on('lib:progress', (_e, { url, title, prog, finished }) => {
  if (url && lib.progress(url, title, prog, finished)) { pushNav(); sendStartData(); }
});
ipcMain.on('lib:track', (_e, { url, title, pageTitle }) => {
  if (url && lib.track(String(url), String(title || ''), String(pageTitle || ''))) pushNav();
});
ipcMain.on('lib:toggle', (_e, title) => {
  const u = view.webContents.getURL();
  lib.toggle(u, title || view.webContents.getTitle(), view.webContents.getTitle());
  pushNav();
});

/* Floating panels <-> reader */
const ovName = (sender) => Object.keys(ov).find((k) => ov[k] && ov[k].webContents === sender);
ipcMain.on('ui:state', (_e, st) => { lastUIState = st; toOverlays('state', st); });
ipcMain.on('ov:act', (_e, a) => {
  if (!a || typeof a.act !== 'string') return;
  if (a.act === 'focus-page') { view.webContents.focus(); return; }
  if (a.act === 'theme') { lib.setPref('theme', lib.d.prefs.theme === 'light' ? 'dark' : 'light'); sendTheme(); return; }
  if (a.act === 'pl-add-page') {
    const u = view.webContents.getURL();
    // the chapter's own title; a page title loses its "| Site name" tail
    const title = (lastUIState && lastUIState.running && lastUIState.title) || view.webContents.getTitle().replace(/\s+[|–—]\s+[^|–—]+$/, '');
    const n = lib.plAdd(u, title);
    if (n) toUI('cmd', { type: 'note', text: `Added to playlist (${n} in the list)` });
    return;
  }
  toUI('cmd', { type: 'remote', act: a.act, val: a.val });
});
ipcMain.on('ov:size', (e, s) => {
  const name = ovName(e.sender);
  if (!name || !s || name === 'mode') return;
  const w = Math.max(40, Math.min(900, Math.round(+s.w || 0)));
  const h = Math.max(40, Math.min(900, Math.round(+s.h || 0)));
  const r = Math.max(0, Math.min(60, Math.round(+s.r || 0)));
  const old = ovSize[name];
  if (old.w === w && old.h === h && old.r === r) return;
  ovSize[name] = { w, h, r };
  try { ov[name].setBorderRadius(r); } catch (_) {}
  layout();
});
ipcMain.handle('ui:theme', () => (lib.d.prefs.theme === 'light' ? 'light' : 'dark'));

/* Start page (only the built-in start page may use these) */
const fromStart = (e) => view && e.sender === view.webContents && isHome(e.senderFrame ? e.senderFrame.url : view.webContents.getURL());
function startData() {
  return { ...lib.snapshot(), theme: lib.d.prefs.theme, brain: brain.stats(), pl: plState() };
}
function sendStartData() {
  if (view && alive(view.webContents) && isHome(view.webContents.getURL())) view.webContents.send('rb:data', startData());
}
ipcMain.handle('start:data', (e) => (fromStart(e) ? startData() : null));
// Opens a link and then reads it (or jumps on to its next chapter)
function openAndRead(u, cmd) {
  const wc = view.webContents;
  appNavOnce = true;
  if (cmd) wc.once('did-finish-load', () => setTimeout(() => toUI('cmd', cmd), 700));
  wc.loadURL(u).catch(() => {});
}
ipcMain.on('start:go', (e, { url, read, next }) => {
  if (!fromStart(e)) return;
  const u = normalize(url);
  if (!u) return;
  plStop();
  openAndRead(u, !read ? null : next ? { type: 'remote', act: 'next-chapter' } : { type: 'read', auto: true });
});

/* Playlist: the start page edits it, the reader plays it */
function plState() { return { items: lib.d.pl.items, at: lib.d.pl.at, active: plActive }; }
function plPlay(i) {
  const it = lib.d.pl.items[i];
  if (!it) return false;
  lib.d.pl.at = i; plActive = true; lib.save();
  openAndRead(it.url, { type: 'read', auto: true, playlist: { at: i, n: lib.d.pl.items.length } });
  sendStartData();
  return true;
}
function plStop() { if (plActive) { plActive = false; sendStartData(); } }
ipcMain.handle('pl:next', () => {
  const pl = lib.d.pl;
  if (pl.items[pl.at]) pl.items[pl.at].done = true;
  lib.save();
  if (plActive && pl.at + 1 < pl.items.length) return plPlay(pl.at + 1);
  plStop();
  return false;
});
ipcMain.on('pl:stop', () => plStop());
ipcMain.on('pl:title', (_e, { url, title }) => {
  const it = lib.d.pl.items[lib.d.pl.at];
  if (plActive && it && title) { it.title = String(title).slice(0, 140); lib.save(); }
});
const plFromStart = (name, fn) => ipcMain.on('start:' + name, (e, d) => { if (fromStart(e)) { fn(d || {}); sendStartData(); } });
plFromStart('pl-add', (d) => { const u = normalize(String(d.url || '')); if (u && !/google\.com\/search/.test(u)) lib.plAdd(u, String(d.title || '')); });
plFromStart('pl-remove', (d) => { const i = lib.plRemove(String(d.id || '')); if (i >= 0 && i === lib.d.pl.at) plActive = false; });
plFromStart('pl-up', (d) => lib.plUp(String(d.id || '')));
plFromStart('pl-clear', (d) => { plActive = false; lib.plClear(!!d.done); });
ipcMain.on('start:pl-play', (e, d) => {
  if (!fromStart(e)) return;
  const items = lib.d.pl.items;
  let i = d && d.id ? items.findIndex((x) => x.id === d.id) : items.findIndex((x) => !x.done);
  if (i < 0) { i = 0; items.forEach((x) => { x.done = false; }); }
  plPlay(i);
});
ipcMain.on('start:add-site', (e, { url, name }) => { if (fromStart(e)) { lib.addSite(String(url || ''), String(name || '')); sendStartData(); } });
ipcMain.on('start:remove-site', (e, host) => { if (fromStart(e)) { lib.removeSite(String(host)); sendStartData(); } });
ipcMain.on('start:remove', (e, id) => { if (fromStart(e)) { lib.remove(String(id)); sendStartData(); } });
ipcMain.on('start:forget', (e) => { if (fromStart(e)) { brain.forget(); sendStartData(); } });

/* ------------------------------------------------------------------ */
app.whenReady().then(() => {
  const dir = app.getPath('userData');
  brain = new Brain(dir);
  lib = new Library(dir);

  // Trim the browser cache if an older version let it grow.
  session.defaultSession.getCacheSize().then((s) => { if (s > CACHE_MAX * 1.3) session.defaultSession.clearCache(); }).catch(() => {});

  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (d, cb) => {
    try {
      const u = new URL(d.url);
      const h = u.hostname;
      let block = AD_HOSTS.some((a) => h === a || h.endsWith('.' + a));
      // third-party frames that look like ads (each one costs memory and CPU)
      if (!block && d.resourceType === 'subFrame' && d.frame && d.frame.url) {
        let top = '';
        try { top = new URL(view.webContents.getURL()).hostname; } catch (_) {}
        const third = top && !h.endsWith(top.replace(/^www\./, ''));
        block = third && AD_FRAME.test(h + u.pathname);
      }
      cb({ cancel: block });
    } catch (_) { cb({}); }
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'Reader',
    submenu: [
      { label: 'Read selection or page', accelerator: 'F9', click: () => toUI('cmd', { type: 'read' }) },
      { label: 'Pause / resume', accelerator: 'F8', click: () => toUI('cmd', { type: 'toggle' }) },
      { label: 'Stop', accelerator: 'F7', click: () => toUI('cmd', { type: 'stop' }) },
      { label: 'Previous paragraph', accelerator: 'Alt+Up', click: () => toUI('cmd', { type: 'remote', act: 'para-back' }) },
      { label: 'Next paragraph', accelerator: 'Alt+Down', click: () => toUI('cmd', { type: 'remote', act: 'para-next' }) },
      { label: 'Next chapter', accelerator: 'F10', click: () => toUI('cmd', { type: 'remote', act: 'next-chapter' }) },
      { label: 'Address bar', accelerator: 'CommandOrControl+L', click: () => { win.webContents.focus(); toUI('cmd', { type: 'focus-url' }); } },
      { label: 'Reload', accelerator: 'F5', click: () => view.webContents.reload() },
      { label: 'Back', accelerator: 'Alt+Left', click: () => toUI('cmd', { type: 'remote', act: 'back' }) },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => toUI('cmd', { type: 'remote', act: 'forward' }) },
      { type: 'separator' },
      { role: 'toggleDevTools' },
      { role: 'quit' },
    ],
  }]));

  createWindow();
  startWorker();
});

app.on('before-quit', () => {
  if (worker) { try { worker.kill(); } catch (_) {} }
  try { brain.flush(); lib.flush(); } catch (_) {}
});
app.on('window-all-closed', () => app.quit());
