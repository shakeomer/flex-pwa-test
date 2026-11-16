'use strict';
const VERSION = 'flex-pwa-test 1.0 (2026-11-16)';
const MP_VER = '1.2.3';
const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + MP_VER;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const MIMES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

const $ = (id) => document.getElementById(id);
const R = {};                       // results, keyed by test
const S = { clips: [], record: null, launchIdx: -1, stream: null, facing: 'environment',
  rec: null, wake: null, pose: null, delegate: 'GPU' };
const errText = (e) => (e && e.name ? e.name + ': ' + e.message : String(e));
const st = (id, kind, msg) => { const e = $('s-' + id); e.className = 'status ' + kind; e.textContent = msg; };
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' MB';
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(p, ms, label) {
  let t; const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + ' timed out after ' + ms + ' ms')), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}
// Runs a test; any error is shown in its status line and stored, never propagated.
async function guard(id, key, fn) {
  try { await fn(); } catch (e) { R[key] = Object.assign(R[key] || {}, { ok: false, error: errText(e) }); st(id, 'fail', 'FAIL ' + errText(e)); }
}
const onTap = (btn, id, key, fn) => $(btn).addEventListener('click', () => guard(id, key, fn));

// ---------- IndexedDB ----------
let dbp;
const getDb = () => dbp || (dbp = new Promise((res, rej) => {
  const r = indexedDB.open('flextest', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('meta'); r.result.createObjectStore('clips', { keyPath: 'id' }); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('IDB blocked'));
}));
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function tx(store, mode, fn) {
  const t = (await getDb()).transaction(store, mode);
  const done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('tx aborted')); });
  const out = await fn(t.objectStore(store));
  await done; return out;
}
const saveRecord = () => tx('meta', 'readwrite', (s) => reqP(s.put(S.record, 'record')));

// ---------- 1. Environment ----------
async function registerSW() {
  if (!('serviceWorker' in navigator)) { R.sw = 'unsupported'; return; }
  try { const reg = await navigator.serviceWorker.register('./sw.js'); R.sw = 'registered, scope ' + reg.scope; }
  catch (e) { R.sw = 'FAILED ' + errText(e); }
}
async function envTest() {
  R.env = {
    userAgent: navigator.userAgent,
    standaloneMatchMedia: matchMedia('(display-mode: standalone)').matches,
    navigatorStandalone: navigator.standalone,
    secureContext: window.isSecureContext,
    screen: screen.width + 'x' + screen.height + ' @' + devicePixelRatio + 'x',
    viewport: innerWidth + 'x' + innerHeight,
    url: location.href,
    serviceWorker: R.sw, swControlsPage: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    api: { getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), MediaRecorder: typeof MediaRecorder !== 'undefined',
      wakeLock: 'wakeLock' in navigator, opfs: !!(navigator.storage && navigator.storage.getDirectory), share: !!navigator.share,
      clipboard: !!(navigator.clipboard && navigator.clipboard.writeText), deviceOrientation: 'DeviceOrientationEvent' in window },
  };
  const e = R.env;
  st('env', e.standaloneMatchMedia || e.navigatorStandalone ? 'pass' : 'warn',
    (isStandalone() ? 'STANDALONE (home-screen mode)' : 'BROWSER TAB (not standalone)') +
    '\nmatchMedia standalone: ' + e.standaloneMatchMedia + '\nnavigator.standalone: ' + e.navigatorStandalone +
    '\nsecure context: ' + e.secureContext + '\nscreen: ' + e.screen + '  viewport: ' + e.viewport +
    '\nSW: ' + e.serviceWorker + ' (controls page: ' + e.swControlsPage + ')\nUA: ' + e.userAgent);
}

