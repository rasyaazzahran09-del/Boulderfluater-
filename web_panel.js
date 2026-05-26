/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║     🌐 WEB PANEL - Flutter Build Bot                        ║
 * ║     Halaman utama: BUILD (upload ZIP → APK)                 ║
 * ║     + Admin: kelola web user                                ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Login dengan Telegram User ID + password yang dibuat admin lewat
 * perintah /addwebuser di Telegram. Setelah login, user langsung
 * masuk halaman Build, bukan dashboard.
 */

const express  = require("express");
const crypto   = require("crypto");
const fs       = require("fs");
const path     = require("path");
const bcrypt   = require("bcryptjs");
const multer   = require("multer");
require("dotenv").config();

const WEB_PANEL_PORT    = Number(process.env.WEB_PANEL_PORT || 3000);
const WEB_PANEL_SECRET  = process.env.WEB_PANEL_SECRET || crypto.randomBytes(32).toString("hex");
const WEB_USERS_FILE    = path.join(__dirname, "web_users.json");
const SESSION_TTL_MS    = 6 * 60 * 60 * 1000; // 6 jam
const MAX_UPLOAD_MB     = Number(process.env.MAX_ZIP_MB || 50);

// ─────────────────────────────────────────────
//  Storage web users: { userId: { hash, addedAt } }
// ─────────────────────────────────────────────
function loadWebUsers() {
  try {
    if (!fs.existsSync(WEB_USERS_FILE)) return {};
    return JSON.parse(fs.readFileSync(WEB_USERS_FILE, "utf8"));
  } catch { return {}; }
}

function saveWebUsers(data) {
  fs.writeFileSync(WEB_USERS_FILE, JSON.stringify(data, null, 2));
}

// Sessions in-memory: { token: { userId, expiresAt } }
const sessions = new Map();

// In-memory store untuk build yang dipicu dari web (buildId → { ownerUserId, fileName, flutterVersion, startedAt })
const webBuilds = new Map();

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  return s;
}

function getCookieToken(req) {
  const raw = req.headers.cookie || "";
  const match = raw.match(/(?:^|;\s*)wb_sess=([^;]+)/);
  return match ? match[1] : null;
}

// ─────────────────────────────────────────────
//  API untuk index.js
// ─────────────────────────────────────────────
function addWebUser(userId) {
  userId = String(userId);
  const chars    = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const rawPass  = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const hash     = bcrypt.hashSync(rawPass, 10);

  const users = loadWebUsers();
  users[userId] = { hash, addedAt: new Date().toISOString() };
  saveWebUsers(users);

  return { userId, password: rawPass };
}

function removeWebUser(userId) {
  userId = String(userId);
  const users = loadWebUsers();
  if (!users[userId]) return false;
  delete users[userId];
  saveWebUsers(users);
  return true;
}

function listWebUsers() {
  return loadWebUsers();
}

