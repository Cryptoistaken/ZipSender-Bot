# ZipSender

Google Drive → GitHub Actions → Telegram

Your lightweight server runs only the Telegram bot coordinator.  
All heavy work runs on GitHub Actions free runners.

---

## File structure

```
index.js                        ← Telegram coordinator bot
.github/
  workflows/worker.yml          ← GitHub Actions workflow
  scripts/worker.js             ← Worker that runs inside the Action
package.json
.env.example
```

---

## Setup

### 1. GitHub repo
Create a GitHub repo and push this code.

### 2. GitHub PAT
Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**

Create a token with:
- **Repository access**: your repo only
- **Permissions**:
  - `Actions` → Read & Write

Copy the token.

### 3. GitHub repo secrets
Go to your **repo → Settings → Secrets and variables → Actions → New repository secret**

Add these secrets:

| Secret name         | Value                                          |
|---------------------|------------------------------------------------|
| `TELEGRAM_API_ID`   | from https://my.telegram.org                   |
| `TELEGRAM_API_HASH` | from https://my.telegram.org                   |
| `TELEGRAM_SESSION`  | run `node scripts/gramjs-setup.js`, copy output |
| `BOT_TOKEN`         | your Telegram bot token                        |
| `GROQ_API_KEY`      | from https://console.groq.com                  |

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
You → send GDrive link to bot (supports multiple links in one message)
Bot → calls GitHub API to trigger worker.yml
      (passes file_ids, chat_id, job_id as inputs)

GitHub Actions runner:
  1. npm install
  2. Downloads files from GDrive in parallel
  3. Extracts ZIPs if needed
  4. AI renames files via Groq
  5. Uploads each video to Telegram via gramjs
  6. Reports completion back to bot

Your server: updates the Telegram status message
```

---

## Commands

Inline keyboard buttons:

| Button        | What it does                              |
|---------------|-------------------------------------------|
| Run Debug     | Check all env vars and GitHub connectivity|
| Active Jobs   | List local and GitHub Actions jobs        |
| Cancel Latest | Cancel the most recent running job        |

Send a Google Drive link to start processing.

---

## Limits (GitHub free tier)
- 2,000 minutes/month (free for public repos: unlimited)
- 6-hour max per job
- 14GB disk on runner

For high volume: make the repo **public**. Secrets stay private.
