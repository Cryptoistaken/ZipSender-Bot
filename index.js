import "dotenv/config";
import fs from "fs";
import http from "http";
import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import chalk from "chalk";

// ─── GitHub Actions trigger config ───────────────────────────────────────────
const GH_TOKEN  = process.env.GITHUB_TOKEN;       // fine-grained PAT
const GH_OWNER  = process.env.GITHUB_OWNER;       // your github username
const GH_REPO   = process.env.GITHUB_REPO;        // repo name
const GH_BRANCH = process.env.GITHUB_BRANCH || "main";
const WORKFLOW  = "worker.yml";

// ─── In-memory job tracking ───────────────────────────────────────────────────
// jobId → { chatId, msgId, fileId, status, startedAt }
const jobs = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────
function extractGDriveId(url) {
  const match = url.match(/(?:\/d\/|[?&]id=)([a-zA-Z0-9_-]{25,})/);
  return match ? match[1] : null;
}

function githubHeaders() {
  return {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "zipsender-bot",
  };
}

// Trigger a new workflow run and return the run_id (via polling runs list)
async function triggerWorkflow(inputs) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${WORKFLOW}/dispatches`;
  const before = Date.now();

  const res = await fetch(url, {
    method: "POST",
    headers: githubHeaders(),
    body: JSON.stringify({ ref: GH_BRANCH, inputs }),
  });

  if (res.status !== 204) {
    const body = await res.text();
    throw new Error(`GitHub dispatch failed: ${res.status} ${body}`);
  }

  // Poll until we find a run that started after `before`
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(3000);
    const runsUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${WORKFLOW}/runs?per_page=5`;
    const r = await fetch(runsUrl, { headers: githubHeaders() });
    const data = await r.json();
    const run = (data.workflow_runs || []).find(
      (w) => new Date(w.created_at).getTime() > before - 5000,
    );
    if (run) return run.id;
  }
  throw new Error("Could not find the new workflow run after dispatch");
}

// Get current status/conclusion of a run
async function getRunStatus(runId) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/runs/${runId}`;
  const r = await fetch(url, { headers: githubHeaders() });
  const data = await r.json();
  return { status: data.status, conclusion: data.conclusion }; // status: queued|in_progress|completed
}

// Get logs download URL for a run (to parse worker output if needed)
async function getRunLogsUrl(runId) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/runs/${runId}/logs`;
  const r = await fetch(url, { headers: githubHeaders(), redirect: "manual" });
  return r.headers.get("location");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Callback server (GitHub Actions → your server) ──────────────────────────
// Actions worker calls POST /callback with JSON { job_id, event, message }
// This is optional but gives real-time updates. Set CALLBACK_PORT in .env.
// If you don't have a public URL, the bot falls back to polling run status.
const CALLBACK_PORT = process.env.CALLBACK_PORT ? Number(process.env.CALLBACK_PORT) : null;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || "";

function startCallbackServer(bot) {
  if (!CALLBACK_PORT) {
    console.log(chalk.gray("no CALLBACK_PORT set — using polling only"));
    return;
  }
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        if (CALLBACK_SECRET && payload.secret !== CALLBACK_SECRET) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        res.writeHead(200);
        res.end("ok");
        await handleCallback(bot, payload);
      } catch (e) {
        console.log(chalk.bold("callback parse error"), e.message);
        res.writeHead(400);
        res.end();
      }
    });
  });
  server.listen(CALLBACK_PORT, () =>
    console.log(chalk.bold(`callback server on :${CALLBACK_PORT}`)),
  );
}

async function handleCallback(bot, payload) {
  const { job_id, event, message: msg, chat_id } = payload;
  // event: "progress" | "done" | "error"
  const job = jobs.get(job_id);
  const cid = chat_id || job?.chatId;
  if (!cid) return;

  if (event === "progress") {
    if (job?.msgId) {
      await bot.telegram
        .editMessageText(cid, job.msgId, null, `⏳ ${msg}`)
        .catch(() => {});
    } else {
      const m = await bot.telegram.sendMessage(cid, `⏳ ${msg}`);
      if (job) job.msgId = m.message_id;
    }
  } else if (event === "done") {
    if (job?.msgId) {
      await bot.telegram
        .editMessageText(cid, job.msgId, null, `✓ ${msg}`)
        .catch(() => {});
    } else {
      await bot.telegram.sendMessage(cid, `✓ ${msg}`);
    }
    jobs.delete(job_id);
  } else if (event === "error") {
    if (job?.msgId) {
      await bot.telegram
        .editMessageText(cid, job.msgId, null, `✗ ${msg}`)
        .catch(() => {});
    } else {
      await bot.telegram.sendMessage(cid, `✗ ${msg}`);
    }
    jobs.delete(job_id);
  }
}

