import { action } from "./_generated/server";
import { v } from "convex/values";

export const sendMessage = action({
  args: {
    chatId: v.string(),
    text: v.string(),
  },
  handler: async (_ctx, args) => {
    const base = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
    const res = await fetch(`${base}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: args.chatId, text: args.text }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram sendMessage failed: ${data.description}`);
    return data.result.message_id;
  },
});

export const editMessage = action({
  args: {
    chatId: v.string(),
    msgId: v.number(),
    text: v.string(),
  },
  handler: async (_ctx, args) => {
    const base = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
    await fetch(`${base}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: args.chatId,
        message_id: args.msgId,
        text: args.text,
      }),
    });
  },
});

export const sendMessageWithKeyboard = action({
  args: {
    chatId: v.string(),
    text: v.string(),
  },
  handler: async (_ctx, args) => {
    const base = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
    const keyboard = {
      inline_keyboard: [
        [{ text: "Run Debug", callback_data: "action:debug" }],
        [
          { text: "Active Jobs", callback_data: "action:jobs" },
          { text: "Cancel Latest", callback_data: "action:cancel" },
        ],
      ],
    };
    const res = await fetch(`${base}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: args.chatId,
        text: args.text,
        reply_markup: keyboard,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram sendMessage failed: ${data.description}`);
    return data.result.message_id;
  },
});

export const answerCallbackQuery = action({
  args: {
    callbackQueryId: v.string(),
    text: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const base = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
    await fetch(`${base}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: args.callbackQueryId,
        text: args.text || "",
      }),
    });
  },
});
