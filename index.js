/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║     🤖 FLUTTER BUILD BOT v3.0 — MULTI-REPO POOL            ║
 * ║     Telegram + Secure Build + Pterodactyl Panel           ║
 * ║                                                              ║
 * ║  ✅ Multi-repo pool: build otomatis pindah ke repo kosong   ║
 * ║  ✅ Auto-create repo & push workflow                         ║
 * ║  ✅ Fix error 404 log detail                                 ║
 * ║  ✅ Semua command pakai Inline Button                        ║
 * ║  ✅ ZIP Flutter → APK → kirim balik ke Telegram             ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const TelegramBot = require("node-telegram-bot-api");
const axios       = require("axios");
const fs          = require("fs");
const path        = require("path");
const os          = require("os");
const { execFileSync } = require("child_process");
const crypto      = require("crypto");
require("dotenv").config();
const { startLocalBotApiIfEnabled } = require("./local_bot_api");
const { createWebPanel, addWebUser, removeWebUser, listWebUsers } = require("./web_panel");
const { createRepoPool } = require("./repo_pool");

// ════════════════════════════════════════════════════════════
//  KONFIGURASI — diambil dari .env
// ════════════════════════════════════════════════════════════
const BOT_TOKEN    = process.env.BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO  = process.env.GITHUB_REPO;

// Multi-repo pool config
const GITHUB_REPOS_RAW = (process.env.GITHUB_REPOS || "").trim();
const GITHUB_REPOS = GITHUB_REPOS_RAW
  ? GITHUB_REPOS_RAW.split(",").map(r => r.trim()).filter(Boolean)
  : [GITHUB_REPO].filter(Boolean);
const AUTO_CREATE_REPOS = String(process.env.AUTO_CREATE_REPOS || "true").toLowerCase() === "true";
const START_PHOTO_PATH = path.join(__dirname, process.env.START_PHOTO || "start.jpg");
let USERBOT_STRING_SESSION = (process.env.USERBOT_STRING_SESSION || "").trim();
let USERBOT_API_ID = Number(process.env.USERBOT_API_ID || process.env.TELEGRAM_API_ID || 0);
let USERBOT_API_HASH = (process.env.USERBOT_API_HASH || process.env.TELEGRAM_API_HASH || "").trim();
const USERBOT_PANEL_LOGIN = String(process.env.USERBOT_PANEL_LOGIN || "false").toLowerCase() === "true";
const USERBOT_PHONE = (process.env.USERBOT_PHONE || "").trim();
const WEB_PANEL_PUBLIC_URL = (process.env.WEB_PANEL_PUBLIC_URL || "").trim();
const REQUIRED_CHANNELS = String(process.env.REQUIRED_CHANNELS || "")
  .split(",").map(v => v.trim()).filter(Boolean);
const REQUIRED_CHANNEL_LINKS = String(process.env.REQUIRED_CHANNEL_LINKS || "")
  .split(",").map(v => v.trim()).filter(Boolean);

// Telegram cloud Bot API biasanya hanya aman download file sampai ±20 MB.
// Jika ingin menerima ZIP sampai 50 MB tanpa error "file is too big",
// jalankan Local Telegram Bot API Server lalu isi TELEGRAM_API_BASE_URL di .env.
// CATATAN: TELEGRAM_API_BASE_URL bisa di-isi sendiri di .env, ATAU otomatis
// diatur oleh startLocalBotApiIfEnabled() di bagian startup setelah Local
// Bot API server siap. Karena itu, baca lagi setelah local bot API dispawn.
function readTelegramApiBaseUrl() {
  return (process.env.TELEGRAM_API_BASE_URL || "").trim().replace(/\/$/, "");
}
let TELEGRAM_API_BASE_URL = readTelegramApiBaseUrl();
let TELEGRAM_DOWNLOAD_LIMIT_MB = Number(
  process.env.TELEGRAM_DOWNLOAD_LIMIT_MB || (TELEGRAM_API_BASE_URL ? 50 : 19.5)
);
const ENV_MAX_ZIP_MB = Number(process.env.MAX_ZIP_MB || 50);
const ENV_MAX_APK_SEND_MB = Number(process.env.MAX_APK_SEND_MB || 50);
const ENV_TELEGRAM_DOWNLOAD_LIMIT_MB = TELEGRAM_DOWNLOAD_LIMIT_MB;

// ── Runtime config (bisa diubah admin via /setmaxzip dst) ───────────────────
// File ini menyimpan override yang dibuat admin lewat command Telegram
// sehingga limit tetap konsisten setelah bot di-restart.
const BOT_CONFIG_FILE = path.join(__dirname, "bot_config.json");

function defaultBotConfig() {
  return {
    max_zip_mb: ENV_MAX_ZIP_MB,
    max_apk_send_mb: ENV_MAX_APK_SEND_MB,
    telegram_download_limit_mb: ENV_TELEGRAM_DOWNLOAD_LIMIT_MB,
    remote_config_url: process.env.REMOTE_CONFIG_URL || "",
    license_url: process.env.LICENSE_URL || "",
    license_key: process.env.LICENSE_KEY || "",
    update_command: process.env.UPDATE_COMMAND || "git pull --ff-only && npm install --omit=dev",
  };
}

function loadBotConfig() {
  try {
    if (!fs.existsSync(BOT_CONFIG_FILE)) return defaultBotConfig();
    const raw = JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, "utf8"));
    return { ...defaultBotConfig(), ...raw };
  } catch (e) {
    console.error("Gagal membaca bot_config.json:", e.message);
    return defaultBotConfig();
  }
}

let BOT_CONFIG = loadBotConfig();

function saveBotConfig() {
  try {
    fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(BOT_CONFIG, null, 2));
  } catch (e) {
    console.error("Gagal menyimpan bot_config.json:", e.message);
  }
}

function getMaxZipMb()          { return Number(BOT_CONFIG.max_zip_mb)          || ENV_MAX_ZIP_MB; }
function getMaxApkSendMb()      { return Number(BOT_CONFIG.max_apk_send_mb)     || ENV_MAX_APK_SEND_MB; }
function getDownloadLimitMb()   { return Number(BOT_CONFIG.telegram_download_limit_mb) || ENV_TELEGRAM_DOWNLOAD_LIMIT_MB; }

function parseIds(value = "") {
  return String(value)
    .split(",")
    .map(id => parseInt(id.trim(), 10))
    .filter(Boolean);
}

// ADMIN_IDS lebih disarankan. ALLOWED_USERS lama tetap dibaca agar config lama tidak rusak.
const ADMIN_IDS = parseIds(process.env.ADMIN_IDS || process.env.ALLOWED_USERS || "");
const ACCESS_FILE = path.join(__dirname, "allowed_users.json");

const missingVars = ["BOT_TOKEN","GITHUB_TOKEN","GITHUB_OWNER","GITHUB_REPO"]
  .filter(k => !process.env[k]);
if (missingVars.length) {
  console.error("❌ Variabel .env belum diisi:", missingVars.join(", "));
  process.exit(1);
}

// ════════════════════════════════════════════════════════════
//  ISI WORKFLOW — akan di-push otomatis ke GitHub saat startup
// ════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════
//  ISI WORKFLOW — dibaca dari file .github/workflows/build_apk.yml
//  agar mudah diedit tanpa harus mengubah kode JS. Fallback ke
//  WORKFLOW_YAML_FALLBACK kalau file tidak ada (mis. saat dipack
//  ulang tanpa workflow file).
// ════════════════════════════════════════════════════════════
const WORKFLOW_YAML_PATH = path.join(__dirname, ".github", "workflows", "build_apk.yml");

const WORKFLOW_YAML_FALLBACK = `name: Flutter Build Bot - ZIP to APK
run-name: "Build APK \${{ inputs.build_id || github.run_id }}"

"on":
  workflow_dispatch:
    inputs:
      zip_filename:
        description: Nama file ZIP yang akan di-build
        required: true
        default: project.zip
      build_id:
        description: ID unik build dari bot
        required: true
        default: manual-build
      flutter_version:
        description: "Versi Flutter (auto / stable / 3.35.5 / 3.22.3 / 2.10.5 dll)"
        required: false
        default: auto

permissions:
  contents: write

env:
  FLUTTER_CHANNEL: stable
  DEFAULT_FLUTTER_VERSION: 3.35.5

jobs:
  build-apk:
    name: Build Flutter APK
    runs-on: ubuntu-latest
    timeout-minutes: 55
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "17"
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
          flutter-version: "\${{ github.event.inputs.flutter_version }}"
          cache: true
      - name: Build APK
        shell: bash
        run: |
          set -e
          ZIP="\${{ github.event.inputs.zip_filename }}"
          mkdir -p build_workspace
          unzip -q -o "$ZIP" -d build_workspace/extracted
          PUBSPEC="$(find build_workspace/extracted -type f -name pubspec.yaml | head -1)"
          [ -z "$PUBSPEC" ] && { echo "pubspec.yaml tidak ditemukan"; exit 1; }
          cd "$(dirname "$PUBSPEC")"
          flutter pub get
          flutter build apk --release --no-tree-shake-icons
`;

function loadWorkflowYaml() {
  try {
    if (fs.existsSync(WORKFLOW_YAML_PATH)) {
      const fromDisk = fs.readFileSync(WORKFLOW_YAML_PATH, "utf8");
      if (fromDisk && fromDisk.trim().length > 0) {
        return fromDisk;
      }
    }
  } catch (e) {
    console.warn("Gagal baca workflow file:", e.message);
  }
  return WORKFLOW_YAML_FALLBACK;
}

let WORKFLOW_YAML = loadWorkflowYaml();

// ════════════════════════════════════════════════════════════
//  INISIALISASI
// ════════════════════════════════════════════════════════════
// `bot` di-init sebagai proxy yang menampung registrasi handler (onText/on)
// supaya kode di bawah bisa langsung memanggil bot.onText(...) sebelum Local
// Bot API server selesai start. Di main() nanti, proxy ini ditukar dengan
// `new TelegramBot(...)` asli dan semua handler di-replay.
const pendingBotCalls = [];
function makePendingBot() {
  return new Proxy({}, {
    get(_t, prop) {
      return (...args) => { pendingBotCalls.push({ prop, args }); };
    },
  });
}
let bot = makePendingBot();
const userState = new Map(); // chatId → state

function buildRealBot() {
  const opts = { polling: true };
  TELEGRAM_API_BASE_URL = readTelegramApiBaseUrl();
  if (TELEGRAM_API_BASE_URL) {
    opts.baseApiUrl = TELEGRAM_API_BASE_URL;
    // Default download limit otomatis naik ke 50 MB kalau pakai local Bot API
    if (!process.env.TELEGRAM_DOWNLOAD_LIMIT_MB) {
      TELEGRAM_DOWNLOAD_LIMIT_MB = 50;
      if (Number(BOT_CONFIG.telegram_download_limit_mb) === ENV_TELEGRAM_DOWNLOAD_LIMIT_MB) {
        BOT_CONFIG.telegram_download_limit_mb = 50;
      }
    }
  }
  const realBot = new TelegramBot(BOT_TOKEN, opts);
  for (const { prop, args } of pendingBotCalls) {
    try { realBot[prop](...args); } catch (e) {
      console.error(`Gagal replay bot.${String(prop)}:`, e.message);
    }
  }
  pendingBotCalls.length = 0;
  bot = realBot;
}

const GH_HEADERS = {
  Authorization: `token ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
};

// ════════════════════════════════════════════════════════════
//  MULTI-REPO POOL — buat pool di sini, init di main()
// ════════════════════════════════════════════════════════════
let repoPool = null; // diinit di startup

const branchCache = new Map();
async function getDefaultBranch(repo) {
  const r = repo || GITHUB_REPO;
  if (branchCache.has(r)) return branchCache.get(r);
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${GITHUB_OWNER}/${r}`,
      { headers: GH_HEADERS }
    );
    branchCache.set(r, data.default_branch || "main");
  } catch {
    branchCache.set(r, "main");
  }
  return branchCache.get(r);
}

