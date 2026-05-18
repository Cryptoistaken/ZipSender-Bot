import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

function extractGDriveIds(text) {
  const regex = /(?:\/d\/|[?&]id=)([a-zA-Z0-9_-]{25,})/g;
  const matches = [];
  let m;
  while ((m = regex.exec(text)) !== null) matches.push(m[1]);
  return [...new Set(matches)];
}

http.route({
  path: "/telegram-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const update = await request.json();

    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = String(cb.message.chat.id);
      const fromId = cb.from.id;
      const ownerChatId = Number(process.env.OWNER_CHAT_ID);

      await ctx.runAction(internal.telegram.answerCallbackQuery, {
        callbackQueryId: cb.id,
        text: "Working...",
      });

      if (fromId !== ownerChatId) {
        return new Response("ok", { status: 200 });
      }

      const action = cb.data;

      if (action === "action:debug") {
        await ctx.runAction(internal.github.runDebug, { chatId });
      } else if (action === "action:jobs") {
        const jobs = await ctx.runQuery(internal.jobs.listJobs, {});
        const runs = await ctx.runAction(internal.github.listRecentRuns, {});
        const parts = [];

        if (jobs.length > 0) {
          const localLines = jobs.map((j) => {
            const age = Math.floor((Date.now() - j.startedAt) / 1000);
            const count = j.fileIds ? j.fileIds.split(",").length : 0;
            return `  ${j.jobId.slice(0, 8)}  ${count} file(s)  ${age}s  [${j.status}]`;
          });
          parts.push(`Local jobs (${jobs.length}):\n${localLines.join("\n")}`);
        }

        if (runs.length > 0) {
          const runLines = runs.map((r) => {
            const icon =
              r.status === "completed"
                ? r.conclusion === "success"
                  ? "ok"
                  : "fail"
                : "...";
            const ageMin = Math.floor(
              (Date.now() - new Date(r.createdAt)) / 60000,
            );
            return `  ${icon} ${r.displayTitle}  ${r.status}  ${ageMin}min`;
          });
          parts.push(`GitHub runs:\n${runLines.join("\n")}`);
        }

        const text = parts.length > 0 ? parts.join("\n\n") : "Nothing running.";
        await ctx.runAction(internal.telegram.sendMessageWithKeyboard, {
          chatId,
          text,
        });
      } else if (action === "action:cancel") {
        const jobs = await ctx.runQuery(internal.jobs.listJobs, {});
        const myJobs = jobs.filter((j) => j.chatId === chatId);
        const latest = myJobs[myJobs.length - 1];

        if (latest?.runId) {
          await ctx.runAction(internal.github.cancelRun, {
            runId: latest.runId,
          });
          await ctx.runMutation(internal.jobs.deleteJob, {
            jobId: latest.jobId,
          });
          await ctx.runAction(internal.telegram.sendMessageWithKeyboard, {
            chatId,
            text: "Cancel requested - runner will stop shortly.",
          });
        } else {
          const runs = await ctx.runAction(internal.github.listRecentRuns, {});
          const activeRun = runs.find((r) => r.status !== "completed");
          if (activeRun) {
            await ctx.runAction(internal.github.cancelRun, {
              runId: activeRun.id,
            });
            await ctx.runAction(internal.telegram.sendMessageWithKeyboard, {
              chatId,
              text: `Cancelled: ${activeRun.displayTitle}`,
            });
          } else {
            await ctx.runAction(internal.telegram.sendMessageWithKeyboard, {
              chatId,
              text: "No active job to cancel.",
            });
          }
        }
      }

      return new Response("ok", { status: 200 });
    }

    if (!update.message) return new Response("ok", { status: 200 });

    const msg = update.message;
    const chatId = String(msg.chat.id);
    const fromId = msg.from?.id;
    const ownerChatId = Number(process.env.OWNER_CHAT_ID);

    if (fromId !== ownerChatId) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId,
        text: "Unauthorized",
      });
      return new Response("ok", { status: 200 });
    }

    const text = msg.text || "";

    if (text === "/start" || text.startsWith("/start ")) {
      await ctx.runAction(internal.telegram.sendMessageWithKeyboard, {
        chatId,
        text: "Ready. Send a Google Drive link.",
      });
      return new Response("ok", { status: 200 });
    }

    const fileIds = extractGDriveIds(text);
    if (fileIds.length === 0) {
      await ctx.runAction(internal.telegram.sendMessageWithKeyboard, {
        chatId,
        text: "Send a Google Drive link to get started.",
      });
      return new Response("ok", { status: 200 });
    }

    const statusMsgId = await ctx.runAction(internal.telegram.sendMessage, {
      chatId,
      text: `Starting GitHub Actions worker for ${fileIds.length} links`,
    });

    const jobId = `${chatId}_${Date.now()}`;

    await ctx.runMutation(internal.jobs.createJob, {
      jobId,
      chatId,
      fileIds: fileIds.join(","),
    });

    let runId;
    try {
      runId = await ctx.runAction(internal.github.triggerWorkflow, {
        jobId,
        fileId: fileIds.join(","),
        chatId,
        msgId: String(statusMsgId),
        auntUsername: process.env.AUNT_USERNAME || "",
      });
    } catch (err) {
      await ctx.runAction(internal.telegram.editMessage, {
        chatId,
        msgId: statusMsgId,
        text: `Failed to trigger worker: ${err.message}`,
      });
      await ctx.runMutation(internal.jobs.deleteJob, { jobId });
      return new Response("ok", { status: 200 });
    }

    await ctx.runMutation(internal.jobs.setRunInfo, {
      jobId,
      runId,
      msgId: statusMsgId,
    });

    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const runsUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;

    await ctx.runAction(internal.telegram.editMessage, {
      chatId,
      msgId: statusMsgId,
      text: `Worker started\n\nRun: ${runsUrl}\n\nThis message will update as the job progresses.`,
    });

    return new Response("ok", { status: 200 });
  }),
});