// ---------- 2. Launch history ----------
async function launchTest() {
  const now = Date.now(), standalone = isStandalone();
  const fsURL = new URL('./__firstSeen', location.href).href;
  let lsVal = null, cacheVal = null, idbRec = null;
  try { const v = localStorage.getItem('ft_firstSeen'); lsVal = v ? Number(v) : null; } catch (e) { lsVal = 'ERR ' + errText(e); }
  try {
    const c = await caches.open('flextest-data'); const r = await c.match(fsURL);
    cacheVal = r ? Number(await r.text()) : null;
  } catch (e) { cacheVal = 'ERR ' + errText(e); }
  idbRec = await tx('meta', 'readonly', (s) => reqP(s.get('record')));

  const idbFirst = idbRec ? idbRec.firstSeen : null;
  const existing = { idb: idbFirst, localStorage: lsVal, cacheStorage: cacheVal };
  const present = Object.values(existing).filter((v) => typeof v === 'number');
  let verdict;
  if (present.length === 0) verdict = 'first launch ever (nothing stored yet)';
  else if (present.length < 3) verdict = 'DISAGREE: missing in ' + Object.keys(existing).filter((k) => typeof existing[k] !== 'number').join(', ') + ' -> possible EVICTION';
  else if (new Set(present).size > 1) verdict = 'DISAGREE: values differ';
  else verdict = 'consistent';

  S.record = idbRec || { firstSeen: now, launches: [] };
  const prev = S.record.launches.length ? S.record.launches[S.record.launches.length - 1].t : null;
  S.record.launches.push({ t: now, iso: new Date(now).toISOString(), standalone, camera: null });
  S.launchIdx = S.record.launches.length - 1;
  await saveRecord();
  try { if (lsVal === null) localStorage.setItem('ft_firstSeen', String(S.record.firstSeen)); } catch (e) { /* reported via ERR above next time */ }
  try { if (cacheVal === null) await (await caches.open('flextest-data')).put(fsURL, new Response(String(S.record.firstSeen))); } catch (e) { /* ignore */ }

  const days = (a, b) => ((a - b) / 86400000).toFixed(2);
  R.launch = { ok: true, verdict, existingBeforeThisLaunch: existing, firstSeen: new Date(S.record.firstSeen).toISOString(),
    daysSinceFirstSeen: Number(days(now, S.record.firstSeen)), daysSincePrevLaunch: prev ? Number(days(now, prev)) : null,
    launches: S.record.launches.length, idbRecordWasMissing: !idbRec };
  st('launch', verdict.startsWith('DISAGREE') ? 'fail' : 'pass',
    'verdict: ' + verdict + '\nfirst seen (IDB): ' + new Date(S.record.firstSeen).toLocaleString() +
    '\ndays since first seen: ' + days(now, S.record.firstSeen) +
    '\ndays since previous launch: ' + (prev ? days(now, prev) : 'n/a') +
    '\nlaunches recorded: ' + S.record.launches.length +
    '\nbefore this launch -> IDB: ' + fmtTs(idbFirst) + ' | localStorage: ' + fmtTs(lsVal) + ' | Cache: ' + fmtTs(cacheVal));
}
const fmtTs = (v) => (typeof v === 'number' ? new Date(v).toISOString().slice(0, 16) : String(v));
async function recordCamera(info) {
  if (!S.record || S.launchIdx < 0) return;
  S.record.launches[S.launchIdx].camera = info;
  try { await saveRecord(); } catch (e) { /* shown elsewhere */ }
}

// ---------- 3. Storage ----------
async function storageTest(askPersist) {
  if (!navigator.storage) throw new Error('navigator.storage unavailable');
  const o = {};
  if (askPersist) { o.persistResult = navigator.storage.persist ? await navigator.storage.persist() : 'persist() unavailable'; }
  o.persisted = navigator.storage.persisted ? await navigator.storage.persisted() : 'persisted() unavailable';
  if (navigator.storage.estimate) { const e = await navigator.storage.estimate(); o.quotaMB = +(e.quota / 1048576).toFixed(1); o.usageMB = +(e.usage / 1048576).toFixed(2); }
  else o.estimate = 'unavailable';
  R.storage = Object.assign({ ok: true, persistAsked: !!askPersist }, o);
  st('storage', 'info', (askPersist ? 'persist() returned: ' + o.persistResult + '\n' : 'persist() not requested yet (tap button)\n') +
    'persisted(): ' + o.persisted + '\nquota: ' + o.quotaMB + ' MB\nusage: ' + o.usageMB + ' MB');
}

