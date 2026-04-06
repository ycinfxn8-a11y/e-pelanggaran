/**
 * import_siswa.js — Import m_siswa.csv ke Appwrite
 *
 * Jalankan:
 *   node import_siswa.js ./m_siswa.csv
 *
 * Env yang dibutuhkan (sama dengan init.js):
 *   APPWRITE_ENDPOINT   (default: https://cloud.appwrite.io/v1)
 *   APPWRITE_PROJECT    Project ID
 *   APPWRITE_API_KEY    Server Key
 *   APPWRITE_DB_ID      (default: siswapro)
 *
 * Format CSV (delimiter ;, tanpa header):
 *   kolom 1 : nomor urut (diabaikan)
 *   kolom 2 : id lama (diabaikan)
 *   kolom 3 : kode kelas
 *              4 digit → 2 digit pertama = kode kelas  contoh: 7101 → kelas 7.1
 *              5 digit → 3 digit pertama = kode kelas  contoh: 71001 → kelas 7.10
 *   kolom 4 : nama siswa
 *   kolom 5 : jenis kelamin (L/P)
 *
 * Proses:
 *   1. Parse CSV → buat set kelas unik
 *   2. Buat / fetch dokumen m_kelas di Appwrite (idempotent)
 *   3. Import siswa satu per satu dengan rate-limit sederhana
 *   4. Log ringkasan di akhir
 */

import fs from 'fs';
import readline from 'readline';
import { Client, Databases, Query, ID } from 'node-appwrite';

// ─── Konfigurasi ─────────────────────────────────────────────────────────────
const ENDPOINT   = process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT  || 'GANTI_PROJECT_ID';
const API_KEY    = process.env.APPWRITE_API_KEY  || 'GANTI_API_KEY';
const DB_ID      = process.env.APPWRITE_DB_ID    || 'siswapro';
const COL_KELAS  = 'm_kelas';
const COL_SISWA  = 'm_siswa';

// Jeda antar request (ms) — naikkan jika kena rate-limit Appwrite Cloud
const DELAY_MS   = 120;

// ─── Appwrite client ─────────────────────────────────────────────────────────
const client = new Client()
  .setEndpoint(ENDPOINT)
  .setProject(PROJECT_ID)
  .setKey(API_KEY);
const db = new Databases(client);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Helper: parse kode kelas → nama kelas ───────────────────────────────────
function parseKelas(kode) {
  kode = kode.trim();
  let raw;
  if (kode.length === 4)      raw = kode.slice(0, 2); // "71" → "7.1"
  else if (kode.length === 5) raw = kode.slice(0, 3); // "710" → "7.10"
  else                        raw = kode;              // fallback
  return `${raw[0]}.${raw.slice(1)}`;                  // "7.1" / "7.10"
}

// ─── Parse CSV ────────────────────────────────────────────────────────────────
async function parseCSV(filePath) {
  const rows = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, 'utf-8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(';').map(p => p.trim());
    if (parts.length < 4) {
      console.warn(`  ⚠️  Baris dilewati (kolom kurang): ${line}`);
      continue;
    }
    const kodeKelas   = parts[2];
    const namaSiswa   = parts[3];
    const jenisKelamin = (parts[4] || 'L').toUpperCase() === 'P' ? 'P' : 'L';
    const namaKelas   = parseKelas(kodeKelas);
    rows.push({ kodeKelas, namaKelas, namaSiswa, jenisKelamin });
  }
  return rows;
}

// ─── Buat / fetch semua kelas di Appwrite ────────────────────────────────────
async function upsertKelas(namaKelasSet) {
  console.log(`\n📂 Sinkronisasi ${namaKelasSet.size} kelas ke Appwrite…`);

  // Fetch semua kelas yang sudah ada
  const existing = {};
  let offset = 0;
  while (true) {
    const res = await db.listDocuments(DB_ID, COL_KELAS, [Query.limit(100), Query.offset(offset)]);
    for (const doc of res.documents) existing[doc.nama_kelas] = doc.$id;
    if (res.documents.length < 100) break;
    offset += 100;
  }
  console.log(`  Ada ${Object.keys(existing).length} kelas di Appwrite`);

  const ts = new Date().toISOString();
  const kelasMap = { ...existing }; // namaKelas → $id

  for (const namaKelas of [...namaKelasSet].sort()) {
    if (kelasMap[namaKelas]) {
      console.log(`  ✅ ${namaKelas} — sudah ada (${kelasMap[namaKelas]})`);
      continue;
    }
    try {
      const docId = ID.unique();
      await db.createDocument(DB_ID, COL_KELAS, docId, {
        nama_kelas: namaKelas,
        is_updated: ts,
        is_deleted: null,
      });
      kelasMap[namaKelas] = docId;
      console.log(`  ✅ ${namaKelas} — dibuat (${docId})`);
      await sleep(DELAY_MS);
    } catch (e) {
      console.error(`  ❌ ${namaKelas} — gagal: ${e.message}`);
    }
  }

  return kelasMap; // namaKelas → $id
}

