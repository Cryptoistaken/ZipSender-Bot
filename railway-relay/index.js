import express from "express";
import multer from "multer";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger } from "telegram/extensions/index.js";
import fs from "fs";

const PORT = process.env.PORT || 3000;
const RELAY_API_KEY = process.env.RELAY_API_KEY || "zipsender-relay-key-2024";
const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID || "25180122");
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || "9671dfbdfd00b57f61dbb8babd661701";
const TELEGRAM_SESSION = process.env.TELEGRAM_SESSION || "1BQANOTEuMTA4LjU2LjEwMgG7ehx4Vg84l48gdaP/fdXsD0PjcRXK4lL4D16OIu+CM5Q+KdBEB41GlrXUnHV5IhFKsACqCG4uP7wr6JciBq6t4KEkJxY9xjRaZuTtTTwSqbYNuZeF2N97sBHKaCia71m3qKxwdbJX4IG/P6sngiI+fnIqxw0J5u5M6oyxw0TsoHywKvdviHYWIPgFX5yEGX3EaCBE9QgwRWH811Lgh9IvaS2f4jLQMNyFzElsBTny3ObP3ComN8fTjnXyZsw+nK596szWPgcIkrgjHkbgKAYmPDf2CjQTAfGoqc4t0BinQTMzAkJXw/gMeHeahJSlLKzj6JorxJkSfsABSXYH41yhxQ==";
const BOT_TOKEN = process.env.BOT_TOKEN || "7798380730:AAHNSDpQ8nGkpn3LUBHncC_0rRwl4SywDPc";

const upload = multer({ dest: "/tmp/" });
const app = express();

function auth(req, res, next) {
  const key = req.headers["authorization"]?.replace("Bearer ", "");
  if (!RELAY_API_KEY || key === RELAY_API_KEY) return next();
  res.status(401).json({ error: "unauthorized" });
}

app.post("/upload", auth, upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "no file" });

  const { auntUsername, chatId, msgId, renamedName, callbackUrl, callbackSecret } = req.body;
  if (!auntUsername) return res.status(400).json({ error: "no auntUsername" });

  res.json({ ok: true, file: file.filename });

  const jobId = req.headers["x-job-id"] || "";

  const filePath = file.path;
  const fileName = renamedName || file.originalname || "file";
  const silentLogger = new Logger("none");

  const session = new StringSession(TELEGRAM_SESSION);
  const client = new TelegramClient(session, TELEGRAM_API_ID, TELEGRAM_API_HASH, {
    connectionRetries: 5, retryDelay: 1000, baseLogger: silentLogger,
  });

  let statusMsgId = msgId && msgId !== "null" && msgId !== "" ? Number(msgId) : null;
  let lastPct = -1;
  const startTime = Date.now();
  const fileSize = fs.statSync(filePath).size;

  let editQueue = Promise.resolve();
  function queueEdit(text) {
    editQueue = editQueue.then(() => editOrSend(text).catch(e => console.error("editOrSend err:", e.message)));
  }

  async function editOrSend(text) {
    if (!BOT_TOKEN || !chatId) return;
    try {
      if (statusMsgId) {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, message_id: statusMsgId, text }),
        });
        if (!res.ok) console.error("edit failed:", res.status, await res.text().catch(()=>""));
      } else {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
        const data = await res.json();
        if (data.ok) statusMsgId = data.result.message_id;
        else console.error("send failed:", res.status, JSON.stringify(data));
      }
    } catch (e) { console.error("editOrSend exception:", e.message); }
  }

  async function doCallback(event, message) {
    if (!callbackUrl || !callbackSecret) return;
    try {
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, chat_id: chatId, event, message, secret: callbackSecret }),
      });
    } catch {}
  }

  try {
    await queueEdit(`Relay: Uploading ${fileName}...`);
    await client.connect();

    await client.sendFile(auntUsername, {
      file: filePath,
      forceDocument: true,
      workers: 15,
      progressCallback: (progress) => {
        const pct = Math.floor(progress * 100);
        if (pct !== lastPct && (pct % 10 === 0 || pct === 100)) {
          lastPct = pct;
          const elapsed = (Date.now() - startTime) / 1000 || 0.001;
          const speed = (progress * fileSize) / elapsed;
          queueEdit(`Relay: ${fileName}\n${pct}%  ${(speed / 1024 / 1024).toFixed(1)} MB/s`);
        }
      },
    });

    const totalTime = (Date.now() - startTime) / 1000;
    const msg = `Relay: Done ${fileName} in ${totalTime.toFixed(1)}s`;
    await queueEdit(msg);
    await doCallback("done", msg);
  } catch (err) {
    const msg = `Relay: Failed ${fileName}: ${err.message}`;
    await queueEdit(msg);
    await doCallback("error", msg);
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
    try { await client.disconnect(); await client.destroy(); } catch {}
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Relay running on ${PORT}`));
