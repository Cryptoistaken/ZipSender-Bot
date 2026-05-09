// .github/scripts/worker.js
// Runs inside GitHub Actions. Has access to env vars set as workflow inputs + secrets.
// Handles: download from GDrive → extract ZIP → AI rename → upload to Telegram

import fs from "fs";
import path from "path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger } from "telegram/extensions/index.js";
import OpenAI from "openai";
import axios from "axios";
import unzipper from "unzipper";

// ─── Config from env (injected by workflow) ───────────────────────────────────
const FILE_ID        = process.env.INPUT_FILE_ID;
const CHAT_ID        = process.env.INPUT_CHAT_ID;
const JOB_ID         = process.env.INPUT_JOB_ID;
const CALLBACK_URL   = process.env.INPUT_CALLBACK_URL || "";
const CALLBACK_SECRET = process.env.INPUT_CALLBACK_SECRET || "";
const AUNT_USERNAME  = process.env.INPUT_AUNT_USERNAME;

const TELEGRAM_API_ID   = Number(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const TELEGRAM_SESSION  = process.env.TELEGRAM_SESSION;
const BOT_TOKEN         = process.env.BOT_TOKEN;
const GROQ_API_KEY      = process.env.GROQ_API_KEY;

const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v"];

// ─── Telegram Bot API (for status messages — no gramjs needed for this) ───────
async function botSend(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  }).catch(() => {});
}

// ─── Callback to your server ──────────────────────────────────────────────────
async function callback(event, message) {
  console.log(`[${event}] ${message}`);
  // Always send via Telegram Bot API as well (instant, no server needed)
  await botSend(
    event === "done" ? `✓ ${message}` :
    event === "error" ? `✗ ${message}` :
    `⏳ ${message}`
  );

  if (!CALLBACK_URL) return;
  try {
    await fetch(CALLBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: JOB_ID,
        chat_id: CHAT_ID,
        event,
        message,
        secret: CALLBACK_SECRET,
      }),
    });
  } catch (e) {
    console.log("callback fetch failed:", e.message);
  }
}

// ─── GDrive download ──────────────────────────────────────────────────────────
function contentTypeToExt(contentType) {
  if (!contentType) return null;
  const ct = contentType.toLowerCase().split(";")[0].trim();
  const map = {
    "video/mp4":        ".mp4",
    "video/x-matroska": ".mkv",
    "video/x-msvideo":  ".avi",
    "video/quicktime":  ".mov",
    "video/webm":       ".webm",
    "video/x-m4v":      ".m4v",
  };
  return map[ct] || null;
}

async function downloadFile(fileId, destPath) {
  const url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
  console.log("downloading from", url);

  const response = await axios.get(url, {
    responseType: "stream",
    maxRedirects: 10,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const contentType = response.headers["content-type"] || "";
  const videoExtFromHeader = contentTypeToExt(contentType);

  const total = parseInt(response.headers["content-length"] || "0", 10);
  let downloaded = 0;
  let lastReported = 0;
  const startTime = Date.now();

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    const pct = total ? Math.floor((downloaded / total) * 100) : 0;
    // Log every 10% to avoid spamming
    if (pct - lastReported >= 10) {
      lastReported = pct;
      const elapsed = (Date.now() - startTime) / 1000 || 0.001;
      const speed = downloaded / elapsed;
      const speedStr =
        speed > 1024 * 1024
          ? `${(speed / 1024 / 1024).toFixed(1)} MB/s`
          : `${(speed / 1024).toFixed(1)} KB/s`;
      console.log(`download: ${pct}% at ${speedStr}`);
    }
  });

  const writer = fs.createWriteStream(destPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => {
      const buf = Buffer.alloc(12);
      const fd  = fs.openSync(destPath, "r");
      fs.readSync(fd, buf, 0, 12, 0);
      fs.closeSync(fd);

      const isZip  = buf[0] === 0x50 && buf[1] === 0x4b;
      const isMkv  = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
      const isAvi  = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46;
      const isMp4  =
        (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) ||
        (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x00);

      if (isZip) {
        resolve({ type: "zip", ext: ".zip" });
      } else if (videoExtFromHeader) {
        resolve({ type: "video", ext: videoExtFromHeader });
      } else if (isMkv) {
        resolve({ type: "video", ext: ".mkv" });
      } else if (isAvi) {
        resolve({ type: "video", ext: ".avi" });
      } else if (isMp4) {
        resolve({ type: "video", ext: ".mp4" });
      } else {
        reject(new Error("unrecognized file type — check the file is publicly shared on Drive"));
      }
    });
    writer.on("error", reject);
  });
}

