/**
 * init.js — Inisialisasi Schema Appwrite untuk E-Pelanggaran
 *
 * Jalankan sekali:
 *   node init.js
 *
 * Env yang dibutuhkan:
 *   APPWRITE_ENDPOINT  (default: https://cloud.appwrite.io/v1)
 *   APPWRITE_PROJECT   (Project ID dari Console)
 *   APPWRITE_API_KEY   (Server Key dari Console > Settings > API Keys)
 */

import { Client, Databases, Permission, Role } from 'node-appwrite';

const ENDPOINT   = process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT  || 'GANTI_PROJECT_ID';
const API_KEY    = process.env.APPWRITE_API_KEY  || 'GANTI_API_KEY';
const DB_ID      = 'siswapro';

const client = new Client()
  .setEndpoint(ENDPOINT)
  .setProject(PROJECT_ID)
  .setKey(API_KEY);

const db = new Databases(client);

// Permission: hanya user yang sudah login (admin)
const perms = [
  Permission.read(Role.users()),
  Permission.create(Role.users()),
  Permission.update(Role.users()),
  Permission.delete(Role.users()),
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Tunggu ms milidetik — wajib antar createAttribute agar Appwrite tidak race */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * safeCreate — jalankan fn(), log hasil.
 * - Jika 409 (sudah ada): skip tanpa error
 * - Jika error lain: log dan lempar ulang agar caller bisa berhenti
 */
async function safeCreate(fn, label) {
  try {
    const r = await fn();
    console.log(`  ✅ ${label}`);
    return r;
  } catch (e) {
    if (e.code === 409) {
      console.log(`  ⚠️  ${label} — sudah ada, skip`);
      return null;
    }
    console.error(`  ❌ ${label} — ${e.message}`);
    throw e; // lempar agar proses berhenti & tidak buat index sebelum attr selesai
  }
}

/**
 * safeAttr — buat attribute, tunggu DELAY ms setelah sukses/skip.
 * Appwrite memproses attribute secara async di background; tanpa jeda,
 * createIndex atau attribute berikutnya bisa gagal karena attr belum AVAILABLE.
 */
const ATTR_DELAY = 800; // ms — sesuaikan jika Appwrite self-hosted lebih lambat
async function safeAttr(fn, label) {
  const r = await safeCreate(fn, label);
  await sleep(ATTR_DELAY);
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// KOLOM DELTA SYNC — ditambahkan ke semua koleksi kecuali pengaturan
// is_updated : datetime — di-set setiap kali dokumen dibuat/diupdate
// is_deleted : datetime — di-set saat soft-delete (dokumen tidak benar-benar dihapus)
// ─────────────────────────────────────────────────────────────────────────────
async function addDeltaCols(colId) {
  await safeAttr(
    () => db.createDatetimeAttribute(DB_ID, colId, 'is_updated', false),
    `Attr: ${colId}.is_updated`
  );
  await safeAttr(
    () => db.createDatetimeAttribute(DB_ID, colId, 'is_deleted', false),
    `Attr: ${colId}.is_deleted`
  );
  // Index untuk delta pull: ambil semua yang berubah sejak lastSyncAt
  await safeCreate(
    () => db.createIndex(DB_ID, colId, 'idx_is_updated', 'key', ['is_updated'], ['ASC']),
    `Index: ${colId}.is_updated`
  );
  await safeCreate(
    () => db.createIndex(DB_ID, colId, 'idx_is_deleted', 'key', ['is_deleted'], ['ASC']),
    `Index: ${colId}.is_deleted`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀 Inisialisasi Schema E-Pelanggaran\n');

  // ── DATABASE ────────────────────────────────────────────────────────────────
  console.log('📦 Database');
  await safeCreate(
    () => db.create(DB_ID, 'E-Pelanggaran Siswa'),
    `Database: ${DB_ID}`
  );

  // ── m_kelas ─────────────────────────────────────────────────────────────────
  console.log('\n📂 Collection: m_kelas');
  await safeCreate(
    () => db.createCollection(DB_ID, 'm_kelas', 'Master Kelas', perms),
    'Collection: m_kelas'
  );
  await safeAttr(
    () => db.createStringAttribute(DB_ID, 'm_kelas', 'nama_kelas', 50, true),
    'Attr: m_kelas.nama_kelas'
  );
  await addDeltaCols('m_kelas');

  // ── m_siswa ─────────────────────────────────────────────────────────────────
  console.log('\n📂 Collection: m_siswa');
  await safeCreate(
    () => db.createCollection(DB_ID, 'm_siswa', 'Master Siswa', perms),
    'Collection: m_siswa'
  );
  await safeAttr(
    () => db.createStringAttribute(DB_ID, 'm_siswa', 'id_kelas', 36, true),
    'Attr: m_siswa.id_kelas'
  );
  await safeAttr(
    () => db.createStringAttribute(DB_ID, 'm_siswa', 'nis', 20, true),
    'Attr: m_siswa.nis'
  );
  await safeAttr(
    () => db.createStringAttribute(DB_ID, 'm_siswa', 'nama_siswa', 100, true),
    'Attr: m_siswa.nama_siswa'
  );
  await safeAttr(
    () => db.createEnumAttribute(DB_ID, 'm_siswa', 'jenis_kelamin', ['L', 'P'], false),
    'Attr: m_siswa.jenis_kelamin'
  );
  await addDeltaCols('m_siswa');
  await safeCreate(
    () => db.createIndex(DB_ID, 'm_siswa', 'nis_unique', 'unique', ['nis']),
    'Index: m_siswa.nis (unique)'
  );
  await safeCreate(
    () => db.createIndex(DB_ID, 'm_siswa', 'idx_kelas', 'key', ['id_kelas']),
    'Index: m_siswa.id_kelas'
  );

  // ── t_pelanggaran ────────────────────────────────────────────────────────────
  console.log('\n📂 Collection: t_pelanggaran');
  await safeCreate(
    () => db.createCollection(DB_ID, 't_pelanggaran', 'Transaksi Pelanggaran', perms),
    'Collection: t_pelanggaran'
  );
  await safeAttr(
    () => db.createStringAttribute(DB_ID, 't_pelanggaran', 'id_siswa', 36, true),
    'Attr: t_pelanggaran.id_siswa'
  );
  await safeAttr(
    () => db.createDatetimeAttribute(DB_ID, 't_pelanggaran', 'tanggal', true),
    'Attr: t_pelanggaran.tanggal'
  );
  await safeAttr(
    () => db.createStringAttribute(DB_ID, 't_pelanggaran', 'catatan', 1000, true),
    'Attr: t_pelanggaran.catatan'
  );
  // FIX: createIntegerAttribute — signature: (databaseId, collectionId, key, required, min, max, default)
  // Urutan min/max/default wajib benar agar tidak gagal validasi
  await safeAttr(
    () => db.createIntegerAttribute(DB_ID, 't_pelanggaran', 'poin', false, 0, 999, 0),
    'Attr: t_pelanggaran.poin'
  );
  await safeAttr(
    () => db.createStringAttribute(DB_ID, 't_pelanggaran', 'tindakan', 255, false),
    'Attr: t_pelanggaran.tindakan'
  );
  await addDeltaCols('t_pelanggaran');
  await safeCreate(
    () => db.createIndex(DB_ID, 't_pelanggaran', 'idx_tanggal', 'key', ['tanggal'], ['DESC']),
    'Index: t_pelanggaran.tanggal'
  );
  await safeCreate(
    () => db.createIndex(DB_ID, 't_pelanggaran', 'idx_siswa', 'key', ['id_siswa']),
    'Index: t_pelanggaran.id_siswa'
  );

  // ── pengaturan ───────────────────────────────────────────────────────────────
  console.log('\n📂 Collection: pengaturan');
  await safeCreate(
    () => db.createCollection(DB_ID, 'pengaturan', 'Pengaturan Aplikasi', perms),
    'Collection: pengaturan'
  );
  await safeAttr(
    () => db.createStringAttribute(DB_ID, 'pengaturan', 'nama_sekolah', 100, true),
    'Attr: pengaturan.nama_sekolah'
  );
  await safeAttr(
    () => db.createStringAttribute(DB_ID, 'pengaturan', 'alamat_sekolah', 500, false),
    'Attr: pengaturan.alamat_sekolah'
  );
  // pengaturan tidak perlu delta cols (single-doc, selalu full-fetch)

  // ── SELESAI ──────────────────────────────────────────────────────────────────
  console.log('\n✅ Schema selesai!\n');
  console.log('Langkah selanjutnya:');
  console.log('1. Buat dokumen pengaturan awal di Appwrite Console:');
  console.log(`   Collection: pengaturan  |  Document ID: main`);
  console.log(`   Field: nama_sekolah = "Nama Sekolah Anda"`);
  console.log('');
  console.log('2. Buat user admin:');
  console.log('   Appwrite Console > Auth > Users > Create User');
  console.log('');
  console.log('3. Tambahkan Web Platform:');
  console.log('   Console > Settings > Platforms > Add Platform > Web');
  console.log('   Hostname: localhost (dev) dan domain production Anda');
  console.log('');
}

main().catch(e => {
  console.error('\n💥 Init gagal:', e.message);
  process.exit(1);
});