// ════════════════════════════════════════════════════════════
//  AUTO-SETUP: PUSH WORKFLOW KE SEMUA REPO (MULTI-REPO)
// ════════════════════════════════════════════════════════════
async function autoSetupWorkflow(targetRepo) {
  if (repoPool && !targetRepo) {
    return repoPool.initAllRepos();
  }
  const repo = targetRepo || GITHUB_REPO;
  const filePath = ".github/workflows/build_apk.yml";
  const branch   = await getDefaultBranch(repo);
  const apiUrl   = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${filePath}`;

  try {
    let sha;
    let existingContent = "";

    try {
      const res = await axios.get(apiUrl, {
        headers: GH_HEADERS,
        params: { ref: branch },
      });
      sha = res.data.sha;
      existingContent = Buffer.from(res.data.content, "base64").toString("utf8");
    } catch (e) {
      if (e.response?.status !== 404) throw e;
    }

    if (existingContent.trim() === WORKFLOW_YAML.trim()) {
      return { status: "uptodate", branch, repo };
    }

    await axios.put(apiUrl, {
      message: sha
        ? "bot: update workflow build APK"
        : "bot: auto-setup workflow build APK (server startup)",
      content: Buffer.from(WORKFLOW_YAML).toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }, { headers: GH_HEADERS });

    return { status: sha ? "updated" : "created", branch, repo };

  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    return { status: "error", message: msg, branch, repo };
  }
}

// ════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════
function loadAllowedUsers() {
  try {
    if (!fs.existsSync(ACCESS_FILE)) {
      fs.writeFileSync(ACCESS_FILE, JSON.stringify({ users: ADMIN_IDS }, null, 2));
      return new Set(ADMIN_IDS);
    }
    const raw = JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8"));
    return new Set([...(raw.users || []), ...ADMIN_IDS].map(Number).filter(Boolean));
  } catch (e) {
    console.error("Gagal membaca allowed_users.json:", e.message);
    return new Set(ADMIN_IDS);
  }
}

let ALLOWED_USER_SET = loadAllowedUsers();

function saveAllowedUsers() {
  fs.writeFileSync(ACCESS_FILE, JSON.stringify({
    users: [...ALLOWED_USER_SET].sort((a, b) => a - b),
  }, null, 2));
}

const isAdmin = uid => ADMIN_IDS.length === 0 || ADMIN_IDS.includes(Number(uid));
const isAllowed = uid => isAdmin(uid) || ALLOWED_USER_SET.has(Number(uid));
const sendMsg   = (chatId, text, extra = {}) =>
  bot.sendMessage(chatId, text, { parse_mode: "Markdown", disable_web_page_preview: true, ...extra });

function sanitizePrivateText(text = "") {
  let out = String(text || "");
  const owner = String(GITHUB_OWNER || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const repo  = String(GITHUB_REPO  || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  out = out.replace(/https?:\/\/[^\s`'\")<>]*github[^\s`'\")<>]*/gi, "[URL disembunyikan]");
  out = out.replace(/git@github\.com:[^\s`'\")<>]+/gi, "[repo disembunyikan]");
  if (owner && repo) out = out.replace(new RegExp(`${owner}\/${repo}`, "gi"), "[repo disembunyikan]");
  if (repo) out = out.replace(new RegExp(repo, "gi"), "[repo disembunyikan]");
  for (const secret of [BOT_TOKEN, GITHUB_TOKEN, USERBOT_STRING_SESSION, USERBOT_API_HASH]) {
    if (secret && String(secret).length >= 8) out = out.split(String(secret)).join("[secret disembunyikan]");
  }
  out = out.replace(/(Authorization:\s*(token|Bearer)\s+)[^\s]+/gi, "$1[secret disembunyikan]");
  out = out.replace(/(GITHUB_TOKEN|BOT_TOKEN|USERBOT_STRING_SESSION|USERBOT_API_HASH)\s*[=:]\s*[^\s]+/gi, "$1=[secret disembunyikan]");
  return out;
}

function escapeMd(text = "") {
  return sanitizePrivateText(text).replace(/([_*`\[\]])/g, "\\$1");
}

function errorDetails(err) {
  const parts = [];
  if (err?.message) parts.push(err.message);
  if (err?.response?.status) parts.push(`HTTP ${err.response.status}`);
  if (err?.response?.data) {
    const data = typeof err.response.data === "string" ? err.response.data : JSON.stringify(err.response.data, null, 2);
    parts.push(data);
  }
  if (err?.stack) parts.push(err.stack);
  return sanitizePrivateText(parts.filter(Boolean).join("\n\n"));
}

async function sendLongSafeLog(chatId, title, rawLog, markup) {
  const clean = sanitizePrivateText(rawLog || "Tidak ada detail log.");
  const max = 3300;
  const chunks = clean.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) || ["Tidak ada detail log."];
  await sendMsg(chatId, `${title}\n\n\`\`\`\n${chunks[0]}\n\`\`\``, chunks.length === 1 ? (markup ? { reply_markup: markup } : {}) : {});
  for (let i = 1; i < chunks.length; i++) {
    await sendMsg(chatId, `📄 *Lanjutan log ${i + 1}/${chunks.length}:*\n\n\`\`\`\n${chunks[i]}\n\`\`\``, i === chunks.length - 1 && markup ? { reply_markup: markup } : {});
  }
}

function tgUserText(user = {}) {
  const username = user.username ? `@${escapeMd(user.username)}` : "-";
  const name = escapeMd([user.first_name, user.last_name].filter(Boolean).join(" ") || "Tanpa nama");
  return `Nama: ${name}\nUsername: ${username}\nID: ${user.id}`;
}

async function notifyAdmins(text, extra = {}) {
  const targets = ADMIN_IDS.length ? ADMIN_IDS : [...ALLOWED_USER_SET];
  for (const adminId of targets) {
    try { await sendMsg(adminId, text, extra); } catch {}
  }
}

function joinKeyboard() {
  const rows = REQUIRED_CHANNELS.map((ch, i) => {
    const link = REQUIRED_CHANNEL_LINKS[i] || (ch.startsWith("@") ? `https://t.me/${ch.slice(1)}` : "https://t.me/");
    return [{ text: `📢 Join Channel ${i + 1}`, url: link }];
  });
  rows.push([{ text: "✅ Saya Sudah Join", callback_data: "check_join" }]);
  return { inline_keyboard: rows };
}

async function isJoinedRequiredChannels(userId) {
  if (!REQUIRED_CHANNELS.length) return true;
  for (const channel of REQUIRED_CHANNELS) {
    try {
      const member = await bot.getChatMember(channel, userId);
      if (["left", "kicked"].includes(member.status)) return false;
    } catch (e) {
      console.error(`Gagal cek channel ${channel}:`, e.message);
      return false;
    }
  }
  return true;
}

async function sendJoinRequired(chatId) {
  return sendMsg(chatId,
    `🔒 *Wajib join ${REQUIRED_CHANNELS.length} channel dulu.*\n\n` +
    `Setelah join, tekan tombol *✅ Saya Sudah Join* agar menu build terbuka.`,
    { reply_markup: joinKeyboard() }
  );
}

async function sendStartMenu(chatId, name = "Pengguna", userId = 0) {
  const caption =
    `👋 Halo *${escapeMd(name)}!*\n\n` +
    `*Flutter Build Bot v2.0* 🚀\n\n` +
    `Ubah *ZIP Flutter → APK* otomatis lewat workflow aman.\n` +
    `APK hasil build akan dicoba dikirim memakai *userbot* sebagai file, bukan link.\n\n` +
    `Pilih menu:`;

  if (fs.existsSync(START_PHOTO_PATH)) {
    try {
      return await bot.sendPhoto(chatId, START_PHOTO_PATH, {
        caption, parse_mode: "Markdown", reply_markup: mainMenu(userId),
      });
    } catch (e1) {
      console.error("Gagal kirim foto start via path:", e1.message);
      try {
        return await bot.sendPhoto(chatId, fs.createReadStream(START_PHOTO_PATH), {
          caption, parse_mode: "Markdown", reply_markup: mainMenu(userId),
        });
      } catch (e2) {
        console.error("Gagal kirim foto start via stream:", e2.message);
      }
    }
  } else {
    console.error("Foto start tidak ditemukan:", START_PHOTO_PATH);
  }
  return sendMsg(chatId, caption, { reply_markup: mainMenu(userId) });
}

function adminOnly(chatId, uid) {
  if (isAdmin(uid)) return true;
  sendMsg(chatId, "⛔ Command ini hanya untuk admin.").catch(() => {});
  return false;
}

function mb(bytes = 0) {
  return (Number(bytes || 0) / 1024 / 1024).toFixed(2);
}

function isTelegramFileTooBigError(err) {
  const text = String(err?.message || err?.response?.data?.description || "").toLowerCase();
  return text.includes("file is too big") ||
    text.includes("request entity too large") ||
    text.includes("413") ||
    text.includes("too large");
}

function telegramLimitMessage(kind, sizeMb) {
  return (
    `❌ *${kind} terlalu besar untuk Bot API Telegram cloud.*\n\n` +
    `Ukuran file: *${sizeMb} MB*\n` +
    `Batas ZIP bot saat ini: *${getDownloadLimitMb()} MB*\n\n` +
    `Agar ZIP sampai *50 MB* tidak error, isi .env dengan Local Telegram Bot API Server:\n` +
    `\`TELEGRAM_API_BASE_URL=http://127.0.0.1:8081/bot\`\n` +
    `\`TELEGRAM_DOWNLOAD_LIMIT_MB=50\`\n\n` +
    `Tanpa local Bot API, Telegram sering menolak download file bot di atas ±20 MB dengan error \`file is too big\`.`
  );
}

function formatConfigSnapshot() {
  return (
    `⚙️ *Config bot saat ini:*\n\n` +
    `• \`MAX_ZIP_MB\` (limit terima ZIP)            : *${getMaxZipMb()} MB*\n` +
    `• \`MAX_APK_SEND_MB\` (limit kirim APK)        : *${getMaxApkSendMb()} MB*\n` +
    `• \`TELEGRAM_DOWNLOAD_LIMIT_MB\` (Bot API)     : *${getDownloadLimitMb()} MB*\n` +
    `• \`TELEGRAM_API_BASE_URL\`                    : ${TELEGRAM_API_BASE_URL ? `\`${TELEGRAM_API_BASE_URL}\`` : "cloud default"}\n\n` +
    `Ubah limit (admin only):\n` +
    `\`/setmaxzip 50\`\n` +
    `\`/setmaxapk 50\`\n` +
    `\`/setdllimit 50\`\n` +
    `\`/resetconfig\` — balik ke nilai .env.`
  );
}

// ─── Keyboards ───────────────────────────────────────────────
const mainMenu = (userId = 0) => {
  const rows = [
    [{ text: "🔨 Build APK", callback_data: "menu_build" }],
    [
      { text: "📊 Status Build", callback_data: "menu_status" },
      { text: "📱 Release Terbaru", callback_data: "menu_release" },
    ],
    [
      { text: "☁️ Sync Workflow", callback_data: "menu_sync" },
      { text: "⚙️ Config Limit", callback_data: "menu_config" },
    ],
    [
      { text: "❓ Bantuan", callback_data: "menu_help" },
      { text: "ℹ️ Info Bot", callback_data: "menu_info" },
    ],
  ];

  // Tombol Userbot hanya muncul untuk admin.
  if (isAdmin(userId)) {
    rows.splice(3, 0,
      [{ text: "🛡️ Admin Panel", callback_data: "menu_admin" }],
      [{ text: "👤 Userbot", callback_data: "menu_userbot" }]
    );
  }

  return { inline_keyboard: rows };
};

const backToMenu = () => ({
  inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "menu_home" }]],
});

const confirmBuild = fileName => ({
  inline_keyboard: [
    [
      { text: "✅ Ya, Mulai Build!", callback_data: `confirm:${fileName}` },
      { text: "❌ Batal",            callback_data: "cancel_build"         },
    ],
  ],
});

const afterBuildFile = () => ({
  inline_keyboard: [
    [{ text: "🏠 Menu Utama", callback_data: "menu_home" }],
  ],
});

const afterBuildFallback = () => ({
  inline_keyboard: [
    [
      { text: "🔁 Coba Kirim Lagi", callback_data: "menu_release" },
      { text: "🏠 Menu", callback_data: "menu_home" },
    ],
  ],
});

const afterFail = () => ({
  inline_keyboard: [
    [
      { text: "🔁 Coba Lagi",  callback_data: "menu_build" },
      { text: "🏠 Menu",       callback_data: "menu_home"  },
    ],
  ],
});

// ─── Edit pesan helper ────────────────────────────────────────
async function editMsg(chatId, msgId, text, markup) {
  const opts = {
    chat_id: chatId, message_id: msgId,
    parse_mode: "Markdown",
    ...(markup ? { reply_markup: markup } : {}),
  };
  try {
    return await bot.editMessageText(text, opts);
  } catch (e) {
    // Kalau pesan awal berupa foto, Telegram harus edit caption, bukan text.
    try {
      if (String(text).length <= 950) {
        return await bot.editMessageCaption(text, opts);
      }
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
      return await sendMsg(chatId, text, markup ? { reply_markup: markup } : {});
    } catch {
      return await sendMsg(chatId, text, markup ? { reply_markup: markup } : {});
    }
  }
}

