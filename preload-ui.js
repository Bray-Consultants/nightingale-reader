const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['nav', 'cmd', 'tts:state', 'theme', 'next:info']);

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
  next: (sig, fromUrl) => ipcRenderer.invoke('tts:next', { sig, fromUrl }),
  highlight: (i, url) => ipcRenderer.send('tts:highlight', { i, url }),
  publish: (st) => ipcRenderer.send('ui:state', st),
  theme: () => ipcRenderer.invoke('ui:theme'),

  savePos: (url, i) => ipcRenderer.send('pos:save', { url, i }),
  libProgress: (url, title, prog, finished) => ipcRenderer.send('lib:progress', { url, title, prog, finished }),
  libToggle: (title) => ipcRenderer.send('lib:toggle', title),

  on: (ch, fn) => { if (EVENTS.has(ch)) ipcRenderer.on(ch, (_e, d) => fn(d)); },
});
