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
const DEBUG = process.env.DEBUG === "true";
const LOG_FILE = ".logs/coordinator.jsonl";

const jobs = new Map();

/* ── agent-first structured logger ─────────────────────────── */
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
    console.error(chalk.red("[LOG_ERR]"), e.message);
  }
  if (DEBUG || level === "ERROR" || level === "WARN") {
    const color =
      level === "ERROR"
        ? chalk.red
        : level === "WARN"
          ? chalk.yellow
          : level === "DEBUG"
            ? chalk.gray
            : chalk.cyan;
    console.log(
      color(`[${level}]`),
      chalk.dim(source),
      message,
      data ? chalk.gray(JSON.stringify(data)) : "",
    );
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

function redactToken(token) {
  if (!token) return null;
  return token.slice(0, 8) + "****";
}

/* ── startup snapshot ──────────────────────────────────────── */
debugLog("INFO", "coordinator:startup", "coordinator starting", {
  version: process.env.npm_package_version || "2.0.0",
  node: process.version,
  platform: process.platform,
  env: {
    GH_OWNER,
    GH_REPO,
    GH_BRANCH,
    GH_TOKEN_SET: !!GH_TOKEN,
    GH_TOKEN_PREVIEW: redactToken(GH_TOKEN),
    WORKFLOW,
    CALLBACK_PORT: process.env.CALLBACK_PORT || null,
    CALLBACK_URL: process.env.CALLBACK_URL || null,
  },
});

function extractGDriveIds(text) {
  const regex = /(?:\/d\/|[?&]id=)([a-zA-Z0-9_-]{25,})/g;
  const matches = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    matches.push(m[1]);
  }
  return [...new Set(matches)];
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
  logDebug("triggerWorkflow:entry", "dispatching workflow", {
    job_id: inputs.job_id,
    file_ids: inputs.file_id,
    chat_id: inputs.chat_id,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: githubHeaders(),
    body: JSON.stringify({ ref: GH_BRANCH, inputs }),
  });

  if (res.status !== 204) {
    const body = await res.text();
    logError(
      "triggerWorkflow:dispatch",
      `GitHub dispatch failed ${res.status}`,
      new Error(`GitHub dispatch failed: ${res.status}`),
      { body, job_id: inputs.job_id },
    );
    throw new Error(`GitHub dispatch failed: ${res.status} ${body}`);
  }

  logInfo("triggerWorkflow:dispatch", "dispatch accepted (204)", {
    job_id: inputs.job_id,
  });

  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(3000);
    const runsUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${WORKFLOW}/runs?per_page=5`;
    const r = await fetch(runsUrl, { headers: githubHeaders() });
    const data = await r.json();
    const run = (data.workflow_runs || []).find(
      (w) => new Date(w.created_at).getTime() > before - 5000,
    );
    if (run) {
      logInfo("triggerWorkflow:found", `run found after ${attempt + 1} attempts`, {
        run_id: run.id,
        status: run.status,
        job_id: inputs.job_id,
      });
      return run.id;
    }
  }
  logError(
    "triggerWorkflow:timeout",
    "Could not find new workflow run after 20 attempts",
    new Error("workflow run lookup timeout"),
    { job_id: inputs.job_id },
  );
  throw new Error("Could not find the new workflow run after dispatch");
}

async function getRunStatus(runId) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/runs/${runId}`;
  logDebug("getRunStatus:fetch", `checking run ${runId}`);
  const r = await fetch(url, { headers: githubHeaders() });
  const data = await r.json();
  const status = data.status;
  const conclusion = data.conclusion;
  logDebug("getRunStatus:result", `run ${runId} status`, {
    status,
    conclusion,
    run_name: data.name,
  });
  return { status, conclusion };
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
  logDebug("handleCallback:entry", "received callback", {
    job_id: payload.job_id,
    event: payload.event,
    chat_id: payload.chat_id,
    msg_preview: payload.message?.slice(0, 120),
  });
  const { job_id, event, message: msg, chat_id } = payload;
  const job = jobs.get(job_id);
  const cid = chat_id || job?.chatId;
  if (!cid) {
    logWarn("handleCallback:skip", "no matching job_id or chat_id", {
      job_id,
      known_jobs: [...jobs.keys()],
    });
    return;
  }

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
    logInfo("handleCallback:done", `job ${job_id} done`, {
      msg_preview: msg?.slice(0, 200),
    });
    if (job?.msgId) {
      await bot.telegram
        .editMessageText(cid, job.msgId, null, `Done\n\n${msg}`)
        .catch((e) => logError("handleCallback:edit", "edit failed", e));
    } else {
      await bot.telegram.sendMessage(cid, `Done\n\n${msg}`);
    }
    jobs.delete(job_id);
  } else if (event === "error") {
    logError("handleCallback:error", `job ${job_id} error`, new Error(msg), {
      chat_id: cid,
      job_id,
    });
    if (job?.msgId) {
      await bot.telegram
        .editMessageText(cid, job.msgId, null, `Failed: ${msg}`)
        .catch((e) => logError("handleCallback:edit", "edit failed", e));
    } else {
      await bot.telegram.sendMessage(cid, `Failed: ${msg}`);
    }
    jobs.delete(job_id);
  }
}