// ---------- 4. Camera ----------
function stopCamera() {
  stopPose();
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null; $('preview').srcObject = null;
}
async function startCamera() {
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) throw new Error('getUserMedia unavailable');
  stopCamera();
  const v = $('preview'); const t0 = performance.now();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: { ideal: S.facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } });
    const tGum = performance.now() - t0;
    S.stream = stream; v.srcObject = stream;
    const first = new Promise((res) => { if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => res()); else v.addEventListener('playing', () => res(), { once: true }); });
    await v.play();
    await withTimeout(first, 8000, 'first frame');
    const tFrame = performance.now() - t0;
    const s = stream.getVideoTracks()[0].getSettings();
    R.camera = { ok: true, requestedFacing: S.facing, width: s.width, height: s.height, frameRate: s.frameRate, facingMode: s.facingMode || null,
      msToStream: Math.round(tGum), msToFirstFrame: Math.round(tFrame), label: stream.getVideoTracks()[0].label };
    await recordCamera({ ok: true, width: s.width, height: s.height, frameRate: s.frameRate, msToFirstFrame: Math.round(tFrame) });
    st('camera', 'pass', 'PASS ' + s.width + 'x' + s.height + ' @ ' + s.frameRate + ' fps, facingMode: ' + (s.facingMode || '(not reported)') +
      '\ngetUserMedia: ' + Math.round(tGum) + ' ms, first frame: ' + Math.round(tFrame) + ' ms');
  } catch (e) {
    stopCamera();
    R.camera = { ok: false, error: errText(e), requestedFacing: S.facing };
    await recordCamera({ ok: false, error: errText(e) });
    throw e;
  }
}

// ---------- 5. Recording ----------
function mimeSupport() {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder unavailable');
  return Object.fromEntries(MIMES.map((m) => [m, MediaRecorder.isTypeSupported(m)]));
}
function showFormats() {
  const sup = mimeSupport(); R.formats = sup;
  st('rec', 'info', 'isTypeSupported:\n' + MIMES.map((m) => (sup[m] ? 'YES ' : 'no  ') + m).join('\n'));
}
function probe(blob, ms) {
  return new Promise((res, rej) => {
    const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true; v.playsInline = true;
    const url = URL.createObjectURL(blob); let info = {};
    const done = (f, x) => { clearTimeout(t); v.onerror = v.onloadedmetadata = v.ontimeupdate = null; v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); f(x); };
    const t = setTimeout(() => done(rej, new Error('metadata timeout')), ms || 10000);
    v.onerror = () => done(rej, new Error('video error code ' + (v.error && v.error.code)));
    v.onloadedmetadata = () => {
      info = { width: v.videoWidth, height: v.videoHeight };
      if (v.duration === Infinity || isNaN(v.duration)) {
        v.ontimeupdate = () => { v.ontimeupdate = null; done(res, Object.assign(info, { duration: v.duration, wasInfinity: true })); };
        v.currentTime = 1e101;
      } else done(res, Object.assign(info, { duration: v.duration, wasInfinity: false }));
    };
    v.src = url;
  });
}
function record(secs) {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder unavailable');
  if (!S.stream || !S.stream.active) throw new Error('start the camera first');
  if (S.rec) throw new Error('already recording');
  const mimeType = MIMES.find((m) => MediaRecorder.isTypeSupported(m));
  const rec = mimeType ? new MediaRecorder(S.stream, { mimeType }) : new MediaRecorder(S.stream);
  const chunks = []; const t0 = performance.now(); S.rec = rec;
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const tick = setInterval(() => st('rec', 'warn', 'RECORDING ' + ((performance.now() - t0) / 1000).toFixed(0) + ' / ' + secs + ' s  (' + fmtMB(chunks.reduce((a, c) => a + c.size, 0)) + ')\nmime: ' + (rec.mimeType || mimeType)), 500);
  const timer = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, secs * 1000);
  return new Promise((resolve, reject) => {
    rec.onerror = (e) => { clearInterval(tick); clearTimeout(timer); S.rec = null; reject(e.error || new Error('MediaRecorder error')); };
    rec.onstop = async () => {
      clearInterval(tick); clearTimeout(timer); S.rec = null;
      try {
        const wall = (performance.now() - t0) / 1000;
        const type = rec.mimeType || mimeType || 'video/mp4';
        const blob = new Blob(chunks, { type });
        if (!blob.size) throw new Error('recorded blob is empty');
        st('rec', 'info', 'stopped, measuring... ' + fmtMB(blob.size));
        let pr; try { pr = await probe(blob); } catch (e) { pr = { error: errText(e) }; }
        R.recording = { ok: !pr.error, chosenMimeType: mimeType || '(browser default)', recorderMimeType: rec.mimeType, size: blob.size, wallSeconds: +wall.toFixed(1),
          measuredDuration: pr.duration, durationWasInfinity: pr.wasInfinity, width: pr.width, height: pr.height, probeError: pr.error };
        st('rec', pr.error ? 'fail' : 'pass', (pr.error ? 'recorded but unreadable: ' + pr.error : 'PASS') + '\nmime: ' + type + '\nsize: ' + fmtMB(blob.size) +
          '\nwall: ' + wall.toFixed(1) + ' s, measured: ' + (pr.duration !== undefined ? pr.duration.toFixed(2) + ' s' : '?') + (pr.wasInfinity ? ' (was Infinity)' : '') +
          '\nvideo: ' + pr.width + 'x' + pr.height);
        const pb = $('playback'); if (pb.dataset.url) URL.revokeObjectURL(pb.dataset.url);
        pb.dataset.url = URL.createObjectURL(blob); pb.src = pb.dataset.url;
        await saveClip(blob, type, pr.duration, wall);
        resolve();
      } catch (e) { R.recording = Object.assign(R.recording || {}, { ok: false, error: errText(e) }); reject(e); }
    };
    rec.start(1000);
  });
}

