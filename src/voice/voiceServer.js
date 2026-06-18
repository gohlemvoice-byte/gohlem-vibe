const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { twiml: TwilioTwiml } = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const ConversationEngine = require('../conversation/conversationEngine');
const restaurantConfig = require('../config/restaurantConfig');

const MENU_PATH = path.join(__dirname, '../../hot_bagels_menu_with_real_acai_restaurant.json');
const PORT = process.env.PORT || 3000;
const DG_KEY = process.env.DEEPGRAM_API_KEY;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const deepgramClient = createClient(DG_KEY);

// callSid → session
const sessions = new Map();

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
          engine: new ConversationEngine(MENU_PATH),
          dgConn: null,
          dgReady: false,
          state: 'init', // init | greeting | speaking | listening | processing | done
          startTime: Date.now(),
        };
        sessions.set(callSid, session);
        log(callSid, `Stream started (${streamSid})`);
        await sendGreeting(session);
        break;
      }

      case 'media': {
        if (!session || session.state !== 'listening') break;
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
    endpointing: 500,     // fire speech_final after 500ms silence
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

    log(session.callSid, `Heard: "${text}"`);

    // Shut down this STT connection; a new one opens next round
    session.state = 'processing';
    try { conn.requestClose(); } catch {}
    session.dgConn = null;
    session.dgReady = false;

    await processUtterance(session, text);
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
  log(session.callSid, `Speaking: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);

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

  if (session.dgConn) {
    try { session.dgConn.requestClose(); } catch {}
    session.dgConn = null;
  }

  sessions.delete(session.callSid);
}

// ─── START ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  log(null, `Gohlem.ai voice server on port ${PORT}`);
  log(null, `Restaurant: ${restaurantConfig.restaurantInfo.name}`);
  log(null, `Routes: POST /voice/inbound  GET /health  POST /voice/fallback`);
});
