// The reading brain: a tiny, fully local learner.
//
// What it learns (only from verified outcomes, never from raw page text):
//   - a general "is this the Next-chapter button?" scorer (a logistic model of ~20 weights),
//   - per site: where the chapter text lives, which button is Next, whether chapter links
//     just count up (…/chapter-41 -> …/chapter-42), and boilerplate lines to skip,
//   - where you stopped in each chapter, so you can carry on later.
//
// It never runs in the background: every function here is called only at the moment
// a chapter starts or ends. Learned data is pruned and hard-capped so it never grows.
const fs = require('fs');
const path = require('path');

// Feature order must match NEXT_FEATURES in page-scripts.js
const FEATURES = [
  'rel', 'cls', 'txtChap', 'txtExact', 'txtStarts', 'arrow', 'aria', 'hrefInc', 'hrefSeries',
  'hrefChap', 'inNav', 'below', 'isButton', 'tocWord', 'external', 'shortTxt', 'jsHref', 'learned',
];
const W0 = [5, 3, 3, 2.5, 1.5, 1, 1.5, 3, 0.5, 0.8, 0.5, 0.6, 0, -3, -3, 0.3, -0.3, 2.5];
const B0 = -3;

const LIMITS = {
  sites: 150,          // sites remembered
  lines: 40,           // repeated-line counters per site
  junk: 25,            // learned skip lines per site
  pos: 300,            // resume positions
  siteDays: 120,       // forget sites not visited for this long
  posDays: 60,
  bytes: 400 * 1024,   // hard cap for the whole brain file
};
const LR = 0.12, L2 = 0.002, WMAX = 8;
const DAY = 86400000;

const sig = (z) => 1 / (1 + Math.exp(-z));
const now = () => Date.now();
const norm = (t) => String(t || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);