http.route({
  path: "/worker-callback",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const payload = await request.json();

    const expectedSecret = process.env.CALLBACK_SECRET || "";
    if (expectedSecret && payload.secret !== expectedSecret) {
      return new Response("forbidden", { status: 403 });
    }

    const { job_id: jobId, chat_id: chatId, event, message } = payload;

    const job = await ctx.runQuery(internal.jobs.getJob, { jobId });
    const cid = chatId || job?.chatId;
    if (!cid) return new Response("ok", { status: 200 });

    if (event === "progress") {
      await ctx.runMutation(internal.jobs.setWorkerActive, { jobId });
      if (job?.msgId) {
        await ctx.runAction(internal.telegram.editMessage, {
          chatId: cid,
          msgId: job.msgId,
          text: message,
        });
      } else {
        const newMsgId = await ctx.runAction(internal.telegram.sendMessage, {
          chatId: cid,
          text: message,
        });
        await ctx.runMutation(internal.jobs.setMsgId, {
          jobId,
          msgId: newMsgId,
        });
      }
    } else if (event === "done") {
      if (job?.msgId) {
        await ctx.runAction(internal.telegram.editMessage, {
          chatId: cid,
          msgId: job.msgId,
          text: `Done\n\n${message}`,
        });
      } else {
        await ctx.runAction(internal.telegram.sendMessage, {
          chatId: cid,
          text: `Done\n\n${message}`,
        });
      }
      await ctx.runMutation(internal.jobs.finishJob, { jobId, status: "done" });
    } else if (event === "error") {
      if (job?.msgId) {
        await ctx.runAction(internal.telegram.editMessage, {
          chatId: cid,
          msgId: job.msgId,
          text: `Failed: ${message}`,
        });
      } else {
        await ctx.runAction(internal.telegram.sendMessage, {
          chatId: cid,
          text: `Failed: ${message}`,
        });
      }
      await ctx.runMutation(internal.jobs.finishJob, {
        jobId,
        status: "error",
      });
    }

    return new Response("ok", { status: 200 });
  }),
});

export default http;