// ─── Background poller (fallback when no callback URL) ───────────────────────
// Polls GitHub every 15s and updates the Telegram message
async function pollJobUntilDone(bot, jobId, runId) {
  const job = jobs.get(jobId);
  if (!job) return;

  const phases = [
    "queued on GitHub...",
    "runner starting...",
    "downloading file...",
    "extracting & uploading...",
  ];
  let phaseIndex = 0;
  let lastStatus = "";

  while (true) {
    await sleep(15000);
    const job2 = jobs.get(jobId);
    if (!job2) return; // was cancelled

    let runStatus;
    try {
      runStatus = await getRunStatus(runId);
    } catch {
      continue;
    }

    // Cycle through descriptive phases while in_progress
    if (runStatus.status === "in_progress" && lastStatus !== "in_progress") {
      lastStatus = "in_progress";
      phaseIndex = 1;
    }
    if (runStatus.status === "in_progress") {
      phaseIndex = Math.min(phaseIndex + 1, phases.length - 1);
    }

    const displayMsg =
      runStatus.status === "completed"
        ? runStatus.conclusion === "success"
          ? `✓ all files sent to Telegram!`
          : `✗ worker failed (${runStatus.conclusion}) — check GitHub Actions logs`
        : `⏳ ${phases[phaseIndex]}`;

    try {
      if (job2.msgId) {
        await bot.telegram.editMessageText(
          job2.chatId,
          job2.msgId,
          null,
          displayMsg,
        );
      }
    } catch {}

    if (runStatus.status === "completed") {
      jobs.delete(jobId);
      return;
    }
  }
}

// ─── Bot ─────────────────────────────────────────────────────────────────────
const isSetup = process.argv.includes("--setup");
if (isSetup) {
  console.log(chalk.bold("setup mode: run scripts/v1/index.js --setup instead"));
  console.log(
    chalk.gray(
      "The new coordinator bot does not need gramjs. Setup is only needed for the GitHub Actions worker.",
    ),
  );
  process.exit(0);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// Auth guard
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== Number(process.env.OWNER_CHAT_ID)) {
    await ctx.reply("✗ unauthorized");
    return;
  }
  return next();
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "ZipSender v2 ready\n\nSend a Google Drive ZIP or video link.\nDownload & upload runs on GitHub Actions — your server just coordinates.\n\nCommands:\n/jobs — show active jobs\n/cancel — cancel latest job",
  );
});

bot.command("jobs", async (ctx) => {
  if (jobs.size === 0) {
    await ctx.reply("no active jobs");
    return;
  }
  const lines = [...jobs.entries()].map(([id, j]) => {
    const age = Math.floor((Date.now() - j.startedAt) / 1000);
    return `• job ${id.slice(0, 8)}… — fileId: ${j.fileId.slice(0, 12)}… — ${age}s ago`;
  });
  await ctx.reply(lines.join("\n"));
});

bot.command("cancel", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const jobEntry = [...jobs.entries()].findLast(([, j]) => j.chatId === chatId);
  if (!jobEntry) {
    await ctx.reply("no active job to cancel");
    return;
  }
  const [jobId, job] = jobEntry;

  // Ask GitHub to cancel the run
  try {
    await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/runs/${job.runId}/cancel`,
      { method: "POST", headers: githubHeaders() },
    );
  } catch {}

  jobs.delete(jobId);
  await ctx.reply("✓ cancel requested — GitHub runner will stop shortly");
});

bot.on(message("text"), async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text;

  const fileId = extractGDriveId(text);
  if (!fileId) {
    await ctx.reply("✗ not a valid Google Drive link");
    return;
  }

  // Check if user already has a running job
  const existing = [...jobs.values()].find((j) => j.chatId === chatId);
  if (existing) {
    await ctx.reply(
      "⚠ you already have a job running — use /cancel first if you want to start a new one",
    );
    return;
  }

  const statusMsg = await ctx.reply("⏳ triggering GitHub Actions worker...");

  // Generate a unique job ID to correlate callbacks
  const jobId = `${chatId}_${Date.now()}`;

  // Inputs passed into the workflow
  const inputs = {
    job_id:       jobId,
    file_id:      fileId,
    chat_id:      chatId,
    callback_url: process.env.CALLBACK_URL || "",   // e.g. https://yourserver.com/callback
    callback_secret: CALLBACK_SECRET,
    aunt_username: process.env.AUNT_USERNAME,
  };

  let runId;
  try {
    runId = await triggerWorkflow(inputs);
  } catch (err) {
    console.log(chalk.bold("dispatch error"), chalk.white(err.message));
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `✗ failed to trigger worker: ${err.message}`,
    );
    return;
  }

  jobs.set(jobId, {
    chatId,
    fileId,
    runId,
    msgId: statusMsg.message_id,
    startedAt: Date.now(),
  });

  const runsUrl = `https://github.com/${GH_OWNER}/${GH_REPO}/actions/runs/${runId}`;
  await ctx.telegram.editMessageText(
    ctx.chat.id,
    statusMsg.message_id,
    null,
    `⏳ worker started!\n\nRun: ${runsUrl}\n\nI'll update you as it progresses.`,
  );

  // Always start polling in background (works even without callback URL)
  pollJobUntilDone(bot, jobId, runId).catch(() => {});
});

bot.catch((err, ctx) => {
  console.log(chalk.bold("bot error"), chalk.white(err.message));
  ctx.reply("✗ something went wrong");
});

startCallbackServer(bot);

console.log(chalk.bold("starting coordinator bot"));
bot.launch();

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