// ─── Fetch NIS siswa yang sudah ada (untuk skip duplikat) ────────────────────
async function fetchExistingNIS() {
  console.log('\n🔍 Mengambil daftar NIS yang sudah ada di Appwrite…');
  const existing = new Set();
  let offset = 0;
  while (true) {
    const res = await db.listDocuments(DB_ID, COL_SISWA, [
      Query.limit(100),
      Query.offset(offset),
      Query.select(['nis']),
    ]);
    for (const doc of res.documents) existing.add(doc.nis);
    if (res.documents.length < 100) break;
    offset += 100;
  }
  console.log(`  Ditemukan ${existing.size} NIS sudah ada`);
  return existing;
}

// ─── Import siswa ─────────────────────────────────────────────────────────────
async function importSiswa(rows, kelasMap, existingNIS) {
  console.log(`\n👨‍🎓 Mengimport ${rows.length} siswa…`);
  const ts = new Date().toISOString();

  let ok = 0, skip = 0, err = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const { namaKelas, namaSiswa, jenisKelamin, kodeKelas } = rows[i];
    const nis    = kodeKelas.trim(); // kode kelas dipakai sebagai NIS
    const idKelas = kelasMap[namaKelas];

    if (!idKelas) {
      console.warn(`  ⚠️  [${i+1}] ${namaSiswa} — kelas "${namaKelas}" tidak ditemukan di map, skip`);
      err++;
      errors.push({ row: i+1, nis, nama: namaSiswa, reason: `kelas ${namaKelas} tidak ada` });
      continue;
    }

    if (existingNIS.has(nis)) {
      skip++;
      if (skip <= 5 || skip % 50 === 0)
        process.stdout.write(`  ⏭️  [${i+1}] NIS ${nis} sudah ada, skip\n`);
      continue;
    }

    try {
      await db.createDocument(DB_ID, COL_SISWA, ID.unique(), {
        nis,
        nama_siswa:    namaSiswa,
        id_kelas:      idKelas,
        jenis_kelamin: jenisKelamin,
        is_updated:    ts,
        is_deleted:    null,
      });
      existingNIS.add(nis);
      ok++;
      if (ok <= 10 || ok % 100 === 0)
        process.stdout.write(`  ✅ [${i+1}] ${namaSiswa} (${namaKelas})\n`);
      await sleep(DELAY_MS);
    } catch (e) {
      err++;
      errors.push({ row: i+1, nis, nama: namaSiswa, reason: e.message });
      console.error(`  ❌ [${i+1}] ${namaSiswa} — ${e.message}`);
    }

    // Progress setiap 100 baris
    if ((i + 1) % 100 === 0) {
      console.log(`  … ${i+1}/${rows.length} diproses (✅${ok} ⏭️${skip} ❌${err})`);
    }
  }

  return { ok, skip, err, errors };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node import_siswa.js <path/ke/m_siswa.csv>');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File tidak ditemukan: ${filePath}`);
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════');
  console.log('  Import Siswa → Appwrite E-Pelanggaran');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Endpoint : ${ENDPOINT}`);
  console.log(`  Project  : ${PROJECT_ID}`);
  console.log(`  Database : ${DB_ID}`);
  console.log(`  File     : ${filePath}`);
  console.log('───────────────────────────────────────────────────');

  // 1. Parse CSV
  console.log('\n📄 Membaca CSV…');
  const rows = await parseCSV(filePath);
  console.log(`  ${rows.length} baris terbaca`);

  // 2. Kumpulkan kelas unik
  const namaKelasSet = new Set(rows.map(r => r.namaKelas));
  console.log(`  ${namaKelasSet.size} kelas unik: ${[...namaKelasSet].sort().join(', ')}`);

  // 3. Upsert kelas
  const kelasMap = await upsertKelas(namaKelasSet);

  // 4. Fetch NIS yang sudah ada
  const existingNIS = await fetchExistingNIS();

  // 5. Import siswa
  const { ok, skip, err, errors } = await importSiswa(rows, kelasMap, existingNIS);

  // 6. Ringkasan
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  SELESAI');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  ✅ Berhasil import : ${ok} siswa`);
  console.log(`  ⏭️  Dilewati (duplikat): ${skip} siswa`);
  console.log(`  ❌ Gagal           : ${err} siswa`);
  if (errors.length > 0) {
    console.log('\n  Detail error:');
    errors.forEach(e => console.log(`    Baris ${e.row}: NIS=${e.nis} | ${e.nama} | ${e.reason}`));
  }
  console.log('');
}

main().catch(e => {
  console.error('\n💥 Fatal:', e.message);
  process.exit(1);
});
