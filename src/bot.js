/**
 * Zoom AI Interpreter Bot
 * Stack: Recall.ai (join/audio) → OpenAI Whisper (STT) → GPT-4o (translate) → OpenAI TTS (speak) → Recall.ai (inject)
 */

const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');
require('dotenv').config();

const app = express();

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
  // Interpreter-assignment nudges: the host still has to manually move the
  // bot into the French interpretation channel (Zoom gives us no API to do
  // this for them — see README). These flags make sure we (a) remind them
  // exactly once as soon as the bot is in the call, and (b) warn once if a
  // while has passed with no translations, which usually means the
  // assignment step got missed.
  assignmentReminderSent: false,
  assignmentWarningSent: false,
  assignmentCheckTimer: null,
};

// How long to wait after the bot starts listening before checking whether
// interpretation seems to be flowing. If nothing has been translated by
// then, it's a reasonable signal the host forgot to assign the French
// channel (or no one has spoken yet — the warning is phrased accordingly).
const ASSIGNMENT_CHECK_DELAY_MS = 3 * 60 * 1000;

function emit(event, data) { pushEvent(event, data); }

function updateStatus(status, message) {
  botState.status = status;
  pushEvent('status', { status, message, timestamp: new Date().toISOString() });
  console.log(`[${status.toUpperCase()}] ${message}`);
}

function resetBotSession() {
  if (botState.joinPoller) {
    clearInterval(botState.joinPoller);
    botState.joinPoller = null;
  }
  if (botState.assignmentCheckTimer) {
    clearTimeout(botState.assignmentCheckTimer);
    botState.assignmentCheckTimer = null;
  }
  botState.botId = null;
  botState.meetingUrl = null;
  botState.lastTranslation = '';
  botState.sessionLog = [];
  botState.totalTranslations = 0;
  botState.assignmentReminderSent = false;
  botState.assignmentWarningSent = false;
}

