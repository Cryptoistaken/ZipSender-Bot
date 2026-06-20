import { action } from "./_generated/server";
import { v } from "convex/values";

function githubHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "zipsender-bot",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const GH_OWNER = () => process.env.GITHUB_OWNER;
const GH_REPO = () => process.env.GITHUB_REPO;
const GH_BRANCH = () => process.env.GITHUB_BRANCH || "main";
const WORKFLOW = "worker.yml";

export const triggerWorkflow = action({
  args: {
    jobId: v.string(),
    fileId: v.string(),
    chatId: v.string(),
    msgId: v.string(),
    auntUsername: v.string(),
  },
  handler: async (ctx, args) => {
    const owner = GH_OWNER();
    const repo = GH_REPO();
    const branch = GH_BRANCH();
    const callbackSecret = process.env.CALLBACK_SECRET || "";

    const convexSiteUrl = process.env.CONVEX_SITE_URL || "";
    const callbackUrl = convexSiteUrl ? `${convexSiteUrl}/worker-callback` : "";

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW}/dispatches`;
    const before = Date.now();

    const inputs = {
      job_id: args.jobId,
      file_id: args.fileId,
      chat_id: args.chatId,
      msg_id: args.msgId,
      callback_url: callbackUrl,
      callback_secret: callbackSecret,
      aunt_username: args.auntUsername,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: githubHeaders(),
      body: JSON.stringify({ ref: branch, inputs }),
    });

    if (res.status !== 204) {
      const body = await res.text();
      throw new Error(`GitHub dispatch failed: ${res.status} ${body}`);
    }

    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(3000);
      const runsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=5`;
      const r = await fetch(runsUrl, { headers: githubHeaders() });
      const data = await r.json();
      const run = (data.workflow_runs || []).find(
        (w) => new Date(w.created_at).getTime() > before - 5000
      );
      if (run) return run.id;
    }

    throw new Error("Could not find the new workflow run after dispatch");
  },
});

export const cancelRun = action({
  args: { runId: v.number() },
  handler: async (_ctx, args) => {
    const owner = GH_OWNER();
    const repo = GH_REPO();
    await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${args.runId}/cancel`,
      { method: "POST", headers: githubHeaders() }
    );
  },
});

export const getRunStatus = action({
  args: { runId: v.number() },
  handler: async (_ctx, args) => {
    const owner = GH_OWNER();
    const repo = GH_REPO();
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${args.runId}`,
      { headers: githubHeaders() }
    );
    const data = await r.json();
    return { status: data.status, conclusion: data.conclusion };
  },
});

export const listRecentRuns = action({
  args: {},
  handler: async (_ctx) => {
    const owner = GH_OWNER();
    const repo = GH_REPO();
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=5`,
      { headers: githubHeaders() }
    );
    const data = await r.json();
    return (data.workflow_runs || []).map((w) => ({
      id: w.id,
      status: w.status,
      conclusion: w.conclusion,
      displayTitle: w.display_title || w.name || String(w.id),
      createdAt: w.created_at,
    }));
  },
});

