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
//   /novel/lantern/chapter-11        -> novel/lantern
//   /lantern-road-chapter-11.html    -> lantern-road
//   /book/123/456.html               -> book/123
function seriesOf(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return null;
    const host = x.host.replace(/^www\./, '');
    const segs = x.pathname.split('/').filter(Boolean);
    const last = (() => { try { return decodeURIComponent(segs[segs.length - 1] || ''); } catch (_) { return segs[segs.length - 1] || ''; } })();
    const m = /^(.*?)[-_. ]*(?:chapter|chap|ch|episode|ep|part)[-_. ]*\d+.*$/i.exec(last);
    if (m && m[1].replace(/[-_. ]/g, '').length >= 2 && !/^\d+$/.test(m[1])) segs[segs.length - 1] = m[1];
    else if (segs.length > 1 && (/\d/.test(last) || m)) segs.pop();
    const pre = '/' + segs.join('/');
    return { key: host + pre, host, slug: segs[segs.length - 1] || host };
  } catch (_) { return null; }
}
// "Lantern Road - Chapter 11 | Site" -> "Lantern Road"
function nameFromTitle(t) {
  const m = /^(.{2,90}?)\s*[-–—|:·,]?\s*(?:chapter|ch\.?|episode|ep\.?)\s*\d+/i.exec(String(t || '').trim());
  if (!m) return '';
  const n = m[1].replace(/[\s\-–—|:·,]+$/, '').trim();
  return n.length >= 2 && !/^(chapter|ch)$/i.test(n) ? n.slice(0, 80) : '';
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
    this.d = { v: 1, list: [], sites: [], prefs: { theme: 'dark' }, pl: { items: [], at: -1 } };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.v === 1) this.d = { ...this.d, ...raw, prefs: { ...this.d.prefs, ...(raw.prefs || {}) } };
      if (!this.d.pl || !Array.isArray(this.d.pl.items)) this.d.pl = { items: [], at: -1 };
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
  toggle(u, chapterTitle, pageTitle) {
    const s = seriesOf(u);
    if (!s) return false;
    const i = this.d.list.findIndex((x) => x.key === s.key);
    if (i >= 0) { this.d.list.splice(i, 1); this.save(); return false; }
    this.d.list.unshift(this.entry(s, u, chapterTitle, pageTitle, 'unread'));
    this.save();
    return true;
  }
  entry(s, u, chapterTitle, pageTitle, status) {
    const named = nameFromTitle(pageTitle) || nameFromTitle(chapterTitle);
    return {
      id: Math.random().toString(36).slice(2, 10), key: s.key, host: s.host,
      title: named || humanize(s.slug) || s.host, named: !!named,
      chapter: (chapterTitle || '').slice(0, 120), num: chapterNum(u, chapterTitle), url: u, status, prog: 0, heard: 0, added: now(), updated: now(),
    };
  }
  // A chapter started playing: every novel you listen to is kept here by itself,
  // one card per novel, pointing at the last chapter you were on.
  track(u, chapterTitle, pageTitle) {
    const s = seriesOf(u);
    if (!s) return false;
    let e = this.d.list.find((x) => x.key === s.key);
    if (!e) { e = this.entry(s, u, chapterTitle, pageTitle, 'progress'); this.d.list.unshift(e); }
    if (!e.named) { const n = nameFromTitle(pageTitle) || nameFromTitle(chapterTitle); if (n) { e.title = n; e.named = true; } }
    if (e.url !== u) e.prog = 0;
    e.url = u;
    if (chapterTitle) e.chapter = chapterTitle.slice(0, 120);
    e.num = chapterNum(u, chapterTitle) ?? e.num;
    e.status = 'progress';
    e.updated = now();
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
    if (e.prog >= 1 && e.doneUrl !== u) { e.heard = (e.heard || 0) + 1; e.doneUrl = u; }
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

  /* playlist: chapters that play one after another */
  plAdd(url, title) {
    if (!/^https?:\/\//i.test(url || '')) return 0;
    const items = this.d.pl.items;
    items.push({ id: Math.random().toString(36).slice(2, 10), url, title: String(title || '').slice(0, 140), done: false });
    if (items.length > 200) { items.shift(); this.d.pl.at = Math.max(-1, this.d.pl.at - 1); }
    this.save();
    return items.length;
  }
  plRemove(id) {
    const pl = this.d.pl, i = pl.items.findIndex((x) => x.id === id);
    if (i < 0) return -1;
    pl.items.splice(i, 1);
    if (i < pl.at) pl.at--;
    this.save();
    return i;
  }
  plUp(id) {
    const pl = this.d.pl, i = pl.items.findIndex((x) => x.id === id);
    if (i <= 0) return;
    const [it] = pl.items.splice(i, 1);
    pl.items.splice(i - 1, 0, it);
    if (pl.at === i) pl.at--; else if (pl.at === i - 1) pl.at++;
    this.save();
  }
  plClear(onlyDone) {
    const pl = this.d.pl;
    pl.items = onlyDone ? pl.items.filter((x) => !x.done) : [];
    pl.at = -1;
    this.save();
  }
}

Library.seriesOf = seriesOf;
Library.nameFromTitle = nameFromTitle;
module.exports = Library;