// ─── GitHub API helpers ───────────────────────────────────────
// ─── Build identity helpers ─────────────────────────────────────
function safeFileBase(name = "project.zip") {
  const base = path.basename(String(name || "project.zip"));
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 80) || "project.zip";
}

function createBuildId(chatId) {
  const rand = crypto.randomBytes(4).toString("hex");
  return `${Date.now()}-${String(chatId).replace(/[^0-9-]/g, "")}-${rand}`;
}

async function uploadZipToGithub(localPath, repoFilePath, targetRepo) {
  const repo = targetRepo || GITHUB_REPO;
  const content = fs.readFileSync(localPath).toString("base64");
  const safeRepoPath = String(repoFilePath).replace(/^\/+/, "");
  const apiUrl  = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${encodeURI(safeRepoPath).replace(/%2F/g, "/")}`;

  let sha;
  try {
    const res = await axios.get(apiUrl, { headers: GH_HEADERS });
    sha = res.data.sha;
  } catch {}

  await axios.put(apiUrl, {
    message: `bot: upload ZIP untuk build APK`,
    content,
    ...(sha ? { sha } : {}),
  }, { headers: GH_HEADERS });
}

async function ensureWorkflowReady(maxWaitMs = 30000, targetRepo) {
  const repo = targetRepo || GITHUB_REPO;
  const workflowApiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/workflows/build_apk.yml`;
  const deadline = Date.now() + maxWaitMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const { data } = await axios.get(workflowApiUrl, { headers: GH_HEADERS });
      if (data && (data.state === "active" || data.state === "disabled_inactivity")) {
        return true;
      }
    } catch (e) {
      lastErr = e;
      if (e.response?.status === 404) {
        await autoSetupWorkflow(repo);
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw lastErr || new Error(`Workflow tidak aktif di repo ${repo} setelah menunggu.`);
}

async function triggerWorkflow(zipRepoPath, buildId, flutterVersion = "auto", targetRepo) {
  const repo = targetRepo || GITHUB_REPO;
  const branch = await getDefaultBranch(repo);

  await ensureWorkflowReady(30000, repo);
  await new Promise(r => setTimeout(r, 3000));

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await axios.post(
        `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/workflows/build_apk.yml/dispatches`,
        { ref: branch, inputs: { zip_filename: zipRepoPath, build_id: buildId, flutter_version: String(flutterVersion || "auto") } },
        { headers: GH_HEADERS }
      );
      return;
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      const msg = e.response?.data?.message || e.message;
      if (status === 422) {
        console.warn(`[triggerWorkflow] Attempt ${attempt} gagal 422 di repo ${repo}: ${msg}. Re-push workflow & retry...`);
        await autoSetupWorkflow(repo);
        await new Promise(r => setTimeout(r, 5000 * attempt));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function waitForBuild(chatId, msgId, buildId, startedAtMs = Date.now(), targetRepo) {
  const repo = targetRepo || (repoPool ? repoPool.getRepoForBuild(buildId) : GITHUB_REPO);
  const MAX    = 30 * 60 * 1000;
  const TICK   = 20 * 1000;
  const start  = Date.now();
  let matchedRunId = null;

  const stages = [
    "⏳ Antrian runner...",
    "☕ Setup Java 17 & Flutter SDK...",
    "📦 Mengekstrak ZIP project...",
    "📚 flutter pub get...",
    "🔨 Kompilasi APK release...",
    "🚀 Upload hasil build...",
  ];
  let si = 0;

  while (Date.now() - start < MAX) {
    await new Promise(r => setTimeout(r, TICK));

    if (si < stages.length) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const label   = elapsed >= 60
        ? `${Math.floor(elapsed/60)}m ${elapsed%60}s`
        : `${elapsed}s`;
      try {
        await editMsg(chatId, msgId,
          `🏗️ *Build Berjalan...*\n\n${stages[si]}\n\n` +
          `🆔 Build ID: \`${buildId}\`\n` +
          `📦 Repo: \`${repo}\`\n` +
          `⏱ Elapsed: \`${label}\` | Step \`${si+1}/${stages.length}\``
        );
      } catch {}
      si++;
    }

    try {
      const { data } = await axios.get(
        `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/runs?per_page=20`,
        { headers: GH_HEADERS }
      );
      const runs = data.workflow_runs || [];
      const run = runs.find(r => {
        const title = String(r.display_title || r.name || "");
        const created = new Date(r.created_at || 0).getTime();
        return title.includes(buildId) || (matchedRunId && r.id === matchedRunId) || (created >= startedAtMs - 15000 && title.includes("Build APK"));
      });
      if (run) {
        matchedRunId = run.id;
        if (repoPool) repoPool.registerBuildRun(buildId, run.id);
        if (run.status === "completed") {
          return { ok: run.conclusion === "success", runId: run.id, runUrl: run.html_url, repo };
        }
      }
    } catch {}
  }

  return { ok: false, runId: matchedRunId, runUrl: null, timeout: true, repo };
}

async function getRunSafeLog(runId, targetRepo) {
  if (!runId) return "Log build belum tersedia.";
  const repo = targetRepo || GITHUB_REPO;
  const tmpZip = path.join(os.tmpdir(), `build-log-${runId}-${Date.now()}.zip`);

  // Retry up to 3 times with delay for 404 (logs may not be ready yet)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(
        `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/runs/${runId}/logs`,
        { headers: GH_HEADERS, responseType: "arraybuffer", maxRedirects: 5, validateStatus: s => s >= 200 && s < 300 }
      );
      fs.writeFileSync(tmpZip, Buffer.from(res.data));
      const raw = execFileSync("unzip", ["-p", tmpZip], { encoding: "utf8", maxBuffer: 1024 * 1024 * 6 });
      return sanitizePrivateText(raw).slice(-9000);
    } catch (e) {
      const status = e.response?.status;
      if (status === 404 && attempt < 3) {
        console.log(`[getRunSafeLog] Attempt ${attempt}: log belum ready (404), retry in ${5 * attempt}s...`);
        await new Promise(r => setTimeout(r, 5000 * attempt));
        continue;
      }
      // Fallback: try to get job-level logs
      if (status === 404) {
        try {
          return await getJobLevelLog(runId, repo);
        } catch {
          return "Log build belum tersedia. GitHub Actions mungkin belum selesai menyiapkan log, atau run sudah expired.\nCoba tekan \"Refresh\" di menu Status Build beberapa saat lagi.";
        }
      }
      return sanitizePrivateText(`Gagal mengambil log detail (HTTP ${status || "?"}). ${e.message || e}`);
    } finally {
      try { if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip); } catch {}
    }
  }
  return "Log build belum tersedia setelah beberapa percobaan.";
}

async function getJobLevelLog(runId, targetRepo) {
  const repo = targetRepo || GITHUB_REPO;
  const { data } = await axios.get(
    `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/runs/${runId}/jobs?per_page=10`,
    { headers: GH_HEADERS }
  );
  const jobs = data.jobs || [];
  if (!jobs.length) return "Tidak ada job ditemukan untuk run ini.";

  const lines = [];
  for (const job of jobs) {
    lines.push(`=== Job: ${job.name} [${job.conclusion || job.status}] ===`);
    for (const step of (job.steps || [])) {
      const icon = step.conclusion === "success" ? "✅" : step.conclusion === "failure" ? "❌" : "⏳";
      lines.push(`  ${icon} ${step.name} (${step.conclusion || step.status})`);
    }
    // Get detailed log for failed jobs
    if (job.conclusion === "failure") {
      try {
        const logRes = await axios.get(
          `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/jobs/${job.id}/logs`,
          { headers: GH_HEADERS, maxRedirects: 5, validateStatus: s => s >= 200 && s < 400 }
        );
        if (typeof logRes.data === "string") {
          lines.push("--- Log detail:");
          lines.push(logRes.data.slice(-3000));
        }
      } catch {
        lines.push("(log detail job tidak tersedia)");
      }
    }
  }
  return sanitizePrivateText(lines.join("\n")).slice(-9000);
}

function cleanupOldBuildTmpFiles() {
  const tmp = os.tmpdir();
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (/^(apk-artifact-|build-log-|flutter-release-|\d{13,}-)/.test(name)) {
        try { fs.rmSync(path.join(tmp, name), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
}

function getFreeTmpBytes() {
  try {
    const out = execFileSync("df", ["-Pk", os.tmpdir()], { encoding: "utf8" }).trim().split(/\n/).pop();
    const cols = out.trim().split(/\s+/);
    return Number(cols[3] || 0) * 1024;
  } catch {
    return 0;
  }
}


function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function runShell(command, cwd = __dirname) {
  return execFileSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 12,
  });
}

function zipExcludeArgs() {
  return [
    "*.git*", "*node_modules*", "*.dart_tool*", "*build*", "*.gradle*",
    "*android/.gradle*", "*ios/Pods*", "*ios/.symlinks*", "*macos/Pods*",
    "*.idea*", "*.vscode*", "*.DS_Store", "*coverage*", "*.tmp", "*.log",
    "*pubspec.lock", "*backup*", "*.apk", "*.aab", "*.ipa"
  ];
}

function optimizeFlutterZipBuffer(zipBuffer, originalName = "project.zip") {
  const inputSize = zipBuffer.length;
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "flutterzip-opt-"));
  const inputZip = path.join(tempBase, safeFileBase(originalName));
  const extractDir = path.join(tempBase, "src");
  const outZip = path.join(tempBase, `optimized-${Date.now()}.zip`);
  try {
    ensureDir(extractDir);
    fs.writeFileSync(inputZip, zipBuffer);
    execFileSync("unzip", ["-q", "-o", inputZip, "-d", extractDir], { stdio: "ignore" });

    const removeNames = new Set([".git", "node_modules", ".dart_tool", "build", ".gradle", ".idea", ".vscode", "Pods", ".symlinks", "coverage"]);
    const removeFiles = new Set([".DS_Store", "pubspec.lock"]);
    const walk = dir => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (removeNames.has(item.name)) fs.rmSync(full, { recursive: true, force: true });
          else walk(full);
        } else if (removeFiles.has(item.name) || /\.(apk|aab|ipa|log|tmp)$/i.test(item.name)) {
          fs.rmSync(full, { force: true });
        }
      }
    };
    walk(extractDir);

    const pubspecs = runShell(`find . -type f -name pubspec.yaml | head -1`, extractDir).trim();
    if (!pubspecs) throw new Error("pubspec.yaml tidak ditemukan setelah optimasi ZIP.");
    runShell(`zip -qr9 "${outZip}" . -x ${zipExcludeArgs().map(v => `'${v}'`).join(" ")}`, extractDir);
    const outBuffer = fs.readFileSync(outZip);
    return { buffer: outBuffer.length < zipBuffer.length ? outBuffer : zipBuffer, before: inputSize, after: Math.min(outBuffer.length, zipBuffer.length), changed: outBuffer.length < zipBuffer.length };
  } catch (e) {
    console.error("Optimasi ZIP gagal, memakai ZIP original:", e.message);
    return { buffer: zipBuffer, before: inputSize, after: inputSize, changed: false, error: e.message };
  } finally {
    try { fs.rmSync(tempBase, { recursive: true, force: true }); } catch {}
  }
}

async function optimizeAndStoreZip(chatId, zipBuffer, fileName, dlMsgId) {
  const info = optimizeFlutterZipBuffer(zipBuffer, fileName);
  const finalName = info.changed ? safeFileBase(fileName).replace(/\.zip$/i, "") + "-optimized.zip" : fileName;
  userState.set(chatId, { waitingForZip: false, zipBuffer: info.buffer, fileName: finalName });
  const note = info.changed ? `\n🧹 Dioptimasi: ${mb(info.before)} MB → *${mb(info.after)} MB*` : `\n🧹 Optimasi: tidak ada file cache besar yang bisa dikurangi`;
  const warn = info.after > 20 * 1024 * 1024 ? `\n\n⚠️ Ukuran masih di atas 20 MB karena asset/project memang besar. Bot tetap bisa build jika limit mengizinkan.` : `\n\n✅ Ukuran ZIP aman di bawah 20 MB.`;
  await bot.editMessageText(
    `✅ *ZIP Diterima!*\n\n` +
    `📄 \`${escapeMd(finalName)}\`\n` +
    `💾 ${mb(info.after)} MB${note}${warn}\n\n` +
    `Mulai build APK sekarang?`,
    { chat_id: chatId, message_id: dlMsgId, parse_mode: "Markdown", reply_markup: confirmBuild(finalName) }
  );
}

