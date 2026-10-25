// Reading list, favourite sites and app preferences. Small JSON file, capped.
const fs = require('fs');
const path = require('path');

const MAX_LIST = 200;
const MAX_SITES = 12;

const now = () => Date.now();

function humanize(slug) {
  return decodeURIComponent(slug || '')
    .replace(/[-_+]+/g, ' ')
    .replace(/\.(html?|php|aspx?)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// The "series" a chapter belongs to: same site + the path without the chapter part.
function seriesOf(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return null;
    const segs = x.pathname.split('/').filter(Boolean);
    if (segs.length && /\d/.test(segs[segs.length - 1]) && segs.length > 1) segs.pop();
    else if (!x.search && segs.length > 1 && /chap|ch\d|episode|part/i.test(segs[segs.length - 1])) segs.pop();
    const pre = '/' + segs.join('/');
    return { key: x.host.replace(/^www\./, '') + pre, host: x.host.replace(/^www\./, ''), slug: segs[segs.length - 1] || x.host };
  } catch (_) { return null; }
}
function chapterNum(u, title) {
  const t = /(?:chapter|ch\.?|episode|ep\.?)\s*(\d+)/i.exec(title || '');
  if (t) return Number(t[1]);
  const m = /(\d+)(?!.*\d)/.exec((() => { try { const x = new URL(u); return x.pathname + x.search; } catch (_) { return ''; } })());
  return m ? Number(m[1]) : null;
}

class Library {
  constructor(dir) {
    this.file = path.join(dir, 'library.json');
    this.timer = null;
    this.d = { v: 1, list: [], sites: [], prefs: { theme: 'dark' } };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.v === 1) this.d = { ...this.d, ...raw, prefs: { ...this.d.prefs, ...(raw.prefs || {}) } };
    } catch (_) {}
  }
  save() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 1500); }
  flush() {
    clearTimeout(this.timer);
    this.d.list = this.d.list.sort((a, b) => b.updated - a.updated).slice(0, MAX_LIST);
    this.d.sites = this.d.sites.slice(0, MAX_SITES);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.d));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (_) {}
  }
  snapshot() { return { list: this.d.list, sites: this.d.sites, prefs: this.d.prefs }; }

  /* reading list */
  find(u) { const s = seriesOf(u); return s ? this.d.list.find((x) => x.key === s.key) || null : null; }
  isSaved(u) { return !!this.find(u); }
  toggle(u, chapterTitle) {
    const s = seriesOf(u);
    if (!s) return false;
    const i = this.d.list.findIndex((x) => x.key === s.key);
    if (i >= 0) { this.d.list.splice(i, 1); this.save(); return false; }
    this.d.list.unshift({
      id: Math.random().toString(36).slice(2, 10), key: s.key, host: s.host,
      title: humanize(s.slug) || s.host, chapter: (chapterTitle || '').slice(0, 120),
      num: chapterNum(u, chapterTitle), url: u, status: 'unread', prog: 0, added: now(), updated: now(),
    });
    this.save();
    return true;
  }
  remove(id) { this.d.list = this.d.list.filter((x) => x.id !== id); this.save(); }
  // Reading moved on: keep the saved novel pointing at the chapter you are on.
  progress(u, chapterTitle, prog, finished) {
    const e = this.find(u);
    if (!e) return false;
    e.url = u;
    if (chapterTitle) e.chapter = chapterTitle.slice(0, 120);
    e.num = chapterNum(u, chapterTitle) ?? e.num;
    e.prog = Math.max(0, Math.min(1, prog || 0));
    e.status = finished ? 'finished' : 'progress';
    e.updated = now();
    this.save();
    return true;
  }

  /* favourite sites */
  addSite(url, name) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url); } catch (_) { return false; }
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return false;
    const host = u.hostname.replace(/^www\./, '');
    if (this.d.sites.some((s) => s.host === host)) return true;
    if (this.d.sites.length >= MAX_SITES) return false;
    const label = (name || '').trim().slice(0, 32) || humanize(host.split('.')[0]);
    this.d.sites.push({ host, name: label, url: u.href });
    this.save();
    return true;
  }
  removeSite(host) { this.d.sites = this.d.sites.filter((s) => s.host !== host); this.save(); }

  setPref(k, v) { this.d.prefs[k] = v; this.save(); }
}

Library.seriesOf = seriesOf;
module.exports = Library;
