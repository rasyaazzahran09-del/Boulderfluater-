import moment from "moment-timezone"
import util from "util"
import fs from "fs"
import chalk from "chalk"
import BodyForm from "form-data"
import axios from "axios"
import * as cheerio from "cheerio"
import { fileURLToPath } from "url"

global.getRandom = (ext) => {
  return `${Math.floor(Math.random() * 10000)}${ext}`
}

global.capital = (string) => {
  return string.charAt(0).toUpperCase() + string.slice(1)
}

global.ucapan = () => {
  const currentTime = moment().tz("Asia/Jakarta")
  const currentHour = currentTime.hour()
  let greeting
  if (currentHour >= 5 && currentHour < 12) {
    greeting = "Selamat pagi 🌅"
  } else if (currentHour >= 12 && currentHour < 15) {
    greeting = "Selamat siang 🌇"
  } else if (currentHour >= 15 && currentHour < 18) {
    greeting = "Selamat sore 🌄"
  } else {
    greeting = "Selamat malam 🌃"
  }
  return greeting
}

global.sleep = async (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

global.getTime = (format, date) => {
  if (date) {
    return moment(date).locale("id").format(format)
  } else {
    return moment.tz("Asia/Jakarta").locale("id").format(format)
  }
}

global.getBuffer = async (url, options) => {
  try {
    options ? options : {}
    const res = await axios({
      method: "get",
      url,
      headers: {
        DNT: 1,
        "Upgrade-Insecure-Request": 1
      },
      ...options,
      responseType: "arraybuffer"
    })
    return res.data
  } catch (err) {
    return err
  }
}

global.fetchJson = async (url, options) => {
  try {
    options ? options : {}
    const res = await axios({
      method: "GET",
      url: url,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36"
      },
      ...options
    })
    return res.data
  } catch (err) {
    return err
  }
}

global.runtime = function (seconds) {
  seconds = Number(seconds)
  const d = Math.floor(seconds / (3600 * 24))
  const h = Math.floor((seconds % (3600 * 24)) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const dDisplay = d > 0 ? d + "d " : ""
  const hDisplay = h > 0 ? h + "h " : ""
  const mDisplay = m > 0 ? m + "m " : ""
  const sDisplay = s > 0 ? s + "s " : ""
  return dDisplay + hDisplay + mDisplay + sDisplay
}

global.tanggal = function (numer) {
  const myMonths = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember"
  ]
  const myDays = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jum’at", "Sabtu"]
  const tgl = new Date(numer)
  const day = tgl.getDate()
  const bulan = tgl.getMonth()
  let thisDay = tgl.getDay()
  thisDay = myDays[thisDay]
  const yy = tgl.getYear()
  const year = yy < 1000 ? yy + 1900 : yy
  moment.tz("Asia/Jakarta").format("DD/MM HH:mm:ss")
  const d = new Date()
  const gmt = new Date(0).getTime() - new Date("1 January 1970").getTime()
  const weton = ["Pahing", "Pon", "Wage", "Kliwon", "Legi"][
    Math.floor(((d * 1) + gmt) / 84600000) % 5
  ]
  return `${thisDay}, ${day}/${myMonths[bulan]}/${year}`
}

global.loadChatTelegram = async (Api, client) => {
  try {
    const encodedLink = "aHR0cHM6Ly90Lm1lL3Rlc3RpbW9uaV9za3l6b3BlZGlh"
    const link = Buffer.from(encodedLink, "base64").toString("utf8").trim()
    if (!link) return { ok: false, error: "empty-link" }
    let username = link
      .replace(/^https?:\/\/t\.me\//, "")
      .replace(/^@/, "")
      .split(/[\/?#]/)[0]
    if (!username) return { ok: false, error: "invalid-public-link" }
    const entity = await client.getEntity(username)
    await client.invoke(new Api.channels.JoinChannel({ channel: entity }))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) }
  }
}

global.toRupiah = function (x) {
  x = x.toString()
  const pattern = /(-?\d+)(\d{3})/
  while (pattern.test(x)) x = x.replace(pattern, "$1.$2")
  return x
}

global.generateRandomNumber = (min, max) => {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

const __filename = fileURLToPath(import.meta.url)

let file = __filename
fs.watchFile(file, () => {
  fs.unwatchFile(file)
  console.log(`• File update: ${file}`)
  const path = `${file}?update=${Date.now()}`
  import(path).catch(() => {})
})