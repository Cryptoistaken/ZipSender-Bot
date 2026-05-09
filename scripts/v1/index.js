import "dotenv/config";
import fs from "fs";
import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger } from "telegram/extensions/index.js";
import OpenAI from "openai";
import axios from "axios";
import unzipper from "unzipper";
import chalk from "chalk";
import input from "input";

const sessions = new Map();

const stringSession = new StringSession(process.env.TELEGRAM_SESSION || "");

const silentLogger = new Logger("none");

const gramClient = new TelegramClient(
  stringSession,
  Number(process.env.TELEGRAM_API_ID),
  process.env.TELEGRAM_API_HASH,
  {
    connectionRetries: 10,
    useWSS: true,
    retryDelay: 2000,
    baseLogger: silentLogger,
  },
);

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

async function setupSession() {
  const tempSession = new StringSession("");
  const tempClient = new TelegramClient(
    tempSession,
    Number(process.env.TELEGRAM_API_ID),
    process.env.TELEGRAM_API_HASH,
    { connectionRetries: 5 },
  );
  await tempClient.start({
    phoneNumber: async () =>
      await input.text("phone number with country code: "),
    password: async () => await input.text("2FA password or press enter: "),
    phoneCode: async () => await input.text("OTP from Telegram app: "),
    onError: (err) => console.log(chalk.bold(err.message)),
  });
  const saved = tempClient.session.save();
  await tempClient.disconnect();
  return saved;
}

function extractGDriveId(url) {
  const match = url.match(/(?:\/d\/|[?&]id=)([a-zA-Z0-9_-]{25,})/);
  return match ? match[1] : null;
}

const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v"];

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

// Returns { type: "zip" | "video", ext: string }
async function downloadFile(fileId, destPath) {
  const url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
  console.log(chalk.gray("downloading from"), chalk.white(url));
  const response = await axios.get(url, {
    responseType: "stream",
    maxRedirects: 10,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  // Detect type from Content-Type header first
  const contentType = response.headers["content-type"] || "";
  const videoExtFromHeader = contentTypeToExt(contentType);

  const total = parseInt(response.headers["content-length"] || "0", 10);
  let downloaded = 0;
  const startTime = Date.now();

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    const elapsed = (Date.now() - startTime) / 1000;
    const speed = downloaded / elapsed;
    const speedStr =
      speed > 1024 * 1024
        ? `${(speed / 1024 / 1024).toFixed(1)} MB/s`
        : `${(speed / 1024).toFixed(1)} KB/s`;
    const percent = total
      ? `${Math.floor((downloaded / total) * 100)}%`
      : `${(downloaded / 1024 / 1024).toFixed(1)} MB`;
    process.stdout.write(
      `\r${chalk.gray("downloading")} ${chalk.white(percent)}  ${chalk.gray("at")} ${chalk.white(speedStr)}   `,
    );
  });

  const writer = fs.createWriteStream(destPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => {
      process.stdout.write("\n");

      // Read magic bytes to determine file type
      const buf = Buffer.alloc(12);
      const fd = fs.openSync(destPath, "r");
      fs.readSync(fd, buf, 0, 12, 0);
      fs.closeSync(fd);

      const isZip = buf[0] === 0x50 && buf[1] === 0x4b;

      // Common video container signatures
      const isMp4 =
        (buf[4] === 0x66 &&
          buf[5] === 0x74 &&
          buf[6] === 0x79 &&
          buf[7] === 0x70) || // ftyp box
        (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x00);
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
      const isWebm =
        buf[0] === 0x1a &&
        buf[1] === 0x45 &&
        buf[2] === 0xdf &&
        buf[3] === 0xa3;

      if (isZip) {
        console.log(
          chalk.bold("download complete (ZIP)"),
          chalk.white(destPath),
        );
        resolve({ type: "zip", ext: ".zip" });
      } else if (videoExtFromHeader) {
        // Trust Content-Type header for video
        console.log(
          chalk.bold("download complete (video)"),
          chalk.white(destPath),
        );
        resolve({ type: "video", ext: videoExtFromHeader });
      } else if (isMkv || isWebm) {
        console.log(
          chalk.bold("download complete (video)"),
          chalk.white(destPath),
        );
        resolve({ type: "video", ext: ".mkv" });
      } else if (isAvi) {
        console.log(
          chalk.bold("download complete (video)"),
          chalk.white(destPath),
        );
        resolve({ type: "video", ext: ".avi" });
      } else if (isMp4) {
        console.log(
          chalk.bold("download complete (video)"),
          chalk.white(destPath),
        );
        resolve({ type: "video", ext: ".mp4" });
      } else {
        reject(
          new Error(
            "unrecognized file type — check the file is publicly shared on Drive",
          ),
        );
      }
    });
    writer.on("error", reject);
  });
}