async function sendOptimizedZipOnly(chatId, zipBuffer, fileName, dlMsgId) {
  const info = optimizeFlutterZipBuffer(zipBuffer, fileName);
  const finalName = safeFileBase(fileName).replace(/\.zip$/i, "") + "-under20-optimized.zip";
  const tmp = path.join(os.tmpdir(), `${Date.now()}-${finalName}`);
  fs.writeFileSync(tmp, info.buffer);
  const warn = info.after > 20 * 1024 * 1024 ? "\n⚠️ Masih di atas 20 MB karena asset asli besar." : "\n✅ Berhasil di bawah 20 MB.";
  await bot.editMessageText(`✅ *Optimasi ZIP selesai!*\n\nSebelum: *${mb(info.before)} MB*\nSesudah: *${mb(info.after)} MB*${warn}`, { chat_id: chatId, message_id: dlMsgId, parse_mode: "Markdown" }).catch(() => {});
  try {
    await bot.sendDocument(chatId, fs.createReadStream(tmp), { caption: `ZIP hasil optimasi: ${mb(info.after)} MB` }, { filename: finalName, contentType: "application/zip" });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    userState.delete(chatId);
  }
}

function backupTargets() {
  return ["index.js", "package.json", "README.md", "allowed_users.json", "bot_config.json", ".github", "local_bot_api.js", "userbot-login.js", "userbot_zip1_move_friend"].filter(v => fs.existsSync(path.join(__dirname, v)));
}

async function createScriptBackup() {
  ensureDir(path.join(__dirname, "backups"));
  const name = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
  const out = path.join(__dirname, "backups", name);
  const targets = backupTargets().map(v => `"${v}"`).join(" ");
  if (!targets) throw new Error("Tidak ada file yang bisa dibackup.");
  runShell(`zip -qr9 "${out}" ${targets} -x '*node_modules*' '*.git*' 'backups/*' 'bot-builds/*'`, __dirname);
  return { path: out, name, size: fs.statSync(out).size };
}

function listBackups() {
  const dir = path.join(__dirname, "backups");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^backup-.*\.zip$/i.test(f)).sort().reverse();
}

async function restoreBackup(name) {
  const safe = safeFileBase(name);
  const file = path.join(__dirname, "backups", safe);
  if (!fs.existsSync(file)) throw new Error("Backup tidak ditemukan.");
  execFileSync("unzip", ["-q", "-o", file, "-d", __dirname], { stdio: "ignore" });
  return safe;
}

async function applyRemoteConfig() {
  const url = String(BOT_CONFIG.remote_config_url || process.env.REMOTE_CONFIG_URL || "").trim();
  if (!url) throw new Error("REMOTE_CONFIG_URL belum diisi.");
  const { data } = await axios.get(url, { timeout: 15000, validateStatus: s => s >= 200 && s < 300 });
  const remote = typeof data === "string" ? JSON.parse(data) : data;
  const allowed = ["max_zip_mb", "max_apk_send_mb", "telegram_download_limit_mb", "license_url", "license_key"];
  for (const k of allowed) if (remote[k] !== undefined) BOT_CONFIG[k] = remote[k];
  saveBotConfig();
  return remote;
}

async function checkOnlineLicense() {
  const url = String(BOT_CONFIG.license_url || process.env.LICENSE_URL || "").trim();
  const key = String(BOT_CONFIG.license_key || process.env.LICENSE_KEY || "").trim();
  if (!url) return { ok: true, message: "License URL belum diisi, mode offline." };
  const { data } = await axios.get(url, { params: { key }, timeout: 15000, validateStatus: s => s >= 200 && s < 500 });
  const payload = typeof data === "string" ? JSON.parse(data) : data;
  const ok = payload.ok === true || payload.valid === true || payload.status === "active";
  return { ok, message: payload.message || payload.status || (ok ? "License aktif" : "License tidak aktif"), payload };
}

function dashboardText() {
  const uptime = Math.floor(process.uptime());
  const mins = Math.floor(uptime / 60);
  const mem = process.memoryUsage();
  const backups = listBackups();
  let text = `📊 *Dashboard Status*\n\n` +
    `Runtime: *Aktif ✅*\n` +
    `Uptime: *${mins} menit*\n` +
    `Memory: *${mb(mem.rss)} MB*\n` +
    `Node: \`${process.version}\`\n` +
    `Max ZIP: *${getMaxZipMb()} MB*\n` +
    `Max APK: *${getMaxApkSendMb()} MB*\n` +
    `Userbot: *${userbotClient ? "Aktif ✅" : "Belum aktif ❌"}*\n` +
    `Backup: *${backups.length} file*\n` +
    `Remote Config: ${BOT_CONFIG.remote_config_url ? "*Ada ✅*" : "belum diisi"}\n` +
    `License Online: ${BOT_CONFIG.license_url ? "*Ada ✅*" : "belum diisi"}`;

  if (repoPool) {
    const pool = repoPool.getPoolStatus();
    text += `\n\n🔄 *Repo Pool (${pool.length} repo):*\n`;
    for (const p of pool) {
      text += `• \`${p.repo}\`: ${p.busy ? `🔴 Sibuk (${p.elapsed}s)` : "🟢 Kosong"}\n`;
    }
  }
  return text;
}

async function runAutoFix() {
  ensureDir(path.join(__dirname, "backups"));
  if (!fs.existsSync(ACCESS_FILE)) saveAllowedUsers();
  saveBotConfig();
  const workflow = await autoSetupWorkflow();
  let npmLog = "npm install dilewati";
  try { npmLog = runShell("npm install --omit=dev", __dirname).slice(-2500); } catch (e) { npmLog = sanitizePrivateText(String(e.stderr || e.message || e)).slice(-2500); }
  return `Workflow: ${workflow.status}\n\nNPM:\n${npmLog}`;
}

async function runAutoUpdate() {
  await createScriptBackup();
  const cmd = String(BOT_CONFIG.update_command || process.env.UPDATE_COMMAND || "git pull --ff-only && npm install --omit=dev").trim();
  if (!cmd) throw new Error("UPDATE_COMMAND kosong.");
  return runShell(cmd, __dirname).slice(-3500);
}

async function downloadApkFromRunArtifact(runId, buildId, targetRepo) {
  if (!runId) throw new Error("Run ID build tidak ditemukan, jadi APK tidak bisa diambil dengan aman.");
  const repo = targetRepo || (repoPool ? repoPool.getRepoForBuild(buildId) : GITHUB_REPO);

  cleanupOldBuildTmpFiles();

  const { data } = await axios.get(
    `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/runs/${runId}/artifacts?per_page=50`,
    { headers: GH_HEADERS }
  );
  const artifacts = data.artifacts || [];
  const artifact = artifacts.find(a => a.name === `APK-${buildId}`) || artifacts.find(a => String(a.name || "").startsWith("APK-"));
  if (!artifact) throw new Error(`Artifact APK untuk build ${buildId} tidak ditemukan.`);

  const tmpZip = path.join(os.tmpdir(), `apk-artifact-${buildId}.zip`);

  try {
    const res = await axios.get(
      artifact.archive_download_url,
      { headers: { ...GH_HEADERS, Accept: "application/vnd.github+json" }, responseType: "arraybuffer", maxRedirects: 5 }
    );

    const artifactBuffer = Buffer.from(res.data);
    const freeBefore = getFreeTmpBytes();
    if (freeBefore && freeBefore < artifactBuffer.length + (20 * 1024 * 1024)) {
      cleanupOldBuildTmpFiles();
      const freeAfter = getFreeTmpBytes();
      if (freeAfter && freeAfter < artifactBuffer.length + (20 * 1024 * 1024)) {
        throw new Error(`Storage /tmp hampir penuh. Free ${mb(freeAfter)} MB, artifact ${mb(artifactBuffer.length)} MB. Hapus file lama di server lalu ulangi build.`);
      }
    }

    fs.writeFileSync(tmpZip, artifactBuffer);

    // Jangan extract semua isi artifact ke folder /tmp.
    // Langsung baca nama APK di dalam ZIP lalu keluarkan hanya file APK itu.
    // Ini mencegah error: write error (disk full?) karena sebelumnya ZIP + folder extract + copy APK memakan storage dobel/tripel.
    const list = execFileSync("unzip", ["-Z1", tmpZip], { encoding: "utf8", maxBuffer: 1024 * 1024 }).split(/\r?\n/);
    const apkEntry = list.find(v => /\.apk$/i.test(v.trim()));
    if (!apkEntry) throw new Error("File APK tidak ditemukan di artifact build.");

    const apkName = safeFileBase(path.basename(apkEntry));
    const finalPath = path.join(os.tmpdir(), `${buildId}-${apkName}`);
    const apkData = execFileSync("unzip", ["-p", tmpZip, apkEntry], { encoding: "buffer", maxBuffer: 1024 * 1024 * 300 });
    fs.writeFileSync(finalPath, apkData);

    return {
      apkPath: finalPath,
      apkName: path.basename(finalPath),
      apkSize: fs.statSync(finalPath).size,
      artifactName: artifact.name,
    };
  } finally {
    try { if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip); } catch {}
  }
}

