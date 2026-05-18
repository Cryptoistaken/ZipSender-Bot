import { action } from "./_generated/server";
import { v } from "convex/values";

export const registerWebhook = action({
  args: {},
  handler: async (_ctx) => {
    const botToken = process.env.BOT_TOKEN;
    const convexSiteUrl = process.env.CONVEX_SITE_URL;

    if (!botToken) throw new Error("BOT_TOKEN not set in Convex env vars");
    if (!convexSiteUrl) throw new Error("CONVEX_SITE_URL not set in Convex env vars");

    const webhookUrl = `${convexSiteUrl}/telegram-webhook`;

    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: true,
        }),
      }
    );
    const data = await res.json();
    if (!data.ok) throw new Error(`setWebhook failed: ${data.description}`);

    const infoRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getWebhookInfo`
    );
    const info = await infoRes.json();

    return {
      registered: webhookUrl,
      telegramConfirms: info.result?.url,
      pendingUpdates: info.result?.pending_update_count,
    };
  },
});

export const deleteWebhook = action({
  args: {},
  handler: async (_ctx) => {
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) throw new Error("BOT_TOKEN not set");
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/deleteWebhook`,
      { method: "POST" }
    );
    const data = await res.json();
    return data;
  },
});