// ─────────────────────────────────────────────
//  HTML helpers
// ─────────────────────────────────────────────
const HTML_HEAD = (title) => `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title} — Flutter Build Bot</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
      min-height: 100vh;
      color: #e0e0e0;
    }
    .card {
      background: rgba(255,255,255,0.07);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 16px;
      backdrop-filter: blur(10px);
      padding: 2rem;
    }
    .btn {
      display: inline-block;
      padding: .6rem 1.4rem;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: .95rem;
      font-weight: 600;
      transition: opacity .2s, transform .2s;
      text-decoration: none;
    }
    .btn:hover { opacity: .9; transform: translateY(-1px); }
    .btn:disabled { opacity: .55; cursor: not-allowed; transform: none; }
    .btn-primary  { background: #5e5ce6; color: #fff; }
    .btn-danger   { background: #e64e4e; color: #fff; }
    .btn-success  { background: #3ecf8e; color: #000; }
    .btn-sm { padding: .35rem .85rem; font-size: .82rem; }
    input[type=text], input[type=password], input[type=number], select {
      width: 100%;
      padding: .65rem 1rem;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.06);
      color: #fff;
      font-size: 1rem;
      outline: none;
      transition: border .2s;
    }
    input:focus, select:focus { border-color: #5e5ce6; }
    label { display: block; margin-bottom: .4rem; font-size: .9rem; color: #aaa; }
    .err  { color: #ff6b6b; font-size: .9rem; margin-top: .5rem; }
    .ok   { color: #3ecf8e; font-size: .9rem; margin-top: .5rem; }
    nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: .9rem 2rem;
      background: rgba(0,0,0,.35);
      border-bottom: 1px solid rgba(255,255,255,.07);
      position: sticky; top: 0; z-index: 100;
    }
    nav .logo { font-size: 1.1rem; font-weight: 700; color: #5e5ce6; }
    nav .links { display: flex; gap: 1.2rem; align-items: center; }
    nav .links a { color: #aaa; text-decoration: none; font-size: .9rem; }
    nav .links a.active { color: #fff; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: .93rem; }
    th, td { text-align: left; padding: .65rem .9rem; border-bottom: 1px solid rgba(255,255,255,.07); }
    th { color: #aaa; font-weight: 600; font-size: .82rem; text-transform: uppercase; letter-spacing: .05em; }
    tr:hover td { background: rgba(255,255,255,.03); }
    .badge {
      display: inline-block; padding: .2rem .55rem;
      border-radius: 20px; font-size: .78rem; font-weight: 600;
    }
    .badge-green  { background: #1a4731; color: #3ecf8e; }
    .badge-purple { background: #29245e; color: #a09dff; }
    .badge-red    { background: #4a1a1a; color: #ff6b6b; }
    .badge-yellow { background: #4a401a; color: #ffd966; }
    .section-title { font-size: 1rem; font-weight: 700; color: #c0bdff; margin-bottom: 1rem; display: flex; align-items: center; gap: .5rem; }
    .file-drop {
      border: 2px dashed rgba(94,92,230,.45);
      border-radius: 12px;
      padding: 2rem;
      text-align: center;
      transition: background .2s, border-color .2s;
      cursor: pointer;
      color: #c0bdff;
    }
    .file-drop:hover, .file-drop.dragover { background: rgba(94,92,230,.10); border-color: #5e5ce6; }
    .file-drop input[type=file] { display: none; }
    .file-drop .file-info { font-size: .85rem; color: #aaa; margin-top: .5rem; }
    progress { width: 100%; height: 10px; border-radius: 6px; overflow: hidden; background: rgba(255,255,255,.08); }
    progress::-webkit-progress-bar { background: rgba(255,255,255,.08); }
    progress::-webkit-progress-value { background: linear-gradient(90deg,#5e5ce6,#a09dff); }
    progress::-moz-progress-bar { background: linear-gradient(90deg,#5e5ce6,#a09dff); }
    .log-box {
      background: #0a0a14;
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 8px;
      padding: 1rem;
      font-family: 'Consolas','Monaco',monospace;
      font-size: .8rem;
      color: #c0c0c0;
      white-space: pre-wrap;
      max-height: 380px;
      overflow-y: auto;
    }
  </style>
</head>
<body>`;

function pageLogin(errMsg = "") {
  return HTML_HEAD("Login") + `
<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem;">
  <div class="card" style="width:100%;max-width:400px;">
    <div style="text-align:center;margin-bottom:1.5rem;">
      <div style="font-size:2.5rem;">🤖</div>
      <h1 style="font-size:1.4rem;margin-top:.5rem;">Flutter Build Bot</h1>
      <p style="color:#888;font-size:.87rem;margin-top:.3rem;">Masuk untuk build APK dari ZIP project Flutter</p>
    </div>
    <form method="POST" action="/login">
      <div style="margin-bottom:1rem;">
        <label>Telegram User ID</label>
        <input type="text" name="userId" placeholder="123456789" required autofocus/>
      </div>
      <div style="margin-bottom:1.3rem;">
        <label>Password</label>
        <input type="password" name="password" placeholder="••••••••••" required/>
      </div>
      <button type="submit" class="btn btn-primary" style="width:100%;padding:.75rem;">🔑 Masuk</button>
      ${errMsg ? `<p class="err" style="text-align:center;margin-top:.8rem;">⚠️ ${errMsg}</p>` : ""}
    </form>
    <p style="text-align:center;margin-top:1.3rem;font-size:.82rem;color:#777;">
      Belum punya akses? Minta admin tambahkan kamu lewat <code>/addwebuser</code> di Telegram.
    </p>
  </div>
</div>
</body></html>`;
}

