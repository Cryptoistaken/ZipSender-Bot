# ZipSender Bot

Google Drive - GitHub Actions - Telegram

No server required. The bot runs on Convex (free, serverless).  
All heavy work runs on GitHub Actions free runners.

---

## File structure

```
.github/
  workflows/worker.yml          - GitHub Actions workflow (uses Bun)
  scripts/worker.js             - Worker that runs inside the Action
convex/
  schema.js                     - Database schema (jobs table)
  http.js                       - Telegram webhook + worker callback receiver
  jobs.js                       - Job DB mutations/queries
  github.js                     - GitHub API actions
  telegram.js                   - Telegram send/edit actions
  webhook_setup.js              - One-shot webhook registration
scripts/
  set-webhook.js                - Local webhook setup script
  gramjs-setup.js               - GramJS session setup
package.json
.env.example
```

---

## Setup

### 1. Create a GitHub repo and push this code

### 2. Install dependencies

```bash
npm install
```

### 3. Set up Convex

```bash
npx convex dev
```

This will:
- Create a free Convex project at dashboard.convex.dev
- Give you a deployment URL like `https://happy-animal-123.convex.cloud`
- Give you a site URL like `https://happy-animal-123.convex.site`

Copy both URLs.

### 4. Set Convex environment variables

```bash
npx convex env set BOT_TOKEN        "your-bot-token"
npx convex env set OWNER_CHAT_ID    "your-telegram-user-id"
npx convex env set AUNT_USERNAME    "recipient-user-id"
npx convex env set GITHUB_TOKEN     "github_pat_..."
npx convex env set GITHUB_OWNER     "your-github-username"
npx convex env set GITHUB_REPO      "your-repo-name"
npx convex env set GITHUB_BRANCH    "main"
npx convex env set CALLBACK_SECRET  "any-random-string"
npx convex env set CONVEX_SITE_URL  "https://happy-animal-123.convex.site"
```

### 5. Register the Telegram webhook

Option A - via Convex (recommended):
```bash
npx convex run webhook_setup:registerWebhook
```

Option B - via local script:
```bash
cp .env.example .env
# Fill in BOT_TOKEN and CONVEX_SITE_URL
node scripts/set-webhook.js
```

You should see:
```
Webhook set successfully
Telegram confirms webhook URL: https://happy-animal-123.convex.site/telegram-webhook
```

### 6. Set GitHub Actions secrets

Go to your **repo - Settings - Secrets and variables - Actions - New repository secret**

| Secret name         | Value                                                 |
|---------------------|-------------------------------------------------------|
| `TELEGRAM_API_ID`   | from https://my.telegram.org                          |
| `TELEGRAM_API_HASH` | from https://my.telegram.org                          |
| `TELEGRAM_SESSION`  | run `node scripts/gramjs-setup.js`, copy output       |
| `BOT_TOKEN`         | your Telegram bot token                               |
| `GROQ_API_KEY`      | from https://console.groq.com                         |
| `CALLBACK_SECRET`   | same value you set in Convex env vars (step 4)        |

### 7. Deploy Convex to production

```bash
npx convex dev
```

Done. No server to run. The bot is live.

---

## How it works

```
You - send GDrive link to Telegram bot
Telegram - POST to https://your-app.convex.site/telegram-webhook
Convex HTTP action:
  - saves job to Convex DB
  - calls GitHub API to trigger worker.yml
  - edits Telegram message with run URL

GitHub Actions runner:
  1. bun install  (~10 seconds vs 3-5 min with npm)
  2. Downloads files from GDrive in parallel
  3. Extracts ZIPs if needed
  4. AI renames files via Groq
  5. Uploads each video to Telegram via gramjs (workers: 15)
  6. POSTs progress/done/error to https://your-app.convex.site/worker-callback

Convex worker-callback action:
  - updates the Telegram status message in real-time
  - marks job done/error in DB
```

---

## Commands

Send any Google Drive link to start processing (supports multiple links in one message).

Inline keyboard buttons:

| Button        | What it does                               |
|---------------|--------------------------------------------|
| Run Debug     | Check all env vars and GitHub connectivity |
| Active Jobs   | List local DB jobs and recent GitHub runs  |
| Cancel Latest | Cancel the most recent running job         |

---

## Limits (GitHub free tier)

- 2,000 minutes/month (free for public repos: unlimited)
- 6-hour max per job
- 14GB disk on runner

For high volume: make the repo **public**. Secrets stay private.

---

## Convex limits (free tier)

- 1M function calls/month
- 1 GB database storage
- 1 GB file storage
- More than enough for personal use
