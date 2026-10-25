// Runs in its own process so the browser never freezes while a voice is being generated.
//
// 0.2: the voice files are now downloaded by this worker itself, safely:
//   - each file is written to "<name>.part" first and only renamed once it is complete,
//     so an interrupted download can never leave a broken model behind,
//   - an interrupted download resumes where it stopped on the next launch,
//   - if a model that is already on disk fails to load (e.g. "Protobuf parsing failed"
//     from an older, half-downloaded copy), it is deleted and downloaded again automatically.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KokoroTTS } from 'kokoro-js';
import { env, StyleTextToSpeech2Model, AutoTokenizer } from '@huggingface/transformers';

// 0.4: the voice runs on the graphics card when it can (DirectML on Windows) and falls back to the
// processor otherwise. On the processor it uses as few threads as it can while still keeping ahead
// of playback (measured, not guessed), threads never spin while idle, and it runs at low priority.
const CORES = Math.max(1, (os.cpus() || []).length);
const DEVICE_PREF = process.env.TTS_DEVICE || 'auto';           // auto | gpu | cpu
const MAX_THREADS = Math.max(1, Math.min(4, +process.env.TTS_MAX_THREADS || CORES - 1));
try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) {}
const sessionFor = (gpu, threads) => ({
  intraOpNumThreads: gpu ? 1 : threads,
  interOpNumThreads: 1,
  executionMode: 'sequential',
  graphOptimizationLevel: 'all',
  enableCpuMemArena: false,      // give memory back after each sentence instead of keeping a big pool
  enableMemPattern: false,
  extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } },
});
const BENCH = 'The lamp at the top of the pass had not been lit in eleven winters, and yet she could see it burning.';

const CACHE = process.env.TTS_CACHE;
env.cacheDir = CACHE;

// q8 = best balance of speed and quality on CPU (~90 MB).
// Want it even faster on an old PC? Change to 'q4' (smaller, a little less clear).
const DTYPE = 'q8';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const ONNX_FILE = { fp32: 'model.onnx', fp16: 'model_fp16.onnx', q8: 'model_quantized.onnx', q4: 'model_q4.onnx', q4f16: 'model_q4f16.onnx' }[DTYPE];
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/' + ONNX_FILE];

const HOST = process.env.TTS_HOST || 'https://huggingface.co';
const MODEL_DIR = path.join(CACHE, ...MODEL.split('/'));
const MANIFEST = path.join(MODEL_DIR, '.verified.json');

let tts = null;
let chain = Promise.resolve();

const send = (m) => { try { process.send(m); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (msg) => send({ type: 'status', message: msg });

/* ---------------- files on disk ---------------- */
function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) || {}; } catch (_) { return {}; }
}
function writeManifest() {
  const m = {};
  for (const f of FILES) {
    try { m[f] = fs.statSync(path.join(MODEL_DIR, f)).size; } catch (_) {}
  }
  try { fs.writeFileSync(MANIFEST, JSON.stringify(m)); } catch (_) {}
}
function purgeModel() {
  // Removes finished files and half-downloaded ".part" files.
  try { fs.rmSync(MODEL_DIR, { recursive: true, force: true }); } catch (_) {}
}
function looksValid(file, full) {
  try {
    if (file.endsWith('.json')) { JSON.parse(fs.readFileSync(full, 'utf8')); return true; }
    // An ONNX model is a protobuf whose first field is the IR version (byte 0x08).
    const fd = fs.openSync(full, 'r');
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, 0);
    fs.closeSync(fd);
    return b[0] === 0x08 && fs.statSync(full).size > 1_000_000;
  } catch (_) { return false; }
}

/* ---------------- safe, resumable download ---------------- */
async function download(file) {
  const final = path.join(MODEL_DIR, file);
  const part = final + '.part';
  fs.mkdirSync(path.dirname(final), { recursive: true });
  const url = `${HOST}/${MODEL}/resolve/main/${file}`;

  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(1500 * attempt);
    let start = 0;
    try { start = fs.statSync(part).size; } catch (_) {}
    try {
      const headers = { 'Accept-Encoding': 'identity' };
      if (start > 0) headers.Range = `bytes=${start}-`;
      const res = await fetch(url, { headers });

      if (res.status === 416) { // the .part is already complete or invalid: start over
        fs.rmSync(part, { force: true });
        continue;
      }
      if (res.status !== 200 && res.status !== 206) throw new Error('server answered ' + res.status);

      let expected = 0;
      if (res.status === 206) {
        const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
        expected = m ? Number(m[1]) : 0;
      } else {
        start = 0; // server ignored the resume request, write from the beginning
        expected = Number(res.headers.get('content-length') || 0);
      }
      const encoded = !!res.headers.get('content-encoding') && res.headers.get('content-encoding') !== 'identity';
      if (encoded) expected = 0; // size check is not possible, the content check below still runs

      const out = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
      const done = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
      let loaded = start;
      const reader = res.body.getReader();
      let lastSent = 0;
      try {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          if (!out.write(value)) await new Promise((r) => out.once('drain', r));
          loaded += value.length;
          const now = Date.now();
          if (now - lastSent > 150) { lastSent = now; send({ type: 'progress', file, loaded, total: expected || loaded }); }
        }
      } finally {
        out.end();
        await done;
      }
      send({ type: 'progress', file, loaded, total: expected || loaded });

      if (expected && loaded !== expected) throw new Error(`download incomplete (${loaded} of ${expected} bytes)`);
      if (!looksValid(file, part)) { fs.rmSync(part, { force: true }); throw new Error('downloaded file is damaged'); }
      fs.renameSync(part, final);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Couldn't download the voice (${lastErr && lastErr.message ? lastErr.message : 'network error'}). Check your internet connection and press Retry.`);
}

