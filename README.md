# 🎙️ Zoom AI Interpreter Bot
**EN → FR simultaneous interpretation bot — Recall.ai + OpenAI (Whisper + GPT-4o + TTS)**

The bot joins your Zoom meeting as a participant called "AI Interpreter 🇫🇷", listens to English speech, translates with GPT-4o, and speaks natural French audio back into the interpreter channel — all in real time. Just **two API keys** needed.

---

## How it works

```
Speaker talks (English)
        ↓
Recall.ai bot captures audio in meeting
        ↓
OpenAI Whisper converts speech → text (~300ms)
        ↓
GPT-4o translates English → French
        ↓
OpenAI TTS converts French text → audio
        ↓
Recall.ai injects French audio back into meeting
        ↓
French channel attendees hear interpretation
```

---

## Prerequisites

| Service | Purpose | Link |
|---|---|---|
| **Recall.ai** | Bot joins Zoom & captures audio | recall.ai |
| **OpenAI** | Whisper STT + GPT-4o translation + TTS | platform.openai.com |
| **ngrok** | Public webhook URL (local dev only) | ngrok.com (free) |

**That's it — just two API keys.**

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables
```bash
cp .env.example .env
```

Fill in `.env`:
```env
RECALL_API_KEY=your_recall_api_key
OPENAI_API_KEY=your_openai_api_key
WEBHOOK_URL=https://your-ngrok-or-railway-url.com
PORT=3000
```

### 3. Run ngrok (local dev only)
```bash
ngrok http 3000
# copy the https URL → paste as WEBHOOK_URL in .env
```

### 4. Start the server
```bash
npm start
# open http://localhost:3000
```

---

## GitHub → Railway deployment

### Push to GitHub
```bash
git init
git add .
git commit -m "feat: zoom interpreter bot"
git remote add origin https://github.com/YOUR_USERNAME/zoom-interpreter-bot.git
git push -u origin main
```

### Deploy on Railway
1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Select `zoom-interpreter-bot`
3. Add environment variables in Railway dashboard:
   ```
   RECALL_API_KEY=...
   OPENAI_API_KEY=...
   WEBHOOK_URL=https://your-app.up.railway.app
   PORT=3000
   ```
4. Add `RAILWAY_TOKEN` to GitHub repo Secrets for auto-deploy on push

**After setup, every `git push` to `main` auto-deploys. No ngrok needed.**

---

## Using the bot in a Zoom meeting

1. **Host enables interpretation** — Zoom meeting → More → Language Interpretation → Enable → add French channel
2. **Send the bot** — paste meeting URL in dashboard → click "Send bot into meeting"
3. **Move bot to interpreter slot** — host moves "AI Interpreter 🇫🇷" to the French interpreter channel
4. **Bot interprets live** — listens in English, speaks French automatically

---

## OpenAI voice options

| Voice | Character |
|---|---|
| `alloy` | Neutral, clear (default) |
| `nova` | Warm, natural |
| `shimmer` | Soft, expressive |
| `echo` | Smooth, steady |
| `fable` | Authoritative |
| `onyx` | Deep, rich |

Switch voice in the dashboard before sending the bot in. Use `tts-1-hd` in `bot.js` for higher audio quality (costs ~2× more).

---

## Cost estimate (OpenAI only, per meeting hour)

| API | Usage | Cost |
|---|---|---|
| Whisper STT | ~60 min audio | ~$0.36 |
| GPT-4o translation | ~10K tokens | ~$0.05 |
| TTS | ~5K chars French | ~$0.075 |
| **Total** | | **~$0.49/hr** |

---

## File structure

```
zoom-interpreter-bot/
├── src/
│   └── bot.js              ← Main server + full pipeline
├── public/
│   └── index.html          ← Control dashboard
├── .github/
│   └── workflows/
│       └── deploy.yml      ← Auto-deploy to Railway on push
├── .env.example            ← Environment template (safe to commit)
├── .gitignore              ← Keeps .env out of GitHub
├── railway.json            ← Railway deployment config
├── Procfile                ← Render/Heroku compatibility
├── package.json
└── README.md
```

---

## Troubleshooting

**Bot doesn't join** → check `RECALL_API_KEY` and that the Zoom meeting is active

**No transcripts** → check ngrok is running and `WEBHOOK_URL` is correct in `.env`

**No French audio** → test with dashboard "Test translation" button first; check `OPENAI_API_KEY` has TTS access

**Poor translation quality** → switch to "Technical / conference" register for specialist meetings
