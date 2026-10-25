(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    url: $('url'), back: $('back'), fwd: $('fwd'), reload: $('reload'), home: $('home'),
    addr: $('addr'), vhost: $('vhost'), vpath: $('vpath'), load: $('load'),
    icoLock: $('ico-lock'), icoSearch: $('ico-search'),
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const VOICES = ['af_heart', 'am_michael', 'bf_emma'];

  // How far ahead the voice works. Big enough to hide any hiccup, small enough to cancel cheaply.
  const AHEAD_S = 25;        // seconds of speech kept ready
  const INFLIGHT = 2;        // requests queued at the voice at once (no idle gap between sentences)
  const LEAD_S = 8;          // start fetching the next chapter when this much of the current one is left
  const PARA_GAP = 0.28;     // breath between paragraphs
  const CH_GAP = 0.9;        // pause between chapters

  /* ---------------- state ---------------- */
  let engine = { state: 'loading', pct: 0, msg: '' };
  let session = 0;           // every start / stop / skip / seek bumps this; stale work is dropped
  let running = false;
  let paused = false;

  let ctx = null;            // Web Audio
  let nextT = 0;             // when the last scheduled sound ends
  let lastKey = null;        // ch:para of the last scheduled chunk (for pauses)
  let timeline = [];         // { t, dur, ch, n, para } what plays when
  const sources = new Set();

  // A reading = the chapters met since you pressed play. Survives skips and seeks.
  let reading = null;        // { chapters: [ {ex, chunks, chars, title, url, sig} ], pageCh, mode, label }
  let heard = null;          // timeline entry being heard right now
  let cps = 14.5;            // characters per second of speech at 1×, learned while reading

  const ui = { status: '', cls: '', title: '', prog: null, pos: 0, dur: 0, nextNote: '' };
  const nav = { url: '', title: '', saved: false, canSave: false };
  let lastTitle = '';
  let libProgSent = -1;
  let lastPosSaved = '';

  /* ---------------- saved settings ---------------- */
  const set = { voice: 'af_heart', speed: 1, auto: true };
  try {
    const s = JSON.parse(localStorage.getItem('rb') || '{}');
    if (VOICES.includes(s.voice)) set.voice = s.voice;
    if (s.speed && isFinite(+s.speed)) set.speed = Math.min(1.5, Math.max(0.8, +s.speed));
    if (typeof s.auto === 'boolean') set.auto = s.auto;
    if (s.cps && isFinite(+s.cps)) cps = Math.min(25, Math.max(8, +s.cps));
  } catch (_) {}
  const save = () => {
    try { localStorage.setItem('rb', JSON.stringify({ voice: set.voice, speed: String(set.speed), auto: set.auto, cps: Math.round(cps * 10) / 10 })); } catch (_) {}
  };

  /* ---------------- publish to the floating panels ---------------- */
  let pubQueued = false;
  function publish() {
    if (pubQueued) return;
    pubQueued = true;
    queueMicrotask(() => {
      pubQueued = false;
      api.publish({
        engine, running, paused,
        status: ui.status, cls: ui.cls, title: ui.title, prog: ui.prog,
        pos: ui.pos, dur: ui.dur, canSeek: !!(running && reading && reading.mode === 'page' && heard),
        voice: set.voice, speed: set.speed, auto: set.auto,
        saved: nav.saved, canSave: nav.canSave, canSkip: !!(running && reading && reading.mode === 'page'),
        pageTitle: nav.url ? nav.title : '', lastTitle,
      });
    });
  }

  /* ---------------- status ---------------- */
  const voiceUsable = () => engine.state === 'ready' || engine.state === 'sleeping';
  function say(msg, cls) { ui.status = msg; ui.cls = cls || ''; publish(); }
  function idleStatus() {
    if (voiceUsable()) say('Ready');
    else if (engine.state === 'error') say(engine.msg || 'Voice engine failed', 'err');
    else if (engine.msg) say(engine.msg);
    else say(engine.pct ? `Loading voice… ${engine.pct}%` : 'Loading voice…');
  }
  function liveStatus() {
    if (!running) return;
    say(paused ? 'Paused' : 'Reading' + (ui.nextNote ? '. ' + ui.nextNote : ''), 'live');
  }

  /* ---------------- text → chunks ---------------- */
  function clean(t) {
    return t
      .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
      .replace(/[—–]/g, ', ')
      .replace(/\*+|_{2,}|[\[\]{}<>|~^#=\\]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function sentences(t) {
    t = t.replace(/\b(Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|vs|etc|No)\./g, '$1\u0000');
    const m = t.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g) || [t];
    return m.map((s) => s.replace(/\u0000/g, '.').trim()).filter(Boolean);
  }
  function splitLong(s) {
    const bits = s.split(/(?<=[,;:])\s+/);
    const res = [];
    let b = '';
    for (const x of bits) {
      if (b && (b + ' ' + x).length > 240) { res.push(b); b = x; } else b = b ? b + ' ' + x : x;
    }
    if (b) res.push(b);
    return res.flatMap((r) => (r.length > 300 ? (r.match(/.{1,260}(\s|$)/g) || [r]).map((z) => z.trim()) : [r]));
  }
  function addText(out, text, para) {
    let buf = '';
    const push = () => {
      if (buf && /[\p{L}\p{N}]/u.test(buf)) out.push({ text: buf, para });
      buf = '';
    };
    for (const s of sentences(clean(text))) {
      for (const part of (s.length > 260 ? splitLong(s) : [s])) {
        if (buf && buf.length + part.length + 1 > 200) push();
        buf = buf ? buf + ' ' + part : part;
      }
    }
    push();
  }
  // A chapter as a list of chunks with running character offsets (for time and seeking)
  function makeChapter(ex) {
    const chunks = [];
    if (ex.title) addText(chunks, ex.title + '.', -1);
    for (let i = 0; i < ex.paras.length; i++) addText(chunks, ex.paras[i], i);
    let c = 0;
    for (const k of chunks) { k.at = c; c += k.text.length; }
    return { ex, chunks, chars: Math.max(1, c), title: ex.title || 'This page', url: ex.url, sig: ex.sig };
  }
  const chunkOfPara = (chap, para) => {
    const i = chap.chunks.findIndex((k) => k.para >= para);
    return i < 0 ? chap.chunks.length : i;
  };

  /* ---------------- audio ---------------- */
  function audio() {
    if (!ctx) ctx = new AudioContext({ sampleRate: 24000, latencyHint: 'playback' });
    return ctx;
  }
  function schedule(f32, sr, entry) {
    const c = audio();
    const buf = c.createBuffer(1, f32.length, sr);
    buf.copyToChannel(f32, 0);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    let t = Math.max(c.currentTime + 0.05, nextT);
    const key = entry.ch + ':' + entry.para;
    if (lastKey !== null && key !== lastKey) t += String(entry.ch) !== lastKey.split(':')[0] ? CH_GAP : PARA_GAP;
    lastKey = key;
    src.start(t);
    nextT = t + buf.duration;
    timeline.push({ ...entry, t, dur: buf.duration });
    sources.add(src);
    src.onended = () => { sources.delete(src); };
  }
  const ahead = () => (ctx ? Math.max(0, nextT - ctx.currentTime) : 0);

  // Stops sound and all queued work. Keeps `reading` so skips and seeks can restart instantly.
  function halt() {
    session++;
    api.cancel(session);           // the voice drops every queued sentence from before
    api.nextCancel();              // and any next-chapter jump still in progress stops
    for (const s of sources) { s.onended = null; try { s.stop(); } catch (_) {} }
    sources.clear();
    nextT = 0; timeline = []; lastKey = null; paused = false; heard = null;
    ui.nextNote = '';
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }
  function stopAll() {
    halt();
    clearTimeout(jumpTimer); jumpT = null;
    running = false;
    reading = null;
    ui.title = ''; ui.prog = null; ui.pos = 0; ui.dur = 0;
    api.highlight(-1);
    publish();
    idleStatus();
  }

  /* ---------------- what you hear right now ---------------- */
  setInterval(() => {
    if (!running || !ctx || !timeline.length || !reading) return;
    const now = ctx.currentTime;
    let hit = null;
    for (let i = timeline.length - 1; i >= 0; i--) if (timeline[i].t <= now) { hit = timeline[i]; break; }
    while (timeline.length > 2 && timeline[1].t + 0.01 <= now && timeline[1] !== hit) {
      if (timeline[0] === hit) break;
      timeline.shift();
    }
    if (!hit) return;
    const chap = reading.chapters[hit.ch];
    if (!chap) return;
    const changed = !heard || heard.ch !== hit.ch || heard.para !== hit.para;
    heard = hit;
    if (changed) {
      if (reading.mode === 'page') {
        api.highlight(hit.para, chap.url);
        if (hit.para > 0 && chap.url) { api.savePos(chap.url, hit.para); lastPosSaved = chap.url; }
      }
      if (ui.title !== chap.title) { ui.title = chap.title; lastTitle = chap.title; libProgSent = -1; }
    }
    // position within the chapter, in characters, then in estimated seconds
    const k = chap.chunks[hit.n];
    const frac = hit.dur ? Math.min(1, Math.max(0, (now - hit.t) / hit.dur)) : 0;
    const at = (k ? k.at + frac * k.text.length : 0);
    const rate = cps * set.speed;
    const prog = Math.min(1, at / chap.chars);
    const pos = at / rate, dur = chap.chars / rate;
    if (Math.abs(prog - (ui.prog || 0)) > 0.002 || Math.abs(pos - ui.pos) > 0.4 || Math.abs(dur - ui.dur) > 1) {
      ui.prog = prog; ui.pos = pos; ui.dur = dur;
      publish();
    }
    if (reading.mode === 'page' && chap.url && Math.abs(prog - libProgSent) >= 0.05) {
      libProgSent = prog;
      api.libProgress(chap.url, chap.title, prog, false);
    }
  }, 150);

  /* ---------------- the producer: keeps the voice ~25 s ahead ---------------- */
  async function produce(my, ch, n) {
    let fails = 0;
    const q = [];                                   // requests in flight, in order
    const send = (c, i) => {
      const chap = reading.chapters[c];
      const k = chap.chunks[i];
      const p = api.synth(k.text, set.voice, set.speed, my).then(
        (r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
      q.push({ p, c, i, k });
    };
    let sc = ch, si = n;                             // next chunk to send
    for (;;) {
      if (my !== session) return;
      // keep the pipe full while we are not too far ahead
      while (q.length < INFLIGHT && my === session && ahead() < AHEAD_S) {
        const chap = reading.chapters[sc];
        if (!chap) break;
        if (si >= chap.chunks.length) {
          // chapter text all sent: move on once the next chapter is known
          if (reading.chapters[sc + 1]) { sc++; si = 0; continue; }
          break;
        }
        send(sc, si++);
      }
      if (!q.length && ahead() >= AHEAD_S && hasMore(sc, si)) { await sleep(250); continue; }   // far enough ahead: rest
      if (!q.length) {
        // nothing more to say from what we have: fetch the next chapter, or finish
        const chap = reading.chapters[sc];
        if (reading.mode !== 'page' || !set.auto || !chap) return finish(my, null);
        while (my === session && ahead() > LEAD_S) await sleep(250);    // not yet: no need to change the page early
        if (my !== session) return;
        const got = await fetchNext(my, sc);
        if (my !== session) return;
        if (!got.ok) return finish(my, got.reason);
        continue;
      }
      // wait for the oldest request, then play it
      const job = q[0];
      const res = await job.p;
      if (my !== session) return;
      q.shift();
      if (!res.ok) {
        if (/cancelled/.test(String(res.e && res.e.message))) continue;
        if (++fails >= 3) return finish(my, 'voice');
        continue;
      }
      fails = 0;
      const sec = res.r.audio.length / res.r.sr;
      if (sec > 0.6 && job.k.text.length > 20) {   // learn speaking rate for the time display
        cps = cps * 0.9 + (job.k.text.length / (sec * set.speed)) * 0.1;
      }
      schedule(res.r.audio, res.r.sr, { ch: job.c, n: job.i, para: job.k.para });
      if (running && !paused && /^(Loading voice|Waking|Carrying|Reading from|Getting)/.test(ui.status)) liveStatus();
    }
  }

  const hasMore = (sc, si) => {
    const chap = reading && reading.chapters[sc];
    return !!chap && (si < chap.chunks.length || !!reading.chapters[sc + 1]);
  };

  // Next chapter: click Next on the page (learned per site), then add it to the reading.
  async function fetchNext(my, sc) {
    const chap = reading.chapters[sc];
    ui.nextNote = 'Fetching the next chapter';
    liveStatus();
    const nx = await api.next(chap.sig, chap.url);
    if (my !== session) return { ok: false, reason: 'cancelled' };
    ui.nextNote = '';
    if (!nx.ok) { liveStatus(); return { ok: false, reason: nx.reason }; }
    api.savePos(chap.url, 0);
    api.libProgress(chap.url, chap.title, 1, false);
    const next = makeChapter(nx.ex);
    reading.chapters[sc + 1] = next;
    reading.pageCh = sc + 1;
    for (let i = 0; i < sc - 1; i++) reading.chapters[i] = null;   // keep memory flat on long nights
    ui.nextNote = 'Next up: ' + next.title;
    liveStatus();
    setTimeout(() => { if (ui.nextNote === 'Next up: ' + next.title) { ui.nextNote = ''; liveStatus(); } }, 6000);
    return { ok: true };
  }

  // Wait for the last sound to end, then report how the reading ended.
  async function finish(my, reason) {
    while (my === session && (ahead() > 0.05 || sources.size)) await sleep(150);
    if (my !== session) return;
    const chap = reading && heard ? reading.chapters[heard.ch] : null;
    let end = null;
    if (reason === 'voice') end = ['Stopped: the voice is not responding. Press Retry', 'err'];
    else if (reason === 'no-button' || reason === 'not-a-chapter') {
      end = ['Finished. You’re caught up, no newer chapter yet'];
      if (chap) api.libProgress(chap.url, chap.title, 1, true);
    } else if (reason === 'timeout') end = ['Finished. The next chapter didn’t load. Check the connection'];
    if (chap && reading.mode === 'page') api.savePos(chap.url, 0);
    running = false;
    paused = false;
    heard = null;
    ui.prog = null; ui.pos = 0; ui.dur = 0;
    api.highlight(-1);
    reading = null;
    publish();
    if (end) say(end[0], end[1]); else idleStatus();
  }

  /* ---------------- starting ---------------- */
  // Begin (or restart) playback of the current reading at chapter ch, chunk n.
  async function playFrom(ch, n, note) {
    halt();
    const my = session;
    running = true;
    if (engine.state === 'error') { running = false; say('Voice engine failed. Press Retry', 'err'); return; }
    try { await audio().resume(); } catch (_) {}
    const chap = reading.chapters[ch];
    ui.title = chap.title; lastTitle = chap.title;
    ui.prog = Math.min(1, (chap.chunks[n] ? chap.chunks[n].at : chap.chars) / chap.chars);
    ui.dur = chap.chars / (cps * set.speed); ui.pos = ui.prog * ui.dur;
    if (!voiceUsable()) idleStatus(); else say(note || 'Reading', 'live');
    produce(my, ch, n).catch((e) => { if (my === session) { running = false; say('Stopped: ' + e.message, 'err'); } });
  }

  // mode 'page': opts.pt (read from a point), opts.fromTop (ignore saved place), opts.ex (already loaded chapter)
  async function start(mode, opts = {}) {
    halt();
    clearTimeout(jumpTimer); jumpT = null;
    const my = session;
    if (engine.state === 'error') { say('Voice engine failed. Press Retry', 'err'); return; }
    running = true;
    publish();
    if (mode === 'selection') {
      const text = ((opts.text != null ? opts.text : await api.selection()) || '').trim();
      if (my !== session) return;
      if (!text) { running = false; say('Select some text first'); return; }
      const chunks = [];
      addText(chunks, text, -1);
      let c = 0; for (const k of chunks) { k.at = c; c += k.text.length; }
      reading = { mode: 'selection', pageCh: -1, chapters: [{ ex: null, chunks, chars: Math.max(1, c), title: opts.label || 'Selected text', url: '', sig: '' }] };
      return playFrom(0, 0, opts.label ? 'Voice sample' : 'Reading selection');
    }
    say('Finding the text…', 'live');
    const ex = opts.ex || await api.extract(opts.pt);
    if (my !== session) return;
    if (!ex || !ex.paras || !ex.paras.length) { running = false; reading = null; say('Couldn’t find readable text on this page', 'err'); return; }
    const chap = makeChapter(ex);
    reading = { mode: 'page', pageCh: 0, chapters: [chap] };
    let from = 0, note = 'Reading';
    if (opts.pt && (ex.startIndex > 0 || opts.snip)) {
      from = chunkOfPara(chap, ex.startIndex);
      note = 'Reading from here';
      // start at the exact sentence you selected, not just its paragraph
      const want = clean(opts.snip || '').toLowerCase().slice(0, 30);
      if (want.length >= 4) {
        for (let i = from; i < chap.chunks.length && chap.chunks[i].para === chap.chunks[from].para; i++) {
          if (chap.chunks[i].text.toLowerCase().includes(want)) { from = i; break; }
        }
      }
    }
    else if (!opts.fromTop && ex.resumeAt > 0 && ex.resumeAt < ex.paras.length - 1) {
      from = chunkOfPara(chap, ex.resumeAt); note = 'Carrying on from where you stopped';
    }
    return playFrom(0, from, note);
  }

  async function read() {
    const s = ((await api.selection()) || '').trim();
    if (s.length > 1) start('selection', { text: s }); else start('page');
  }
  async function togglePause() {
    if (!running || !ctx) return;
    if (paused) { await ctx.resume(); paused = false; }
    else { await ctx.suspend(); paused = true; }
    liveStatus();
  }

  // Jump to the next chapter now and read it.
  async function skipNext() {
    if (reading && reading.mode === 'page' && heard && reading.chapters[heard.ch + 1]) {
      return playFrom(heard.ch + 1, 0);
    }
    const base = reading && reading.mode === 'page' ? reading.chapters[heard ? heard.ch : reading.pageCh] : null;
    halt();
    const my = session;
    running = true;
    say('Opening next chapter…', 'live');
    let sig = base ? base.sig : '', from = base ? base.url : '';
    if (!base) {
      try { const cur = await api.extract(null); if (cur && cur.sig) { sig = cur.sig; from = cur.url; } } catch (_) {}
    }
    const nx = await api.next(sig, from);
    if (my !== session) return;
    if (!nx.ok) {
      running = false;
      reading = null;
      publish();
      say(nx.reason === 'timeout' ? 'The next chapter didn’t load. Check the connection' : 'No next chapter found on this page');
      return;
    }
    reading = { mode: 'page', pageCh: 0, chapters: [makeChapter(nx.ex)] };
    playFrom(0, 0);
  }

  /* ---------------- skipping and seeking ---------------- */
  // Rapid presses add up and restart once, ~0.25 s after the last press.
  let jumpT = null, jumpTimer = null;
  function jumpPara(delta) {
    if (!running || !reading || reading.mode !== 'page') return;
    const base = jumpT || (heard ? { ch: heard.ch, para: Math.max(heard.para, 0), into: ctx ? ctx.currentTime - heard.t : 0 }
      : { ch: reading.pageCh, para: 0, into: 0 });
    let { ch, para } = base;
    if (delta < 0) {
      // first press replays the paragraph you are in, unless it only just began
      if (!jumpT && base.into > 2.5) { /* same paragraph */ } else para -= 1;
      if (para < 0) {
        if (reading.chapters[ch - 1] && reading.chapters[ch - 1].ex) { ch -= 1; para = reading.chapters[ch].ex.paras.length - 1; } else para = 0;
      }
    } else {
      para += 1;
      if (para >= reading.chapters[ch].ex.paras.length) {
        if (reading.chapters[ch + 1]) { ch += 1; para = 0; } else { jumpT = null; clearTimeout(jumpTimer); skipNext(); return; }
      }
    }
    jumpT = { ch, para, into: 0 };
    // instant feedback while you keep pressing
    const chap = reading.chapters[ch];
    ui.title = chap.title;
    ui.prog = Math.min(1, (chap.chunks[chunkOfPara(chap, para)] || { at: chap.chars }).at / chap.chars);
    ui.pos = ui.prog * ui.dur;
    if (reading.mode === 'page') api.highlight(para, chap.url);
    publish();
    clearTimeout(jumpTimer);
    jumpTimer = setTimeout(() => {
      const t = jumpT; jumpT = null;
      if (!t || !reading) return;
      playFrom(t.ch, chunkOfPara(reading.chapters[t.ch], t.para));
    }, 250);
  }
  // Seek bar: f = 0..1 through the chapter you are hearing.
  function seek(f) {
    if (!running || !reading || reading.mode !== 'page') return;
    const ch = jumpT ? jumpT.ch : heard ? heard.ch : reading.pageCh;
    const chap = reading.chapters[ch];
    if (!chap) return;
    const target = Math.max(0, Math.min(1, +f || 0)) * chap.chars;
    let n = chap.chunks.findIndex((k) => k.at + k.text.length > target);
    if (n < 0) n = chap.chunks.length - 1;
    clearTimeout(jumpTimer); jumpT = null;
    playFrom(ch, Math.max(0, n));
  }

  // A new voice or speed takes effect at once: replay from the sentence you are hearing.
  let redoTimer = null;
  function redoFromHere() {
    if (!running || !reading || !heard || paused) return;
    clearTimeout(redoTimer);
    redoTimer = setTimeout(() => { if (running && heard && reading) playFrom(heard.ch, heard.n); }, 450);
  }

  const SAMPLES = {
    af_heart: 'Hi, I’m Heart. I’ll read your chapters in a warm, friendly voice.',
    am_michael: 'Hello, I’m Michael. A steady voice for long reading sessions.',
    bf_emma: 'Hello, I’m Emma. I read with a British accent.',
  };

  // Commands coming from the floating dock and rail
  function remote(act, val) {
    switch (act) {
      case 'orb':            // main round button: start, or pause/resume while reading
        if (engine.state === 'error') { api.retryEngine(); break; }
        if (running) togglePause(); else read();
        break;
      case 'read': read(); break;
      case 'read-page': start('page', { fromTop: true }); break;
      case 'next-chapter': skipNext(); break;
      case 'para-back': jumpPara(-1); break;
      case 'para-next': jumpPara(1); break;
      case 'seek': seek(val); break;
      case 'toggle': togglePause(); break;
      case 'stop': stopAll(); break;
      case 'retry': api.retryEngine(); break;
      case 'bookmark': api.libToggle(heard && reading && reading.chapters[heard.ch] ? reading.chapters[heard.ch].title : ''); break;
      case 'voice':
        if (VOICES.includes(val)) { const was = set.voice; set.voice = val; save(); publish(); if (was !== val && reading && reading.mode === 'page') redoFromHere(); }
        break;
      case 'try-voice':
        if (VOICES.includes(val)) {
          set.voice = val; save(); publish();
          if (voiceUsable()) start('selection', { text: SAMPLES[val], label: 'Voice sample' });
        }
        break;
      case 'speed': {
        const v = Math.round(Math.min(1.5, Math.max(0.8, +val || 1)) * 100) / 100;
        const was = set.speed; set.speed = v; save(); publish();
        if (Math.abs(was - v) > 0.001) redoFromHere();
        break;
      }
      case 'auto': set.auto = typeof val === 'boolean' ? val : !set.auto; save(); publish(); break;
      case 'focus-url': el.url.focus(); el.url.select(); break;
      case 'back': if (!el.back.disabled) el.back.onclick(); break;
      case 'forward': if (!el.fwd.disabled) el.fwd.onclick(); break;
      default: break;
    }
  }

  /* ---------------- address capsule ---------------- */
  let curUrl = '';
  function renderAddr() {
    const focused = document.activeElement === el.url;
    let pretty = false;
    el.icoLock.style.display = 'none';
    el.icoSearch.style.display = '';
    if (curUrl) {
      try {
        const u = new URL(curUrl);
        if (/^https?:$/.test(u.protocol)) {
          el.vhost.textContent = u.hostname.replace(/^www\./, '');
          const rest = (u.pathname === '/' ? '' : u.pathname) + u.search;
          el.vpath.textContent = rest ? decodeURI(rest) : '';
          pretty = !focused;
          if (u.protocol === 'https:') { el.icoLock.style.display = ''; el.icoSearch.style.display = 'none'; }
        }
      } catch (_) { /* keep the raw text */ }
    }
    el.addr.classList.toggle('pretty', pretty);
  }

  /* ---------------- wiring ---------------- */
  el.back.onclick = () => { stopAll(); api.back(); };
  el.fwd.onclick = () => { stopAll(); api.forward(); };
  el.reload.onclick = () => { stopAll(); api.reload(); };
  el.home.onclick = () => { stopAll(); api.home(); };
  el.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && el.url.value.trim()) { stopAll(); api.go(el.url.value); el.url.blur(); }
    if (e.key === 'Escape') { el.url.value = curUrl; el.url.blur(); }
  });
  el.url.addEventListener('focus', () => { renderAddr(); el.url.select(); });
  el.url.addEventListener('blur', renderAddr);
  el.addr.addEventListener('mousedown', (e) => {
    if (e.target !== el.url) { e.preventDefault(); el.url.focus(); }
  });

  function applyTheme(t) { document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark'; }
  api.theme().then(applyTheme);
  api.on('theme', applyTheme);

  api.on('nav', (s) => {
    curUrl = s.url || '';
    nav.url = s.url || '';
    nav.title = s.title || '';
    nav.saved = !!s.saved;
    nav.canSave = !!s.canSave;
    if (document.activeElement !== el.url) el.url.value = curUrl;
    el.back.disabled = !s.back;
    el.fwd.disabled = !s.fwd;
    el.load.classList.toggle('on', !!s.loading);
    renderAddr();
    publish();
  });
  api.on('next:info', (d) => {
    const label = (d && d.label) || '';
    if (running && /^Fetching/.test(ui.nextNote)) { ui.nextNote = 'Fetching the next chapter' + (label ? ' (' + label + ')' : ''); liveStatus(); }
    else if (running && /^Opening next chapter/.test(ui.status)) say('Opening next chapter…' + (label ? ' ' + label : ''), 'live');
  });
  api.on('tts:state', (s) => {
    engine = s;
    if (!running) idleStatus();
    else { if (voiceUsable() && /^(Loading voice|Waking|Getting|Trying)/.test(ui.status)) liveStatus(); publish(); }
  });
  api.on('cmd', (c) => {
    if (c.type === 'read') read();
    else if (c.type === 'toggle') togglePause();
    else if (c.type === 'stop') stopAll();
    else if (c.type === 'focus-url') { el.url.focus(); el.url.select(); }
    else if (c.type === 'read-selection') start('selection');
    else if (c.type === 'read-from') start('page', { pt: c.pt, snip: c.snip });
    else if (c.type === 'remote') remote(c.act, c.val);
  });

  api.engine().then((s) => {
    engine = s;
    if (!running) idleStatus();
  });
  renderAddr();
  publish();
  idleStatus();
})();