const FLUTTER_VERSIONS = [
  ["auto",    "Auto-deteksi (rekomendasi)"],
  ["stable",  "Channel: stable (terbaru stabil)"],
  ["beta",    "Channel: beta"],
  ["master",  "Channel: master"],
  ["3.35.5",  "3.35.5 (Dart 3.5)"],
  ["3.32.0",  "3.32.0"],
  ["3.27.4",  "3.27.4"],
  ["3.24.5",  "3.24.5"],
  ["3.22.3",  "3.22.3"],
  ["3.19.6",  "3.19.6 (Dart 3.3)"],
  ["3.16.9",  "3.16.9"],
  ["3.13.9",  "3.13.9"],
  ["3.10.6",  "3.10.6 (Dart 3.0)"],
  ["3.7.12",  "3.7.12"],
  ["3.3.10",  "3.3.10"],
  ["3.0.5",   "3.0.5"],
  ["2.10.5",  "2.10.5 (Flutter 2.x last)"],
  ["1.22.6",  "1.22.6 (legacy)"],
];

function pageBuild(userId, opts = {}) {
  const { isAdmin, ghOwner, ghRepo, botRunning } = opts;
  const versionOptions = FLUTTER_VERSIONS
    .map(([v, label]) => `<option value="${v}">${label}</option>`)
    .join("");

  return HTML_HEAD("Build APK") + `
<nav>
  <span class="logo">🤖 Flutter Build Bot</span>
  <div class="links">
    <a href="/build" class="active">🔨 Build</a>
    ${isAdmin ? '<a href="/admin">👥 Admin</a>' : ''}
    <span style="color:#666;">•</span>
    <span style="font-size:.85rem;color:#aaa;">👤 ${userId}</span>
    <a href="/logout" class="btn btn-danger btn-sm">Logout</a>
  </div>
</nav>

<div style="max-width:900px;margin:2rem auto;padding:0 1rem;">

  <!-- Header bar -->
  <div style="display:flex;gap:1rem;margin-bottom:1rem;flex-wrap:wrap;">
    <span class="badge ${botRunning ? "badge-green" : "badge-red"}">
      Bot Telegram: ${botRunning ? "ONLINE" : "OFFLINE"}
    </span>
    <span class="badge badge-purple">Repo: ${ghOwner}/${ghRepo}</span>
    <span class="badge badge-yellow">Max ZIP: ${MAX_UPLOAD_MB} MB</span>
  </div>

  <!-- Form Build -->
  <div class="card" style="margin-bottom:1.5rem;">
    <div class="section-title">🔨 Build APK dari ZIP Project Flutter</div>
    <p style="color:#aaa;font-size:.9rem;margin-bottom:1.3rem;">
      Upload file <code>.zip</code> berisi project Flutter (harus ada <code>pubspec.yaml</code> di dalamnya).
      Bot akan otomatis perbaiki Android embedding v1→v2 dan kompilasi APK release.
    </p>

    <form id="buildForm" enctype="multipart/form-data">
      <!-- Drop / pilih file -->
      <label class="file-drop" id="dropZone">
        <input type="file" id="zipInput" name="zip" accept=".zip,application/zip" required/>
        <div style="font-size:2rem;">📦</div>
        <div style="font-weight:600;margin-top:.4rem;">Klik atau drop file <code>.zip</code> di sini</div>
        <div class="file-info" id="fileInfo">Belum ada file dipilih</div>
      </label>

      <!-- Pilih versi Flutter -->
      <div style="margin-top:1.3rem;">
        <label for="versionSelect">Versi Flutter</label>
        <select id="versionSelect" name="flutter_version">
          ${versionOptions}
        </select>
        <p style="font-size:.8rem;color:#888;margin-top:.4rem;">
          Pilih <b>Auto-deteksi</b> kalau bingung — bot akan menebak versi cocok dari <code>pubspec.yaml</code>.
        </p>
      </div>

      <!-- Tombol -->
      <button type="submit" id="buildBtn" class="btn btn-success" style="margin-top:1.3rem;width:100%;padding:.85rem;">
        🚀 Mulai Build
      </button>
      <p id="formMsg" class="err" style="text-align:center;display:none;"></p>
    </form>
  </div>

  <!-- Build status (tersembunyi awal) -->
  <div id="statusCard" class="card" style="display:none;">
    <div class="section-title">📊 Status Build</div>
    <p style="color:#aaa;font-size:.87rem;margin-bottom:.6rem;">
      Build ID: <code id="buildIdView"></code>
    </p>
    <progress id="buildProgress" max="100"></progress>
    <p id="statusText" style="font-size:.92rem;margin-top:.6rem;color:#c0bdff;">⏳ Mengirim ZIP ke build server...</p>
    <p id="elapsedText" style="font-size:.82rem;color:#888;margin-top:.3rem;">Elapsed: 0s</p>
    <div id="resultBox" style="margin-top:1rem;display:none;"></div>
    <details id="logBox" style="margin-top:1rem;display:none;">
      <summary style="cursor:pointer;color:#a09dff;font-size:.9rem;">📄 Tampilkan log build</summary>
      <div id="logContent" class="log-box" style="margin-top:.5rem;">memuat...</div>
    </details>
  </div>

  <!-- Info ringkas -->
  <div class="card" style="margin-top:1.5rem;">
    <div class="section-title">💡 Info Build</div>
    <ul style="padding-left:1.2rem;color:#aaa;font-size:.88rem;line-height:1.85;">
      <li>Pastikan file ZIP berisi <code>pubspec.yaml</code> (project Flutter valid).</li>
      <li>Workflow mendukung <b>semua versi Flutter</b> dari <code>1.22.6</code> sampai <code>3.35.x</code>.</li>
      <li>Auto-fix Android Embedding v1 → v2 (perbaikan untuk error <i>“Build failed due to use of deleted Android v1 embedding”</i>).</li>
      <li>Auto-pilih Java 8/11/17 sesuai versi Flutter, auto-upgrade Gradle wrapper kalau terlalu lama.</li>
      <li>Build pertama untuk versi Flutter baru bisa lebih lama (download SDK). Versi yang sama biasanya cepat karena cache.</li>
    </ul>
  </div>
</div>

<script>
(function(){
  const dropZone     = document.getElementById("dropZone");
  const zipInput     = document.getElementById("zipInput");
  const fileInfo     = document.getElementById("fileInfo");
  const buildForm    = document.getElementById("buildForm");
  const buildBtn     = document.getElementById("buildBtn");
  const formMsg      = document.getElementById("formMsg");
  const statusCard   = document.getElementById("statusCard");
  const buildIdView  = document.getElementById("buildIdView");
  const progressEl   = document.getElementById("buildProgress");
  const statusText   = document.getElementById("statusText");
  const elapsedText  = document.getElementById("elapsedText");
  const resultBox    = document.getElementById("resultBox");
  const logBox       = document.getElementById("logBox");
  const logContent   = document.getElementById("logContent");

  function fmtSize(b){ if(!b) return ""; if(b<1024)return b+"B"; if(b<1048576)return (b/1024).toFixed(1)+"KB"; return (b/1048576).toFixed(2)+"MB"; }

  zipInput.addEventListener("change", () => {
    const f = zipInput.files[0];
    if (!f) { fileInfo.textContent = "Belum ada file dipilih"; return; }
    fileInfo.textContent = f.name + "  •  " + fmtSize(f.size);
  });

  ["dragenter","dragover"].forEach(ev =>
    dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add("dragover"); }));
  ["dragleave","drop"].forEach(ev =>
    dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove("dragover"); }));
  dropZone.addEventListener("drop", e => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      zipInput.files = e.dataTransfer.files;
      zipInput.dispatchEvent(new Event("change"));
    }
  });

  let pollTimer = null;
  let startedAt = 0;
  let elapsedTimer = null;

  function setStatus(text, percent) {
    statusText.textContent = text;
    if (typeof percent === "number") progressEl.value = percent;
  }

  function startElapsedTimer() {
    startedAt = Date.now();
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      const m = Math.floor(s / 60);
      elapsedText.textContent = "Elapsed: " + (m > 0 ? (m + "m " + (s%60) + "s") : (s + "s"));
    }, 1000);
  }

  function stopElapsedTimer() { if (elapsedTimer) clearInterval(elapsedTimer); elapsedTimer = null; }

  async function pollStatus(buildId) {
    try {
      const r = await fetch("/api/build/status/" + encodeURIComponent(buildId), { credentials: "same-origin" });
      const data = await r.json();
      if (!data.found) {
        setStatus("⏳ Antrian runner di GitHub Actions...", 15);
        return;
      }
      if (data.status === "queued") {
        setStatus("⏳ Antrian runner di GitHub Actions...", 20);
      } else if (data.status === "in_progress") {
        setStatus("🔨 Build berjalan... (extract, pub get, kompilasi APK)", 60);
      } else if (data.status === "completed") {
        clearInterval(pollTimer); pollTimer = null;
        stopElapsedTimer();
        if (data.conclusion === "success") {
          setStatus("✅ Build sukses!", 100);
          resultBox.style.display = "block";
          resultBox.innerHTML =
            '<div style="background:rgba(62,207,142,.10);border:1px solid rgba(62,207,142,.3);border-radius:10px;padding:1rem;color:#3ecf8e;">' +
            '<b>✅ Build sukses!</b><br><br>' +
            (data.apkUrl
              ? '<a href="' + data.apkUrl + '" class="btn btn-success" target="_blank" rel="noopener">📥 Download APK</a>'
              : '<span style="color:#aaa;">APK sudah jadi tapi link release belum siap. Coba refresh sebentar lagi.</span>') +
            '</div>';
        } else {
          setStatus("❌ Build gagal: " + (data.conclusion || "unknown"), 100);
          resultBox.style.display = "block";
          resultBox.innerHTML =
            '<div style="background:rgba(230,78,78,.10);border:1px solid rgba(230,78,78,.3);border-radius:10px;padding:1rem;color:#ff6b6b;">' +
            '<b>❌ Build gagal (' + (data.conclusion || "unknown") + ').</b> Lihat log di bawah untuk detail.' +
            '</div>';
          logBox.style.display = "block";
          loadLog(buildId);
        }
        buildBtn.disabled = false;
        buildBtn.textContent = "🚀 Mulai Build Lagi";
      }
    } catch (e) {
      // diam saja, polling berikutnya
    }
  }

  async function loadLog(buildId) {
    try {
      logContent.textContent = "Memuat log...";
      const r = await fetch("/api/build/log/" + encodeURIComponent(buildId), { credentials: "same-origin" });
      const t = await r.text();
      logContent.textContent = t || "(log kosong)";
    } catch (e) {
      logContent.textContent = "Gagal memuat log: " + e.message;
    }
  }

  buildForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    formMsg.style.display = "none";
    if (!zipInput.files[0]) { formMsg.textContent = "Pilih file ZIP dulu."; formMsg.style.display = "block"; return; }

    const fd = new FormData();
    fd.append("zip", zipInput.files[0]);
    fd.append("flutter_version", document.getElementById("versionSelect").value);

    buildBtn.disabled = true;
    buildBtn.textContent = "⏳ Mengirim ZIP...";
    statusCard.style.display = "block";
    resultBox.style.display = "none";
    logBox.style.display = "none";
    setStatus("📤 Mengirim ZIP ke server...", 5);
    startElapsedTimer();

    try {
      const r = await fetch("/api/build", { method: "POST", body: fd, credentials: "same-origin" });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        throw new Error(data.error || ("HTTP " + r.status));
      }
      buildIdView.textContent = data.buildId;
      setStatus("🚀 Workflow dipicu, menunggu runner...", 10);
      // Mulai polling tiap 8 detik
      pollStatus(data.buildId);
      pollTimer = setInterval(() => pollStatus(data.buildId), 8000);
    } catch (err) {
      formMsg.textContent = "❌ " + err.message;
      formMsg.style.display = "block";
      setStatus("❌ Gagal memicu build: " + err.message, 0);
      buildBtn.disabled = false;
      buildBtn.textContent = "🚀 Mulai Build";
      stopElapsedTimer();
    }
  });
})();
</script>
</body></html>`;
}