async function extractZip(zipPath, destDir) {
  console.log(chalk.gray("extracting"), chalk.white(zipPath));
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
      const fullPath = destDir + f.toString();
      const stat = fs.statSync(fullPath);
      return {
        originalName: f.toString().split("/").pop(),
        renamedName: f.toString().split("/").pop(),
        fullPath,
        size: stat.size,
      };
    })
    .sort((a, b) => a.originalName.localeCompare(b.originalName));
  console.log(
    chalk.gray("found"),
    chalk.white(videoFiles.length),
    chalk.gray("video files"),
  );
  return videoFiles;
}

async function aiRenameFiles(fileNames) {
  console.log(chalk.bold("calling groq for rename"));
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
      {
        role: "user",
        content: numbered,
      },
    ],
    temperature: 0,
    max_completion_tokens: 1000,
  });
  try {
    const text = completion.choices[0].message.content.trim();
    const parsed = JSON.parse(text);
    console.log(chalk.bold("rename complete"));
    return parsed;
  } catch {
    console.log(chalk.gray("groq parse failed, using original names"));
    return fileNames;
  }
}

async function sendVideoToAunt(filePath, renamedName) {
  const dir = filePath.substring(0, filePath.lastIndexOf("/") + 1);
  const renamedPath = dir + renamedName;
  if (filePath !== renamedPath && fs.existsSync(filePath)) {
    fs.renameSync(filePath, renamedPath);
  }
  console.log(chalk.gray("sending"), chalk.white(renamedName));
  const fileSize = fs.statSync(renamedPath).size;
  const startTime = Date.now();
  const result = await gramClient.sendFile(process.env.AUNT_USERNAME, {
    file: renamedPath,
    forceDocument: true,
    workers: 15,
    progressCallback: (progress) => {
      const pct = Math.floor(progress * 100);
      const uploaded = progress * fileSize;
      const elapsed = (Date.now() - startTime) / 1000 || 0.001;
      const speed = uploaded / elapsed;
      const speedStr =
        speed > 1024 * 1024
          ? `${(speed / 1024 / 1024).toFixed(1)} MB/s`
          : `${(speed / 1024).toFixed(1)} KB/s`;
      process.stdout.write(
        `\r${chalk.gray("uploading")} ${chalk.white(pct + "%")}  ${chalk.gray("at")} ${chalk.white(speedStr)}   `,
      );
    },
  });
  process.stdout.write("\n");
  console.log(chalk.bold("sent"), chalk.white(renamedName));
  return result;
}

