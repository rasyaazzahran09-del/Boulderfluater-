# 🤖 Flutter Build Bot v3.0 — Multi-Repo Pool

Telegram bot yang mengkonversi project Flutter (ZIP) menjadi APK melalui GitHub Actions.

## ✨ Fitur Baru v3.0

### 🔄 Multi-Repo Pool
- **Otomatis pindah ke repo kosong** — Jika ada build di repo 1, build selanjutnya otomatis dipindahkan ke repo yang kosong
- **Auto-create repo** — Bot otomatis membuat repo baru di GitHub jika belum ada
- **Auto-push workflow** — Workflow `build_apk.yml` otomatis di-push ke semua repo saat startup
- **Status pool real-time** — Lihat status setiap repo (sibuk/kosong) via dashboard/Telegram
- **Force-release** — Jika semua repo sibuk, repo yang paling lama building akan dibebaskan

### 🔧 Fix Error 404 Log
- **Retry otomatis** — Jika log belum ready (404), bot akan retry hingga 3x dengan delay
- **Fallback ke job-level log** — Jika run-level log tidak tersedia, bot ambil log dari individual jobs
- **Pesan error yang jelas** — Tidak lagi muncul "Request failed with status code 404"

## 📋 Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Konfigurasi `.env`
Salin `.env.example` menjadi `.env` dan isi semua nilai:
```bash
cp .env.example .env
nano .env
```

### 3. Multi-Repo Pool
Isi `GITHUB_REPOS` dengan daftar repo yang ingin dipakai:
```env
GITHUB_REPOS=Boulderfluater-,Boulderfluater-2,Boulderfluater-3
AUTO_CREATE_REPOS=true
```

Bot akan otomatis:
- Membuat repo yang belum ada (jika `AUTO_CREATE_REPOS=true`)
- Push workflow ke semua repo
- Mendistribusikan build ke repo yang kosong

### 4. Jalankan bot
```bash
node index.js
```

## 📊 Dashboard & Status

- **Telegram**: Gunakan `/dashboard` atau tombol Status Build
- **Web Panel**: Akses `http://server:10882` untuk web interface
- **API Pool**: `GET /api/pool` untuk status repo pool

## 🏗️ Arsitektur Multi-Repo

```
User kirim ZIP
      │
      ▼
┌─────────────┐
│  Repo Pool   │──▶ Cari repo kosong
└─────────────┘
      │
      ├── Repo 1 (🔴 sibuk) → skip
      ├── Repo 2 (🟢 kosong) → ✅ pakai ini!
      └── Repo 3 (🟢 kosong) → cadangan
      │
      ▼
   Upload ZIP ke Repo 2
      │
      ▼
   Trigger workflow di Repo 2
      │
      ▼
   Poll status build
      │
      ▼
   Download APK → Kirim ke user
      │
      ▼
   Release Repo 2 (🟢 kosong lagi)
```

## 📁 Struktur File

| File | Deskripsi |
|------|-----------|
| `index.js` | Bot Telegram utama + logika build |
| `repo_pool.js` | Multi-repo pool manager |
| `web_panel.js` | Web panel Express.js |
| `local_bot_api.js` | Local Telegram Bot API runner |
| `.env.example` | Template konfigurasi |
| `.github/workflows/build_apk.yml` | GitHub Actions workflow |