async function pollJobUntilDone(bot, jobId, runId) {
  logDebug("pollJobUntilDone:entry", `starting poll loop`, { jobId, runId });
  const job = jobs.get(jobId);
  if (!job) {
    logWarn("pollJobUntilDone:missing", "job not found in Map", { jobId });
    return;
  }

  let loops = 0;
  while (true) {
    loops += 1;
    await sleep(15000);
    const job2 = jobs.get(jobId);
    if (!job2) {
      logInfo("pollJobUntilDone:exit", "job removed from Map, stopping poll", {
        jobId,
        loops,
      });
      return;
    }

    let runStatus;
    try {
      runStatus = await getRunStatus(runId);
    } catch (e) {
      logDebug("pollJobUntilDone:fetch_err", `run status fetch failed`, {
        runId,
        loops,
      });
      continue;
    }

    if (runStatus.status === "completed") {
      logInfo("pollJobUntilDone:completed", `run completed`, {
        runId,
        conclusion: runStatus.conclusion,
        loops,
      });
      if (runStatus.conclusion !== "success" && job2.msgId) {
        await bot.telegram
          .editMessageText(
            job2.chatId,
            job2.msgId,
            null,
            `Worker failed (${runStatus.conclusion}) — check GitHub Actions logs`,
          )
          .catch((e) => logError("pollJobUntilDone:edit", "edit failed", e));
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
    "Ready. Send a Google Drive link.",
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
    await ctx.reply(`❌ Missing env vars: ${missing.join(", ")}`);
    return;
  }
  lines.push(`✅ env vars ok`);
  lines.push(`  owner:  ${GH_OWNER}`);
  lines.push(`  repo:   ${GH_REPO}`);
  lines.push(`  branch: ${GH_BRANCH}`);
  lines.push(`  token:  ${GH_TOKEN.slice(0, 10)}...`);

  try {
    const r = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`,
      { headers: githubHeaders() },
    );
    const data = await r.json();
    if (r.status === 404) {
      lines.push(`❌ repo not found — check GITHUB_OWNER and GITHUB_REPO`);
      await ctx.reply(lines.join("\n"));
      return;
    }
    if (r.status === 401 || r.status === 403) {
      lines.push(`❌ token rejected (${r.status}) — check GITHUB_TOKEN`);
      await ctx.reply(lines.join("\n"));
      return;
    }
    lines.push(
      `✅ repo: ${data.full_name} (${data.private ? "private" : "public"})`,
    );
  } catch (e) {
    lines.push(`❌ GitHub API unreachable: ${e.message}`);
    await ctx.reply(lines.join("\n"));
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
      lines.push(`❌ workflow .github/workflows/${WORKFLOW} not found`);
      lines.push(`   workflows in repo: ${names}`);
    } else {
      lines.push(`✅ workflow: ${found.name} (state: ${found.state})`);
      if (found.state !== "active") {
        lines.push(`   ⚠️ state is "${found.state}" — enable it in GitHub UI`);
      }
    }
  } catch (e) {
    lines.push(`❌ could not list workflows: ${e.message}`);
  }

  try {
    const r = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/branches/${GH_BRANCH}`,
      { headers: githubHeaders() },
    );
    if (r.status === 404) {
      lines.push(`❌ branch "${GH_BRANCH}" not found`);
    } else {
      lines.push(`✅ branch "${GH_BRANCH}": ok`);
    }
  } catch (e) {
    lines.push(`❌ could not check branch: ${e.message}`);
  }

  await ctx.reply(lines.join("\n"));
}

async function handleJobs(ctx) {
  const parts = [];

  if (jobs.size > 0) {
    const localLines = [...jobs.entries()].map(([id, j]) => {
      const age = Math.floor((Date.now() - j.startedAt) / 1000);
      const fileCount = j.fileIds
        ? j.fileIds.split(",").length
        : j.fileId
          ? 1
          : 0;
      return `  ${id.slice(0, 8)}  ${fileCount} file${fileCount !== 1 ? "s" : ""}  ${age}s`;
    });
    parts.push(`Local  ${jobs.size}:\n${localLines.join("\n")}`);
  }

  try {
    const r = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${WORKFLOW}/runs?per_page=5`,
      { headers: githubHeaders() },
    );
    const data = await r.json();
    const runs = (data.workflow_runs || []).slice(0, 5);
    if (runs.length > 0) {
      const runLines = runs.map((w) => {
        const icon =
          w.status === "completed"
            ? w.conclusion === "success"
              ? "✅"
              : "❌"
            : "⏳";
        const ageMin = Math.floor(
          (Date.now() - new Date(w.created_at)) / 60000,
        );
        return `  ${icon} ${w.display_title || w.name}  ${w.status}  ${ageMin}min`;
      });
      parts.push(`GitHub  ${runs.length}:\n${runLines.join("\n")}`);
    }
  } catch (e) {
    parts.push(`⚠️ GitHub fetch failed: ${e.message}`);
  }

  if (parts.length === 0) {
    await ctx.reply("Nothing running.", mainKeyboard);
    return;
  }

  await ctx.reply(parts.join("\n\n"), mainKeyboard);
}

async function handleCancel(ctx) {
  const chatId = String(ctx.chat.id);

  // Try local Map first
  const filtered = [...jobs.entries()].filter(([, j]) => j.chatId === chatId);
  const jobEntry = filtered.length ? filtered[filtered.length - 1] : null;

  if (jobEntry) {
    const [jobId, job] = jobEntry;
    try {
      await fetch(
        `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/runs/${job.runId}/cancel`,
        { method: "POST", headers: githubHeaders() },
      );
    } catch (e) {
      await ctx.reply(`⚠️ Cancel API failed: ${e.message}`, mainKeyboard);
    }
    jobs.delete(jobId);
    await ctx.reply(
      "✅ Cancel requested — runner will stop shortly.",
      mainKeyboard,
    );
    return;
  }

  // Fallback: cancel latest non-completed GitHub run
  try {
    const r = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${WORKFLOW}/runs?per_page=5`,
      { headers: githubHeaders() },
    );
    const data = await r.json();
    const latest = (data.workflow_runs || []).find(
      (w) => w.status !== "completed",
    );
    if (!latest) {
      await ctx.reply("No active job to cancel.", mainKeyboard);
      return;
    }
    await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/runs/${latest.id}/cancel`,
      { method: "POST", headers: githubHeaders() },
    );
    await ctx.reply(
      `✅ Cancelled latest run: ${latest.display_title || latest.name || latest.id}`,
      mainKeyboard,
    );
  } catch (e) {
    await ctx.reply(`❌ Failed to cancel: ${e.message}`, mainKeyboard);
  }
}

bot.action("action:debug", async (ctx) => {
  logInfo("bot:action:debug", "button pressed", { from: ctx.from?.id });
  try {
    await ctx.answerCbQuery({ text: "Running debug..." });
    await handleDebug(ctx);
  } catch (err) {
    logError("bot:action:debug", "debug handler error", err);
    console.log(chalk.bold("debug error"), chalk.white(err.message));
    await ctx.reply(`❌ Debug failed: ${err.message}`);
  }
});
bot.action("action:jobs", async (ctx) => {
  logInfo("bot:action:jobs", "button pressed", { from: ctx.from?.id });
  try {
    await ctx.answerCbQuery({ text: "Fetching jobs..." });
    await handleJobs(ctx);
  } catch (err) {
    logError("bot:action:jobs", "jobs handler error", err);
    console.log(chalk.bold("jobs error"), chalk.white(err.message));
    await ctx.reply(`❌ Jobs check failed: ${err.message}`);
  }
});
bot.action("action:cancel", async (ctx) => {
  logInfo("bot:action:cancel", "button pressed", { from: ctx.from?.id });
  try {
    await ctx.answerCbQuery({ text: "Cancelling..." });
    await handleCancel(ctx);
  } catch (err) {
    logError("bot:action:cancel", "cancel handler error", err);
    console.log(chalk.bold("cancel error"), chalk.white(err.message));
    await ctx.reply(`❌ Cancel failed: ${err.message}`);
  }
});

bot.on(message("text"), async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text;

  const fileIds = extractGDriveIds(text);
  if (fileIds.length === 0) {
    await ctx.reply("Send a Google Drive link to get started.", mainKeyboard);
    return;
  }

  const statusMsg = await ctx.reply(`Starting GitHub Actions worker for ${fileIds.length} link(s)`);

  const jobId = `${chatId}_${Date.now()}`;

  const inputs = {
    job_id: jobId,
    file_id: fileIds.join(","),
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
    fileIds: fileIds.join(","),
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