// ─── ZIP extraction ───────────────────────────────────────────────────────────
async function extractZip(zipPath, destDir) {
  console.log("extracting", zipPath, "→", destDir);
  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: destDir }))
    .promise();

  const allFiles = fs.readdirSync(destDir, { recursive: true });
  const videoFiles = allFiles
    .filter((f) => VIDEO_EXTENSIONS.some((ext) => f.toString().toLowerCase().endsWith(ext)))
    .map((f) => {
      const fullPath = path.join(destDir, f.toString());
      const stat = fs.statSync(fullPath);
      return {
        originalName: path.basename(f.toString()),
        renamedName:  path.basename(f.toString()),
        fullPath,
        size: stat.size,
      };
    })
    .sort((a, b) => a.originalName.localeCompare(b.originalName));

  console.log(`found ${videoFiles.length} video files`);
  return videoFiles;
}

// ─── AI rename ────────────────────────────────────────────────────────────────
async function aiRenameFiles(fileNames) {
  const groq = new OpenAI({
    apiKey: GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });

  console.log("calling groq for rename");
  const numbered = fileNames.map((n, i) => `${i + 1}. ${n}`).join("\n");

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `You are a file name cleaner. The user gives you a numbered list of messy video file names.
Your job is to normalize each name by:
- Replacing dots and underscores with spaces
- Keeping the show/movie title, episode info (e.g. S01E03), and resolution (e.g. 720p) if present
- Removing technical junk like: x265, x264, HEVC, 10bit, 8bit, WEB-DL, WEBRip, BluRay, HDRip, HDTV, AAC, AC3, language codes (HIN, KOR, ENG, etc), ESub, YIFY, YTS, and similar tags
- Keeping the original file extension
- Output clean readable names like: True Beauty S01E03 720p.mkv or Inception 1080p.mkv

Return only a JSON array of the cleaned names in the same order. No markdown, no backticks, no explanation.`,
      },
      { role: "user", content: numbered },
    ],
    temperature: 0,
    max_completion_tokens: 1000,
  });

  try {
    const text   = completion.choices[0].message.content.trim();
    const parsed = JSON.parse(text);
    console.log("rename complete");
    return parsed;
  } catch {
    console.log("groq parse failed, using original names");
    return fileNames;
  }
}

// ─── Telegram upload via gramjs ───────────────────────────────────────────────
let gramClient = null;

async function initGramClient() {
  const silentLogger = new Logger("none");
  const session = new StringSession(TELEGRAM_SESSION);
  gramClient = new TelegramClient(session, TELEGRAM_API_ID, TELEGRAM_API_HASH, {
    connectionRetries: 10,
    useWSS: true,
    retryDelay: 2000,
    baseLogger: silentLogger,
  });
  await gramClient.connect();
  console.log("gramjs connected");
}

