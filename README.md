# 🎙️ Zoom AI Interpreter Bot

**EN → FR simultaneous interpretation bot — Recall.ai + OpenAI (Whisper + GPT-4o + TTS)**

The bot joins your Zoom meeting as a participant called "AI Interpreter 🇫🇷", listens to English speech, translates with GPT-4o, and speaks natural French audio back into the interpreter channel — all in real time. Just two API keys are needed.

---

## How it works

```text
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
WEBHOOK_URL=https://your-ngrok-or-vercel-url.com
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

## Deployment options

### Vercel
1. Push this repository to GitHub.
2. In Vercel, import the repository and deploy it.
3. Add these environment variables in Vercel Project Settings:
   - RECALL_API_KEY
   - OPENAI_API_KEY
   - WEBHOOK_URL
   - PORT

4. Start the app locally with:
   - npm install
   - npm run dev

### Railway
1. Go to railway.app → New Project → Deploy from GitHub repo
2. Select the repository
3. Add the same environment variables in the Railway dashboard

---

## Using the bot in a Zoom meeting

1. **Host enables interpretation** — Zoom meeting → More → Language Interpretation → Enable → add French channel
2. **Send the bot** — paste meeting URL in the dashboard → click "Send bot into meeting"
3. **Assign the AI interpreter** — the host should move "AI Interpreter 🇫🇷" into the French interpreter channel in Zoom's interpretation settings.
4. **Bot interprets live** — the bot listens in English, displays captions, and speaks French audio into the interpreter room.

---

## Troubleshooting

**Bot doesn't join** → check RECALL_API_KEY and that the Zoom meeting is active.
**No interpreter assignment** → confirm the host has moved the bot into the French interpreter channel.

**No transcripts** → check ngrok is running and WEBHOOK_URL is correct in .env

**No French audio** → test with the dashboard translation button first; check OPENAI_API_KEY has TTS access

**Poor translation quality** → switch to the technical or conference register for specialist meetings
