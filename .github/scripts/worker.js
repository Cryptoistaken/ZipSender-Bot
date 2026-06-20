import fs from "fs";
import path from "path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger } from "telegram/extensions/index.js";
import OpenAI from "openai";
import axios from "axios";
import unzipper from "unzipper";

const DEBUG = process.env.DEBUG === "true";
const LOG_FILE = ".logs/worker.jsonl";

function ensureLogDir() {
  try {
    fs.mkdirSync(".logs", { recursive: true });
  } catch {}
}

function debugLog(level, source, message, data = null, err = null) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    source,
    msg: message,
    pid: process.pid,
  };
  if (data) entry.data = data;
  if (err) {
    entry.error = {
      message: err.message,
      stack: err.stack,
      name: err.name,
    };
  }
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error("[LOG_ERR]", e.message);
  }
  if (DEBUG || level === "ERROR" || level === "WARN") {
    const prefix =
      level === "ERROR" ? "[ERR]" : level === "WARN" ? "[WARN]" : "[DBG]";
    console.log(prefix, source, message, data ? JSON.stringify(data) : "");
  }
}

function logInfo(source, msg, data) {
  debugLog("INFO", source, msg, data);
}
function logError(source, msg, err, data) {
  debugLog("ERROR", source, msg, data, err);
}
function logDebug(source, msg, data) {
  debugLog("DEBUG", source, msg, data);
}
function logWarn(source, msg, data) {
  debugLog("WARN", source, msg, data);
}

function redactToken(tok) {
  if (!tok) return null;
  return tok.slice(0, 6) + "****";
}

const FILE_IDS = (process.env.INPUT_FILE_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CHAT_ID = process.env.INPUT_CHAT_ID;
const JOB_ID = process.env.INPUT_JOB_ID;
const MSG_ID = process.env.INPUT_MSG_ID
  ? Number(process.env.INPUT_MSG_ID)
  : null;
const CALLBACK_URL = process.env.INPUT_CALLBACK_URL || "";
const CALLBACK_SECRET = process.env.INPUT_CALLBACK_SECRET || "";
const AUNT_USERNAME = process.env.INPUT_AUNT_USERNAME;

debugLog("INFO", "worker:startup", "worker starting", {
  node: process.version,
  platform: process.platform,
  env: {
    FILE_IDS,
    CHAT_ID,
    JOB_ID,
    MSG_ID,
    CALLBACK_URL_SET: !!CALLBACK_URL,
    AUNT_USERNAME,
    TELEGRAM_API_ID_SET: !!process.env.TELEGRAM_API_ID,
    TELEGRAM_API_HASH_SET: !!process.env.TELEGRAM_API_HASH,
    TELEGRAM_SESSION_SET: !!process.env.TELEGRAM_SESSION,
    BOT_TOKEN_SET: !!process.env.BOT_TOKEN,
    BOT_TOKEN_PREVIEW: redactToken(process.env.BOT_TOKEN),
    GROQ_API_KEY_SET: !!process.env.GROQ_API_KEY,
    GROQ_API_KEY_PREVIEW: redactToken(process.env.GROQ_API_KEY),
  },
});

const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const TELEGRAM_SESSION = process.env.TELEGRAM_SESSION;
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v"];

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec > 1024 * 1024)
    return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
}

function formatBytesShort(bytes) {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024 || bytes === 0) return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}

function formatSpeedShort(bytesPerSec) {
  if (!bytesPerSec) return "0KB";
  if (bytesPerSec > 1024 * 1024)
    return `${(bytesPerSec / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytesPerSec / 1024).toFixed(1)}KB`;
}

function buildBar(pct, width = 12) {
  const filled = Math.round((pct / 100) * width);
  return "▐" + "█".repeat(filled) + "░".repeat(width - filled) + "▌";
}

let statusMsgId = MSG_ID || null;

async function editOrSend(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  const base = `https://api.telegram.org/bot${BOT_TOKEN}`;

  if (statusMsgId) {
    try {
      await fetch(`${base}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          message_id: statusMsgId,
          text,
        }),
      });
      return;
    } catch {}
  }

  try {
    const res = await fetch(`${base}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
    });
    const data = await res.json();
    if (data.ok) statusMsgId = data.result.message_id;
  } catch (e) {
    console.log("telegram send failed:", e.message);
  }
}

async function callback(event, message) {
  console.log(`[${event}] ${message}`);
  await editOrSend(message);

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
    "video/mp4": ".mp4",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-m4v": ".m4v",
  };
  return map[ct] || null;
}

