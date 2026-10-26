// Runs inside every page you open. Shows a small "Read aloud" button next to selected text.
// On the built-in start page only, it also exposes the reading list and favourite sites.
const { ipcRenderer, contextBridge } = require('electron');

if (location.protocol === 'file:' && /\/start\.html$/i.test(location.pathname)) {
  contextBridge.exposeInMainWorld('rb', {
    data: () => ipcRenderer.invoke('start:data'),
    go: (url, read, next) => ipcRenderer.send('start:go', { url, read: !!read, next: !!next }),
    plAdd: (url, title) => ipcRenderer.send('start:pl-add', { url, title: title || '' }),
    plRemove: (id) => ipcRenderer.send('start:pl-remove', { id }),
    plUp: (id) => ipcRenderer.send('start:pl-up', { id }),
    plPlay: (id) => ipcRenderer.send('start:pl-play', { id: id || '' }),
    plClear: (done) => ipcRenderer.send('start:pl-clear', { done: !!done }),
    addSite: (url, name) => ipcRenderer.send('start:add-site', { url, name }),
    removeSite: (host) => ipcRenderer.send('start:remove-site', host),
    remove: (id) => ipcRenderer.send('start:remove', id),
    forget: () => ipcRenderer.send('start:forget'),
    on: (ch, fn) => { if (ch === 'data' || ch === 'theme') ipcRenderer.on('rb:' + ch, (_e, d) => fn(d)); },
  });
}

let host = null;
let selPt = null;   // where the selection starts, for "Read from here"

function ensure() {
  if (host) return host;
  host = document.createElement('div');
  host.style.cssText = 'position:absolute;z-index:2147483647;display:none;';
  const sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML =
    '<style>.b{display:inline-flex;gap:2px;padding:3px;border-radius:999px;background:#1c1e27;' +
    'box-shadow:0 6px 18px rgba(0,0,0,.3),inset 0 0 0 1px rgba(255,255,255,.08)}' +
    'button{all:unset;cursor:pointer;color:#efe6d3;font:600 13px "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;' +
    'padding:6px 13px;border-radius:999px;white-space:nowrap}button:hover{background:#2c2f3b}' +
    'button.main{background:#efe6d3;color:#1c1d23}button.main:hover{background:#fffaf0}</style>' +
    '<div class="b"><button type="button" class="main" data-a="from">Read from here</button>' +
    '<button type="button" data-a="sel">Read selection</button></div>';
  sh.querySelectorAll('button').forEach((b) => b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (b.dataset.a === 'from' && selPt) ipcRenderer.send('page:read-from', selPt);
    else ipcRenderer.send('page:read-selection');
    hide();
  }));
  document.documentElement.appendChild(host);
  return host;
}

function hide() { if (host) host.style.display = 'none'; }

function show() {
  const sel = window.getSelection();
  const text = sel ? String(sel).trim() : '';
  if (text.length < 3 || !sel.rangeCount) { hide(); return; }
  const range = sel.getRangeAt(0);
  const r = range.getBoundingClientRect();
  if (!r.width && !r.height) { hide(); return; }
  // first line of the selection = where "Read from here" starts
  const first = range.getClientRects()[0] || r;
  selPt = { x: Math.round(first.left + Math.min(4, first.width / 2)), y: Math.round(first.top + first.height / 2), snip: text.slice(0, 60) };
  const h = ensure();
  h.style.display = 'block';
  const top = r.top > 52 ? r.top - 46 : r.bottom + 10;
  h.style.top = top + window.scrollY + 'px';
  h.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - 270)) + 'px';
}

window.addEventListener('mouseup', () => setTimeout(show, 10), true);
window.addEventListener('keyup', (e) => { if (e.shiftKey) setTimeout(show, 10); }, true);
window.addEventListener('mousedown', (e) => { if (!host || e.target !== host) hide(); }, true);
window.addEventListener('scroll', () => { if (host && host.style.display !== 'none') show(); }, { passive: true });
document.addEventListener('selectionchange', () => {
  const s = window.getSelection();
  if (!s || !String(s).trim()) hide();
});