async function deleteGithubFileSafe(repoFilePath, targetRepo) {
  const repo = targetRepo || GITHUB_REPO;
  try {
    const branch = await getDefaultBranch(repo);
    const safeRepoPath = String(repoFilePath).replace(/^\/+/, "");
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${encodeURI(safeRepoPath).replace(/%2F/g, "/")}`;
    const res = await axios.get(apiUrl, { headers: GH_HEADERS, params: { ref: branch } });
    await axios.delete(apiUrl, {
      headers: GH_HEADERS,
      data: {
        message: "bot: cleanup ZIP build temporary",
        sha: res.data.sha,
        branch,
      },
    });
  } catch (e) {
    console.error(`Cleanup ZIP GitHub gagal (repo ${repo}):`, sanitizePrivateText(e.message));
  }
}

async function listGithubZipFiles(dir = "bot-builds", targetRepo) {
  const repo = targetRepo || GITHUB_REPO;
  const branch = await getDefaultBranch(repo);
  const safeDir = String(dir || "").replace(/^\/+|\/+$|\.\./g, "");
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${encodeURI(safeDir).replace(/%2F/g, "/")}`;
  try {
    const { data } = await axios.get(apiUrl, { headers: GH_HEADERS, params: { ref: branch } });
    const items = Array.isArray(data) ? data : [data];
    const result = [];
    for (const item of items) {
      if (item.type === "dir") {
        result.push(...await listGithubZipFiles(item.path, repo));
      } else if (item.type === "file" && /\.zip$/i.test(item.name || item.path || "")) {
        result.push({ path: item.path, sha: item.sha });
      }
    }
    return result;
  } catch (e) {
    if (e.response?.status === 404) return [];
    throw e;
  }
}

async function deleteAllFlutterZipFromGithub() {
  let totalDeleted = 0;
  let totalFiles = 0;
  const allRepos = repoPool ? repoPool.getAllRepos() : [GITHUB_REPO];
  for (const repo of allRepos) {
    const branch = await getDefaultBranch(repo);
    const files = await listGithubZipFiles("bot-builds", repo);
    totalFiles += files.length;
    for (const file of files) {
      try {
        const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${encodeURI(file.path).replace(/%2F/g, "/")}`;
        await axios.delete(apiUrl, {
          headers: GH_HEADERS,
          data: {
            message: "bot: admin cleanup all Flutter ZIP builds",
            sha: file.sha,
            branch,
          },
        });
        totalDeleted++;
        await new Promise(r => setTimeout(r, 250));
      } catch (e) {
        console.error(`Gagal hapus ZIP GitHub (${repo}):`, sanitizePrivateText(`${file.path}: ${e.message}`));
      }
    }
  }
  return { deleted: totalDeleted, total: totalFiles };
}


let userbotClient = null;

function updateEnvValue(key, value) {
  const envPath = path.join(__dirname, ".env");
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const line = `${key}=${String(value).replace(/\n/g, "").trim()}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(env)) env = env.replace(re, line);
  else env += (env.endsWith("\n") || env.length === 0 ? "" : "\n") + line + "\n";
  fs.writeFileSync(envPath, env);
  process.env[key] = String(value).trim();
}

function askPanel(question) {
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function createUserbotSessionFromPanel(TelegramClient, StringSession) {
  if (!USERBOT_PANEL_LOGIN || !USERBOT_PHONE) return "";
  if (!USERBOT_API_ID || !USERBOT_API_HASH) {
    console.log("👤 Userbot panel login gagal: USERBOT_API_ID/API_HASH belum lengkap.");
    return "";
  }
  console.log("");
  console.log("👤 USERBOT PANEL LOGIN AKTIF");
  console.log("📱 Nomor:", USERBOT_PHONE);
  console.log("➡️  Telegram akan mengirim kode ke akun itu. Isi kode di Console/Panel server.");
  const client = new TelegramClient(new StringSession(""), USERBOT_API_ID, USERBOT_API_HASH, { connectionRetries: 5 });
  await client.start({
    phoneNumber: async () => USERBOT_PHONE,
    phoneCode: async () => askPanel("Masukkan kode Telegram userbot dari panel: "),
    password: async () => askPanel("Masukkan password 2FA Telegram jika ada, kalau tidak ada kosongkan: "),
    onError: err => console.log("Userbot login error:", err.message),
  });
  const session = client.session.save();
  updateEnvValue("USERBOT_STRING_SESSION", session);
  updateEnvValue("USERBOT_PANEL_LOGIN", "false");
  console.log("✅ USERBOT_STRING_SESSION berhasil dibuat dan disimpan ke .env");
  return session;
}

async function initUserbot() {
  USERBOT_STRING_SESSION = (process.env.USERBOT_STRING_SESSION || "").trim();
  USERBOT_API_ID = Number(process.env.USERBOT_API_ID || process.env.TELEGRAM_API_ID || 0);
  USERBOT_API_HASH = (process.env.USERBOT_API_HASH || process.env.TELEGRAM_API_HASH || "").trim();

  try {
    const { TelegramClient } = await import("telegram");
    const { StringSession } = await import("telegram/sessions/index.js");

    if (!USERBOT_STRING_SESSION) {
      USERBOT_STRING_SESSION = await createUserbotSessionFromPanel(TelegramClient, StringSession);
    }

    if (!USERBOT_STRING_SESSION) {
      console.log("👤 Userbot: belum ada session. Isi USERBOT_STRING_SESSION atau pakai USERBOT_PANEL_LOGIN=true + USERBOT_PHONE.");
      return;
    }
    if (!USERBOT_API_ID || !USERBOT_API_HASH) {
      console.log("👤 Userbot: USERBOT_API_ID/API_HASH belum lengkap.");
      return;
    }

    userbotClient = new TelegramClient(
      new StringSession(USERBOT_STRING_SESSION),
      USERBOT_API_ID,
      USERBOT_API_HASH,
      { connectionRetries: 5, autoReconnect: true }
    );
    await userbotClient.connect();
    if (!(await userbotClient.checkAuthorization())) {
      userbotClient = null;
      console.log("👤 Userbot: string session tidak valid / belum login.");
      return;
    }
    console.log("👤 Userbot: aktif untuk kirim APK sebagai file.");
  } catch (e) {
    userbotClient = null;
    console.log("👤 Userbot gagal start:", e.message);
  }
}

function userbotStatusText() {
  return (
    `👤 *Status Userbot*\n\n` +
    `Status: *${userbotClient ? "Aktif ✅" : "Belum aktif ❌"}*\n` +
    `API ID: ${USERBOT_API_ID ? "terisi ✅" : "kosong ❌"}\n` +
    `API HASH: ${USERBOT_API_HASH ? "terisi ✅" : "kosong ❌"}\n` +
    `String Session: ${USERBOT_STRING_SESSION ? "terisi ✅" : "kosong ❌"}\n\n` +
    `*Cara login userbot lewat panel:*\n` +
    `1. Isi di .env: \`USERBOT_PHONE=+62xxxx\`\n` +
    `2. Isi: \`USERBOT_PANEL_LOGIN=true\`\n` +
    `3. Restart server / npm start\n` +
    `4. Kode Telegram akan diminta di Console/Panel server\n\n` +
    `Atau jalankan: \`npm run userbot:login\` lalu copy session otomatis tersimpan ke .env.`
  );
}

async function sendApkViaUserbot(chatId, apk) {
  if (!userbotClient) return { ok: false, reason: "Userbot belum aktif" };
  try {
    const sizeMB = mb(apk.apkSize);
    await userbotClient.sendFile(chatId, {
      file: apk.apkPath,
      caption: `🎉 APK Siap!\n\n📱 ${apk.apkName}\n💾 ${sizeMB} MB\n\nDikirim otomatis via userbot.`,
      forceDocument: true,
    });
    return { ok: true };
  } catch (e) {
    console.error("Kirim APK via userbot gagal:", e.message);
    return { ok: false, reason: e.message };
  }
}

async function sendApkToUserSafe(chatId, apk) {
  const sizeMB = mb(apk.apkSize);

  // Prioritas sesuai request: kirim APK memakai userbot sebagai FILE, bukan link.
  const viaUserbot = await sendApkViaUserbot(chatId, apk);
  if (viaUserbot.ok) return { sentFile: true, via: "userbot" };

  // Fallback aman: kalau userbot belum aktif/gagal resolve user, bot tetap coba kirim file.
  try {
    await bot.sendDocument(
      chatId,
      fs.createReadStream(apk.apkPath),
      {
        caption:
          `🎉 *APK Siap!*

` +
          `📱 \`${apk.apkName}\`
` +
          `💾 ${sizeMB} MB

` +
          `⚠️ Userbot gagal mengirim (${escapeMd(viaUserbot.reason || "unknown")}), jadi bot mengirim file langsung.`,
        parse_mode: "Markdown",
      },
      {
        filename: apk.apkName,
        contentType: "application/vnd.android.package-archive",
      }
    );
    return { sentFile: true, via: "bot" };
  } catch (err) {
    if (!isTelegramFileTooBigError(err)) throw err;
    await sendMsg(chatId,
      `✅ *Build Sukses!*

` +
      `📱 APK: \`${apk.apkName}\`
` +
      `💾 Size: ${sizeMB} MB

` +
      `❌ APK berhasil dibuat, tetapi gagal dikirim sebagai file oleh userbot dan bot karena batas Telegram/server.\n` +
      `Aktifkan USERBOT_STRING_SESSION yang valid atau Local Telegram Bot API agar bisa kirim file besar langsung.`,
      { reply_markup: afterBuildFallback() }
    );
    return { sentFile: false, via: "none" };
  }
}

// ────────────────────────────────────────────────────────────
//  PROSES BUILD UTAMA (MULTI-REPO)
// ────────────────────────────────────────────────────────────
async function runBuild(chatId, msgId, fileName) {
  let localPath;
  let zipRepoPath;
  let buildRepo;
  try {
    const state = userState.get(chatId);
    if (!state?.zipBuffer) throw new Error("Data ZIP hilang. Kirim ulang file ZIP.");

    const buildId = createBuildId(chatId);
    const safeName = safeFileBase(fileName || state.fileName || "project.zip");
    zipRepoPath = `bot-builds/${buildId}/${safeName}`;

    // Pilih repo dari pool (otomatis pindah ke repo kosong jika yang lain sibuk)
    buildRepo = repoPool ? repoPool.acquireRepo(buildId) : GITHUB_REPO;

    // 1. Upload ZIP ke build storage
    await editMsg(chatId, msgId,
      `☁️ *Menyiapkan file build...*

` +
      `🆔 Build ID: \`${buildId}\`
` +
      `📦 Repo: \`${buildRepo}\`
` +
      `Source disimpan aman dan tidak ditampilkan ke user.`);

    localPath = path.join(os.tmpdir(), `${buildId}-${safeName}`);
    fs.writeFileSync(localPath, state.zipBuffer);
    userState.delete(chatId);
    await uploadZipToGithub(localPath, zipRepoPath, buildRepo);

    // 2. Trigger workflow build
    await editMsg(chatId, msgId,
      `🚀 *Memulai proses build...*

` +
      `🆔 Build ID: \`${buildId}\`
` +
      `📦 Repo: \`${buildRepo}\`
` +
      `Workflow sudah dipicu secara aman.`);
    const workflowStartedAt = Date.now();
    await triggerWorkflow(zipRepoPath, buildId, state.flutterVersion || "auto", buildRepo);
    await new Promise(r => setTimeout(r, 5000));

    // 3. Polling build
    await editMsg(chatId, msgId,
      `🏗️ *Build Berjalan...*

` +
      `🆔 Build ID: \`${buildId}\`
` +
      `📦 Repo: \`${buildRepo}\`
` +
      `⏳ Antrian runner...

` +
      `_Mohon tunggu sampai APK selesai dibuat._`);

    const { ok, runId, timeout, repo: usedRepo } = await waitForBuild(chatId, msgId, buildId, workflowStartedAt, buildRepo);

    if (timeout) {
      const detail = runId ? await getRunSafeLog(runId, usedRepo) : "Build melewati batas waktu. Detail run belum tersedia.";
      await editMsg(chatId, msgId, `⏰ *Build Timeout!*

Mengirim log error lengkap yang sudah disensor...`, afterFail());
      return sendLongSafeLog(chatId, "📄 *Log Error Build*", detail, afterFail());
    }

    if (!ok) {
      const detail = await getRunSafeLog(runId, usedRepo);
      await editMsg(chatId, msgId, `❌ *Build Gagal!*

Mengirim log error lengkap yang sudah disensor...`, afterFail());
      return sendLongSafeLog(chatId, "📄 *Log Error Build*", detail, afterFail());
    }

    // 4. Download APK
    await editMsg(chatId, msgId, `✅ *Build Sukses! Mengunduh APK...*`);
    const apk = await downloadApkFromRunArtifact(runId, buildId, usedRepo);

    // 5. Kirim APK sebagai file
    await editMsg(chatId, msgId, `📤 *Mengirim APK ke user...*`);
    const sent = await sendApkToUserSafe(chatId, apk);

    await editMsg(chatId, msgId,
      sent.sentFile
        ? `✅ *Selesai!* APK telah dikirim langsung ke user sebagai file via *${sent.via}*.`
        : `✅ *Selesai!* APK sudah berhasil dibuat, tetapi gagal dikirim sebagai file.`,
      sent.sentFile ? afterBuildFile() : afterBuildFallback());

    if (fs.existsSync(apk.apkPath)) fs.unlinkSync(apk.apkPath);

  } catch (err) {
    console.error("runBuild error:", sanitizePrivateText(err.message));
    sendLongSafeLog(chatId, "❌ *Error:*", errorDetails(err), afterFail()).catch(() => {});
  } finally {
    if (localPath && fs.existsSync(localPath)) fs.unlinkSync(localPath);
    if (zipRepoPath) deleteGithubFileSafe(zipRepoPath, buildRepo).catch(() => {});
    if (buildRepo && repoPool) repoPool.releaseRepo(buildRepo);
  }
}

// ════════════════════════════════════════════════════════════
//  /start & /menu
// ════════════════════════════════════════════════════════════
bot.onText(/\/(start|menu)/, async (msg) => {
  const uid = msg.from.id;
  const allowed = isAllowed(uid);
  const name = msg.from.first_name || "Pengguna";

  await notifyAdmins(
    `📥 *User Start Bot*\n\n${tgUserText(msg.from)}\nStatus: ${allowed ? "✅ Diizinkan" : "⏳ Belum diizinkan"}\n\n` +
    `Untuk add user:\n\`/adduser ${uid}\``
  );

  if (!allowed) {
    return sendMsg(msg.chat.id,
      `⛔ *Akses belum diizinkan.*\n\n` +
      `ID kamu: \`${uid}\`\n` +
      `Silakan minta admin add user kamu dulu.`
    );
  }

  return sendStartMenu(msg.chat.id, name, uid);
});

bot.onText(/\/adduser(?:\s+(.+))?/, async (msg, match) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const id = parseInt((match[1] || "").trim(), 10);
  if (!id) return sendMsg(msg.chat.id, "Format: `/adduser 123456789`");
  ALLOWED_USER_SET.add(id);
  saveAllowedUsers();
  await sendMsg(msg.chat.id, `✅ User \`${id}\` berhasil di-add dan sudah bisa memakai bot.`);
  try { await sendMsg(id, "✅ Akses kamu sudah diizinkan admin. Kirim /start untuk mulai memakai bot."); } catch {}
});

bot.onText(/\/deluser(?:\s+(.+))?/, async (msg, match) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const id = parseInt((match[1] || "").trim(), 10);
  if (!id) return sendMsg(msg.chat.id, "Format: `/deluser 123456789`");
  if (isAdmin(id)) return sendMsg(msg.chat.id, "❌ Admin tidak bisa dihapus dari akses lewat /deluser.");
  ALLOWED_USER_SET.delete(id);
  saveAllowedUsers();
  await sendMsg(msg.chat.id, `✅ User \`${id}\` berhasil dihapus dari akses bot.`);
});

bot.onText(/\/users/, async (msg) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const users = [...ALLOWED_USER_SET].sort((a, b) => a - b);
  const list = users.length ? users.map(id => `• \`${id}\`${isAdmin(id) ? " *(admin)*" : ""}`).join("\n") : "Belum ada user.";
  await sendMsg(msg.chat.id, `👥 *User yang boleh memakai bot:*\n\n${list}`);
});

// ════════════════════════════════════════════════════════════
//  WEB PANEL — Kelola user panel lewat Telegram
// ════════════════════════════════════════════════════════════
bot.onText(/\/addwebuser(?:\s+(.+))?/, async (msg, match) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const id = (match?.[1] || "").trim();
  if (!id || isNaN(Number(id))) return sendMsg(msg.chat.id, "Format: `/addwebuser 123456789`");
  try {
    const { userId, password } = addWebUser(id);
    const panelUrl = WEB_PANEL_PUBLIC_URL || `http://vinzvpsmakeksendiri.danzxnstore.my.id:${process.env.WEB_PANEL_PORT || 10882}/login`;
    await sendMsg(msg.chat.id,
      `✅ *Web User Ditambahkan!*\n\n👤 User ID: \`${userId}\`\n🔑 Password: \`${password}\`\n🌐 Panel: ${panelUrl}\n\n⚠️ Kirim password ke user sekarang, tidak bisa tampil lagi.`);
  } catch(e) { await sendMsg(msg.chat.id, `❌ Gagal: \`${e.message}\``); }
});

