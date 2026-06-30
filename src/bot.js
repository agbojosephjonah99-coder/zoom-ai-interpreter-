/**
 * Zoom AI Interpreter Bot
 * Stack: Recall.ai (join/audio) → OpenAI Whisper (STT) → GPT-4o (translate) → OpenAI TTS (speak) → Recall.ai (inject)
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── State ────────────────────────────────────────────────────────────────────
let botState = {
  status: 'idle',        // idle | joining | listening | interpreting | error
  botId: null,
  meetingUrl: null,
  sourceLanguage: 'en',
  targetLanguage: 'fr',
  register: 'formal',
  voice: 'alloy',        // OpenAI TTS voice
  lastTranslation: '',
  sessionLog: [],
  totalTranslations: 0,
};

function emit(event, data) { io.emit(event, data); }

function updateStatus(status, message) {
  botState.status = status;
  emit('status', { status, message, timestamp: new Date().toISOString() });
  console.log(`[${status.toUpperCase()}] ${message}`);
}

function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}

function getMissingEnvVars() {
  const missing = [];
  if (!process.env.RECALL_API_KEY || process.env.RECALL_API_KEY.includes('your_') || process.env.RECALL_API_KEY.includes('your-recall')) {
    missing.push('RECALL_API_KEY');
  }
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.includes('your_') || process.env.OPENAI_API_KEY.includes('your-openai')) {
    missing.push('OPENAI_API_KEY');
  }
  if (!process.env.WEBHOOK_URL || process.env.WEBHOOK_URL.includes('your-domain') || process.env.WEBHOOK_URL.includes('example.com')) {
    missing.push('WEBHOOK_URL');
  }
  return missing;
}

// ── Recall.ai ────────────────────────────────────────────────────────────────
async function createBot(meetingUrl) {
  const res = await fetchWithTimeout('https://us-west-2.recall.ai/api/v1/bot/', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${process.env.RECALL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      meeting_url: meetingUrl,
      bot_name: 'AI Interpreter 🇫🇷',
      real_time_transcription: {
        destination_url: `${process.env.WEBHOOK_URL}/webhook/transcript`,
        partial_results: false,
      },
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Recall.ai bot creation failed: ${err}`);
  }
  return res.json();
}

async function getBotStatus(botId) {
  const res = await fetchWithTimeout(`https://us-west-2.recall.ai/api/v1/bot/${botId}/`, {
    headers: { 'Authorization': `Token ${process.env.RECALL_API_KEY}` }
  });
  return res.json();
}

async function sendAudioToBot(botId, audioBase64) {
  const res = await fetchWithTimeout(`https://us-west-2.recall.ai/api/v1/bot/${botId}/output_audio/`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${process.env.RECALL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ b64_data: audioBase64, kind: 'mp3' })
  });
  return res.ok;
}

async function stopBot(botId) {
  await fetchWithTimeout(`https://us-west-2.recall.ai/api/v1/bot/${botId}/leave_call/`, {
    method: 'POST',
    headers: { 'Authorization': `Token ${process.env.RECALL_API_KEY}` }
  });
}

// ── OpenAI: Translate with GPT-4o ────────────────────────────────────────────
async function translateWithGPT(text) {
  const registerNote = {
    formal:    'Use formal vous-form French suitable for professional meetings. Preserve speaker intent exactly.',
    neutral:   'Use natural, neutral French.',
    technical: 'Use technical/conference register. Preserve all terminology, acronyms, and proper nouns exactly.',
  }[botState.register] || '';

  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1024,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `You are a professional simultaneous interpreter from English to French. ${registerNote} Output ONLY the French translation — no preamble, no notes, no quotation marks.`
        },
        { role: 'user', content: text }
      ]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GPT-4o translation failed: ${err}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ── OpenAI: Text-to-Speech ────────────────────────────────────────────────────
async function synthesizeFrench(frenchText) {
  const res = await fetchWithTimeout('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',           // or tts-1-hd for higher quality
      input: frenchText,
      voice: botState.voice,    // alloy | echo | fable | onyx | nova | shimmer
      response_format: 'mp3',
      speed: 0.95,
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI TTS failed: ${err}`);
  }
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// ── Core pipeline: transcript → translate → speak ─────────────────────────────
async function handleTranscript(speakerName, text) {
  if (!text || text.trim().length < 3) return;

  updateStatus('interpreting', `Translating: "${text.slice(0, 60)}…"`);
  emit('transcript', { speaker: speakerName, text, timestamp: new Date().toISOString() });

  try {
    // 1. Translate with GPT-4o
    const frenchText = await translateWithGPT(text);
    botState.lastTranslation = frenchText;
    botState.totalTranslations++;

    emit('translation', {
      english: text,
      french: frenchText,
      speaker: speakerName,
      timestamp: new Date().toISOString()
    });

    // 2. Synthesize French audio with OpenAI TTS
    const audioBase64 = await synthesizeFrench(frenchText);

    // 3. Inject audio back into meeting via Recall.ai
    if (botState.botId) {
      await sendAudioToBot(botState.botId, audioBase64);
    }

    // 4. Log session
    botState.sessionLog.unshift({ english: text, french: frenchText, speaker: speakerName, ts: new Date().toISOString() });
    if (botState.sessionLog.length > 50) botState.sessionLog.pop();

    updateStatus('listening', 'Listening for speech…');
    emit('stats', { total: botState.totalTranslations, log: botState.sessionLog.slice(0, 10) });

  } catch (err) {
    console.error('Pipeline error:', err);
    updateStatus('error', `Error: ${err.message}`);
    setTimeout(() => updateStatus('listening', 'Listening for speech…'), 3000);
  }
}

// ── Webhook: receive transcripts from Recall.ai ───────────────────────────────
app.post('/webhook/transcript', (req, res) => {
  res.sendStatus(200);
  const { transcript } = req.body || {};
  if (!transcript) return;
  const { speaker, words } = transcript;
  const text = words?.map(w => w.text).join(' ').trim();
  if (text) handleTranscript(speaker || 'Speaker', text);
});

// ── REST API ──────────────────────────────────────────────────────────────────
app.post('/api/join', async (req, res) => {
  const { meetingUrl, register, sourceLanguage, voice } = req.body;
  if (!meetingUrl) return res.status(400).json({ error: 'meetingUrl required' });
  if (botState.botId) return res.status(400).json({ error: 'Bot already active' });

  botState.meetingUrl = meetingUrl;
  botState.register = register || 'formal';
  botState.sourceLanguage = sourceLanguage || 'en';
  botState.voice = voice || 'alloy';
  botState.totalTranslations = 0;
  botState.sessionLog = [];

  const missingEnv = getMissingEnvVars();
  if (missingEnv.length) {
    const message = `Missing or placeholder environment values: ${missingEnv.join(', ')}. Set them in .env or Vercel and restart the app.`;
    updateStatus('error', message);
    return res.status(500).json({ error: message });
  }

  try {
    updateStatus('joining', 'Sending bot into meeting…');
    const bot = await createBot(meetingUrl);
    botState.botId = bot.id;

    // Poll until bot is confirmed in the call
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      const status = await getBotStatus(botState.botId);
      const code = status.status_changes?.slice(-1)[0]?.code;
      if (code === 'in_call_not_recording' || code === 'in_call_recording') {
        clearInterval(poll);
        updateStatus('listening', 'Bot is in the meeting and listening…');
      } else if (code === 'fatal' || attempts > 30) {
        clearInterval(poll);
        updateStatus('error', 'Bot failed to join the meeting');
        botState.botId = null;
      }
    }, 3000);

    res.json({ success: true, botId: bot.id });
  } catch (err) {
    updateStatus('error', err.message);
    botState.botId = null;
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leave', async (req, res) => {
  if (!botState.botId) return res.status(400).json({ error: 'No active bot' });
  try {
    await stopBot(botState.botId);
    botState.botId = null;
    updateStatus('idle', 'Bot has left the meeting');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/state', (req, res) => res.json(botState));

// ── Test endpoint: translate + TTS without a live meeting ─────────────────────
app.post('/api/translate', async (req, res) => {
  const { text, register, voice } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  botState.register = register || botState.register;
  botState.voice = voice || botState.voice;
  try {
    const french = await translateWithGPT(text);
    const audioBase64 = await synthesizeFrench(french);
    res.json({ english: text, french, audioBase64 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  server.listen(PORT, () => console.log(`\n🎙️  Zoom Interpreter Bot running at http://localhost:${PORT}\n`));
}

module.exports = app;