async function sendVideoToAunt(filePath, renamedName, fileIndex, total) {
  const dir         = path.dirname(filePath);
  const renamedPath = path.join(dir, renamedName);

  if (filePath !== renamedPath && fs.existsSync(filePath)) {
    fs.renameSync(filePath, renamedPath);
  }

  const fileSize = fs.statSync(renamedPath).size;
  const startTime = Date.now();
  let lastPct = -1;

  await gramClient.sendFile(AUNT_USERNAME, {
    file: renamedPath,
    forceDocument: true,
    workers: 15,
    progressCallback: (progress) => {
      const pct = Math.floor(progress * 100);
      if (pct !== lastPct && pct % 20 === 0) {
        lastPct = pct;
        const elapsed = (Date.now() - startTime) / 1000 || 0.001;
        const speed   = (progress * fileSize) / elapsed;
        const speedStr =
          speed > 1024 * 1024
            ? `${(speed / 1024 / 1024).toFixed(1)} MB/s`
            : `${(speed / 1024).toFixed(1)} KB/s`;
        console.log(`upload [${fileIndex}/${total}] ${renamedName}: ${pct}% at ${speedStr}`);
      }
    },
  });

  console.log(`sent: ${renamedName}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!FILE_ID || !CHAT_ID || !JOB_ID) {
    console.error("missing required inputs: INPUT_FILE_ID, INPUT_CHAT_ID, INPUT_JOB_ID");
    process.exit(1);
  }

  fs.mkdirSync("tmp", { recursive: true });

  // ── 1. Download ──────────────────────────────────────────────────────────
  await callback("progress", "downloading from Google Drive...");

  const tmpPath = `tmp/download_${Date.now()}.tmp`;
  let result;
  try {
    result = await downloadFile(FILE_ID, tmpPath);
  } catch (err) {
    await callback("error", `download failed: ${err.message}`);
    process.exit(1);
  }

  await callback("progress", `downloaded (${result.type}) — preparing files...`);

  // ── 2. Resolve file list ─────────────────────────────────────────────────
  let files = [];

  if (result.type === "video") {
    const videoPath = `tmp/video_${Date.now()}${result.ext}`;
    fs.renameSync(tmpPath, videoPath);
    const stat = fs.statSync(videoPath);
    files = [{
      originalName: path.basename(videoPath),
      renamedName:  path.basename(videoPath),
      fullPath:     videoPath,
      size:         stat.size,
    }];
  } else {
    // ZIP
    const zipPath  = `tmp/archive_${Date.now()}.zip`;
    const extractDir = `tmp/extracted_${Date.now()}/`;
    fs.renameSync(tmpPath, zipPath);

    await callback("progress", "extracting ZIP...");
    try {
      fs.mkdirSync(extractDir, { recursive: true });
      files = await extractZip(zipPath, extractDir);
      fs.rmSync(zipPath, { force: true }); // free space immediately
    } catch (err) {
      await callback("error", `extraction failed: ${err.message}`);
      process.exit(1);
    }

    if (files.length === 0) {
      await callback("error", "no video files found in ZIP");
      process.exit(1);
    }
  }

  // ── 3. AI rename ─────────────────────────────────────────────────────────
  await callback("progress", `found ${files.length} file(s) — AI renaming...`);

  try {
    const originalNames = files.map((f) => f.originalName);
    const newNames      = await aiRenameFiles(originalNames);
    files = files.map((f, i) => ({
      ...f,
      renamedName: newNames[i] || f.originalName,
    }));
  } catch (err) {
    console.log("groq error, using original names:", err.message);
    // non-fatal — continue with original names
  }

  // ── 4. Connect gramjs & upload ───────────────────────────────────────────
  await callback("progress", `uploading ${files.length} file(s) to Telegram...`);

  try {
    await initGramClient();
  } catch (err) {
    await callback("error", `gramjs connect failed: ${err.message}`);
    process.exit(1);
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    await callback(
      "progress",
      `uploading ${i + 1}/${files.length}: ${file.renamedName}`,
    );
    try {
      await sendVideoToAunt(file.fullPath, file.renamedName, i + 1, files.length);
    } catch (err) {
      // non-fatal per file — report but continue
      await callback("progress", `⚠ failed to send ${file.renamedName}: ${err.message}`);
    }
    // Clean up each file after upload to keep runner disk tidy
    fs.rmSync(path.join(path.dirname(file.fullPath), file.renamedName), { force: true });
  }

  await gramClient.disconnect();

  await callback(
    "done",
    `all ${files.length} file(s) sent to Telegram successfully! 🎉`,
  );
}

main().catch(async (err) => {
  console.error("fatal:", err);
  await callback("error", `worker crashed: ${err.message}`);
  process.exit(1);
});
