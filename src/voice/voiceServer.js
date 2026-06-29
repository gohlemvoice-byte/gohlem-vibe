const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { twiml: TwilioTwiml } = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');


const ConversationEngine = require('../conversation/conversationEngine');
const restaurantConfig  = require('../config/restaurantConfig');
const hotBagelsConfig   = require('../config/hotBagelsConfig');
const sushiSpotConfig   = require('../config/sushiSpotConfig');
const pizzaPlaceConfig  = require('../config/pizzaPlaceConfig');
const transcriptStore   = require('../db/transcriptStore');

const RESTAURANT_CONFIGS = {
  tonys:      restaurantConfig,
  hotbagels:  hotBagelsConfig,
  sushi:      sushiSpotConfig,
  pizza:      pizzaPlaceConfig,
};

const PORT = process.env.PORT || 3000;
const DG_KEY = process.env.DEEPGRAM_API_KEY;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const deepgramClient = createClient(DG_KEY);

// callSid → session
const sessions = new Map();
// sessionId → browser test session  { engine, lastActivity }
const browserSessions = new Map();
// last 30 completed call transcripts (in-memory, newest first)
const callHistory = [];

// Purge browser sessions idle for more than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, s] of browserSessions) {
    if (s.lastActivity < cutoff) browserSessions.delete(id);
  }
}, 5 * 60 * 1000);

function toWav(pcm, sampleRate = 24000, channels = 1, bitDepth = 16) {
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28);
  buf.writeUInt16LE(channels * (bitDepth / 8), 32);
  buf.writeUInt16LE(bitDepth, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function log(id, msg) {
  const tag = id ? id.slice(-8) : 'SERVER';
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

// ─── HTTP ROUTES ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    restaurant: restaurantConfig.restaurantInfo.name,
    activeCalls: sessions.size,
  });
});

app.post('/voice/inbound', (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  const rawHost = process.env.SERVER_URL
    ? process.env.SERVER_URL.replace(/^https?:\/\//, '')
    : req.headers.host;

  log(callSid, 'Inbound call');

  const twiml = new TwilioTwiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: `wss://${rawHost}/voice/stream` });

  res.type('text/xml').send(twiml.toString());
});

app.post('/voice/fallback', (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  log(callSid, 'Fallback triggered');

  const twiml = new TwilioTwiml.VoiceResponse();
  twiml.say('We are experiencing technical difficulties. Please hold.');
  if (process.env.RESTAURANT_PHONE) {
    twiml.dial(process.env.RESTAURANT_PHONE);
  } else {
    twiml.say('Please call us back directly. Thank you.');
  }

  res.type('text/xml').send(twiml.toString());
});

// ─── BROWSER VOICE TEST ──────────────────────────────────────────────────────

app.get('/voice/test', (_req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/voiceTest.html'));
});

