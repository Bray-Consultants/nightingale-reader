(() => {
  const $ = (id) => document.getElementById(id);
  const sitesEl = $('sites'), books = $('books'), empty = $('empty'), brainEl = $('brain'), filters = $('filters');
  let data = { list: [], sites: [], brain: null };
  let filter = 'all';
  try { filter = localStorage.getItem('rb-filter') || 'all'; } catch (_) {}

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
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
      const ch = x.chapter || (x.num != null ? 'Chapter ' + x.num : '');
      const action = x.status === 'unread' ? 'Start' : x.status === 'finished' ? 'Read again' : 'Continue';
      return `<li class="book">` +
        `<div class="cover" data-url="${esc(x.url)}" style="background:linear-gradient(135deg,hsl(${h} 42% 38%),hsl(${(h + 40) % 360} 30% 22%))" title="Open ${esc(x.title)}">` +
        `<span class="h">${esc(x.host)}</span><span class="t">${esc(x.title)}</span></div>` +
        `<button class="x" type="button" data-id="${esc(x.id)}" title="Remove from reading list" aria-label="Remove ${esc(x.title)} from reading list">${X}</button>` +
        `<div class="meta"><div class="ch" title="${esc(ch)}">${esc(ch) || '&nbsp;'}</div>` +
        `<div class="bar"><i style="width:${x.status === 'finished' ? 100 : pct}%"></i></div>` +
        `<div class="row"><span class="tag ${esc(x.status)}">${STATUS[x.status] || ''}${x.status === 'progress' ? ` ${pct}%` : ''}</span>` +
        `<button class="play" type="button" data-url="${esc(x.url)}">${action}</button></div></div></li>`;
    }).join('');
    if (!data.list.length) {
      empty.hidden = false;
      empty.textContent = 'Nothing saved yet. Open a chapter and press the bookmark on the right-hand rail to keep the novel here.';
    } else if (!items.length) {
      empty.hidden = false;
      empty.textContent = 'No novels in this list.';
    } else empty.hidden = true;
  }
  books.addEventListener('click', (e) => {
    const p = e.target.closest('.play[data-url]');
    if (p) { rb.go(p.dataset.url, true); return; }
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
    renderSites(); renderBooks(); renderBrain();
  }

  rb.on('data', render);
  rb.on('theme', (t) => { document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark'; });
  rb.data().then(render);
  $('q').focus();
})();
