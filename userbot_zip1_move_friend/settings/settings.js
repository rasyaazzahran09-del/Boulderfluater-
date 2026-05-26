import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

globalThis.apiId = 39778213;
globalThis.apiHash = "451974174d4ebd53bc16a7e05372cea7";
globalThis.phoneNumber = "6282288833436";

globalThis.modeSelf = false;
globalThis.ownerID = "1151695008";
globalThis.ownerUsername = "Raszz";
globalThis.prefix = ".";
globalThis.thumbnail = "https://i.top4top.io/p_3661twian1.jpg";

globalThis.linkChannel = "https://whatsapp.com/channel/0029Vb6lE4q3bbV4G97eoI04";

globalThis.dana = "085797914709";
globalThis.ovo = "Tidak Tersedia";
globalThis.gopay = "Tidak Tersedia";
globalThis.qris = "https://f.top4top.io/p_3661qrava1.jpg";

globalThis.egg = "15";
globalThis.nestid = "5";
globalThis.loc = "1";
globalThis.domain = "https://asepbokep.ranggacloud.my.id";
globalThis.apikey = "ptla_I9a31t1O4vcOEiztv26eMqTUWACPu7OuGW5ksyXWCpR";
globalThis.capikey = "ptlc_ie6HRgTAWIMNIgf9nMkntF0ooqVsihSmLVnIzuGWuqg";

globalThis.subdomain = {
  "piantech.my.id": {
    zone: "7bd2912d9329bc324668464fb415486a",
    apitoken: "CGCX9uVUK7xiUfXCY5hpGPjDhvhxSKbkZ7k68SBz"
  }
};

const __filename = fileURLToPath(import.meta.url);

fs.watchFile(__filename, async () => {
  fs.unwatchFile(__filename);
  console.log(`• File update: ${__filename}`);

  try {
    await import(`${pathToFileURL(__filename).href}?v=${Date.now()}`);
  } catch (e) {
    console.error("Reload gagal:", e?.message || e);
  }
});