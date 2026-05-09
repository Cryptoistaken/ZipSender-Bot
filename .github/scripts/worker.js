import fs from "fs";
import path from "path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger } from "telegram/extensions/index.js";
import OpenAI from "openai";
import axios from "axios";
import unzipper from "unzipper";

const FILE_ID         = process.env.INPUT_FILE_ID;
const CHAT_ID         = process.env.INPUT_CHAT_ID;
const JOB_ID          = process.env.INPUT_JOB_ID;
const CALLBACK_URL    = process.env.INPUT_CALLBACK_URL || "";
const CALLBACK_SECRET = process.env.INPUT_CALLBACK_SECRET || "";
const AUNT_USERNAME   = process.env.INPUT_AUNT_USERNAME;

const TELEGRAM_API_ID   = Number(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const TELEGRAM_SESSION  = process.env.TELEGRAM_SESSION;
const BOT_TOKEN         = process.env.BOT_TOKEN;
const GROQ_API_KEY      = process.env.GROQ_API_KEY;

const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v"];

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec > 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
}

function buildBar(pct, width = 12) {
  const filled = Math.round((pct / 100) * width);
  return "▐" + "█".repeat(filled) + "░".repeat(width - filled) + "▌";
}

async function callback(event, message) {
  console.log(`[${event}] ${message}`);

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

  response.data.on("data", async (chunk) => {
    downloaded += chunk.length;
    const pct = total ? Math.floor((downloaded / total) * 100) : 0;
    if (pct - lastReported >= 10) {
      lastReported = pct;
      const elapsed = (Date.now() - startTime) / 1000 || 0.001;
      const speed = downloaded / elapsed;
      const bar = buildBar(pct);
      const msg = total
        ? `Downloading\n${bar} ${pct}%\n${formatBytes(downloaded)} / ${formatBytes(total)}  |  ${formatSpeed(speed)}`
        : `Downloading\n${formatBytes(downloaded)} downloaded  |  ${formatSpeed(speed)}`;
      console.log(msg.replace(/\n/g, "  "));
      await callback("progress", msg);
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

async function extractZip(zipPath, destDir) {
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

  return videoFiles;
}

async function aiRenameFiles(fileNames) {
  const groq = new OpenAI({
    apiKey: GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });

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
    return parsed;
  } catch {
    return fileNames;
  }
}

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
    progressCallback: async (progress) => {
      const pct = Math.floor(progress * 100);
      if (pct !== lastPct && pct % 20 === 0) {
        lastPct = pct;
        const elapsed = (Date.now() - startTime) / 1000 || 0.001;
        const speed   = (progress * fileSize) / elapsed;
        const uploaded = progress * fileSize;
        const bar = buildBar(pct);
        const msg = `Uploading ${fileIndex}/${total}\n${renamedName}\n${bar} ${pct}%\n${formatBytes(uploaded)} / ${formatBytes(fileSize)}  |  ${formatSpeed(speed)}`;
        console.log(msg.replace(/\n/g, "  "));
        await callback("progress", msg);
      }
    },
  });
}

async function main() {
  if (!FILE_ID || !CHAT_ID || !JOB_ID) {
    console.error("missing required inputs: INPUT_FILE_ID, INPUT_CHAT_ID, INPUT_JOB_ID");
    process.exit(1);
  }

  fs.mkdirSync("tmp", { recursive: true });

  await callback("progress", "Connecting to Google Drive...");

  const tmpPath = `tmp/download_${Date.now()}.tmp`;
  let result;
  try {
    result = await downloadFile(FILE_ID, tmpPath);
  } catch (err) {
    await callback("error", `Download failed: ${err.message}`);
    process.exit(1);
  }

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
    const zipPath    = `tmp/archive_${Date.now()}.zip`;
    const extractDir = `tmp/extracted_${Date.now()}/`;
    fs.renameSync(tmpPath, zipPath);

    await callback("progress", "Extracting ZIP archive...");
    try {
      fs.mkdirSync(extractDir, { recursive: true });
      files = await extractZip(zipPath, extractDir);
      fs.rmSync(zipPath, { force: true });
    } catch (err) {
      await callback("error", `Extraction failed: ${err.message}`);
      process.exit(1);
    }

    if (files.length === 0) {
      await callback("error", "No video files found in ZIP");
      process.exit(1);
    }
  }

  await callback("progress", `Found ${files.length} file(s) — running AI rename...`);

  try {
    const originalNames = files.map((f) => f.originalName);
    const newNames      = await aiRenameFiles(originalNames);
    files = files.map((f, i) => ({
      ...f,
      renamedName: newNames[i] || f.originalName,
    }));
  } catch (err) {
    console.log("groq error, using original names:", err.message);
  }

  await callback("progress", `Starting upload of ${files.length} file(s) to Telegram...`);

  try {
    await initGramClient();
  } catch (err) {
    await callback("error", `Telegram connect failed: ${err.message}`);
    process.exit(1);
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      await sendVideoToAunt(file.fullPath, file.renamedName, i + 1, files.length);
    } catch (err) {
      await callback("progress", `Failed to send ${file.renamedName}: ${err.message}`);
    }
    fs.rmSync(path.join(path.dirname(file.fullPath), file.renamedName), { force: true });
  }

  await gramClient.disconnect();

  const totalSize = files.reduce((s, f) => s + f.size, 0);
  await callback(
    "done",
    `Done — ${files.length} file(s) sent\nTotal: ${formatBytes(totalSize)}\n${files.map((f) => `  ${f.renamedName}`).join("\n")}`,
  );
}

main().catch(async (err) => {
  console.error("fatal:", err);
  await callback("error", `worker crashed: ${err.message}`);
  process.exit(1);
});