async function downloadFile(fileId, destPath, onProgress) {
  logDebug("downloadFile:entry", "starting download", { fileId, destPath });
  const url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;

  const response = await axios.get(url, {
    responseType: "stream",
    maxRedirects: 10,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const contentType = response.headers["content-type"] || "";
  const videoExtFromHeader = contentTypeToExt(contentType);

  const disposition = response.headers["content-disposition"] || "";
  let originalFilename = null;
  const fnMatch = disposition.match(
    /filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i,
  );
  if (fnMatch) originalFilename = decodeURIComponent(fnMatch[1].trim());

  const total = parseInt(response.headers["content-length"] || "0", 10);
  let downloaded = 0;
  let lastReported = 0;
  const startTime = Date.now();

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    const pct = total ? Math.floor((downloaded / total) * 100) : 0;
    if (pct - lastReported >= 10) {
      lastReported = pct;
      const elapsed = (Date.now() - startTime) / 1000 || 0.001;
      const speed = downloaded / elapsed;
      if (onProgress) onProgress(pct, downloaded, total, speed);
    }
  });

  logDebug("downloadFile:start", "stream pipe started", { fileId, destPath });

  const writer = fs.createWriteStream(destPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => {
      const buf = Buffer.alloc(12);
      const fd = fs.openSync(destPath, "r");
      fs.readSync(fd, buf, 0, 12, 0);
      fs.closeSync(fd);

      const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
      const isMkv =
        buf[0] === 0x1a &&
        buf[1] === 0x45 &&
        buf[2] === 0xdf &&
        buf[3] === 0xa3;
      const isAvi =
        buf[0] === 0x52 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x46;
      const isMp4 =
        buf[4] === 0x66 &&
        buf[5] === 0x74 &&
        buf[6] === 0x79 &&
        buf[7] === 0x70;

      if (isZip) {
        resolve({ type: "zip", ext: ".zip", originalFilename });
      } else if (videoExtFromHeader) {
        resolve({ type: "video", ext: videoExtFromHeader, originalFilename });
      } else if (isMkv) {
        resolve({ type: "video", ext: ".mkv", originalFilename });
      } else if (isAvi) {
        resolve({ type: "video", ext: ".avi", originalFilename });
      } else if (isMp4) {
        resolve({ type: "video", ext: ".mp4", originalFilename });
      } else {
        reject(
          new Error(
            "unrecognized file type check the file is publicly shared on Drive",
          ),
        );
      }
    });
    writer.on("error", reject);
  });
}

async function extractZip(zipPath, destDir) {
  logDebug("extractZip:entry", "extracting archive", { zipPath, destDir });
  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: destDir }))
    .promise();

  const allFiles = fs.readdirSync(destDir, { recursive: true });
  const videoFiles = allFiles
    .filter((f) =>
      VIDEO_EXTENSIONS.some((ext) => f.toString().toLowerCase().endsWith(ext)),
    )
    .map((f) => {
      const fullPath = path.join(destDir, f.toString());
      const stat = fs.statSync(fullPath);
      return {
        originalName: path.basename(f.toString()),
        renamedName: path.basename(f.toString()),
        fullPath,
        size: stat.size,
      };
    })
    .sort((a, b) => a.originalName.localeCompare(b.originalName));

  logInfo("extractZip:done", `found ${videoFiles.length} video file(s)`, {
    zipPath,
    videoFiles: videoFiles.map((v) => v.originalName),
  });
  return videoFiles;
}

