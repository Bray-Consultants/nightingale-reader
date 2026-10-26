const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['nav', 'cmd', 'tts:state', 'theme', 'next:info', 'page:user-nav', 'page:user-loaded']);

contextBridge.exposeInMainWorld('api', {
  go: (u) => ipcRenderer.invoke('nav:go', u),
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  home: () => ipcRenderer.send('nav:home'),

  engine: () => ipcRenderer.invoke('tts:engine'),
  retryEngine: () => ipcRenderer.send('tts:retry'),
  synth: (text, voice, speed, gen) => ipcRenderer.invoke('tts:synth', { text, voice, speed, gen }),
  cancel: (gen) => ipcRenderer.send('tts:cancel', gen),
  nextCancel: () => ipcRenderer.send('tts:next-cancel'),
  selection: () => ipcRenderer.invoke('tts:selection'),
  extract: (pt) => ipcRenderer.invoke('tts:extract', pt || null),
  next: (sig, fromUrl, fromTitle) => ipcRenderer.invoke('tts:next', { sig, fromUrl, fromTitle }),
  highlight: (i, url) => ipcRenderer.send('tts:highlight', { i, url }),
  publish: (st) => ipcRenderer.send('ui:state', st),
  theme: () => ipcRenderer.invoke('ui:theme'),

  savePos: (url, i) => ipcRenderer.send('pos:save', { url, i }),
  libProgress: (url, title, prog, finished) => ipcRenderer.send('lib:progress', { url, title, prog, finished }),
  libToggle: (title) => ipcRenderer.send('lib:toggle', title),
  libTrack: (url, title, pageTitle) => ipcRenderer.send('lib:track', { url, title, pageTitle }),
  plNext: () => ipcRenderer.invoke('pl:next'),
  plStop: () => ipcRenderer.send('pl:stop'),
  plTitle: (url, title) => ipcRenderer.send('pl:title', { url, title }),

  on: (ch, fn) => { if (EVENTS.has(ch)) ipcRenderer.on(ch, (_e, d) => fn(d)); },
});
