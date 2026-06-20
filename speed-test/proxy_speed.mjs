import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger } from "telegram/extensions/index.js";
import { ConnectionTCPObfuscated } from "telegram/network/index.js";
import fs from "fs";

const TELEGRAM_API_ID = 25180122;
const TELEGRAM_API_HASH = "9671dfbdfd00b57f61dbb8babd661701";
const TELEGRAM_SESSION = "1BQANOTEuMTA4LjU2LjEwMgG7ehx4Vg84l48gdaP/fdXsD0PjcRXK4lL4D16OIu+CM5Q+KdBEB41GlrXUnHV5IhFKsACqCG4uP7wr6JciBq6t4KEkJxY9xjRaZuTtTTwSqbYNuZeF2N97sBHKaCia71m3qKxwdbJX4IG/P6sngiI+fnIqxw0J5u5M6oyxw0TsoHywKvdviHYWIPgFX5yEGX3EaCBE9QgwRWH811Lgh9IvaS2f4jLQMNyFzElsBTny3ObP3ComN8fTjnXyZsw+nK596szWPgcIkrgjHkbgKAYmPDf2CjQTAfGoqc4t0BinQTMzAkJXw/gMeHeahJSlLKzj6JorxJkSfsABSXYH41yhxQ==";
const AUNT_USERNAME = "8759911558";

const PROXY_HOST = "shortline.proxy.rlwy.net";
const PROXY_PORT = 36546;
const PROXY_USER = "ratul";
const PROXY_PASS = "ratul";
const TELEGRAM_PORT = 80;

class ProxyConnection extends ConnectionTCPObfuscated {
  constructor(opts) {
    super({ ...opts, port: TELEGRAM_PORT });
  }
}

const FILE_SIZE_MB = Number(process.env.FILE_SIZE_MB || "200");
const FILE = "/tmp/upload_speed_test.bin";

console.log("=== Railway US → SOCKS5 Asia → Telegram Speed Test ===");
console.log(`Proxy: ${PROXY_HOST}:${PROXY_PORT}`);
console.log(`Telegram port: ${TELEGRAM_PORT} (443 blocked, 80 works)`);
console.log(`File: ${FILE_SIZE_MB} MB, Workers: 15\n`);

console.log("Creating test file...");
const startWrite = Date.now();
const fd = fs.openSync(FILE, "w");
const buf = Buffer.alloc(1024 * 1024, 0x42);
for (let i = 0; i < FILE_SIZE_MB; i++) { fs.writeSync(fd, buf); if (i % 50 === 0 && i > 0) process.stdout.write(`  ${i}/${FILE_SIZE_MB}MB\r`); }
fs.closeSync(fd);
console.log(`File created in ${((Date.now()-startWrite)/1000).toFixed(1)}s: ${(fs.statSync(FILE).size/1024/1024).toFixed(1)} MB\n`);

console.log("Connecting via SOCKS5 proxy...");
const logger = new Logger("none");
const client = new TelegramClient(
  new StringSession(TELEGRAM_SESSION),
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  {
    connectionRetries: 5,
    retryDelay: 1000,
    baseLogger: logger,
    connection: ProxyConnection,
    proxy: {
      socksType: 5,
      ip: PROXY_HOST,
      port: PROXY_PORT,
      username: PROXY_USER,
      password: PROXY_PASS,
    },
  },
);

await client.connect();
const me = await client.getMe();
const dc = await client.getDC(client.session.dcId);
console.log(`Logged in: ${me.firstName} (${me.id})`);
console.log(`DC ${client.session.dcId} → ${dc.ipAddress}:${TELEGRAM_PORT} via ${PROXY_HOST}:${PROXY_PORT}\n`);

console.log("Uploading...");
let lastPct = -1;
const startTime = Date.now();

await client.sendFile(AUNT_USERNAME, {
  file: FILE,
  forceDocument: true,
  workers: 15,
  progressCallback: (p) => {
    const pct = Math.floor(p * 100);
    if (pct >= lastPct + 5 || pct === 100) {
      lastPct = pct;
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = (p * fs.statSync(FILE).size) / elapsed;
      console.log(`  ${pct}%  ${(speed/1024/1024).toFixed(1)} MB/s`);
    }
  },
});

const totalTime = (Date.now() - startTime) / 1000;
console.log(`\nDone in ${totalTime.toFixed(1)}s`);
console.log(`Speed: ${(fs.statSync(FILE).size / 1024 / 1024 / totalTime).toFixed(1)} MB/s`);

fs.unlinkSync(FILE);
await client.disconnect();
await client.destroy();
