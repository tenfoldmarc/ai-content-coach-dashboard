---
name: content-coach
description: Set up and run the AI Content Coach dashboard. Walks through full installation — dependencies, Apify connection, Instagram handles, and server launch. Trigger with /content-coach
---

# AI Content Coach — Setup & Run

## Trigger
User types `/content-coach` or `/content-coach setup`

## What This Does
Walks the user through setting up the AI Content Coach dashboard — a local intelligence tool that scrapes their Instagram posts and competitors, transcribes reels, and gives them a Claude-powered chat interface for content strategy.

---

## STEP 1 — Welcome

Tell the user:

> "Let's get your AI Content Coach dashboard running. I'll walk you through every step — this takes about 10 minutes. You'll need:
> - Node.js installed
> - A free Apify account (for Instagram scraping)
> - Python 3 (for video transcription)
> - Your Instagram handle + 3–5 competitors to track"

Ask: "Ready? Where did you clone the repo? (Paste the full folder path)"

Save this as REPO_DIR. All commands below run from this directory.

---

## STEP 2 — Check Prerequisites

Run all checks in parallel. For each failure, provide the exact install command.

### Node.js (v18+)
```bash
node --version
```
If missing or < v18: `brew install node` (Mac) or direct them to nodejs.org

### Python 3
```bash
python3 --version
```
If missing: `brew install python3` (Mac) or python.org

### ffmpeg (required by yt-dlp and Whisper)
```bash
ffmpeg -version
```
If missing: `brew install ffmpeg`

### yt-dlp (downloads Instagram reels)
```bash
yt-dlp --version
```
If missing:
```bash
pip3 install yt-dlp
```
After installing, find the binary path:
```bash
which yt-dlp || python3 -m site --user-base
```

### Whisper (transcribes reels to text)
```bash
python3 -c "import whisper; print('Whisper OK')"
```
If missing:
```bash
pip3 install openai-whisper
```
Note: Whisper downloads a ~150MB model on first run. The `base` model is fast enough for this use case.

After all prerequisites pass, tell the user which ones you installed and confirm everything is green.

---

## STEP 3 — Claude Auth Method

Ask:

> "How are you running Claude Code?
>
> **A)** I have an Anthropic API key (from console.anthropic.com)
> **B)** I use a Claude.ai subscription (the $20/month plan)
>
> Type A or B."

**If A (API key):**
Ask them to paste their API key. Add to `.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
```
Tell them: "The server will use your API key directly — no extra setup needed."

**If B (Claude subscription):**
Tell them: "The server routes through your installed Claude Code — no API key needed. The chat just works."
Do NOT add anything to `.env` for auth.

---

## STEP 4 — Instagram Handle

Ask:

> "What's your Instagram handle? (no @ symbol, just the username)"

Example: `tenfoldmarc`

Save as YOUR_HANDLE.

---

## STEP 5 — Competitor Handles

Ask:

> "Give me 3–5 competitor Instagram handles you want to spy on. These are accounts in your niche you want to benchmark against.
>
> List them one per line or comma-separated. (no @ symbols)"

Example:
```
chase.h.ai
noevarner.ai
mattganzak
agentic.james
```

Save as COMPETITORS list.

---

## STEP 6 — Apify Token

Ask:

> "Now we need your Apify token — this is what scrapes Instagram for you.
>
> 1. Go to **apify.com** and create a free account
> 2. In your Apify dashboard → Settings → API tokens
> 3. Copy your **Personal API token**
> 4. Paste it here"

Add to `.env`:
```
APIFY_TOKEN=apify_api_...
```

Tell them: "Apify charges ~$0.002–0.006 per profile scraped. Pulling 25 posts from 5 accounts costs about $0.03."

---

## STEP 7 — Write Config Files

### Create `config.json` in REPO_DIR:
```json
{
  "yourHandle": "YOUR_HANDLE",
  "yourName": "Their Name",
  "postsPerAccount": 25,
  "competitors": [
    { "handle": "competitor1", "name": "Competitor 1 Name", "pattern": "" },
    { "handle": "competitor2", "name": "Competitor 2 Name", "pattern": "" }
  ]
}
```

Fill in their actual handles. For "name" fields, use the handle as the name for now (they can update it).
For "pattern" — leave empty string. It gets populated by Claude's analysis after the first data fetch.

### Confirm `.env` has:
```
APIFY_TOKEN=apify_api_...
# Only if they chose option A:
ANTHROPIC_API_KEY=sk-ant-...
```

---

## STEP 8 — Install Node Dependencies

```bash
cd REPO_DIR && npm install
```

Confirm it completed without errors.

---

## STEP 9 — Find Tool Paths

Run these to find exact binary paths (needed for transcription):
```bash
which yt-dlp || python3 -m site --user-base
which whisper || python3 -c "import whisper; import os; print(os.path.dirname(whisper.__file__))"
which ffmpeg
```

These paths get written into `config.json` automatically by the next step. Tell the user: "Found your tools — locking in the paths so the scraper always knows where they are."

Update `config.json` to add:
```json
{
  "tools": {
    "ytdlp": "/path/to/yt-dlp",
    "whisper": "/path/to/whisper",
    "ffmpeg": "/path/to/ffmpeg",
    "whisperModel": "base"
  }
}
```

---

## STEP 10 — Initial Data Fetch

Tell the user: "Now scraping your last 25 posts + all competitors. This takes 2–4 minutes. Don't close the terminal."

```bash
cd REPO_DIR && node fetch-data.js
```

Watch for output. If it errors:
- `APIFY_TOKEN not found` → check `.env` file
- `Apify run failed` → check token is valid at apify.com
- `yt-dlp` errors → some reels may be private, that's OK, they get skipped

When complete, confirm: "X posts saved from your account, Y posts saved from Z competitors. Transcriptions complete."

---

## STEP 11 — Start the Server

```bash
cd REPO_DIR && node server.js
```

Then open the browser:
```bash
open http://localhost:3003
```

Tell the user:

> "Your AI Content Coach is live at http://localhost:3003
>
> Every time you want fresh data, run: `node fetch-data.js`
> Every time you want to open the dashboard, run: `node server.js`
>
> The AI chat in the dashboard is trained on ALL your saved posts — the more you run fetch-data.js, the smarter it gets."

---

## Error Handling

- **Port 3003 in use**: Tell them to run `node server.js -- --port 3004` or kill the process using `lsof -i :3003`
- **Instagram scrape returns 0 posts**: Some accounts have rate limiting. Tell them to wait 30 min and retry.
- **Whisper model download**: First run downloads ~150MB. Tell them it's a one-time thing.
- **Private Instagram account**: yt-dlp needs Instagram cookies for private accounts. Skip transcription for private accounts, metadata-only still works via Apify.

---

## Ongoing Commands

After setup, when user types `/content-coach`:
- If dashboard isn't running: start it (`node server.js && open http://localhost:3003`)
- If they want fresh data: run `node fetch-data.js` then restart server
- If they want to add a competitor: update `config.json` then re-run fetch
