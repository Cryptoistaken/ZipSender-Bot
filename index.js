import "dotenv/config";
import fs from "fs";
import http from "http";
import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import chalk from "chalk";

const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_OWNER = process.env.GITHUB_OWNER;
const GH_REPO = process.env.GITHUB_REPO;
const GH_BRANCH = process.env.GITHUB_BRANCH || "main";
const WORKFLOW = "worker.yml";

const jobs = new Map();

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

async function getRunStatus(runId) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/runs/${runId}`;
  const r = await fetch(url, { headers: githubHeaders() });
  const data = await r.json();
  return { status: data.status, conclusion: data.conclusion };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const CALLBACK_PORT = process.env.CALLBACK_PORT
  ? Number(process.env.CALLBACK_PORT)
  : null;
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
  const job = jobs.get(job_id);
  const cid = chat_id || job?.chatId;
  if (!cid) return;

  if (job) job.workerActive = true;

  if (event === "progress") {
    if (job?.msgId) {
      await bot.telegram
        .editMessageText(cid, job.msgId, null, msg)
        .catch(() => {});
    } else {
      const m = await bot.telegram.sendMessage(cid, msg);
      if (job) job.msgId = m.message_id;
    }
  } else if (event === "done") {
    if (job?.msgId) {
      await bot.telegram
        .editMessageText(cid, job.msgId, null, `Done\n\n${msg}`)
        .catch(() => {});
    } else {
      await bot.telegram.sendMessage(cid, `Done\n\n${msg}`);
    }
    jobs.delete(job_id);
  } else if (event === "error") {
    if (job?.msgId) {
      await bot.telegram
        .editMessageText(cid, job.msgId, null, `Failed: ${msg}`)
        .catch(() => {});
    } else {
      await bot.telegram.sendMessage(cid, `Failed: ${msg}`);
    }
    jobs.delete(job_id);
  }
}

async function pollJobUntilDone(bot, jobId, runId) {
  const job = jobs.get(jobId);
  if (!job) return;

  while (true) {
    await sleep(15000);
    const job2 = jobs.get(jobId);
    if (!job2) return;

    let runStatus;
    try {
      runStatus = await getRunStatus(runId);
    } catch {
      continue;
    }

    if (runStatus.status === "completed") {
      if (runStatus.conclusion !== "success" && job2.msgId) {
        await bot.telegram
          .editMessageText(
            job2.chatId,
            job2.msgId,
            null,
            `Worker failed (${runStatus.conclusion}) — check GitHub Actions logs`,
          )
          .catch(() => {});
      }
      jobs.delete(jobId);
      return;
    }

    if (job2.workerActive) continue;

    if (runStatus.status === "in_progress") continue;

    if (runStatus.status !== "completed") {
      try {
        if (job2.msgId) {
          await bot.telegram.editMessageText(
            job2.chatId,
            job2.msgId,
            null,
            "Queued on GitHub — runner starting",
          );
        }
      } catch {}
    }
  }
}

const isSetup = process.argv.includes("--setup");
if (isSetup) {
  console.log(
    chalk.bold("setup mode: run scripts/v1/index.js --setup instead"),
  );
  console.log(
    chalk.gray(
      "The coordinator bot does not need gramjs. Setup is only needed for the GitHub Actions worker.",
    ),
  );
  process.exit(0);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (ctx.from?.id !== Number(process.env.OWNER_CHAT_ID)) {
    await ctx.reply("Unauthorized");
    return;
  }
  return next();
});

const mainKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("Run Debug", "action:debug")],
  [
    Markup.button.callback("Active Jobs", "action:jobs"),
    Markup.button.callback("Cancel Latest", "action:cancel"),
  ],
]);

bot.command("start", async (ctx) => {
  await ctx.reply(
    "ZipSender ready\n\nSend a Google Drive link to a ZIP or video file.\nDownload and upload runs on GitHub Actions — this bot just coordinates.",
    mainKeyboard,
  );
});

async function handleDebug(ctx) {
  const lines = [];

  const missing = [];
  if (!GH_TOKEN) missing.push("GITHUB_TOKEN");
  if (!GH_OWNER) missing.push("GITHUB_OWNER");
  if (!GH_REPO) missing.push("GITHUB_REPO");
  if (missing.length) {
    await ctx.reply(`Missing env vars: ${missing.join(", ")}`);
    return;
  }
  lines.push(`env vars: ok`);
  lines.push(`  owner:  ${GH_OWNER}`);
  lines.push(`  repo:   ${GH_REPO}`);
  lines.push(`  branch: ${GH_BRANCH}`);
  lines.push(`  token:  ${GH_TOKEN.slice(0, 10)}...`);

  const sent = await ctx.reply(lines.join("\n") + "\n\nChecking GitHub API");
  const edit = (text) =>
    ctx.telegram
      .editMessageText(ctx.chat.id, sent.message_id, null, text)
      .catch(() => {});

  try {
    const r = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`,
      { headers: githubHeaders() },
    );
    const data = await r.json();
    if (r.status === 404) {
      lines.push(`repo not found — check GITHUB_OWNER and GITHUB_REPO`);
      await edit(lines.join("\n"));
      return;
    }
    if (r.status === 401 || r.status === 403) {
      lines.push(
        `token rejected (${r.status}) — check GITHUB_TOKEN and its permissions`,
      );
      await edit(lines.join("\n"));
      return;
    }
    lines.push(
      `repo: ${data.full_name} (${data.private ? "private" : "public"})`,
    );
  } catch (e) {
    lines.push(`GitHub API unreachable: ${e.message}`);
    await edit(lines.join("\n"));
    return;
  }

  try {
    const r = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows`,
      { headers: githubHeaders() },
    );
    const data = await r.json();
    const workflows = data.workflows || [];
    const found = workflows.find(
      (w) => w.path === `.github/workflows/${WORKFLOW}`,
    );
    if (!found) {
      const names = workflows.map((w) => w.path).join(", ") || "none";
      lines.push(`workflow not found: .github/workflows/${WORKFLOW}`);
      lines.push(`  workflows in repo: ${names}`);
      lines.push(`  push worker.yml to your repo and try again`);
    } else {
      lines.push(`workflow: ${found.name} (state: ${found.state})`);
      if (found.state !== "active") {
        lines.push(`  state is "${found.state}" — enable it in GitHub UI`);
      }
    }
  } catch (e) {
    lines.push(`could not list workflows: ${e.message}`);
  }

  try {
    const r = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/branches/${GH_BRANCH}`,
      { headers: githubHeaders() },
    );
    if (r.status === 404) {
      lines.push(
        `branch "${GH_BRANCH}" not found — check GITHUB_BRANCH in .env`,
      );
    } else {
      lines.push(`branch "${GH_BRANCH}": ok`);
    }
  } catch (e) {
    lines.push(`could not check branch: ${e.message}`);
  }

  await edit(lines.join("\n"));
}

