(() => {
  const $ = (id) => document.getElementById(id);
  const sitesEl = $('sites'), books = $('books'), empty = $('empty'), brainEl = $('brain'), filters = $('filters');
  let data = { list: [], sites: [], brain: null, pl: { items: [], at: -1, active: false } };
  let filter = 'all';
  try { filter = localStorage.getItem('rb-filter') || 'all'; } catch (_) {}

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h10M4 12h10M4 17h6"/><path d="M18 14v6M15 17h6"/></svg>';
  const IC = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l9.6-6.2a.8.8 0 0 0 0-1.4L9.2 5.1A.8.8 0 0 0 8 5.8z"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14l6-6 6 6"/></svg>',
    eq: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="9" width="3" height="10" rx="1"/><rect x="10.5" y="5" width="3" height="14" rx="1"/><rect x="16" y="11" width="3" height="8" rx="1"/></svg>',
  };
  const X = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  /* search / read aloud */
  $('go').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('q').value.trim();
    if (!v) { $('q').focus(); return; }
    const looksLikeLink = /^https?:\/\//i.test(v) || (!/\s/.test(v) && /\.[a-z]{2,}/i.test(v));
    rb.go(v, looksLikeLink);
  });

  /* favourite sites */
  function renderSites() {
    let html = '';
    for (const s of data.sites) {
      html += `<li class="site"><a href="#" data-url="${esc(s.url)}" title="${esc(s.host)}"><span class="av">${esc((s.name || s.host)[0].toUpperCase())}</span><span class="nm">${esc(s.name)}</span></a>` +
        `<button class="x" type="button" data-host="${esc(s.host)}" title="Remove ${esc(s.name)}" aria-label="Remove ${esc(s.name)}">${X}</button></li>`;
    }
    if (data.sites.length < 12) {
      html += `<li class="site" id="addTile"><button class="add" type="button" id="addBtn"><span class="av">+</span><span class="nm">Add site</span></button></li>` +
        `<li class="addform" id="addForm"><input id="addUrl" placeholder="Site address, e.g. novelhost.com" aria-label="Site address"><button class="save" type="button" id="addSave">Add</button><button type="button" id="addCancel">Cancel</button></li>`;
    }
    sitesEl.innerHTML = html;
    const tile = $('addTile'), form = $('addForm');
    if (tile) {
      $('addBtn').onclick = () => { tile.style.display = 'none'; form.classList.add('on'); $('addUrl').focus(); };
      const close = () => { form.classList.remove('on'); tile.style.display = ''; };
      $('addCancel').onclick = close;
      const add = () => { const v = $('addUrl').value.trim(); if (v) rb.addSite(v, ''); close(); };
      $('addSave').onclick = add;
      $('addUrl').onkeydown = (e) => { if (e.key === 'Enter') add(); if (e.key === 'Escape') close(); };
    }
  }
  sitesEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-url]');
    if (a) { e.preventDefault(); rb.go(a.dataset.url, false); return; }
    const x = e.target.closest('.x[data-host]');
    if (x) rb.removeSite(x.dataset.host);
  });

  /* reading list */
  const STATUS = { unread: 'Unread', progress: 'In progress', finished: 'Finished' };
  function renderBooks() {
    for (const b of filters.children) b.setAttribute('aria-pressed', String(b.dataset.f === filter));
    const items = data.list.filter((x) => filter === 'all' || x.status === filter);
    books.innerHTML = items.map((x) => {
      const h = hue(x.key);
      const pct = Math.round((x.prog || 0) * 100);
      let ch = x.chapter || (x.num != null ? 'Chapter ' + x.num : '');
      if (x.num != null && ch && !new RegExp('\\b' + x.num + '\\b').test(ch)) ch = 'Ch. ' + x.num + ' · ' + ch;
      ch = ch ? 'Last read: ' + ch : '';
      const done = x.status === 'progress' && (x.prog || 0) >= 0.99;
      const action = x.status === 'unread' ? 'Start' : x.status === 'finished' ? 'Read again' : done ? 'Next chapter' : 'Continue';
      return `<li class="book">` +
        `<div class="cover" data-url="${esc(x.url)}" style="background:linear-gradient(135deg,hsl(${h} 42% 38%),hsl(${(h + 40) % 360} 30% 22%))" title="Open ${esc(x.title)}">` +
        `<span class="h">${esc(x.host)}</span><span class="t">${esc(x.title)}</span></div>` +
        `<button class="x" type="button" data-id="${esc(x.id)}" title="Remove from reading list" aria-label="Remove ${esc(x.title)} from reading list">${X}</button>` +
        `<div class="meta"><div class="ch" title="${esc(ch)}">${esc(ch) || '&nbsp;'}</div>` +
        `<div class="bar"><i style="width:${x.status === 'finished' ? 100 : pct}%"></i></div>` +
        `<div class="row"><span class="tag ${esc(x.status)}">${done ? 'Chapter done' : (STATUS[x.status] || '') + (x.status === 'progress' ? ` ${pct}%` : '')}</span>` +
        `<span class="btns"><button class="addq" type="button" data-url="${esc(x.url)}" data-title="${esc(x.chapter || x.title)}" title="Add this chapter to the playlist" aria-label="Add ${esc(x.title)} to the playlist">${PLUS}</button>` +
        `<button class="play" type="button" data-url="${esc(x.url)}"${done ? ' data-next="1"' : ''}>${action}</button></span></div>` +
        (x.heard ? `<div class="heard">${x.heard} chapter${x.heard === 1 ? '' : 's'} listened</div>` : '') + `</div></li>`;
    }).join('');
    if (!data.list.length) {
      empty.hidden = false;
      empty.textContent = 'Novels you listen to show up here by themselves, one card per novel, with the last chapter you were on.';
    } else if (!items.length) {
      empty.hidden = false;
      empty.textContent = 'No novels in this list.';
    } else empty.hidden = true;
  }
  books.addEventListener('click', (e) => {
    const q = e.target.closest('.addq[data-url]');
    if (q) { rb.plAdd(q.dataset.url, q.dataset.title); q.style.background = 'var(--stroke)'; setTimeout(() => { q.style.background = ''; }, 600); return; }
    const p = e.target.closest('.play[data-url]');
    if (p) { rb.go(p.dataset.url, true, !!p.dataset.next); return; }
    const c = e.target.closest('.cover[data-url]');
    if (c) { rb.go(c.dataset.url, false); return; }
    const x = e.target.closest('.x[data-id]');
    if (x) rb.remove(x.dataset.id);
  });
  filters.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    filter = b.dataset.f;
    try { localStorage.setItem('rb-filter', filter); } catch (_) {}
    renderBooks();
  });

  /* playlist */
  const plEl = $('pl'), plEmpty = $('plEmpty'), plCtl = $('plCtl');
  // "Lantern Road · Ch. 3" from the link itself, before the chapter has been opened
  function guessName(u) {
    try {
      const x = new URL(u);
      const segs = x.pathname.split('/').filter(Boolean).map((z) => { try { return decodeURIComponent(z); } catch (_) { return z; } });
      const num = (/(\d+)(?!.*\d)/.exec(x.pathname + x.search) || [])[1];
      let last = segs[segs.length - 1] || '';
      const m = /^(.*?)[-_. ]*(?:chapter|chap|ch|episode|ep|part)[-_. ]*\d+/i.exec(last.replace(/\.\w+$/, ''));
      let name = m && m[1].replace(/[-_. ]/g, '').length >= 2 ? m[1] : (segs.length > 1 && /\d/.test(last) ? segs[segs.length - 2] : last);
      name = name.replace(/\.\w+$/, '').replace(/[-_+]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
      if (/^\d+$/.test(name)) name = '';
      return [name || x.hostname.replace(/^www\./, ''), num ? 'Ch. ' + num : ''].filter(Boolean).join(' · ');
    } catch (_) { return u; }
  }
  const where = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + decodeURI(x.pathname); } catch (_) { return u; } };
  function renderPl() {
    const p = data.pl || { items: [] };
    plEl.innerHTML = p.items.map((it, i) => {
      const now = p.active && i === p.at;
      return `<li class="pli${now ? ' now' : ''}${it.done && !now ? ' done' : ''}">` +
        `<span class="no">${now ? IC.eq : i + 1}</span>` +
        `<span class="tx"><b>${esc(it.title || guessName(it.url))}</b><small>${esc(where(it.url))}</small></span>` +
        `<button class="ib" type="button" data-up="${esc(it.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${IC.up}</button>` +
        `<button class="ib" type="button" data-play="${esc(it.id)}" aria-label="Play from here">${IC.play}</button>` +
        `<button class="ib" type="button" data-rm="${esc(it.id)}" aria-label="Remove">${X}</button></li>`;
    }).join('');
    plEmpty.hidden = !!p.items.length;
    plCtl.hidden = !p.items.length;
    $('plClearDone').hidden = !p.items.some((x) => x.done);
    $('plPlay').textContent = p.items.some((x) => x.done) && p.items.some((x) => !x.done) ? 'Play the rest' : 'Play all';
  }
  $('plAdd').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('plUrl').value.trim();
    if (!v) { $('plUrl').focus(); return; }
    for (const u of v.split(/\s+/).filter(Boolean)) rb.plAdd(u, '');
    $('plUrl').value = '';
  });
  plEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.play) rb.plPlay(b.dataset.play);
    else if (b.dataset.up) rb.plUp(b.dataset.up);
    else if (b.dataset.rm) rb.plRemove(b.dataset.rm);
  });
  $('plPlay').onclick = () => rb.plPlay('');
  $('plClear').onclick = () => rb.plClear(false);
  $('plClearDone').onclick = () => rb.plClear(true);

  /* what the reader has learned (all on this PC) */
  function renderBrain() {
    const b = data.brain;
    if (!b) { brainEl.textContent = ''; return; }
    const kb = Math.max(1, Math.round(b.bytes / 1024));
    if (!b.sites) {
      brainEl.innerHTML = 'The reader learns how each site lays out its chapters as you listen. It stays on this PC.';
      return;
    }
    brainEl.innerHTML = `The reader has learned the layout of ${b.sites} site${b.sites === 1 ? '' : 's'} (${kb} KB, kept on this PC). <button type="button" id="forget">Forget what it learned</button>`;
    $('forget').onclick = () => rb.forget();
  }

  function render(d) {
    if (!d) return;
    data = d;
    document.documentElement.dataset.theme = d.theme === 'light' ? 'light' : 'dark';
    renderSites(); renderPl(); renderBooks(); renderBrain();
  }

  rb.on('data', render);
  rb.on('theme', (t) => { document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark'; });
  rb.data().then(render);
})();
