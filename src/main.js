/**
 * E-Pelanggaran Siswa — PWA
 * Stack : Vite + Vanilla JS (single main.js) + Appwrite + IDB offline-first
 * Sync  : Delta sync otomatis tiap 100 detik saat online
 *         — hanya fetch dokumen yang is_updated > lastSyncAt
 *         — soft-delete via is_deleted (tidak hapus fisik di Appwrite)
 *
 * Koleksi Appwrite (jalankan init.js sekali untuk setup):
 *   DB_ID: 'siswapro'
 *   m_kelas       : nama_kelas, is_updated, is_deleted
 *   m_siswa       : id_kelas, nis, nama_siswa, jenis_kelamin, is_updated, is_deleted
 *   t_pelanggaran : id_siswa, tanggal, catatan, poin, tindakan, is_updated, is_deleted
 *   pengaturan    : nama_sekolah, alamat_sekolah  (single-doc, no delta)
 */

import { registerSW } from 'virtual:pwa-register';
import { Client, Databases, Account, Query, ID } from 'appwrite';
import { openDB } from 'idb';

// ─────────────────────────────────────────────────────────────────────────────
// KONFIGURASI — via .env (VITE_APPWRITE_ENDPOINT, VITE_APPWRITE_PROJECT)
// ─────────────────────────────────────────────────────────────────────────────
const APPWRITE_ENDPOINT = import.meta.env.VITE_APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1';
const APPWRITE_PROJECT  = import.meta.env.VITE_APPWRITE_PROJECT  || 'GANTI_PROJECT_ID';
const DB_ID             = import.meta.env.VITE_DB_ID             || 'siswapro';
const COL_KELAS         = 'm_kelas';
const COL_SISWA         = 'm_siswa';
const COL_PELANGGARAN   = 't_pelanggaran';
const COL_PENGATURAN    = 'pengaturan';
const PENGATURAN_DOC_ID = import.meta.env.VITE_PENGATURAN_DOC_ID || 'main';

// ─────────────────────────────────────────────────────────────────────────────
// APPWRITE CLIENT
// ─────────────────────────────────────────────────────────────────────────────
const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT);
const account = new Account(client);
const db = new Databases(client);

// ─────────────────────────────────────────────────────────────────────────────
// IDB — OFFLINE CACHE
// ─────────────────────────────────────────────────────────────────────────────
// ── IDB UTAMA — data & sync cache ────────────────────────────────────────────
const idbReady = openDB('siswapro-idb', 4, {
  upgrade(database) {
    if (!database.objectStoreNames.contains('kelas'))        database.createObjectStore('kelas',        { keyPath: '$id' });
    if (!database.objectStoreNames.contains('siswa'))        database.createObjectStore('siswa',        { keyPath: '$id' });
    if (!database.objectStoreNames.contains('pelanggaran'))  database.createObjectStore('pelanggaran',  { keyPath: '$id' });
    if (!database.objectStoreNames.contains('pengaturan'))   database.createObjectStore('pengaturan',   { keyPath: 'key' });
    if (!database.objectStoreNames.contains('syncQueue'))    database.createObjectStore('syncQueue',    { keyPath: 'id', autoIncrement: true });
    if (!database.objectStoreNames.contains('syncMeta'))     database.createObjectStore('syncMeta',     { keyPath: 'key' });
  }
});
async function idb() { return idbReady; }

// ── IDB SESSION — database terpisah, versi tetap 1, tidak pernah berubah ─────
// Dipisah agar upgrade IDB utama tidak pernah mengganggu persistensi session.
const sessionDbReady = openDB('siswapro-session', 1, {
  upgrade(database) {
    if (!database.objectStoreNames.contains('kv')) {
      database.createObjectStore('kv', { keyPath: 'k' });
    }
  }
});
async function sessionDb() { return sessionDbReady; }

async function sessionSave(user) {
  try {
    const d = await sessionDb();
    await d.put('kv', { k: 'user', v: user, ts: Date.now() });
  } catch (e) { console.warn('[Session] gagal simpan:', e.message); }
}
async function sessionLoad() {
  try {
    const d = await sessionDb();
    const rec = await d.get('kv', 'user');
    return rec ? rec.v : null;
  } catch (e) { console.warn('[Session] gagal baca:', e.message); return null; }
}
async function sessionClear() {
  try {
    const d = await sessionDb();
    await d.delete('kv', 'user');
  } catch (e) { console.warn('[Session] gagal hapus:', e.message); }
}

// Helper cache
async function cacheAll(store, docs) {
  const d = await idb();
  const tx = d.transaction(store, 'readwrite');
  for (const doc of docs) await tx.store.put(doc);
  await tx.done;
}
async function cacheOne(store, doc) {
  const d = await idb(); await d.put(store, doc);
}
async function getFromCache(store) {
  const d = await idb(); return d.getAll(store);
}
async function deleteFromCache(store, id) {
  const d = await idb(); await d.delete(store, id);
}
async function addToSyncQueue(op) {
  const d = await idb();
  await d.add('syncQueue', { ...op, createdAt: Date.now() });
  syncState.queueCount++;
  _refreshSyncPanel();
}

// Baca/tulis timestamp lastSyncAt per koleksi ke IDB syncMeta
async function getLastSyncAt(collection) {
  const d = await idb();
  try { const r = await d.get('syncMeta', collection); return r ? r.ts : null; }
  catch { return null; }
}
async function setLastSyncAt(collection, ts) {
  const d = await idb(); await d.put('syncMeta', { key: collection, ts });
}

// Drain syncQueue: kirim semua operasi offline ke Appwrite
// is_updated di-set ulang oleh Appwrite $updatedAt, tapi kita kirim juga dari data
async function drainSyncQueue() {
  const d = await idb();
  const queue = await d.getAll('syncQueue');
  let drained = 0;
  for (const op of queue) {
    try {
      if (op.type === 'create') await db.createDocument(DB_ID, op.collection, op.docId, op.data);
      if (op.type === 'update') await db.updateDocument(DB_ID, op.collection, op.docId, op.data);
      if (op.type === 'softDelete') await db.updateDocument(DB_ID, op.collection, op.docId, op.data);
      await d.delete('syncQueue', op.id);
      drained++;
    } catch { /* biarkan, coba lagi di siklus berikutnya */ }
  }
  if (drained > 0) {
    console.log('[Sync] drainQueue:', drained, 'ops dikirim');
    await _refreshQueueCount();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ONLINE DETECTION + DELTA SYNC ENGINE
// ─────────────────────────────────────────────────────────────────────────────
// v1.0 b7
const APP_VERSION = 'v1.0 b11';

let isOnline = false;   // selalu mulai false, dikonfirmasi via probeOnline()
let _deltaTimer = null;

/**
 * probeOnline — cek koneksi ke Appwrite secara aktif.
 * Jauh lebih reliable dari navigator.onLine di mobile.
 * Timeout 6 detik. Return true jika berhasil.
 */
async function probeOnline() {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 6000);
    // HEAD ke endpoint Appwrite — ringan, tanpa body
    await fetch(APPWRITE_ENDPOINT + '/health', {
      method:  'HEAD',
      signal:  ctrl.signal,
      cache:   'no-store',
      headers: { 'X-Appwrite-Project': APPWRITE_PROJECT },
    });
    clearTimeout(tid);
    isOnline = true;
  } catch {
    isOnline = false;
  }
  renderSyncBadge();
  return isOnline;
}

// Sync state — dibaca oleh halaman Pengaturan untuk progress bar
const syncState = {
  running:      false,
  nextSyncIn:   100,       // detik hitung mundur
  lastSyncAt:   null,      // ISO string waktu sync terakhir selesai
  lastLog:      [],        // array { col, count, ts } dari sync terakhir
  queueCount:   0,         // jumlah dokumen offline belum dikirim
  _countdownTimer: null,
};

/** Refresh queueCount dari IDB dan update panel */
async function _refreshQueueCount() {
  try {
    const d = await idb();
    const queue = await d.getAll('syncQueue');
    syncState.queueCount = queue.length;
  } catch { syncState.queueCount = 0; }
  _refreshSyncPanel();
}