// Clean transcript viewer for real phone calls — reads from database
app.get('/voice/transcripts', async (_req, res) => {
  let calls;
  try {
    const dbRows = await transcriptStore.getRecent(50);
    calls = dbRows.map(row => ({
      callSid:    row.call_sid,
      restaurant: row.restaurant,
      startTime:  row.started_at,
      duration:   row.duration_sec,
      items:      row.item_count,
      total:      Number(row.total_dollars).toFixed(2),
      avgLatency: row.avg_latency_ms,
      transcript: typeof row.transcript === 'string' ? JSON.parse(row.transcript) : row.transcript,
    }));
  } catch (err) {
    // DB unavailable — fall back to in-memory
    log(null, `Transcripts DB read failed, using memory: ${err.message}`);
    calls = callHistory.map(c => ({ ...c, avgLatency: null }));
  }

  function renderCall(call) {
    const turns = (call.transcript || []).map(t => {
      const time = new Date(t.ts).toLocaleTimeString('en-US', { hour12: false });
      const latency = t.latencyMs != null
        ? `<span class="lat">${t.latencyMs}ms</span>` : '';
      return t.role === 'customer'
        ? `<div class="turn customer"><span class="label">CALLER</span> <span class="time">${time}</span><p>${t.text}</p></div>`
        : `<div class="turn ai"><span class="label">AI ${latency}</span> <span class="time">${time}</span><p>${t.text}</p></div>`;
    }).join('');

    const avg = call.avgLatency
      ?? (() => {
        const lats = (call.transcript || []).filter(t => t.role === 'ai' && t.latencyMs).map(t => t.latencyMs);
        return lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null;
      })();

    const when = new Date(call.startTime).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    return `
      <div class="call">
        <div class="call-header">
          📞 ${when} &nbsp;|&nbsp; ${call.duration}s &nbsp;|&nbsp;
          ${call.items} item(s) &nbsp;|&nbsp; $${call.total}
          ${avg ? `&nbsp;|&nbsp; <strong>avg latency: ${avg}ms</strong>` : ''}
          ${call.restaurant ? `&nbsp;|&nbsp; ${call.restaurant}` : ''}
          <span class="sid">${call.callSid}</span>
        </div>
        <div class="turns">${turns}</div>
      </div>`;
  }

  const rows = calls.map(renderCall).join('');

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>Gohlem Call Transcripts</title>
<meta http-equiv="refresh" content="30">
<style>
  body { font-family: sans-serif; background: #0f0f0f; color: #eee; padding: 24px; max-width: 800px; margin: auto; }
  h1 { font-size: 18px; color: #aaa; margin-bottom: 4px; }
  .sub { font-size: 12px; color: #444; margin-bottom: 24px; }
  .call { background: #1a1a1a; border-radius: 10px; margin-bottom: 28px; overflow: hidden; }
  .call-header { background: #222; padding: 10px 16px; font-size: 13px; color: #888; }
  .call-header strong { color: #f90; }
  .sid { float: right; font-size: 11px; color: #444; }
  .turns { padding: 16px; }
  .turn { margin-bottom: 12px; }
  .turn p { margin: 4px 0 0 0; font-size: 15px; line-height: 1.5; }
  .turn.customer p { color: #fff; }
  .turn.ai p { color: #7dd3fc; }
  .label { font-size: 11px; font-weight: bold; text-transform: uppercase; }
  .turn.customer .label { color: #888; }
  .turn.ai .label { color: #3b82f6; }
  .time { font-size: 11px; color: #444; margin-left: 8px; }
  .lat { background: #f90; color: #000; border-radius: 4px; padding: 1px 5px; font-size: 11px; font-weight: bold; margin-left: 4px; }
  .empty { color: #444; text-align: center; padding: 60px; }
</style>
</head><body>
<h1>Gohlem Call Transcripts</h1>
<div class="sub">${calls.length} call(s) stored &nbsp;·&nbsp; auto-refreshes every 30s &nbsp;·&nbsp; survives deploys</div>
${calls.length === 0 ? '<div class="empty">No calls yet. Make a call to +19728458717 and refresh.</div>' : rows}
</body></html>`);
});

// Open a new browser session and return the greeting.
// Client generates a fresh UUID on every page load (or "Start New Order" click).
app.post('/voice/test/open', express.json(), async (req, res) => {
  const sessionId = req.body?.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const config  = RESTAURANT_CONFIGS[req.body?.restaurantId] || restaurantConfig;
  const session = { engine: new ConversationEngine(config), lastActivity: Date.now() };
  browserSessions.set(sessionId, session);

  try {
    const openResult = await session.engine.open();
    log(null, `Voice test — new session ${sessionId.slice(-8)}`);
    res.json({ greeting: openResult.message, restaurantName: config.restaurantInfo.name });
  } catch (err) {
    log(null, `Voice test open error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/voice/test', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const session   = sessionId && browserSessions.get(sessionId);

  if (!session) {
    return res.status(400).json({ error: 'Session not found. Please start a new order.' });
  }
  session.lastActivity = Date.now();

  try {
    // Strip codec params — Deepgram wants "audio/webm" not "audio/webm;codecs=opus"
    const rawType = req.headers['content-type'] || 'audio/webm';
    const contentType = rawType.split(';')[0].trim();
    const sttRes = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&detect_language=false&language=en',
      {
        method: 'POST',
        headers: { Authorization: `Token ${DG_KEY}`, 'Content-Type': contentType },
        body: req.body,
      }
    );
    if (!sttRes.ok) throw new Error(`STT ${sttRes.status}: ${await sttRes.text()}`);
    const sttData = await sttRes.json();
    const transcript = sttData.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';

    if (!transcript) {
      return res.status(400).json({ error: 'No speech detected — please try again.' });
    }

    log(null, `Voice test — heard: "${transcript}"`);

    const chatResult = await session.engine.chat(transcript);
    const responseText = chatResult.message;
    log(null, `Voice test — response: "${responseText.slice(0, 80)}"`);

    const ttsRes = await fetch(
      'https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=24000',
      {
        method: 'POST',
        headers: { Authorization: `Token ${DG_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: responseText }),
      }
    );
    if (!ttsRes.ok) throw new Error(`TTS ${ttsRes.status}: ${await ttsRes.text()}`);

    const audio = toWav(Buffer.from(await ttsRes.arrayBuffer())).toString('base64');

    const order = session.engine.cart.getOrder();
    const cart = {
      orderType: session.engine.cart.orderType || null,
      restaurantName: session.engine.config.restaurantInfo.name,
      items: order.items.map(i => ({
        name: i.name,
        quantity: i.quantity,
        modifiers: i.modifiers.map(m => m.name),
        specialInstructions: i.specialInstructions || '',
        lineTotal: i.lineTotal,
      })),
      total: order.total,
    };

    res.json({ transcript, response: responseText, audio, cart });

  } catch (err) {
    log(null, `Voice test error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── WEBSOCKET SERVER ─────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/voice/stream' });

wss.on('connection', (twilioWs) => {
  let session = null;

  twilioWs.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {
      case 'connected':
        break; // Twilio handshake — nothing to do

      case 'start': {
        const { callSid, streamSid } = msg.start;
        session = {
          callSid,
          streamSid,
          ws: twilioWs,
          engine: new ConversationEngine(restaurantConfig),
          dgConn: null,
          dgReady: false,
          state: 'init', // init | greeting | speaking | listening | processing | done
          processing: false, // guard against concurrent transcript events
          startTime: Date.now(),
          transcript: [],      // { role, text, ts, latencyMs? }
          lastHeardTs: null,   // timestamp when customer finished speaking
        };
        sessions.set(callSid, session);
        log(callSid, `Stream started (${streamSid})`);
        await sendGreeting(session);
        break;
      }

      case 'media': {
        if (!session || session.state !== 'listening' || session.processing) break;
        if (!session.dgConn || !session.dgReady) break;
        const audio = Buffer.from(msg.media.payload, 'base64');
        session.dgConn.send(audio);
        break;
      }

      case 'mark': {
        // Twilio confirms audio finished playing — start listening
        if (session && session.state === 'speaking') {
          startListening(session);
        }
        break;
      }

      case 'stop': {
        if (session) teardown(session, 'Twilio stop');
        break;
      }
    }
  });

  twilioWs.on('close', () => {
    if (session) teardown(session, 'WebSocket closed');
  });

  twilioWs.on('error', (err) => {
    if (session) log(session.callSid, `WS error: ${err.message}`);
  });
});

// ─── GREETING ─────────────────────────────────────────────────────────────────

async function sendGreeting(session) {
  session.state = 'greeting';
  try {
    const result = await session.engine.open();
    await speak(session, result.message || 'Welcome. Will this be for pickup or delivery?');
  } catch (err) {
    log(session.callSid, `Greeting error: ${err.message}`);
    startListening(session);
  }
}

// ─── LISTEN ───────────────────────────────────────────────────────────────────

function startListening(session) {
  if (session.state === 'done') return;
  session.state = 'listening';

  const conn = deepgramClient.listen.live({
    model: 'nova-2',
    language: 'en-US',
    smart_format: true,
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
    endpointing: 1500,        // fire speech_final after 1500ms silence
    utterance_end_ms: 2000,   // backup utterance boundary at 2000ms
    interim_results: true,
  });

  conn.on(LiveTranscriptionEvents.Open, () => {
    session.dgReady = true;
    log(session.callSid, 'STT ready, listening');
  });

  conn.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const text = data.channel?.alternatives?.[0]?.transcript?.trim();
    if (!text) return;
    if (!data.is_final || !data.speech_final) return;

    // Prevent race condition — drop duplicate final events
    if (session.processing) return;
    session.processing = true;

    log(session.callSid, `Heard: "${text}"`);

    // Shut down this STT connection; a new one opens next round
    session.state = 'processing';
    try { conn.requestClose(); } catch {}
    session.dgConn = null;
    session.dgReady = false;

    await processUtterance(session, text);
    session.processing = false;
  });

  conn.on(LiveTranscriptionEvents.Error, (err) => {
    log(session.callSid, `STT error: ${JSON.stringify(err)}`);
  });

  conn.on(LiveTranscriptionEvents.Close, () => {
    session.dgReady = false;
  });

  session.dgConn = conn;
}

// ─── PROCESS ──────────────────────────────────────────────────────────────────

async function processUtterance(session, text) {
  if (session.state === 'done') return;
  session.lastHeardTs = Date.now();
  session.transcript.push({ role: 'customer', text, ts: Date.now() });
  try {
    const result = await session.engine.chat(text);
    const reply = result.message || "I'm sorry, I didn't catch that. Could you repeat?";
    await speak(session, reply);

    // Detect natural end-of-call phrases
    const lower = reply.toLowerCase();
    const ended = lower.includes('goodbye') || lower.includes('take care') ||
                  lower.includes('order has been placed') || lower.includes('have a great');
    if (ended) {
      // Brief pause so TTS finishes before we tear down
      setTimeout(() => teardown(session, 'Order complete'), 4000);
    }
    // Otherwise the mark event from speak() will trigger startListening()
  } catch (err) {
    log(session.callSid, `Process error: ${err.message}`);
    await speak(session, "Sorry, something went wrong. Let me try again.");
  }
}

// ─── TEXT-TO-SPEECH ───────────────────────────────────────────────────────────

async function speak(session, text) {
  if (session.state === 'done') return;
  session.state = 'speaking';
  const latencyMs = session.lastHeardTs ? Date.now() - session.lastHeardTs : null;
  session.transcript.push({ role: 'ai', text, ts: Date.now(), latencyMs });
  session.lastHeardTs = null;
  log(session.callSid, `Speaking${latencyMs !== null ? ` [${latencyMs}ms latency]` : ''}: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);

  try {
    const res = await fetch(
      'https://api.deepgram.com/v1/speak' +
      '?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=none',
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${DG_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      }
    );

    if (!res.ok) {
      throw new Error(`TTS ${res.status}: ${await res.text()}`);
    }

    const audio = Buffer.from(await res.arrayBuffer());

    if (session.ws.readyState !== WebSocket.OPEN) return;

    // Stream in 20ms mulaw chunks (160 bytes @ 8000 Hz)
    const CHUNK = 160;
    for (let i = 0; i < audio.length; i += CHUNK) {
      session.ws.send(JSON.stringify({
        event: 'media',
        streamSid: session.streamSid,
        media: { payload: audio.slice(i, i + CHUNK).toString('base64') },
      }));
    }

    // Mark tells us when Twilio has finished playing all sent audio
    session.ws.send(JSON.stringify({
      event: 'mark',
      streamSid: session.streamSid,
      mark: { name: `end-${Date.now()}` },
    }));
  } catch (err) {
    log(session.callSid, `TTS error: ${err.message}`);
    // Mark never arrives — start listening now so call doesn't hang
    startListening(session);
  }
}

// ─── TEARDOWN ─────────────────────────────────────────────────────────────────

function teardown(session, reason) {
  if (session.state === 'done') return;
  session.state = 'done';

  const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
  const order = session.engine.cart.getOrder();

  log(session.callSid, `Ended — ${reason}`);
  log(session.callSid, `Duration: ${duration}s | Items: ${order.items.length} | Total: $${order.total.toFixed(2)}`);
  log(session.callSid, `Summary: ${session.engine.cart.getSummary()}`);

  // Save to in-memory cache (fallback if db is unavailable)
  callHistory.unshift({
    callSid: session.callSid,
    restaurant: session.engine.config.restaurantInfo.name,
    startTime: new Date(session.startTime).toISOString(),
    duration,
    items: order.items.length,
    total: order.total.toFixed(2),
    transcript: session.transcript,
  });
  if (callHistory.length > 30) callHistory.pop();

  // Persist to database
  transcriptStore.save({
    callSid: session.callSid,
    restaurant: session.engine.config.restaurantInfo.name,
    startTime: session.startTime,
    duration,
    items: order.items.length,
    total: order.total.toFixed(2),
    transcript: session.transcript,
  }).catch(err => log(session.callSid, `DB save failed: ${err.message}`));

  if (session.dgConn) {
    try { session.dgConn.requestClose(); } catch {}
    session.dgConn = null;
  }

  sessions.delete(session.callSid);
}

// ─── START ────────────────────────────────────────────────────────────────────

transcriptStore.init()
  .then(() => log(null, 'DB: call_transcripts table ready'))
  .catch(err => log(null, `DB init failed (transcripts will use memory only): ${err.message}`));

server.listen(PORT, () => {
  log(null, `Gohlem.ai voice server on port ${PORT}`);
  log(null, `Restaurant: ${restaurantConfig.restaurantInfo.name}`);
  log(null, `Routes: POST /voice/inbound  GET /health  POST /voice/fallback`);
});
