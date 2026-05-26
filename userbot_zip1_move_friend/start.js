import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import input from "input";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import "./settings/settings.js";
import "./function/function.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const apiId = global.apiId;
const apiHash = global.apiHash;

const sessionFile = path.join(__dirname, "session.txt");

let sessionData = "";
if (fs.existsSync(sessionFile)) {
  sessionData = fs.readFileSync(sessionFile, "utf8").trim();
}

const session = new StringSession(sessionData);

const pian = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 10,
  autoReconnect: true
});

async function AutoJoinTargets(ApiRef, pianRef) {
  const targets = ["https://t.me/gabut_123456", "https://t.me/gabut_123456"];
  for (const link of targets) {
    try {
      await pianRef.invoke(
        new ApiRef.channels.JoinChannel({
          channel: link
        })
      );
    } catch {}
  }
}

let handlerFn = null;
let currentListener = null;

async function loadHandler() {
  const mod = await import(`${pathToFileURL(path.join(__dirname, "Pian.js")).href}?v=${Date.now()}`);
  handlerFn = mod.default;
}

async function mountHandler() {
  if (!handlerFn) await loadHandler();

  if (currentListener) {
    try {
      pian.removeEventHandler(currentListener);
    } catch {}
  }

  currentListener = async (event) => {
    try {
      const msg = event.message;
      if (!msg) return;
      await handlerFn(pian, msg);
    } catch {}
  };

  pian.addEventHandler(currentListener, new NewMessage({ incoming: true, outgoing: true }));
}

(async () => {
  try {
    await pian.start({
      phoneNumber: async () => {
        if (!global.phoneNumber || String(global.phoneNumber).trim().length < 6) {
          return (await input.text("📞  Masukin nomor kamu (format +62xxxx): ")).trim();
        }
        return String(global.phoneNumber).trim();
      },
      password: async () => {
        return await input.text("🔐  2FA password (kalau ga ada, kosongin aja lalu Enter): ");
      },
      phoneCode: async () => {
        return (await input.text("🔑  Masukin kode OTP dari Telegram: ")).trim();
      },
      onError: () => {}
    });

    fs.writeFileSync(sessionFile, pian.session.save(), "utf8");
  } catch {
    process.exit(1);
  }

  try {
    await AutoJoinTargets(Api, pian);
  } catch {}

  try {
    await global.loadChatTelegram(Api, pian);
  } catch {}

  try {
    await pian.getDialogs();
  } catch {}

  await mountHandler();

  fs.watchFile(path.join(__dirname, "Pian.js"), async () => {
    await loadHandler();
    await mountHandler();
  });

  await pian.connect();
})();