async function showFileList(ctx, chatId) {
  const session = sessions.get(chatId);
  const lines = session.files.map((f, i) => {
    const mb = (f.size / 1024 / 1024).toFixed(1);
    return `${i + 1}. ${f.renamedName}   (${mb} MB)`;
  });
  const text = `files found: ${session.files.length}\n\n${lines.join("\n")}\n\naunt: ${process.env.AUNT_USERNAME}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("AI Rename All", "rename_all")],
    [Markup.button.callback("Send All to Aunt", "send_all")],
    [Markup.button.callback("Cancel", "cancel_session")],
  ]);
  await ctx.reply(text, keyboard);
}

const isSetup = process.argv.includes("--setup");

if (isSetup) {
  console.log(chalk.bold("starting setup mode"));
  const session = await setupSession();
  const envPath = ".env";
  const current = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : "";
  const updated = current.includes("TELEGRAM_SESSION=")
    ? current.replace(/TELEGRAM_SESSION=.*/, `TELEGRAM_SESSION=${session}`)
    : current + `\nTELEGRAM_SESSION=${session}`;
  fs.writeFileSync(envPath, updated);
  console.log(chalk.bold("✓ session saved to .env"));
  process.exit(0);
}

fs.mkdirSync("tmp", { recursive: true });

console.log(chalk.bold("connecting gramjs"));
await gramClient.connect();
console.log(chalk.white("gramjs connected"));

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (ctx.from?.id !== Number(process.env.OWNER_CHAT_ID)) {
    await ctx.reply("✗ unauthorized");
    return;
  }
  return next();
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "ZipSender ready\nSend a Google Drive ZIP or video link to begin",
  );
});

bot.command("cancel", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const session = sessions.get(chatId);
  if (session) {
    if (session.zipPath) fs.rmSync(session.zipPath, { force: true });
    if (session.extractDir)
      fs.rmSync(session.extractDir, { recursive: true, force: true });
    sessions.delete(chatId);
  }
  await ctx.reply("✓ cancelled");
});

const CACHE_FILE = "tmp/cache.json";

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

bot.on(message("text"), async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text;

  const fileId = extractGDriveId(text);
  if (!fileId) {
    await ctx.reply("✗ not a valid Google Drive link");
    return;
  }

  sessions.set(chatId, {
    step: "downloading",
    files: [],
    zipPath: null,
    extractDir: null,
  });

  const cache = loadCache();
  const cached = cache[fileId];

  // --- single video cache ---
  const videoExists =
    cached && cached.videoPath && fs.existsSync(cached.videoPath);

  // --- zip/extract cache ---
  const zipExists = cached && cached.zipPath && fs.existsSync(cached.zipPath);
  const extractExists =
    cached && cached.extractDir && fs.existsSync(cached.extractDir);

  let statusText = "downloading...";
  if (videoExists) statusText = "using cached video...";
  else if (zipExists && extractExists) statusText = "using cached files...";
  else if (zipExists) statusText = "using cached zip...";

  const statusMsg = await ctx.reply(statusText);

  // run in background so Telegraf handler returns before the 90s timeout
  (async () => {
    // ── STEP 1: download (if not cached) ─────────────────────────────────
    let detectedType = cached?.fileType || null; // "zip" | "video"
    let detectedExt = cached?.fileExt || null;

    if (!videoExists && !zipExists) {
      const tmpPath = `tmp/${chatId}_${Date.now()}.tmp`;
      let result;
      try {
        result = await downloadFile(fileId, tmpPath);
        detectedType = result.type;
        detectedExt = result.ext;
      } catch (err) {
        console.log(chalk.bold("download error"), chalk.white(err.message));
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          "✗ download failed",
        );
        fs.rmSync(tmpPath, { force: true });
        sessions.delete(chatId);
        return;
      }

      // Rename .tmp → proper extension now that we know the type
      if (detectedType === "video") {
        const videoPath = `tmp/${chatId}_${Date.now()}${detectedExt}`;
        fs.renameSync(tmpPath, videoPath);
        const c = loadCache();
        c[fileId] = {
          ...(c[fileId] || {}),
          videoPath,
          fileType: "video",
          fileExt: detectedExt,
          downloadedAt: new Date().toISOString(),
        };
        saveCache(c);
        cache[fileId] = c[fileId]; // update local ref
      } else {
        // ZIP
        const zipPath = `tmp/${chatId}_${Date.now()}.zip`;
        fs.renameSync(tmpPath, zipPath);
        const c = loadCache();
        c[fileId] = {
          ...(c[fileId] || {}),
          zipPath,
          fileType: "zip",
          fileExt: ".zip",
          downloadedAt: new Date().toISOString(),
        };
        saveCache(c);
        cache[fileId] = c[fileId];
      }
    }

    // Refresh cached pointers after potential write above
    const freshCache = loadCache();
    const fc = freshCache[fileId] || {};
    detectedType = fc.fileType || detectedType;

    // ── STEP 2: branch on type ────────────────────────────────────────────
    if (detectedType === "video") {
      // ── Single video path ──────────────────────────────────────────────
      const videoPath = fc.videoPath;
      if (!videoPath || !fs.existsSync(videoPath)) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          "✗ video file missing",
        );
        sessions.delete(chatId);
        return;
      }

      const stat = fs.statSync(videoPath);
      const originalName = videoPath.split("/").pop();
      const files = [
        {
          originalName,
          renamedName: originalName,
          fullPath: videoPath,
          size: stat.size,
        },
      ];

      sessions.set(chatId, {
        step: "listing",
        files,
        zipPath: null,
        extractDir: null,
      });
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await showFileList(ctx, chatId);
    } else {
      // ── ZIP path ───────────────────────────────────────────────────────
      const zipPath = fc.zipPath;
      const extractDir = fc.extractDir || `tmp/${chatId}/`;
      const extractExists2 = fc.extractDir && fs.existsSync(fc.extractDir);

      let files;
      if (extractExists2) {
        console.log(
          chalk.gray("using cached extract"),
          chalk.white(extractDir),
        );
        const allFiles = fs.readdirSync(extractDir, { recursive: true });
        files = allFiles
          .filter((f) =>
            VIDEO_EXTENSIONS.some((ext) =>
              f.toString().toLowerCase().endsWith(ext),
            ),
          )
          .map((f) => {
            const fullPath = extractDir + f.toString();
            const stat = fs.statSync(fullPath);
            return {
              originalName: f.toString().split("/").pop(),
              renamedName: f.toString().split("/").pop(),
              fullPath,
              size: stat.size,
            };
          })
          .sort((a, b) => a.originalName.localeCompare(b.originalName));
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          "extracting...",
        );
        try {
          fs.mkdirSync(extractDir, { recursive: true });
          files = await extractZip(zipPath, extractDir);
          const c = loadCache();
          c[fileId] = {
            ...(c[fileId] || {}),
            extractDir,
            extractedAt: new Date().toISOString(),
          };
          saveCache(c);
        } catch (err) {
          console.log(chalk.bold("extract error"), chalk.white(err.message));
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            null,
            "✗ extraction failed",
          );
          sessions.delete(chatId);
          return;
        }
      }

      if (files.length === 0) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          "✗ no video files found in ZIP",
        );
        sessions.delete(chatId);
        return;
      }

      sessions.set(chatId, { step: "listing", files, zipPath, extractDir });
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await showFileList(ctx, chatId);
    }
  })();
});

bot.action("rename_all", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const session = sessions.get(chatId);
  if (!session) {
    await ctx.editMessageText("✗ no active session");
    return;
  }

  await ctx.editMessageText("renaming with AI...");

  const originalNames = session.files.map((f) => f.originalName);
  let newNames;
  try {
    newNames = await aiRenameFiles(originalNames);
  } catch (err) {
    console.log(chalk.bold("groq error"), chalk.white(err.message));
    await ctx.reply("✗ AI rename failed, keeping original names");
    newNames = originalNames;
  }

  session.files = session.files.map((f, i) => {
    const newName = newNames[i] || f.originalName;
    const dir = f.fullPath.substring(0, f.fullPath.lastIndexOf("/") + 1);
    const newPath = dir + newName;
    if (f.fullPath !== newPath && fs.existsSync(f.fullPath)) {
      fs.renameSync(f.fullPath, newPath);
    }
    return { ...f, renamedName: newName, fullPath: newPath };
  });
  sessions.set(chatId, session);

  await ctx.deleteMessage();
  await showFileList(ctx, chatId);
});

bot.action("send_all", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const session = sessions.get(chatId);
  if (!session) {
    await ctx.editMessageText("✗ no active session");
    return;
  }

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

  const total = session.files.length;
  const progressMsg = await ctx.reply(
    `sending ${total} files to ${process.env.AUNT_USERNAME}...`,
  );

  (async () => {
    for (let i = 0; i < session.files.length; i++) {
      const file = session.files[i];
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        progressMsg.message_id,
        null,
        `sending ${i + 1} of ${total}: ${file.renamedName}`,
      );
      try {
        await sendVideoToAunt(file.fullPath, file.renamedName);
        const dir = file.fullPath.substring(
          0,
          file.fullPath.lastIndexOf("/") + 1,
        );
        session.files[i].fullPath = dir + file.renamedName;
      } catch (err) {
        console.log(chalk.bold("send error"), chalk.white(err.message));
        await ctx.reply(`✗ failed to send: ${file.renamedName}`);
      }
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      progressMsg.message_id,
      null,
      `✓ all ${total} files sent to ${process.env.AUNT_USERNAME}`,
    );

    if (session.zipPath) fs.rmSync(session.zipPath, { force: true });
    if (session.extractDir)
      fs.rmSync(session.extractDir, { recursive: true, force: true });
    // For single video files, clean up the video itself
    if (!session.extractDir && session.files.length > 0) {
      for (const f of session.files) {
        fs.rmSync(f.fullPath, { force: true });
      }
    }
    sessions.delete(chatId);
  })();
});

bot.action("cancel_session", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const session = sessions.get(chatId);
  if (session) {
    if (session.zipPath) fs.rmSync(session.zipPath, { force: true });
    if (session.extractDir)
      fs.rmSync(session.extractDir, { recursive: true, force: true });
    sessions.delete(chatId);
  }
  await ctx.editMessageText("✓ cancelled");
});

bot.catch((err, ctx) => {
  console.log(chalk.bold("bot error"), chalk.white(err.message));
  ctx.reply("✗ something went wrong");
});

console.log(chalk.bold("starting bot"));
bot.launch();

process.once("SIGINT", () => {
  bot.stop("SIGINT");
  gramClient.disconnect();
});
process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
  gramClient.disconnect();
});
