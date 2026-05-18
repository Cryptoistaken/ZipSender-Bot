# ZipSender Bot

Google Drive to Telegram via GitHub Actions. Serverless backend on Convex.

---

## File structure

```
.github/
  workflows/
    worker.yml          Download, extract, rename, upload
    convex-deploy.yml   Auto-deploy Convex + sync env vars + register webhook
  scripts/
    worker.js           Worker script that runs inside the Action
convex/
  schema.js             Database schema
  http.js               Telegram webhook + worker callback
  jobs.js               Job DB mutations and queries
  github.js             GitHub API actions
  telegram.js           Telegram send and edit actions
  webhook_setup.js      Manual webhook registration helper
scripts/
  set-webhook.js        Local webhook setup script
  gramjs-setup.js       GramJS session setup
package.json
bun.lockb
.env.example
```

---

## Setup

### 1. Create a GitHub repo and push this code

### 2. Install dependencies locally

```bash
bun install
```

### 3. Set up Convex

```bash
npx convex dev
```

This creates a free Convex project. Copy the `.convex.site` URL from the dashboard.

### 4. Set GitHub Actions secrets

Go to **repo Settings - Secrets and variables - Actions - New repository secret**

| Secret name              | Value                                                        |
|--------------------------|--------------------------------------------------------------|
| `BOT_TOKEN`              | Telegram bot token                                           |
| `OWNER_CHAT_ID`          | Your Telegram user ID                                        |
| `AUNT_USERNAME`          | Telegram recipient user ID                                   |
| `TELEGRAM_API_ID`        | From https://my.telegram.org                                 |
| `TELEGRAM_API_HASH`      | From https://my.telegram.org                                 |
| `TELEGRAM_SESSION`       | Run `bun scripts/gramjs-setup.js`, copy the output           |
| `GROQ_API_KEY`           | From https://console.groq.com                                |
| `GH_PAT`                 | GitHub personal access token with repo and actions scopes    |
| `GH_OWNER`               | Your GitHub username                                         |
| `GH_REPO`                | This repo name                                               |
| `GH_BRANCH`              | `master`                                                     |
| `CALLBACK_SECRET`        | Any random string                                            |
| `CONVEX_DEPLOY_KEY`      | From Convex dashboard - Settings - Deploy Key                |
| `CONVEX_SITE_URL`        | Your `.convex.site` URL from the dashboard                   |

### 5. Deploy and auto-sync

Push to `master` or run the `Deploy Convex` workflow manually. This deploys the Convex backend, syncs all secrets above to Convex environment variables, and registers the Telegram webhook automatically.

```bash
git push origin master
```

Verify in the Actions tab that the deploy succeeded. The webhook registration step will confirm the URL.

---

## How it works

```
You - send Google Drive link to Telegram bot
Telegram - POST to https://your-app.convex.site/telegram-webhook
Convex HTTP action:
  - saves job to Convex DB
  - triggers GitHub Actions worker.yml via API
  - sends run URL back to Telegram chat

GitHub Actions runner:
  1. bun install
  2. Downloads files from GDrive in parallel
  3. Extracts ZIPs if needed
  4. AI renames files via Groq
  5. Uploads videos to Telegram via GramJS in parallel (workers: 15 each)
  6. POSTs progress, done, or error to Convex callback URL

Convex callback action:
  - updates the Telegram status message in real time
  - marks job done or error in DB
```

---

## Commands

Send any Google Drive link to start processing. Multiple links in one message are supported.

| Button        | What it does                               |
|---------------|--------------------------------------------|
| Run Debug     | Check env vars and GitHub connectivity     |
| Active Jobs   | List local DB jobs and recent GitHub runs  |
| Cancel Latest | Cancel the most recent running job         |

---

## Limits (GitHub free tier)

- 2 000 minutes per month (unlimited for public repos)
- 6 hour max per job
- 14 GB disk on runner

For high volume: make the repo public. GitHub secrets stay private.

---

## Convex limits (free tier)

- 1M function calls per month
- 1 GB database storage
- 1 GB file storage

More than enough for personal use.