// ---------- 6. Clip persistence ----------
const clipName = (c) => 'clip-' + c.id + (/mp4/.test(c.mimeType) ? '.mp4' : '.webm');
const WORKER_SRC = 'onmessage=async e=>{try{const{name,blob}=e.data;const root=await navigator.storage.getDirectory();' +
  'const fh=await root.getFileHandle(name,{create:true});const h=await fh.createSyncAccessHandle();h.truncate(0);' +
  'const CH=4194304;for(let o=0;o<blob.size;o+=CH){h.write(new Uint8Array(await blob.slice(o,o+CH).arrayBuffer()),{at:o});}' +
  'h.flush();h.close();postMessage({ok:true});}catch(err){postMessage({ok:false,error:err.name+": "+err.message});}}';
function opfsWorkerWrite(name, blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })); const w = new Worker(url);
    const fin = (f, x) => { w.terminate(); URL.revokeObjectURL(url); f(x); };
    w.onmessage = (e) => (e.data.ok ? fin(res) : fin(rej, new Error(e.data.error)));
    w.onerror = (e) => fin(rej, new Error(e.message || 'worker error'));
    w.postMessage({ name, blob });
  });
}
async function opfsWrite(name, blob) {
  if (!(navigator.storage && navigator.storage.getDirectory)) return 'unavailable (no getDirectory)';
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(name, { create: true });
  let first = null;
  if (typeof fh.createWritable === 'function') {
    try { const w = await fh.createWritable(); await w.write(blob); await w.close(); return 'ok (createWritable)'; } catch (e) { first = errText(e); }
  } else first = 'createWritable missing';
  await opfsWorkerWrite(name, blob);
  return 'ok (worker syncAccessHandle; main-thread: ' + first + ')';
}
async function opfsSize(name) {
  const root = await navigator.storage.getDirectory();
  return (await (await root.getFileHandle(name)).getFile()).size;
}
async function saveClip(blob, mimeType, duration, wall) {
  const clip = { id: Date.now(), created: new Date().toISOString(), mimeType, size: blob.size, duration: duration === undefined ? null : duration, wallSeconds: +wall.toFixed(1), blob, opfs: null };
  try { clip.opfs = await withTimeout(opfsWrite(clipName(clip), blob), 20000, 'OPFS write'); } catch (e) { clip.opfs = 'FAILED ' + errText(e); }
  await tx('clips', 'readwrite', (s) => reqP(s.put(clip)));
  R.clipSave = { ok: true, id: clip.id, idb: 'ok', opfs: clip.opfs };
  await loadClips();
}
async function loadClips() {
  S.clips = await tx('clips', 'readonly', (s) => reqP(s.getAll()));
  S.clips.sort((a, b) => a.id - b.id);
  const list = $('cliplist'); list.textContent = '';
  for (const c of S.clips) {
    const d = document.createElement('div'); d.className = 'clip'; d.id = 'clip-' + c.id;
    const m = document.createElement('div'); m.className = 'meta'; m.id = 'meta-' + c.id;
    const o = document.createElement('button'); o.className = 'small'; o.textContent = 'Open'; o.dataset.act = 'open'; o.dataset.id = c.id;
    const x = document.createElement('button'); x.className = 'small danger'; x.textContent = 'Delete'; x.dataset.act = 'del'; x.dataset.id = c.id;
    const r = document.createElement('div'); r.className = 'row'; r.append(o, x); d.append(m, r); list.append(d);
    renderMeta(c);
  }
  st('clips', 'info', S.clips.length + ' clip(s) stored. Verifying...');
  await verifyClips();
}
function renderMeta(c) {
  const v = c.verify;
  $('meta-' + c.id).textContent = '#' + c.id + '\n' + c.created + '\n' + c.mimeType + ' | ' + fmtMB(c.size) + ' | dur ' + (c.duration == null ? '?' : c.duration.toFixed(1) + 's') +
    '\nOPFS@save: ' + c.opfs + (v ? '\nverify: IDB blob ' + v.idb + ' | plays ' + v.plays + ' | OPFS ' + v.opfs : '\nverify: pending');
}
async function verifyClips() {
  let bad = 0;
  for (const c of S.clips) {
    const v = { idb: 'ok', plays: 'ok', opfs: 'n/a' };
    if (!(c.blob instanceof Blob) || c.blob.size <= 0) { v.idb = 'EMPTY/MISSING'; v.plays = 'n/a'; }
    else {
      if (c.blob.size !== c.size) v.idb = 'size mismatch ' + c.blob.size + ' vs ' + c.size;
      try { await probe(c.blob, 10000); } catch (e) { v.plays = 'FAIL ' + errText(e); }
    }
    if (c.opfs && c.opfs.startsWith('ok')) { try { const n = await opfsSize(clipName(c)); v.opfs = n === c.size ? 'ok' : 'size mismatch ' + n; } catch (e) { v.opfs = 'FAIL ' + errText(e); } }
    if (v.idb !== 'ok' || v.plays !== 'ok' || (c.opfs && c.opfs.startsWith('ok') && v.opfs !== 'ok')) bad++;
    c.verify = v; renderMeta(c);
  }
  R.clips = { ok: bad === 0, count: S.clips.length, bad };
  st('clips', bad ? 'fail' : 'pass', S.clips.length + ' clip(s); ' + (bad ? bad + ' failed verification' : 'all verified readable'));
}
$('cliplist').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  guard('clips', 'clips', async () => {
    const id = Number(b.dataset.id); const c = S.clips.find((x) => x.id === id); if (!c) return;
    if (b.dataset.act === 'open') {
      const pb = $('playback'); if (pb.dataset.url) URL.revokeObjectURL(pb.dataset.url);
      pb.dataset.url = URL.createObjectURL(c.blob); pb.src = pb.dataset.url; await pb.play(); st('clips', 'info', 'playing #' + id);
    } else {
      await tx('clips', 'readwrite', (s) => reqP(s.delete(id)));
      try { const root = await navigator.storage.getDirectory(); await root.removeEntry(clipName(c)); } catch (err) { /* may not exist */ }
      await loadClips();
    }
  });
});

