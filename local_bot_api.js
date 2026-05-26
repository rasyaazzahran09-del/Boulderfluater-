/**
 * Local Telegram Bot API runner.
 *
 * Spawns the `telegram-bot-api` binary (https://github.com/tdlib/telegram-bot-api)
 * as a child process of the bot so that ZIP up to 2000 MB bisa di-download bot
 * tanpa kena error "ETELEGRAM: 400 Bad Request: file is too big" dari
 * Telegram cloud (yang membatasi download bot ke ±20 MB).
 *
 * Configurable via .env:
 *
 *   LOCAL_BOT_API_AUTOSTART=true            # aktifkan auto-spawn
 *   LOCAL_BOT_API_BINARY=./bin/telegram-bot-api
 *   LOCAL_BOT_API_PORT=8081                 # HTTP port
 *   LOCAL_BOT_API_DIR=./local_bot_api_data  # storage state telegram-bot-api
 *   LOCAL_BOT_API_LOG=./logs/telegram-bot-api.log
 *   TELEGRAM_API_ID=...                     # dari https://my.telegram.org
 *   TELEGRAM_API_HASH=...                   # dari https://my.telegram.org
 *
 * Setelah Local Bot API ready (HTTP 8081 menerima koneksi), modul ini mengisi
 * `process.env.TELEGRAM_API_BASE_URL` ke http://127.0.0.1:PORT/bot — kalau
 * variabel itu belum ada — supaya `node-telegram-bot-api` otomatis pakai
 * server lokal, bukan cloud.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

function envBool(name, def = false) {
  const v = String(process.env[name] || "").trim().toLowerCase();
  if (!v) return def;
  return ["1", "true", "yes", "on", "y"].includes(v);
}

function resolveBinary(input) {
  if (!input) return null;
  // Allow relative path (default ./bin/telegram-bot-api) or absolute path.
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

function probePort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.once("connect", () => { socket.end(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(800, () => { socket.destroy(); resolve(false); });
  });
}

async function waitForPortReady(port, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

async function startLocalBotApiIfEnabled() {
  if (!envBool("LOCAL_BOT_API_AUTOSTART", false)) return { started: false, reason: "disabled" };

  const apiId   = String(process.env.TELEGRAM_API_ID   || "").trim();
  const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
  if (!apiId || !apiHash) {
    console.error("⚠️  LOCAL_BOT_API_AUTOSTART=true tapi TELEGRAM_API_ID / TELEGRAM_API_HASH belum diisi.");
    console.error("    Dapatkan dari https://my.telegram.org → 'API development tools'.");
    return { started: false, reason: "missing-api-credentials" };
  }

  const binaryPath = resolveBinary(process.env.LOCAL_BOT_API_BINARY || "./bin/telegram-bot-api");
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    console.error(`⚠️  Binary telegram-bot-api tidak ditemukan di: ${binaryPath || "(belum diisi)"}.`);
    console.error("    Jalankan ./install-local-bot-api.sh dulu, atau set LOCAL_BOT_API_BINARY ke path binary yang sudah ada.");
    return { started: false, reason: "binary-not-found", binaryPath };
  }

  const port = Number(process.env.LOCAL_BOT_API_PORT || 8081);
  const dataDir = path.resolve(process.cwd(), process.env.LOCAL_BOT_API_DIR || "./local_bot_api_data");
  const logFile = path.resolve(process.cwd(), process.env.LOCAL_BOT_API_LOG || "./logs/telegram-bot-api.log");
  ensureDir(dataDir);
  ensureDir(path.dirname(logFile));

  if (await probePort(port)) {
    console.log(`ℹ️  Port ${port} sudah dipakai — kemungkinan telegram-bot-api sudah jalan. Skip spawn, pakai server yang ada.`);
    if (!process.env.TELEGRAM_API_BASE_URL) {
      process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${port}/bot`;
    }
    return { started: false, reused: true, port };
  }

  const args = [
    `--api-id=${apiId}`,
    `--api-hash=${apiHash}`,
    `--http-port=${port}`,
    `--http-stat-port=${port + 1}`,
    `--local`,
    `--dir=${dataDir}`,
    `--log=${logFile}`,
    `--verbosity=1`,
  ];

  console.log("🌐 Menjalankan Local Telegram Bot API Server...");
  console.log(`    Binary : ${binaryPath}`);
  console.log(`    Port   : ${port}`);
  console.log(`    Data   : ${dataDir}`);
  console.log(`    Log    : ${logFile}`);

  const child = spawn(binaryPath, args, {
    stdio: ["ignore", "ignore", "inherit"],
    detached: false,
  });

  child.on("error", (err) => {
    console.error("❌ telegram-bot-api gagal start:", err.message);
  });

  child.on("exit", (code, signal) => {
    console.error(`❌ telegram-bot-api berhenti (code=${code}, signal=${signal}). Bot Telegram akan exit supaya Pterodactyl/PM2 bisa restart.`);
    process.exit(1);
  });

  // Bersih-bersih kalau bot dimatikan
  const stopChild = () => { try { child.kill("SIGTERM"); } catch {} };
  process.on("exit", stopChild);
  process.on("SIGINT", () => { stopChild(); process.exit(0); });
  process.on("SIGTERM", () => { stopChild(); process.exit(0); });

  const ready = await waitForPortReady(port, { timeoutMs: 45000 });
  if (!ready) {
    console.error(`❌ Local Bot API tidak siap dalam 45 detik. Cek log di: ${logFile}`);
    stopChild();
    return { started: false, reason: "timeout", port, logFile };
  }

  if (!process.env.TELEGRAM_API_BASE_URL) {
    process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${port}/bot`;
  }
  console.log(`✅ Local Bot API ready di http://127.0.0.1:${port}/bot`);
  return { started: true, port, pid: child.pid };
}

module.exports = { startLocalBotApiIfEnabled };
