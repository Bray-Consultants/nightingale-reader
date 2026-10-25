(() => {
  const $ = (id) => document.getElementById(id);
  const orb = $('orb'), fill = $('fill'), title = $('title'), status = $('status'), note = $('note'), orbPct = $('orbPct');
  const stop = $('stop'), retry = $('retry'), fold = $('fold'), pback = $('pback'), pnext = $('pnext');
  const bar = $('bar'), barFill = $('barFill'), thumb = $('barThumb'), tip = $('tip'), tPos = $('tPos'), tLeft = $('tLeft');
  const C = 2 * Math.PI * 27.5;
  fill.style.strokeDasharray = C;
  fill.style.strokeDashoffset = C;

  let folded = false;
  try { folded = localStorage.getItem('rb-dock-folded') === '1'; } catch (_) {}
  let st = null;
  let dragging = false;

  function size() {
    if (folded) ov.size(136, 84, 42); else ov.size(640, 84, 42);
    document.body.classList.toggle('folded', folded);
    fold.title = folded ? 'Show the player' : 'Fold the player';
    fold.setAttribute('aria-label', fold.title);
  }
  function ring(p) {
    const v = p == null ? 0 : Math.max(0, Math.min(1, p));
    fill.style.strokeDashoffset = String(C * (1 - v));
  }
  const mmss = (s) => {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
  };
  function showBar(f, dur) {
    const v = Math.max(0, Math.min(1, f || 0));
    barFill.style.width = (v * 100) + '%';
    thumb.style.left = (v * 100) + '%';
    tPos.textContent = mmss(v * dur);
    tLeft.textContent = '-' + mmss((1 - v) * dur);
    bar.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    bar.setAttribute('aria-valuetext', `${mmss(v * dur)} of about ${mmss(dur)}`);
  }

  function render(s) {
    st = s;
    const e = s.engine || {};
    const usable = e.state === 'ready' || e.state === 'sleeping';
    const err = e.state === 'error' && !s.running;
    const opening = s.running && /^Opening next chapter/.test(s.status || '');
    let mode, line = s.status || '';
    const name = s.title || s.pageTitle || s.lastTitle || '';

    if (err) {
      mode = 'retry';
      line = e.msg || 'The voice didn’t load. Check the connection and press Retry';
      ring(0);
    } else if (s.running && !usable && !s.paused) {
      mode = 'wait';
      line = e.msg || (e.pct ? `Loading voice… ${e.pct}%` : 'Loading voice…');
      ring(e.pct ? e.pct / 100 : 0);
    } else if (s.running) {
      mode = s.paused ? 'play' : 'pause';
      ring(opening ? 1 : s.prog);
    } else if (usable) {
      mode = 'play';
      if (!line || line === 'Ready') line = e.state === 'sleeping' ? 'Ready. The voice wakes up when you press play' : 'Ready';
      ring(0);
    } else {
      mode = 'wait';
      line = e.msg || (e.pct && e.pct < 100 ? `Loading voice… ${e.pct}%` : 'Loading voice…');
      ring(e.pct ? e.pct / 100 : 0);
    }

    const seekable = !!s.canSeek && s.dur > 0 && !err;
    document.body.dataset.orb = mode;
    document.body.classList.toggle('err', err || s.cls === 'err');
    document.body.classList.toggle('seekable', seekable);
    orbPct.textContent = mode === 'wait' && e.pct ? e.pct + '%' : '';
    title.textContent = name || (usable ? 'Ready to read' : 'Getting the voice ready');
    title.title = title.textContent;
    status.textContent = line;
    status.title = line;
    // with the seek bar showing, short notes ride next to the title
    const n = seekable ? line.replace(/^Reading\.?\s*/, '') : '';
    note.textContent = n;
    note.title = n;
    if (seekable && !dragging) showBar(s.prog, s.dur);
    stop.disabled = !s.running;
    pback.disabled = pnext.disabled = !s.canSkip;

    const label = mode === 'retry' ? 'Retry loading the voice'
      : s.running ? (s.paused ? 'Resume (F8)' : 'Pause (F8)') : 'Read (F9)';
    orb.title = label;
    orb.setAttribute('aria-label', label);
  }

  /* seek bar: click or drag anywhere on it */
  const fracAt = (x) => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width))); };
  function preview(x) {
    const f = fracAt(x);
    const dur = st ? st.dur : 0;
    tip.textContent = mmss(f * dur);
    tip.style.left = (f * 100) + '%';
    if (dragging) showBar(f, dur);
    return f;
  }
  bar.addEventListener('pointermove', (e) => preview(e.clientX));
  bar.addEventListener('pointerdown', (e) => {
    if (!st || !st.canSeek) return;
    dragging = true;
    bar.classList.add('drag');
    bar.setPointerCapture(e.pointerId);
    preview(e.clientX);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('drag');
    ov.act('seek', preview(e.clientX));
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', () => { dragging = false; bar.classList.remove('drag'); });
  bar.addEventListener('keydown', (e) => {
    if (!st || !st.canSeek || !st.dur) return;
    const step = 10 / st.dur;                       // 10 seconds
    if (e.key === 'ArrowRight') { e.preventDefault(); ov.act('seek', Math.min(1, (st.prog || 0) + step)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); ov.act('seek', Math.max(0, (st.prog || 0) - step)); }
  });

  orb.onclick = () => ov.act('orb');
  stop.onclick = () => ov.act('stop');
  pback.onclick = () => ov.act('para-back');
  pnext.onclick = () => ov.act('para-next');
  retry.onclick = () => ov.act('retry');
  fold.onclick = () => {
    folded = !folded;
    try { localStorage.setItem('rb-dock-folded', folded ? '1' : '0'); } catch (_) {}
    size();
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ' && e.target === document.body) { e.preventDefault(); ov.act('orb'); }
  });

  ov.on('theme', (t) => { document.documentElement.dataset.theme = t; });
  ov.on('state', render);
  size();
})();
