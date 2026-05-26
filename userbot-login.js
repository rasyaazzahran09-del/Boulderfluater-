#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans.trim()); }));
}

function updateEnvValue(key, value) {
  const envPath = path.join(__dirname, '.env');
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const safeValue = String(value || '').replace(/\n/g, '').trim();
  const line = `${key}=${safeValue}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(env)) env = env.replace(re, line);
  else env += (env.endsWith('\n') || env.length === 0 ? '' : '\n') + line + '\n';
  fs.writeFileSync(envPath, env);
}

(async () => {
  const { TelegramClient } = await import('telegram');
  const { StringSession } = await import('telegram/sessions/index.js');

  const apiId = Number(process.env.USERBOT_API_ID || process.env.TELEGRAM_API_ID || await ask('USERBOT_API_ID / TELEGRAM_API_ID: '));
  const apiHash = (process.env.USERBOT_API_HASH || process.env.TELEGRAM_API_HASH || await ask('USERBOT_API_HASH / TELEGRAM_API_HASH: ')).trim();
  const phone = (process.env.USERBOT_PHONE || await ask('Nomor Telegram userbot, contoh +628xxxx: ')).trim();

  if (!apiId || !apiHash || !phone) {
    console.log('❌ API ID, API HASH, dan nomor wajib diisi.');
    process.exit(1);
  }

  console.log('\n📨 Telegram akan mengirim kode login ke akun userbot.');
  console.log('Masukkan kode itu di panel/console ini.\n');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
  await client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => ask('Masukkan kode Telegram userbot: '),
    password: async () => ask('Password 2FA jika ada, kalau tidak ada kosongkan: '),
    onError: err => console.log('Login error:', err.message),
  });

  const session = client.session.save();
  updateEnvValue('USERBOT_API_ID', apiId);
  updateEnvValue('USERBOT_API_HASH', apiHash);
  updateEnvValue('USERBOT_PHONE', phone);
  updateEnvValue('USERBOT_STRING_SESSION', session);
  updateEnvValue('USERBOT_PANEL_LOGIN', 'false');

  console.log('\n✅ Userbot berhasil login.');
  console.log('✅ USERBOT_STRING_SESSION sudah disimpan otomatis ke .env');
  console.log('✅ Sekarang jalankan: npm start');
  await client.disconnect();
})().catch(err => {
  console.error('❌ Gagal login userbot:', err.message);
  process.exit(1);
});
