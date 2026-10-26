// Small functions injected into web pages. They run only when called, then stop.

// Finds the main readable text on the page (works for novel/chapter sites and normal articles).
// hints = { csel, junk } learned for this site.
const EXTRACT_FN = function (pt, hints) {
  hints = hints || {};
  const SPECIFIC = [
    '#chapter-content', '.chapter-content', '#chr-content', '.chr-c', '#chapter-container',
    '.chapter-c', '#chaptercontent', '.reading-content', '#novelcontent', '.novel-content',
    '.text-left', '.entry-content', '.post-content', '.article-content', '#chapter_body', '.chapter-body',
  ];
  const GENERIC = ['article', '#content', 'main', 'body'];
  const BAD = /(^|[\s_-])(ads?|advert|advertisement|sponsor|sponsored|adsbygoogle|comments?|share|social|related|navbar|nav|menu|footer|sidebar|breadcrumb|toolbar|btn|button)([\s_-]|$)/i;
  const SKIPLINE = /^(advertisement|ads?|sponsored|next chapter|previous chapter|prev|next|report|bookmark)$/i;
  const norm = (t) => String(t || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
  const junk = new Set(hints.junk || []);

  const pLen = (e) => {
    let n = 0;
    for (const c of e.children) if (c.tagName === 'P') n += (c.textContent || '').trim().length;
    return n;
  };
  const isBad = (el, stop) => {
    for (let n = 0; el && el !== stop && n < 8; el = el.parentElement, n++) {
      if (/^(NAV|FOOTER|ASIDE|SCRIPT|STYLE|NOSCRIPT|BUTTON|FORM)$/.test(el.tagName)) return true;
      if (BAD.test((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : ''))) return true;
    }
    return false;
  };
  const good = (e) => e && (e.querySelectorAll('p').length >= 3 || (e.innerText || '').length > 800);
  // A short, stable selector for a container, so the site can be recognised next time
  const selOf = (e) => {
    if (!e || e === document.body) return 'body';
    if (e.id && !/\d{3,}/.test(e.id)) return '#' + CSS.escape(e.id);
    const cls = (typeof e.className === 'string' ? e.className : '').split(/\s+/)
      .filter((c) => c && !/\d{3,}|active|show|hidden|open/i.test(c)).slice(0, 2);
    const own = e.tagName.toLowerCase() + cls.map((c) => '.' + CSS.escape(c)).join('');
    if (cls.length) return own;
    const p = e.parentElement;
    if (p && p !== document.body && p.id) return '#' + CSS.escape(p.id) + ' > ' + own;
    return own;
  };

  // 1) pick the container: learned one first
  let c = null, usedLearned = null;
  if (hints.csel) {
    let e = null;
    try { e = document.querySelector(hints.csel); } catch (_) {}
    usedLearned = good(e);
    if (usedLearned) c = e;
  }
  if (!c) {
    for (const s of SPECIFIC) {
      let e = null;
      try { e = document.querySelector(s); } catch (_) {}
      if (good(e)) { c = e; break; }
    }
  }
  if (!c) {
    let best = null, bs = 0;
    document.querySelectorAll('div,article,section,main,td').forEach((e) => {
      if (e.closest('nav,footer,aside,header,#comments,.comments,#disqus_thread')) return;
      const s = pLen(e);
      if (s > bs) { bs = s; best = e; }
    });
    if (best && bs > 300) c = best;
  }
  if (!c) {
    for (const s of GENERIC) { const e = document.querySelector(s); if (e) { c = e; break; } }
  }
  if (!c) return { title: '', paras: [], sig: '', startIndex: 0, url: location.href, host: location.hostname, edges: [] };

  // 2) collect paragraphs, skipping lines this site repeats in every chapter
  const els = [], texts = [];
  const raw = [];
  const ps = Array.from(c.querySelectorAll('p')).filter((p) => !isBad(p, c) && (p.innerText || '').trim());
  if (ps.length >= 3) ps.forEach((p) => raw.push([p, p.innerText.trim()]));
  else (c.innerText || '').split(/\n+/).map((s) => s.trim()).filter(Boolean).forEach((t) => raw.push([null, t]));
  for (const [e, t] of raw) {
    if (SKIPLINE.test(t)) continue;
    if (junk.size && junk.has(norm(t))) continue;
    els.push(e); texts.push(t);
  }

  // 3) title
  let title = '';
  const tEl =
    document.querySelector('.chapter-title, .chr-title, #chapter-heading, .title-chapter, h1.chapter, .entry-title') ||
    c.querySelector('h1,h2,h3') || document.querySelector('h1');
  title = ((tEl && tEl.innerText) || document.title || '').trim().slice(0, 120);

  // 4) "read from here"
  let startIndex = 0;
  if (pt) {
    const t = document.elementFromPoint(pt.x, pt.y);
    if (t) {
      let found = -1;
      for (let i = 0; i < els.length; i++) if (els[i] && els[i].contains(t)) { found = i; break; }
      if (found < 0) {
        for (let i = 0; i < els.length; i++) {
          if (els[i] && (t.compareDocumentPosition(els[i]) & Node.DOCUMENT_POSITION_FOLLOWING)) { found = i; break; }
        }
      }
      if (found > 0) startIndex = found;
    }
  }

  window.__ttsEls = els;
  window.__ttsBox = c;
  // How many links on the page point at chapters. A novel's index page is mostly a chapter list;
  // a chapter page has a few at most (prev / next / a "latest chapters" box).
  let chapLinks = 0;
  const CHAP = /(?:chapter|chap|ch\.?|episode|ep\.?)\s*[-_#.:]?\s*\d+/i;
  const links = document.getElementsByTagName('a');
  for (let i = 0; i < links.length && i < 3000; i++) {
    const a = links[i];
    if (CHAP.test(a.textContent || '') || CHAP.test(a.getAttribute('href') || '')) chapLinks++;
  }
  // fingerprint of this chapter: its address plus a hash of all its text
  // (sites often start and end every chapter with the same lines, so first/last lines are not enough)
  let hsh = 5381;
  const all = texts.join('\n');
  for (let i = 0; i < all.length; i++) hsh = ((hsh * 33) ^ all.charCodeAt(i)) >>> 0;
  const sig = texts.length + '|' + location.pathname + location.search + '|' + all.length + '|' + hsh.toString(36);
  // short lines at the start and end: candidates for "boilerplate" learning (never stored as-is)
  const edges = raw.map((r) => r[1]).filter((t) => t.length < 160);
  const edgeSet = edges.length > 6 ? edges.slice(0, 2).concat(edges.slice(-3)) : [];
  return {
    title, paras: texts, sig, startIndex, url: location.href, host: location.hostname,
    csel: selOf(c), usedLearned, edges: edgeSet, docTitle: document.title.slice(0, 160), chapLinks,
  };
};

// Highlights the paragraph being read (i < 0 clears).
const HL_FN = function (i) {
  if (window.__ttsPrev) {
    window.__ttsPrev.style.backgroundColor = window.__ttsPrevBg || '';
    window.__ttsPrev.style.boxShadow = window.__ttsPrevSh || '';
    window.__ttsPrev.style.borderRadius = '';
    window.__ttsPrev = null;
  }
  const e = (window.__ttsEls || [])[i];
  if (e) {
    window.__ttsPrevBg = e.style.backgroundColor;
    window.__ttsPrevSh = e.style.boxShadow;
    e.style.backgroundColor = 'rgba(128,120,104,.16)';
    e.style.boxShadow = '-6px 0 0 rgba(128,120,104,.16), inset 3px 0 0 rgba(120,112,96,.55)';
    e.style.borderRadius = '6px';
    e.scrollIntoView({ block: 'center', behavior: 'smooth' });
    window.__ttsPrev = e;
  }
};

// Lists likely "next chapter" links with a feature vector each (scored by the brain).
// Feature order must match FEATURES in brain.js
const NEXT_CANDS_FN = function (hint) {
  const BADRE = /prev|previous|back|上一|anterior|précédent|предыдущ/i;
  const GOODTXT = /^\s*(next|next chapter|next ch\.?|next page|next ›|next »|›|»|>|→|下一章|下一页|siguiente|suivant|próximo|proximo|далее|следующая)\s*[›»>→]*\s*$/i;
  const CLASSRE = /(^|[\s_-])next([\s_-]|$)|next_?chap|nextchap|btn-?next|chapter-?next/i;
  const TOC = /index|table of contents|\btoc\b|contents|chapter list|all chapters|home|novel info/i;

  const here = new URL(location.href);
  const lastNum = (s) => { const m = /(\d+)(?!.*\d)/.exec(s || ''); return m ? Number(m[1]) : null; };
  const hereNum = lastNum(here.pathname + here.search);
  const segs = here.pathname.split('/').filter(Boolean);
  const box = window.__ttsBox && document.contains(window.__ttsBox) ? window.__ttsBox : null;

  // The button this site used last time. A plain tag ("a") says nothing, so then only the exact text counts.
  let learnedEl = [];
  const specific = !!(hint && hint.sel && /[#.]/.test(hint.sel));
  if (specific) { try { learnedEl = Array.from(document.querySelectorAll(hint.sel)); } catch (_) {} }
  const learned = (el, text) => {
    if (!hint) return false;
    if (specific) return learnedEl.includes(el);
    return !!hint.text && text === hint.text;
  };

  const selOf = (e) => {
    if (e.id && !/\d{3,}/.test(e.id)) return '#' + CSS.escape(e.id);
    const cls = (typeof e.className === 'string' ? e.className : '').split(/\s+/)
      .filter((c) => c && !/\d{3,}|active|hover|focus/i.test(c)).slice(0, 2);
    return e.tagName.toLowerCase() + cls.map((c) => '.' + CSS.escape(c)).join('');
  };

  const out = [];
  window.__rbCands = [];
  document.querySelectorAll('a,button,[role="button"]').forEach((el) => {
    const idc = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
    const text = (el.innerText || el.getAttribute('aria-label') || el.title || '').trim().replace(/\s+/g, ' ');
    if (BADRE.test(text) || BADRE.test(idc)) return;
    if (el.disabled || /disabled/i.test(idc) || el.getAttribute('aria-disabled') === 'true') return;
    if (!el.getClientRects().length) return;
    const hrefRaw = el.tagName === 'A' ? el.getAttribute('href') || '' : '';
    let href = '';
    if (el.tagName === 'A' && el.href) {
      if (el.href.split('#')[0] === location.href.split('#')[0]) return;
      href = el.href;
    }
    let u = null;
    try { u = href ? new URL(href) : null; } catch (_) {}
    const aria = ((el.getAttribute('aria-label') || '') + ' ' + (el.title || '')).toLowerCase();
    const relNext = /(^|\s)next(\s|$)/i.test(el.getAttribute('rel') || '');
    const f = [
      relNext ? 1 : 0,
      CLASSRE.test(idc) ? 1 : 0,
      /next\s*chapter|chapter\s*next|next\s+ch/i.test(text) ? 1 : 0,
      GOODTXT.test(text) ? 1 : 0,
      /^next\b/i.test(text) ? 1 : 0,
      /^[›»>→]+$/.test(text) ? 1 : 0,
      /next/.test(aria) ? 1 : 0,
      u && hereNum != null && u.host === here.host && lastNum(u.pathname + u.search) === hereNum + 1 ? 1 : 0,
      u && u.host === here.host && segs.length > 1 && u.pathname.startsWith('/' + segs.slice(0, -1).join('/')) ? 1 : 0,
      u && /chap|chapter|\/ch[-_]?\d|\/c\d/i.test(u.pathname + u.search) ? 1 : 0,
      el.closest('nav,.pagination,.chapter-nav,.nav-links,[class*="nav"],[class*="pager"]') ? 1 : 0,
      box && (box.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) ? 1 : 0,
      el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' ? 1 : 0,
      TOC.test(text) ? 1 : 0,
      u && u.host !== here.host ? 1 : 0,
      text.length > 0 && text.length <= 24 ? 1 : 0,
      /^(javascript:|#)/i.test(hrefRaw) ? 1 : 0,
      learned(el, text) ? 1 : 0,
    ];
    // only things that look at least a bit like "next"
    if (!(f[0] || f[1] || f[2] || f[3] || f[4] || f[5] || f[6] || f[7] || f[17])) return;
    window.__rbCands.push(el);
    out.push({ i: window.__rbCands.length - 1, f, href, text: text.slice(0, 40), sel: selOf(el) });
  });
  return out.slice(0, 40);
};

// Clicks candidate number i from the last NEXT_CANDS_FN call.
const CLICK_FN = function (i) {
  const el = (window.__rbCands || [])[i];
  if (!el) return { ok: false };
  if (el.tagName === 'A') el.removeAttribute('target');
  setTimeout(() => el.click(), 30);
  return { ok: true };
};

// <link rel="next"> in the page head
const LINK_NEXT_FN = function () {
  const l = document.querySelector('link[rel="next"]');
  return l && l.href ? l.href : '';
};

module.exports = { EXTRACT_FN, HL_FN, NEXT_CANDS_FN, CLICK_FN, LINK_NEXT_FN };
