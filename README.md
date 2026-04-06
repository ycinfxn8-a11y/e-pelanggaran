# E-Pelanggaran Siswa — PWA

Aplikasi pencatatan pelanggaran siswa, dikonversi dari PHP/MySQL ke:

**Vite + Vanilla JS (single `src/main.js`) + Appwrite + IDB (offline-first)**

---

## Stack

| Layer     | Teknologi |
|-----------|-----------|
| Frontend  | Vite + Vanilla JS (satu file `src/main.js`) |
| Database  | Appwrite (Cloud / Self-hosted) |
| Offline   | IndexedDB via `idb`, Sync Queue |
| PWA       | `vite-plugin-pwa` + Workbox |

---

## Fitur

- ✅ Login admin via Appwrite Auth (email/password)
- ✅ Data Pelanggaran — list dengan filter tanggal/bulan/tahun/nama/catatan
- ✅ Input Pelanggaran — pencarian siswa dengan autocomplete
- ✅ Master Kelas — CRUD
- ✅ Master Siswa — CRUD dengan kelas
- ✅ Pengaturan — nama & alamat sekolah
- ✅ **Offline-first** — semua data di-cache IDB, sync otomatis saat online
- ✅ Cetak laporan (Print CSS)
- ✅ Installable sebagai PWA

---

## Setup

### 1. Appwrite — Buat Project

1. Buka [cloud.appwrite.io](https://cloud.appwrite.io) atau self-hosted
2. Buat project baru, catat **Project ID**
3. Di **Auth > Settings**, aktifkan **Email/Password**
4. Buat user admin di **Auth > Users**

### 2. Inisialisasi Schema

```bash
# Install node-appwrite
npm install node-appwrite

# Set env
export APPWRITE_PROJECT=your_project_id
export APPWRITE_API_KEY=your_server_api_key

# Jalankan init
node init.js
```

Setelah selesai, buat dokumen pengaturan awal di Appwrite Console:
- Collection: `pengaturan`, Document ID: `main`
- Field: `nama_sekolah`, `alamat_sekolah`

### 3. Konfigurasi Aplikasi

Edit `src/main.js`, baris konfigurasi:

```js
const APPWRITE_ENDPOINT = 'https://cloud.appwrite.io/v1';
const APPWRITE_PROJECT  = 'GANTI_PROJECT_ID';  // ← ganti ini
```

### 4. Tambahkan Platform Web

Di Appwrite Console > **Settings > Platforms**, tambahkan:
- **Web** platform dengan hostname `localhost` (dev) dan domain production Anda

### 5. Jalankan

```bash
npm install
npm run dev      # development
npm run build    # production build
npm run preview  # preview build
```

---

## Struktur File

```
siswapro-pwa/
├── src/
│   └── main.js          ← SELURUH logika aplikasi (satu file)
├── index.html
├── vite.config.js
├── init.js              ← Setup schema Appwrite (jalankan sekali)
├── package.json
└── README.md
```

---

## Appwrite Schema

```
Database: siswapro
├── m_kelas
│   └── nama_kelas (string, required)
├── m_siswa
│   ├── id_kelas (string → $id dari m_kelas)
│   ├── nis (string, unique)
│   ├── nama_siswa (string)
│   └── jenis_kelamin (enum: L/P)
├── t_pelanggaran
│   ├── id_siswa (string → $id dari m_siswa)
│   ├── tanggal (datetime)
│   ├── catatan (string)
│   ├── poin (integer, default: 0)
│   └── tindakan (string)
└── pengaturan
    ├── nama_sekolah (string)
    └── alamat_sekolah (string)
```

---

## Offline Behavior

| Kondisi | Perilaku |
|---------|----------|
| Online  | Fetch dari Appwrite → cache ke IDB |
| Offline | Baca dari IDB cache |
| Mutasi offline | Masuk **Sync Queue** di IDB |
| Kembali online | Sync Queue di-drain otomatis |

---

## Perbedaan dari Versi PHP Asli

| PHP/MySQL | PWA Baru |
|-----------|----------|
| Session PHP | Appwrite Auth (JWT) |
| MySQL | Appwrite Database |
| Multi-file PHP | Single `src/main.js` |
| Tidak offline | Offline-first (IDB) |
| Tidak installable | Installable PWA |
| Plain HTML | Dark theme, mobile-first |
