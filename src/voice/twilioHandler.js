'use strict';

const WebSocket = require('ws');
const { twiml: TwilioTwiml } = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const ConversationEngine = require('../conversation/conversationEngine');
const restaurantConfig   = require('../config/restaurantConfig');
const transcriptStore    = require('../db/transcriptStore');

const DG_KEY         = process.env.DEEPGRAM_API_KEY;
const deepgramClient = createClient(DG_KEY);

const sessions = new Map();

function log(id, msg) {
  const tag = id ? id.slice(-8) : 'Twilio';
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

// ─── ATTACH TO SERVER ─────────────────────────────────────────────────────────

function attach(server, app) {
  app.post('/voice/inbound', (req, res) => {
    const callSid = req.body.CallSid || 'unknown';
    const rawHost = process.env.SERVER_URL
      ? process.env.SERVER_URL.replace(/^https?:\/\//, '')
      : req.headers.host;
    log(callSid, 'Inbound call');
    const twiml = new TwilioTwiml.VoiceResponse();
    twiml.connect().stream({ url: `wss://${rawHost}/voice/stream` });
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

  const wss = new WebSocket.Server({ server, path: '/voice/stream' });

  wss.on('connection', (twilioWs) => {
    let session = null;

    twilioWs.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.event) {
        case 'connected': break;

        case 'start': {
          const { callSid, streamSid } = msg.start;
          session = {
            callSid, streamSid,
            ws:          twilioWs,
            engine:      new ConversationEngine(restaurantConfig),
            dgConn:      null,
            dgReady:     false,
            state:       'init',
            processing:  false,
            startTime:   Date.now(),
            transcript:  [],
            lastHeardTs: null,
          };
          sessions.set(callSid, session);
          log(callSid, `Stream started (${streamSid})`);
          await sendGreeting(session);
          break;
        }

        case 'media': {
          if (!session || session.state !== 'listening' || session.processing) break;
          if (!session.dgConn || !session.dgReady) break;
          session.dgConn.send(Buffer.from(msg.media.payload, 'base64'));
          break;
        }

        case 'mark': {
          if (session && session.state === 'speaking') startListening(session);
          break;
        }

        case 'stop': {
          if (session) teardown(session, 'Twilio stop');
          break;
        }
      }
    });

    twilioWs.on('close', () => { if (session) teardown(session, 'WebSocket closed'); });
    twilioWs.on('error', (err) => { if (session) log(session.callSid, `WS error: ${err.message}`); });
  });
}

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
    model:           'nova-2',
    language:        'en-US',
    smart_format:    true,
    encoding:        'mulaw',
    sample_rate:     8000,
    channels:        1,
    endpointing:     600,
    utterance_end_ms: 1200,
    interim_results: true,
  });

  conn.on(LiveTranscriptionEvents.Open, () => {
    session.dgReady = true;
    log(session.callSid, 'STT ready');
  });

  conn.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const text = data.channel?.alternatives?.[0]?.transcript?.trim();
    if (!text || !data.is_final || !data.speech_final) return;
    if (session.processing) return;
    session.processing = true;

    log(session.callSid, `Heard: "${text}"`);
    session.state = 'processing';
    try { conn.requestClose(); } catch {}
    session.dgConn  = null;
    session.dgReady = false;

    await processUtterance(session, text);
    session.processing = false;
  });

  conn.on(LiveTranscriptionEvents.Error, (err) => {
    log(session.callSid, `STT error: ${JSON.stringify(err)}`);
  });

  conn.on(LiveTranscriptionEvents.Close, () => { session.dgReady = false; });

  session.dgConn = conn;
}

// ─── PROCESS ──────────────────────────────────────────────────────────────────

async function processUtterance(session, text) {
  if (session.state === 'done') return;
  session.lastHeardTs = Date.now();
  session.transcript.push({ role: 'customer', text, ts: Date.now() });
  try {
    const result = await session.engine.chat(text);
    const reply  = result.message || "I'm sorry, I didn't catch that. Could you repeat?";
    await speak(session, reply);

    const lower = reply.toLowerCase();
    const ended = lower.includes('goodbye') || lower.includes('take care') ||
                  lower.includes('order has been placed') || lower.includes('have a great');
    if (ended) setTimeout(() => teardown(session, 'Order complete'), 4000);
  } catch (err) {
    log(session.callSid, `Process error: ${err.message}`);
    await speak(session, "Sorry, something went wrong. Let me try again.");
  }
}

// ─── SPEAK ────────────────────────────────────────────────────────────────────

async function speak(session, text) {
  if (session.state === 'done') return;
  session.state = 'speaking';
  const latencyMs = session.lastHeardTs ? Date.now() - session.lastHeardTs : null;
  session.transcript.push({ role: 'ai', text, ts: Date.now(), latencyMs });
  session.lastHeardTs = null;
  log(session.callSid, `Speaking${latencyMs !== null ? ` [${latencyMs}ms]` : ''}: "${text.slice(0, 80)}"`);

  try {
    const res = await fetch(
      'https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=none',
      {
        method:  'POST',
        headers: { Authorization: `Token ${DG_KEY}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text }),
      }
    );
    if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);

    const audio = Buffer.from(await res.arrayBuffer());
    if (session.ws.readyState !== WebSocket.OPEN) return;

    const CHUNK = 160;
    for (let i = 0; i < audio.length; i += CHUNK) {
      session.ws.send(JSON.stringify({
        event:     'media',
        streamSid: session.streamSid,
        media:     { payload: audio.slice(i, i + CHUNK).toString('base64') },
      }));
    }
    session.ws.send(JSON.stringify({
      event:     'mark',
      streamSid: session.streamSid,
      mark:      { name: `end-${Date.now()}` },
    }));
  } catch (err) {
    log(session.callSid, `TTS error: ${err.message}`);
    startListening(session);
  }
}

// ─── TEARDOWN ─────────────────────────────────────────────────────────────────

function teardown(session, reason) {
  if (session.state === 'done') return;
  session.state = 'done';

  const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
  const order    = session.engine.cart.getOrder();

  log(session.callSid, `Ended — ${reason} | ${duration}s | ${order.items.length} items | $${order.total.toFixed(2)}`);

  transcriptStore.save({
    callSid:    session.callSid,
    restaurant: session.engine.config.restaurantInfo.name,
    startTime:  session.startTime,
    duration,
    items:      order.items.length,
    total:      order.total.toFixed(2),
    transcript: session.transcript,
  }).catch(err => log(session.callSid, `DB save failed: ${err.message}`));

  if (session.dgConn) {
    try { session.dgConn.requestClose(); } catch {}
    session.dgConn = null;
  }
  sessions.delete(session.callSid);
}

function getActiveCallCount() { return sessions.size; }

module.exports = { attach, getActiveCallCount };