bot.onText(/\/delwebuser(?:\s+(.+))?/, async (msg, match) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const id = (match?.[1] || "").trim();
  if (!id) return sendMsg(msg.chat.id, "Format: `/delwebuser 123456789`");
  const removed = removeWebUser(id);
  await sendMsg(msg.chat.id, removed ? `✅ Web user \`${id}\` dihapus.` : `❌ User \`${id}\` tidak ditemukan.`);
});

bot.onText(/\/webusers/, async (msg) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const users = listWebUsers();
  const entries = Object.entries(users);
  if (!entries.length) return sendMsg(msg.chat.id, "Belum ada web user.");
  await sendMsg(msg.chat.id, `🌐 *Web Panel Users:*\n\n${entries.map(([uid]) => "• `" + uid + "`").join("\n")}`);
});

// Hapus seluruh ZIP Flutter sementara di GitHub. Admin only.
bot.onText(/\/hapuszip(?:\s+(.+))?/, async (msg, match) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const arg = String(match?.[1] || "").trim().toLowerCase();
  if (!["ya", "yes", "confirm", "konfirmasi"].includes(arg)) {
    return sendMsg(msg.chat.id,
      `⚠️ *Konfirmasi hapus ZIP Flutter di GitHub*\n\n` +
      `Command ini akan menghapus semua file \`.zip\` di folder \`bot-builds/\`.\n` +
      `APK/release/workflow tidak ikut dihapus.\n\n` +
      `Ketik: \`/hapuszip ya\``);
  }

  const waitMsg = await sendMsg(msg.chat.id, "🧹 Menghapus seluruh ZIP Flutter di GitHub...");
  try {
    const result = await deleteAllFlutterZipFromGithub();
    await editMsg(msg.chat.id, waitMsg.message_id,
      `✅ *Cleanup selesai!*\n\n` +
      `ZIP ditemukan: *${result.total}*\n` +
      `Berhasil dihapus: *${result.deleted}*\n\n` +
      `Command ini hanya bisa dipakai admin.`);
  } catch (e) {
    await editMsg(msg.chat.id, waitMsg.message_id,
      `❌ Gagal hapus ZIP GitHub:\n\n\`\`\`\n${escapeMd(sanitizePrivateText(e.message || e))}\n\`\`\``);
  }
});

// ════════════════════════════════════════════════════════════
//  CONFIG COMMANDS — admin runtime config (limit ukuran file)
// ════════════════════════════════════════════════════════════
bot.onText(/\/config\b/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  await sendMsg(msg.chat.id, formatConfigSnapshot());
});

function parseSizeArg(text = "") {
  const n = Number(String(text).trim().replace(/[^0-9.]/g, ""));
  if (!isFinite(n) || n <= 0) return null;
  return n;
}

async function applyLimitChange(msg, key, label, raw, { hardMax = 2000 } = {}) {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const value = parseSizeArg(raw);
  if (value === null) {
    return sendMsg(msg.chat.id,
      `Format salah. Contoh:\n\`/setmaxzip 50\`\n\nNilai harus angka MB (boleh desimal), > 0.`);
  }
  if (value > hardMax) {
    return sendMsg(msg.chat.id, `❌ Nilai *${value} MB* terlalu besar. Maks *${hardMax} MB*.`);
  }
  BOT_CONFIG[key] = value;
  saveBotConfig();
  await sendMsg(msg.chat.id,
    `✅ *${label}* diubah ke *${value} MB*.\n\n${formatConfigSnapshot()}`);
}

bot.onText(/\/setmaxzip(?:\s+(.+))?/, async (msg, match) => {
  await applyLimitChange(msg, "max_zip_mb", "MAX_ZIP_MB", match?.[1] || "");
});

bot.onText(/\/setmaxapk(?:\s+(.+))?/, async (msg, match) => {
  await applyLimitChange(msg, "max_apk_send_mb", "MAX_APK_SEND_MB", match?.[1] || "");
});

bot.onText(/\/setdllimit(?:\s+(.+))?/, async (msg, match) => {
  await applyLimitChange(msg, "telegram_download_limit_mb", "TELEGRAM_DOWNLOAD_LIMIT_MB", match?.[1] || "");
});

bot.onText(/\/resetconfig\b/, async (msg) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  BOT_CONFIG = defaultBotConfig();
  saveBotConfig();
  await sendMsg(msg.chat.id, `🔄 *Config bot direset ke nilai .env.*\n\n${formatConfigSnapshot()}`);
});

// ════════════════════════════════════════════════════════════
//  ADMIN TOOLS — Auto Update, Backup, Fix, License, Config, Rollback, Dashboard
// ════════════════════════════════════════════════════════════
bot.onText(/\/dashboard\b/, async (msg) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  await sendMsg(msg.chat.id, dashboardText());
});

bot.onText(/\/backup\b/, async (msg) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const m = await sendMsg(msg.chat.id, "💾 *Membuat backup script...*");
  try {
    const b = await createScriptBackup();
    await bot.editMessageText(`✅ *Backup berhasil!*\n\nFile: \`${b.name}\`\nSize: *${mb(b.size)} MB*`, { chat_id: msg.chat.id, message_id: m.message_id, parse_mode: "Markdown" }).catch(() => {});
    if (b.size <= getMaxApkSendMb() * 1024 * 1024) {
      await bot.sendDocument(msg.chat.id, fs.createReadStream(b.path), {}, { filename: b.name, contentType: "application/zip" }).catch(() => {});
    }
  } catch (e) {
    await sendMsg(msg.chat.id, `❌ Backup gagal:\n\`${escapeMd(e.message)}\``);
  }
});

bot.onText(/\/rollback(?:\s+(.+))?/, async (msg, match) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const arg = (match?.[1] || "").trim();
  if (!arg) {
    const list = listBackups().slice(0, 10);
    return sendMsg(msg.chat.id, `♻️ *Rollback Version*\n\n${list.length ? list.map((v,i)=>`${i+1}. \`${v}\``).join("\n") : "Belum ada backup."}\n\nPakai: \`/rollback nama_backup.zip\``);
  }
  try {
    const restored = await restoreBackup(arg);
    await sendMsg(msg.chat.id, `✅ Rollback berhasil dari \`${restored}\`.\nRestart server supaya semua perubahan aktif.`);
  } catch (e) {
    await sendMsg(msg.chat.id, `❌ Rollback gagal:\n\`${escapeMd(e.message)}\``);
  }
});

bot.onText(/\/autofix\b/, async (msg) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const m = await sendMsg(msg.chat.id, "🛠️ *Auto Fix Error berjalan...*");
  try {
    const log = await runAutoFix();
    await sendLongSafeLog(msg.chat.id, "✅ *Auto Fix selesai:*", log);
    await bot.deleteMessage(msg.chat.id, m.message_id).catch(() => {});
  } catch (e) {
    await sendMsg(msg.chat.id, `❌ Auto Fix gagal:\n\`${escapeMd(e.message)}\``);
  }
});

bot.onText(/\/autoupdate\b/, async (msg) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const m = await sendMsg(msg.chat.id, "⬆️ *Auto Update Script berjalan...*\nBackup otomatis dibuat sebelum update.");
  try {
    const log = await runAutoUpdate();
    await sendLongSafeLog(msg.chat.id, "✅ *Auto Update selesai:*", log || "Update selesai. Restart server jika diperlukan.");
    await bot.deleteMessage(msg.chat.id, m.message_id).catch(() => {});
  } catch (e) {
    await sendMsg(msg.chat.id, `❌ Auto Update gagal:\n\`${escapeMd(e.message)}\``);
  }
});

bot.onText(/\/remoteconfig(?:\s+(.+))?/, async (msg, match) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const url = (match?.[1] || "").trim();
  if (url) {
    BOT_CONFIG.remote_config_url = url;
    saveBotConfig();
  }
  try {
    const cfg = await applyRemoteConfig();
    await sendMsg(msg.chat.id, `✅ *Remote Config diterapkan.*\n\n\`\`\`json\n${JSON.stringify(cfg, null, 2).slice(0, 2500)}\n\`\`\``);
  } catch (e) {
    await sendMsg(msg.chat.id, `❌ Remote Config gagal:\n\`${escapeMd(e.message)}\`\n\nFormat: \`/remoteconfig https://domain/config.json\``);
  }
});

bot.onText(/\/license(?:\s+(.+))?/, async (msg, match) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  const arg = (match?.[1] || "").trim();
  if (arg) {
    if (/^https?:\/\//i.test(arg)) BOT_CONFIG.license_url = arg;
    else BOT_CONFIG.license_key = arg;
    saveBotConfig();
  }
  try {
    const res = await checkOnlineLicense();
    await sendMsg(msg.chat.id, `${res.ok ? "✅" : "❌"} *License Online*\n\nStatus: *${res.ok ? "Aktif" : "Tidak aktif"}*\nPesan: ${escapeMd(res.message)}\n\nSet URL: \`/license https://domain/license.json\`\nSet Key: \`/license KEY-KAMU\``);
  } catch (e) {
    await sendMsg(msg.chat.id, `❌ Cek license gagal:\n\`${escapeMd(e.message)}\``);
  }
});

bot.onText(/\/kecilzip\b/, async (msg) => {
  if (!adminOnly(msg.chat.id, msg.from.id)) return;
  userState.set(msg.chat.id, { waitingForZip: true, adminOptimizeOnly: true });
  await sendMsg(msg.chat.id, "📦 Kirim ZIP Flutter yang mau dikecilkan. Bot akan buang cache seperti `build/`, `.dart_tool/`, `.git/`, `node_modules/`, file APK/AAB/log, lalu kompres ulang.");
});

