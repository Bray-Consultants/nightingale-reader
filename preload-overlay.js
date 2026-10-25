// Bridge for the floating panels (player dock and tool rail).
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['state', 'ov:width', 'theme']);

contextBridge.exposeInMainWorld('ov', {
  act: (act, val) => ipcRenderer.send('ov:act', { act, val }),
  size: (w, h, r) => ipcRenderer.send('ov:size', { w, h, r }),
  on: (ch, fn) => { if (EVENTS.has(ch)) ipcRenderer.on(ch, (_e, d) => fn(d)); },
});