// Fires once per session, the moment the bot is confirmed in the call:
// (1) a dashboard banner reminding the host to assign the bot to the
//     French interpreter channel, and (2) a best-effort chat message doing
//     the same inside Zoom itself. It also arms a one-shot timer that warns
//     if no translations have happened after a few minutes — the most
//     reliable proxy we have for "the assignment step got missed", since
//     Zoom doesn't expose interpreter-channel status via webhook.
function notifyAssignmentStepIfNeeded() {
  if (botState.assignmentReminderSent) return;
  botState.assignmentReminderSent = true;

  const reminder = isSignedInBotConfigured()
    ? `Assign the bot to the French channel now: Interpretation icon → Add Interpreter → search for "${botState.botName}" (or the connected Zoom account name if it doesn't show).`
    : `Assign "${botState.botName}" to the French channel now — note: if it doesn't appear in the search, this Zoom account isn't signed in (see README → Signed-in bot setup).`;
  pushEvent('assignment_reminder', { message: reminder, timestamp: new Date().toISOString() });

  if (botState.botId) {
    void sendChatMessage(
      botState.botId,
      `👋 I'm listening. Please open Language Interpretation and assign me ("${botState.botName}") to the French channel so I can speak.`
    );
  }

  if (botState.assignmentCheckTimer) clearTimeout(botState.assignmentCheckTimer);
  botState.assignmentCheckTimer = setTimeout(() => {
    botState.assignmentCheckTimer = null;
    if (botState.assignmentWarningSent) return;
    if (botState.status === 'idle' || botState.status === 'error') return;
    if (botState.totalTranslations > 0) return; // interpretation is flowing — no warning needed

    botState.assignmentWarningSent = true;
    const warning = 'No French audio has gone out yet. If no one has spoken, this is expected — otherwise, double-check the bot was assigned to the French interpreter channel.';
    pushEvent('assignment_warning', { message: warning, timestamp: new Date().toISOString() });
    console.log(`[ASSIGNMENT CHECK] ${warning}`);
  }, ASSIGNMENT_CHECK_DELAY_MS);
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

// ── Zoom signed-in bots (ZAK) ──────────────────────────────────────────────
// By default, Recall.ai bots join Zoom as anonymous guests. Zoom's
// "Add interpreter" search box in the Language Interpretation panel only
// lists participants who are signed into a real Zoom account — anonymous
// guests never appear there, no matter what the host searches. Recall.ai's
// fix is a "signed-in bot": we give it a Zoom ZAK token (a short-lived token
// tied to a real Zoom account) via `zoom.zak_url` on bot creation, and Recall
// re-fetches it from that URL for the life of the call. See:
// https://docs.recall.ai/docs/zoom-signed-in-bots
//
// We use Recall's own OAuth-credential storage (rather than storing Zoom's
// rotating refresh token ourselves) so this works cleanly on stateless
// deployments like Vercel — see README for the one-time setup steps.
function isSignedInBotConfigured() {
  return Boolean(
    process.env.RECALL_ZOOM_CREDENTIAL_ID &&
    process.env.ZOOM_OAUTH_CLIENT_ID &&
    process.env.ZOOM_OAUTH_CLIENT_SECRET
  );
}

function zoomOAuthRedirectUri() {
  return process.env.ZOOM_OAUTH_REDIRECT_URI || `${process.env.WEBHOOK_URL || ''}/auth/zoom/callback`;
}

// A ~0.3s silent MP3, required as a placeholder so Recall.ai treats the bot
// as audio-output-capable from the moment it joins. Without
// `automatic_audio_output` set on Create Bot, Recall's Output Audio endpoint
// (used by sendAudioToBot below) rejects every call — this is Bug A.
const SILENT_MP3_B64 = 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//NYwAAAAAAAAAAAAEluZm8AAAAPAAAACwAAAkAAYGBgYGBgYGBgcHBwcHBwcHBwgICAgICAgICAkJCQkJCQkJCQoKCgoKCgoKCgsLCwsLCwsLCwwMDAwMDAwMDA0NDQ0NDQ0NDQ4ODg4ODg4ODg8PDw8PDw8PDw////////////AAAAAExhdmM2MC4zMQAAAAAAAAAAAAAAACQDwAAAAAAAAAJAxO40NAAAAAAAAAAAAAAA//MYxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVV//MYxBcAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxC4AAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxEUAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxFwAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxHMAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxIoAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxKEAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxLgAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxM8AAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxOYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';

// ── Recall.ai ────────────────────────────────────────────────────────────────
async function createBot(meetingUrl) {
  const body = {
    meeting_url: meetingUrl,
    bot_name: botState.botName || 'AI Interpreter',
    automatic_audio_output: {
      in_call_recording: {
        data: { kind: 'mp3', b64_data: SILENT_MP3_B64 },
      },
    },
    zoom: {
      ...(body.zoom || {}),
      interpreter_audio: true,
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
  };

  // Signed-in bot: makes the bot show up in Zoom's "Add interpreter" search
  // (anonymous guest bots never do — see isSignedInBotConfigured above).
  if (isSignedInBotConfigured()) {
    body.zoom = { zak_url: `${process.env.WEBHOOK_URL}/webhook/zak` };
  }

  const res = await fetchWithTimeout('https://us-west-2.recall.ai/api/v1/bot/', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${process.env.RECALL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body)
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
  // Send to interpreter channel specifically
  const res = await fetchWithTimeout(`https://us-west-2.recall.ai/api/v1/bot/${botId}/output_audio/`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${process.env.RECALL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      b64_data: audioBase64,
      kind: 'mp3',
      interpreter_audio: true,
    })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('[AUDIO] sendAudioToBot failed:', err);
  }
  return res.ok;
}

// Best-effort chat nudge so the host sees the assignment instructions right
// inside the Zoom chat, not just on the dashboard. This is a "nice to have":
// if the Recall.ai plan/API doesn't support chat messages, or the call
// fails for any reason, we swallow the error — it should never break the
// interpretation pipeline.
async function sendChatMessage(botId, message) {
  try {
    const res = await fetchWithTimeout(`https://us-west-2.recall.ai/api/v1/bot/${botId}/send_chat_message/`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.RECALL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message })
    });
    if (!res.ok) {
      console.log('[CHAT] Could not send in-meeting chat nudge:', await res.text());
    }
  } catch (err) {
    console.log('[CHAT] Chat nudge failed (non-fatal):', err.message);
  }
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
  // Use longer timeout for TTS
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
      speed: 1.0,
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
  if (!text || text.trim().length < 2) return;

  updateStatus('interpreting', `Translating: "${text.slice(0, 60)}…"`);
  pushEvent('transcript', { speaker: speakerName, text, timestamp: new Date().toISOString() });
  pushEvent('caption', { text: 'Translating…', speaker: speakerName, timestamp: new Date().toISOString() });

  try {
    // 1. Translate with GPT
    const frenchText = await translateWithGPT(text);
    botState.lastTranslation = frenchText;
    botState.totalTranslations++;

    // First confirmed translation of the session — the assignment clearly
    // worked, so clear out any reminder/warning banners still showing.
    if (botState.totalTranslations === 1) {
      if (botState.assignmentCheckTimer) {
        clearTimeout(botState.assignmentCheckTimer);
        botState.assignmentCheckTimer = null;
      }
      pushEvent('assignment_resolved', {});
    }

    pushEvent('translation', {
      english: text,
      french: frenchText,
      speaker: speakerName,
      timestamp: new Date().toISOString()
    });
    pushEvent('caption', {
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
    pushEvent('stats', { total: botState.totalTranslations, log: botState.sessionLog.slice(0, 10) });

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

// ── Webhook: bot status changes (replaces polling — configure this URL in the
// Recall Dashboard → Webhooks tab, e.g. https://your-app.vercel.app/webhook/status)
app.post('/webhook/status', (req, res) => {
  res.sendStatus(200);
  try {
    const { event, data } = req.body || {};
    const botId = data?.bot?.id;
    const code = data?.data?.code;
    if (!botId || botId !== botState.botId) return; // ignore events for other/old bots

    if (code === 'in_call_not_recording' || code === 'in_call_recording') {
      updateStatus('listening', 'Bot is in the meeting and listening…');
      notifyAssignmentStepIfNeeded();
    } else if (code === 'fatal') {
      updateStatus('error', 'Bot failed to join the meeting');
      resetBotSession();
    } else if (code === 'call_ended' || code === 'done') {
      updateStatus('idle', 'Bot has left the meeting');
      resetBotSession();
    } else {
      console.log(`[STATUS WEBHOOK] ${event}: ${code}`);
    }
  } catch (err) {
    console.error('Status webhook processing failed:', err);
  }
});

// ── Zoom signed-in bot setup (one-time OAuth flow — see README) ────────────
// Visit /auth/zoom/start once, in a browser, signed into the dedicated Zoom
// account you want your bot to authenticate as. It walks through Zoom's
// OAuth consent, hands the resulting code to Recall (which stores and
// rotates the underlying refresh token for us), and prints a
// RECALL_ZOOM_CREDENTIAL_ID for you to copy into your env vars.
app.get('/auth/zoom/start', (req, res) => {
  if (!process.env.ZOOM_OAUTH_CLIENT_ID) {
    return res.status(500).send('ZOOM_OAUTH_CLIENT_ID is not set. See README → Signed-in bot setup.');
  }
  const url = new URL('https://zoom.us/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.ZOOM_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', zoomOAuthRedirectUri());
  url.searchParams.set('scope', 'user:read:zak user:read:user meeting:read:list_meetings meeting:read:local_recording_token');
  res.redirect(url.toString());
});

app.get('/auth/zoom/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Zoom returned an error: ${error}`);
  if (!code) return res.status(400).send('Missing ?code= from Zoom.');

  try {
    const missing = ['RECALL_API_KEY', 'RECALL_ZOOM_OAUTH_APP_ID'].filter(k => !process.env[k]);
    if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);

    const credRes = await fetchWithTimeout('https://us-west-2.recall.ai/api/v2/zoom-oauth-credentials/', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.RECALL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        oauth_app: process.env.RECALL_ZOOM_OAUTH_APP_ID,
        authorization_code: { code, redirect_uri: zoomOAuthRedirectUri() },
      })
    });
    if (!credRes.ok) throw new Error(await credRes.text());
    const cred = await credRes.json();

    res.send(`
      <pre style="font-family:monospace;font-size:14px;padding:24px;line-height:1.6">
✅ Zoom account connected.

Copy this into your env vars as RECALL_ZOOM_CREDENTIAL_ID, then redeploy:

RECALL_ZOOM_CREDENTIAL_ID=${cred.id}

Once set (along with ZOOM_OAUTH_CLIENT_ID / ZOOM_OAUTH_CLIENT_SECRET),
new bots will join Zoom "signed in" and become selectable in Zoom's
Language Interpretation → Add Interpreter search.
      </pre>
    `);
  } catch (err) {
    console.error('Zoom OAuth callback failed:', err);
    res.status(500).send(`Failed to connect Zoom account: ${err.message}`);
  }
});

