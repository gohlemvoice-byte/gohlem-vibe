'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const express = require('express');
const http    = require('http');

const ConversationEngine = require('../conversation/conversationEngine');
const restaurantConfig   = require('../config/restaurantConfig');
const hotBagelsConfig    = require('../config/hotBagelsConfig');
const sushiSpotConfig    = require('../config/sushiSpotConfig');
const pizzaPlaceConfig   = require('../config/pizzaPlaceConfig');
const transcriptStore    = require('../db/transcriptStore');
const retellHandler      = require('./retellHandler');

const RESTAURANT_CONFIGS = {
  tonys:      restaurantConfig,
  hotbagels:  hotBagelsConfig,
  sushi:      sushiSpotConfig,
  pizza:      pizzaPlaceConfig,
};

const PORT   = process.env.PORT || 3000;
const DG_KEY = process.env.DEEPGRAM_API_KEY;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// sessionId → browser test session  { engine, lastActivity }
const browserSessions = new Map();
// last 30 completed call transcripts (in-memory fallback)
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

function log(id, msg) {
  const tag = id ? id.slice(-8) : 'SERVER';
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

// ─── HEALTH ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:      'ok',
    restaurant:  restaurantConfig.restaurantInfo.name,
    activeCalls: retellHandler.getActiveCallCount(),
  });
});

// ─── RETELL WEBHOOK ───────────────────────────────────────────────────────────

app.post('/retell/chat', retellHandler.handleWebhook);

// ─── BROWSER VOICE TEST ──────────────────────────────────────────────────────

app.get('/voice/test', (_req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/voiceTest.html'));
});

// Clean transcript viewer — reads from database, falls back to memory
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
    log(null, `Transcripts DB read failed, using memory: ${err.message}`);
    calls = callHistory.map(c => ({ ...c, avgLatency: null }));
  }

  function renderCall(call) {
    const turns = (call.transcript || []).map(t => {
      const time    = new Date(t.ts).toLocaleTimeString('en-US', { hour12: false });
      const latency = t.latencyMs != null
        ? `<span class="lat">${t.latencyMs}ms</span>` : '';
      return t.role === 'customer'
        ? `<div class="turn customer"><span class="label">CALLER</span> <span class="time">${time}</span><p>${t.text}</p></div>`
        : `<div class="turn ai"><span class="label">AI ${latency}</span> <span class="time">${time}</span><p>${t.text}</p></div>`;
    }).join('');

    const avg = call.avgLatency ?? (() => {
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
${calls.length === 0 ? '<div class="empty">No calls yet — make a call and refresh.</div>' : rows}
</body></html>`);
});

// Open a new browser test session
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
    const rawType     = req.headers['content-type'] || 'audio/webm';
    const contentType = rawType.split(';')[0].trim();
    const sttRes = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&detect_language=false&language=en',
      {
        method:  'POST',
        headers: { Authorization: `Token ${DG_KEY}`, 'Content-Type': contentType },
        body:    req.body,
      }
    );
    if (!sttRes.ok) throw new Error(`STT ${sttRes.status}: ${await sttRes.text()}`);
    const sttData    = await sttRes.json();
    const transcript = sttData.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';

    if (!transcript) {
      return res.status(400).json({ error: 'No speech detected — please try again.' });
    }

    log(null, `Voice test — heard: "${transcript}"`);

    const chatResult   = await session.engine.chat(transcript);
    const responseText = chatResult.message;
    log(null, `Voice test — response: "${responseText.slice(0, 80)}"`);

    const ttsRes = await fetch(
      'https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=24000',
      {
        method:  'POST',
        headers: { Authorization: `Token ${DG_KEY}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: responseText }),
      }
    );
    if (!ttsRes.ok) throw new Error(`TTS ${ttsRes.status}: ${await ttsRes.text()}`);

    const audio = toWav(Buffer.from(await ttsRes.arrayBuffer())).toString('base64');
    const order = session.engine.cart.getOrder();
    const cart  = {
      orderType:      session.engine.cart.orderType || null,
      restaurantName: session.engine.config.restaurantInfo.name,
      items: order.items.map(i => ({
        name:               i.name,
        quantity:           i.quantity,
        modifiers:          i.modifiers.map(m => m.name),
        specialInstructions: i.specialInstructions || '',
        lineTotal:          i.lineTotal,
      })),
      total: order.total,
    };

    res.json({ transcript, response: responseText, audio, cart });

  } catch (err) {
    log(null, `Voice test error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

transcriptStore.init()
  .then(() => log(null, 'DB: call_transcripts table ready'))
  .catch(err => log(null, `DB init failed (transcripts will use memory only): ${err.message}`));

const server = http.createServer(app);
server.listen(PORT, () => {
  log(null, `Gohlem.ai voice server on port ${PORT}`);
  log(null, `Voice layer: Retell  |  Webhook: POST /retell/chat`);
  log(null, `Browser test: GET /voice/test  |  Transcripts: GET /voice/transcripts`);
});