// ---------- 7. Export ----------
function latestClip() { if (!S.clips.length) throw new Error('no saved clips'); return S.clips[S.clips.length - 1]; }
function download() {
  const c = latestClip(); const url = URL.createObjectURL(c.blob);
  const a = document.createElement('a'); a.href = url; a.download = clipName(c); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  R.exportDownload = { ok: true, note: 'anchor click dispatched; confirm file appeared in Files/Downloads', file: clipName(c) };
  st('export', 'info', 'anchor download triggered for ' + clipName(c) + '\n(confirm manually that a file or preview appeared)');
}
async function share() {
  const c = latestClip();
  if (!navigator.share) throw new Error('navigator.share unavailable');
  const f = new File([c.blob], clipName(c), { type: c.mimeType.split(';')[0] });
  if (!navigator.canShare || !navigator.canShare({ files: [f] })) throw new Error('canShare({files}) is false for ' + f.type);
  try { await navigator.share({ files: [f] }); R.exportShare = { ok: true }; st('export', 'pass', 'PASS share sheet completed for ' + f.name); }
  catch (e) {
    if (e.name === 'AbortError') { R.exportShare = { ok: true, note: 'sheet opened, user cancelled' }; st('export', 'pass', 'share sheet opened (cancelled by user) - file sharing works'); }
    else throw e;
  }
}