async function aiRenameFiles(fileNames) {
  logDebug("aiRenameFiles:entry", "renaming", {
    count: fileNames.length,
    names: fileNames,
  });
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
- Keeping the original file extension with the dot (e.g. .mkv, .mp4)
- The extension MUST always start with a dot — never output "mkv" without the dot
- Output clean readable names like: True Beauty S01E03 720p.mkv or Inception 1080p.mp4

Return only a JSON array of the cleaned names in the same order. No markdown, no backticks, no explanation.`,
      },
      { role: "user", content: numbered },
    ],
    temperature: 0,
    max_completion_tokens: 1000,
  });

  try {
    const text = completion.choices[0].message.content.trim();
    logDebug("aiRenameFiles:raw", "LLM raw response", {
      raw: text.slice(0, 500),
    });
    const parsed = JSON.parse(text);
    logInfo("aiRenameFiles:done", "rename succeeded", {
      input: fileNames,
      output: parsed,
    });
    return parsed;
  } catch (err) {
    logError("aiRenameFiles:fail", "rename parse/API failed", err, {
      input: fileNames,
      raw_preview: completion?.choices?.[0]?.message?.content?.slice(0, 200),
    });
    return fileNames;
  }
}

async function sendVideoToAunt(
  filePath,
  renamedName,
  fileIndex,
  total,
  onProgress,
  sharedClient,
) {
  logDebug("sendVideoToAunt:entry", `sending file ${fileIndex}/${total}`, {
    renamedName,
    filePath,
    size: fs.existsSync(filePath) ? fs.statSync(filePath).size : null,
  });
  const dir = path.dirname(filePath);
  const renamedPath = path.join(dir, renamedName);

  if (filePath !== renamedPath && fs.existsSync(filePath)) {
    fs.renameSync(filePath, renamedPath);
  }

  const fileSize = fs.statSync(renamedPath).size;
  const startTime = Date.now();
  let lastPct = -1;

  const silentLogger = new Logger("none");
  const session = new StringSession(TELEGRAM_SESSION);
  const client = sharedClient || new TelegramClient(session, TELEGRAM_API_ID, TELEGRAM_API_HASH, {
    retryDelay: 1000,
    baseLogger: silentLogger,
  });

  const origWarn = console.warn;
  const origError = console.error;
  const filterGramJS = (...args) => {
    const txt = args.join(" ");
    if (txt.includes("sender already has some hanging states") || txt.includes("reconnecting")) return;
    if (args[0] && typeof args[0] === "string" && args[0].includes("WARN")) origWarn.apply(console, args);
    else origError.apply(console, args);
  };
  console.warn = filterGramJS;
  console.error = filterGramJS;

  try {
    if (!sharedClient) await client.connect();

    await client.sendFile(AUNT_USERNAME, {
      file: renamedPath,
      forceDocument: true,
      workers: 8,
      progressCallback: async (progress) => {
        const pct = Math.floor(progress * 100);
        if (pct !== lastPct && (pct % 10 === 0 || pct === 100)) {
          lastPct = pct;
          const elapsed = (Date.now() - startTime) / 1000 || 0.001;
          const speed = (progress * fileSize) / elapsed;
          const uploaded = progress * fileSize;
          if (onProgress) onProgress(pct, uploaded, fileSize, speed);
        }
      },
    });
    logInfo("sendVideoToAunt:done", `file sent`, {
      renamedName,
      fileIndex,
      total,
      size: fileSize,
    });
  } finally {
    console.warn = origWarn;
    console.error = origError;
    if (!sharedClient) {
      await client.disconnect();
      await client.destroy();
    }
  }
}

async function main() {
  logInfo("main:entry", "main() starting", {
    file_ids_count: FILE_IDS.length,
    chat_id: CHAT_ID,
    job_id: JOB_ID,
    callback_url_set: !!CALLBACK_URL,
  });
  if (FILE_IDS.length === 0 || !CHAT_ID || !JOB_ID) {
    console.error(
      "missing required inputs: INPUT_FILE_ID, INPUT_CHAT_ID, INPUT_JOB_ID",
    );
    process.exit(1);
  }

  fs.mkdirSync("tmp", { recursive: true });

  await callback("progress", "Downloading");

  const downloadStates = FILE_IDS.map(() => ({ pct: 0, downloaded: 0, total: 0, speed: 0 }));
  let lastDownloadReport = 0;
  let isDownloadingReport = false;

  async function reportDownloads(force = false) {
    const now = Date.now();
    if (!force && now - lastDownloadReport < 2000) return;
    if (isDownloadingReport) return;
    lastDownloadReport = now;
    isDownloadingReport = true;

    try {
      const lines = [];
      downloadStates.forEach((s) => {
        const bar = buildBar(s.pct);
        const spec = s.total > 0
          ? `${s.pct}%  ${formatBytesShort(s.downloaded)} of ${formatBytesShort(s.total)}  ${formatSpeedShort(s.speed)}`
          : `${formatBytesShort(s.downloaded)}  ${formatSpeedShort(s.speed)}`;
        lines.push(`${bar}  ${spec}`);
      });
      await callback("progress", lines.join("\n"));
    } finally {
      isDownloadingReport = false;
    }
  }

  const downloadTasks = FILE_IDS.map((fileId, index) => {
    const tmpPath = `tmp/download_${index}_${Date.now()}.tmp`;
    return downloadFile(fileId, tmpPath, (pct, downloaded, total, speed) => {
      downloadStates[index] = { pct, downloaded, total, speed };
      reportDownloads();
    }).then((result) => ({
      result,
      tmpPath,
      fileId,
      index,
    }));
  });

  let downloads;
  try {
    downloads = await Promise.all(downloadTasks);
    await reportDownloads(true);
    logInfo("main:downloads", `all ${downloads.length} downloads finished`);
  } catch (err) {
    logError("main:downloads", "download batch failed", err);
    await callback("error", `Download failed: ${err.message}`);
    process.exit(1);
  }

  let allFiles = [];

  for (const { result, tmpPath, index } of downloads) {
    if (result.type === "video") {
      const videoPath = `tmp/video_${index}_${Date.now()}${result.ext}`;
      fs.renameSync(tmpPath, videoPath);
      const stat = fs.statSync(videoPath);
      const guessedName = result.originalFilename || `video${result.ext}`;
      const nameWithExt = path.extname(guessedName)
        ? guessedName
        : guessedName + result.ext;
      allFiles.push({
        originalName: nameWithExt,
        renamedName: nameWithExt,
        fullPath: videoPath,
        size: stat.size,
      });
    } else {
      const zipPath = `tmp/archive_${index}_${Date.now()}.zip`;
      const extractDir = `tmp/extracted_${index}_${Date.now()}/`;
      fs.renameSync(tmpPath, zipPath);

      await callback("progress", "Extracting ZIP archives");
      try {
        fs.mkdirSync(extractDir, { recursive: true });
        const files = await extractZip(zipPath, extractDir);
        logDebug(
          "main:extract",
          `zip ${index} yielded ${files.length} video(s)`,
        );
        allFiles.push(...files);
      } catch (err) {
        logError("main:extract", `extraction failed for index ${index}`, err);
        await callback("error", `Extraction failed: ${err.message}`);
        process.exit(1);
      }
      fs.rmSync(zipPath, { force: true });
    }
  }

  if (allFiles.length === 0) {
    await callback("error", "No video files found in any archive");
    process.exit(1);
  }

  await callback("progress", `Renaming ${allFiles.length}`);

  try {
    const originalNames = allFiles.map((f) => f.originalName);
    const newNames = await aiRenameFiles(originalNames);
    allFiles = allFiles.map((f, i) => ({
      ...f,
      renamedName: newNames[i] || f.originalName,
    }));
  } catch (err) {
    console.log("groq error, using original names:", err.message);
  }

  const uploadStates = allFiles.map((f) => ({ pct: 0, uploaded: 0, total: f.size, speed: 0 }));
  let lastUploadReport = 0;
  let isUploadingReport = false;

  async function reportUploads(force = false) {
    const now = Date.now();
    if (!force && now - lastUploadReport < 2000) return;
    if (isUploadingReport) return;
    lastUploadReport = now;
    isUploadingReport = true;

    try {
      const lines = [];
      uploadStates.forEach((s) => {
        const bar = buildBar(s.pct);
        const spec = s.total > 0
          ? `${s.pct}%  ${formatBytesShort(s.uploaded)} of ${formatBytesShort(s.total)}  ${formatSpeedShort(s.speed)}`
          : `${formatBytesShort(s.uploaded)}  ${formatSpeedShort(s.speed)}`;
        lines.push(`${bar}  ${spec}`);
      });
      await callback("progress", lines.join("\n"));
    } finally {
      isUploadingReport = false;
    }
  }

  const silentLogger = new Logger("none");
  const session = new StringSession(TELEGRAM_SESSION);
  const uploadClient = new TelegramClient(session, TELEGRAM_API_ID, TELEGRAM_API_HASH, {
    retryDelay: 1000,
    baseLogger: silentLogger,
  });

  const origWarn2 = console.warn;
  const origError2 = console.error;
  const filterGramJS2 = (...args) => {
    const txt = args.join(" ");
    if (txt.includes("sender already has some hanging states") || txt.includes("reconnecting")) return;
    if (args[0] && typeof args[0] === "string" && args[0].includes("WARN")) origWarn2.apply(console, args);
    else origError2.apply(console, args);
  };
  console.warn = filterGramJS2;
  console.error = filterGramJS2;

  try {
    await uploadClient.connect();

    for (let i = 0; i < allFiles.length; i++) {
    const file = allFiles[i];
    try {
      await sendVideoToAunt(
        file.fullPath,
        file.renamedName,
        i + 1,
        allFiles.length,
        (pct, uploaded, total, speed) => {
          uploadStates[i] = { pct, uploaded, total, speed };
          reportUploads();
        },
        uploadClient,
      );
      fs.rmSync(path.join(path.dirname(file.fullPath), file.renamedName), { force: true });
    } catch (err) {
      logError("main:upload", `upload failed for ${file.renamedName}`, err, {
        fullPath: file.fullPath,
        index: i + 1,
      });
      await callback("progress", `Failed ${file.renamedName}: ${err.message}`);
    }
  }

  } finally {
    await uploadClient.disconnect();
    await uploadClient.destroy();
    console.warn = origWarn2;
    console.error = origError2;
  }
  await reportUploads(true);

  const totalSize = allFiles.reduce((s, f) => s + f.size, 0);
  const fileList = allFiles.map((f) => `  ${f.renamedName}`).join("\n");
  await callback("done", `Done ${allFiles.length}  ${formatBytesShort(totalSize)}\n${fileList}`);
}

main().catch(async (err) => {
  logError("main:fatal", "unhandled crash at top level", err, {
    file_ids: FILE_IDS,
    job_id: JOB_ID,
  });
  console.error("fatal:", err);
  await callback("error", `worker crashed: ${err.message}`);
  process.exit(1);
});