function pageAdmin(userId, users, isUserAdmin) {
  const adminList = (process.env.ADMIN_IDS || "").split(",").map(v => v.trim()).filter(Boolean);
  const userCount = Object.keys(users).length;

  const usersRows = Object.entries(users).map(([uid, info]) => `
    <tr>
      <td><code>${uid}</code></td>
      <td><span class="badge badge-purple">Web User</span>${adminList.includes(uid) ? ' <span class="badge badge-red">Admin</span>' : ""}</td>
      <td style="color:#888;font-size:.82rem;">${info.addedAt ? new Date(info.addedAt).toLocaleString("id-ID") : "-"}</td>
      <td>
        ${isUserAdmin ? `
        <form method="POST" action="/delwebuser" style="display:inline;" onsubmit="return confirm('Hapus user ini?')">
          <input type="hidden" name="userId" value="${uid}"/>
          <button type="submit" class="btn btn-danger btn-sm">🗑 Hapus</button>
        </form>` : "-"}
      </td>
    </tr>`).join("");

  return HTML_HEAD("Admin") + `
<nav>
  <span class="logo">🤖 Flutter Build Bot</span>
  <div class="links">
    <a href="/build">🔨 Build</a>
    <a href="/admin" class="active">👥 Admin</a>
    <span style="color:#666;">•</span>
    <span style="font-size:.85rem;color:#aaa;">👤 ${userId}</span>
    <a href="/logout" class="btn btn-danger btn-sm">Logout</a>
  </div>
</nav>
<div style="max-width:900px;margin:2rem auto;padding:0 1rem;">

  ${isUserAdmin ? `
  <div class="card" style="margin-bottom:1.5rem;">
    <div class="section-title">➕ Tambah Web User</div>
    <p style="font-size:.87rem;color:#aaa;margin-bottom:1rem;">
      Masukkan Telegram User ID. Password acak akan dibuat dan ditampilkan satu kali.
    </p>
    <form method="POST" action="/addwebuser" style="display:flex;gap:.8rem;flex-wrap:wrap;">
      <input type="text" name="userId" placeholder="Telegram User ID (contoh: 123456789)" style="flex:1;min-width:200px;" required/>
      <button type="submit" class="btn btn-success">✅ Add User</button>
    </form>
  </div>

  <div class="card">
    <div class="section-title">👥 Daftar Web Users (${userCount})</div>
    ${userCount === 0 ? '<p style="color:#888;font-size:.9rem;">Belum ada web user.</p>' : `
    <div style="overflow-x:auto;">
      <table>
        <thead><tr><th>User ID</th><th>Role</th><th>Ditambahkan</th><th>Aksi</th></tr></thead>
        <tbody>${usersRows}</tbody>
      </table>
    </div>`}
  </div>` : `
  <div class="card">
    <div class="section-title">⛔ Akses Ditolak</div>
    <p style="color:#aaa;font-size:.93rem;">Halaman admin hanya untuk admin. Kembali ke <a href="/build" style="color:#a09dff;">/build</a>.</p>
  </div>`}

</div>
</body></html>`;
}