async function handleJobs(ctx) {
  if (jobs.size === 0) {
    await ctx.reply("No active jobs.", mainKeyboard);
    return;
  }
  const lines = [...jobs.entries()].map(([id, j]) => {
    const age = Math.floor((Date.now() - j.startedAt) / 1000);
    return `  ${id.slice(0, 8)}  fileId: ${j.fileId.slice(0, 12)}  ${age}s ago`;
  });
  await ctx.reply(
    `Active jobs (${jobs.size}):\n${lines.join("\n")}`,
    mainKeyboard,
  );
}

async function handleCancel(ctx) {
  const chatId = String(ctx.chat.id);
  const jobEntry = [...jobs.entries()].findLast(([, j]) => j.chatId === chatId);
  if (!jobEntry) {
    await ctx.reply("No active job to cancel.", mainKeyboard);
    return;
  }
  const [jobId, job] = jobEntry;

  try {
    await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/runs/${job.runId}/cancel`,
      { method: "POST", headers: githubHeaders() },
    );
  } catch {}

  jobs.delete(jobId);
  await ctx.reply(
    "Cancel requested — GitHub runner will stop shortly.",
    mainKeyboard,
  );
}

bot.action("action:debug", async (ctx) => {
  await ctx.answerCbQuery();
  await handleDebug(ctx);
});
bot.action("action:jobs", async (ctx) => {
  await ctx.answerCbQuery();
  await handleJobs(ctx);
});
bot.action("action:cancel", async (ctx) => {
  await ctx.answerCbQuery();
  await handleCancel(ctx);
});

bot.on(message("text"), async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text;

  const fileId = extractGDriveId(text);
  if (!fileId) {
    await ctx.reply("Send a Google Drive link to get started.", mainKeyboard);
    return;
  }

  const statusMsg = await ctx.reply("Starting GitHub Actions worker");

  const jobId = `${chatId}_${Date.now()}`;

  const inputs = {
    job_id: jobId,
    file_id: fileId,
    chat_id: chatId,
    msg_id: String(statusMsg.message_id),
    callback_url: process.env.CALLBACK_URL || "",
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
      `Failed to trigger worker: ${err.message}`,
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
    `Worker started\n\nRun: ${runsUrl}\n\nThis message will update as the job progresses.`,
  );

  pollJobUntilDone(bot, jobId, runId).catch(() => {});
});

bot.catch((err, ctx) => {
  console.log(chalk.bold("bot error"), chalk.white(err.message));
  ctx.reply("Something went wrong.");
});

startCallbackServer(bot);

console.log(chalk.bold("starting coordinator bot"));
bot.launch();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