// ════════════════════════════════════════════════════════════
//  CALLBACK QUERY — semua interaksi button
// ════════════════════════════════════════════════════════════
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const msgId  = q.message.message_id;
  const data   = q.data;

  await bot.answerCallbackQuery(q.id).catch(() => {});

  if (!isAllowed(q.from.id)) {
    return bot.answerCallbackQuery(q.id, { text: "⛔ Akses ditolak!", show_alert: true });
  }

  // ── Kembali ke menu ───────────────────────────────────────
  if (data === "menu_home") {
    return editMsg(chatId, msgId, "🏠 *Menu Utama*\n\nPilih aksi:", mainMenu(q.from.id));
  }

  // ── Build APK (mulai waiting) ─────────────────────────────
  if (data === "menu_build") {
    userState.set(chatId, { waitingForZip: true });
    return editMsg(chatId, msgId,
      `📦 *Mode Build APK*\n\n` +
      `Kirim file \.zip project Flutter ke sini sekarang.\n\n` +
      `*Syarat:*\n` +
      `• Ada \`pubspec.yaml\` di dalam ZIP\n` +
      `• Ukuran maks *${getMaxZipMb()} MB*\n` +
      `• Untuk ZIP >20 MB disarankan pakai Local Telegram Bot API\n\n` +
      `_Menunggu file ZIP kamu..._`,
      { inline_keyboard: [[{ text: "❌ Batal", callback_data: "menu_home" }]] }
    );
  }

  // ── Status build ──────────────────────────────────────────
  if (data === "menu_status") {
    await editMsg(chatId, msgId, "🔍 *Mengambil status build...*");
    try {
      const allRepos = repoPool ? repoPool.getAllRepos() : [GITHUB_REPO];
      let allRuns = [];
      for (const repo of allRepos) {
        try {
          const { data: gh } = await axios.get(
            `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/runs?per_page=5`,
            { headers: GH_HEADERS }
          );
          for (const run of (gh.workflow_runs || [])) {
            allRuns.push({ ...run, _repo: repo });
          }
        } catch {}
      }
      allRuns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      if (!allRuns.length) {
        return editMsg(chatId, msgId, "ℹ️ Belum ada build.", backToMenu());
      }

      const ic = { success:"✅", failure:"❌", cancelled:"⛔", in_progress:"🔄", queued:"⏳" };
      let text = `📊 *Status Build (5 Terakhir):*\n\n`;
      allRuns.slice(0, 5).forEach((r, i) => {
        const badge = ic[r.conclusion || r.status] || "❓";
        const date  = new Date(r.created_at).toLocaleString("id-ID",
          { dateStyle:"short", timeStyle:"short" });
        text += `${i+1}. ${badge} \`${r.conclusion || r.status}\`  📅 ${date}  📦 \`${r._repo}\`\n`;
      });

      // Show pool status
      if (repoPool) {
        const pool = repoPool.getPoolStatus();
        text += `\n🔄 *Status Repo Pool:*\n`;
        for (const p of pool) {
          text += `• \`${p.repo}\`: ${p.busy ? `🔴 Sibuk (${p.elapsed}s)` : "🟢 Kosong"}\n`;
        }
      }

      text += `\n_Source/repo/link tidak ditampilkan demi keamanan._`;

      return editMsg(chatId, msgId, text, {
        inline_keyboard: [
          [
            { text: "🔄 Refresh",  callback_data: "menu_status" },
            { text: "🏠 Menu",     callback_data: "menu_home"   },
          ],
        ],
      });
    } catch (err) {
      return editMsg(chatId, msgId, `❌ Gagal: \`${escapeMd(err.message)}\``, backToMenu());
    }
  }

  // ── Release terbaru ───────────────────────────────────────
  if (data === "menu_release") {
    await editMsg(chatId, msgId, "🔍 *Mengambil release terbaru...*");
    try {
      const allRepos = repoPool ? repoPool.getAllRepos() : [GITHUB_REPO];
      let latestRel = null;
      let latestRepo = null;
      for (const repo of allRepos) {
        try {
          const { data: rel } = await axios.get(
            `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/releases/latest`,
            { headers: GH_HEADERS }
          );
          if (!latestRel || new Date(rel.created_at) > new Date(latestRel.created_at)) {
            latestRel = rel;
            latestRepo = repo;
          }
        } catch {}
      }
      if (!latestRel) throw new Error("no releases");

      const apk    = latestRel.assets?.find(a => a.name.endsWith(".apk"));
      const sizeMB = apk ? (apk.size/1024/1024).toFixed(2) : "?";
      const date   = new Date(latestRel.created_at).toLocaleString("id-ID");

      return editMsg(chatId, msgId,
        `🎉 *Release Terbaru:*\n\n` +
        `📌 Tag: \`${latestRel.tag_name}\`\n` +
        `📱 APK: \`${apk?.name || "tidak ada"}\`\n` +
        `💾 Size: ${sizeMB} MB\n` +
        `📅 Tanggal: ${date}\n` +
        `📦 Repo: \`${latestRepo}\``,
        {
          inline_keyboard: [
            [
              { text: "🔄 Refresh", callback_data: "menu_release" },
              { text: "🏠 Menu",    callback_data: "menu_home"    },
            ],
          ],
        }
      );
    } catch {
      return editMsg(chatId, msgId, "ℹ️ Belum ada release.", backToMenu());
    }
  }

  // ── Lihat config limit ────────────────────────────────────
  if (data === "menu_config") {
    const adminHint = isAdmin(q.from.id)
      ? ""
      : "\n\n_Hanya admin yang bisa mengubah limit._";
    return editMsg(chatId, msgId, formatConfigSnapshot() + adminHint, backToMenu());
  }

  // ── Sync workflow manual ──────────────────────────────────
  if (data === "menu_sync") {
    await editMsg(chatId, msgId, "🔄 *Sinkronisasi workflow ke semua repo...*");
    const results = await autoSetupWorkflow();

    let msg;
    if (Array.isArray(results)) {
      const lines = results.map(r => {
        const ic = { uptodate:"✅", updated:"🔄", created:"🆕", error:"❌", create_failed:"❌", not_found:"⚠️" };
        return `${ic[r.status] || "❓"} \`${r.repo}\`: ${r.status}`;
      });
      msg = `🔄 *Hasil Sync Workflow:*\n\n${lines.join("\n")}`;
    } else {
      msg = {
        uptodate: "✅ *Workflow sudah up-to-date!*\n\nTidak perlu update.",
        updated:  "🔄 *Workflow diperbarui!*\n\n`build_apk.yml` sudah di-update.",
        created:  "🆕 *Workflow dibuat!*\n\n`build_apk.yml` baru sudah aktif.",
        error:    `❌ *Gagal:*\n\`${results.message}\``,
      }[results.status] || "❓ Unknown";
    }

    return editMsg(chatId, msgId, msg, backToMenu());
  }

  // ── Bantuan ───────────────────────────────────────────────
  if (data === "menu_help") {
    const adminHelp = isAdmin(q.from.id)
      ? `\n\n*Admin commands:*\n` +
        `• \`/config\` — Lihat batas saat ini\n` +
        `• \`/setmaxzip 50\` — Ubah batas terima ZIP\n` +
        `• \`/setmaxapk 50\` — Ubah batas kirim APK\n` +
        `• \`/setdllimit 50\` — Ubah batas download Bot API\n` +
        `• \`/resetconfig\` — Kembali ke nilai .env\n` +
        `• \`/hapuszip ya\` — Hapus seluruh ZIP Flutter di GitHub
` +
        `• \`/dashboard\` — Dashboard status bot
` +
        `• \`/backup\` — Auto backup script
` +
        `• \`/autofix\` — Auto fix error dasar
` +
        `• \`/autoupdate\` — Auto update script
` +
        `• \`/remoteconfig URL\` — Ambil config online
` +
        `• \`/license\` — Cek license online
` +
        `• \`/rollback\` — Rollback dari backup
` +
        `• \`/kecilzip\` — Kecilkan ZIP Flutter`
      : "";

    return editMsg(chatId, msgId,
      `❓ *Bantuan*\n\n` +
      `*Cara Build APK:*\n` +
      `1. Tekan 🔨 *Build APK*\n` +
      `2. Kirim file \`.zip\` Flutter\n` +
      `3. Tekan ✅ *Konfirmasi*\n` +
      `4. Tunggu 5–15 menit\n` +
      `5. APK dikirim otomatis! 📱\n\n` +
      `*Syarat ZIP:*\n` +
      `• Harus ada \`pubspec.yaml\`\n` +
      `• Maks ${getMaxZipMb()} MB\n` +
      `• ZIP 20–50 MB perlu Local Telegram Bot API agar tidak \`file is too big\`\n\n` +
      `*Menu:*\n` +
      `• 📊 Status — Cek build terakhir\n` +
      `• 📱 Release — APK terbaru\n` +
      `• ☁️ Sync — Sinkronisasi workflow\n` +
      `• ⚙️ Config Limit — Lihat / ubah batas ukuran file` + adminHelp,
      backToMenu()
    );
  }

  // ── Info bot ──────────────────────────────────────────────
  if (data === "menu_info") {
    return editMsg(chatId, msgId,
      `ℹ️ *Flutter Build Bot v2.0*

` +
      `🐦 Flutter: \`3.22.0\`
` +
      `☕ Java: \`17 Temurin\`
` +
      `🟢 Auto-sync workflow: *Aktif*
` +
      `🔒 Source/repo/link tidak ditampilkan ke user.

` +
      `_ZIP → Build → APK → Telegram_`,
      backToMenu()
    );
  }


  // ── Admin panel ─────────────────────────────────────────────
  if (data === "menu_admin") {
    if (!isAdmin(q.from.id)) {
      return bot.answerCallbackQuery(q.id, { text: "⛔ Admin only", show_alert: true }).catch(() => {});
    }
    return editMsg(chatId, msgId,
      `🛡️ *Admin Panel*\n\n` +
      `✅ Auto Update Script: \`/autoupdate\`\n` +
      `✅ Auto Backup: \`/backup\`\n` +
      `✅ Auto Fix Error: \`/autofix\`\n` +
      `✅ License Online: \`/license\`\n` +
      `✅ Remote Config: \`/remoteconfig URL\`\n` +
      `✅ Rollback Version: \`/rollback\`\n` +
      `✅ Dashboard Status: \`/dashboard\`\n` +
      `✅ Kecilkan ZIP Flutter: \`/kecilzip\`\n\n` +
      `_Semua fitur di atas hanya bisa dipakai admin._`,
      { inline_keyboard: [
        [{ text: "📊 Dashboard", callback_data: "admin_dashboard" }],
        [{ text: "💾 Backup", callback_data: "admin_backup" }, { text: "🛠️ Auto Fix", callback_data: "admin_autofix" }],
        [{ text: "📦 Kecilkan ZIP", callback_data: "admin_kecilzip" }, { text: "🏠 Menu", callback_data: "menu_home" }],
      ] }
    );
  }

  if (data === "admin_dashboard") {
    if (!isAdmin(q.from.id)) return bot.answerCallbackQuery(q.id, { text: "⛔ Admin only", show_alert: true }).catch(() => {});
    return editMsg(chatId, msgId, dashboardText(), backToMenu());
  }

  if (data === "admin_kecilzip") {
    if (!isAdmin(q.from.id)) return bot.answerCallbackQuery(q.id, { text: "⛔ Admin only", show_alert: true }).catch(() => {});
    userState.set(chatId, { waitingForZip: true, adminOptimizeOnly: true });
    return editMsg(chatId, msgId, "📦 *Kecilkan ZIP Flutter*\n\nKirim ZIP Flutter yang mau dioptimasi. Cache/build akan dibuang lalu ZIP dikompres ulang.", { inline_keyboard: [[{ text: "❌ Batal", callback_data: "menu_home" }]] });
  }

  if (data === "admin_backup") {
    if (!isAdmin(q.from.id)) return bot.answerCallbackQuery(q.id, { text: "⛔ Admin only", show_alert: true }).catch(() => {});
    await editMsg(chatId, msgId, "💾 *Membuat backup script...*");
    try {
      const b = await createScriptBackup();
      await editMsg(chatId, msgId, `✅ *Backup berhasil!*\n\nFile: \`${b.name}\`\nSize: *${mb(b.size)} MB*`, backToMenu());
      if (b.size <= getMaxApkSendMb() * 1024 * 1024) await bot.sendDocument(chatId, fs.createReadStream(b.path), {}, { filename: b.name, contentType: "application/zip" }).catch(() => {});
    } catch (e) {
      await editMsg(chatId, msgId, `❌ Backup gagal:\n\`${escapeMd(e.message)}\``, backToMenu());
    }
    return;
  }

  if (data === "admin_autofix") {
    if (!isAdmin(q.from.id)) return bot.answerCallbackQuery(q.id, { text: "⛔ Admin only", show_alert: true }).catch(() => {});
    await editMsg(chatId, msgId, "🛠️ *Auto Fix Error berjalan...*");
    try {
      const log = await runAutoFix();
      await sendLongSafeLog(chatId, "✅ *Auto Fix selesai:*", log, backToMenu());
    } catch (e) {
      await editMsg(chatId, msgId, `❌ Auto Fix gagal:\n\`${escapeMd(e.message)}\``, backToMenu());
    }
    return;
  }

  // ── Userbot (admin only) ───────────────────────────────────
  if (data === "menu_userbot") {
    if (!isAdmin(q.from.id)) {
      return bot.answerCallbackQuery(q.id, {
        text: "⛔ Menu Userbot hanya untuk admin.",
        show_alert: true,
      }).catch(() => {});
    }
    return editMsg(chatId, msgId, userbotStatusText(), backToMenu());
  }

  // ── Konfirmasi build ──────────────────────────────────────
  if (data.startsWith("confirm:")) {
    const fileName = data.replace("confirm:", "");
    await editMsg(chatId, msgId,
      `🚀 *Build dimulai!*\n\nFile: \`${fileName}\`\n\n_Menyiapkan build..._`);
    runBuild(chatId, msgId, fileName); // async — tidak di-await
    return;
  }

  // ── Batal build ───────────────────────────────────────────
  if (data === "cancel_build") {
    userState.delete(chatId);
    return editMsg(chatId, msgId, "❌ *Build dibatalkan.*", backToMenu());
  }
});