// ---------- 8. Wake lock ----------
let wakeWanted = false, wakeT0 = 0, wakeTimer = null;
async function acquireWake(reason) {
  S.wake = await navigator.wakeLock.request('screen');
  R.wake.acquisitions++;
  S.wake.addEventListener('release', () => { R.wake.releases++; R.wake.lastReleaseAtS = +((performance.now() - wakeT0) / 1000).toFixed(1); });
  return reason;
}
async function wakeTest() {
  if (!navigator.wakeLock) throw new Error('navigator.wakeLock unavailable');
  R.wake = { ok: true, acquisitions: 0, releases: 0, reacquiredAfterVisibility: 0, heldAt60s: null };
  wakeWanted = true; wakeT0 = performance.now();
  await acquireWake('initial');
  clearInterval(wakeTimer);
  wakeTimer = setInterval(() => {
    const s = (performance.now() - wakeT0) / 1000; const held = S.wake && !S.wake.released;
    if (s >= 60 && R.wake.heldAt60s === null) R.wake.heldAt60s = !!held;
    st('wake', held ? 'pass' : 'warn', 'acquired: yes\nheld now: ' + held + ' (t=' + s.toFixed(0) + ' s)\nheld at 60 s: ' + (R.wake.heldAt60s === null ? 'waiting...' : R.wake.heldAt60s) +
      '\nreleases: ' + R.wake.releases + ', re-acquired after visibility: ' + R.wake.reacquiredAfterVisibility);
  }, 1000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeWanted && (!S.wake || S.wake.released)) {
    guard('wake', 'wake', async () => { await acquireWake('visibility'); R.wake.reacquiredAfterVisibility++; });
  }
});

// ---------- 9. Motion ----------
let motionOn = false;
async function motionTest() {
  if (!('DeviceOrientationEvent' in window)) throw new Error('DeviceOrientationEvent unavailable');
  let perm = 'not required';
  if (typeof DeviceOrientationEvent.requestPermission === 'function') perm = await DeviceOrientationEvent.requestPermission();
  R.motion = { ok: perm === 'granted' || perm === 'not required', permission: perm, events: 0, sample: null };
  if (!R.motion.ok) throw new Error('permission ' + perm);
  if (!motionOn) {
    motionOn = true;
    addEventListener('deviceorientation', (e) => {
      R.motion.events++;
      if (e.beta === null || e.gamma === null) return;
      R.motion.sample = { beta: +e.beta.toFixed(1), gamma: +e.gamma.toFixed(1), alpha: e.alpha === null ? null : +e.alpha.toFixed(1) };
      $('motion-big').textContent = 'pitch(beta) ' + e.beta.toFixed(0) + '\nroll(gamma) ' + e.gamma.toFixed(0);
      $('motion-big').style.whiteSpace = 'pre-line';
    });
  }
  st('motion', 'info', 'permission: ' + perm + '\nwaiting for events...');
  await sleep(2500);
  if (!R.motion.events) { R.motion.ok = false; st('motion', 'fail', 'FAIL permission ' + perm + ' but no deviceorientation events in 2.5 s'); }
  else st('motion', 'pass', 'PASS permission ' + perm + ', ' + R.motion.events + ' events so far');
}

