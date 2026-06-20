# ZipSender Bot v3

Telegram bot that downloads Google Drive files, extracts ZIPs, AI-renames videos, and delivers them via GramJS — all triggered from a chat message. Serverless backend on Convex, worker on GitHub Actions.

---

## Architecture

```
You ─send GDrive link─▶ Telegram Bot
                          │
                          ▼
                    Convex HTTP webhook
                    ├─ saves job to DB
                    ├─ triggers GitHub Actions worker via API
                    └─ replies with run URL
                          │
                          ▼
                    GitHub Actions runner
                    ├─ downloads files from GDrive (parallel)
                    ├─ extracts ZIPs if needed
                    ├─ AI renames files via Groq (llama-3.3-70b)
                    ├─ uploads videos via GramJS (15 workers)
                    └─ POSTs progress/done/error to Convex callback
                          │
                          ▼
                    Convex callback action
                    ├─ edits Telegram status message in real time
                    └─ marks job done or error in DB
```

---

## File structure

```
.github/
  scripts/
    worker.js                  Worker script (download → extract → rename → upload)
  workflows/
    worker.yml                 GitHub Actions workflow triggered by Convex
    convex-deploy.yml          Auto-deploy Convex + sync env vars + register webhook
convex/
  schema.js                    Database schema (jobs table)
  http.js                      Telegram webhook + worker callback routes
  jobs.js                      Job DB mutations and queries
  github.js                    GitHub API: trigger/cancel/status/list runs
  telegram.js                  Telegram send/edit/callback answer actions
  webhookSetup.js              Manual webhook registration via Convex action
scripts/
  gramjsSetup.js               GramJS interactive session setup
  setWebhook.js                Local webhook setup script
package.json
```

---

## Setup

### 1. Create a GitHub repo and push this code

### 2. Install dependencies

```bash
bun install
```

### 3. Set up Convex

```bash
npx convex dev
```

This creates a free Convex project. Copy the `.convex.site` URL from the dashboard.

### 4. Set GitHub Actions secrets

Go to **repo Settings > Secrets and variables > Actions > New repository secret**

| Secret | Description |
|---|---|
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `OWNER_CHAT_ID` | Your Telegram user ID (only you can use the bot) |
| `AUNT_USERNAME` | Recipient Telegram user ID (files sent here) |
| `TELEGRAM_API_ID` | From https://my.telegram.org |
| `TELEGRAM_API_HASH` | From https://my.telegram.org |
| `TELEGRAM_SESSION` | Run `bun scripts/gramjsSetup.js`, copy the output |
| `GROQ_API_KEY` | From https://console.groq.com |
| `GH_PAT` | GitHub personal access token (repo + actions scopes) |
| `GH_OWNER` | Your GitHub username |
| `GH_REPO` | This repo name |
| `GH_BRANCH` | `master` |
| `CALLBACK_SECRET` | Any random string |
| `CONVEX_DEPLOY_KEY` | From Convex dashboard > Settings > Deploy Key |
| `CONVEX_SITE_URL` | Your `.convex.site` URL from the dashboard |

### 5. Deploy

Push to `master` or run the `Deploy Convex` workflow manually:

```bash
git push origin master
```

The deploy workflow will:
1. Deploy the Convex backend
2. Sync all secrets to Convex environment variables
3. Register the Telegram webhook automatically

Verify in the Actions tab that the deploy succeeded.

---

## How it works

### Telegram webhook (`convex/http.js`)

- Receives messages and callback queries from Telegram
- Extracts Google Drive file IDs from the message text (supports multiple links)
- Creates a job in Convex DB
- Triggers the GitHub Actions worker via the GitHub API
- Handles inline keyboard callbacks: **Active Jobs**, **Cancel Latest**, **Stop**

### Worker (`convex/.github/scripts/worker.js`)

1. Downloads files from Google Drive in parallel using `drive.usercontent.google.com`
2. Detects file type by magic bytes (ZIP, MP4, MKV, AVI) and content-type header
3. Extracts ZIPs, collects all video files
4. AI renames files via Groq (`llama-3.3-70b-versatile`) — strips encoding tags, normalizes names
5. Uploads videos to Telegram via GramJS with 15 parallel workers
6. Reports progress/done/error to Convex callback URL in real time

### Convex DB (`convex/jobs.js`)

Tracks active jobs with: `jobId`, `chatId`, `fileIds`, `runId`, `msgId`, `status`, `workerActive`, `startedAt`

---

## Commands

Send any Google Drive link to the bot. Multiple links in one message are supported.

| Button | Action |
|---|---|
| Active Jobs | List DB jobs and recent GitHub runs |
| Cancel Latest | Cancel the most recent running job |
| Stop (per-job) | Cancel a specific job during processing |

---

## Supported file types

- **Input**: Google Drive links (direct download or shared)
- **ZIP archives**: Extracted automatically, video files inside are processed
- **Video files**: `.mp4`, `.mkv`, `.avi`, `.mov`, `.webm`, `.m4v`

---

## Limits

### GitHub Actions (free tier)

- 2,000 minutes/month (unlimited for public repos)
- 6 hours max per job
- 14 GB disk on runner

### Convex (free tier)

- 1M function calls/month
- 1 GB database storage
- 1 GB file storage

---

## npm scripts

| Script | Command | Description |
|---|---|---|
| `dev` | `npx convex dev` | Start Convex dev server |
| `deploy` | `npx convex deploy` | Deploy to Convex |
| `setup:webhook` | `node scripts/setWebhook.js` | Register Telegram webhook locally |
| `setup:session` | `node scripts/gramjsSetup.js` | Interactive GramJS session setup |

---

## Environment variables (Convex)

These are synced automatically by the deploy workflow:

| Variable | Source |
|---|---|
| `BOT_TOKEN` | GitHub secret |
| `OWNER_CHAT_ID` | GitHub secret |
| `AUNT_USERNAME` | GitHub secret |
| `GITHUB_TOKEN` | `GH_PAT` secret |
| `GITHUB_OWNER` | GitHub secret |
| `GITHUB_REPO` | GitHub secret |
| `GITHUB_BRANCH` | GitHub secret |
| `CALLBACK_SECRET` | GitHub secret |
| `CONVEX_SITE_URL` | GitHub secret |

---

## License

MIT
