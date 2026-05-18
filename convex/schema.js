import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  jobs: defineTable({
    jobId: v.string(),
    chatId: v.string(),
    fileIds: v.string(),
    runId: v.optional(v.number()),
    msgId: v.optional(v.number()),
    workerActive: v.boolean(),
    startedAt: v.number(),
    status: v.string(),
  }).index("by_jobId", ["jobId"]),
});