// ---------- 10. Pose ----------
const GROUPS = { hips: [23, 24], knees: [25, 26], ankles: [27, 28] };
function stopPose() {
  if (!S.pose) return;
  S.pose.running = false;
  try { S.pose.lm.close(); } catch (e) { /* ignore */ }
  const c = $('overlay'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
  S.pose = null;
}
async function poseTest() {
  if (!S.stream || !S.stream.active) throw new Error('start the camera first (section 4)');
  stopPose();
  const delegate = S.delegate; const t0 = performance.now();
  st('pose', 'warn', 'loading MediaPipe ' + MP_VER + ' (' + delegate + ')...');
  R.pose = { ok: false, delegate, mediapipeVersion: MP_VER, model: MODEL_URL };
  const mod = await withTimeout(import(MP_BASE + '/vision_bundle.mjs'), 30000, 'import vision_bundle.mjs');
  const fileset = await withTimeout(mod.FilesetResolver.forVisionTasks(MP_BASE + '/wasm'), 30000, 'FilesetResolver');
  const lm = await withTimeout(mod.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: 'VIDEO', numPoses: 1 }), 60000, 'createFromOptions');
  const loadMs = Math.round(performance.now() - t0);
  const p = S.pose = { lm, running: true };
  const v = $('preview'), cv = $('overlay'), ctx = cv.getContext('2d');
  const times = [], vis = { hips: [], knees: [], ankles: [] }; let lastT = 0, frames = 0, detected = 0, lastUI = 0, inferMs = 0;
  const next = (f) => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(f) : requestAnimationFrame(f));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  R.pose = Object.assign(R.pose, { ok: true, loadMs });
  const loop = () => {
    if (!p.running) return;
    try {
      if (v.readyState >= 2 && v.videoWidth) {
        let t = performance.now(); if (t <= lastT) t = lastT + 1; lastT = t;
        const a = performance.now(); const res = lm.detectForVideo(v, t); inferMs = performance.now() - a; frames++;
        times.push(t); if (times.length > 30) times.shift();
        if (cv.width !== v.videoWidth) { cv.width = v.videoWidth; cv.height = v.videoHeight; }
        ctx.clearRect(0, 0, cv.width, cv.height);
        const pts = res.landmarks && res.landmarks[0];
        if (pts) {
          detected++;
          for (const g in GROUPS) { vis[g].push(mean(GROUPS[g].map((i) => pts[i].visibility))); if (vis[g].length > 60) vis[g].shift(); }
          ctx.lineWidth = Math.max(3, cv.width / 220); ctx.strokeStyle = '#2ec4b6'; ctx.fillStyle = '#fbbf24';
          for (const c of mod.PoseLandmarker.POSE_CONNECTIONS) {
            const A = pts[c.start], B = pts[c.end]; ctx.globalAlpha = Math.min(A.visibility, B.visibility) < 0.5 ? 0.3 : 1;
            ctx.beginPath(); ctx.moveTo(A.x * cv.width, A.y * cv.height); ctx.lineTo(B.x * cv.width, B.y * cv.height); ctx.stroke();
          }
          for (const q of pts) { ctx.globalAlpha = q.visibility < 0.5 ? 0.3 : 1; ctx.beginPath(); ctx.arc(q.x * cv.width, q.y * cv.height, ctx.lineWidth * 1.3, 0, 7); ctx.fill(); }
          ctx.globalAlpha = 1;
        }
        if (t - lastUI > 500 && times.length > 1) {
          lastUI = t; const fps = (times.length - 1) / ((times[times.length - 1] - times[0]) / 1000);
          const mv = (g) => (vis[g].length ? +mean(vis[g]).toFixed(2) : null);
          R.pose = Object.assign(R.pose, { fps: +fps.toFixed(1), inferMsLast: +inferMs.toFixed(1), frames, framesWithPerson: detected, meanVisibility: { hips: mv('hips'), knees: mv('knees'), ankles: mv('ankles') } });
          st('pose', 'pass', 'RUNNING ' + delegate + ' (load ' + loadMs + ' ms)\nfps (30-frame avg): ' + fps.toFixed(1) + '  infer ' + inferMs.toFixed(0) + ' ms' +
            '\nperson in ' + detected + '/' + frames + ' frames\nmean visibility  hips ' + mv('hips') + '  knees ' + mv('knees') + '  ankles ' + mv('ankles'));
        }
      }
    } catch (e) { p.running = false; R.pose = Object.assign(R.pose, { ok: false, error: errText(e) }); st('pose', 'fail', 'FAIL during detect: ' + errText(e)); return; }
    next(loop);
  };
  next(loop);
}

