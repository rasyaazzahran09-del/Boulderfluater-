import fs from "fs";
import path from "path";
import archiver from "archiver";
import axios from "axios";
import os from "os";
import nou from "node-os-utils";
import speed from "performance-now";
import { Api } from "telegram";
import { fileURLToPath, pathToFileURL } from "url";
import { Client as SSHClient } from "ssh2";

const readJSON = (p, fallback) => {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf-8");
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const writeJSON = (p, data) => {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
};

const ensureFile = (p, fallback) => {
  if (!fs.existsSync(p)) writeJSON(p, fallback);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runtime = (seconds) => {
  seconds = Number(seconds || 0);
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
};

const progressBar = (current, total, size = 14) => {
  const pct = total <= 0 ? 0 : Math.min(100, Math.max(0, Math.round((current / total) * 100)));
  const filled = Math.round((pct / 100) * size);
  const empty = Math.max(0, size - filled);
  return `【${"█".repeat(filled)}${"░".repeat(empty)}】 ${pct}% (${current}/${total})`;
};

const detectLink = (text = "") => {
  const t = String(text || "");
  const re =
    /(?:https?:\/\/|www\.)[^\s]+|(?:t\.me\/|telegram\.me\/)[^\s]+|(?:\b(?:bit\.ly|tinyurl\.com|cutt\.ly|s\.id|rebrand\.ly|rb\.gy|is\.gd|soo\.gd|shorturl\.at)\/[^\s]+)\b/gi;
  return re.test(t);
};

const nowMs = () => Date.now();

const SETTINGS_FILE = "./settings.js";
const DATA_SELLER = "./data-sellerlist.json";
const DATA_BLACKLIST = "./data-blacklist.json";
const DATA_MUTED_GROUPS = "./data-muted-groups.json";
const DATA_ANTISPAM = "./data-antispam.json";
const DATA_ALLOWED_GROUPS = "./data-allowed-groups.json";
const DATA_GROUP_SETTINGS = "./data-group-settings.json";

ensureFile(DATA_SELLER, []);
ensureFile(DATA_BLACKLIST, []);
ensureFile(DATA_MUTED_GROUPS, []);
ensureFile(DATA_ANTISPAM, { users: {}, groups: {} });
ensureFile(DATA_ALLOWED_GROUPS, []);
ensureFile(DATA_GROUP_SETTINGS, {});

const updateSettingsJS = (pattern, replacement) => {
  if (!fs.existsSync(SETTINGS_FILE)) return false;
  let content = fs.readFileSync(SETTINGS_FILE, "utf-8");
  const next = content.replace(pattern, replacement);
  if (next === content) return false;
  fs.writeFileSync(SETTINGS_FILE, next, "utf-8");
  return true;
};

const canWriteInChat = async (pian, chatEntity, userId) => {
  try {
    const perms = await pian.getPermissions(chatEntity, userId);
    if (!perms) return true;
    if (perms.bannedRights) {
      const br = perms.bannedRights;
      if (br.sendMessages || br.sendMedia || br.sendStickers || br.sendGifs || br.sendGames || br.sendInline || br.sendPolls) return false;
    }
    return true;
  } catch {
    return true;
  }
};

const tryLeave = async (pian, entity) => {
  try {
    if (entity?.className === "Channel" || entity?.className === "Chat") {
      await pian.invoke(new Api.channels.LeaveChannel({ channel: entity }));
      return true;
    }
  } catch {}
  try {
    if (entity?.id) {
      await pian.invoke(new Api.channels.LeaveChannel({ channel: entity }));
      return true;
    }
  } catch {}
  return false;
};

const tryDeleteMsg = async (pian, chatId, ids) => {
  try {
    const idList = Array.isArray(ids) ? ids : [ids];
    await pian.deleteMessages(chatId, idList, { revoke: true });
    return true;
  } catch {
    try {
      await pian.invoke(new Api.messages.DeleteMessages({ id: Array.isArray(ids) ? ids : [ids], revoke: true }));
      return true;
    } catch {
      return false;
    }
  }
};

const tryKickUser = async (pian, chatEntity, userId) => {
  try {
    if (chatEntity?.className === "Channel") {
      await pian.invoke(
        new Api.channels.EditBanned({
          channel: chatEntity,
          participant: userId,
          bannedRights: new Api.ChatBannedRights({
            untilDate: Math.floor(Date.now() / 1000) + 60,
            viewMessages: true,
            sendMessages: true,
            sendMedia: true,
            sendStickers: true,
            sendGifs: true,
            sendGames: true,
            sendInline: true,
            sendPolls: true,
            changeInfo: true,
            inviteUsers: true,
            pinMessages: true,
            manageTopics: true
          })
        })
      );
      await sleep(500);
      await pian.invoke(
        new Api.channels.EditBanned({
          channel: chatEntity,
          participant: userId,
          bannedRights: new Api.ChatBannedRights({
            untilDate: 0,
            viewMessages: false,
            sendMessages: false,
            sendMedia: false,
            sendStickers: false,
            sendGifs: false,
            sendGames: false,
            sendInline: false,
            sendPolls: false,
            changeInfo: false,
            inviteUsers: false,
            pinMessages: false,
            manageTopics: false
          })
        })
      );
      return true;
    }
  } catch {}
  try {
    if (chatEntity?.className === "Chat") {
      await pian.invoke(new Api.messages.DeleteChatUser({ chatId: chatEntity.id, userId }));
      return true;
    }
  } catch {}
  return false;
};

const getGroupSettings = (chatId) => {
  const all = readJSON(DATA_GROUP_SETTINGS, {});
  const key = String(chatId);
  const conf = all[key] || {};
  return { all, key, conf };
};

const setGroupSettings = (chatId, nextConf) => {
  const all = readJSON(DATA_GROUP_SETTINGS, {});
  const key = String(chatId);
  all[key] = { ...(all[key] || {}), ...(nextConf || {}) };
  writeJSON(DATA_GROUP_SETTINGS, all);
  return all[key];
};

const safeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const parsePeerInput = (raw = "") => {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replace(/^<@?/, "").replace(/>$/, "").trim();
  const m = s.match(/(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{3,64})/i);
  if (m?.[1]) return `@${m[1]}`;
  if (s.startsWith("@")) return s;
  if (/^[A-Za-z0-9_]{3,64}$/.test(s)) return `@${s}`;
  if (/^-?\d+$/.test(s)) return s;
  return s;
};

if (!global.__pian_dedupe) global.__pian_dedupe = new Map();
if (!global.__pian_cmd_dedupe) global.__pian_cmd_dedupe = new Map();

export default async function handler(pian, msg) {
  try {
    const dedupeKey = `${String(msg?.chatId ?? "")}:${String(msg?.id ?? "")}`;
    const dedupeNow = nowMs();
    const dedupeLast = global.__pian_dedupe.get(dedupeKey);
    if (dedupeLast && dedupeNow - dedupeLast < 15000) return;
    global.__pian_dedupe.set(dedupeKey, dedupeNow);
    if (global.__pian_dedupe.size > 5000) {
      const entries = [...global.__pian_dedupe.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < Math.floor(entries.length * 0.5); i++) global.__pian_dedupe.delete(entries[i][0]);
    }

    const sellerList = readJSON(DATA_SELLER, []);
    let blacklist = readJSON(DATA_BLACKLIST, []);
    const mutedGroups = readJSON(DATA_MUTED_GROUPS, []);
    const antispam = readJSON(DATA_ANTISPAM, { users: {}, groups: {} });
    const allowedGroups = readJSON(DATA_ALLOWED_GROUPS, []);
    const groupSettingsAll = readJSON(DATA_GROUP_SETTINGS, {});

    const me = await pian.getMe();
    const chatId = msg.chatId;
    const senderId = msg.senderId?.toString?.() || "";
    const fromUserId = msg?.fromId?.userId?.toString?.() || senderId;
    const isOwner =
      fromUserId === global.ownerID?.toString?.() ||
      senderId === global.ownerID?.toString?.() ||
      senderId === me?.id?.toString?.();

    const isSeller = sellerList.includes(senderId);

    const textMsg = (msg.message || "").toString();
    const isCmd = textMsg.startsWith(global.prefix || ".");
    const args = textMsg.trim().split(/ +/).slice(1);
    const argText = args.join(" ");
    const command = isCmd ? textMsg.slice((global.prefix || ".").length).trim().split(" ").shift().toLowerCase() : "";
    const cmd = (global.prefix || ".") + command;

    const reply = async (message, options = {}) => {
      try {
        const payload = {
          message,
          replyTo: msg.id,
          parseMode: "html",
          linkPreview: false,
          ...options
        };
        return await pian.sendMessage(options.jid ? options.jid : msg.chatId, payload);
      } catch {}
    };

    const messOwner = () => reply("⚠️ Hanya Owner yang bisa menggunakan perintah ini!");
    const messGroup = () => reply("⚠️ Perintah ini hanya bisa dijalankan di dalam grup.");

    const isPrivateChat = !msg.isGroup;
    const gKey = msg.isGroup ? String(chatId) : null;
    const gConf = gKey ? groupSettingsAll[gKey] || {} : {};
    const antiLinkOn = Boolean(gKey && gConf.antilink === true);
    const groupSpamConf = gKey ? antispam.groups?.[gKey] || {} : {};
    const antiSpamOn = Boolean(gKey && groupSpamConf.enabled === true);

    const shouldModerate = Boolean(msg.isGroup && gKey && !blacklist.includes(gKey) && (antiLinkOn || antiSpamOn));

    if (global.modeSelf && !isOwner) {
      if (!isPrivateChat && !shouldModerate) return;
    }

    const groupMutedByBot = msg.isGroup && mutedGroups.includes(String(chatId));
    const passMutedGroupCommands = new Set(["unmute", "unmutegc"]);
    if (groupMutedByBot && !(isCmd && passMutedGroupCommands.has(command) && isOwner)) {
      if (isCmd && isOwner) {
        return reply("🔇 Grup ini sedang di-mute oleh bot. Gunakan .unmute untuk mengaktifkan kembali.");
      }
      return;
    }

    if (shouldModerate) {
      if (antiSpamOn) {
        antispam.groups[gKey] = antispam.groups[gKey] || { users: {}, enabled: true };

        const uKey = String(senderId);
        const bucket = antispam.groups[gKey].users;
        bucket[uKey] = bucket[uKey] || { t: [], warned: 0, mutedUntil: 0 };

        const st = bucket[uKey];
        const now = nowMs();

        st.t = (st.t || []).filter((x) => now - x < 15000);
        st.t.push(now);

        const isMuted = st.mutedUntil && st.mutedUntil > now;
        if (!isOwner && isMuted) {
          await tryDeleteMsg(pian, chatId, msg.id);
          writeJSON(DATA_ANTISPAM, antispam);
          return;
        }

        const spamThreshold = Number((antispam.groups[gKey].threshold ?? global.antispamThreshold) || 6);
        const muteSeconds = Number((antispam.groups[gKey].muteSeconds ?? global.antispamMuteSeconds) || 60);

        if (!isOwner && st.t.length >= spamThreshold) {
          st.warned = (st.warned || 0) + 1;
          st.mutedUntil = now + muteSeconds * 1000;
          writeJSON(DATA_ANTISPAM, antispam);
          await tryDeleteMsg(pian, chatId, msg.id);
          await reply(`⚠️ <b>Anti-Spam:</b> Terlalu cepat mengirim pesan. Kamu dimute <b>${muteSeconds}s</b>.`);
          return;
        }

        writeJSON(DATA_ANTISPAM, antispam);
      }

      if (antiLinkOn && !isOwner && detectLink(textMsg)) {
        const canDelete = await tryDeleteMsg(pian, chatId, msg.id);
        if (canDelete) await reply("🚫 <b>Anti-Link:</b> Link dilarang di grup ini.");
        return;
      }
    }

    if (isCmd) {
      const k = `${String(chatId)}:${String(senderId)}:${String(command)}`;
      const last = Number(global.__pian_cmd_dedupe.get(k) || 0);
      const now = nowMs();
      if (now - last < 2000) return;
      global.__pian_cmd_dedupe.set(k, now);
      if (global.__pian_cmd_dedupe.size > 5000) {
        const entries = [...global.__pian_cmd_dedupe.entries()].sort((a, b) => a[1] - b[1]);
        for (let i = 0; i < Math.floor(entries.length * 0.5); i++) global.__pian_cmd_dedupe.delete(entries[i][0]);
      }
    }

    switch (command) {
      case "menu":
      case "help":
      case "start": {
        const userId = msg.senderId;
        const name = msg.sender?.firstName || "User";
        const menu = `
<pre>
╭─❍「 BOT INFO 」❍
│ Dev      : Raszz
│ Runtime  : ${runtime(process.uptime())}
│ Mode     : ${global.modeSelf ? "Self" : "Public"}
│ Nama Bot : RaszzBot
│ Powered  : GramJs
│ Owner    : ${global.owner}
│ Prefix   : ${global.prefix}
│ Version  : 1.0 Beta
╰───────────────❍

╭─❍「 OWNER MENU 」❍
│ ${global.prefix}bc
│ ${global.prefix}cfd
│ ${global.prefix}listgc
│ ${global.prefix}enc
│ ${global.prefix}bl
│ ${global.prefix}delbl
│ ${global.prefix}listbl
│ ${global.prefix}resetbl
│ ${global.prefix}pushkontak
│ ${global.prefix}pay
│ ${global.prefix}proses / .done
│ ${global.prefix}backup
│ ${global.prefix}eval
│ ${global.prefix}scangroup
│ ${global.prefix}zombies
│ ${global.prefix}mute
│ ${global.prefix}unmute
│ ${global.prefix}setbio
╰───────────────❍

╭─❍「 PANEL MENU 」❍
│ ${global.prefix}1gb / unlimited
│ ${global.prefix}listpanel
│ ${global.prefix}delpanel
│ ${global.prefix}cadmin
│ ${global.prefix}listadmin
│ ${global.prefix}deladmin
│ ${global.prefix}addseller
│ ${global.prefix}listseller
│ ${global.prefix}resetseller
│ ${global.prefix}delseller
│ ${global.prefix}installpanel
│ ${global.prefix}subdomain
╰───────────────❍

╭─❍「 SETTING BOT 」❍
│ ${global.prefix}setprefix
│ ${global.prefix}self
│ ${global.prefix}public
╰───────────────❍

╭─❍「 DOWNLOAD MENU 」❍
│ ${global.prefix}tiktok
│ ${global.prefix}instagram
│ ${global.prefix}ytmp3
│ ${global.prefix}ytvid
│ ${global.prefix}pindl
│ ${global.prefix}spotifydl
╰───────────────❍

╭─❍「 SEARCH MENU 」❍
│ ${global.prefix}play
│ ${global.prefix}pinsearch
│ ${global.prefix}ttsearch
│ ${global.prefix}igsearch
│ ${global.prefix}mobilelegend
│ ${global.prefix}pintereststalk
╰───────────────❍
</pre>
`;
        await pian.sendFile(msg.chatId, {
          file: global.thumbnail,
          caption: menu,
          replyTo: msg.id,
          parseMode: "html"
        });
        break;
      }

      case "tq":
      case "thanks": {
        const channelUrl = "https://t.me/gabut_123456";
        const channelName = global.ownerUsername ? `Raszz(@${global.ownerUsername})` : "Raszzz";

        const teks =
          `<blockquote><tg-emoji emoji-id="5296664501058285438">🙏</tg-emoji><b>TERIMA KASIH BANYAK ATAS KEPERCAYAAN ANDA</b></blockquote>\n\n` +
          `<blockquote><tg-emoji emoji-id="5375506335242661284">🥳</tg-emoji><b>SENANG BANGET BISA BANTU!</b></blockquote>\n` +
          `<a href="${channelUrl}"><b>CHANNEL ${channelName}</b></a>\n\n` +
          `◌<tg-emoji emoji-id="5208895581644140071">🎉</tg-emoji> <i>your order is done, dear buyer 🩷\nthank you for trusting me—i truly appreciate it.</i>\n\n` +
          `<blockquote><i>if you have a moment, could you please leave a rating &amp; a short criticism?\nit really helps me improve and serve you better.</i></blockquote>\n\n` +
          `<a href="${channelUrl}">${channelUrl}</a>\n\n` +
          `<blockquote><i>i’ll be waiting for your next order—once again, thank you for choosing me 🤍</i></blockquote>`;

        try {
          await pian.sendMessage(msg.chatId, {
            message: teks,
            parseMode: "html",
            linkPreview: false,
            replyTo: msg.id
          });
        } catch (err) {
          console.error("THANKS ERROR:", err);
          await reply("❌ Gagal mengirim pesan terimakasih.");
        }
        break;
      }
      
// Fitur Downloader
      case "play":
      case "ytplay":
      case "ytaudio": {
        if (!argText) return reply(`Masukkan judul lagu!\n\nContoh:\n<code>${cmd}</code> Happy Nation`);

        const q = argText.trim();
        const apiUrl = `https://api.vreden.my.id/api/v1/download/play/audio?query=${encodeURIComponent(q)}`;

        const safe = (s) =>
          String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const fmtViews = (n) => {
          const num = Number(n || 0);
          if (num >= 1e9) return (num / 1e9).toFixed(2).replace(/\.00$/, "") + "B";
          if (num >= 1e6) return (num / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
          if (num >= 1e3) return (num / 1e3).toFixed(2).replace(/\.00$/, "") + "K";
          return String(num);
        };

        const pad2 = (x) => String(x).padStart(2, "0");
        const fmtTime = () => {
          const d = new Date();
          return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(
            d.getMinutes()
          )}:${pad2(d.getSeconds())}`;
        };

        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const progressBar = (cur, tot, size = 14) => bar(cur, tot, size);

        const fmt = (sec) => {
          sec = Number(sec || 0);
          const m = Math.floor(sec / 60);
          const s = Math.floor(sec % 60);
          return `${m}:${String(s).padStart(2, "0")}`;
        };

        const statusMsg = await reply(
          `<b>🎧 PLAY AUDIO</b>\n` +
            `┌ ${bar(0, 4)}\n` +
            `├ 🔎 Mencari: <b>${safe(q)}</b>\n` +
            `└ ⏳ Mohon tunggu...`
        );

        let currentSec = 0;
        let totalSec = 0;
        let progTimer = null;

        try {
          const stepEdit = async (step, line) => {
            const text =
              `<b>🎧 PLAY AUDIO</b>\n` +
              `┌ ${bar(step, 4)}\n` +
              `├ 🔎 Query: <b>${safe(q)}</b>\n` +
              `└ ${line}`;
            try {
              await pian.editMessage(msg.chatId, {
                message: statusMsg.id,
                text,
                parseMode: "html",
                linkPreview: false
              });
            } catch {}
          };

          const fetchBuffer = async (url) => {
            const r = await axios.get(url, {
              responseType: "arraybuffer",
              timeout: 90000,
              headers: { "user-agent": "Mozilla/5.0" },
              maxContentLength: Infinity,
              maxBodyLength: Infinity
            });
            return Buffer.from(r.data);
          };

          const sendFileSafe = async (chatId, payload, filenameFallback) => {
            try {
              return await pian.sendFile(chatId, payload);
            } catch {
              try {
                const buf = await fetchBuffer(payload.file);
                return await pian.sendFile(chatId, {
                  ...payload,
                  file: buf,
                  filename: payload.filename || filenameFallback
                });
              } catch (e) {
                throw e;
              }
            }
          };

          await stepEdit(1, "🌐 Menghubungi server...");

          const res = await axios
            .get(apiUrl, {
              timeout: 30000,
              headers: {
                accept: "application/json",
                "user-agent": "Mozilla/5.0"
              }
            })
            .catch(() => null);

          if (!res || !res.data || res.data.status !== true) {
            await stepEdit(4, "❌ Gagal mengambil data dari API.");
            return;
          }

          await stepEdit(2, "📦 Mengolah metadata...");

          const data = res.data;
          const meta = data?.result?.metadata || {};
          const dl = data?.result?.download || {};

          if (!dl?.url) {
            await stepEdit(4, "❌ URL audio tidak ditemukan.");
            return;
          }

          const title = safe(meta.title || q);
          const authorName = safe(meta?.author?.name || "-");
          const duration = safe(meta?.duration?.timestamp || meta.timestamp || "-");
          const views = fmtViews(meta.views || 0);
          const ago = safe(meta.ago || "-");
          const vid = safe(meta.videoId || "-");
          const yurl = safe(meta.url || "-");
          const thumb = meta.thumbnail || meta.image;

          const qualities = Array.isArray(dl.availableQuality) ? dl.availableQuality.join(", ") : "-";
          const ql = safe(dl.quality || "-");
          const fn = safe(dl.filename || "audio.mp3");

          totalSec = Number(meta?.seconds || meta?.duration?.seconds || 0) || 0;
          currentSec = 0;

          if (progTimer) clearInterval(progTimer);
          progTimer = setInterval(() => {
            if (!totalSec) return;
            currentSec = Math.min(totalSec, currentSec + 2);
          }, 2000);

          await stepEdit(3, "⬇️ Mengirim audio...");

          const caption =
            `<b>PIAN PLAY MUSIC</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `╭─❍「 <b>📌 INFO VIDEO</b> 」❍\n` +
            `├ <b>📌 Judul</b>: ${title}\n` +
            `├ <b>👤 Channel</b>: ${authorName}\n` +
            `├ <b>⏱️️ Durasi</b>: ${duration}\n` +
            `├ <b>👁 Views</b>: ${views}\n` +
            `├ <b>🗓 Upload</b>: ${ago}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🔗 LINK & ID</b> 」❍\n` +
            `├ <b>🧷 Video ID</b>: <code>${vid}</code>\n` +
            `├ <b>🔗 YouTube</b>: <a href="${yurl}">Click Here</a>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🎧 AUDIO</b> 」❍\n` +
            `├ <b>🎧 Quality</b>: ${ql}\n` +
            `├ <b>📶 Available</b>: <code>${safe(qualities)}</code>\n` +
            `├ <b>🗂 File</b>: <code>${fn}</code>\n` +
            `├ <b>🕒 Time</b>: <code>${safe(fmtTime())}</code>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>📊 PROGRESS</b> 」❍\n` +
            `├ ${safe(progressBar(currentSec, totalSec || 1))}\n` +
            `├ <b>⏳</b> <code>${safe(fmt(currentSec))}</code> / <code>${safe(fmt(totalSec || 0))}</code>\n` +
            `╰──────❍`;

          if (thumb) {
            await sendFileSafe(
              msg.chatId,
              {
                file: thumb,
                caption,
                replyTo: msg.id,
                parseMode: "html",
                linkPreview: false
              },
              "thumb.jpg"
            );
          } else {
            await reply(caption);
          }

          await sendFileSafe(
            msg.chatId,
            {
              file: dl.url,
              caption: `✅ <b>Audio siap diputar</b>\n<code>${fn}</code>`,
              replyTo: msg.id,
              parseMode: "html"
            },
            fn || "audio.mp3"
          );

          if (progTimer) clearInterval(progTimer);
          progTimer = null;

          await stepEdit(4, "✅ Done.");
        } catch (e) {
          if (progTimer) clearInterval(progTimer);
          progTimer = null;

          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>🎧 PLAY AUDIO</b>\n` +
                `┌ ${bar(4, 4)}\n` +
                `├ 🔎 Query: <b>${safe(q)}</b>\n` +
                `└ ❌ Error: <code>${safe(String(e?.message || e))}</code>`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {
            await reply("❌ Terjadi error saat menjalankan fitur play.");
          }
        }
        break;
      }

      case "pinterestdl":
      case "pindl": {
        if (!argText) return reply(`Masukkan link Pinterest!\n\nContoh:\n<code>${cmd}</code> https://pinterest.com/pin/xxxx`);

        const safe = (s) =>
          String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const fmtTime = () => {
          const d = new Date();
          const pad2 = (x) => String(x).padStart(2, "0");
          return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(
            d.getMinutes()
          )}:${pad2(d.getSeconds())}`;
        };

        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const fetchBuffer = async (url) => {
          const r = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 90000,
            headers: { "user-agent": "Mozilla/5.0" },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          });
          return Buffer.from(r.data);
        };

        const sendFileSafe = async (chatId, payload, filenameFallback) => {
          try {
            return await pian.sendFile(chatId, payload);
          } catch {
            try {
              const buf = await fetchBuffer(payload.file);
              return await pian.sendFile(chatId, {
                ...payload,
                file: buf,
                filename: payload.filename || filenameFallback
              });
            } catch (e) {
              throw e;
            }
          }
        };

        const urlPin = argText.trim();
        const apiUrl = `https://api.vreden.my.id/api/v1/download/pinterest?url=${encodeURIComponent(urlPin)}`;

        const statusMsg = await reply(
          `<b>📌 PINTEREST DOWNLOADER</b>\n` +
            `┌ ${bar(0, 4)}\n` +
            `├ 🔗 URL: <code>${safe(urlPin)}</code>\n` +
            `└ ⏳ Memproses...`
        );

        const stepEdit = async (step, line) => {
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>📌 PINTEREST DOWNLOADER</b>\n` +
                `┌ ${bar(step, 4)}\n` +
                `├ 🔗 URL: <code>${safe(urlPin)}</code>\n` +
                `└ ${line}`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {}
        };

        try {
          await stepEdit(1, "🌐 Menghubungi server...");

          const res = await axios
            .get(apiUrl, {
              timeout: 30000,
              headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }
            })
            .catch(() => null);

          if (!res?.data || res.data.status !== true) {
            await stepEdit(4, "❌ Gagal mengambil data dari API.");
            return;
          }

          await stepEdit(2, "📦 Mengolah metadata...");

          const r = res.data.result || {};
          const id = safe(r.id || "-");
          const title = safe(r.title || "-");
          const desc = safe((r.description || "").trim() || "-");
          const created = safe(r.created_at || "-");
          const domColor = safe(r.dominant_color || "-");
          const category = safe(r.category || "-");
          const privacy = safe(r.privacy || "-");

          const stats = r.statistics || {};
          const saved = safe(stats.saved ?? "-");
          const comment = safe(stats.comment ?? "-");
          const views = safe(stats.views ?? "-");

          const up = r.uploader || {};
          const upId = safe(up.id || "-");
          const upUser = up.username ? `@${safe(up.username)}` : "-";
          const upName = safe(up.full_name || "-");
          const upUrl = safe(up.profile_url || "-");
          const upFollowers = safe(up.followers ?? "-");
          const upImg = up.profile_img;

          const tags = Array.isArray(r.hashtags) ? r.hashtags.filter(Boolean) : [];
          const ann = Array.isArray(r.visual_annotation) ? r.visual_annotation.filter(Boolean) : [];
          const media = Array.isArray(r.media_urls) ? r.media_urls : [];

          const pick = (q) => media.find((m) => m?.quality === q) || null;
          const mOri = pick("original");
          const mLarge = pick("large");
          const mMed = pick("medium");
          const mSmall = pick("small") || pick("thumbnail");

          const best = mOri || mLarge || mMed || mSmall;
          if (!best?.url) {
            await stepEdit(4, "❌ Media tidak ditemukan.");
            return;
          }

          await stepEdit(3, "⬇️ Mengirim hasil...");

          const cap =
            `<b>📌 PINTEREST RESULT</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `╭─❍「 <b>📌 INFO PIN</b> 」❍\n` +
            `├ <b>🆔 ID</b>: <code>${id}</code>\n` +
            `├ <b>📌 Judul</b>: ${title}\n` +
            `├ <b>📝 Deskripsi</b>: ${desc}\n` +
            `├ <b>🗓 Created</b>: ${created}\n` +
            `├ <b>🎨 Dominant</b>: <code>${domColor}</code>\n` +
            `├ <b>🏷 Category</b>: <code>${category}</code>\n` +
            `├ <b>🔒 Privacy</b>: <code>${privacy}</code>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>📊 STAT</b> 」❍\n` +
            `├ <b>💾 Saved</b>: <b>${saved}</b>\n` +
            `├ <b>💬 Comment</b>: <b>${comment}</b>\n` +
            `├ <b>👁 Views</b>: <b>${views}</b>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>👤 UPLOADER</b> 」❍\n` +
            `├ <b>🆔 ID</b>: <code>${upId}</code>\n` +
            `├ <b>👤 Nama</b>: ${upName}\n` +
            `├ <b>🏷 Username</b>: ${upUser}\n` +
            `├ <b>👥 Followers</b>: <b>${upFollowers}</b>\n` +
            `├ <b>🔗 Profile</b>: <a href="${upUrl}">Click Here</a>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🖼 MEDIA</b> 」❍\n` +
            `├ <b>⭐ Best</b>: <code>${safe(best.quality || "-")}</code> <code>${safe(best.size || "-")}</code>\n` +
            `├ <b>🧷 Original</b>: <code>${safe(mOri?.size || "-")}</code>\n` +
            `├ <b>🧷 Large</b>: <code>${safe(mLarge?.size || "-")}</code>\n` +
            `├ <b>🧷 Medium</b>: <code>${safe(mMed?.size || "-")}</code>\n` +
            `├ <b>🧷 Small</b>: <code>${safe(mSmall?.size || "-")}</code>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🏷 TAG</b> 」❍\n` +
            `├ <b>Hashtags</b>: <code>${safe(tags.length ? tags.join(", ") : "-")}</code>\n` +
            `├ <b>Annotation</b>: <code>${safe(ann.length ? ann.slice(0, 12).join(", ") : "-")}</code>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🕒 RASZZ INFO</b> 」❍\n` +
            `├ <b>👑 Dev</b>: Raszz\n` +
            `├ <b>🕒 Time</b>: <code>${safe(fmtTime())}</code>\n` +
            `╰──────❍`;

          const thumb = upImg || best.url;

          await sendFileSafe(
            msg.chatId,
            {
              file: thumb,
              caption: cap,
              replyTo: msg.id,
              parseMode: "html",
              linkPreview: false
            },
            "thumb.jpg"
          );

          await sendFileSafe(
            msg.chatId,
            {
              file: best.url,
              caption: `✅ <b>File Pinterest siap</b>\n<code>${safe(best.quality || "file")}</code> • <code>${safe(best.size || "-")}</code>`,
              replyTo: msg.id,
              parseMode: "html"
            },
            `${id}.jpg`
          );

          await stepEdit(4, "✅ Done.");
        } catch (e) {
          await stepEdit(4, `❌ Error: <code>${safe(String(e?.message || e))}</code>`);
        }

        break;
      }

      case "ytaudio":
      case "ytmp3":
      case "ytmusic": {
        if (!argText) return reply(`Masukkan link YouTube!\n\nContoh:\n<code>${cmd}</code> https://youtu.be/xxxxx 128`);

        const safe = (s) =>
          String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const fmtViews = (n) => {
          const num = Number(n || 0);
          if (num >= 1e9) return (num / 1e9).toFixed(2).replace(/\.00$/, "") + "B";
          if (num >= 1e6) return (num / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
          if (num >= 1e3) return (num / 1e3).toFixed(2).replace(/\.00$/, "") + "K";
          return String(num);
        };

        const pad2 = (x) => String(x).padStart(2, "0");
        const fmtTime = () => {
          const d = new Date();
          return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(
            d.getSeconds()
          )}`;
        };

        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const fetchBuffer = async (url) => {
          const r = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 90000,
            headers: { "user-agent": "Mozilla/5.0" },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          });
          return Buffer.from(r.data);
        };

        const sendFileSafe = async (chatId, payload, filenameFallback) => {
          try {
            return await pian.sendFile(chatId, payload);
          } catch {
            try {
              const buf = await fetchBuffer(payload.file);
              return await pian.sendFile(chatId, {
                ...payload,
                file: buf,
                filename: payload.filename || filenameFallback
              });
            } catch (e) {
              throw e;
            }
          }
        };

        const parts = argText.trim().split(/ +/);
        const url = parts[0];
        const q = parts[1] ? String(parts[1]) : "128";
        const apiUrl = `https://api.vreden.my.id/api/v1/download/youtube/audio?url=${encodeURIComponent(url)}&quality=${encodeURIComponent(q)}`;

        const statusMsg = await reply(
          `<b>🎧 YOUTUBE AUDIO</b>\n` +
            `┌ ${bar(0, 4)}\n` +
            `├ 🔗 URL: <code>${safe(url)}</code>\n` +
            `└ ⏳ Memproses...`
        );

        const stepEdit = async (step, line) => {
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>🎧 YOUTUBE AUDIO</b>\n` +
                `┌ ${bar(step, 4)}\n` +
                `├ 🔗 URL: <code>${safe(url)}</code>\n` +
                `└ ${line}`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {}
        };

        try {
          await stepEdit(1, "🌐 Menghubungi server...");

          const res = await axios
            .get(apiUrl, { timeout: 30000, headers: { accept: "application/json", "user-agent": "Mozilla/5.0" } })
            .catch(() => null);

          if (!res?.data || res.data.status !== true || res.data.result?.status !== true) {
            await stepEdit(4, "❌ Gagal mengambil data dari API.");
            return;
          }

          await stepEdit(2, "📦 Mengolah metadata...");

          const meta = res.data.result.metadata || {};
          const dl = res.data.result.download || {};

          if (!dl?.url) {
            await stepEdit(4, "❌ URL audio tidak ditemukan.");
            return;
          }

          await stepEdit(3, "⬇️ Mengirim audio...");

          const title = safe(meta.title || "-");
          const authorName = safe(meta?.author?.name || "-");
          const duration = safe(meta?.duration?.timestamp || meta.timestamp || "-");
          const views = fmtViews(meta.views || 0);
          const ago = safe(meta.ago || "-");
          const vid = safe(meta.videoId || "-");
          const yurl = safe(meta.url || "-");
          const thumb = meta.thumbnail || meta.image;

          const qualities = Array.isArray(dl.availableQuality) ? dl.availableQuality.join(", ") : "-";
          const ql = safe(dl.quality || "-");
          const fn = safe(dl.filename || "audio.mp3");

          const cap =
            `<b>🎧 YT AUDIO RESULT</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `╭─❍「 <b>📌 INFO VIDEO</b> 」❍\n` +
            `├ <b>📌 Judul</b>: ${title}\n` +
            `├ <b>👤 Channel</b>: ${authorName}\n` +
            `├ <b>⏱️ Durasi</b>: ${duration}\n` +
            `├ <b>👁 Views</b>: ${safe(String(views))}\n` +
            `├ <b>🗓 Upload</b>: ${ago}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🔗 LINK & ID</b> 」❍\n` +
            `├ <b>🧷 Video ID</b>: <code>${vid}</code>\n` +
            `├ <b>🔗 YouTube</b>: <a href="${yurl}">Click Here</a>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🎧 AUDIO</b> 」❍\n` +
            `├ <b>🎧 Quality</b>: ${ql}\n` +
            `├ <b>📶 Available</b>: <code>${safe(qualities)}</code>\n` +
            `├ <b>🗂 File</b>: <code>${fn}</code>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🕒 RASZZ INFO</b> 」❍\n` +
            `├ <b>👑 Dev</b>: Raszz\n` +
            `├ <b>🕒 Time</b>: <code>${safe(fmtTime())}</code>\n` +
            `╰──────❍`;

          if (thumb) {
            await sendFileSafe(
              msg.chatId,
              {
                file: thumb,
                caption: cap,
                replyTo: msg.id,
                parseMode: "html",
                linkPreview: false
              },
              "thumb.jpg"
            );
          } else {
            await reply(cap);
          }

          await sendFileSafe(
            msg.chatId,
            {
              file: dl.url,
              caption: `✅ <b>Audio siap diputar</b>\n<code>${fn}</code>`,
              replyTo: msg.id,
              parseMode: "html"
            },
            fn || "audio.mp3"
          );

          await stepEdit(4, "✅ Done.");
        } catch (e) {
          await stepEdit(4, `❌ Error: <code>${safe(String(e?.message || e))}</code>`);
        }

        break;
      }

      case "ytvideo":
      case "ytmp4":
      case "ytv": {
        if (!argText) return reply(`Masukkan link YouTube!\n\nContoh:\n<code>${cmd}</code> https://youtu.be/xxxxx 360`);

        const safe = (s) =>
          String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const fmtViews = (n) => {
          const num = Number(n || 0);
          if (num >= 1e9) return (num / 1e9).toFixed(2).replace(/\.00$/, "") + "B";
          if (num >= 1e6) return (num / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
          if (num >= 1e3) return (num / 1e3).toFixed(2).replace(/\.00$/, "") + "K";
          return String(num);
        };

        const pad2 = (x) => String(x).padStart(2, "0");
        const fmtTime = () => {
          const d = new Date();
          return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(
            d.getSeconds()
          )}`;
        };

        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const fetchBuffer = async (url) => {
          const r = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 90000,
            headers: { "user-agent": "Mozilla/5.0" },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          });
          return Buffer.from(r.data);
        };

        const sendFileSafe = async (chatId, payload, filenameFallback) => {
          try {
            return await pian.sendFile(chatId, payload);
          } catch {
            try {
              const buf = await fetchBuffer(payload.file);
              return await pian.sendFile(chatId, {
                ...payload,
                file: buf,
                filename: payload.filename || filenameFallback
              });
            } catch (e) {
              throw e;
            }
          }
        };

        const parts = argText.trim().split(/ +/);
        const url = parts[0];
        const q = parts[1] ? String(parts[1]) : "360";
        const apiUrl = `https://api.vreden.my.id/api/v1/download/youtube/video?url=${encodeURIComponent(url)}&quality=${encodeURIComponent(q)}`;

        const statusMsg = await reply(
          `<b>🎬 YOUTUBE VIDEO</b>\n` +
            `┌ ${bar(0, 4)}\n` +
            `├ 🔗 URL: <code>${safe(url)}</code>\n` +
            `└ ⏳ Memproses...`
        );

        const stepEdit = async (step, line) => {
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>🎬 YOUTUBE VIDEO</b>\n` +
                `┌ ${bar(step, 4)}\n` +
                `├ 🔗 URL: <code>${safe(url)}</code>\n` +
                `└ ${line}`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {}
        };

        try {
          await stepEdit(1, "🌐 Menghubungi server...");

          const res = await axios
            .get(apiUrl, { timeout: 30000, headers: { accept: "application/json", "user-agent": "Mozilla/5.0" } })
            .catch(() => null);

          if (!res?.data || res.data.status !== true || res.data.result?.status !== true) {
            await stepEdit(4, "❌ Gagal mengambil data dari API.");
            return;
          }

          await stepEdit(2, "📦 Mengolah metadata...");

          const meta = res.data.result.metadata || {};
          const dl = res.data.result.download || {};

          if (!dl?.url) {
            await stepEdit(4, "❌ URL video tidak ditemukan.");
            return;
          }

          await stepEdit(3, "⬇️ Mengirim video...");

          const title = safe(meta.title || "-");
          const authorName = safe(meta?.author?.name || "-");
          const duration = safe(meta?.duration?.timestamp || meta.timestamp || "-");
          const views = fmtViews(meta.views || 0);
          const ago = safe(meta.ago || "-");
          const vid = safe(meta.videoId || "-");
          const yurl = safe(meta.url || "-");
          const thumb = meta.thumbnail || meta.image;

          const qualities = Array.isArray(dl.availableQuality) ? dl.availableQuality.join(", ") : "-";
          const ql = safe(dl.quality || "-");
          const fn = safe(dl.filename || "video.mp4");

          const cap =
            `<b>🎬 YT VIDEO RESULT</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `╭─❍「 <b>📌 INFO VIDEO</b> 」❍\n` +
            `├ <b>📌 Judul</b>: ${title}\n` +
            `├ <b>👤 Channel</b>: ${authorName}\n` +
            `├ <b>⏱️ Durasi</b>: ${duration}\n` +
            `├ <b>👁 Views</b>: ${safe(String(views))}\n` +
            `├ <b>🗓 Upload</b>: ${ago}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🔗 LINK & ID</b> 」❍\n` +
            `├ <b>🧷 Video ID</b>: <code>${vid}</code>\n` +
            `├ <b>🔗 YouTube</b>: <a href="${yurl}">Click Here</a>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🎞 VIDEO</b> 」❍\n` +
            `├ <b>🎞 Quality</b>: ${ql}\n` +
            `├ <b>📶 Available</b>: <code>${safe(qualities)}</code>\n` +
            `├ <b>🗂 File</b>: <code>${fn}</code>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🕒 RASZZ INFO</b> 」❍\n` +
            `├ <b>👑 Dev</b>: Raszz\n` +
            `├ <b>🕒 Time</b>: <code>${safe(fmtTime())}</code>\n` +
            `╰──────❍`;

          if (thumb) {
            await sendFileSafe(
              msg.chatId,
              {
                file: thumb,
                caption: cap,
                replyTo: msg.id,
                parseMode: "html",
                linkPreview: false
              },
              "thumb.jpg"
            );
          } else {
            await reply(cap);
          }

          await sendFileSafe(
            msg.chatId,
            {
              file: dl.url,
              caption: `✅ <b>Video siap diputar</b>\n<code>${fn}</code>`,
              replyTo: msg.id,
              parseMode: "html"
            },
            fn || "video.mp4"
          );

          await stepEdit(4, "✅ Done.");
        } catch (e) {
          await stepEdit(4, `❌ Error: <code>${safe(String(e?.message || e))}</code>`);
        }

        break;
      }

      case "spotifydl":
      case "spotidl":
      case "spdl": {
        if (!argText) return reply(`Masukkan link Spotify!\n\nContoh:\n<code>${cmd}</code> https://open.spotify.com/track/xxxx`);

        const safe = (s) =>
          String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const pad2 = (x) => String(x).padStart(2, "0");
        const fmtTime = () => {
          const d = new Date();
          return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(
            d.getSeconds()
          )}`;
        };

        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const fetchBuffer = async (url) => {
          const r = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 90000,
            headers: { "user-agent": "Mozilla/5.0" },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          });
          return Buffer.from(r.data);
        };

        const sendFileSafe = async (chatId, payload, filenameFallback) => {
          try {
            return await pian.sendFile(chatId, payload);
          } catch {
            try {
              const buf = await fetchBuffer(payload.file);
              return await pian.sendFile(chatId, {
                ...payload,
                file: buf,
                filename: payload.filename || filenameFallback
              });
            } catch (e) {
              throw e;
            }
          }
        };

        const urlSp = argText.trim();
        const apiUrl = `https://api.vreden.my.id/api/v1/download/spotify?url=${encodeURIComponent(urlSp)}`;

        const statusMsg = await reply(
          `<b>🎵 SPOTIFY DOWNLOADER</b>\n` +
            `┌ ${bar(0, 4)}\n` +
            `├ 🔗 URL: <code>${safe(urlSp)}</code>\n` +
            `└ ⏳ Memproses...`
        );

        const stepEdit = async (step, line) => {
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>🎵 SPOTIFY DOWNLOADER</b>\n` +
                `┌ ${bar(step, 4)}\n` +
                `├ 🔗 URL: <code>${safe(urlSp)}</code>\n` +
                `└ ${line}`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {}
        };

        const msToTime = (ms) => {
          ms = Number(ms || 0);
          const s = Math.floor(ms / 1000);
          const m = Math.floor(s / 60);
          const r = s % 60;
          return `${m}:${String(r).padStart(2, "0")}`;
        };

        try {
          await stepEdit(1, "🌐 Menghubungi server...");

          const res = await axios
            .get(apiUrl, { timeout: 30000, headers: { accept: "application/json", "user-agent": "Mozilla/5.0" } })
            .catch(() => null);

          if (!res?.data || res.data.status !== true) {
            await stepEdit(4, "❌ Gagal mengambil data dari API.");
            return;
          }

          await stepEdit(2, "📦 Mengolah metadata...");

          const r = res.data.result || {};
          const sid = safe(r.id || "-");
          const title = safe(r.title || "-");
          const artists = safe(r.artists || "-");
          const album = safe(r.album || "-");
          const cover = r.cover_url;
          const release = safe(r.release_date || "-");
          const dur = safe(msToTime(r.duration_ms || 0));
          const dl = r.download;

          if (!dl) {
            await stepEdit(4, "❌ URL audio tidak ditemukan.");
            return;
          }

          await stepEdit(3, "⬇️ Mengirim audio...");

          const cap =
            `<b>🎵 SPOTIFY RESULT</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `╭─❍「 <b>📌 INFO</b> 」❍\n` +
            `├ <b>🆔 ID</b>: <code>${sid}</code>\n` +
            `├ <b>🎶 Judul</b>: ${title}\n` +
            `├ <b>👤 Artist</b>: ${artists}\n` +
            `├ <b>💿 Album</b>: ${album}\n` +
            `├ <b>⏱️ Durasi</b>: <code>${dur}</code>\n` +
            `├ <b>🗓 Rilis</b>: <code>${release}</code>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🕒 RASZZ INFO</b> 」❍\n` +
            `├ <b>👑 Dev</b>: Raszz\n` +
            `├ <b>🕒 Time</b>: <code>${safe(fmtTime())}</code>\n` +
            `╰──────❍`;

          if (cover) {
            await sendFileSafe(
              msg.chatId,
              {
                file: cover,
                caption: cap,
                replyTo: msg.id,
                parseMode: "html",
                linkPreview: false
              },
              "cover.jpg"
            );
          } else {
            await reply(cap);
          }

          await sendFileSafe(
            msg.chatId,
            {
              file: dl,
              caption: `✅ <b>Audio Spotify siap</b>\n<code>${safe(title)}.mp3</code>`,
              replyTo: msg.id,
              parseMode: "html"
            },
            `${title}.mp3`
          );

          await stepEdit(4, "✅ Done.");
        } catch (e) {
          await stepEdit(4, `❌ Error: <code>${safe(String(e?.message || e))}</code>`);
        }

        break;
      }

      case "tiktok":
      case "tt":
      case "ttdl": {
        if (!argText) {
          return reply(`Masukkan link TikTok!\n\nContoh:\n<code>${cmd}</code> https://vm.tiktok.com/xxxxxx/`);
        }

        const ttUrl = argText.trim();
        const apiUrl = `https://api.vreden.my.id/api/v1/download/tiktok?url=${encodeURIComponent(ttUrl)}`;

        const safe = (s) =>
          String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const pad2 = (x) => String(x).padStart(2, "0");
        const fmtTime = () => {
          const d = new Date();
          return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(
            d.getMinutes()
          )}:${pad2(d.getSeconds())}`;
        };

        const fmtBytes = (bytes) => {
          const b = Number(bytes || 0);
          if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + " MB";
          if (b >= 1024) return (b / 1024).toFixed(2) + " KB";
          return b + " B";
        };

        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const fetchBuffer = async (url) => {
          const r = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 90000,
            headers: { "user-agent": "Mozilla/5.0" },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          });
          return Buffer.from(r.data);
        };

        const sendFileSafe = async (chatId, payload, filenameFallback) => {
          try {
            return await pian.sendFile(chatId, payload);
          } catch {
            try {
              const buf = await fetchBuffer(payload.file);
              return await pian.sendFile(chatId, {
                ...payload,
                file: buf,
                filename: payload.filename || filenameFallback
              });
            } catch (e) {
              throw e;
            }
          }
        };

        const statusMsg = await reply(
          `<b>🎬 TIKTOK DOWNLOADER</b>\n` +
            `┌ ${bar(0, 4)}\n` +
            `├ 🔗 URL: <code>${safe(ttUrl)}</code>\n` +
            `└ ⏳ Memproses...`
        );

        const stepEdit = async (step, line) => {
          const text =
            `<b>🎬 TIKTOK DOWNLOADER</b>\n` +
            `┌ ${bar(step, 4)}\n` +
            `├ 🔗 URL: <code>${safe(ttUrl)}</code>\n` +
            `└ ${line}`;
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text,
              parseMode: "html",
              linkPreview: false
            });
          } catch {}
        };

        try {
          await stepEdit(1, "🌐 Menghubungi server...");

          const res = await axios
            .get(apiUrl, {
              timeout: 30000,
              headers: {
                accept: "application/json",
                "user-agent": "Mozilla/5.0"
              }
            })
            .catch(() => null);

          if (!res?.data || res.data.status !== true) {
            await stepEdit(4, "❌ Gagal mengambil data dari API.");
            return;
          }

          await stepEdit(2, "📦 Mengolah metadata...");

          const data = res.data?.result || {};
          const title = safe(data.title || "-");
          const takenAt = safe(data.taken_at || "-");
          const region = safe(data.region || "-");
          const vidId = safe(data.id || "-");
          const dur = safe(data.duration || `${data.durations || "-"}s`);

          const cover = data.cover;
          const author = data.author || {};
          const stats = data.stats || {};
          const music = data.music_info || {};

          const authorName = safe(author.fullname || author.nickname || "-");
          const authorNick = safe(author.nickname || "-");

          const list = Array.isArray(data.data) ? data.data : [];
          const hd = list.find((x) => x?.type === "nowatermark_hd")?.url;
          const nowm = list.find((x) => x?.type === "nowatermark")?.url;
          const videoUrl = hd || nowm;

          if (!videoUrl) {
            await stepEdit(4, "❌ URL video tidak ditemukan.");
            return;
          }

          const sizeNowm = fmtBytes(data.size_nowm);
          const sizeHd = fmtBytes(data.size_nowm_hd);

          const musicTitle = safe(music.title || "-");
          const musicAuthor = safe(music.author || "-");
          const musicUrl = music.url;

          await stepEdit(3, "⬇️ Mengirim hasil...");

          const caption =
            `<b>🎬 TIKTOK RESULT</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `╭─❍「 <b>📌 INFO VIDEO</b> 」❍\n` +
            `├ <b>📌 Judul</b>: ${title}\n` +
            `├ <b>🆔 ID</b>: <code>${vidId}</code>\n` +
            `├ <b>⏱️ Durasi</b>: ${dur}\n` +
            `├ <b>🗓 Upload</b>: ${takenAt}\n` +
            `├ <b>🌍 Region</b>: ${region}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>👤 AUTHOR</b> 」❍\n` +
            `├ <b>👤 Nama</b>: ${authorName}\n` +
            `├ <b>🏷 Nick</b>: ${authorNick}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>📊 STATS</b> 」❍\n` +
            `├ <b>👁 Views</b>: ${safe(stats.views || "-")}\n` +
            `├ <b>❤️ Likes</b>: ${safe(stats.likes || "-")}\n` +
            `├ <b>💬 Comment</b>: ${safe(stats.comment || "-")}\n` +
            `├ <b>🔁 Share</b>: ${safe(stats.share || "-")}\n` +
            `├ <b>⬇️ Download</b>: ${safe(stats.download || "-")}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🎞 FILE</b> 」❍\n` +
            `├ <b>🎞 No WM</b>: <code>${sizeNowm}</code>\n` +
            `├ <b>🎞 No WM HD</b>: <code>${sizeHd}</code>\n` +
            `├ <b>🕒 Time</b>: <code>${safe(fmtTime())}</code>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🎵 MUSIC</b> 」❍\n` +
            `├ <b>🎵 Judul</b>: ${musicTitle}\n` +
            `├ <b>👤 Author</b>: ${musicAuthor}\n` +
            `╰──────❍`;

          if (cover) {
            await sendFileSafe(
              msg.chatId,
              {
                file: cover,
                caption,
                replyTo: msg.id,
                parseMode: "html",
                linkPreview: false
              },
              "cover.jpg"
            );
          } else {
            await reply(caption);
          }

          await sendFileSafe(
            msg.chatId,
            {
              file: videoUrl,
              caption: `✅ <b>Video TikTok siap</b>\n<code>${hd ? "nowatermark_hd.mp4" : "nowatermark.mp4"}</code>`,
              replyTo: msg.id,
              parseMode: "html"
            },
            hd ? "nowatermark_hd.mp4" : "nowatermark.mp4"
          );

          if (musicUrl) {
            await sendFileSafe(
              msg.chatId,
              {
                file: musicUrl,
                caption: `🎵 <b>Audio/Music</b>\n<code>${safe(musicTitle)}</code>`,
                replyTo: msg.id,
                parseMode: "html"
              },
              `${musicTitle}.mp3`
            );
          }

          await stepEdit(4, "✅ Done.");
        } catch (e) {
          await stepEdit(4, `❌ Error: <code>${safe(String(e?.message || e))}</code>`);
        }

        break;
      }

      case "igsearch":
      case "reelssearch":
      case "instareels": {
        if (!argText) return reply(`Masukkan username/keyword!\n\nContoh:\n<code>${cmd}</code> yahyaalmthr`);

        const q = argText.trim();
        const apiUrl = `https://api.vreden.my.id/api/v1/search/instagram/reels?query=${encodeURIComponent(q)}`;

        const safe = (s) =>
          String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const pad2 = (x) => String(x).padStart(2, "0");
        const fmtTime = () => {
          const d = new Date();
          return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(
            d.getMinutes()
          )}:${pad2(d.getSeconds())}`;
        };

        const fmtViews = (n) => {
          const num = Number(n || 0);
          if (num >= 1e9) return (num / 1e9).toFixed(2).replace(/\.00$/, "") + "B";
          if (num >= 1e6) return (num / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
          if (num >= 1e3) return (num / 1e3).toFixed(2).replace(/\.00$/, "") + "K";
          return String(num);
        };

        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const fetchBuffer = async (url) => {
          const r = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 90000,
            headers: { "user-agent": "Mozilla/5.0" },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          });
          return Buffer.from(r.data);
        };

        const sendFileSafe = async (chatId, payload, filenameFallback) => {
          try {
            return await pian.sendFile(chatId, payload);
          } catch {
            try {
              const buf = await fetchBuffer(payload.file);
              return await pian.sendFile(chatId, {
                ...payload,
                file: buf,
                filename: payload.filename || filenameFallback
              });
            } catch (e) {
              throw e;
            }
          }
        };

        const pick = (arr) => (Array.isArray(arr) ? arr : []).filter(Boolean);
        const joinTags = (arr) => pick(arr).slice(0, 10).join(" ");

        const statusMsg = await reply(
          `<b>🔎 IG REELS SEARCH</b>\n` +
            `┌ ${bar(0, 4)}\n` +
            `├ 🔎 Query: <b>${safe(q)}</b>\n` +
            `└ ⏳ Mohon tunggu...`
        );

        try {
          const stepEdit = async (step, line) => {
            const text =
              `<b>🔎 IG REELS SEARCH</b>\n` +
              `┌ ${bar(step, 4)}\n` +
              `├ 🔎 Query: <b>${safe(q)}</b>\n` +
              `└ ${line}`;
            try {
              await pian.editMessage(msg.chatId, {
                message: statusMsg.id,
                text,
                parseMode: "html",
                linkPreview: false
              });
            } catch {}
          };

          await stepEdit(1, "🌐 Menghubungi server...");

          const res = await axios
            .get(apiUrl, {
              timeout: 30000,
              headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }
            })
            .catch(() => null);

          if (!res?.data || res.data.status !== true) {
            await stepEdit(4, "❌ Gagal mengambil data dari API.");
            return;
          }

          await stepEdit(2, "📦 Mengolah hasil...");

          const data = res.data;
          const result = data.result || {};
          const total = Number(result.count || 0);
          const items = Array.isArray(result.search_data) ? result.search_data : [];

          if (!items.length) {
            await stepEdit(4, "❌ Hasil tidak ditemukan.");
            return;
          }

          const top = items[0] || {};
          const prof = top.profile || {};
          const stats = top.statistics || {};
          const reels = top.reels || {};

          const uname = safe(prof.username || result.query || q);
          const fname = safe(prof.full_name || "-");
          const verified = prof.is_verified ? "✅" : "❌";
          const priv = prof.is_private ? "Ya" : "Tidak";
          const ppic = prof.profile_pic_url;

          const reelId = safe(top.id || "-");
          const caption = safe(top.caption || "-");
          const link = safe(top.links || "-");
          const thumb = top.thumbnail;
          const vidUrl = reels.url;

          const duration = safe(String(top.duration ?? "-"));
          const plays = fmtViews(stats.play_count || 0);
          const likes = fmtViews(stats.like_count || 0);
          const comments = fmtViews(stats.comment_count || 0);
          const shares = fmtViews(stats.share_count || 0);

          const mentions = joinTags(top.mentions || []);
          const hashtags = joinTags(top.hashtags || []);

          const listPreview = items
            .slice(0, 7)
            .map((it, i) => {
              const st = it.statistics || {};
              const t = safe((it.caption || it.title || "-").toString().slice(0, 60));
              const lk = safe(it.links || "-");
              return (
                `├ <b>${i + 1}.</b> <code>${safe(it.id || "-")}</code> • ❤️ ${fmtViews(st.like_count || 0)} • ▶️ ${fmtViews(
                  st.play_count || 0
                )}\n` +
                `│    ${t}${(it.caption || it.title || "").length > 60 ? "..." : ""}\n` +
                `│    <a href="${lk}">Open</a>`
              );
            })
            .join("\n");

          await stepEdit(3, "📨 Mengirim hasil...");

          const out =
            `<b>PIAN IG REELS SEARCH</b>\n\n` +
            `╭─❍「 <b>👤 PROFILE</b> 」❍\n` +
            `├ <b>📛 Nama</b>: ${fname}\n` +
            `├ <b>👤 Username</b>: @${uname}\n` +
            `├ <b>✅ Verified</b>: ${verified}\n` +
            `├ <b>🔒 Private</b>: ${safe(priv)}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🎬 TOP REELS</b> 」❍\n` +
            `├ <b>🆔 Reels ID</b>: <code>${reelId}</code>\n` +
            `├ <b>⏱️️ Durasi</b>: <code>${duration}s</code>\n` +
            `├ <b>❤️ Likes</b>: <b>${safe(likes)}</b>\n` +
            `├ <b>▶️ Plays</b>: <b>${safe(plays)}</b>\n` +
            `├ <b>💬 Comment</b>: <b>${safe(comments)}</b>\n` +
            `├ <b>🔁 Share</b>: <b>${safe(shares)}</b>\n` +
            `├ <b>🔗 Link</b>: <a href="${link}">Click Here</a>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>📝 CAPTION</b> 」❍\n` +
            `╰ ${caption}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>#️⃣ TAGS</b> 」❍\n` +
            `├ <b>📌 Mentions</b>: ${safe(mentions || "-")}\n` +
            `├ <b>🏷 Hashtags</b>: ${safe(hashtags || "-")}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>📚 LIST (TOP ${Math.min(7, items.length)}/${total || items.length})</b> 」❍\n` +
            `${listPreview}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🕒 TIME</b> 」❍\n` +
            `╰ <code>${safe(fmtTime())}</code>\n` +
            `╰──────❍`;

          const showThumb = thumb || ppic;

          if (showThumb) {
            await sendFileSafe(
              msg.chatId,
              {
                file: showThumb,
                caption: out,
                replyTo: msg.id,
                parseMode: "html",
                linkPreview: false
              },
              "thumb.jpg"
            );
          } else {
            await reply(out);
          }

          if (vidUrl) {
            await sendFileSafe(
              msg.chatId,
              {
                file: vidUrl,
                caption: `✅ <b>Reels berhasil diambil</b>\n<code>${safe(uname)} • ${safe(reelId)}.mp4</code>`,
                replyTo: msg.id,
                parseMode: "html"
              },
              `${uname}-${reelId}.mp4`
            );
          }

          await stepEdit(4, "✅ Done.");
        } catch (e) {
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>🔎 IG REELS SEARCH</b>\n` +
                `┌ ${bar(4, 4)}\n` +
                `├ 🔎 Query: <b>${safe(q)}</b>\n` +
                `└ ❌ Error: <code>${safe(e?.message || e)}</code>`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {
            await reply("❌ Terjadi error saat menjalankan igsearch.");
          }
        }
        break;
      }

      case "ttsearch":
      case "tiktoksearch": {
        if (!argText) return reply(`Masukkan keyword!\n\nContoh:\n<code>${cmd}</code> Matshuka`);

        const q = argText.trim();
        const apiUrl = `https://api.vreden.my.id/api/v1/search/tiktok?query=${encodeURIComponent(q)}`;

        const safe = (s) =>
          String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const pad2 = (x) => String(x).padStart(2, "0");
        const fmtTime = () => {
          const d = new Date();
          return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(
            d.getMinutes()
          )}:${pad2(d.getSeconds())}`;
        };

        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const fetchBuffer = async (url) => {
          const r = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 90000,
            headers: { "user-agent": "Mozilla/5.0" },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          });
          return Buffer.from(r.data);
        };

        const sendFileSafe = async (chatId, payload, filenameFallback) => {
          try {
            return await pian.sendFile(chatId, payload);
          } catch {
            try {
              const buf = await fetchBuffer(payload.file);
              return await pian.sendFile(chatId, {
                ...payload,
                file: buf,
                filename: payload.filename || filenameFallback
              });
            } catch (e) {
              throw e;
            }
          }
        };

        const statusMsg = await reply(
          `<b>🔎 TIKTOK SEARCH</b>\n` +
            `┌ ${bar(0, 4)}\n` +
            `├ 🔎 Query: <b>${safe(q)}</b>\n` +
            `└ ⏳ Mohon tunggu...`
        );

        try {
          const stepEdit = async (step, line) => {
            const text =
              `<b>🔎 TIKTOK SEARCH</b>\n` +
              `┌ ${bar(step, 4)}\n` +
              `├ 🔎 Query: <b>${safe(q)}</b>\n` +
              `└ ${line}`;
            try {
              await pian.editMessage(msg.chatId, {
                message: statusMsg.id,
                text,
                parseMode: "html",
                linkPreview: false
              });
            } catch {}
          };

          await stepEdit(1, "🌐 Menghubungi server...");

          const res = await axios
            .get(apiUrl, {
              timeout: 30000,
              headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }
            })
            .catch(() => null);

          if (!res?.data || res.data.status !== true) {
            await stepEdit(4, "❌ Gagal mengambil data dari API.");
            return;
          }

          await stepEdit(2, "📦 Mengolah hasil...");

          const data = res.data;
          const result = data.result || {};
          const total = Number(result.count || 0);
          const items = Array.isArray(result.search_data) ? result.search_data : [];

          if (!items.length) {
            await stepEdit(4, "❌ Hasil tidak ditemukan.");
            return;
          }

          const top = items[0] || {};
          const author = top.author || {};
          const music = top.music_info || {};
          const stats = top.stats || {};
          const list = items
            .slice(0, 7)
            .map((it, i) => {
              const au = it.author || {};
              const st = it.stats || {};
              const t = safe((it.title || "-").toString().slice(0, 60));
              const vid = safe(it.video_id || "-");
              const link = safe(`https://www.tiktok.com/@${au.fullname || au.nickname || "user"}/video/${vid}`);
              return (
                `├ <b>${i + 1}.</b> <code>${vid}</code> • ❤️ ${safe(st.likes || "-")} • ▶️ ${safe(st.views || "-")}\n` +
                `│    ${t}${(it.title || "").length > 60 ? "..." : ""}\n` +
                `│    <a href="${link}">Open</a>`
              );
            })
            .join("\n");

          const vidId = safe(top.video_id || "-");
          const title = safe(top.title || "-");
          const taken = safe(top.taken_at || "-");
          const region = safe(top.region || "-");
          const cover = top.cover;

          const auId = safe(author.id || "-");
          const auName = safe(author.fullname || "-");
          const auNick = safe(author.nickname || "-");

          const musicTitle = safe(music.title || "-");
          const musicAuthor = safe(music.author || "-");
          const musicUrl = safe(music.url || "-");

          const noWm = (top.data || []).find((x) => /no_watermark/i.test(x?.type || ""))?.url;
          const wm = (top.data || []).find((x) => /watermark/i.test(x?.type || ""))?.url;

          await stepEdit(3, "📨 Mengirim hasil...");

          const out =
            `<b>PIAN TIKTOK SEARCH</b>\n\n` +
            `╭─❍「 <b>📌 INFO</b> 」❍\n` +
            `├ <b>🔎 Query</b>: <code>${safe(result.query || q)}</code>\n` +
            `├ <b>📦 Total</b>: <b>${safe(total || items.length)}</b>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🎬 TOP VIDEO</b> 」❍\n` +
            `├ <b>🆔 Video ID</b>: <code>${vidId}</code>\n` +
            `├ <b>🗺 Region</b>: <code>${region}</code>\n` +
            `├ <b>🕒 Taken</b>: <code>${taken}</code>\n` +
            `├ <b>📝 Title</b>: ${title}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>👤 AUTHOR</b> 」❍\n` +
            `├ <b>🆔 ID</b>: <code>${auId}</code>\n` +
            `├ <b>📛 Name</b>: ${auName}\n` +
            `├ <b>✨ Nick</b>: ${auNick}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🎵 MUSIC</b> 」❍\n` +
            `├ <b>🎵 Judul</b>: ${musicTitle}\n` +
            `├ <b>👤 Author</b>: ${musicAuthor}\n` +
            `├ <b>🔗 URL</b>: <a href="${musicUrl}">Click Here</a>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>📊 STATS</b> 」❍\n` +
            `├ <b>👁 Views</b>: <b>${safe(stats.views || "-")}</b>\n` +
            `├ <b>❤️ Likes</b>: <b>${safe(stats.likes || "-")}</b>\n` +
            `├ <b>💬 Comment</b>: <b>${safe(stats.comment || "-")}</b>\n` +
            `├ <b>🔁 Share</b>: <b>${safe(stats.share || "-")}</b>\n` +
            `├ <b>⬇️ Download</b>: <b>${safe(stats.download || "-")}</b>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>📥 DOWNLOAD</b> 」❍\n` +
            `├ <b>✅ No WM</b>: ${noWm ? `<a href="${safe(noWm)}">Click Here</a>` : "Tidak ada"}\n` +
            `├ <b>✅ WM</b>: ${wm ? `<a href="${safe(wm)}">Click Here</a>` : "Tidak ada"}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>📚 LIST (TOP ${Math.min(7, items.length)}/${total || items.length})</b> 」❍\n` +
            `${list}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🕒 TIME</b> 」❍\n` +
            `╰ <code>${safe(fmtTime())}</code>\n` +
            `╰──────❍`;

          if (cover) {
            await sendFileSafe(
              msg.chatId,
              {
                file: cover,
                caption: out,
                replyTo: msg.id,
                parseMode: "html",
                linkPreview: false
              },
              "cover.jpg"
            );
          } else {
            await reply(out);
          }

          if (noWm) {
            await sendFileSafe(
              msg.chatId,
              {
                file: noWm,
                caption: `✅ <b>Video (No Watermark)</b>\n<code>${vidId}.mp4</code>`,
                replyTo: msg.id,
                parseMode: "html"
              },
              `${vidId}.mp4`
            );
          }

          await stepEdit(4, "✅ Done.");
        } catch (e) {
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>🔎 TIKTOK SEARCH</b>\n` +
                `┌ ${bar(4, 4)}\n` +
                `├ 🔎 Query: <b>${safe(q)}</b>\n` +
                `└ ❌ Error: <code>${safe(e?.message || e)}</code>`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {
            await reply("❌ Terjadi error saat menjalankan ttsearch.");
          }
        }
        break;
      }

      case "pinterestsearch":
      case "pinsearch":
      case "pinvid": {
        if (!argText) return reply(`Masukkan keyword!\n\nContoh:\n<code>${cmd}</code> pemandangan alam`);

        const q = argText.trim();
        const apiUrl = `https://api.vreden.my.id/api/v2/search/pinterest?query=${encodeURIComponent(q)}&limit=10&type=videos`;

        const safe = (s) =>
          String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const pad2 = (x) => String(x).padStart(2, "0");
        const fmtTime = () => {
          const d = new Date();
          return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(
            d.getMinutes()
          )}:${pad2(d.getSeconds())}`;
        };

        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const fetchBuffer = async (url) => {
          const r = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 90000,
            headers: { "user-agent": "Mozilla/5.0" },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          });
          return Buffer.from(r.data);
        };

        const sendFileSafe = async (chatId, payload, filenameFallback) => {
          try {
            return await pian.sendFile(chatId, payload);
          } catch {
            try {
              const buf = await fetchBuffer(payload.file);
              return await pian.sendFile(chatId, {
                ...payload,
                file: buf,
                filename: payload.filename || filenameFallback
              });
            } catch (e) {
              throw e;
            }
          }
        };

        const statusMsg = await reply(
          `<b>🔎 PINTEREST SEARCH</b>\n` +
            `┌ ${bar(0, 4)}\n` +
            `├ 🔎 Query: <b>${safe(q)}</b>\n` +
            `└ ⏳ Mohon tunggu...`
        );

        try {
          const stepEdit = async (step, line) => {
            const text =
              `<b>🔎 PINTEREST SEARCH</b>\n` +
              `┌ ${bar(step, 4)}\n` +
              `├ 🔎 Query: <b>${safe(q)}</b>\n` +
              `└ ${line}`;
            try {
              await pian.editMessage(msg.chatId, {
                message: statusMsg.id,
                text,
                parseMode: "html",
                linkPreview: false
              });
            } catch {}
          };

          await stepEdit(1, "🌐 Menghubungi server...");

          const res = await axios
            .get(apiUrl, {
              timeout: 30000,
              headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }
            })
            .catch(() => null);

          if (!res?.data || res.data.status !== true) {
            await stepEdit(4, "❌ Gagal mengambil data dari API.");
            return;
          }

          await stepEdit(2, "📦 Mengolah hasil...");

          const data = res.data;
          const result = data.result || {};
          const total = Number(result.total || 0);
          const items = Array.isArray(result.result) ? result.result : [];

          if (!items.length) {
            await stepEdit(4, "❌ Hasil tidak ditemukan.");
            return;
          }

          const top = items[0] || {};
          const uploader = top.uploader || {};
          const media = Array.isArray(top.media_urls) ? top.media_urls[0] : null;

          const pinId = safe(top.id || "-");
          const title = safe(top.title || "-");
          const desc = safe((top.description || "").trim() || "-");
          const color = safe(top.dominant_color || "-");
          const pinUrl = safe(top.pin_url || "-");

          const upName = safe(uploader.full_name || "-");
          const upUser = safe(uploader.username || "-");
          const upFollow = safe(uploader.followers ?? "-");
          const upImg = uploader.profile_img;

          const vidUrl = media?.url;
          const thumb = media?.thumbnail;
          const dim = media ? `${media.width || "-"}x${media.height || "-"}` : "-";
          const durMs = media?.duration_ms;

          const list = items
            .slice(0, 7)
            .map((it, i) => {
              const m = Array.isArray(it.media_urls) ? it.media_urls[0] : null;
              const t = safe((it.title || "-").toString().slice(0, 55));
              const link = safe(it.pin_url || "-");
              const d = m?.duration_ms ? `${Math.round(m.duration_ms / 1000)}s` : "-";
              const ql = safe(m?.quality || "-");
              return (
                `├ <b>${i + 1}.</b> <code>${safe(it.id || "-")}</code> • <code>${ql}</code> • <code>${d}</code>\n` +
                `│    ${t}${(it.title || "").length > 55 ? "..." : ""}\n` +
                `│    <a href="${link}">Open</a>`
              );
            })
            .join("\n");

          await stepEdit(3, "📨 Mengirim hasil...");

          const out =
            `<b>PIAN PINTEREST SEARCH</b>\n\n` +
            `╭─❍「 <b>📌 INFO</b> 」❍\n` +
            `├ <b>🔎 Query</b>: <code>${safe(result.query || q)}</code>\n` +
            `├ <b>📦 Total</b>: <b>${safe(total || items.length)}</b>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>📍 TOP PIN</b> 」❍\n` +
            `├ <b>🆔 Pin ID</b>: <code>${pinId}</code>\n` +
            `├ <b>📝 Judul</b>: ${title}\n` +
            `├ <b>🗒 Deskripsi</b>: ${desc}\n` +
            `├ <b>🎨 Dominant</b>: <code>${color}</code>\n` +
            `├ <b>🔗 URL</b>: <a href="${pinUrl}">Click Here</a>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🎞 MEDIA</b> 」❍\n` +
            `├ <b>📐 Size</b>: <code>${safe(dim)}</code>\n` +
            `├ <b>⏱️ Durasi</b>: <code>${durMs ? Math.round(durMs / 1000) + "s" : "-"}</code>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>👤 UPLOADER</b> 」❍\n` +
            `├ <b>👤 Username</b>: @${upUser}\n` +
            `├ <b>📛 Nama</b>: ${upName}\n` +
            `├ <b>👥 Followers</b>: <b>${upFollow}</b>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>📚 LIST (TOP ${Math.min(7, items.length)}/${total || items.length})</b> 」❍\n` +
            `${list}\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🕒 TIME</b> 」❍\n` +
            `╰ <code>${safe(fmtTime())}</code>\n` +
            `╰──────❍`;

          const cover = thumb || upImg;
          if (cover) {
            await sendFileSafe(
              msg.chatId,
              {
                file: cover,
                caption: out,
                replyTo: msg.id,
                parseMode: "html",
                linkPreview: false
              },
              "thumb.jpg"
            );
          } else {
            await reply(out);
          }

          if (vidUrl) {
            await sendFileSafe(
              msg.chatId,
              {
                file: vidUrl,
                caption: `✅ <b>Video Pinterest siap</b>\n<code>${pinId}.mp4</code>`,
                replyTo: msg.id,
                parseMode: "html"
              },
              `${pinId}.mp4`
            );
          }

          await stepEdit(4, "✅ Done.");
        } catch (e) {
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>🔎 PINTEREST SEARCH</b>\n` +
                `┌ ${bar(4, 4)}\n` +
                `├ 🔎 Query: <b>${safe(q)}</b>\n` +
                `└ ❌ Error: <code>${safe(e?.message || e)}</code>`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {
            await reply("❌ Terjadi error saat menjalankan pinterest search.");
          }
        }
        break;
      }
// End fitur downloader

// Fitur Stalker 
      case "ffstalk":
      case "freefirestalk":
      case "ffstalker": {
        if (!argText) return reply(`Masukkan ID Free Fire!\n\nContoh:\n<code>${cmd}</code> 92860576`);

        const id = argText.trim();
        const apiUrl = `https://api.vreden.my.id/api/v1/stalker/freefire?id=${encodeURIComponent(id)}`;

        const safe = (s) => String(s ?? "")
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const pad2 = (x) => String(x).padStart(2, "0");
        const fmtTime = () => {
          const d = new Date();
          return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
        };
        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const statusMsg = await reply(
          `<b>🎮 FREE FIRE STALK</b>\n` +
          `┌ ${bar(0, 4)}\n` +
          `├ 🆔 ID: <b>${safe(id)}</b>\n` +
          `└ ⏳ Mohon tunggu...`
        );

        try {
          const stepEdit = async (step, line) => {
            const text =
              `<b>🎮 FREE FIRE STALK</b>\n` +
              `┌ ${bar(step, 4)}\n` +
              `├ 🆔 ID: <b>${safe(id)}</b>\n` +
              `└ ${line}`;
            try {
              await pian.editMessage(msg.chatId, {
                message: statusMsg.id,
                text,
                parseMode: "html",
                linkPreview: false
              });
            } catch {}
          };

          await stepEdit(1, "🌐 Menghubungi server...");

          const res = await axios.get(apiUrl, {
            timeout: 30000,
            headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }
          }).catch(() => null);

          if (!res?.data || res.data.status !== true) {
            await stepEdit(4, "❌ Gagal mengambil data dari API.");
            return;
          }

          await stepEdit(2, "📦 Mengolah hasil...");

          const r = res.data.result || {};
          const gameId = safe(r.game_id || id);
          const username = safe(r.username || "-");

          await stepEdit(3, "📨 Mengirim hasil...");

          const out =
`<b>PIAN FREE FIRE STALK</b>

╭─❍「 <b>🎮 FREE FIRE</b> 」❍
├ <b>🆔 Game ID</b>: <code>${gameId}</code>
├ <b>👤 Username</b>: <b>${username}</b>
╰──────❍

╭─❍「 <b>🕒 TIME</b> 」❍
╰ <code>${safe(fmtTime())}</code>
╰──────❍`;

          await reply(out);
          await stepEdit(4, "✅ Done.");
        } catch (e) {
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>🎮 FREE FIRE STALK</b>\n` +
                `┌ ${bar(4, 4)}\n` +
                `├ 🆔 ID: <b>${safe(id)}</b>\n` +
                `└ ❌ Error: <code>${safe(e?.message || e)}</code>`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {
            await reply("❌ Terjadi error saat menjalankan ffstalk.");
          }
        }
        break;
      }

      case "igstalk":
      case "instagramstalk":
      case "igstalker": {
        if (!argText) return reply(`Masukkan username IG!\n\nContoh:\n<code>${cmd}</code> yahyaalmthr`);

        const username = argText.replace(/^@/, "").trim();
        const apiUrl = `https://api.vreden.my.id/api/v1/stalker/instagram?username=${encodeURIComponent(username)}`;

        const safe = (s) => String(s ?? "")
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const pad2 = (x) => String(x).padStart(2, "0");
        const fmtTime = () => {
          const d = new Date();
          return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
        };
        const fmtNum = (n) => {
          const num = Number(n || 0);
          if (num >= 1e9) return (num / 1e9).toFixed(2).replace(/\.00$/, "") + "B";
          if (num >= 1e6) return (num / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
          if (num >= 1e3) return (num / 1e3).toFixed(2).replace(/\.00$/, "") + "K";
          return String(num);
        };
        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const statusMsg = await reply(
          `<b>📸 INSTAGRAM STALK</b>\n` +
          `┌ ${bar(0, 4)}\n` +
          `├ 👤 Username: <b>${safe(username)}</b>\n` +
          `└ ⏳ Mohon tunggu...`
        );

        try {
          const stepEdit = async (step, line) => {
            const text =
              `<b>📸 INSTAGRAM STALK</b>\n` +
              `┌ ${bar(step, 4)}\n` +
              `├ 👤 Username: <b>${safe(username)}</b>\n` +
              `└ ${line}`;
            try {
              await pian.editMessage(msg.chatId, {
                message: statusMsg.id,
                text,
                parseMode: "html",
                linkPreview: false
              });
            } catch {}
          };

          await stepEdit(1, "🌐 Menghubungi server...");

          const res = await axios.get(apiUrl, {
            timeout: 30000,
            headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }
          }).catch(() => null);

          if (!res?.data || res.data.status !== true) {
            await stepEdit(4, "❌ Gagal mengambil data dari API.");
            return;
          }

          await stepEdit(2, "📦 Mengolah hasil...");

          const r = res.data.result || {};
          const id = safe(r.id || "-");
          const uname = safe(r.username || username);
          const fullName = safe(r.full_name || "-");
          const category = safe(r.category || "-");
          const bio = safe(r.biography || "-");
          const verified = r.is_verified ? "✅" : "❌";
          const priv = r.is_private ? "Ya" : "Tidak";
          const business = r.is_business ? "Ya" : "Tidak";
          const stats = r.statistics || {};
          const followers = fmtNum(stats.follower || 0);
          const following = fmtNum(stats.following || 0);
          const posts = fmtNum(stats.post || 0);

          const imgCard = r.image_account; // banner image dari editor
          const pfp = r.profile_pic_hd?.url;

          await stepEdit(3, "📨 Mengirim hasil...");

          const out =
`<b>PIAN INSTAGRAM STALK</b>

╭─❍「 <b>👤 PROFILE</b> 」❍
├ <b>🆔 ID</b>: <code>${id}</code>
├ <b>👤 Username</b>: @${uname}
├ <b>📛 Nama</b>: ${fullName}
├ <b>🏷 Kategori</b>: ${category}
├ <b>✅ Verified</b>: ${verified}
├ <b>🔒 Private</b>: ${safe(priv)}
├ <b>💼 Business</b>: ${safe(business)}
╰──────❍

╭─❍「 <b>📊 STATS</b> 」❍
├ <b>👥 Followers</b>: <b>${safe(followers)}</b>
├ <b>👤 Following</b>: <b>${safe(following)}</b>
├ <b>🖼 Posts</b>: <b>${safe(posts)}</b>
╰──────❍

╭─❍「 <b>📝 BIO</b> 」❍
╰ ${bio}
╰──────❍

╭─❍「 <b>🖼 IMAGE</b> 」❍
├ <b>🧾 Card</b>: ${imgCard ? `<a href="${safe(imgCard)}">Click Here</a>` : "Tidak ada"}
├ <b>👤 Profile HD</b>: ${pfp ? `<a href="${safe(pfp)}">Click Here</a>` : "Tidak ada"}
╰──────❍

╭─❍「 <b>🕒 TIME</b> 」❍
╰ <code>${safe(fmtTime())}</code>
╰──────❍`;

          const cover = imgCard || pfp;
          if (cover) {
            await pian.sendFile(msg.chatId, {
              file: cover,
              caption: out,
              replyTo: msg.id,
              parseMode: "html",
              linkPreview: false
            });
          } else {
            await reply(out);
          }

          await stepEdit(4, "✅ Done.");
        } catch (e) {
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>📸 INSTAGRAM STALK</b>\n` +
                `┌ ${bar(4, 4)}\n` +
                `├ 👤 Username: <b>${safe(username)}</b>\n` +
                `└ ❌ Error: <code>${safe(e?.message || e)}</code>`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {
            await reply("❌ Terjadi error saat menjalankan igstalk.");
          }
        }
        break;
      }

      case "mlstalk":
      case "mlstalker":
      case "mobilelegendstalk": {
        if (!argText) return reply(`Masukkan ID Game dan ID Zone!\n\nContoh:\n<code>${cmd}</code> 109088431 2558\natau\n<code>${cmd}</code> 109088431|2558`);

        const raw = argText.trim();
        let id_game = "", id_zone = "";
        if (raw.includes("|")) {
          [id_game, id_zone] = raw.split("|").map(s => s.trim());
        } else {
          const sp = raw.split(/\s+/);
          id_game = sp[0];
          id_zone = sp[1];
        }

        if (!id_game || !id_zone) {
          return reply(`Format salah!\n\nContoh:\n<code>${cmd}</code> 109088431 2558`);
        }

        const apiUrl = `https://api.vreden.my.id/api/v1/stalker/mobilelegends?id_game=${encodeURIComponent(id_game)}&id_zone=${encodeURIComponent(id_zone)}`;

        const safe = (s) => String(s ?? "")
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const pad2 = (x) => String(x).padStart(2, "0");
        const fmtTime = () => {
          const d = new Date();
          return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
        };
        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const statusMsg = await reply(
          `<b>🎮 ML STALK</b>\n` +
          `┌ ${bar(0, 4)}\n` +
          `├ 🆔 Game: <b>${safe(id_game)}</b>\n` +
          `├ 🌐 Zone: <b>${safe(id_zone)}</b>\n` +
          `└ ⏳ Mohon tunggu...`
        );

        try {
          const stepEdit = async (step, line) => {
            const text =
              `<b>🎮 ML STALK</b>\n` +
              `┌ ${bar(step, 4)}\n` +
              `├ 🆔 Game: <b>${safe(id_game)}</b>\n` +
              `├ 🌐 Zone: <b>${safe(id_zone)}</b>\n` +
              `└ ${line}`;
            try {
              await pian.editMessage(msg.chatId, {
                message: statusMsg.id,
                text,
                parseMode: "html",
                linkPreview: false
              });
            } catch {}
          };

          await stepEdit(1, "🌐 Menghubungi server...");

          const res = await axios.get(apiUrl, {
            timeout: 30000,
            headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }
          }).catch(() => null);

          if (!res?.data || res.data.status !== true) {
            await stepEdit(4, "❌ Gagal mengambil data dari API.");
            return;
          }

          await stepEdit(2, "📦 Mengolah hasil...");

          const r = res.data.result || {};
          const gameId = safe(r.game_id || id_game);
          const zoneId = safe(r.zone_id || id_zone);
          const uname = safe(r.username || "-");

          await stepEdit(3, "📨 Mengirim hasil...");

          const out =
`<b>PIAN MOBILE LEGENDS STALK</b>

╭─❍「 <b>🎮 MOBILE LEGENDS</b> 」❍
├ <b>🆔 Game ID</b>: <code>${gameId}</code>
├ <b>🌐 Zone ID</b>: <code>${zoneId}</code>
├ <b>👤 Username</b>: <b>${uname}</b>
╰──────❍

╭─❍「 <b>🕒 TIME</b> 」❍
╰ <code>${safe(fmtTime())}</code>
╰──────❍`;

          await reply(out);
          await stepEdit(4, "✅ Done.");
        } catch (e) {
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>🎮 ML STALK</b>\n` +
                `┌ ${bar(4, 4)}\n` +
                `├ 🆔 Game: <b>${safe(id_game)}</b>\n` +
                `├ 🌐 Zone: <b>${safe(id_zone)}</b>\n` +
                `└ ❌ Error: <code>${safe(e?.message || e)}</code>`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {
            await reply("❌ Terjadi error saat menjalankan mlstalk.");
          }
        }
        break;
      }

      case "tiktokstalk":
      case "ttstalk":
      case "tiktokstalker": {
        if (!argText) return reply(`Masukkan username TikTok!\n\nContoh:\n<code>${cmd}</code> yahyaalialmthr`);

        const username = argText.replace(/^@/, "").trim();
        const apiUrl = `https://api.vreden.my.id/api/v1/stalker/tiktok?username=${encodeURIComponent(username)}`;

        const safe = (s) => String(s ?? "")
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const pad2 = (x) => String(x).padStart(2, "0");
        const fmtTime = () => {
          const d = new Date();
          return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
        };
        const fmtNum = (n) => {
          const num = Number(n || 0);
          if (num >= 1e9) return (num / 1e9).toFixed(2).replace(/\.00$/, "") + "B";
          if (num >= 1e6) return (num / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
          if (num >= 1e3) return (num / 1e3).toFixed(2).replace(/\.00$/, "") + "K";
          return String(num);
        };
        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const statusMsg = await reply(
          `<b>🎵 TIKTOK STALK</b>\n` +
          `┌ ${bar(0, 4)}\n` +
          `├ 👤 Username: <b>${safe(username)}</b>\n` +
          `└ ⏳ Mohon tunggu...`
        );

        try {
          const stepEdit = async (step, line) => {
            const text =
              `<b>🎵 TIKTOK STALK</b>\n` +
              `┌ ${bar(step, 4)}\n` +
              `├ 👤 Username: <b>${safe(username)}</b>\n` +
              `└ ${line}`;
            try {
              await pian.editMessage(msg.chatId, {
                message: statusMsg.id,
                text,
                parseMode: "html",
                linkPreview: false
              });
            } catch {}
          };

          await stepEdit(1, "🌐 Menghubungi server...");

          const res = await axios.get(apiUrl, {
            timeout: 30000,
            headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }
          }).catch(() => null);

          if (!res?.data || res.data.status !== true) {
            await stepEdit(4, "❌ Gagal mengambil data dari API.");
            return;
          }

          await stepEdit(2, "📦 Mengolah hasil...");

          const r = res.data.result || {};
          const id = safe(r.id || "-");
          const uname = safe(r.username || username);
          const nick = safe(r.nickname || "-");
          const bio = safe(r.biography || "-");
          const verified = r.verified ? "✅" : "❌";
          const lang = safe(r.language || "-");
          const biolink = safe(r.biolink || "-");

          const avatar = r.avatar || {};
          const avaL = avatar.larger;
          const avaM = avatar.medium;
          const avaT = avatar.thumbnail;

          const st = r.statistics || {};
          const followers = fmtNum(st.follower || 0);
          const following = fmtNum(st.following || 0);
          const likes = fmtNum(st.like || 0);
          const posts = fmtNum(st.post || 0);
          const friends = fmtNum(st.friend || 0);

          const imgCard = r.image_account;

          await stepEdit(3, "📨 Mengirim hasil...");

          const out =
`<b>PIAN TIKTOK STALK</b>

╭─❍「 <b>👤 PROFILE</b> 」❍
├ <b>🆔 ID</b>: <code>${id}</code>
├ <b>👤 Username</b>: @${uname}
├ <b>✨ Nickname</b>: ${nick}
├ <b>✅ Verified</b>: ${verified}
├ <b>🗣 Language</b>: <code>${lang}</code>
├ <b>🔗 BioLink</b>: ${biolink && biolink !== "-" ? `<a href="${biolink}">Click Here</a>` : "-"}
╰──────❍

╭─❍「 <b>📊 STATS</b> 」❍
├ <b>👥 Followers</b>: <b>${safe(followers)}</b>
├ <b>👤 Following</b>: <b>${safe(following)}</b>
├ <b>❤️ Likes</b>: <b>${safe(likes)}</b>
├ <b>📝 Post</b>: <b>${safe(posts)}</b>
├ <b>🤝 Friend</b>: <b>${safe(friends)}</b>
╰──────❍

╭─❍「 <b>📝 BIO</b> 」❍
╰ ${bio}
╰──────❍

╭─❍「 <b>🖼 IMAGE</b> 」❍
├ <b>🧾 Card</b>: ${imgCard ? `<a href="${safe(imgCard)}">Click Here</a>` : "Tidak ada"}
├ <b>👤 Avatar L</b>: ${avaL ? `<a href="${safe(avaL)}">Click Here</a>` : "-"}
├ <b>👤 Avatar M</b>: ${avaM ? `<a href="${safe(avaM)}">Click Here</a>` : "-"}
├ <b>👤 Avatar T</b>: ${avaT ? `<a href="${safe(avaT)}">Click Here</a>` : "-"}
╰──────❍

╭─❍「 <b>🕒 TIME</b> 」❍
╰ <code>${safe(fmtTime())}</code>
╰──────❍`;

          const cover = imgCard || avaL || avaM || avaT;
          if (cover) {
            await pian.sendFile(msg.chatId, {
              file: cover,
              caption: out,
              replyTo: msg.id,
              parseMode: "html",
              linkPreview: false
            });
          } else {
            await reply(out);
          }

          await stepEdit(4, "✅ Done.");
        } catch (e) {
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>🎵 TIKTOK STALK</b>\n` +
                `┌ ${bar(4, 4)}\n` +
                `├ 👤 Username: <b>${safe(username)}</b>\n` +
                `└ ❌ Error: <code>${safe(e?.message || e)}</code>`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {
            await reply("❌ Terjadi error saat menjalankan tiktokstalk.");
          }
        }
        break;
      }
// End Fitur Stalker

      case "ping": {
        const start = speed();
        const cpu = nou.cpu;
        const drive = nou.drive;
        const mem = nou.mem;
        const netstat = nou.netstat;

        const [osName, driveInfo, memInfo, cpuUsage, netStats] = await Promise.all([
          nou.os.oos().catch(() => "Unknown"),
          drive.info().catch(() => ({ usedGb: "N/A", totalGb: "N/A" })),
          mem.info().catch(() => ({ totalMemMb: 0, usedMemMb: 0, freeMemMb: 0 })),
          cpu.usage().catch(() => 0),
          netstat.inOut().catch(() => ({ total: null }))
        ]);

        const totalGB = (memInfo.totalMemMb / 1024 || 0).toFixed(2);
        const usedGB = (memInfo.usedMemMb / 1024 || 0).toFixed(2);
        const freeGB = (memInfo.freeMemMb / 1024 || 0).toFixed(2);

        const cpuList = os.cpus() || [];
        const cpuModel = cpuList[0]?.model || "Unknown CPU";
        const cpuSpeed = cpuList[0]?.speed || "N/A";
        const cpuCores = cpuList.length || 0;

        const vpsUptime = runtime(os.uptime());
        const botUptime = runtime(process.uptime());
        const latency = (speed() - start).toFixed(2);
        const loadAvg = os.loadavg().map((n) => n.toFixed(2)).join(" | ");
        const nodeVersion = process.version;
        const platform = os.platform();
        const hostname = os.hostname();
        const arch = os.arch();
        const network = netStats.total
          ? `${netStats.total.inputMb.toFixed(2)} MB ↓ / ${netStats.total.outputMb.toFixed(2)} MB ↑`
          : "N/A";

        const tt = `
<b>⚙️ SYSTEM STATUS</b>
<b>• OS :</b> ${nou.os.type()} (${osName})
<b>• Platform :</b> ${platform.toUpperCase()}
<b>• Arch :</b> ${arch}
<b>• Hostname :</b> ${hostname}

<b>💾 STORAGE</b>
<b>• Disk :</b> ${driveInfo.usedGb}/${driveInfo.totalGb} GB
<b>• RAM :</b> ${usedGB}/${totalGB} GB (Free: ${freeGB} GB)

<b>🧠 CPU INFO</b>
<b>• Model :</b> ${cpuModel}
<b>• Core(s) :</b> ${cpuCores}
<b>• Speed :</b> ${cpuSpeed} MHz
<b>• Usage :</b> ${cpuUsage.toFixed(2)}%
<b>• Load Avg :</b> ${loadAvg}

<b>🤖 BOT STATUS</b>
<b>• Response Time :</b> ${latency} sec
<b>• Bot Uptime :</b> ${botUptime}
<b>• VPS Uptime :</b> ${vpsUptime}
<b>• Node.js :</b> ${nodeVersion}
<b>• Network :</b> ${network}
`;
        await pian.sendMessage(msg.chatId, { message: tt, parseMode: "html", replyTo: msg.id });
        break;
      }

      case "enc": {
        if (!isOwner) return messOwner();
        const jsconfuser = await import("js-confuser");
        const chatId2 = msg.chatId;

        if (!msg.replyTo) {
          return pian.sendMessage(chatId2, { message: "Reply file `.js` untuk dienkripsi!", replyTo: msg.id });
        }

        const repl = await msg.getReplyMessage();
        const file = repl.media;

        if (!file || !repl.media.document || !repl.media.document.attributes[0].fileName.endsWith(".js")) {
          return pian.sendMessage(chatId2, { message: "Hanya bisa untuk file `.js`", replyTo: msg.id });
        }

        await pian.sendMessage(chatId2, {
          message: `🔒 Sedang memproses encrypt ${repl.media.document.attributes[0].fileName}...`,
          replyTo: msg.id
        });

        let outPath = `./${repl.media.document.attributes[0].fileName}`;
        try {
          const buffer = await pian.downloadMedia(repl.media);
          if (!buffer) {
            return pian.sendMessage(chatId2, { message: "Gagal download file!", replyTo: msg.id });
          }

          const inputCode = buffer.toString();
          const encryptedCode = await jsconfuser.obfuscate(inputCode, {
            target: "node",
            preset: "high",
            stringEncoding: true,
            identifierGenerator: "zeroWidth"
          });

          fs.writeFileSync(outPath, encryptedCode.code);

          await pian.sendFile(chatId2, {
            file: outPath,
            caption: `✅ Berhasil encrypt file ${repl.media.document.attributes[0].fileName}`,
            replyTo: msg.id
          });

          fs.unlinkSync(outPath);
        } catch (err) {
          if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
          await pian.sendMessage(chatId2, { message: "Terjadi kesalahan saat encrypt file!", replyTo: msg.id });
        }
        break;
      }

      case "setprefix": {
        if (!isOwner) return messOwner();
        if (!args[0]) return reply(`Masukkan prefix baru!\n\nContoh:\n${cmd} !`);
        const newPrefix = args[0].trim();
        if (newPrefix.length > 1) return reply("Prefix terlalu panjang (maksimal 1 karakter).");

        if (!fs.existsSync(SETTINGS_FILE)) return reply("❌ settings.js tidak ditemukan.");
        let configFile = fs.readFileSync(SETTINGS_FILE, "utf-8");
        configFile = configFile.replace(/global\.prefix\s*=\s*(['"`]).*?\1/, `global.prefix = '${newPrefix}'`);
        fs.writeFileSync(SETTINGS_FILE, configFile, "utf-8");
        global.prefix = newPrefix;

        reply(`✅ Prefix berhasil diubah menjadi: <b>${newPrefix}</b>`);
        break;
      }

      case "self": {
        if (!isOwner) return messOwner();
        if (global.modeSelf) return reply("Bot sudah dalam mode Self ✅");
        global.modeSelf = true;
        updateSettingsJS(/global\.modeSelf\s*=\s*(true|false)/, "global.modeSelf = true");
        reply("🔒 Bot sekarang dalam mode Self");
        break;
      }

      case "public": {
        if (!isOwner) return messOwner();
        if (!global.modeSelf) return reply("Bot sudah dalam mode Public ✅");
        global.modeSelf = false;
        updateSettingsJS(/global\.modeSelf\s*=\s*(true|false)/, "global.modeSelf = false");
        reply("🔓 Bot sekarang dalam mode Public");
        break;
      }

      case "mute":
      case "mutegc": {
        if (!isOwner) return messOwner();
        if (!msg.isGroup) return messGroup();
        const list = readJSON(DATA_MUTED_GROUPS, []);
        const id = String(msg.chatId);
        if (list.includes(id)) return reply("🔇 Grup ini sudah di-mute.");
        list.push(id);
        writeJSON(DATA_MUTED_GROUPS, list);
        await reply("🔇 Grup berhasil di-mute. Bot tidak akan merespon di grup ini sampai di-unmute.");
        break;
      }

      case "unmute":
      case "unmutegc": {
        if (!isOwner) return messOwner();
        if (!msg.isGroup) return messGroup();
        let list = readJSON(DATA_MUTED_GROUPS, []);
        const id = String(msg.chatId);
        if (!list.includes(id)) return reply("🔊 Grup ini tidak sedang di-mute.");
        list = list.filter((x) => x !== id);
        writeJSON(DATA_MUTED_GROUPS, list);
        await reply("🔊 Grup berhasil di-unmute.");
        break;
      }

      case "setbio":
      case "setbiogrub": {
        if (!isOwner) return messOwner();
        if (!msg.isGroup) return messGroup();
        if (!argText) return reply(`Masukkan bio/deskripsi grup.\n\nContoh:\n<code>${cmd}</code> Deskripsi baru grup`);
        try {
          const ent = await pian.getEntity(msg.chatId);
          if (ent?.className === "Channel") {
            await pian.invoke(new Api.channels.EditAbout({ channel: ent, about: argText }));
            return reply("✅ Bio/Deskripsi grup berhasil diubah.");
          }
          if (ent?.className === "Chat") {
            await pian.invoke(new Api.messages.EditChatAbout({ chatId: ent.id, about: argText }));
            return reply("✅ Bio/Deskripsi grup berhasil diubah.");
          }
          return reply("❌ Tidak dapat mengubah deskripsi grup ini.");
        } catch {
          return reply("❌ Gagal mengubah bio/deskripsi grup (pastikan kamu admin).");
        }
      }

      case "antilink":
      case "antilinkgc": {
        if (!isOwner) return messOwner();
        if (!msg.isGroup) return messGroup();

        const v = (args[0] || "").toLowerCase();
        if (!v || !["on", "off", "true", "false", "1", "0"].includes(v)) {
          const { conf } = getGroupSettings(msg.chatId);
          const cur = Boolean(conf.antilink === true);
          return reply(
            `⚙️ <b>Anti-Link Grup</b>\n` +
              `Status: <b>${cur ? "ON" : "OFF"}</b>\n\n` +
              `Gunakan:\n<code>${cmd} on</code> / <code>${cmd} off</code>`
          );
        }

        const next = v === "on" || v === "true" || v === "1";
        const saved = setGroupSettings(msg.chatId, { antilink: next });
        return reply(`✅ Anti-Link untuk grup ini: <b>${saved.antilink ? "ON" : "OFF"}</b>\n<i>Catatan: default OFF, jadi hanya grup yang kamu ON yang akan dimoderasi.</i>`);
      }

      case "antispam": {
        if (!isOwner) return reply("❌ Khusus Owner.");
        if (!msg.isGroup) return messGroup();

        const gKey2 = String(msg.chatId);

        antispam.groups[gKey2] = antispam.groups[gKey2] || { users: {}, enabled: false };
        if (typeof antispam.groups[gKey2].enabled !== "boolean") antispam.groups[gKey2].enabled = false;

        const arg = String(argText || "").trim().toLowerCase();
        const bar = (cur, tot, size = 14) => {
          tot = tot || 1;
          const pct = Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
          const fill = Math.round((pct / 100) * size);
          return `【${"█".repeat(fill)}${"░".repeat(size - fill)}】 ${pct}%`;
        };

        const statusMsg = await reply(
          `<b>🛡 ANTI-SPAM</b>\n` +
            `┌ ${bar(0, 4)}\n` +
            `├ 🧩 Group: <code>${gKey2}</code>\n` +
            `└ ⏳ Memproses...`
        );

        const stepEdit = async (step, line) => {
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>🛡 ANTI-SPAM</b>\n` +
                `┌ ${bar(step, 4)}\n` +
                `├ 🧩 Group: <code>${gKey2}</code>\n` +
                `└ ${line}`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {}
        };

        try {
          await stepEdit(1, "📦 Mengolah data...");

          if (arg === "on" || arg === "enable" || arg === "1" || arg === "true") {
            antispam.groups[gKey2].enabled = true;
            writeJSON(DATA_ANTISPAM, antispam);
            await stepEdit(4, "✅ Anti-Spam diaktifkan untuk grup ini.");
            return;
          }

          if (arg === "off" || arg === "disable" || arg === "0" || arg === "false") {
            antispam.groups[gKey2].enabled = false;
            writeJSON(DATA_ANTISPAM, antispam);
            await stepEdit(4, "✅ Anti-Spam dimatikan untuk grup ini.");
            return;
          }

          const parts = arg.split(/ +/).filter(Boolean);
          if (parts[0] === "set") {
            const key = (parts[1] || "").toLowerCase();
            const val = Number(parts[2] || 0);

            if (key === "threshold" && val > 0) {
              antispam.groups[gKey2].threshold = val;
              writeJSON(DATA_ANTISPAM, antispam);
              await stepEdit(4, `✅ Threshold grup di-set: <b>${val}</b>.`);
              return;
            }

            if ((key === "mute" || key === "muteseconds") && val > 0) {
              antispam.groups[gKey2].muteSeconds = val;
              writeJSON(DATA_ANTISPAM, antispam);
              await stepEdit(4, `✅ Mute grup di-set: <b>${val}s</b>.`);
              return;
            }
          }

          await stepEdit(2, "📊 Menyiapkan info...");

          const enabled = antispam.groups[gKey2].enabled ? "ON ✅" : "OFF ❌";
          const thr = Number((antispam.groups[gKey2].threshold ?? global.antispamThreshold) || 6);
          const mute = Number((antispam.groups[gKey2].muteSeconds ?? global.antispamMuteSeconds) || 60);

          await stepEdit(
            4,
            `✅ Done.\n\n` +
              `╭─❍「 <b>SETTINGS</b> 」❍\n` +
              `├ <b>Status</b>: <b>${enabled}</b>\n` +
              `├ <b>Threshold</b>: <code>${thr}</code> / 15s\n` +
              `├ <b>Mute</b>: <code>${mute}s</code>\n` +
              `╰──────❍\n\n` +
              `╭─❍「 <b>COMMAND</b> 」❍\n` +
              `├ <code>${cmd} on</code>\n` +
              `├ <code>${cmd} off</code>\n` +
              `├ <code>${cmd} set threshold 6</code>\n` +
              `├ <code>${cmd} set mute 60</code>\n` +
              `╰──────❍\n\n` +
              `<i>Catatan: default OFF, jadi hanya grup yang kamu ON yang akan dimoderasi.</i>`
          );
        } catch (e) {
          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text:
                `<b>🛡 ANTI-SPAM</b>\n` +
                `┌ ${bar(4, 4)}\n` +
                `├ 🧩 Group: <code>${gKey2}</code>\n` +
                `└ ❌ Error: <code>${safeHtml(String(e?.message || e))}</code>`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {
            await reply("❌ Terjadi error saat menjalankan antispam.");
          }
        }

        break;
      }
      
      case "tourl": {
        try {
          const safe = (s) =>
            String(s ?? "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");

          let targetMessage;
          if (msg.replyToMsgId) {
            try {
              const replied = await msg.getReplyMessage();
              if (replied) targetMessage = replied;
            } catch {}
          }

          const msgMedia = targetMessage?.media;
          if (!msgMedia) return reply("⚠️ Reply media (foto/video/audio/dokumen/stiker) untuk menggunakannya.");

          const statusMsg = await reply(
            `<b>🔗 TOURL</b>\n` +
              `┌ ${progressBar(0, 4)}\n` +
              `├ 📥 Mengambil media...\n` +
              `└ ⏳ Mohon tunggu...`
          );

          const stepEdit = async (step, line) => {
            const text =
              `<b>🔗 TOURL</b>\n` +
              `┌ ${progressBar(step, 4)}\n` +
              `├ ${line}\n` +
              `└ ⏳`;
            try {
              await pian.editMessage(msg.chatId, {
                message: statusMsg.id,
                text,
                parseMode: "html",
                linkPreview: false
              });
            } catch {}
          };

          await stepEdit(1, "📥 Mengunduh media...");

          let buffer;
          try {
            buffer = await targetMessage.downloadMedia({ downloadUrl: false });
          } catch {
            buffer = null;
          }
          if (!buffer || !buffer.length) {
            await stepEdit(4, "❌ Gagal mengambil media (buffer kosong).");
            return;
          }

          await stepEdit(2, "🧾 Mendeteksi tipe file...");

          const FormData = (await import("form-data")).default;
          const { fileTypeFromBuffer } = await import("file-type");
          const fetchModule = await import("node-fetch");
          const fetch = fetchModule.default;

          const ft = await fileTypeFromBuffer(buffer).catch(() => null);
          const ext = ft?.ext || "bin";
          const mime = ft?.mime || "application/octet-stream";

          const tempDir = "./temp";
          if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
          const filePath = path.join(tempDir, `tourl_${Date.now()}.${ext}`);
          fs.writeFileSync(filePath, buffer);

          const mediaTypeText =
            mime.startsWith("image/")
              ? "Gambar"
              : mime.startsWith("video/")
              ? "Video"
              : mime.startsWith("audio/")
              ? "Audio"
              : mime === "image/webp"
              ? "Stiker"
              : "Dokumen/File";

          const uploadToCatbox = async (buf, filename) => {
            const bodyForm = new FormData();
            bodyForm.append("fileToUpload", buf, filename);
            bodyForm.append("reqtype", "fileupload");
            const res = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: bodyForm });
            const txt = await res.text();
            if (txt && txt.startsWith("http")) return txt.trim();
            throw new Error("Catbox upload failed");
          };

          const uploadToUguu = async (buf, filename) => {
            const bodyForm = new FormData();
            bodyForm.append("files[]", buf, filename);
            const res = await fetch("https://uguu.se/upload.php", { method: "POST", body: bodyForm });
            const json = await res.json().catch(() => null);
            const url = json?.files?.[0]?.url;
            if (url) return String(url).trim();
            throw new Error("Uguu upload failed");
          };

          const uploadToQuax = async (buf, filename) => {
            const bodyForm = new FormData();
            bodyForm.append("files[]", buf, filename);
            const res = await fetch("https://qu.ax/upload.php", { method: "POST", body: bodyForm });
            const json = await res.json().catch(() => null);
            const url = json?.files?.[0]?.url;
            if (url) return String(url).trim();
            throw new Error("Qu.ax upload failed");
          };

          await stepEdit(3, "☁️ Mengupload ke server...");

          let catboxUrl = "Upload gagal";
          let uguuUrl = "Upload gagal";
          let quaxUrl = "Upload gagal";

          const uploadName = `upload_${Date.now()}.${ext}`;

          try {
            catboxUrl = await uploadToCatbox(buffer, uploadName);
          } catch {}

          try {
            uguuUrl = await uploadToUguu(buffer, uploadName);
          } catch {}

          try {
            quaxUrl = await uploadToQuax(buffer, uploadName);
          } catch {}

          const result =
            `<b>✅ HASIL UPLOAD ${safe(mediaTypeText).toUpperCase()}</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `╭─❍「 <b>📦 LINK</b> 」❍\n` +
            `├ <b>📦 Catbox</b>: <code>${safe(catboxUrl)}</code>\n` +
            `├ <b>📦 Uguu</b>  : <code>${safe(uguuUrl)}</code>\n` +
            `├ <b>📦 Qu.ax</b> : <code>${safe(quaxUrl)}</code>\n` +
            `╰──────❍\n\n` +
            `╭─❍「 <b>🧾 INFO</b> 」❍\n` +
            `├ <b>📄 Ext</b>: <code>${safe(ext)}</code>\n` +
            `├ <b>🧷 MIME</b>: <code>${safe(mime)}</code>\n` +
            `├ <b>📦 Size</b>: <code>${safe(String(buffer.length))} bytes</code>\n` +
            `╰──────❍`;

          try {
            await pian.editMessage(msg.chatId, {
              message: statusMsg.id,
              text: `<b>🔗 TOURL</b>\n┌ ${progressBar(4, 4)}\n└ ✅ Done.`,
              parseMode: "html",
              linkPreview: false
            });
          } catch {}

          await reply(result);

          try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          } catch {}

        } catch (err) {
          try {
            console.error("[tourl ERROR]", err);
          } catch {}
          await reply("❌ Gagal upload, pastikan yang di-reply itu media valid!");
        }
        break;
      }
      
      case "me": {
  try {
    const safe = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const fmtPhone = (p) => {
      const ph = String(p || "").trim();
      if (!ph) return "-";
      return ph.startsWith("+") ? ph : `+${ph}`;
    };

    let targetId = null;

    if (msg.replyToMsgId) {
      try {
        const rep = await msg.getReplyMessage();
        if (rep?.senderId) targetId = rep.senderId.toString();
      } catch {}
    }

    if (!targetId) targetId = msg.senderId?.toString?.() || "";

    const user = await pian.getEntity(targetId);

    const chatIdStr = String(msg.chatId ?? "-");
    const roomType = msg.isGroup ? "Group/Channel" : "Private";

    const uid = user?.id ? String(user.id) : "-";
    const first = user?.firstName || "";
    const last = user?.lastName || "";
    const fullName = safe(`${first} ${last}`.trim() || "User");
    const uname = user?.username ? `@${user.username}` : "-";
    const phone = fmtPhone(user?.phone);
    const isBot = user?.bot ? "Ya" : "Tidak";
    const isPremium = user?.premium ? "Ya" : "Tidak";
    const isVerified = user?.verified ? "Ya" : "Tidak";
    const isScam = user?.scam ? "Ya" : "Tidak";
    const isFake = user?.fake ? "Ya" : "Tidak";
    const lang = user?.langCode ? safe(user.langCode) : "-";

    const pfp = user?.photo?.big || user?.photo?.small || null;

    const caption =
      `👤 <b>USER INFO</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `╭─❍「 <b>🧑 PROFILE</b> 」❍\n` +
      `├ <b>📛 Nama</b>: <b>${fullName}</b>\n` +
      `├ <b>🆔 ID</b>: <code>${safe(uid)}</code>\n` +
      `├ <b>👤 Username</b>: ${safe(uname)}\n` +
      `├ <b>📱 Phone</b>: <code>${safe(phone)}</code>\n` +
      `╰──────❍\n\n` +
      `╭─❍「 <b>✅ STATUS</b> 」❍\n` +
      `├ <b>🌐 Bot</b>: ${safe(isBot)}\n` +
      `├ <b>✅ Premium</b>: ${safe(isPremium)}\n` +
      `├ <b>✔️ Verified</b>: ${safe(isVerified)}\n` +
      `├ <b>⚠️ Scam</b>: ${safe(isScam)}\n` +
      `├ <b>🚫 Fake</b>: ${safe(isFake)}\n` +
      `├ <b>🌐 Lang</b>: <code>${safe(lang)}</code>\n` +
      `╰──────❍\n\n` +
      `╭─❍「 <b>💬 CHAT INFO</b> 」❍\n` +
      `├ <b>🏷 Type</b>: ${safe(roomType)}\n` +
      `├ <b>🧩 Room ID</b>: <code>${safe(chatIdStr)}</code>\n` +
      `╰──────❍`;

    if (pfp) {
      await pian.sendFile(msg.chatId, {
        file: pfp,
        caption,
        replyTo: msg.id,
        parseMode: "html",
        linkPreview: false
      });
    } else {
      await reply(caption);
    }
  } catch {
    await reply("❌ Gagal mengambil info user.");
  }
  break;
}

case "id": {
  try {
    const safe = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    let target = null;

    if (msg.replyToMsgId) {
      try {
        const rep = await msg.getReplyMessage();
        if (rep?.chatId) target = String(rep.chatId);
        else if (rep?.senderId) target = rep.senderId.toString();
      } catch {}
    }

    if (!target && argText) {
      let t = argText.trim();
      const m = t.match(/(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{3,64})/i);
      if (m?.[1]) t = "@" + m[1];
      if (!t.startsWith("@") && /^[A-Za-z0-9_]{3,64}$/.test(t)) t = "@" + t;
      target = t;
    }

    if (!target) target = msg.senderId?.toString?.() || "";

    let ent;
    try {
      ent = await pian.getInputEntity(target);
    } catch {
      ent = target;
    }

    const entity = await pian.getEntity(ent);

    const type = entity?.className || "Unknown";
    const id = entity?.id ? String(entity.id) : "-";
    const username = entity?.username ? `@${entity.username}` : "-";

    let name = "-";
    if (entity?.title) name = entity.title;
    else if (entity?.firstName || entity?.lastName) name = `${entity.firstName || ""} ${entity.lastName || ""}`.trim();

    const pfp = entity?.photo?.big || entity?.photo?.small || null;

    let extraInfo = "";

    if (type === "User") {
      const phone = entity?.phone ? `+${entity.phone}` : "-";
      extraInfo =
        `╭─❍「 <b>✅ STATUS</b> 」❍\n` +
        `├ <b>🌐 Bot</b>: ${entity.bot ? "Ya" : "Tidak"}\n` +
        `├ <b>✅ Premium</b>: ${entity.premium ? "Ya" : "Tidak"}\n` +
        `├ <b>✔️ Verified</b>: ${entity.verified ? "Ya" : "Tidak"}\n` +
        `├ <b>⚠️ Scam</b>: ${entity.scam ? "Ya" : "Tidak"}\n` +
        `├ <b>🚫 Fake</b>: ${entity.fake ? "Ya" : "Tidak"}\n` +
        `├ <b>📱 Phone</b>: <code>${safe(phone)}</code>\n` +
        `╰──────❍\n\n`;
    } else {
      extraInfo =
        `╭─❍「 <b>📢 INFO</b> 」❍\n` +
        `├ <b>📌 Type</b>: <code>${safe(type)}</code>\n` +
        `├ <b>👥 Megagroup</b>: ${entity.megagroup ? "Ya" : "Tidak"}\n` +
        `├ <b>📣 Broadcast</b>: ${entity.broadcast ? "Ya" : "Tidak"}\n` +
        `╰──────❍\n\n`;
    }

    const caption =
      `🆔 <b>ID LOOKUP</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `╭─❍「 <b>📌 ENTITY</b> 」❍\n` +
      `├ <b>📛 Nama</b>: <b>${safe(name)}</b>\n` +
      `├ <b>🆔 ID</b>: <code>${safe(id)}</code>\n` +
      `├ <b>👤 Username</b>: ${safe(username)}\n` +
      `╰──────❍\n\n` +
      `${extraInfo}` +
      `╭─❍「 <b>💬 CHAT</b> 」❍\n` +
      `├ <b>🏷 Type</b>: <code>${safe(type)}</code>\n` +
      `├ <b>🧩 Room ID</b>: <code>${safe(String(msg.chatId))}</code>\n` +
      `╰──────❍`;

    if (pfp) {
      await pian.sendFile(msg.chatId, {
        file: pfp,
        caption,
        replyTo: msg.id,
        parseMode: "html",
        linkPreview: false
      });
    } else {
      await reply(caption);
    }
  } catch {
    await reply("❌ Gagal mengambil ID (entity tidak ditemukan).");
  }
  break;
}


      case "listgc": {
        if (!isOwner) return messOwner();
        await reply("<b>⚙️ Mengambil daftar grup & channel...</b>");
        const dialogs = await pian.getDialogs();
        const targets = dialogs.filter((d) => d.isGroup || d.isChannel);
        if (!targets.length) return reply("<b>⚠️ Tidak ada grup atau channel ditemukan.</b>");
        let list = "<b>Daftar Grup/Channel:</b>\n\n";
        targets.forEach((d, i) => {
          list += `${i + 1}. ${d.name || "(Tanpa Nama)"} - <code>${d.id}</code>\n`;
        });
        await pian.sendMessage(msg.chatId, { message: list, parseMode: "html", replyTo: msg.id });
        break;
      }

      case "scangroup":
      case "scangroub": {
        if (!isOwner) return messOwner();
        const progress = await pian.sendMessage(msg.chatId, { message: `<b>🔎 Scanning group...</b>\n${progressBar(0, 1)}`, parseMode: "html", replyTo: msg.id });
        const dialogs = await pian.getDialogs();
        const targets = dialogs.filter((d) => (d.isGroup || d.isChannel) && !blacklist.includes(String(d.id)));
        let left = 0;
        let checked = 0;
        const total = targets.length || 1;

        for (const d of targets) {
          checked++;
          let shouldLeave = false;
          try {
            const ent = await pian.getEntity(d.id);
            const canWrite = await canWriteInChat(pian, ent, me.id);
            if (!canWrite) shouldLeave = true;
          } catch {
            shouldLeave = true;
          }

          if (shouldLeave) {
            try {
              const ent = await pian.getEntity(d.id);
              const ok = await tryLeave(pian, ent);
              if (ok) left++;
            } catch {}
          }

          if (checked === 1 || checked === total || checked % 4 === 0) {
            const txt = `<b>🔎 Scanning group...</b>\n${progressBar(checked, total)}\nKeluar: <b>${left}</b>`;
            try {
              await pian.editMessage(msg.chatId, { message: progress.id, text: txt, parseMode: "html", linkPreview: false });
            } catch {
              try {
                await pian.sendMessage(msg.chatId, { message: txt, parseMode: "html" });
              } catch {}
            }
          }
          await sleep(700);
        }

        const doneTxt = `<b>✅ Scan selesai</b>\nTotal dicek: <b>${targets.length}</b>\nKeluar: <b>${left}</b>`;
        try {
          await pian.editMessage(msg.chatId, { message: progress.id, text: doneTxt, parseMode: "html", linkPreview: false });
        } catch {
          await reply(doneTxt);
        }
        break;
      }


      case "zombies":
      case "zombie": {
        if (!isOwner) return messOwner();
        if (!msg.isGroup) return messGroup();
        const prog = await pian.sendMessage(msg.chatId, {
          message: `<b>🧟 Zombies cleanup (deleted only)...</b>\n${progressBar(0, 1)}\nKriteria: <b>akun terhapus</b>`,
          parseMode: "html",
          replyTo: msg.id
        });

        let kicked = 0;
        let scanned = 0;

        let chatEntity;
        try {
          chatEntity = await pian.getEntity(msg.chatId);
        } catch {
          return reply("❌ Gagal membaca entity grup.");
        }

        let participants = [];
        try {
          participants = await pian.getParticipants(chatEntity);
        } catch {
          return reply("❌ Gagal mengambil member (pastikan kamu admin dan grup mendukung).");
        }

        const total = participants.length || 1;

        for (const u of participants) {
          scanned++;
          if (!u?.id) continue;
          if (String(u.id) === String(me.id)) continue;

          const isDeleted = Boolean(u.deleted); // // ONLY THIS
          if (isDeleted) {
            const ok = await tryKickUser(pian, chatEntity, u.id);
            if (ok) kicked++;
            await sleep(900);
          }

          if (scanned === 1 || scanned === total || scanned % 10 === 0) {
            const txt = `<b>🧟 Zombies cleanup (deleted only)...</b>\n${progressBar(scanned, total)}\nKick: <b>${kicked}</b>\nDicek: <b>${scanned}</b>/<b>${total}</b>`;
            try {
              await pian.editMessage(msg.chatId, { message: prog.id, text: txt, parseMode: "html", linkPreview: false });
            } catch {}
          }
        }

        const doneTxt = `<b>✅ Zombies selesai</b>\nDicek: <b>${participants.length}</b>\nKick (akun terhapus): <b>${kicked}</b>\nKriteria: <b>akun terhapus</b>`;
        try {
          await pian.editMessage(msg.chatId, { message: prog.id, text: doneTxt, parseMode: "html", linkPreview: false });
        } catch {
          await reply(doneTxt);
        }
        break;
      }

      case "bl": {
        if (!isOwner) return messOwner();
        if (!msg.isGroup) return messGroup();
        const groupId = String(msg.chatId);
        const group = await pian.getEntity(chatId);
        if (blacklist.includes(groupId)) return reply(`⚠️ Grup <b>${group.title}</b> sudah ada di blacklist.`);
        blacklist.push(groupId);
        writeJSON(DATA_BLACKLIST, blacklist);
        await reply(`✅ Grup <b>${group.title}</b> berhasil ditambahkan ke blacklist.`);
        break;
      }

      case "delbl": {
        if (!isOwner) return messOwner();
        if (!msg.isGroup) return messGroup();
        const groupId = String(msg.chatId);
        const group = await pian.getEntity(chatId);
        if (!blacklist.includes(groupId)) return reply(`⚠️ Grup <b>${group.title}</b> tidak ada di blacklist.`);
        blacklist = blacklist.filter((id) => id !== groupId);
        writeJSON(DATA_BLACKLIST, blacklist);
        await reply(`✅ Grup <b>${group.title}</b> dihapus dari blacklist.`);
        break;
      }

      case "listbl": {
        if (!isOwner) return messOwner();
        if (blacklist.length === 0) return reply("Tidak ada grup dalam blacklist.");
        let txt = "\n";
        for (const [i, id] of blacklist.entries()) {
          try {
            const group = await pian.getEntity(id);
            txt += `${i + 1}. ${group.title} (<code>${id}</code>)\n`;
          } catch {
            txt += `${i + 1}. [Tidak diketahui] (<code>${id}</code>)\n`;
          }
        }
        await reply(txt);
        break;
      }

      case "resetbl": {
        if (!isOwner) return messOwner();
        blacklist = [];
        writeJSON(DATA_BLACKLIST, blacklist);
        await reply("✅ Semua grup dalam blacklist telah dihapus.");
        break;
      }

      case "bc": {
        if (!isOwner) return messOwner();
        if (!argText) return reply(`Masukan teks broadcast!\n\nContoh penggunaan:\n<code>${cmd}</code> teks`);
        const dialogs = await pian.getDialogs();
        const targets = dialogs.filter((d) => (d.isGroup || d.isChannel) && !blacklist.includes(String(d.id)));
        await reply(`📢 <b>Mulai mengirim broadcast ke ${targets.length} grup & channel...</b>`);
        let sukses = 0,
          gagal = 0;
        for (const d of targets) {
          try {
            await pian.sendMessage(d.id, { message: argText, parseMode: "html" });
            sukses++;
          } catch {
            gagal++;
          }
          await sleep(1000);
        }
        await reply(`✅ <b>Broadcast selesai!</b>\n\nSukses: ${sukses}\nGagal: ${gagal}\nBlacklist: ${blacklist.length}`);
        break;
      }

      case "cfd": {
        if (!isOwner) return messOwner();
        if (!msg.replyToMsgId) return reply(`Reply pesannya!\n\nContoh penggunaan:\n<code>${cmd}</code> dengan reply pesan`);
        const replied = await msg.getReplyMessage();
        if (!replied) return reply("⚠️Tidak dapat menemukan pesan yang dibalas.");

        const dialogs = await pian.getDialogs();
        const targetsAll = dialogs.filter((d) => (d.isGroup || d.isChannel) && !blacklist.includes(String(d.id)));
        const allowedSet = allowedGroups.length ? new Set(allowedGroups.map(String)) : null;
        const targets = allowedSet ? targetsAll.filter((d) => allowedSet.has(String(d.id))) : targetsAll;

        const prog = await reply(`🔁 <b>Forward pesan ke ${targets.length} grup/channel...</b>\n${progressBar(0, targets.length || 1)}\nSukses: <b>0</b> | Gagal: <b>0</b>`);
        let sukses = 0,
          gagal = 0;
        let done = 0;

        for (const d of targets) {
          done++;
          let ok = false;
          try {
            const ent = await pian.getEntity(d.id);
            const canWrite = await canWriteInChat(pian, ent, me.id);
            if (!canWrite) {
              ok = false;
            } else {
              await pian.forwardMessages(d.id, { messages: [replied.id], fromPeer: replied.chat });
              ok = true;
            }
          } catch {
            ok = false;
          }
          if (ok) sukses++;
          else gagal++;

          const txt = `🔁 <b>Forward pesan ke ${targets.length} grup/channel...</b>\n${progressBar(done, targets.length || 1)}\nSukses: <b>${sukses}</b> | Gagal: <b>${gagal}</b>`;
          try {
            await pian.editMessage(msg.chatId, { message: prog.id, text: txt, parseMode: "html", linkPreview: false });
          } catch {}
          await sleep(900);
        }

        const fin = `✅ <b>Forward selesai!</b>\n\nSukses: ${sukses}\nGagal: ${gagal}\nBlacklist: ${blacklist.length}`;
        try {
          await pian.editMessage(msg.chatId, { message: prog.id, text: fin, parseMode: "html", linkPreview: false });
        } catch {
          await reply(fin);
        }
        break;
      }

      case "pushkontak": {
        if (!isOwner) return messOwner();
        if (!msg.isGroup) return messGroup();
        const replied = await msg.getReplyMessage();
        if (!replied) return reply(`Reply pesannya!\n\nContoh penggunaan:\n<code>${cmd}</code> dengan reply pesan`);
        try {
          const groupEntity = await pian.getEntity(msg.chatId);
          const participants = await pian.getParticipants(groupEntity);
          const prog = await reply(`<b>⏳ Memulai forward pesan ke ${participants.length} anggota grup...</b>\n${progressBar(0, participants.length || 1)}\nTerkirim: <b>0</b>`);
          let sentCount = 0;
          let done = 0;
          for (const user of participants) {
            done++;
            if (user.bot || !user.id) continue;
            try {
              await pian.forwardMessages(user.id, { fromPeer: msg.chatId, id: [replied.id] });
              sentCount++;
            } catch {}
            if (done === 1 || done === participants.length || done % 10 === 0) {
              const txt = `<b>⏳ Memulai forward pesan ke ${participants.length} anggota grup...</b>\n${progressBar(done, participants.length || 1)}\nTerkirim: <b>${sentCount}</b>`;
              try {
                await pian.editMessage(msg.chatId, { message: prog.id, text: txt, parseMode: "html", linkPreview: false });
              } catch {}
            }
            await sleep(2000);
          }
          const fin = `<b>✅ Selesai forward ke ${sentCount} anggota grup!</b>`;
          try {
            await pian.editMessage(msg.chatId, { message: prog.id, text: fin, parseMode: "html", linkPreview: false });
          } catch {
            await reply(fin);
          }
        } catch {
          await reply("<b>❌ Terjadi kesalahan saat menjalankan pushkontak.</b>");
        }
        break;
      }

      case "pay":
      case "payment": {
        if (!global.dana && !global.ovo && !global.gopay && !global.qris) return reply("<b>⚠️ Informasi pembayaran belum dikonfigurasi.</b>");
        try {
          const paymentList = `
<blockquote><tg-emoji emoji-id="6156901817146934803">💙</tg-emoji><b>Dana :</b></blockquote> <code>${global.dana || "-"}</code>

<blockquote><tg-emoji emoji-id="6156780561630234390">💜</tg-emoji><b>Ovo :</b></blockquote> <code>${global.ovo || "-"}</code>

<blockquote><tg-emoji emoji-id="6159146671998502143">💚</tg-emoji><b>Gopay :</b></blockquote> <code>${global.gopay || "-"}</code>

<pre>Note:
WAJIB KIRIMKAN BUKTI TRANSFER DEMI KEAMANAN BERSAMA.</pre>
`;
          const Url = global.qris && String(global.qris).includes("https://") ? global.qris : "https://files.catbox.moe/cmt9nn.jpg";
          await pian.sendFile(msg.chatId, { file: Url, caption: paymentList, replyTo: msg.id, parseMode: "html" });
        } catch {
          await reply("❌ Gagal mengirimkan informasi pembayaran.");
        }
        break;
      }

      case "done":
      case "don": {
        if (!isOwner) return messOwner();
        if (!argText) return reply(`Masukan teks transaksi!\n\nContoh penggunaan:\n<code>${cmd}</code> Jasa Fix Error`);
        const teks = `
<blockquote><b>Transaksi Done ✅</b></blockquote>

📦 <b>Pembelian:</b> ${argText}
🗓️ <b>Tanggal:</b> ${global.tanggal ? global.tanggal(Date.now()) : new Date().toLocaleString()}

📢 <b>Cek Testimoni Pembeli:</b>
${global.linkChannel ? global.linkChannel : "-"}
`;
        try {
          if (msg.replyToMsgId) {
            await pian.editMessage(msg.chatId, { message: msg.replyToMsgId, text: teks, parseMode: "html", linkPreview: false });
          } else {
            await pian.sendMessage(msg.chatId, { message: teks, parseMode: "html", linkPreview: false });
          }
        } catch {
          await reply("❌ Gagal mengedit atau mengirim pesan konfirmasi transaksi.");
        }
        break;
      }

      case "proses":
      case "ps": {
        if (!isOwner) return messOwner();
        if (!argText) return reply(`Masukan teks transaksi!\n\nContoh penggunaan:\n<code>${cmd}</code> Jasa Fix Error`);
        const teks = `
<blockquote><b>Dana Telah Diterima ✅</b></blockquote>

📦 <b>Pembelian:</b> ${argText}
🗓️ <b>Tanggal:</b> ${global.tanggal ? global.tanggal(Date.now()) : new Date().toLocaleString()}

📢 <b>Cek Testimoni Pembeli:</b>
${global.linkChannel ? global.linkChannel : "-"}
`;
        try {
          if (msg.id) {
            await pian.editMessage(msg.chatId, { message: msg.id, text: teks, parseMode: "html", linkPreview: false });
          } else {
            await pian.sendMessage(msg.chatId, { message: teks, parseMode: "html", linkPreview: false });
          }
        } catch {
          await reply("❌ Gagal mengedit atau mengirim pesan konfirmasi transaksi.");
        }
        break;
      }
      
      case "backupsc":
      case "bck":
      case "backup": {
        if (!isOwner) return messOwner();
        try {
          await reply("⏳ <b>Memproses Backup Script...</b>");
          const bulanIndo = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
          const tgl = new Date();
          const tanggal = tgl.getDate().toString().padStart(2, "0");
          const bulan = bulanIndo[tgl.getMonth()];
          const name = `VexaUbot-${tanggal}-${bulan}-${tgl.getFullYear()}`;

          const exclude = ["node_modules", "package-lock.json", "yarn.lock", ".npm", ".cache"];
          const filesToZip = fs.readdirSync(".").filter((f) => !exclude.includes(f) && f !== "");

          if (!filesToZip.length) return reply("❌ <b>Tidak ada file yang dapat di-backup.</b>");

          const outputPath = `./${name}.zip`;
          const output = fs.createWriteStream(outputPath);
          const archive = archiver("zip", { zlib: { level: 9 } });
          archive.pipe(output);

          for (const file of filesToZip) {
            const stat = fs.statSync(file);
            if (stat.isDirectory()) archive.directory(file, file);
            else archive.file(file, { name: file });
          }

          await archive.finalize();

          output.on("close", async () => {
            try {
              await pian.sendFile(global.ownerID, { file: outputPath, caption: "✅ <b>Backup Script selesai!</b>", parseMode: "html" });
              fs.unlinkSync(outputPath);
              if (String(msg.chatId) !== String(global.ownerID || "")) {
                await pian.sendMessage(msg.chatId, {
                  message: "✅ <b>Backup script selesai!</b>\nFile telah dikirim ke chat pribadi.",
                  replyTo: msg.id,
                  parseMode: "html"
                });
              }
            } catch {
              await reply("❌ <b>Gagal mengirim file backup ke chat pribadi.</b>");
            }
          });
        } catch {
          await reply("❌ <b>Terjadi kesalahan saat melakukan backup.</b>");
        }
        break;
      }

      case "1gb":
      case "2gb":
      case "3gb":
      case "4gb":
      case "5gb":
      case "6gb":
      case "7gb":
      case "8gb":
      case "9gb":
      case "10gb":
      case "unlimited":
      case "unli": {
        if (!isOwner && !isSeller) return messOwner();
        if (!argText) return reply(`Masukan username!\n\nContoh penggunaan:\n<code>${cmd}</code> Raszz`);

        const username = argText.toLowerCase();
        const email = `${username}@gmail.com`;
        const name = `${global.capital ? global.capital(username) : username} Server`;
        const password = `${username}001`;

        const resourceMap = {
          "1gb": { ram: "1000", disk: "1000", cpu: "40" },
          "2gb": { ram: "2000", disk: "1000", cpu: "60" },
          "3gb": { ram: "3000", disk: "2000", cpu: "80" },
          "4gb": { ram: "4000", disk: "2000", cpu: "100" },
          "5gb": { ram: "5000", disk: "3000", cpu: "120" },
          "6gb": { ram: "6000", disk: "3000", cpu: "140" },
          "7gb": { ram: "7000", disk: "4000", cpu: "160" },
          "8gb": { ram: "8000", disk: "4000", cpu: "180" },
          "9gb": { ram: "9000", disk: "5000", cpu: "200" },
          "10gb": { ram: "10000", disk: "5000", cpu: "220" },
          unlimited: { ram: "0", disk: "0", cpu: "0" },
          unli: { ram: "0", disk: "0", cpu: "0" }
        };

        const key = command === "unli" ? "unlimited" : command;
        const { ram, disk, cpu } = resourceMap[key] || { ram: "0", disk: "0", cpu: "0" };

        try {
          const f = await fetch(`${global.domain}/api/application/users`, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${global.apikey}` },
            body: JSON.stringify({ email, username, first_name: name, last_name: "Server", language: "en", password })
          });
          const data = await f.json();
          if (data.errors) return reply("❌ <b>Error:</b> " + JSON.stringify(data.errors[0], null, 2));
          const user = data.attributes;

          const f1 = await fetch(`${global.domain}/api/application/nests/${global.nestid}/eggs/${global.egg}`, {
            method: "GET",
            headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${global.apikey}` }
          });
          const data2 = await f1.json();
          const startup_cmd = data2.attributes?.startup || "npm start";

          const f2 = await fetch(`${global.domain}/api/application/servers`, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${global.apikey}` },
            body: JSON.stringify({
              name,
              description: global.tanggal ? global.tanggal(Date.now()) : new Date().toLocaleString(),
              user: user.id,
              egg: parseInt(global.egg),
              docker_image: "ghcr.io/parkervcp/yolks:nodejs_20",
              startup: startup_cmd,
              environment: { INST: "npm", USER_UPLOAD: "0", AUTO_UPDATE: "0", CMD_RUN: "npm start" },
              limits: { memory: ram, swap: 0, disk, io: 500, cpu },
              feature_limits: { databases: 5, backups: 5, allocations: 5 },
              deploy: { locations: [parseInt(global.loc)], dedicated_ip: false, port_range: [] }
            })
          });
          const result = await f2.json();
          if (result.errors) return reply("❌ <b>Error:</b> " + JSON.stringify(result.errors[0], null, 2));
          const server = result.attributes;

          const domainTeks = String(global.domain || "").replace(/https?:\/\//g, "");
          const tampilDomain = `<spoiler>${domainTeks}</spoiler>`;

          const teks = `
✅ <b>Berhasil membuat akun panel</b>

📡 <b>Server ID:</b> <code>${server.id}</code>
👤 <b>Username:</b> <code>${user.username}</code>
🔐 <b>Password:</b> <code>${password}</code>
🗓️ <b>Tanggal Aktivasi:</b> ${global.tanggal ? global.tanggal(Date.now()) : new Date().toLocaleString()}

⚙️ <b>Spesifikasi server panel:</b>
- RAM: ${ram === "0" ? "Unlimited" : ram / 1000 + "GB"}
- Disk: ${disk === "0" ? "Unlimited" : disk / 1000 + "GB"}
- CPU: ${cpu === "0" ? "Unlimited" : cpu + "%"}
- Panel: ${tampilDomain}

📝 <b>Rules pembelian panel:</b>
- Masa aktif 30 hari
- Data bersifat pribadi, simpan dengan aman
- Garansi berlaku 15 hari (1x replace)
- Klaim garansi wajib menyertakan bukti chat pembelian
`;

          const chatTarget = msg.isGroup ? msg.senderId : msg.chatId;
          if (msg.isGroup) await reply("✅ <b>Berhasil membuat akun panel!</b>\n📩 Data akun telah dikirim ke private chat.");
          await pian.sendMessage(chatTarget, { message: teks, parseMode: "html", linkPreview: false });
        } catch (err) {
          await reply("❌ <b>Terjadi kesalahan saat membuat panel:</b> " + (err?.message || err));
        }
        break;
      }

      case "listpanel":
      case "listserver": {
        if (!isOwner && !isSeller) return messOwner();
        try {
          const response = await fetch(`${global.domain}/api/application/servers`, {
            method: "GET",
            headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${global.apikey}` }
          });
          const result = await response.json();
          const servers = result.data || [];
          if (!servers.length) return reply("⚠️ <b>Tidak ada server panel!</b>");

          let teks = `<b>Total server panel:</b> ${servers.length}\n`;
          for (const server of servers) {
            const s = server.attributes;
            const ram = s.limits.memory === 0 ? "Unlimited" : s.limits.memory >= 1024 ? `${Math.floor(s.limits.memory / 1024)} GB` : `${s.limits.memory} MB`;
            const disk = s.limits.disk === 0 ? "Unlimited" : s.limits.disk >= 1024 ? `${Math.floor(s.limits.disk / 1024)} GB` : `${s.limits.disk} MB`;
            const cpu = s.limits.cpu === 0 ? "Unlimited" : `${s.limits.cpu}%`;
            teks += `
• <b>ID:</b> <code>${s.id}</code>
• <b>Nama Server:</b> ${s.name}
• <b>RAM:</b> ${ram}
• <b>Disk:</b> ${disk}
• <b>CPU:</b> ${cpu}
• <b>Dibuat:</b> ${s.created_at?.split("T")[0] || "-"}\n`;
          }
          await pian.sendMessage(msg.chatId, { message: teks, parseMode: "html", replyTo: msg.id });
        } catch {
          await reply("⚠️ <b>Terjadi kesalahan saat mengambil data server.</b>");
        }
        break;
      }

      case "delpanel": {
        if (!isOwner && !isSeller) return messOwner();
        if (!argText) return reply(`Input ID Server!\n\nContoh penggunaan:\n<code>${cmd}</code> 13`);
        const ids = argText.split(",").map((id) => id.trim()).filter(Boolean);

        try {
          const [serverRes, userRes] = await Promise.all([
            fetch(`${global.domain}/api/application/servers`, {
              method: "GET",
              headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${global.apikey}` }
            }),
            fetch(`${global.domain}/api/application/users`, {
              method: "GET",
              headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${global.apikey}` }
            })
          ]);

          const serverData = await serverRes.json();
          const userData = await userRes.json();
          const servers = serverData.data || [];
          const users = userData.data || [];

          if (!servers.length) return reply("⚠️ <b>Tidak ada server yang ditemukan!</b>");

          let resultMsg = "\n";

          for (const id of ids) {
            const server = servers.find((s) => s.attributes.id === Number(id));
            if (!server) {
              resultMsg += `❌ <b>ID ${id}:</b> Tidak ditemukan.\n`;
              continue;
            }

            const s = server.attributes;
            const serverName = s.name;
            const serverSection = String(s.name || "").toLowerCase();

            try {
              const delServer = await fetch(`${global.domain}/api/application/servers/${s.id}`, {
                method: "DELETE",
                headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${global.apikey}` }
              });

              if (!delServer.ok) {
                resultMsg += `⚠️ <b>ID ${id}:</b> Gagal hapus server (${serverName}).\n`;
                continue;
              }

              const user = users.find((u) => u.attributes.first_name && String(u.attributes.first_name).toLowerCase() === serverSection);
              if (user) {
                await fetch(`${global.domain}/api/application/users/${user.attributes.id}`, {
                  method: "DELETE",
                  headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${global.apikey}` }
                });
              }

              resultMsg += `✅ <b>ID ${id}:</b> Berhasil hapus server <b>${global.capital ? global.capital(serverName) : serverName}</b>.\n`;
            } catch {
              resultMsg += `❌ <b>ID ${id}:</b> Terjadi error internal.\n`;
            }
          }

          await pian.sendMessage(msg.chatId, { message: resultMsg.trim(), parseMode: "html", replyTo: msg.id });
        } catch {
          await reply("❌ <b>Terjadi kesalahan saat memproses permintaan.</b>");
        }
        break;
      }

      case "cadmin": {
        if (!isOwner) return messOwner();
        if (!argText) return reply(`Masukan username!\n\nContoh penggunaan:\n<code>${cmd}</code> Raszz`);

        const username = argText.toLowerCase();
        const email = `${username}@gmail.com`;
        const name = username.charAt(0).toUpperCase() + username.slice(1);
        const password = `${username}001`;
        const chatTarget = msg.isGroup ? msg.senderId : msg.chatId;

        try {
          const res = await fetch(`${global.domain}/api/application/users`, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${global.apikey}` },
            body: JSON.stringify({
              email,
              username,
              first_name: name,
              last_name: "Admin",
              root_admin: true,
              language: "en",
              password
            })
          });

          const data = await res.json();
          if (data.errors) return reply(`${JSON.stringify(data.errors[0], null, 2)}`);

          const user = data.attributes;
          const domainTeks = String(global.domain || "").replace(/https?:\/\//g, "");
          const tampilDomain = `<spoiler>${domainTeks}</spoiler>`;

          const teks = `
✅ <b>Berhasil membuat akun panel</b>

👤 <b>Username:</b> <code>${user.username}</code>
🔐 <b>Password:</b> <code>${password}</code>
🗓️ <b>Tanggal Aktivasi:</b> ${global.tanggal ? global.tanggal(Date.now()) : new Date().toLocaleString()}

⚙️ <b>Akses:</b> <b>ROOT ADMIN</b>
- Panel: ${tampilDomain}
`;

          if (msg.isGroup) await reply("✅ Berhasil membuat akun panel!\n📩 Data akun telah dikirim ke private chat.");
          await reply(teks, { parseMode: "html", jid: chatTarget });
        } catch {
          await reply("⚠️ Terjadi kesalahan saat membuat akun panel.");
        }
        break;
      }

      case "deladmin": {
        if (!isOwner) return messOwner();
        if (!argText) return reply(`Input ID User!\n\nContoh penggunaan:\n<code>${cmd}</code> 13`);
        try {
          const res = await fetch(`${global.domain}/api/application/users`, {
            method: "GET",
            headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${global.apikey}` }
          });
          const data = await res.json();
          const users = data.data || [];
          const targetAdmin = users.find((e) => String(e.attributes.id) === String(argText) && e.attributes.root_admin === true);
          if (!targetAdmin) return reply("Gagal menghapus admin!\nID user tidak ditemukan.");

          const idadmin = targetAdmin.attributes.id;
          const username = targetAdmin.attributes.username;

          const delRes = await fetch(`${global.domain}/api/application/users/${idadmin}`, {
            method: "DELETE",
            headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${global.apikey}` }
          });

          if (!delRes.ok) {
            const errData = await delRes.json().catch(() => null);
            const e0 = errData?.errors?.[0] || { message: "Unknown error" };
            return reply(`Gagal menghapus admin!\n${JSON.stringify(e0, null, 2)}`);
          }

          await reply(`✅ Berhasil menghapus admin panel.\nNama User: ${global.capital ? global.capital(username) : username}`);
        } catch {
          await reply("⚠️ Terjadi kesalahan saat menghapus akun admin.");
        }
        break;
      }

      case "listadmin": {
        if (!isOwner) return messOwner();
        try {
          const response = await fetch(`${global.domain}/api/application/users`, {
            method: "GET",
            headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${global.apikey}` }
          });
          const result = await response.json();
          const users = result.data || [];

          const adminUsers = users.filter((u) => u.attributes.root_admin === true);
          if (!adminUsers.length) return reply("⚠️ <b>Tidak ada admin panel!</b>");

          let teks = `<b>Total admin panel:</b> ${adminUsers.length}\n`;
          for (const admin of adminUsers) {
            const u = admin.attributes;
            teks += `
• <b>ID:</b> <code>${u.id}</code>
• <b>Nama:</b> ${u.first_name} ${u.last_name || ""}
• <b>Username:</b> ${u.username}
• <b>Dibuat:</b> ${u.created_at?.split("T")[0] || "-"}\n`;
          }

          await pian.sendMessage(msg.chatId, { message: teks, parseMode: "html", replyTo: msg.id });
        } catch {
          await reply("⚠️ <b>Terjadi kesalahan saat mengambil data admin.</b>");
        }
        break;
      }

      case "addseller": {
        if (!isOwner) return messOwner();
        let targetId = null;

        if (msg.replyToMsgId) {
          const repliedMsg = await msg.getReplyMessage();
          if (repliedMsg && repliedMsg.senderId) targetId = repliedMsg.senderId.toString();
        } else if (argText) {
          const input = argText.trim();
          if (!isNaN(input) && input.length >= 5) {
            targetId = input;
          } else {
            try {
              const username = input.startsWith("@") ? input : `@${input}`;
              const entity = await pian.getInputEntity(username);
              const sender = await pian.getEntity(entity);
              targetId = sender.id.toString();
            } catch {}
          }
        }

        if (!targetId) return reply(`Masukkan ID, @username, atau balas pesan pengguna.\n\nContoh: <code>${cmd} @username</code> atau <code>${cmd} 123456789</code>`);
        if (sellerList.includes(targetId)) return reply(`⚠️ Pengguna <code>${targetId}</code> sudah ada di daftar Seller.`);
        if (targetId === me.id.toString()) return reply("⚠️ Bot tidak bisa dijadikan Seller.");
        if (targetId === global.ownerID?.toString?.()) return reply("⚠️ Owner sudah memiliki akses penuh.");

        sellerList.push(targetId);
        writeJSON(DATA_SELLER, sellerList);

        try {
          const userEntity = await pian.getEntity(targetId);
          const username = userEntity.username ? `@${userEntity.username}` : userEntity.firstName || "Pengguna";
          await reply(`✅ Pengguna <b>${username}</b> (<code>${targetId}</code>) berhasil ditambahkan sebagai Seller.`);
        } catch {
          await reply(`✅ ID <code>${targetId}</code> berhasil ditambahkan ke daftar Seller.`);
        }
        break;
      }

      case "resetseller": {
        if (!isOwner) return messOwner();
        writeJSON(DATA_SELLER, []);
        await reply("✅ Semua reseller panel telah dihapus.");
        break;
      }

      case "delseller": {
        if (!isOwner) return messOwner();
        let targetId = null;

        if (msg.replyToMsgId) {
          const repliedMsg = await msg.getReplyMessage();
          if (repliedMsg && repliedMsg.senderId) targetId = repliedMsg.senderId.toString();
        } else if (argText) {
          const input = argText.trim();
          if (!isNaN(input) && input.length >= 5) {
            targetId = input;
          } else {
            try {
              const username = input.startsWith("@") ? input : `@${input}`;
              const entity = await pian.getInputEntity(username);
              const sender = await pian.getEntity(entity);
              targetId = sender.id.toString();
            } catch {}
          }
        }

        if (!targetId) return reply(`Masukkan ID, @username, atau balas pesan pengguna.\n\nContoh: <code>${cmd} @username</code> atau <code>${cmd} 123456789</code>`);
        const list = readJSON(DATA_SELLER, []);
        if (!list.includes(targetId)) return reply(`⚠️ Pengguna <code>${targetId}</code> tidak ada di daftar Seller.`);

        const next = list.filter((id) => id !== targetId);
        writeJSON(DATA_SELLER, next);

        try {
          const userEntity = await pian.getEntity(targetId);
          const username = userEntity.username ? `@${userEntity.username}` : userEntity.firstName || "Pengguna";
          await reply(`✅ Pengguna <b>${username}</b> (<code>${targetId}</code>) dihapus dari daftar Seller.`);
        } catch {
          await reply(`✅ ID <code>${targetId}</code> berhasil dihapus dari daftar Seller.`);
        }
        break;
      }

      case "listseller": {
        if (!isOwner) return messOwner();
        const list = readJSON(DATA_SELLER, []);
        if (!list.length) return reply("✅ Tidak ada pengguna dalam daftar Seller.");

        let txt = "\n";
        for (const [i, id] of list.entries()) {
          try {
            const user = await pian.getEntity(id);
            const username = user.username ? `@${user.username}` : user.firstName || "(Tanpa Nama)";
            txt += `${i + 1}. ${username} (<code>${id}</code>)\n`;
          } catch {
            txt += `${i + 1}. [Tidak diketahui] (<code>${id}</code>)\n`;
          }
        }
        await reply(txt);
        break;
      }

      case "subdomain":
      case "domain":
      case "subdo": {
        if (!isOwner) return messOwner();

        const dom = global.subdomain ? Object.keys(global.subdomain) : [];

        if (!argText) {
          if (!dom.length) return reply("⚠️ Tidak ada domain yang tersedia! Harap konfigurasi <code>global.subdomain</code>.");
          let teks = "🌐 Daftar Domain Tersedia:\n\n";
          dom.forEach((d, i) => (teks += `${i + 1}. ${d}\n`));
          teks += `\nCara membuat subdomain:\n<code>${cmd} [nomor] hostname|ipvps</code>`;
          return reply(teks);
        }

        const parts = argText.split(" ");
        const domainNumber = parts[0];
        const hostAndIpText = parts.slice(1).join(" ").trim();
        const domainIndex = Number(domainNumber) - 1;

        if (isNaN(domainIndex) || domainIndex < 0 || domainIndex >= dom.length) return reply(`Domain tidak ditemukan! Masukkan nomor domain yang valid.\n\nContoh: <code>${cmd} 1 panel|1.2.3.4</code>`);

        const tldnya = dom[domainIndex];
        if (!hostAndIpText || !hostAndIpText.includes("|")) return reply("⚠️ Hostname / IP tidak valid!\nContoh: <code>1 panel|1.2.3.4</code>");

        const [host, ip] = hostAndIpText.split("|").map((str) => str.trim());
        if (!host || !ip) return reply("⚠️ Hostname / IP tidak boleh kosong setelah pemisah '|'!");

        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
        if (!ipRegex.test(ip)) return reply("⚠️ Format IP Address tidak valid!");

        const subDomainAPI = async (subHost, ipAddress, tldConfig) => {
          try {
            const response = await axios.post(
              `https://api.cloudflare.com/client/v4/zones/${tldConfig.zone}/dns_records`,
              {
                type: "A",
                name: `${subHost.replace(/[^a-z0-9.-]/gi, "")}.${tldnya}`,
                content: ipAddress.replace(/[^0-9.]/gi, ""),
                ttl: 3600,
                priority: 10,
                proxied: false
              },
              { headers: { Authorization: `Bearer ${tldConfig.apitoken}`, "Content-Type": "application/json" } }
            );
            const res = response.data;
            if (res.success) return { success: true, name: res.result?.name, ip: res.result?.content };
            return { success: false, error: res.errors?.[0]?.message || "Gagal membuat subdomain." };
          } catch (error) {
            return { success: false, error: error.response?.data?.errors?.[0]?.message || error.message || "Terjadi kesalahan pada API!" };
          }
        };

        await reply("⏳ Memproses pembuatan Subdomain (Panel & Node)...");
        const tldConfig = global.subdomain[tldnya];
        const domnode = `node-${String(global.getRandom ? global.getRandom(5) : Math.random().toString(36).slice(2, 7)).toLowerCase()}`;

        let teksResult = "✅ Subdomain berhasil dibuat!\n\n";
        teksResult += `🌍 IP Address: <code>${ip}</code>\n`;

        for (let i = 0; i < 2; i++) {
          const subHost = i === 0 ? host.toLowerCase() : domnode;
          const result = await subDomainAPI(subHost, ip, tldConfig);
          if (result.success) teksResult += `${i === 0 ? "📮 Panel" : "📡 Node"}: <code>${result.name}</code>\n`;
          else return reply(`❌ Gagal membuat ${i === 0 ? "Panel" : "Node"} Subdomain: ${result.error}`);
        }

        await reply(teksResult);
        break;
      }

      case "installpanel": {
        if (!isOwner) return messOwner();
        if (!argText) {
          return pian.sendMessage(msg.chatId, { message: `Format Salah!\n\nContoh penggunaan:\n<code>${cmd}</code> ipvps|pwvps|panel.com|node.com|ramserver`, parseMode: "html" });
        }

        const vii = argText.split("|");
        if (vii.length < 5) {
          return pian.sendMessage(msg.chatId, { message: `Format Salah!\n\nContoh penggunaan:\n<code>${cmd}</code> ipvps|pwvps|panel.com|node.com|ramserver`, parseMode: "html" });
        }

        const ssh = new SSHClient();
        const ipVps = vii[0];
        const pwVps = vii[1];
        const domainpanel = vii[2];
        const domainnode = vii[3];
        const ramserver = vii[4];
        const jids = msg.chatId;
        const passwordPanel = "admin001";
        const commandPanel = `bash <(curl -s https://pterodactyl-installer.se)`;

        const connSettings = { host: ipVps, port: vii[5] ? parseInt(vii[5]) : 22, username: "root", password: pwVps };

        const instalPanel = async () => {
          ssh.exec(commandPanel, (err, stream) => {
            if (err) return pian.sendMessage(jids, { message: `Gagal menjalankan instalasi panel: ${err.message}` });

            stream
              .on("data", (data) => {
                const str = data.toString();
                if (str.includes("Input 0-6")) stream.write("0\n");
                if (str.includes("(y/N)")) stream.write("y\n");
                if (str.includes("Database name (panel)")) stream.write("\n");
                if (str.includes("Database username (pterodactyl)")) stream.write("admin\n");
                if (str.includes("Password (press enter")) stream.write("admin\n");
                if (str.includes("Select timezone")) stream.write("Asia/Jakarta\n");
                if (str.includes("Provide the email address")) stream.write("admin@gmail.com\n");
                if (str.includes("Email address for the initial admin account")) stream.write("admin@gmail.com\n");
                if (str.includes("Username for the initial admin account")) stream.write("admin\n");
                if (str.includes("First name for the initial admin account")) stream.write("admin\n");
                if (str.includes("Last name for the initial admin account")) stream.write("admin\n");
                if (str.includes("Password for the initial admin account")) stream.write(`${passwordPanel}\n`);
                if (str.includes("Set the FQDN of this panel")) stream.write(`${domainpanel}\n`);
                if (str.includes("Do you want to automatically configure UFW")) stream.write("y\n");
                if (str.includes("Do you want to automatically configure HTTPS")) stream.write("y\n");
                if (str.includes("Select the appropriate number")) stream.write("1\n");
                if (str.includes("I agree that this HTTPS request")) stream.write("y\n");
                if (str.includes("Proceed anyways")) stream.write("y\n");
                if (str.includes("(yes/no)")) stream.write("y\n");
                if (str.includes("Initial configuration completed")) stream.write("y\n");
                if (str.includes("Still assume SSL?")) stream.write("y\n");
                if (str.includes("Please read the Terms of Service")) stream.write("y\n");
                if (str.includes("(A)gree/(C)ancel")) stream.write("A\n");
              })
              .stderr.on("data", (data) => pian.sendMessage(jids, { message: `Error pada instalasi Panel:\n${data.toString()}` }))
              .on("close", () => instalWings());
          });
        };

        const instalWings = async () => {
          ssh.exec(commandPanel, (err, stream) => {
            if (err) return pian.sendMessage(jids, { message: `Gagal memulai instalasi Wings: ${err.message}` });

            stream
              .on("data", (data) => {
                const str = data.toString();
                if (str.includes("Input 0-6")) stream.write("1\n");
                if (str.includes("(y/N)")) stream.write("y\n");
                if (str.includes("Enter the panel address")) stream.write(`${domainpanel}\n`);
                if (str.includes("Database host username")) stream.write("admin\n");
                if (str.includes("Database host password")) stream.write("admin\n");
                if (str.includes("Set the FQDN")) stream.write(`${domainnode}\n`);
                if (str.includes("Enter email address for Let")) stream.write("admin@gmail.com\n");
              })
              .stderr.on("data", (data) => pian.sendMessage(jids, { message: `Error pada instalasi Wings:\n${data.toString()}` }))
              .on("close", () => InstallNodes());
          });
        };

        const InstallNodes = async () => {
          ssh.exec("bash <(curl -s https://raw.githubusercontent.com/SkyzoOffc/Pterodactyl-Theme-Autoinstaller/main/createnode.sh)", (err, stream) => {
            if (err) throw err;

            stream
              .on("data", (data) => {
                const str = data.toString();
                if (str.includes("Masukkan nama lokasi")) stream.write("Singapore\n");
                if (str.includes("Masukkan deskripsi lokasi")) stream.write("Node By Skyzo\n");
                if (str.includes("Masukkan domain")) stream.write(`${domainnode}\n`);
                if (str.includes("Masukkan nama node")) stream.write("Skyzopedia\n");
                if (str.includes("Masukkan RAM")) stream.write(`${ramserver}\n`);
                if (str.includes("Masukkan jumlah maksimum disk")) stream.write(`${ramserver}\n`);
                if (str.includes("Masukkan Locid")) stream.write("1\n");
              })
              .stderr.on("data", (data) => pian.sendMessage(jids, { message: `Error pada instalasi Node:\n${data.toString()}` }))
              .on("close", async () => {
                const teks = `
<b>✅ Install Panel Berhasil!</b>

<b>📦 Detail Akun Panel Kamu:</b>
👤 <b>Username:</b> <code>admin</code>
🔐 <b>Password:</b> <code>${passwordPanel}</code>
🌐 <spoiler>${domainpanel}</spoiler>

<b>⚙️ Silakan atur allocation & ambil token node</b> pada node yang sudah dibuat oleh bot.

<b>🚀 Cara menjalankan wings:</b>
<code>${global.prefix}startwings ${ipVps}|${pwVps}|tokennode</code>
`;
                await pian.sendMessage(jids, { message: teks, parseMode: "html" });
                ssh.end();
              });
          });
        };

        ssh
          .on("ready", async () => {
            await pian.sendMessage(jids, {
              message: `🛠️ Proses instalasi panel sedang berjalan 🚀

📡 IP Address: ${ipVps}
🌐 Domain Panel: <spoiler>${domainpanel}</spoiler>

⏳ Mohon tunggu hingga proses instalasi selesai.
Anda akan mendapatkan notifikasi setelah panel berhasil terpasang.`,
              parseMode: "html",
              replyTo: msg.id
            });

            ssh.exec("", (err, stream) => {
              if (err) throw err;
              stream.on("close", async () => instalPanel()).on("data", async () => {
                await stream.write("\t");
                await stream.write("\n");
              });
            });
          })
          .on("error", async (err) => {
            await pian.sendMessage(jids, { message: `Gagal terhubung ke server: ${err.message}`, replyTo: msg.id });
          });

        ssh.connect(connSettings);
        break;
      }

      case "startwings":
      case "configurewings": {
        if (!isOwner) return messOwner();
        const t = argText.split("|");
        if (t.length < 3) return reply(`Format Salah!\n\nContoh penggunaan:\n<code>${cmd}</code> ipvps|pwvps|token`);
        const [ipvps, passwd, token] = t;
        const connSettings = { host: ipvps, port: 22, username: "root", password: passwd };
        const ssh = new SSHClient();

        ssh
          .on("ready", () => {
            ssh.exec(`${token} && systemctl start wings`, (err, stream) => {
              if (err) return pian.sendMessage(msg.chatId, { message: "Gagal menjalankan perintah di VPS", replyTo: msg.id });

              stream
                .on("close", async () => {
                  await pian.sendMessage(msg.chatId, { message: "✅ Wings node Pterodactyl berhasil dijalankan!", replyTo: msg.id });
                  ssh.end();
                })
                .on("data", () => stream.write("y\n\n"))
                .stderr.on("data", async (data) => {
                  await pian.sendMessage(msg.chatId, { message: `Terjadi error saat eksekusi:\n${data.toString()}`, replyTo: msg.id });
                });
            });
          })
          .on("error", async () => {
            await pian.sendMessage(msg.chatId, { message: "Gagal terhubung ke VPS: IP atau password salah.", replyTo: msg.id });
          })
          .connect(connSettings);

        break;
      }

      case "eval":
      case "ev": {
        if (!isOwner) return;
        if (!argText) return pian.sendMessage(msg.chatId, { message: "Masukkan kode JavaScript untuk dievaluasi." });
        try {
          let result = await eval(`(async () => { ${argText} })()`);
          if (typeof result !== "string") result = (await import("util")).inspect(result, { depth: 1 });

          if (result.length > 4000) {
            const filePath = "./eval_result.txt";
            fs.writeFileSync(filePath, result);
            await pian.sendFile(msg.chatId, { file: filePath, caption: "✅ Eval berhasil (hasil dikirim sebagai file)" });
            fs.unlinkSync(filePath);
          } else {
            await pian.sendMessage(msg.chatId, { message: `<b>✅ Eval berhasil:</b>\n<pre>${result}</pre>`, parseMode: "html" });
          }
        } catch (err) {
          await pian.sendMessage(msg.chatId, { message: `<b>❌ Eval error:</b>\n<pre>${String(err)}</pre>`, parseMode: "html" });
        }
        break;
      }

      case "gikes": {
        if (!isOwner) return messOwner();
        await reply("❌ Perintah ini tidak diaktifkan karena berisiko digunakan untuk spam.");
        break;
      }

      default:
        break;
    }
  } catch (err) {
    try {
      console.error("Error:", err);
    } catch {}
  }
}

const __filename = fileURLToPath(import.meta.url);

if (!global.__pian_watch_registered) {
  global.__pian_watch_registered = true;
  fs.watchFile(__filename, async () => {
    fs.unwatchFile(__filename);
    console.log(`• File update: ${__filename}`);
    try {
      await import(`${pathToFileURL(__filename).href}?update=${Date.now()}`);
    } catch (e) {
      console.error("Reload error:", e?.message || e);
    }
  });
}