function _tickCountdown() {
  if (!isOnline || !_deltaTimer) return;
  syncState.nextSyncIn = Math.max(0, syncState.nextSyncIn - 1);
  _refreshSyncPanel();
}
function _startCountdown() {
  if (syncState._countdownTimer) clearInterval(syncState._countdownTimer);
  syncState.nextSyncIn = 100;
  syncState._countdownTimer = setInterval(_tickCountdown, 1000);
}
function _stopCountdown() {
  if (syncState._countdownTimer) { clearInterval(syncState._countdownTimer); syncState._countdownTimer = null; }
  syncState.nextSyncIn = 0;
  _refreshSyncPanel();
}

/** Update panel sync di halaman Pengaturan tanpa re-render seluruh halaman */
function _refreshSyncPanel() {
  if (state.route !== 'pengaturan') return;

  const bar = document.getElementById('sync-progress-bar');
  const pct = document.getElementById('sync-progress-pct');
  const nxt = document.getElementById('sync-next-in');
  const log = document.getElementById('sync-log-table');
  const sta = document.getElementById('sync-status-label');
  const qel = document.getElementById('sync-queue-count');

  const ratio = syncState.nextSyncIn / 100;

  if (bar)  bar.style.width  = syncState.running ? '100%' : `${(1 - ratio) * 100}%`;
  if (pct)  pct.textContent  = syncState.running ? 'Sinkronisasi…' : `${Math.round((1 - ratio) * 100)}%`;
  if (nxt)  nxt.textContent  = syncState.running
      ? '—'
      : isOnline
        ? `${syncState.nextSyncIn} detik`
        : 'Offline';
  if (sta)  sta.textContent  = syncState.running
      ? '🔄 Sedang sinkronisasi…'
      : isOnline
        ? (syncState.lastSyncAt ? `✅ Terakhir: ${_fmtDateTime(syncState.lastSyncAt)}` : '⏳ Belum sync')
        : '🔴 Offline — sync ditunda';
  if (sta)  sta.style.color  = syncState.running ? 'var(--info)' : isOnline ? 'var(--success)' : 'var(--danger)';

  // Antrian dokumen offline
  if (qel) {
    const q = syncState.queueCount;
    if (q === 0) {
      qel.innerHTML = '<span class="badge badge-success">✓ Tidak ada antrian</span>';
    } else {
      qel.innerHTML = `<span class="badge badge-warn">⏳ ${q} dokumen menunggu dikirim</span>`;
    }
  }

  if (log && syncState.lastLog.length > 0) {
    const labelMap = {
      [COL_KELAS]:       'Master Kelas',
      [COL_SISWA]:       'Master Siswa',
      [COL_PELANGGARAN]: 'Pelanggaran',
    };
    log.innerHTML = syncState.lastLog.map(r => `
      <tr>
        <td>${labelMap[r.col] || r.col}</td>
        <td style="text-align:center">
          <span class="badge ${r.count > 0 ? 'badge-accent' : 'badge-info'}">${r.count} dokumen</span>
        </td>
        <td style="color:var(--text3);font-size:.78rem">${_fmtDateTime(r.ts)}</td>
      </tr>`).join('');
  } else if (log) {
    log.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text3);padding:1rem">Belum ada riwayat sync</td></tr>';
  }
}

function _fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' })
    + ' ' + d.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

window.addEventListener('online', async () => {
  const ok = await probeOnline();
  if (!ok) return;
  await drainSyncQueue();
  await runDeltaSync();
  _reloadActiveRoute();
  showToast('Kembali online — data tersinkron', 'success');
  startDeltaTimer();
});
window.addEventListener('offline', () => {
  isOnline = false;
  renderSyncBadge();
  stopDeltaTimer();
  showToast('Mode offline aktif', 'warn');
});

// Spinner sync pertama — tampil jika IDB belum pernah di-sync
function showFirstSyncSpinner(msg = 'Memuat data pertama kali…') {
  if (document.getElementById('first-sync-overlay')) return;
  const el = document.createElement('div');
  el.id = 'first-sync-overlay';
  el.innerHTML = `
    <div class="spinner"></div>
    <div class="sync-msg">${msg}</div>
    <div class="sync-sub" id="first-sync-sub">Menghubungkan ke server…</div>`;
  document.body.appendChild(el);
}
function updateFirstSyncMsg(sub) {
  const el = document.getElementById('first-sync-sub');
  if (el) el.textContent = sub;
}
function hideFirstSyncSpinner() {
  const el = document.getElementById('first-sync-overlay');
  if (!el) return;
  el.style.transition = 'opacity .4s';
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 420);
}

function startDeltaTimer() {
  stopDeltaTimer();
  _startCountdown();
  _deltaTimer = setInterval(async () => {
    if (!isOnline || !state.user) return;
    await drainSyncQueue();
    await runDeltaSync();
    // Selalu reload halaman aktif setelah sync — data IDB mungkin berubah
    _reloadActiveRoute();
    _startCountdown();
  }, 100_000);
  console.log('[Sync] Delta timer dimulai (interval 100 detik)');
}

/** Reload data halaman yang sedang aktif dari IDB (tanpa navigate ulang) */
function _reloadActiveRoute() {
  if (state.route === 'dashboard')  loadPelanggaran();
  else if (state.route === 'kelas') loadKelas();
  else if (state.route === 'siswa') loadSiswaPage();
  else if (state.route === 'input') loadSiswaForInput();
}
function stopDeltaTimer() {
  if (_deltaTimer) { clearInterval(_deltaTimer); _deltaTimer = null; }
  _stopCountdown();
}

/**
 * runDeltaSync — fetch hanya dokumen yang berubah sejak lastSyncAt
 * Menggunakan Query.greaterThan('is_updated', lastSyncAt)
 * Dokumen soft-deleted (is_deleted != null) dihapus dari IDB lokal
 * Return: true jika ada perubahan
 */
async function runDeltaSync() {
  if (!isOnline || !state.user) return false;
  syncState.running = true;
  syncState.lastLog = [];
  _refreshSyncPanel();

  let anyChange = false;
  const now = new Date().toISOString();

  const targets = [
    { col: COL_KELAS,       store: 'kelas',       label: 'Kelas' },
    { col: COL_SISWA,       store: 'siswa',       label: 'Siswa' },
    { col: COL_PELANGGARAN, store: 'pelanggaran', label: 'Pelanggaran' },
  ];

  // Sync pertama: semua koleksi belum pernah di-sync → tampilkan spinner
  const firstSync = !(await getLastSyncAt(COL_KELAS)) && !(await getLastSyncAt(COL_SISWA));
  if (firstSync) showFirstSyncSpinner('Sinkronisasi data pertama kali…');

  for (const { col, store, label } of targets) {
    try {
      if (firstSync) updateFirstSyncMsg(`Memuat ${label}…`);
      const lastSyncAt = await getLastSyncAt(col);
      const queries = [Query.limit(2000)];
      if (lastSyncAt) {
        queries.push(Query.greaterThan('is_updated', lastSyncAt));
      } else {
        queries.push(Query.orderDesc('$updatedAt'));
      }

      const res = await db.listDocuments(DB_ID, col, queries);
      syncState.lastLog.push({ col, count: res.documents.length, ts: now });

      if (res.documents.length > 0) {
        const d = await idb();
        const tx = d.transaction(store, 'readwrite');
        for (const doc of res.documents) {
          if (doc.is_deleted) {
            await tx.store.delete(doc.$id);
            if (store === 'kelas')       state.kelas       = state.kelas.filter(x => x.$id !== doc.$id);
            if (store === 'siswa')       state.siswa       = state.siswa.filter(x => x.$id !== doc.$id);
            if (store === 'pelanggaran') state.pelanggaran = state.pelanggaran.filter(x => x.$id !== doc.$id);
          } else {
            await tx.store.put(doc);
            if (store === 'kelas') {
              const idx = state.kelas.findIndex(x => x.$id === doc.$id);
              if (idx >= 0) state.kelas[idx] = doc; else state.kelas.push(doc);
            }
            if (store === 'siswa') {
              const idx = state.siswa.findIndex(x => x.$id === doc.$id);
              if (idx >= 0) state.siswa[idx] = doc; else state.siswa.push(doc);
            }
            if (store === 'pelanggaran') {
              const idx = state.pelanggaran.findIndex(x => x.$id === doc.$id);
              if (idx >= 0) state.pelanggaran[idx] = doc; else state.pelanggaran.unshift(doc);
            }
          }
          anyChange = true;
        }
        await tx.done;
        console.log(`[Sync] ${col}: ${res.documents.length} perubahan`);
      }
      await setLastSyncAt(col, now);
    } catch (e) {
      console.warn(`[Sync] ${col} gagal:`, e.message);
      syncState.lastLog.push({ col, count: -1, ts: now }); // -1 = error
    }
  }

  syncState.running  = false;
  syncState.lastSyncAt = now;
  _refreshSyncPanel();
  if (firstSync) hideFirstSyncSpinner();
  return anyChange;
}