// ---------- 11. Report ----------
function buildReport() {
  return { appVersion: VERSION, swCacheVersion: 'see sw.js CACHE_VERSION', generatedAt: new Date().toISOString(), results: R, launchRecord: S.record,
    clips: S.clips.map((c) => ({ id: c.id, created: c.created, mimeType: c.mimeType, size: c.size, duration: c.duration, wallSeconds: c.wallSeconds, opfs: c.opfs, verify: c.verify })) };
}
function copyReport() {
  const txt = JSON.stringify(buildReport(), null, 2); const ta = $('report'); ta.value = txt;
  const fallback = () => { ta.focus(); ta.select(); ta.setSelectionRange(0, txt.length);
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    st('report', ok ? 'pass' : 'warn', ok ? 'PASS copied (execCommand), ' + txt.length + ' chars' : 'clipboard blocked: select the text below and copy manually'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(txt).then(() => st('report', 'pass', 'PASS copied to clipboard, ' + txt.length + ' chars'), fallback);
  }
  fallback();
}

// ---------- wiring ----------
onTap('b-env', 'env', 'env', envTest);
onTap('b-persist', 'storage', 'storage', () => storageTest(true));
onTap('b-cam', 'camera', 'camera', startCamera);
onTap('b-flip', 'camera', 'camera', async () => {
  S.facing = S.facing === 'environment' ? 'user' : 'environment';
  $('b-flip').textContent = 'Facing: ' + (S.facing === 'environment' ? 'rear' : 'front');
  if (S.stream) await startCamera();
});
onTap('b-camstop', 'camera', 'camera', () => { stopCamera(); st('camera', 'info', 'camera stopped'); });
onTap('b-fmt', 'rec', 'formats', showFormats);
onTap('b-rec10', 'rec', 'recording', () => record(10));
onTap('b-rec60', 'rec', 'recording', () => record(60));
onTap('b-rec300', 'rec', 'recording', () => record(300));
onTap('b-recstop', 'rec', 'recording', () => { if (S.rec && S.rec.state !== 'inactive') S.rec.stop(); });
onTap('b-verify', 'clips', 'clips', loadClips);
onTap('b-dl', 'export', 'exportDownload', download);
onTap('b-share', 'export', 'exportShare', share);
onTap('b-wake', 'wake', 'wake', wakeTest);
onTap('b-motion', 'motion', 'motion', motionTest);
onTap('b-pose', 'pose', 'pose', poseTest);
onTap('b-posestop', 'pose', 'pose', () => { stopPose(); st('pose', 'info', 'pose stopped'); });
$('b-delegate').addEventListener('click', () => {
  S.delegate = S.delegate === 'GPU' ? 'CPU' : 'GPU'; $('b-delegate').textContent = 'Delegate: ' + S.delegate;
  if (S.pose) guard('pose', 'pose', poseTest);
});
onTap('b-report', 'report', 'report', copyReport);

(async function init() {
  $('ver').textContent = VERSION + ' | MediaPipe ' + MP_VER + ' | ' + location.href;
  await guard('env', 'env', async () => { await registerSW(); await envTest(); });
  await guard('launch', 'launch', launchTest);
  await guard('storage', 'storage', () => storageTest(false));
  await guard('rec', 'formats', async () => { try { showFormats(); } catch (e) { st('rec', 'fail', 'FAIL ' + errText(e)); R.formats = { error: errText(e) }; } });
  await guard('clips', 'clips', loadClips);
})();