function pageAddSuccess(userId, password, panelUrl) {
  return HTML_HEAD("User Ditambahkan") + `
<nav><span class="logo">🤖 Flutter Build Bot</span><a href="/admin" style="color:#aaa;text-decoration:none;font-size:.9rem;">← Kembali</a></nav>
<div style="max-width:500px;margin:3rem auto;padding:0 1rem;">
  <div class="card">
    <div style="text-align:center;margin-bottom:1.5rem;">
      <div style="font-size:2.5rem;">✅</div>
      <h2 style="margin-top:.5rem;">User Berhasil Ditambahkan!</h2>
    </div>
    <div style="background:rgba(62,207,142,.08);border:1px solid rgba(62,207,142,.2);border-radius:10px;padding:1rem 1.2rem;margin-bottom:1rem;">
      <p style="font-size:.85rem;color:#aaa;margin-bottom:.5rem;">User ID</p>
      <code style="font-size:1.1rem;color:#a09dff;">${userId}</code>
    </div>
    <div style="background:rgba(62,207,142,.08);border:1px solid rgba(62,207,142,.2);border-radius:10px;padding:1rem 1.2rem;margin-bottom:1rem;">
      <p style="font-size:.85rem;color:#aaa;margin-bottom:.5rem;">Password (satu kali tampil — simpan sekarang!)</p>
      <code style="font-size:1.3rem;color:#3ecf8e;letter-spacing:.1em;">${password}</code>
    </div>
    <div style="background:rgba(94,92,230,.08);border:1px solid rgba(94,92,230,.2);border-radius:10px;padding:1rem 1.2rem;margin-bottom:1.5rem;">
      <p style="font-size:.85rem;color:#aaa;margin-bottom:.5rem;">Link Panel</p>
      <a href="${panelUrl}" style="color:#a09dff;word-break:break-all;">${panelUrl}</a>
    </div>
    <p style="font-size:.82rem;color:#888;text-align:center;margin-bottom:1rem;">⚠️ Password hanya ditampilkan sekali. Kirim ke user sekarang.</p>
    <a href="/admin" class="btn btn-primary" style="display:block;text-align:center;">← Kembali ke Admin</a>
  </div>
</div>
</body></html>`;
}