class Brain {
  constructor(dir) {
    this.file = path.join(dir, 'reading-brain.json');
    this.timer = null;
    this.d = this.fresh();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.v === 1 && Array.isArray(raw.w) && raw.w.length === FEATURES.length) this.d = { ...this.fresh(), ...raw };
    } catch (_) { /* first run or unreadable: start fresh */ }
    this.prune();
  }
  fresh() { return { v: 1, w: W0.slice(), b: B0, n: 0, sites: {}, pos: {} }; }

  /* ---------------- storage ---------------- */
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 2000);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    this.prune();
    let json = JSON.stringify(this.d);
    if (json.length > LIMITS.bytes) { this.shrink(); json = JSON.stringify(this.d); }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', json);
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (_) {}
  }
  prune() {
    const t = now();
    const sites = Object.entries(this.d.sites)
      .filter(([, s]) => t - (s.used || 0) < LIMITS.siteDays * DAY)
      .sort((a, b) => (b[1].used || 0) - (a[1].used || 0))
      .slice(0, LIMITS.sites);
    this.d.sites = Object.fromEntries(sites);
    const pos = Object.entries(this.d.pos)
      .filter(([, p]) => t - (p.t || 0) < LIMITS.posDays * DAY)
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, LIMITS.pos);
    this.d.pos = Object.fromEntries(pos);
  }
  shrink() {
    // Over the size cap: keep the most useful half of everything.
    const half = (o, key) => Object.fromEntries(Object.entries(o).sort((a, b) => (b[1][key] || 0) - (a[1][key] || 0)).slice(0, Math.ceil(Object.keys(o).length / 2)));
    this.d.pos = half(this.d.pos, 't');
    this.d.sites = half(this.d.sites, 'used');
    for (const s of Object.values(this.d.sites)) s.lines = {};
  }
  sizeBytes() { return JSON.stringify(this.d).length; }

  site(host, create) {
    let s = this.d.sites[host];
    if (!s && create) s = this.d.sites[host] = { used: now() };
    if (s) s.used = now();
    return s;
  }

  /* ---------------- reading the chapter text ---------------- */
  hintsFor(host) {
    const s = this.d.sites[host];
    return {
      csel: s && s.content ? s.content.sel : null,
      junk: s && s.junk ? s.junk.slice() : [],
      next: s && s.next ? s.next : null,
    };
  }

  // Called after a chapter's text was found.
  learnPage(host, ex) {
    if (!host || !ex || !ex.paras || !ex.paras.length) return;
    const chars = ex.paras.reduce((n, p) => n + p.length, 0);
    if (chars < 300) return; // index pages teach nothing
    const s = this.site(host, true);

    // Container that held the text
    if (ex.csel && ex.csel !== 'body') {
      if (s.content && s.content.sel === ex.csel) s.content.n = Math.min(50, s.content.n + 1);
      else if (s.content && ex.usedLearned === false) { s.content.n -= 2; if (s.content.n <= 0) s.content = { sel: ex.csel, n: 1 }; }
      else if (!s.content) s.content = { sel: ex.csel, n: 1 };
    }

    // Lines that repeat at the start/end of every chapter (translator notes, site ads)
    if (ex.sig && s.lastSig !== ex.sig && Array.isArray(ex.edges)) {
      s.lastSig = ex.sig;
      s.lines = s.lines || {};
      s.junk = s.junk || [];
      for (const raw of ex.edges) {
        const k = norm(raw);
        if (k.length < 4 || k.split(' ').length > 14 || s.junk.includes(k)) continue;
        const e = s.lines[k] || (s.lines[k] = { c: 0, t: 0 });
        e.c++; e.t = now();
        if (e.c >= 3) { // seen in 3 different chapters: it's boilerplate, not story
          s.junk.push(k);
          delete s.lines[k];
          if (s.junk.length > LIMITS.junk) s.junk.shift();
        }
      }
      // keep only the most promising counters
      const keep = Object.entries(s.lines).sort((a, b) => (b[1].c - a[1].c) || (b[1].t - a[1].t)).slice(0, LIMITS.lines);
      s.lines = Object.fromEntries(keep);
    }
    this.save();
  }

  /* ---------------- choosing the Next button ---------------- */
  score(f) {
    let z = this.d.b;
    for (let i = 0; i < FEATURES.length; i++) z += this.d.w[i] * (f[i] || 0);
    return z;
  }
  rank(cands, host) {
    const s = this.d.sites[host];
    return cands.map((c) => {
      let z = this.score(c.f);
      // A button that worked on this site before gets a strong, earned boost
      if (s && s.next && c.f[17]) z += Math.max(-4, Math.min(4, 1.5 * ((s.next.ok || 0) - (s.next.bad || 0))));
      return { ...c, z, p: sig(z) };
    }).sort((a, b) => b.z - a.z);
  }
  update(f, y) {
    const p = sig(this.score(f));
    const g = y - p;
    for (let i = 0; i < FEATURES.length; i++) {
      this.d.w[i] += LR * (g * (f[i] || 0) - L2 * (this.d.w[i] - W0[i]));
      this.d.w[i] = Math.max(-WMAX, Math.min(WMAX, this.d.w[i]));
    }
    this.d.b = Math.max(-WMAX, Math.min(WMAX, this.d.b + LR * g * 0.5));
    this.d.n++;
  }
  // Called once a jump was verified: ok = a new chapter really loaded.
  learnNext(host, chosen, others, ok) {
    if (!chosen) return;
    this.update(chosen.f, ok ? 1 : 0);
    if (ok) {
      for (const o of others || []) if (o.href !== chosen.href && o.p > 0.3) this.update(o.f, 0);
      const s = this.site(host, true);
      if (s.next && s.next.sel === chosen.sel && s.next.text === chosen.text) s.next.ok = Math.min(20, (s.next.ok || 0) + 1);
      else s.next = { sel: chosen.sel, text: chosen.text, ok: 1, bad: 0 };
    } else {
      const s = this.site(host, false);
      if (s && s.next && s.next.sel === chosen.sel && s.next.text === chosen.text) {
        s.next.bad = (s.next.bad || 0) + 1;
        if (s.next.bad > (s.next.ok || 0) + 2) delete s.next; // stopped working: forget it
      }
    }
    this.save();
  }

  /* ---------------- chapter links that count up ---------------- */
  static bumpUrl(u) {
    try {
      const url = new URL(u);
      const tryPart = (str, set) => {
        const re = /(\d+)(?!.*\d)/; // last number
        const m = re.exec(str);
        if (!m) return null;
        const n = String(Number(m[1]) + 1).padStart(m[1].length, '0');
        return set(str.slice(0, m.index) + n + str.slice(m.index + m[1].length));
      };
      const viaPath = tryPart(url.pathname, (p) => { const c = new URL(url.href); c.pathname = p; c.hash = ''; return c.href; });
      if (viaPath) return viaPath;
      return tryPart(url.search, (q) => { const c = new URL(url.href); c.search = q; c.hash = ''; return c.href; });
    } catch (_) { return null; }
  }
  urlGuessAllowed(host) {
    const s = this.d.sites[host];
    return !(s && s.url && (s.url.bad || 0) > (s.url.ok || 0) + 2);
  }
  learnUrl(host, ok) {
    const s = this.site(host, true);
    s.url = s.url || { ok: 0, bad: 0 };
    if (ok) s.url.ok = Math.min(20, s.url.ok + 1); else s.url.bad = Math.min(20, s.url.bad + 1);
    this.save();
  }

  /* ---------------- where you stopped ---------------- */
  static key(u) { try { const x = new URL(u); x.hash = ''; return x.href; } catch (_) { return u; } }
  getPos(u) { const p = this.d.pos[Brain.key(u)]; return p ? p.i : 0; }
  setPos(u, i) {
    const k = Brain.key(u);
    if (!i || i < 1) delete this.d.pos[k]; else this.d.pos[k] = { i, t: now() };
    this.save();
  }

  stats() {
    return { bytes: this.sizeBytes(), sites: Object.keys(this.d.sites).length, lessons: this.d.n };
  }
  forget() { this.d = this.fresh(); this.flush(); }
}

Brain.FEATURES = FEATURES;
module.exports = Brain;