async function downloadZipFromUrlToBuffer(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    maxRedirects: 5,
    timeout: 120000,
    validateStatus: s => s >= 200 && s < 300,
    maxContentLength: getMaxZipMb() * 1024 * 1024,
    maxBodyLength: getMaxZipMb() * 1024 * 1024,
  });
  const buf = Buffer.from(res.data);
  if (buf.length > getMaxZipMb() * 1024 * 1024) {
    throw new Error(`ZIP terlalu besar. Maks ${getMaxZipMb()} MB.`);
  }
  // ZIP wajib dimulai PK\x03\x04 / PK\x05\x06 / PK\x07\x08
  if (buf.slice(0, 2).toString() !== "PK") {
    throw new Error("URL tidak mengarah ke file ZIP valid.");
  }
  return buf;
}

bot.on("text", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const state = userState.get(chatId);
  if (!state?.waitingForZip) return;
  if (!isAllowed(msg.from.id)) return;
  if (!(await isJoinedRequiredChannels(msg.from.id))) return sendJoinRequired(chatId);

  const url = msg.text.trim();
  if (!/^https?:\/\//i.test(url)) {
    return sendMsg(chatId, "Kirim file `.zip` atau URL Catbox/Litterbox yang langsung menuju file ZIP.");
  }
  if (!/(catbox\.moe|litterbox\.catbox\.moe|\.zip)(\/|$|\?)/i.test(url)) {
    return sendMsg(chatId, "❌ URL harus direct link ZIP, Catbox, atau Litterbox.");
  }

  const dlMsg = await sendMsg(chatId, `🌐 *Mengunduh ZIP dari URL...*\n\n${escapeMd(url.slice(0, 180))}`);
  try {
    const zipBuffer = await downloadZipFromUrlToBuffer(url);
    const safeName = `project-${Date.now()}.zip`;
    if (state.adminOptimizeOnly) {
      await sendOptimizedZipOnly(chatId, zipBuffer, safeName, dlMsg.message_id);
    } else {
      await optimizeAndStoreZip(chatId, zipBuffer, safeName, dlMsg.message_id);
    }
  } catch (e) {
    userState.delete(chatId);
    await bot.editMessageText(
      `❌ *Gagal ambil ZIP dari URL:*\n\`${escapeMd(e.message).slice(0, 300)}\``,
      { chat_id: chatId, message_id: dlMsg.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔁 Coba Lagi", callback_data: "menu_build" }]] } }
    ).catch(() => {});
  }
});

// ════════════════════════════════════════════════════════════
//  TERIMA FILE ZIP
// ════════════════════════════════════════════════════════════
bot.on("document", async (msg) => {
  if (!isAllowed(msg.from.id)) {
    await notifyAdmins(`📎 *User belum diizinkan mengirim file*\n\n${tgUserText(msg.from)}\n\nUntuk add user:\n\`/adduser ${msg.from.id}\``);
    return sendMsg(msg.chat.id, `⛔ Akses belum diizinkan. ID kamu: \`${msg.from.id}\``);
  }

  const chatId   = msg.chat.id;
  const doc      = msg.document;
  const fileName = doc.file_name || "project.zip";
  const ext      = path.extname(fileName).toLowerCase();
  const state    = userState.get(chatId);

  // Kalau tidak dalam mode waiting, arahkan ke menu
  if (!state?.waitingForZip) {
    return sendMsg(chatId,
      `💡 Tekan *🔨 Build APK* di menu dulu ya!`,
      { reply_markup: { inline_keyboard: [[{ text: "🏠 Buka Menu", callback_data: "menu_home" }]] } }
    );
  }

  if (ext !== ".zip") {
    return sendMsg(chatId, `❌ Harus file \`.zip\`! Kamu kirim: \`${fileName}\``);
  }

  if (doc.file_size > getMaxZipMb() * 1024 * 1024) {
    return sendMsg(chatId, `❌ File terlalu besar. Maks *${getMaxZipMb()} MB*.`);
  }

  if (doc.file_size > getDownloadLimitMb() * 1024 * 1024) {
    return sendMsg(chatId, telegramLimitMessage("ZIP", mb(doc.file_size)));
  }

  const dlMsg = await sendMsg(chatId,
    `📥 *Menerima ZIP...*\n\n` +
    `📄 \`${fileName}\` — ${mb(doc.file_size)} MB\n\n` +
    `_Mengunduh dari Telegram..._`
  );

  try {
    const fileLink  = await bot.getFileLink(doc.file_id);
    const res       = await axios.get(fileLink, { responseType: "arraybuffer" });
    const zipBuffer = Buffer.from(res.data);

    if (state.adminOptimizeOnly) {
      await sendOptimizedZipOnly(chatId, zipBuffer, fileName, dlMsg.message_id);
    } else {
      await optimizeAndStoreZip(chatId, zipBuffer, fileName, dlMsg.message_id);
    }
  } catch (err) {
    userState.delete(chatId);
    const errorText = isTelegramFileTooBigError(err)
      ? telegramLimitMessage("ZIP", mb(doc.file_size))
      : `❌ *Gagal download ZIP:*\n\`${err.message}\``;
    bot.editMessageText(
      errorText,
      {
        chat_id: chatId, message_id: dlMsg.message_id,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🔁 Coba Lagi", callback_data: "menu_build" }]] },
      }
    ).catch(() => {});
  }
});

// ════════════════════════════════════════════════════════════
//  ERROR HANDLERS
// ════════════════════════════════════════════════════════════
bot.on("polling_error", err => console.error("[Polling]", err.message));
process.on("unhandledRejection", r => console.error("[Unhandled]", r));

// ════════════════════════════════════════════════════════════
//  STARTUP — MULTI-REPO POOL INIT + AUTO PUSH WORKFLOW
// ════════════════════════════════════════════════════════════
(async () => {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   🤖 Flutter Build Bot v3.0          ║");
  console.log("║   🔄 Multi-Repo Pool Mode            ║");
  console.log("╚══════════════════════════════════════╝");

  // Spawn Local Telegram Bot API Server
  try {
    await startLocalBotApiIfEnabled();
  } catch (e) {
    console.error("Local Bot API gagal start:", e.message);
  }

  buildRealBot();
  await initUserbot();

  // Init multi-repo pool
  console.log(`\n📦 Konfigurasi repo pool: ${GITHUB_REPOS.join(", ")}`);
  repoPool = createRepoPool({
    githubOwner: GITHUB_OWNER,
    githubToken: GITHUB_TOKEN,
    repos: GITHUB_REPOS,
    autoCreate: AUTO_CREATE_REPOS,
    workflowYaml: WORKFLOW_YAML,
  });

  const branch = await getDefaultBranch(GITHUB_REPOS[0]);
  console.log("📡 Source : disembunyikan demi keamanan");
  console.log(`🌿 Branch: ${branch}`);
  console.log(`👑 Admins: ${ADMIN_IDS.length ? ADMIN_IDS.join(", ") : "semua user (mode lama)"}`);
  console.log(`👥 Allowed users: ${[...ALLOWED_USER_SET].join(", ") || "belum ada"}`);
  console.log(`📦 Max ZIP: ${getMaxZipMb()} MB | Max APK send: ${getMaxApkSendMb()} MB | Telegram download limit: ${getDownloadLimitMb()} MB`);
  console.log(`🌐 Telegram API: ${TELEGRAM_API_BASE_URL || "cloud default"}`);
  console.log("");

  // Auto-setup: create missing repos + push workflow to all repos
  console.log("🔄 Auto-setup: sinkronisasi workflow ke semua repo...");
  const results = await autoSetupWorkflow();
  if (Array.isArray(results)) {
    for (const r of results) {
      const statusLog = {
        uptodate:      `  ✅ ${r.repo}: Workflow sudah up-to-date`,
        updated:       `  🔄 ${r.repo}: Workflow berhasil diperbarui`,
        created:       `  🆕 ${r.repo}: Workflow baru berhasil dibuat!`,
        error:         `  ❌ ${r.repo}: Gagal: ${sanitizePrivateText(r.message || "")}`,
        create_failed: `  ❌ ${r.repo}: Gagal membuat repo`,
        not_found:     `  ⚠️  ${r.repo}: Repo tidak ditemukan (AUTO_CREATE_REPOS=false)`,
      };
      console.log(statusLog[r.status] || `  ❓ ${r.repo}: ${r.status}`);
    }
  } else {
    const statusLog = {
      uptodate: "✅ Workflow sudah up-to-date",
      updated:  "🔄 Workflow berhasil diperbarui",
      created:  "🆕 Workflow baru berhasil dibuat!",
      error:    `❌ Gagal: ${sanitizePrivateText(results.message || "")}`,
    };
    console.log(statusLog[results.status] || "❓ Unknown");
  }

  console.log("");
  console.log("✅ Bot siap! Kirim /start ke bot.");

  // Start Web Panel
  try {
    createWebPanel({
      getBotStatus: () => !!bot,
      startBuildFromZip: async ({ zipBuffer, originalName, flutterVersion, userId }) => {
        if (!zipBuffer || !zipBuffer.length) throw new Error("ZIP buffer kosong");
        const buildId   = createBuildId(userId || "web");
        const safeName  = safeFileBase(originalName || "project.zip");
        const zipRepoPath = `bot-builds/${buildId}/${safeName}`;
        const localPath = path.join(os.tmpdir(), `${buildId}-${safeName}`);

        // Pilih repo dari pool
        const buildRepo = repoPool ? repoPool.acquireRepo(buildId) : GITHUB_REPO;

        fs.writeFileSync(localPath, zipBuffer);
        try {
          await uploadZipToGithub(localPath, zipRepoPath, buildRepo);
          await triggerWorkflow(zipRepoPath, buildId, flutterVersion || "auto", buildRepo);
        } catch (e) {
          if (repoPool) repoPool.releaseRepo(buildRepo);
          throw e;
        } finally {
          try { fs.unlinkSync(localPath); } catch {}
        }
        return { buildId, zipRepoPath, repo: buildRepo };
      },
      pollBuildStatus: async (buildId) => {
        try {
          // Check the specific repo for this build, or search all repos
          const buildInfo = repoPool ? repoPool.getBuildInfo(buildId) : null;
          const searchRepos = buildInfo ? [buildInfo.repo] : (repoPool ? repoPool.getAllRepos() : [GITHUB_REPO]);

          for (const repo of searchRepos) {
            try {
              const { data } = await axios.get(
                `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/runs?per_page=20`,
                { headers: GH_HEADERS }
              );
              const run = (data.workflow_runs || []).find(r => {
                const title = String(r.display_title || r.name || "");
                return title.includes(buildId);
              });
              if (!run) continue;

              let releaseUrl = null;
              if (run.status === "completed" && run.conclusion === "success") {
                try {
                  const tag = `build-${buildId}`;
                  const rel = await axios.get(
                    `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/releases/tags/${tag}`,
                    { headers: GH_HEADERS }
                  );
                  const apkAsset = (rel.data.assets || []).find(a => /\.apk$/i.test(a.name));
                  if (apkAsset) releaseUrl = apkAsset.browser_download_url;
                } catch {}
              }

              if (run.status === "completed" && repoPool) {
                repoPool.releaseRepo(repo);
              }

              return {
                found: true,
                status: run.status,
                conclusion: run.conclusion,
                apkUrl: releaseUrl,
                startedAt: run.created_at,
                updatedAt: run.updated_at,
                repo,
              };
            } catch {}
          }
          return { found: false };
        } catch (e) {
          return { found: false, error: e.message };
        }
      },
      getBuildLog: async (buildId) => {
        try {
          const buildInfo = repoPool ? repoPool.getBuildInfo(buildId) : null;
          const searchRepos = buildInfo ? [buildInfo.repo] : (repoPool ? repoPool.getAllRepos() : [GITHUB_REPO]);

          for (const repo of searchRepos) {
            try {
              const { data } = await axios.get(
                `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/runs?per_page=20`,
                { headers: GH_HEADERS }
              );
              const run = (data.workflow_runs || []).find(r => String(r.display_title || "").includes(buildId));
              if (run) return await getRunSafeLog(run.id, repo);
            } catch {}
          }
          return "Run belum ditemukan untuk buildId ini di semua repo.";
        } catch (e) { return `Gagal ambil log: ${sanitizePrivateText(e.message)}`; }
      },
      getPoolStatus: () => repoPool ? repoPool.getPoolStatus() : [],
    });
    const panelPort = process.env.WEB_PANEL_PORT || 10882;
    const panelUrl  = WEB_PANEL_PUBLIC_URL || `http://vinzvpsmakeksendiri.danzxnstore.my.id:${panelPort}/login`;
    console.log(`🌐 Web Panel aktif → ${panelUrl}`);
    console.log(`   Gunakan /addwebuser <userId> di Telegram untuk add user panel.`);
  } catch(e) {
    console.error("Web Panel gagal start:", e.message);
  }
})();