// ─────────────────────────────────────────────
//  Express App
// ─────────────────────────────────────────────
function createWebPanel(opts = {}) {
  const {
    getBotStatus,
    startBuildFromZip,   // async ({zipBuffer, originalName, flutterVersion, userId}) → {buildId, zipRepoPath, repo}
    pollBuildStatus,     // async (buildId) → {found, status, conclusion, apkUrl, repo}
    getBuildLog,         // async (buildId) → string
    getPoolStatus,       // () → [{repo, busy, buildId, elapsed}]
  } = opts;

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  });

  // Helpers
  function requireLogin(req, res, next) {
    const token = getCookieToken(req);
    const sess  = getSession(token);
    if (!sess) {
      if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
      return res.redirect("/login");
    }
    req.userId = sess.userId;
    next();
  }
  function isAdminId(uid) {
    const adminIds = (process.env.ADMIN_IDS || "").split(",").map(v => v.trim()).filter(Boolean);
    return adminIds.includes(String(uid));
  }
  function requireAdmin(req, res, next) {
    if (!isAdminId(req.userId)) return res.status(403).send("403 Forbidden — Admin only");
    next();
  }

  // GET /
  app.get("/", (req, res) => {
    const token = getCookieToken(req);
    if (getSession(token)) return res.redirect("/build");
    res.redirect("/login");
  });

  // Backward compat: /dashboard → /build
  app.get("/dashboard", (req, res) => res.redirect("/build"));

  // GET /login
  app.get("/login", (req, res) => {
    const token = getCookieToken(req);
    if (getSession(token)) return res.redirect("/build");
    res.send(pageLogin());
  });

  // POST /login
  app.post("/login", (req, res) => {
    const { userId, password } = req.body || {};
    if (!userId || !password) return res.send(pageLogin("User ID dan password wajib diisi."));
    const users  = loadWebUsers();
    const record = users[String(userId)];
    if (!record) return res.send(pageLogin("User ID tidak ditemukan. Minta admin untuk add kamu."));
    const ok = bcrypt.compareSync(String(password), record.hash);
    if (!ok) return res.send(pageLogin("Password salah. Coba lagi."));
    const token = createSession(String(userId));
    res.setHeader("Set-Cookie", `wb_sess=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.redirect("/build");
  });

  // GET /logout
  app.get("/logout", (req, res) => {
    const token = getCookieToken(req);
    if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", "wb_sess=; Path=/; Max-Age=0");
    res.redirect("/login");
  });

  // GET /build — halaman utama: build APK
  app.get("/build", requireLogin, (req, res) => {
    const botStatus = typeof getBotStatus === "function" ? getBotStatus() : true;
    res.send(pageBuild(req.userId, {
      isAdmin: isAdminId(req.userId),
      ghOwner: process.env.GITHUB_OWNER || "?",
      ghRepo:  process.env.GITHUB_REPO  || "?",
      botRunning: botStatus,
    }));
  });

  // GET /admin — kelola web user
  app.get("/admin", requireLogin, (req, res) => {
    const users = loadWebUsers();
    res.send(pageAdmin(req.userId, users, isAdminId(req.userId)));
  });

  // POST /api/build — upload ZIP, trigger workflow
  app.post("/api/build", requireLogin, upload.single("zip"), async (req, res) => {
    try {
      if (!req.file)              return res.status(400).json({ ok: false, error: "File ZIP wajib di-upload." });
      if (!req.file.buffer)       return res.status(400).json({ ok: false, error: "Buffer ZIP kosong." });
      if (typeof startBuildFromZip !== "function") {
        return res.status(503).json({ ok: false, error: "Build helper belum siap di server." });
      }

      const flutterVersion = String(req.body?.flutter_version || "auto");
      const originalName   = req.file.originalname || "project.zip";

      const result = await startBuildFromZip({
        zipBuffer:      req.file.buffer,
        originalName,
        flutterVersion,
        userId:         req.userId,
      });

      webBuilds.set(result.buildId, {
        ownerUserId:    req.userId,
        fileName:       originalName,
        flutterVersion,
        startedAt:      Date.now(),
        zipRepoPath:    result.zipRepoPath,
      });

      res.json({ ok: true, buildId: result.buildId });
    } catch (e) {
      console.error("[web /api/build] error:", e.message);
      res.status(500).json({ ok: false, error: e.message || "Gagal memicu build." });
    }
  });

  // GET /api/build/status/:id
  app.get("/api/build/status/:id", requireLogin, async (req, res) => {
    try {
      if (typeof pollBuildStatus !== "function") return res.json({ found: false });
      const data = await pollBuildStatus(req.params.id);
      res.json(data || { found: false });
    } catch (e) {
      res.status(500).json({ found: false, error: e.message });
    }
  });

  // GET /api/build/log/:id
  app.get("/api/build/log/:id", requireLogin, async (req, res) => {
    try {
      if (typeof getBuildLog !== "function") return res.type("text/plain").send("Log helper tidak tersedia.");
      const log = await getBuildLog(req.params.id);
      res.type("text/plain; charset=utf-8").send(log || "(kosong)");
    } catch (e) {
      res.status(500).type("text/plain").send("Gagal ambil log: " + e.message);
    }
  });

  // GET /api/pool — status repo pool
  app.get("/api/pool", requireLogin, (req, res) => {
    try {
      if (typeof getPoolStatus === "function") {
        return res.json({ pool: getPoolStatus() });
      }
      return res.json({ pool: [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /addwebuser  (admin only)
  app.post("/addwebuser", requireLogin, requireAdmin, (req, res) => {
    const { userId } = req.body || {};
    if (!userId || isNaN(Number(userId))) return res.redirect("/admin?err=invalid_id");
    const { password } = addWebUser(String(userId));
    const panelUrl = getPanelPublicUrl(req);
    res.send(pageAddSuccess(userId, password, panelUrl));
  });

  // POST /delwebuser (admin only)
  app.post("/delwebuser", requireLogin, requireAdmin, (req, res) => {
    const { userId } = req.body || {};
    if (userId) removeWebUser(String(userId));
    res.redirect("/admin");
  });

  // API — untuk dipanggil bot saat /addwebuser command Telegram
  app.post("/api/adduser", (req, res) => {
    if (req.body?.secret !== WEB_PANEL_SECRET) return res.status(403).json({ error: "forbidden" });
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const result = addWebUser(String(userId));
    res.json({ ok: true, ...result });
  });

  // API — cek status (health)
  app.get("/api/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

  // Multer error → JSON yang rapi
  app.use((err, req, res, next) => {
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ ok: false, error: `File terlalu besar. Maks ${MAX_UPLOAD_MB} MB.` });
    }
    if (err) {
      console.error("[web_panel error]", err.message);
      if (req.path && req.path.startsWith("/api/")) {
        return res.status(500).json({ ok: false, error: err.message });
      }
      return res.status(500).send("Error: " + err.message);
    }
    next();
  });

  app.listen(WEB_PANEL_PORT, () => {
    console.log(`🌐 Web Panel berjalan di port ${WEB_PANEL_PORT}  → http://localhost:${WEB_PANEL_PORT}/build`);
  });

  return app;
}

function getPanelPublicUrl(req) {
  const host  = req.get("host") || `localhost:${WEB_PANEL_PORT}`;
  const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
  return `${proto}://${host}/login`;
}

module.exports = {
  createWebPanel,
  addWebUser,
  removeWebUser,
  listWebUsers,
  WEB_PANEL_PORT,
  WEB_PANEL_SECRET,
};
