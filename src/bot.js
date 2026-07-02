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
  botName: process.env.BOT_NAME || 'AI Interpreter',
  sourceLanguage: 'en',
  targetLanguage: 'fr',
  register: 'formal',
  voice: 'alloy',        // OpenAI TTS voice
  translationModel: 'gpt-4o-mini',
  lastTranslation: '',
  sessionLog: [],
  totalTranslations: 0,
  joinPoller: null,
};

function emit(event, data) { io.emit(event, data); }

function updateStatus(status, message) {
  botState.status = status;
  emit('status', { status, message, timestamp: new Date().toISOString() });
  console.log(`[${status.toUpperCase()}] ${message}`);
}

function resetBotSession() {
  if (botState.joinPoller) {
    clearInterval(botState.joinPoller);
    botState.joinPoller = null;
  }
  botState.botId = null;
  botState.meetingUrl = null;
  botState.lastTranslation = '';
  botState.sessionLog = [];
  botState.totalTranslations = 0;
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

// A ~0.3s silent MP3, required as a placeholder so Recall.ai will treat the
// bot as audio-output-capable (unmuted) from the moment it joins. Without
// `automatic_audio_output` configured on Create Bot, (a) the Output Audio
// endpoint rejects every call, and (b) the bot joins fully muted, which is
// why Zoom's native Language Interpretation picker never lists it as an
// eligible interpreter — Zoom only shows audio-active participants there.
const SILENT_MP3_B64 = 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//NYwAAAAAAAAAAAAEluZm8AAAAPAAAACwAAAkAAYGBgYGBgYGBgcHBwcHBwcHBwgICAgICAgICAkJCQkJCQkJCQoKCgoKCgoKCgsLCwsLCwsLCwwMDAwMDAwMDA0NDQ0NDQ0NDQ4ODg4ODg4ODg8PDw8PDw8PDw////////////AAAAAExhdmM2MC4zMQAAAAAAAAAAAAAAACQDwAAAAAAAAAJAxO40NAAAAAAAAAAAAAAA//MYxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVV//MYxBcAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxC4AAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxEUAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxFwAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxHMAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxIoAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxKEAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxLgAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxM8AAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxOYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';

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
      bot_name: botState.botName || 'AI Interpreter',
      automatic_audio_output: {
        in_call_recording: {
          data: {
            kind: 'mp3',
            b64_data: SILENT_MP3_B64,
          },
        },
      },
      recording_config: {
        transcript: {
          provider: {
            recallai_streaming: {
              mode: 'prioritize_low_latency',
              language_code: botState.sourceLanguage || 'en',
            }
          },
          diarization: {
            use_separate_streams_when_available: true,
          }
        },
        realtime_endpoints: [
          {
            type: 'webhook',
            url: `${process.env.WEBHOOK_URL}/webhook/transcript`,
            events: ['transcript.data'],
          }
        ]
      }
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

// ── OpenAI: Translate with GPT ────────────────────────────────────────────
async function translateWithGPT(text) {
  const registerNote = {
    formal:    'Use formal vous-form French suitable for professional meetings. Preserve speaker intent exactly.',
    neutral:   'Use natural, neutral French.',
    technical: 'Use technical/conference register. Preserve all terminology, acronyms, and proper nouns exactly.',
  }[botState.register] || '';

  const model = process.env.OPENAI_TRANSLATION_MODEL || botState.translationModel;
  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      temperature: 0.0,
      top_p: 1,
      n: 1,
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
    const errText = await res.text();
    const message = errText.includes('invalid_api_key')
      ? 'OpenAI API key is invalid or missing in the deployed environment. Please set OPENAI_API_KEY in Vercel.'
      : `GPT-4o translation failed: ${errText}`;
    throw new Error(message);
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
    const errText = await res.text();
    const message = errText.includes('invalid_api_key')
      ? 'OpenAI API key is invalid or missing in the deployed environment. Please set OPENAI_API_KEY in Vercel.'
      : `OpenAI TTS failed: ${errText}`;
    throw new Error(message);
  }
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// ── Core pipeline: transcript → translate → speak ─────────────────────────────
async function handleTranscript(speakerName, text) {
  if (!text || text.trim().length < 3) return;

  updateStatus('interpreting', `Translating: "${text.slice(0, 60)}…"`);
  emit('transcript', { speaker: speakerName, text, timestamp: new Date().toISOString() });
  emit('caption', { text: 'Translating…', speaker: speakerName, timestamp: new Date().toISOString() });

  try {
    // 1. Translate with GPT
    const frenchText = await translateWithGPT(text);
    botState.lastTranslation = frenchText;
    botState.totalTranslations++;

    emit('translation', {
      english: text,
      french: frenchText,
      speaker: speakerName,
      timestamp: new Date().toISOString()
    });
    emit('caption', {
      text: frenchText,
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
function extractTranscriptPayload(payload) {
  const queue = [payload];
  const seen = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const transcript = current?.transcript || current?.data?.transcript || current?.payload?.transcript || current?.data?.data?.transcript || current?.data?.payload?.transcript || current?.payload?.data?.transcript;
    if (transcript && (Array.isArray(transcript.words) || transcript?.speaker || transcript?.participant || typeof transcript?.text === 'string' || Array.isArray(transcript?.data?.words))) {
      const words = Array.isArray(transcript.words)
        ? transcript.words
        : (Array.isArray(transcript?.data?.words) ? transcript.data.words : []);
      const text = words
        .map(word => (typeof word === 'string' ? word : word?.text || word?.word))
        .filter(Boolean)
        .join(' ')
        .trim();
      const directText = typeof transcript?.text === 'string' ? transcript.text.trim() : '';
      const speaker = transcript.speaker || transcript.participant?.name || transcript.participant?.id || 'Speaker';
      return { speaker, text: text || directText || (typeof transcript?.data?.text === 'string' ? transcript.data.text.trim() : '') };
    }

    if (current?.words || current?.speaker || current?.participant || typeof current?.text === 'string') {
      const words = Array.isArray(current.words)
        ? current.words
        : (Array.isArray(current?.data?.words) ? current.data.words : []);
      const text = words
        .map(word => (typeof word === 'string' ? word : word?.text || word?.word))
        .filter(Boolean)
        .join(' ')
        .trim();
      const directText = typeof current?.text === 'string' ? current.text.trim() : '';
      const speaker = current.speaker || current.participant?.name || current.participant?.id || 'Speaker';
      if (text || directText) {
        return { speaker, text: text || directText || (typeof current?.data?.text === 'string' ? current.data.text.trim() : '') };
      }
    }

    queue.push(current?.data, current?.payload, current?.content, current?.result);
  }

  return null;
}

app.post('/webhook/transcript', (req, res) => {
  res.sendStatus(200);
  void (async () => {
    try {
      const payload = req.body || {};
      const extracted = extractTranscriptPayload(payload);

      if (!extracted?.text) {
        console.log('[WEBHOOK] No transcript text found in payload:', JSON.stringify(payload).slice(0, 2000));
        return;
      }

      await handleTranscript(extracted.speaker || 'Speaker', extracted.text);
    } catch (err) {
      console.error('Webhook processing failed:', err);
    }
  })();
});

// ── REST API ──────────────────────────────────────────────────────────────────
app.post('/api/join', async (req, res) => {
  const { meetingUrl, register, sourceLanguage, voice, botName } = req.body;
  if (!meetingUrl) return res.status(400).json({ error: 'meetingUrl required' });
  if (botState.botId || botState.status === 'joining' || botState.status === 'listening' || botState.status === 'interpreting') {
    return res.status(400).json({ error: 'Bot already active or joining' });
  }

  botState.meetingUrl = meetingUrl;
  botState.register = register || 'formal';
  botState.sourceLanguage = sourceLanguage || 'en';
  botState.voice = voice || 'alloy';
  botState.botName = botName || process.env.BOT_NAME || 'AI Interpreter';
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
    botState.joinPoller = setInterval(async () => {
      if (!botState.botId) return;
      attempts++;
      try {
        const status = await getBotStatus(botState.botId);
        const code = status.status_changes?.slice(-1)[0]?.code;
        if (code === 'in_call_not_recording' || code === 'in_call_recording') {
          clearInterval(botState.joinPoller);
          botState.joinPoller = null;
          updateStatus('listening', 'Bot is in the meeting and listening…');
        } else if (code === 'fatal' || attempts > 30) {
          clearInterval(botState.joinPoller);
          botState.joinPoller = null;
          updateStatus('error', 'Bot failed to join the meeting');
          resetBotSession();
        }
      } catch (err) {
        clearInterval(botState.joinPoller);
        botState.joinPoller = null;
        updateStatus('error', `Bot status check failed: ${err.message}`);
        resetBotSession();
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
  const hasActiveBot = Boolean(botState.botId || botState.joinPoller || botState.status !== 'idle');
  if (!hasActiveBot) {
    resetBotSession();
    updateStatus('idle', 'Bot has left the meeting');
    return res.json({ success: true, alreadyInactive: true });
  }

  try {
    const botId = botState.botId;
    if (botId) {
      void stopBot(botId).catch((err) => {
        console.error('Recall leave request failed:', err);
      });
    }

    resetBotSession();
    updateStatus('idle', 'Bot has left the meeting');
    res.json({ success: true });
  } catch (err) {
    resetBotSession();
    updateStatus('error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Force remove the bot from the meeting (useful when normal leave fails)
app.post('/api/force_leave', async (req, res) => {
  try {
    const botId = botState.botId;
    if (botId) {
      try {
        await stopBot(botId);
      } catch (err) {
        console.error('Force leave: stopBot failed:', err?.message || err);
      }
    }

    resetBotSession();
    updateStatus('idle', 'Bot has been forcefully removed from the meeting');
    return res.json({ success: true, forced: true });
  } catch (err) {
    console.error('Force leave failed:', err);
    updateStatus('error', `Force leave failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
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
module.exports.extractTranscriptPayload = extractTranscriptPayload;