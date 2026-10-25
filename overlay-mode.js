(() => {
  const b = document.getElementById('t');
  b.onclick = () => ov.act('theme');
  ov.on('theme', (t) => {
    document.documentElement.dataset.theme = t;
    const label = t === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    b.title = label;
    b.setAttribute('aria-label', label);
  });
})();
