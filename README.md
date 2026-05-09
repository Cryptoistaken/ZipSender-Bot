# ZipSender v2

Google Drive → GitHub Actions → Telegram

Your 250MB server runs only the Telegram bot coordinator.  
All heavy work (download, extract, upload) runs on GitHub Actions free runners (2 CPU, 14GB RAM, fast internet).

---

## File structure

```
index.js                        ← NEW: coordinator bot (runs on your server)
scripts/v1/index.js             ← ORIGINAL: all-in-one bot (kept for reference)
.github/
  workflows/worker.yml          ← GitHub Actions workflow
  scripts/worker.js             ← Worker that runs inside the Action
package.json
.env.example
```

---

## Setup

### 1. GitHub repo
Create a GitHub repo (can be private) and push this code.

### 2. GitHub PAT
Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**  
Create a token with:
- **Repository access**: your repo only
- **Permissions**:
  - `Actions` → Read & Write (to trigger workflows and read run status)
  - `Contents` → Read (to checkout code in the runner)

Copy the token.

### 3. GitHub repo secrets
Go to your **repo → Settings → Secrets and variables → Actions → New repository secret**

Add these secrets (the runner reads them):

| Secret name        | Value                                      |
|--------------------|--------------------------------------------|
| `TELEGRAM_API_ID`  | from https://my.telegram.org               |
| `TELEGRAM_API_HASH`| from https://my.telegram.org               |
| `TELEGRAM_SESSION` | run `npm run setup:v1` locally, copy output|
| `BOT_TOKEN`        | your Telegram bot token                    |
| `GROQ_API_KEY`     | from https://console.groq.com              |

### 4. Your server .env
Copy `.env.example` to `.env` and fill in:

```env
BOT_TOKEN=8501340062:AAFqRs...
OWNER_CHAT_ID=8447133985
AUNT_USERNAME=1209868253

GITHUB_TOKEN=github_pat_...
GITHUB_OWNER=yourusername
GITHUB_REPO=zipsender
GITHUB_BRANCH=main

# Leave CALLBACK_URL empty if your server has no public URL
# The bot will poll GitHub every 15s instead
CALLBACK_URL=
CALLBACK_PORT=
CALLBACK_SECRET=
```

### 5. Run on your server
```bash
npm install
npm start
```

---

## How it works

```
You → send GDrive link to bot
Bot → calls GitHub API to trigger worker.yml
      (passes file_id, chat_id, job_id as inputs)

GitHub Actions runner:
  1. npm install
  2. Downloads file from GDrive (fast — GitHub has great bandwidth)
  3. Extracts ZIP if needed (14GB workspace — no size worries)
  4. AI renames files via Groq
  5. Uploads each video to Telegram via gramjs
  6. Calls your server /callback OR sends Telegram message directly

Your server: updates the Telegram status message
```

---

## Commands

| Command   | What it does                        |
|-----------|-------------------------------------|
| `/start`  | Show welcome message                |
| `/jobs`   | List active GitHub Actions jobs     |
| `/cancel` | Cancel your latest running job      |

---

## Limits (GitHub free tier)
- 2,000 minutes/month (free for public repos: unlimited)
- 6-hour max per job
- 14GB disk on runner
- No concurrent job limit per se, but your bot enforces 1 job per user

For high volume: make the repo **public** (Actions minutes are free on public repos). The secrets are still private — only the workflow YAML is public.

---

## Keeping v1
The original bot is at `scripts/v1/index.js`.  
Run it with: `npm run start:v1`  
Get a session string: `npm run setup:v1`
