import "dotenv/config";

const botToken = process.env.BOT_TOKEN;
const convexSiteUrl = process.env.CONVEX_SITE_URL;

if (!botToken || !convexSiteUrl) {
  console.error("Missing BOT_TOKEN or CONVEX_SITE_URL in .env");
  process.exit(1);
}

const webhookUrl = `${convexSiteUrl}/telegram-webhook`;

console.log(`Setting webhook to: ${webhookUrl}`);

const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  }),
});

const data = await res.json();

if (data.ok) {
  console.log("Webhook set successfully");
} else {
  console.error("Failed:", data.description);
  process.exit(1);
}

const infoRes = await fetch(
  `https://api.telegram.org/bot${botToken}/getWebhookInfo`
);
const info = await infoRes.json();
console.log("Telegram confirms webhook URL:", info.result?.url);
console.log("Pending updates:", info.result?.pending_update_count ?? 0);