// The zoom.zak_url endpoint: Recall calls this (repeatedly, for the life of
// the call) to fetch a fresh ZAK token for the bot to authenticate with.
app.get('/webhook/zak', async (req, res) => {
  try {
    if (!isSignedInBotConfigured()) {
      return res.status(500).send('Signed-in bot mode is not configured on this server.');
    }
    const tokenRes = await fetchWithTimeout(
      `https://us-west-2.recall.ai/api/v2/zoom-oauth-credentials/${process.env.RECALL_ZOOM_CREDENTIAL_ID}/access-token/`,
      { headers: { 'Authorization': `Token ${process.env.RECALL_API_KEY}` } }
    );
    if (!tokenRes.ok) throw new Error(`Recall access-token fetch failed: ${await tokenRes.text()}`);
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token || tokenData.token;
    if (!accessToken) throw new Error('Recall access-token response missing token');

    const zakRes = await fetchWithTimeout('https://api.zoom.us/v2/users/me/zak', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!zakRes.ok) throw new Error(`Zoom ZAK fetch failed: ${await zakRes.text()}`);
    const zakData = await zakRes.json();
    if (!zakData.token) throw new Error('Zoom ZAK response missing token');

    res.set('Content-Type', 'text/plain').send(zakData.token);
  } catch (err) {
    console.error('[ZAK] Failed to mint ZAK token:', err.message);
    res.status(500).send('Failed to mint ZAK token');
  }
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
    // NOTE: status is now driven entirely by the bot.status_change webhook
    // (see /webhook/status below) instead of polling. You MUST add your
    // webhook URL (e.g. https://your-app.vercel.app/webhook/status) in the
    // Recall Dashboard → Webhooks tab — this cannot be set from createBot().
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

app.get('/api/state', (req, res) => res.json({ ...botState, signedInBotEnabled: isSignedInBotConfigured() }));

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


// ── SSE clients ───────────────────────────────────────────────────────────────
let sseClients = [];
let eventId = 0;

function pushEvent(type, data) {
  const id = ++eventId;
  const payload = { type, data, timestamp: new Date().toISOString(), id };
  const msg = `id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`;
  sseClients = sseClients.filter(client => {
    try { client.write(msg); return true; } catch { return false; }
  });
}

// ── SSE endpoint ──────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'state', data: { ...botState, signedInBotEnabled: isSignedInBotConfigured() } })}\n\n`);
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

// ── Debug endpoint ────────────────────────────────────────────────────────────
app.get('/api/debug', (req, res) => {
  res.json({
    signedInBotConfigured: isSignedInBotConfigured(),
    hasRecallKey: Boolean(process.env.RECALL_API_KEY),
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasWebhookUrl: Boolean(process.env.WEBHOOK_URL),
    hasCredentialId: Boolean(process.env.RECALL_ZOOM_CREDENTIAL_ID),
    hasZoomClientId: Boolean(process.env.ZOOM_OAUTH_CLIENT_ID),
    hasZoomClientSecret: Boolean(process.env.ZOOM_OAUTH_CLIENT_SECRET),
    webhookUrl: process.env.WEBHOOK_URL,
    botName: process.env.BOT_NAME,
    status: botState.status,
  });
});


// ── Zoom Server-to-Server API (auto-assign interpreter) ───────────────────────
async function getZoomServerToken() {
  const credentials = Buffer.from(
    `${process.env.ZOOM_S2S_CLIENT_ID}:${process.env.ZOOM_S2S_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetchWithTimeout(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${process.env.ZOOM_S2S_ACCOUNT_ID}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    }
  );

  if (!res.ok) throw new Error(`Zoom S2S token failed: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

function extractMeetingId(meetingUrl) {
  const match = meetingUrl.match(/\/j\/(\d+)/);
  if (!match) throw new Error('Could not extract meeting ID from URL');
  return match[1];
}

async function autoAssignInterpreter(meetingUrl, botEmail, fromLang = 'en', toLang = 'fr') {
  if (!process.env.ZOOM_S2S_CLIENT_ID || !process.env.ZOOM_S2S_CLIENT_SECRET || !process.env.ZOOM_S2S_ACCOUNT_ID) {
    console.log('[ZOOM API] S2S credentials not set — skipping auto-assign');
    return false;
  }

  try {
    const meetingId = extractMeetingId(meetingUrl);
    const token = await getZoomServerToken();

    // Step 1: Enable interpretation on the meeting
    await fetchWithTimeout(`https://api.zoom.us/v2/meetings/${meetingId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        settings: { language_interpretation: { enable: true } }
      })
    });
    console.log('[ZOOM API] Language interpretation enabled');

    // Step 2: Assign bot as interpreter
    const langMap = { en: 'English', fr: 'French', es: 'Spanish', de: 'German', pt: 'Portuguese', ar: 'Arabic' };
    const assignRes = await fetchWithTimeout(
      `https://api.zoom.us/v2/meetings/${meetingId}/interpretation`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          interpreters: [{
            email: botEmail,
            languages: [langMap[fromLang] || 'English', langMap[toLang] || 'French']
          }]
        })
      }
    );

    if (assignRes.ok || assignRes.status === 204) {
      console.log(`[ZOOM API] ✅ Bot ${botEmail} auto-assigned as ${fromLang}→${toLang} interpreter`);
      pushEvent('zoom_assigned', { message: `Bot auto-assigned as ${fromLang.toUpperCase()}→${toLang.toUpperCase()} interpreter! Click Start in Zoom Language Interpretation.` });
      return true;
    } else {
      const err = await assignRes.text();
      console.warn('[ZOOM API] Assignment failed:', err);
      return false;
    }
  } catch (err) {
    console.error('[ZOOM API] Auto-assign error:', err.message);
    return false;
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => console.log(`\n🎙️  Zoom Interpreter Bot running at http://localhost:${PORT}\n`));
}

module.exports = app;
module.exports.extractTranscriptPayload = extractTranscriptPayload;