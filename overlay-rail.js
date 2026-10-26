(() => {
  const $ = (id) => document.getElementById(id);
  const rail = $('rail'), panel = $('panel');
  const bVoice = $('b-voice'), bSpeed = $('b-speed'), bAuto = $('b-auto'), bPage = $('b-page'), bSave = $('b-save'), bKeys = $('b-keys'), bQueue = $('b-queue');
  const speed = $('speed'), readout = $('readout'), chips = $('chips'), voices = $('voices'), where = $('where');

  const VOICES = [
    { id: 'af_heart', name: 'Heart', desc: 'Warm female' },
    { id: 'am_michael', name: 'Michael', desc: 'Steady male' },
    { id: 'bf_emma', name: 'Emma', desc: 'British female' },
  ];
  const PRESETS = [0.9, 1, 1.15, 1.3, 1.5];
  const PANEL_W = 290;
  let pane = '';
  let st = { voice: 'af_heart', speed: 1, auto: true, engine: {} };

  const fmt = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(/0$/, '').replace(/\.0$/, '') + '×';
  const fillOf = (v) => (((v - 0.8) / 0.7) * 100).toFixed(1) + '%';

  /* build lists */
  for (const v of VOICES) {
    const row = document.createElement('div');
    row.className = 'voice';
    row.setAttribute('role', 'radio');
    row.tabIndex = 0;
    row.dataset.id = v.id;
    row.innerHTML = '<span class="txt"><span class="nm"></span><span class="ds"></span></span><button class="try" type="button">Try</button>';
    row.querySelector('.nm').textContent = v.name;
    row.querySelector('.ds').textContent = v.desc;
    const tryBtn = row.querySelector('.try');
    tryBtn.title = `Hear ${v.name}`;
    tryBtn.onclick = (e) => { e.stopPropagation(); ov.act('try-voice', v.id); };
    row.onclick = () => ov.act('voice', v.id);
    row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ov.act('voice', v.id); } };
    voices.appendChild(row);
  }
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = fmt(p);
    b.dataset.v = p;
    b.onclick = () => ov.act('speed', p);
    chips.appendChild(b);
  }

  /* sizing: closed = just the rail, open = drawer + rail in one card */
  const shell = document.querySelector('.shell');
  function size() {
    // measure natural heights (the card normally stretches both columns to the same height)
    shell.style.alignItems = 'flex-start';
    const railH = rail.offsetHeight;
    const ph = pane ? panel.offsetHeight : 0;
    shell.style.alignItems = '';
    if (!pane) { ov.size(60, railH, 30); return; }
    ov.size(60 + PANEL_W, Math.max(railH, ph), 26);
  }
  function open(p) {
    pane = pane === p ? '' : p;
    document.body.dataset.pane = pane;
    document.body.classList.toggle('open', !!pane);
    for (const b of [bVoice, bSpeed, bKeys]) b.setAttribute('aria-expanded', String(b.dataset.pane === pane));
    requestAnimationFrame(size);
  }

  function render(s) {
    st = s;
    for (const row of voices.children) row.setAttribute('aria-checked', String(row.dataset.id === s.voice));
    const tryable = s.engine && (s.engine.state === 'ready' || s.engine.state === 'sleeping');
    for (const t of voices.querySelectorAll('.try')) t.style.visibility = tryable ? 'visible' : 'hidden';
    bSpeed.textContent = fmt(s.speed);
    readout.textContent = fmt(s.speed);
    if (document.activeElement !== speed) speed.value = s.speed;
    speed.style.setProperty('--fill', fillOf(+speed.value));
    for (const c of chips.children) c.setAttribute('aria-pressed', String(Math.abs(+c.dataset.v - s.speed) < 0.001));
    bAuto.setAttribute('aria-pressed', String(!!s.auto));
    bAuto.title = 'Auto next chapter: ' + (s.auto ? 'on' : 'off');
    bSave.setAttribute('aria-pressed', String(!!s.saved));
    bSave.disabled = !s.canSave && !s.saved;
    bQueue.disabled = !s.canQueue;
    bSave.title = s.saved ? 'Saved to your reading list. Click to remove' : 'Save this novel to your reading list';
    const info = s.engine && s.engine.info;
    where.textContent = info
      ? (info.device === 'gpu' ? 'Runs on your graphics card.' : `Runs on your processor (${info.threads} thread${info.threads === 1 ? '' : 's'}).`) + ' Nothing is sent online.'
      : 'Runs on your computer. Nothing is sent online.';
    const v = VOICES.find((x) => x.id === s.voice);
    bVoice.title = 'Voice: ' + (v ? v.name : s.voice);
  }

  bVoice.onclick = () => open('voice');
  bSpeed.onclick = () => open('speed');
  bKeys.onclick = () => open('keys');
  bAuto.onclick = () => ov.act('auto', !st.auto);
  bPage.onclick = () => ov.act('read-page');
  bSave.onclick = () => ov.act('bookmark');
  bQueue.onclick = () => { ov.act('pl-add-page'); bQueue.classList.add('ok'); setTimeout(() => bQueue.classList.remove('ok'), 700); };
  speed.oninput = () => {
    readout.textContent = fmt(+speed.value);
    speed.style.setProperty('--fill', fillOf(+speed.value));
    ov.act('speed', +speed.value);
  };

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pane) { open(pane); ov.act('focus-page'); } });
  // Clicking back on the page closes the drawer.
  window.addEventListener('blur', () => { if (pane) open(pane); });

  ov.on('theme', (t) => { document.documentElement.dataset.theme = t; });
  ov.on('state', render);
  render(st);
  requestAnimationFrame(size);
})();