async function ensureFiles() {
  const manifest = readManifest();
  const missing = [];
  for (const f of FILES) {
    const full = path.join(MODEL_DIR, f);
    let size = -1;
    try { size = fs.statSync(full).size; } catch (_) {}
    if (size < 0) { missing.push(f); continue; }
    // Known-good size from a previous successful load: must match exactly.
    if (manifest[f] != null && manifest[f] !== size) { fs.rmSync(full, { force: true }); missing.push(f); continue; }
    if (manifest[f] == null && !looksValid(f, full)) { fs.rmSync(full, { force: true }); missing.push(f); }
  }
  // Files that are already here count as fully loaded, so the % stays honest.
  for (const f of FILES) {
    if (!missing.includes(f)) {
      try { const s = fs.statSync(path.join(MODEL_DIR, f)).size; send({ type: 'progress', file: f, loaded: s, total: s }); } catch (_) {}
    }
  }
  for (const f of missing) await download(f);
}

/* ---------------- engine ---------------- */
let minGen = 0;            // requests from older reading sessions are dropped, not generated
let info = { device: 'cpu', threads: 1, rtf: 0 };

async function loadModel(gpu, threads) {
  const [model, tokenizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(MODEL, { dtype: DTYPE, device: gpu ? 'dml' : 'cpu', session_options: sessionFor(gpu, threads) }),
    AutoTokenizer.from_pretrained(MODEL),
  ]);
  return new KokoroTTS(model, tokenizer);
}
async function unload(t) { try { if (t && t.model && t.model.dispose) await t.model.dispose(); } catch (_) {} }
// Real-time factor: seconds of work per second of speech (lower is better; must stay well below 1).
async function bench(t) {
  await t.generate('Ready.', { voice: 'af_heart', speed: 1 });           // warm-up
  const t0 = Date.now();
  const out = await t.generate(BENCH, { voice: 'af_heart', speed: 1 });
  return (Date.now() - t0) / 1000 / Math.max(0.1, out.audio.length / out.sampling_rate);
}

async function loadCpu() {
  let threads = Math.min(MAX_THREADS, CORES <= 2 && !process.env.TTS_MAX_THREADS ? 1 : 2);
  let t = await loadModel(false, threads);
  let rtf = await bench(t);
  // Too slow to stay ahead comfortably? Add threads, one step at a time.
  while (rtf > 0.45 && threads < MAX_THREADS) {
    await unload(t);
    threads = Math.min(MAX_THREADS, threads + 1);
    t = await loadModel(false, threads);
    rtf = await bench(t);
  }
  info = { device: 'cpu', threads, rtf: Math.round(rtf * 100) / 100 };
  return t;
}

async function loadBest() {
  if (DEVICE_PREF !== 'cpu' && process.platform === 'win32') {
    send({ type: 'stage', stage: 'gpu' });       // if the graphics driver crashes us here, main retries on CPU
    try {
      const t = await loadModel(true, 1);
      const rtf = await bench(t);
      if (rtf < 0.4 || DEVICE_PREF === 'gpu') {
        info = { device: 'gpu', threads: 1, rtf: Math.round(rtf * 100) / 100 };
        return t;
      }
      await unload(t);                           // graphics card slower than the processor here
    } catch (_) { /* no usable graphics card: use the processor */ }
    send({ type: 'stage', stage: 'cpu' });
  }
  return loadCpu();
}

async function load() {
  try {
    await ensureFiles();
    try {
      tts = await loadBest();
    } catch (e) {
      // The files on disk are broken (typically "Protobuf parsing failed"): fetch a clean copy once.
      status('Repairing voice files…');
      purgeModel();
      await ensureFiles();
      tts = await loadBest();
    }
    writeManifest();
    send({ type: 'ready', info });
  } catch (e) {
    send({ type: 'load-error', message: String(e && e.message ? e.message : e) });
  }
}

async function synth({ id, gen, text, voice, speed }) {
  if ((gen || 0) < minGen) { send({ type: 'error', id, message: 'cancelled' }); return; }
  try {
    const out = await tts.generate(text, { voice, speed });
    const audio = new Float32Array(out.audio); // own copy, tight buffer
    send({ type: 'audio', id, audio, sr: out.sampling_rate });
  } catch (e) {
    send({ type: 'error', id, message: String(e && e.message ? e.message : e) });
  }
}

process.on('message', (m) => {
  if (!m) return;
  if (m.type === 'synth') chain = chain.then(() => synth(m)); // one sentence at a time, in order
  else if (m.type === 'cancel') minGen = Math.max(minGen, m.gen || 0);
});

load();
