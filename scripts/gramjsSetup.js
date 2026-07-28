import "dotenv/config";
import readline from "readline";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first");
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

const client = new TelegramClient(
  new StringSession(""),
  apiId,
  apiHash,
  { connectionRetries: 5 }
);

console.log("GramJS interactive session setup\n");

await client.start({
  phoneNumber: async () => ask("Phone number (+countrycode...): "),
  password: async () => ask("2FA password (if any, press Enter): "),
  phoneCode: async () => ask("Code from Telegram: "),
  onError: (err) => console.error(err),
});

const sessionString = client.session.save();

console.log("\n--- COPY THIS INTO GITHUB SECRETS AS TELEGRAM_SESSION ---\n");
console.log(sessionString);
console.log("\n----------------------------------------------------------\n");

rl.close();
await client.disconnect();
