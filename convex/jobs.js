import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const createJob = mutation({
  args: {
    jobId: v.string(),
    chatId: v.string(),
    fileIds: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("jobs", {
      jobId: args.jobId,
      chatId: args.chatId,
      fileIds: args.fileIds,
      runId: undefined,
      msgId: undefined,
      workerActive: false,
      startedAt: Date.now(),
      status: "pending",
    });
  },
});

export const setRunInfo = mutation({
  args: {
    jobId: v.string(),
    runId: v.number(),
    msgId: v.number(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("jobs")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .first();
    if (!job) return;
    await ctx.db.patch(job._id, {
      runId: args.runId,
      msgId: args.msgId,
      status: "running",
    });
  },
});

export const setMsgId = mutation({
  args: {
    jobId: v.string(),
    msgId: v.number(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("jobs")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .first();
    if (!job) return;
    await ctx.db.patch(job._id, { msgId: args.msgId });
  },
});

export const setWorkerActive = mutation({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("jobs")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .first();
    if (!job) return;
    await ctx.db.patch(job._id, { workerActive: true });
  },
});

export const finishJob = mutation({
  args: {
    jobId: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("jobs")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .first();
    if (!job) return;
    await ctx.db.delete(job._id);
  },
});

export const getJob = query({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("jobs")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .first();
  },
});

export const listJobs = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("jobs").collect();
  },
});

export const deleteJob = mutation({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("jobs")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .first();
    if (!job) return;
    await ctx.db.delete(job._id);
  },
});
