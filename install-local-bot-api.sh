#!/usr/bin/env bash
# ============================================================
#  Install Local Telegram Bot API Server (tdlib/telegram-bot-api)
#
#  Hasil akhir:
#    ./bin/telegram-bot-api   <- binary yang di-spawn otomatis oleh index.js
#
#  Butuh: build-essential, cmake, gperf, git, libssl-dev, zlib1g-dev
#  Memori build minimum ~2 GB (TDLib berat).
#
#  Dipakai bareng .env:
#    LOCAL_BOT_API_AUTOSTART=true
#    LOCAL_BOT_API_BINARY=./bin/telegram-bot-api
#    LOCAL_BOT_API_PORT=8081
#    TELEGRAM_API_ID=...
#    TELEGRAM_API_HASH=...
#    TELEGRAM_API_BASE_URL=http://127.0.0.1:8081/bot
#    TELEGRAM_DOWNLOAD_LIMIT_MB=50
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$ROOT_DIR/bin"
SRC_DIR="$ROOT_DIR/.build/telegram-bot-api"
BUILD_DIR="$SRC_DIR/build"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 2)}"

echo "==> Folder bot: $ROOT_DIR"
echo "==> Akan build telegram-bot-api dengan $JOBS jobs"

# 1. Cek build tools.
need_cmds=(git cmake make g++ gperf)
missing=()
for c in "${need_cmds[@]}"; do
  if ! command -v "$c" >/dev/null 2>&1; then missing+=("$c"); fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "==> Tools yang kurang: ${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    echo "==> Mencoba install via apt-get (butuh sudo)..."
    if command -v sudo >/dev/null 2>&1; then SUDO=sudo; else SUDO=""; fi
    $SUDO apt-get update
    $SUDO apt-get install -y build-essential cmake gperf git zlib1g-dev libssl-dev
  else
    echo "❌ Install manual: build-essential, cmake, gperf, git, zlib1g-dev, libssl-dev"
    exit 1
  fi
fi

# 2. Clone source (atau fast-fetch update).
if [ ! -d "$SRC_DIR/.git" ]; then
  echo "==> Clone telegram-bot-api ke $SRC_DIR"
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --depth 1 --recursive https://github.com/tdlib/telegram-bot-api.git "$SRC_DIR"
else
  echo "==> Update source di $SRC_DIR"
  (cd "$SRC_DIR" && git pull --ff-only && git submodule update --init --recursive --depth 1)
fi

# 3. Build.
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"
echo "==> cmake configure"
cmake -DCMAKE_BUILD_TYPE=Release ..
echo "==> cmake build (-j$JOBS) — ini bisa makan 10–20 menit di mesin kecil"
cmake --build . --target telegram-bot-api -- -j"$JOBS"

# 4. Salin binary ke ./bin
mkdir -p "$BIN_DIR"
cp -f "$BUILD_DIR/telegram-bot-api" "$BIN_DIR/telegram-bot-api"
chmod +x "$BIN_DIR/telegram-bot-api"

echo ""
echo "✅ Selesai. Binary: $BIN_DIR/telegram-bot-api"
"$BIN_DIR/telegram-bot-api" --help | head -3 || true

cat <<EOF

Langkah selanjutnya:
  1. Buka https://my.telegram.org → 'API development tools', ambil API_ID + API_HASH.
  2. Edit .env, isi minimal:
       LOCAL_BOT_API_AUTOSTART=true
       LOCAL_BOT_API_BINARY=./bin/telegram-bot-api
       LOCAL_BOT_API_PORT=8081
       TELEGRAM_API_ID=...
       TELEGRAM_API_HASH=...
       TELEGRAM_API_BASE_URL=http://127.0.0.1:8081/bot
       TELEGRAM_DOWNLOAD_LIMIT_MB=50
  3. Restart bot:  node index.js

Bot akan otomatis menyalakan Local Bot API Server saat startup.
EOF