// ─────────────────────────────────────────────────────────────────────────────
// PWA SW REGISTER
// ─────────────────────────────────────────────────────────────────────────────
registerSW({ onNeedRefresh() {}, onOfflineReady() { showToast('App siap digunakan offline!', 'info'); } });

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
let state = {
  route: 'login',      // login | dashboard | input | kelas | siswa | pengaturan
  user: null,
  kelas: [],
  siswa: [],
  pelanggaran: [],
  pengaturan: {},
  filter: { tgl: '', bulan: '', tahun: '', nama: '', catatan: '' },
  filterSiswaKelas: '',  // id_kelas filter di halaman siswa
  loading: false,
  toast: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────────────────────────────────────
function navigate(route) {
  state.route = route;
  render();
  if (route === 'dashboard')  loadPelanggaran();
  if (route === 'kelas')      loadKelas();
  if (route === 'siswa')      loadSiswaPage();
  if (route === 'input')      loadSiswaForInput();
  if (route === 'pengaturan') loadPengaturan();
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
async function checkSession() {
  // ── Langkah 1: mulai probe koneksi (paralel, non-blocking) ───────────────────
  const probePromise = probeOnline();

  // ── Langkah 2: baca session dari IDB — tidak butuh network ───────────────────
  const cachedUser = await sessionLoad();

  if (cachedUser) {
    // Ada session lokal → langsung masuk dashboard tanpa tunggu probe
    state.user = cachedUser;
    navigate('dashboard');
    // Setelah probe selesai, verifikasi session di background (non-blocking)
    probePromise.then(online => { if (online) _verifySessionBackground(); });
    return;
  }

  // ── Langkah 3: tidak ada cache — tunggu probe, lalu coba Appwrite ────────────
  const online = await probePromise;
  if (!online) { navigate('login'); return; }
  try {
    state.user = await account.get();
    await sessionSave(state.user);
    navigate('dashboard');
    startDeltaTimer();
  } catch {
    navigate('login');
  }
}

async function _verifySessionBackground() {
  const online = await probeOnline();
  if (!online) return; // offline → tetap di dashboard, tidak force logout

  // Online terkonfirmasi → verifikasi session Appwrite
  try {
    const user = await account.get();
    state.user = user;
    await sessionSave(user);
    await runDeltaSync(); // spinner otomatis jika sync pertama
    _reloadActiveRoute(); // muat ulang data terbaru ke halaman aktif
    startDeltaTimer();
  } catch {
    _forceLogout();
  }
}

async function _forceLogout() {
  stopDeltaTimer();
  try { await account.deleteSession('current'); } catch {}
  await sessionClear();
  state.user = null;
  navigate('login');
  showToast('Sesi habis, silakan login kembali', 'warn');
}

async function doLogin(email, password) {
  setLoading(true);
  try {
    await account.createEmailPasswordSession(email, password);
    state.user = await account.get();
    await sessionSave(state.user);
    navigate('dashboard');
    startDeltaTimer();
  } catch (e) {
    showToast('Login gagal: ' + (e.message || 'Periksa email/password'), 'danger');
  } finally { setLoading(false); }
}

async function doLogout() {
  stopDeltaTimer();
  try { await account.deleteSession('current'); } catch {}
  await sessionClear();
  state.user = null;
  navigate('login');
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA FETCHING — selalu dari IDB (delta sync yang update cache)
// ─────────────────────────────────────────────────────────────────────────────
async function loadKelas() {
  setLoading(true);
  const all = await getFromCache('kelas');
  state.kelas = all.filter(k => !k.is_deleted);
  setLoading(false);
  render();
}

async function loadSiswa() {
  const all = await getFromCache('siswa');
  state.siswa = all.filter(s => !s.is_deleted);
}

async function loadSiswaPage() {
  setLoading(true);
  await loadSiswa();
  if (!state.kelas.length) await loadKelas();
  else { setLoading(false); render(); }
}

async function loadSiswaForInput() {
  await loadSiswa();
  if (!state.kelas.length) await loadKelas();
  else render();
}

async function loadPelanggaran() {
  setLoading(true);
  const all = await getFromCache('pelanggaran');
  state.pelanggaran = all
    .filter(p => !p.is_deleted)
    .sort((a, b) => new Date(b.tanggal) - new Date(a.tanggal));
  if (!state.siswa.length) await loadSiswa();
  if (!state.kelas.length) await loadKelas();
  setLoading(false);
  render();
}

async function loadPengaturan() {
  setLoading(true);
  const d = await idb();
  const c = await d.get('pengaturan', 'main');
  state.pengaturan = c || {};
  setLoading(false);
  render();
}

// ─────────────────────────────────────────────────────────────────────────────
// MUTATIONS
// ─────────────────────────────────────────────────────────────────────────────
async function simpanKelas(namaKelas) {
  const docId = ID.unique();
  const ts    = new Date().toISOString();
  const data  = { nama_kelas: namaKelas, is_updated: ts, is_deleted: null };
  const doc   = { $id: docId, ...data };
  await cacheOne('kelas', doc);
  state.kelas = [...state.kelas, doc];
  // Tidak memanggil render() agar DOM input tidak terhapus — caller update tabel sendiri
  if (isOnline) {
    try { await db.createDocument(DB_ID, COL_KELAS, docId, data); }
    catch { await addToSyncQueue({ type: 'create', collection: COL_KELAS, docId, data }); }
  } else {
    await addToSyncQueue({ type: 'create', collection: COL_KELAS, docId, data });
  }
  showToast('Kelas berhasil disimpan');
}

async function hapusKelas(id) {
  if (!confirm('Hapus kelas ini?')) return;
  const ts = new Date().toISOString();
  const softData = { is_deleted: ts, is_updated: ts };
  state.kelas = state.kelas.filter(k => k.$id !== id);
  await deleteFromCache('kelas', id);
  // Caller (bindKelas) akan refresh tabel sendiri tanpa re-render
  if (isOnline) {
    try { await db.updateDocument(DB_ID, COL_KELAS, id, softData); }
    catch { await addToSyncQueue({ type: 'softDelete', collection: COL_KELAS, docId: id, data: softData }); }
  } else {
    await addToSyncQueue({ type: 'softDelete', collection: COL_KELAS, docId: id, data: softData });
  }
  showToast('Kelas dihapus', 'warn');
}

async function simpanSiswa(dataIn) {
  const docId = ID.unique();
  const ts    = new Date().toISOString();
  const data  = { ...dataIn, is_updated: ts, is_deleted: null };
  const doc   = { $id: docId, ...data };
  await cacheOne('siswa', doc);
  state.siswa = [...state.siswa, doc];
  render();
  if (isOnline) {
    try { await db.createDocument(DB_ID, COL_SISWA, docId, data); }
    catch { await addToSyncQueue({ type: 'create', collection: COL_SISWA, docId, data }); }
  } else {
    await addToSyncQueue({ type: 'create', collection: COL_SISWA, docId, data });
  }
  showToast('Siswa berhasil disimpan');
}

async function hapusSiswa(id) {
  if (!confirm('Hapus siswa ini?')) return;
  const ts = new Date().toISOString();
  const softData = { is_deleted: ts, is_updated: ts };
  state.siswa = state.siswa.filter(s => s.$id !== id);
  await deleteFromCache('siswa', id);
  render();
  if (isOnline) {
    try { await db.updateDocument(DB_ID, COL_SISWA, id, softData); }
    catch { await addToSyncQueue({ type: 'softDelete', collection: COL_SISWA, docId: id, data: softData }); }
  } else {
    await addToSyncQueue({ type: 'softDelete', collection: COL_SISWA, docId: id, data: softData });
  }
  showToast('Siswa dihapus', 'warn');
}

async function simpanPelanggaran(dataIn) {
  const docId = ID.unique();
  const ts    = new Date().toISOString();
  const data  = { ...dataIn, is_updated: ts, is_deleted: null };
  const doc   = { $id: docId, ...data };
  await cacheOne('pelanggaran', doc);
  state.pelanggaran = [doc, ...state.pelanggaran];
  if (isOnline) {
    try { await db.createDocument(DB_ID, COL_PELANGGARAN, docId, data); }
    catch { await addToSyncQueue({ type: 'create', collection: COL_PELANGGARAN, docId, data }); }
  } else {
    await addToSyncQueue({ type: 'create', collection: COL_PELANGGARAN, docId, data });
  }
  showToast('Pelanggaran berhasil dicatat');
  navigate('dashboard');
}

async function hapusPelanggaran(id) {
  if (!confirm('Hapus catatan pelanggaran ini?')) return;
  const ts = new Date().toISOString();
  const softData = { is_deleted: ts, is_updated: ts };
  state.pelanggaran = state.pelanggaran.filter(p => p.$id !== id);
  await deleteFromCache('pelanggaran', id);
  render();
  if (isOnline) {
    try { await db.updateDocument(DB_ID, COL_PELANGGARAN, id, softData); }
    catch { await addToSyncQueue({ type: 'softDelete', collection: COL_PELANGGARAN, docId: id, data: softData }); }
  } else {
    await addToSyncQueue({ type: 'softDelete', collection: COL_PELANGGARAN, docId: id, data: softData });
  }
  showToast('Catatan dihapus', 'warn');
}

async function simpanPengaturan(data) {
  setLoading(true);
  if (isOnline) {
    try {
      // Coba update dulu, kalau tidak ada buat baru
      try { await db.updateDocument(DB_ID, COL_PENGATURAN, PENGATURAN_DOC_ID, data); }
      catch { await db.createDocument(DB_ID, COL_PENGATURAN, PENGATURAN_DOC_ID, data); }
    } catch { await addToSyncQueue({ type: 'update', collection: COL_PENGATURAN, docId: PENGATURAN_DOC_ID, data }); }
  } else {
    await addToSyncQueue({ type: 'update', collection: COL_PENGATURAN, docId: PENGATURAN_DOC_ID, data });
  }
  const d = await idb(); await d.put('pengaturan', { key: 'main', ...data });
  state.pengaturan = { ...state.pengaturan, ...data };
  setLoading(false);
  showToast('Pengaturan disimpan');
  render();
}

// ─────────────────────────────────────────────────────────────────────────────
// FILTER HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function getFilteredPelanggaran() {
  const f = state.filter;
  return state.pelanggaran.filter(p => {
    const siswa = state.siswa.find(s => s.$id === p.id_siswa) || {};
    const tgl   = new Date(p.tanggal);
    if (f.tgl     && p.tanggal.slice(0, 10) !== f.tgl) return false;
    if (f.bulan   && String(tgl.getMonth() + 1) !== f.bulan) return false;
    if (f.tahun   && String(tgl.getFullYear()) !== f.tahun) return false;
    if (f.nama    && !(siswa.nama_siswa || '').toLowerCase().includes(f.nama.toLowerCase())) return false;
    if (f.catatan && !p.catatan.toLowerCase().includes(f.catatan.toLowerCase())) return false;
    return true;
  });
}

function getKelasName(kelasId) {
  return (state.kelas.find(k => k.$id === kelasId) || {}).nama_kelas || '-';
}
function getSiswaById(id) {
  return state.siswa.find(s => s.$id === id) || {};
}

// ─────────────────────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function setLoading(v) { state.loading = v; renderLoader(); }

function renderLoader() {
  const el = document.getElementById('global-loader');
  if (el) el.style.opacity = state.loading ? '1' : '0';
}

function showToast(msg, type = 'success') {
  state.toast = { msg, type };
  const t = document.getElementById('toast');
  if (!t) return;
  const colors = { success: '#22c55e', danger: '#ef4444', warn: '#facc15', info: '#38bdf8' };
  t.style.background = colors[type] || colors.success;
  t.textContent = msg;
  t.style.transform = 'translateY(0)';
  t.style.opacity = '1';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => {
    t.style.transform = 'translateY(120%)';
    t.style.opacity = '0';
  }, 3000);
}

function renderSyncBadge() {
  const el = document.getElementById('sync-badge');
  if (!el) return;
  if (isOnline) {
    el.innerHTML = '🟢 Online';
    el.style.color = '#22c55e';
    el.title = 'Delta sync otomatis tiap 100 detik';
  } else {
    el.innerHTML = '🔴 Offline';
    el.style.color = '#ef4444';
    el.title = 'Perubahan disimpan lokal, akan sync saat online';
  }
  _refreshSyncPanel();
}

const BULAN = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
function fmtTgl(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS STYLES
// ─────────────────────────────────────────────────────────────────────────────
function injectCSS() {
  if (document.getElementById('app-style')) return;
  const style = document.createElement('style');
  style.id = 'app-style';
  style.textContent = `
    /* ── LAYOUT ── */
    .shell { display:flex; flex-direction:column; min-height:100vh; }
    .topbar { background:var(--surface); border-bottom:1px solid var(--border); padding:0 1.25rem;
      display:flex; align-items:center; justify-content:space-between; height:56px; position:sticky; top:0; z-index:100; }
    .topbar-brand { font-family:'DM Serif Display',serif; font-size:1.2rem; color:var(--accent); letter-spacing:-.02em; }
    .topbar-right { display:flex; align-items:center; gap:.75rem; }
    .sync-badge { font-size:.72rem; font-weight:600; letter-spacing:.04em; }
    .main { flex:1; padding:1.25rem; max-width:960px; margin:0 auto; width:100%; }
    .botnav { background:var(--surface); border-top:1px solid var(--border); display:flex; position:sticky; bottom:0; z-index:100; }
    .botnav-item { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
      gap:3px; padding:.6rem .4rem; cursor:pointer; border:none; background:none; color:var(--text2);
      font-size:.64rem; font-weight:600; letter-spacing:.04em; text-transform:uppercase; transition:all .18s; }
    .botnav-item svg { width:20px; height:20px; }
    .botnav-item.active { color:var(--accent); }
    .botnav-item:active { background:var(--surface2); }

    /* ── CARDS ── */
    .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:1.1rem; margin-bottom:.9rem; }
    .card-header { font-weight:600; margin-bottom:.9rem; font-size:.85rem; color:var(--text2); text-transform:uppercase; letter-spacing:.06em; display:flex; align-items:center; gap:.5rem; }
    .card-header-main { font-family:'DM Serif Display',serif; font-size:1.1rem; color:var(--text); text-transform:none; letter-spacing:-.01em; }

    /* ── FORM ── */
    .form-group { margin-bottom:.85rem; }
    .form-label { display:block; font-size:.78rem; font-weight:600; color:var(--text2); margin-bottom:.3rem; letter-spacing:.04em; text-transform:uppercase; }
    .form-control { width:100%; background:var(--surface2); border:1px solid var(--border); border-radius:8px;
      color:var(--text); padding:.55rem .75rem; font-family:'DM Sans',sans-serif; font-size:.9rem; outline:none; transition:border .15s; }
    .form-control:focus { border-color:var(--accent); }
    select.form-control option { background:var(--surface2); }
    .row-2 { display:grid; grid-template-columns:1fr 1fr; gap:.75rem; }
    .row-3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:.75rem; }

    /* ── BUTTONS ── */
    .btn { display:inline-flex; align-items:center; gap:.4rem; padding:.5rem 1rem; border-radius:8px;
      font-family:'DM Sans',sans-serif; font-weight:600; font-size:.85rem; cursor:pointer; border:none;
      transition:all .15s; letter-spacing:.01em; }
    .btn-primary   { background:var(--accent); color:#fff; }
    .btn-primary:hover { background:var(--accent2); }
    .btn-outline   { background:transparent; border:1px solid var(--border); color:var(--text); }
    .btn-outline:hover { border-color:var(--accent); color:var(--accent); }
    .btn-danger    { background:var(--danger); color:#fff; }
    .btn-ghost     { background:transparent; color:var(--text2); }
    .btn-ghost:hover { color:var(--text); background:var(--surface2); }
    .btn-sm        { padding:.3rem .65rem; font-size:.78rem; }
    .btn-block     { width:100%; justify-content:center; }

    /* ── TABLE ── */
    .tbl-wrap { overflow-x:auto; }
    table { width:100%; border-collapse:collapse; }
    thead th { background:var(--surface2); color:var(--text2); font-size:.72rem; font-weight:600; letter-spacing:.06em; text-transform:uppercase;
      padding:.65rem .85rem; border-bottom:1px solid var(--border); text-align:left; }
    tbody td { padding:.7rem .85rem; border-bottom:1px solid var(--border); vertical-align:middle; }
    tbody tr:last-child td { border-bottom:none; }
    tbody tr:hover { background:var(--surface2); }

    /* ── BADGE ── */
    .badge { display:inline-block; padding:.18rem .55rem; border-radius:99px; font-size:.7rem; font-weight:700; letter-spacing:.04em; }
    .badge-accent  { background:rgba(249,115,22,.15); color:var(--accent); }
    .badge-info    { background:rgba(56,189,248,.15); color:var(--info); }
    .badge-danger  { background:rgba(239,68,68,.15); color:var(--danger); }
    .badge-success { background:rgba(34,197,94,.15); color:var(--success); }
    .badge-warn    { background:rgba(250,204,21,.15); color:var(--warn); }

    /* ── LOGIN ── */
    .login-wrap { display:flex; align-items:center; justify-content:center; min-height:100vh; padding:1.5rem; }
    .login-card { width:100%; max-width:380px; background:var(--surface); border:1px solid var(--border);
      border-radius:14px; padding:2rem; box-shadow:var(--shadow); }
    .login-title { font-family:'DM Serif Display',serif; font-size:1.9rem; color:var(--text); margin-bottom:.25rem; }
    .login-sub { color:var(--text3); font-size:.85rem; margin-bottom:2rem; }

    /* ── TOAST ── */
    #toast { position:fixed; bottom:70px; left:50%; transform:translateX(-50%) translateY(120%);
      padding:.6rem 1.2rem; border-radius:99px; font-weight:600; font-size:.82rem;
      transition:all .3s cubic-bezier(.34,1.56,.64,1); z-index:999; white-space:nowrap;
      box-shadow:0 4px 20px rgba(0,0,0,.5); opacity:0; color:#fff; pointer-events:none; }

    /* ── LOADER ── */
    #global-loader { position:fixed; top:0; left:0; right:0; height:3px; z-index:9999;
      background:linear-gradient(90deg,var(--accent),var(--accent2),var(--accent));
      background-size:200% 100%; animation:loadanim 1s linear infinite; transition:opacity .2s; opacity:0; }
    @keyframes loadanim { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

    /* ── FILTER SECTION ── */
    .filter-wrap { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:1rem; margin-bottom:1rem; }
    .filter-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:.6rem; }
    .filter-actions { display:flex; gap:.5rem; justify-content:flex-end; margin-top:.75rem; }

    /* ── EMPTY ── */
    .empty { text-align:center; padding:3rem 1rem; color:var(--text3); }
    .empty-icon { font-size:2.5rem; margin-bottom:.75rem; }

    /* ── PAGE TITLE ── */
    .page-title { font-family:'DM Serif Display',serif; font-size:1.5rem; margin-bottom:1.2rem; display:flex; align-items:center; gap:.6rem; }
    .page-actions { display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; }

    /* ── PELANGGARAN CARD ── */
    .pcard { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:1rem 1.1rem;
      margin-bottom:.75rem; transition:border-color .15s; }
    .pcard:hover { border-color:var(--accent); }
    .pcard-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:.4rem; }
    .pcard-name { font-weight:700; font-size:.95rem; }
    .pcard-meta { font-size:.78rem; color:var(--text3); margin-bottom:.5rem; }
    .pcard-catatan { color:var(--text2); font-size:.88rem; line-height:1.5; }
    .pcard-footer { display:flex; justify-content:space-between; align-items:center; margin-top:.75rem; padding-top:.65rem; border-top:1px solid var(--border); }

    /* ── FIRST-SYNC SPINNER ── */
    #first-sync-overlay {
      position:fixed; inset:0; z-index:9998;
      background:var(--bg);
      display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1.25rem;
    }
    #first-sync-overlay .spinner {
      width:52px; height:52px; border-radius:50%;
      border:4px solid var(--border);
      border-top-color:var(--accent);
      animation:spin .8s linear infinite;
    }
    @keyframes spin { to { transform:rotate(360deg); } }
    #first-sync-overlay .sync-msg {
      font-family:'DM Serif Display',serif; font-size:1.15rem; color:var(--text);
    }
    #first-sync-overlay .sync-sub {
      font-size:.8rem; color:var(--text3);
    }

    /* Print */
    @media print {
      .topbar,.botnav,.filter-wrap,.btn { display:none !important; }
      .main { max-width:100%; padding:0; }
      .pcard { border:1px solid #ccc; margin:0 0 6pt; page-break-inside:avoid; }
      body::before { content:"LAPORAN PELANGGARAN SISWA"; display:block; text-align:center; font-size:16pt; font-weight:bold; margin-bottom:12pt; }
    }

    @media(max-width:480px) {
      .row-2,.row-3 { grid-template-columns:1fr; }
      .filter-grid { grid-template-columns:1fr 1fr; }
    }
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER ENGINE
// ─────────────────────────────────────────────────────────────────────────────
function render() {
  injectCSS();
  const app = document.getElementById('app');
  if (state.route === 'login') { app.innerHTML = renderLogin(); bindLogin(); return; }
  app.innerHTML = renderShell();
  document.getElementById('global-loader').style.opacity = state.loading ? '1' : '0';
  renderSyncBadge();

  const main = document.getElementById('main-content');
  if (state.route === 'dashboard')  { main.innerHTML = renderDashboard(); bindDashboard(); }
  if (state.route === 'input')      { main.innerHTML = renderInput(); bindInput(); }
  if (state.route === 'kelas')      { main.innerHTML = renderKelas(); bindKelas(); }
  if (state.route === 'siswa')      { main.innerHTML = renderSiswa(); bindSiswa(); }
  if (state.route === 'pengaturan') { main.innerHTML = renderPengaturan(); bindPengaturan(); }

  // Bottom nav active
  document.querySelectorAll('.botnav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.route === state.route);
    el.onclick = () => navigate(el.dataset.route);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SHELL
// ─────────────────────────────────────────────────────────────────────────────
function renderShell() {
  const ps = state.pengaturan;
  const namaSekolah = ps.nama_sekolah || 'E-Pelanggaran';
  return `
    <div id="global-loader"></div>
    <div id="toast"></div>
    <div class="shell">
      <header class="topbar">
        <span class="topbar-brand">⚖️ ${namaSekolah}</span>
        <div class="topbar-right">
          <span id="sync-badge" class="sync-badge">...</span>
          <button class="btn btn-ghost btn-sm" id="btn-logout">Keluar</button>
        </div>
      </header>
      <main class="main" id="main-content"></main>
      <nav class="botnav">
        ${navItem('dashboard','<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>','Data')}
        ${navItem('input','<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>','Input')}
        ${navItem('kelas','<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>','Kelas')}
        ${navItem('siswa','<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>','Siswa')}
        ${navItem('pengaturan','<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><circle cx="12" cy="12" r="3"/></svg>','Atur')}
      </nav>
    </div>`;
}
function navItem(route, icon, label) {
  return `<button class="botnav-item" data-route="${route}">${icon}<span>${label}</span></button>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────────────────────
function renderLogin() {
  return `
    <div id="global-loader"></div>
    <div id="toast"></div>
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-title">⚖️ E-Pelanggaran</div>
        <p class="login-sub">Sistem Pencatatan Pelanggaran Siswa</p>
        <div class="form-group">
          <label class="form-label">Email</label>
          <input id="inp-email" type="email" class="form-control" placeholder="admin@sekolah.id" autocomplete="email">
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <input id="inp-pass" type="password" class="form-control" placeholder="••••••••" autocomplete="current-password">
        </div>
        <button id="btn-login" class="btn btn-primary btn-block" style="margin-top:.5rem">Masuk</button>
        <p style="color:var(--text3);font-size:.75rem;margin-top:1rem;text-align:center">
          Buat akun admin di Appwrite Console terlebih dahulu
        </p>
      </div>
    </div>`;
}
function bindLogin() {
  const go = () => doLogin(
    document.getElementById('inp-email').value.trim(),
    document.getElementById('inp-pass').value
  );
  document.getElementById('btn-login').onclick = go;
  document.getElementById('inp-email').addEventListener('keydown', e => e.key === 'Enter' && document.getElementById('inp-pass').focus());
  document.getElementById('inp-pass').addEventListener('keydown', e => e.key === 'Enter' && go());
  document.getElementById('global-loader').style.opacity = state.loading ? '1' : '0';
  // Re-trigger toast if any
  if (state.toast) setTimeout(() => showToast(state.toast.msg, state.toast.type), 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD — Data Pelanggaran
// ─────────────────────────────────────────────────────────────────────────────
function renderDashboard() {
  const filtered = getFilteredPelanggaran();
  const totalPoin = filtered.reduce((s, p) => s + (p.poin || 0), 0);

  return `
    <div class="page-actions">
      <h1 class="page-title" style="margin:0">📋 Pelanggaran</h1>
      <div style="display:flex;gap:.5rem;align-items:center">
        <span style="color:var(--text3);font-size:.8rem">${filtered.length} data</span>
        <button id="btn-print" class="btn btn-outline btn-sm">🖨️ Cetak</button>
      </div>
    </div>

    <!-- Stats -->
    <div class="row-3" style="margin-bottom:1rem">
      <div class="card" style="margin:0;text-align:center">
        <div style="font-size:1.6rem;font-family:'DM Serif Display',serif;color:var(--accent)">${filtered.length}</div>
        <div style="font-size:.72rem;color:var(--text3);font-weight:600;letter-spacing:.04em">PELANGGARAN</div>
      </div>
      <div class="card" style="margin:0;text-align:center">
        <div style="font-size:1.6rem;font-family:'DM Serif Display',serif;color:var(--danger)">${totalPoin}</div>
        <div style="font-size:.72rem;color:var(--text3);font-weight:600;letter-spacing:.04em">TOTAL POIN</div>
      </div>
      <div class="card" style="margin:0;text-align:center">
        <div style="font-size:1.6rem;font-family:'DM Serif Display',serif;color:var(--info)">${state.siswa.length}</div>
        <div style="font-size:.72rem;color:var(--text3);font-weight:600;letter-spacing:.04em">SISWA</div>
      </div>
    </div>

    <!-- Filter -->
    <div class="filter-wrap">
      <div class="card-header" style="margin-bottom:.6rem">🔍 Filter</div>
      <div class="filter-grid">
        <div>
          <div class="form-label">Tanggal</div>
          <input type="date" id="f-tgl" class="form-control" value="${state.filter.tgl}">
        </div>
        <div>
          <div class="form-label">Bulan</div>
          <select id="f-bulan" class="form-control">
            <option value="">Semua</option>
            ${BULAN.slice(1).map((b,i) => `<option value="${i+1}" ${state.filter.bulan==i+1?'selected':''}>${b}</option>`).join('')}
          </select>
        </div>
        <div>
          <div class="form-label">Tahun</div>
          <input type="number" id="f-tahun" class="form-control" placeholder="${new Date().getFullYear()}" value="${state.filter.tahun}">
        </div>
        <div>
          <div class="form-label">Nama Siswa</div>
          <input type="text" id="f-nama" class="form-control" placeholder="Cari nama..." value="${state.filter.nama}">
        </div>
        <div>
          <div class="form-label">Pelanggaran</div>
          <input type="text" id="f-catatan" class="form-control" placeholder="Cari catatan..." value="${state.filter.catatan}">
        </div>
      </div>
      <div class="filter-actions">
        <button id="btn-reset-filter" class="btn btn-ghost btn-sm">Reset</button>
        <button id="btn-apply-filter" class="btn btn-primary btn-sm">Terapkan</button>
      </div>
    </div>

    <!-- List -->
    <div id="plist">
      ${filtered.length === 0
        ? `<div class="empty"><div class="empty-icon">📭</div><div>Belum ada data pelanggaran</div></div>`
        : filtered.map(p => renderPCard(p)).join('')
      }
    </div>
  `;
}

function renderPCard(p) {
  const siswa = getSiswaById(p.id_siswa);
  const kelas = getKelasName(siswa.id_kelas);
  return `
    <div class="pcard">
      <div class="pcard-header">
        <div>
          <div class="pcard-name">${siswa.nama_siswa || 'Siswa Tidak Ditemukan'}</div>
          <div class="pcard-meta">📅 ${fmtTgl(p.tanggal)} &nbsp;·&nbsp; <span class="badge badge-info">${kelas}</span></div>
        </div>
        <span class="badge badge-danger">-${p.poin || 0} poin</span>
      </div>
      <div class="pcard-catatan">${p.catatan}</div>
      <div class="pcard-footer">
        <span style="color:var(--text3);font-size:.78rem">${p.tindakan ? '🔖 ' + p.tindakan : ''}</span>
        <button class="btn btn-ghost btn-sm btn-hapus-p" data-id="${p.$id}" style="color:var(--danger)">Hapus</button>
      </div>
    </div>`;
}

function bindDashboard() {
  document.getElementById('btn-logout').onclick = doLogout;
  document.getElementById('btn-print').onclick = () => window.print();
  document.getElementById('btn-apply-filter').onclick = () => {
    state.filter = {
      tgl:     document.getElementById('f-tgl').value,
      bulan:   document.getElementById('f-bulan').value,
      tahun:   document.getElementById('f-tahun').value,
      nama:    document.getElementById('f-nama').value,
      catatan: document.getElementById('f-catatan').value,
    };
    document.getElementById('plist').innerHTML = (() => {
      const filtered = getFilteredPelanggaran();
      return filtered.length === 0
        ? `<div class="empty"><div class="empty-icon">📭</div><div>Tidak ada data sesuai filter</div></div>`
        : filtered.map(p => renderPCard(p)).join('');
    })();
    bindHapusPButtons();
  };
  document.getElementById('btn-reset-filter').onclick = () => {
    state.filter = { tgl:'', bulan:'', tahun:'', nama:'', catatan:'' };
    render();
  };
  bindHapusPButtons();
}
function bindHapusPButtons() {
  document.querySelectorAll('.btn-hapus-p').forEach(b => {
    b.onclick = () => hapusPelanggaran(b.dataset.id);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// INPUT PELANGGARAN
// ─────────────────────────────────────────────────────────────────────────────
function renderInput() {
  const today = new Date().toISOString().slice(0, 10);
  return `
    <h1 class="page-title">✍️ Input Pelanggaran</h1>
    <div class="card">
      <div class="form-group">
        <label class="form-label">Cari Nama Siswa</label>
        <input type="text" id="search-siswa" class="form-control" placeholder="Ketik nama atau NIS...">
        <div id="siswa-dropdown" style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;max-height:180px;overflow-y:auto;display:none;margin-top:4px;"></div>
        <input type="hidden" id="sel-siswa-id">
        <div id="sel-siswa-display" style="margin-top:.4rem;font-size:.82rem;color:var(--accent);display:none;"></div>
      </div>
      <div class="form-group">
        <label class="form-label">Tanggal Kejadian</label>
        <input type="date" id="inp-tgl" class="form-control" value="${today}">
      </div>
      <div class="form-group">
        <label class="form-label">Detail Pelanggaran</label>
        <textarea id="inp-catatan" class="form-control" rows="3" placeholder="Contoh: Tidak memakai atribut lengkap saat upacara"></textarea>
      </div>
      <div class="row-2">
        <div class="form-group">
          <label class="form-label">Poin Pelanggaran</label>
          <input type="number" id="inp-poin" class="form-control" value="5" min="0" max="100">
        </div>
        <div class="form-group">
          <label class="form-label">Tindakan / Sanksi</label>
          <input type="text" id="inp-tindakan" class="form-control" placeholder="Contoh: Pembinaan wali kelas">
        </div>
      </div>
      <button id="btn-simpan-p" class="btn btn-primary btn-block" style="margin-top:.5rem">Simpan Pelanggaran</button>
      <button id="btn-batal-p" class="btn btn-ghost btn-block" style="margin-top:.4rem">Batal</button>
    </div>`;
}

function bindInput() {
  document.getElementById('btn-logout').onclick = doLogout;
  const searchEl = document.getElementById('search-siswa');
  const dropdown = document.getElementById('siswa-dropdown');
  const selId    = document.getElementById('sel-siswa-id');
  const selDisp  = document.getElementById('sel-siswa-display');

  searchEl.oninput = () => {
    const q = searchEl.value.toLowerCase();
    if (!q) { dropdown.style.display = 'none'; return; }
    const matches = state.siswa.filter(s =>
      s.nama_siswa.toLowerCase().includes(q) || (s.nis || '').includes(q)
    ).slice(0, 10);
    if (!matches.length) { dropdown.style.display = 'none'; return; }
    dropdown.style.display = 'block';
    dropdown.innerHTML = matches.map(s =>
      `<div class="dropdown-item" data-id="${s.$id}" data-nama="${s.nama_siswa}" style="padding:.55rem .75rem;cursor:pointer;transition:background .1s">
        <span style="font-weight:600">${s.nama_siswa}</span>
        <span style="color:var(--text3);font-size:.78rem;margin-left:.5rem">${getKelasName(s.id_kelas)} · ${s.nis}</span>
      </div>`
    ).join('');
    dropdown.querySelectorAll('.dropdown-item').forEach(el => {
      el.onmouseenter = () => el.style.background = 'var(--surface)';
      el.onmouseleave = () => el.style.background = '';
      el.onclick = () => {
        selId.value = el.dataset.id;
        searchEl.value = el.dataset.nama;
        selDisp.textContent = '✓ ' + el.dataset.nama;
        selDisp.style.display = 'block';
        dropdown.style.display = 'none';
      };
    });
  };

  document.getElementById('btn-simpan-p').onclick = () => {
    const id_siswa = selId.value;
    const tanggal  = document.getElementById('inp-tgl').value;
    const catatan  = document.getElementById('inp-catatan').value.trim();
    const poin     = parseInt(document.getElementById('inp-poin').value) || 0;
    const tindakan = document.getElementById('inp-tindakan').value.trim();
    if (!id_siswa) { showToast('Pilih siswa terlebih dahulu', 'danger'); return; }
    if (!catatan)  { showToast('Isi detail pelanggaran', 'danger'); return; }
    simpanPelanggaran({ id_siswa, tanggal, catatan, poin, tindakan });
  };
  document.getElementById('btn-batal-p').onclick = () => navigate('dashboard');
}

// ─────────────────────────────────────────────────────────────────────────────
// MASTER KELAS
// ─────────────────────────────────────────────────────────────────────────────
function renderKelas() {
  return `
    <h1 class="page-title">🏫 Master Kelas</h1>
    <div class="card">
      <div class="card-header">Tambah Kelas Baru</div>
      <div style="display:flex;gap:.65rem;align-items:center">
        <input type="text" id="inp-kelas" class="form-control" placeholder="Contoh: XII RPL 1" style="flex:1">
        <button type="button" id="btn-add-kelas" class="btn btn-primary">Simpan</button>
      </div>
    </div>
    <div class="card" style="padding:0">
      <div class="tbl-wrap">
        <table id="tbl-kelas">
          <thead><tr><th>Nama Kelas</th><th style="width:80px;text-align:center">Aksi</th></tr></thead>
          <tbody>
            ${state.kelas.length === 0
              ? `<tr><td colspan="2" style="text-align:center;padding:2rem;color:var(--text3)">Belum ada kelas</td></tr>`
              : state.kelas.map(k => `
                <tr>
                  <td><span class="badge badge-info">${k.nama_kelas}</span></td>
                  <td style="text-align:center">
                    <button type="button" class="btn btn-ghost btn-sm btn-del-kelas" data-id="${k.$id}" style="color:var(--danger)">Hapus</button>
                  </td>
                </tr>`).join('')
            }
          </tbody>
        </table>
      </div>
    </div>`;
}
function bindKelas() {
  document.getElementById('btn-logout').onclick = doLogout;
  const inp = document.getElementById('inp-kelas');

  function refreshKelasTable() {
    const tbody = document.querySelector('#tbl-kelas tbody');
    if (!tbody) return;
    tbody.innerHTML = state.kelas.length === 0
      ? `<tr><td colspan="2" style="text-align:center;padding:2rem;color:var(--text3)">Belum ada kelas</td></tr>`
      : state.kelas.map(k => `
          <tr>
            <td><span class="badge badge-info">${k.nama_kelas}</span></td>
            <td style="text-align:center">
              <button type="button" class="btn btn-ghost btn-sm btn-del-kelas" data-id="${k.$id}" style="color:var(--danger)">Hapus</button>
            </td>
          </tr>`).join('');
    bindHapusKelasButtons();
  }

  function bindHapusKelasButtons() {
    document.querySelectorAll('.btn-del-kelas').forEach(b => {
      b.onclick = () => { hapusKelas(b.dataset.id); refreshKelasTable(); };
    });
  }

  const add = async () => {
    const v = inp.value.trim();
    if (!v) { showToast('Nama kelas wajib diisi', 'danger'); return; }
    inp.value = '';
    await simpanKelas(v);
    refreshKelasTable();
  };

  document.getElementById('btn-add-kelas').onclick = add;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  bindHapusKelasButtons();
}

// ─────────────────────────────────────────────────────────────────────────────
// MASTER SISWA
// ─────────────────────────────────────────────────────────────────────────────
function renderSiswaRows(filterKelas) {
  const list = filterKelas
    ? state.siswa.filter(s => s.id_kelas === filterKelas)
    : state.siswa;
  if (list.length === 0)
    return `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text3)">Belum ada data siswa</td></tr>`;
  return list.map(s => `
    <tr>
      <td><code style="font-size:.8rem;color:var(--text3)">${s.nis}</code></td>
      <td style="font-weight:600">${s.nama_siswa}</td>
      <td><span class="badge badge-info">${getKelasName(s.id_kelas)}</span></td>
      <td><span class="badge ${s.jenis_kelamin==='L'?'badge-info':'badge-accent'}">${s.jenis_kelamin==='L'?'L':'P'}</span></td>
      <td style="text-align:center">
        <button class="btn btn-ghost btn-sm btn-del-siswa" data-id="${s.$id}" style="color:var(--danger)">Hapus</button>
      </td>
    </tr>`).join('');
}

function renderSiswa() {
  return `
    <h1 class="page-title">👨‍🎓 Master Siswa</h1>
    <div class="card">
      <div class="card-header">Tambah Siswa Baru</div>
      <div class="row-2">
        <div class="form-group">
          <label class="form-label">NIS</label>
          <input type="text" id="inp-nis" class="form-control" placeholder="Nomor Induk Siswa">
        </div>
        <div class="form-group">
          <label class="form-label">Nama Lengkap</label>
          <input type="text" id="inp-nama-siswa" class="form-control" placeholder="Nama lengkap siswa">
        </div>
      </div>
      <div class="row-2">
        <div class="form-group">
          <label class="form-label">Kelas</label>
          <select id="inp-kelas-siswa" class="form-control">
            <option value="">-- Pilih Kelas --</option>
            ${state.kelas.map(k => `<option value="${k.$id}">${k.nama_kelas}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Jenis Kelamin</label>
          <select id="inp-jk" class="form-control">
            <option value="L">Laki-laki</option>
            <option value="P">Perempuan</option>
          </select>
        </div>
      </div>
      <button id="btn-add-siswa" class="btn btn-primary btn-block">Simpan Siswa</button>
    </div>

    <!-- Filter kelas -->
    <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.75rem;flex-wrap:wrap">
      <span style="font-size:.78rem;font-weight:600;color:var(--text2);letter-spacing:.04em;text-transform:uppercase">Filter Kelas:</span>
      <button type="button" class="btn-kelas-filter btn btn-sm ${!state.filterSiswaKelas?'btn-primary':'btn-outline'}" data-kelas="">Semua</button>
      ${state.kelas.map(k => `
        <button type="button" class="btn-kelas-filter btn btn-sm ${state.filterSiswaKelas===k.$id?'btn-primary':'btn-outline'}" data-kelas="${k.$id}">${k.nama_kelas}</button>
      `).join('')}
    </div>

    <div class="card" style="padding:0">
      <div class="tbl-wrap">
        <table id="tbl-siswa">
          <thead>
            <tr><th>NIS</th><th>Nama</th><th>Kelas</th><th>JK</th><th style="width:70px;text-align:center">Aksi</th></tr>
          </thead>
          <tbody>${renderSiswaRows(state.filterSiswaKelas)}</tbody>
        </table>
      </div>
    </div>`;
}
function bindSiswa() {
  document.getElementById('btn-logout').onclick = doLogout;

  function refreshSiswaTabel() {
    const tbody = document.querySelector('#tbl-siswa tbody');
    if (tbody) {
      tbody.innerHTML = renderSiswaRows(state.filterSiswaKelas);
      bindHapusSiswaButtons();
    }
  }
  function bindHapusSiswaButtons() {
    document.querySelectorAll('.btn-del-siswa').forEach(b => {
      b.onclick = () => hapusSiswa(b.dataset.id).then(() => refreshSiswaTabel());
    });
  }

  // Filter kelas pill buttons — update tanpa re-render halaman
  document.querySelectorAll('.btn-kelas-filter').forEach(b => {
    b.onclick = () => {
      state.filterSiswaKelas = b.dataset.kelas;
      // Update style pill aktif
      document.querySelectorAll('.btn-kelas-filter').forEach(x => {
        x.classList.toggle('btn-primary', x.dataset.kelas === state.filterSiswaKelas);
        x.classList.toggle('btn-outline',  x.dataset.kelas !== state.filterSiswaKelas);
      });
      refreshSiswaTabel();
    };
  });

  document.getElementById('btn-add-siswa').onclick = () => {
    const nis = document.getElementById('inp-nis').value.trim();
    const nama = document.getElementById('inp-nama-siswa').value.trim();
    const id_kelas = document.getElementById('inp-kelas-siswa').value;
    const jenis_kelamin = document.getElementById('inp-jk').value;
    if (!nis || !nama || !id_kelas) { showToast('Lengkapi semua data', 'danger'); return; }
    simpanSiswa({ nis, nama_siswa: nama, id_kelas, jenis_kelamin });
    document.getElementById('inp-nis').value = '';
    document.getElementById('inp-nama-siswa').value = '';
    // Refresh tabel setelah tambah (simpanSiswa update state.siswa)
    setTimeout(refreshSiswaTabel, 50);
  };

  bindHapusSiswaButtons();
}

// ─────────────────────────────────────────────────────────────────────────────
// PENGATURAN
// ─────────────────────────────────────────────────────────────────────────────
function renderPengaturan() {
  const p = state.pengaturan;
  return `
    <h1 class="page-title">⚙️ Pengaturan</h1>
    <div class="card">
      <div class="card-header">Profil Sekolah</div>
      <div class="form-group">
        <label class="form-label">Nama Sekolah</label>
        <input type="text" id="inp-nama-sekolah" class="form-control" value="${p.nama_sekolah || ''}" placeholder="Nama sekolah">
      </div>
      <div class="form-group">
        <label class="form-label">Alamat Sekolah</label>
        <textarea id="inp-alamat" class="form-control" rows="2" placeholder="Alamat lengkap sekolah">${p.alamat_sekolah || ''}</textarea>
      </div>
      <button id="btn-save-profil" class="btn btn-primary btn-block">Simpan Perubahan</button>
    </div>

    <!-- SYNC PANEL -->
    <div class="card">
      <div class="card-header">🔄 Sinkronisasi Delta</div>

      <!-- Antrian offline -->
      <div style="margin-bottom:.85rem">
        <div style="font-size:.75rem;font-weight:600;color:var(--text2);letter-spacing:.05em;text-transform:uppercase;margin-bottom:.35rem">Antrian Offline</div>
        <div id="sync-queue-count"><span class="badge badge-info">Memuat…</span></div>
      </div>

      <!-- Status label -->
      <div id="sync-status-label" style="font-size:.85rem;margin-bottom:.85rem;font-weight:600">
        ⏳ Memuat status…
      </div>

      <!-- Progress bar -->
      <div style="background:var(--surface2);border-radius:99px;height:8px;overflow:hidden;margin-bottom:.5rem">
        <div id="sync-progress-bar" style="height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:99px;width:0%;transition:width .8s ease"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:.75rem;color:var(--text3);margin-bottom:1rem">
        <span id="sync-progress-pct">0%</span>
        <span>Sync berikutnya: <strong id="sync-next-in" style="color:var(--text2)">—</strong></span>
      </div>

      <!-- Tombol manual -->
      <button type="button" id="btn-sync-now" class="btn btn-outline btn-sm" style="margin-bottom:1rem">
        ⚡ Sync Sekarang
      </button>

      <!-- Log tabel -->
      <div style="font-size:.72rem;font-weight:600;color:var(--text3);letter-spacing:.04em;text-transform:uppercase;margin-bottom:.5rem">
        Riwayat Sync Terakhir
      </div>
      <div class="tbl-wrap" style="margin:0">
        <table style="font-size:.82rem">
          <thead>
            <tr>
              <th>Tabel</th>
              <th style="text-align:center;width:110px">Dokumen</th>
              <th style="width:140px">Waktu</th>
            </tr>
          </thead>
          <tbody id="sync-log-table">
            <tr><td colspan="3" style="text-align:center;color:var(--text3);padding:1rem">Belum ada riwayat sync</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">Informasi Akun</div>
      <p style="color:var(--text2);font-size:.85rem;margin-bottom:.75rem">
        Manajemen akun admin dilakukan melalui Appwrite Console.<br>
        Email: <strong style="color:var(--text)">${state.user?.email || '-'}</strong>
      </p>
      <button id="btn-logout2" class="btn btn-danger btn-block">Keluar dari Akun</button>
    </div>
    <div class="card" style="padding:1rem">
      <div style="font-size:.75rem;color:var(--text3);text-align:center">
        E-Pelanggaran ${APP_VERSION} · PWA · Offline-First<br>
        Stack: Vite + Vanilla JS + Appwrite + IDB
      </div>
    </div>`;
}
function bindPengaturan() {
  document.getElementById('btn-logout').onclick = doLogout;
  document.getElementById('btn-logout2').onclick = doLogout;
  document.getElementById('btn-save-profil').onclick = () => {
    const nama_sekolah    = document.getElementById('inp-nama-sekolah').value.trim();
    const alamat_sekolah  = document.getElementById('inp-alamat').value.trim();
    if (!nama_sekolah) { showToast('Nama sekolah wajib diisi', 'danger'); return; }
    simpanPengaturan({ nama_sekolah, alamat_sekolah });
  };
  document.getElementById('btn-sync-now').onclick = async () => {
    if (!isOnline) { showToast('Tidak dapat sync — sedang offline', 'warn'); return; }
    const btn = document.getElementById('btn-sync-now');
    btn.disabled = true;
    btn.textContent = '⏳ Sync…';
    await drainSyncQueue();
    await runDeltaSync();
    _startCountdown();
    btn.disabled = false;
    btn.textContent = '⚡ Sync Sekarang';
    showToast('Sync selesai', 'success');
  };
  // Load queue count & render panel saat halaman dibuka
  _refreshQueueCount().then(() => _refreshSyncPanel());
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────
injectCSS();
checkSession();
