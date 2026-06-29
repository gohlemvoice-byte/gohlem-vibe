'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');

const ConversationEngine = require('../conversation/conversationEngine');
const restaurantConfig   = require('../config/restaurantConfig');
const hotBagelsConfig    = require('../config/hotBagelsConfig');
const sushiSpotConfig    = require('../config/sushiSpotConfig');
const pizzaPlaceConfig   = require('../config/pizzaPlaceConfig');
const transcriptStore    = require('../db/transcriptStore');
const retellHandler      = require('./retellHandler');
const twilioHandler      = require('./twilioHandler');

const RESTAURANT_CONFIGS = {
  tonys:      restaurantConfig,
  hotbagels:  hotBagelsConfig,
  sushi:      sushiSpotConfig,
  pizza:      pizzaPlaceConfig,
};

// ─── VOICE LAYER TOGGLE ───────────────────────────────────────────────────────
// Set VOICE_LAYER=twilio in Railway to switch to Twilio + Deepgram.
// Default (unset or "retell") uses Retell.
const VOICE_LAYER = (process.env.VOICE_LAYER || 'retell').toLowerCase();

const PORT   = process.env.PORT || 3000;
const DG_KEY = process.env.DEEPGRAM_API_KEY;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// sessionId → browser test session  { engine, lastActivity }
const browserSessions = new Map();

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
  const handler    = VOICE_LAYER === 'twilio' ? twilioHandler : retellHandler;
  res.json({
    status:      'ok',
    voiceLayer:  VOICE_LAYER,
    restaurant:  restaurantConfig.restaurantInfo.name,
    activeCalls: handler.getActiveCallCount(),
  });
});

// ─── TWILIO FALLBACK (works regardless of voice layer) ───────────────────────
// Twilio calls this if the primary webhook fails. Always returns valid TwiML.
app.post('/voice/fallback', (req, res) => {
  const { twiml: TwilioTwiml } = require('twilio');
  const twiml = new TwilioTwiml.VoiceResponse();
  twiml.say({ voice: 'alice' }, 'We are sorry, we are experiencing technical difficulties. Please call us back in a few minutes. Thank you.');
  res.type('text/xml').send(twiml.toString());
});

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
      callSid:          row.call_sid,
      restaurant:       row.restaurant,
      startTime:        row.started_at,
      duration:         row.duration_sec,
      items:            row.item_count,
      total:            Number(row.total_dollars).toFixed(2),
      avgLatency:       row.avg_latency_ms,
      transcript:       typeof row.transcript === 'string' ? JSON.parse(row.transcript) : row.transcript,
      cartItems:        typeof row.cart_items === 'string' ? JSON.parse(row.cart_items) : (row.cart_items || []),
      promptTokens:     row.prompt_tokens     ? Number(row.prompt_tokens)     : null,
      completionTokens: row.completion_tokens ? Number(row.completion_tokens) : null,
      retellCostUsd:    row.retell_cost_usd   ? Number(row.retell_cost_usd)   : null,
    }));
  } catch (err) {
    log(null, `Transcripts DB read failed, using memory: ${err.message}`);
    calls = [];
  }

  function toolSummary(toolCalls) {
    if (!toolCalls || !toolCalls.length) return '';
    const pills = toolCalls.map(tc => {
      const n = tc.name;
      const r = tc.result || {};
      let label = '';
      if (n === 'search_menu') {
        label = `🔍 search("${tc.args.query || ''}") → ${r.found ? (r.items && r.items[0] ? r.items[0].name : 'found') : 'not found'}`;
      } else if (n === 'add_to_cart') {
        label = r.success ? `🛒 add → ✓ ${r.name || ''}` : `🛒 add → ✗ ${r.error || ''}`;
      } else if (n === 'update_cart_item') {
        label = `✏️ update → ${r.success ? '✓' : '✗ ' + (r.error || '')}`;
      } else if (n === 'remove_from_cart') {
        label = `🗑 remove → ${r.success ? '✓' : '✗'}`;
      } else if (n === 'get_cart') {
        label = `📋 get_cart → ${r.items ? r.items.length + ' item(s)' : 'ok'}`;
      } else {
        label = `⚙️ ${n}`;
      }
      return `<span class="tool-pill">${label}</span>`;
    }).join('');
    return `<div class="tool-row">${pills}</div>`;
  }

  function renderCall(call, idx) {
    const turns = (call.transcript || []).map(t => {
      const time    = new Date(t.ts).toLocaleTimeString('en-US', { hour12: false });
      const latency = t.latencyMs != null ? `<span class="lat">${t.latencyMs}ms</span>` : '';
      const tokBadge = t.tokens
        ? `<span class="tok">${t.tokens.promptTokens}+${t.tokens.completionTokens}tok</span>` : '';
      const tools   = toolSummary(t.toolCalls);
      return t.role === 'customer'
        ? `<div class="turn customer"><span class="label">CALLER</span> <span class="time">${time}</span><p>${t.text}</p></div>`
        : `<div class="turn ai"><span class="label">AI ${latency}${tokBadge}</span> <span class="time">${time}</span>${tools}<p>${t.text}</p></div>`;
    }).join('');

    const avg = call.avgLatency ?? (() => {
      const lats = (call.transcript || []).filter(t => t.role === 'ai' && t.latencyMs).map(t => t.latencyMs);
      return lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null;
    })();

    // LLM cost: GPT-4o-mini $0.150/1M input, $0.600/1M output
    const llmCost = (call.promptTokens != null && call.completionTokens != null)
      ? ((call.promptTokens / 1_000_000) * 0.150) + ((call.completionTokens / 1_000_000) * 0.600)
      : null;
    const totalTokens = (call.promptTokens || 0) + (call.completionTokens || 0);

    const costHtml = (llmCost !== null || call.retellCostUsd !== null) ? `
      <div class="cost-section">
        <div class="cost-title">Cost Breakdown</div>
        ${totalTokens ? `<div class="cost-row"><span>OpenAI tokens</span><span>${call.promptTokens?.toLocaleString()} in + ${call.completionTokens?.toLocaleString()} out = ${totalTokens.toLocaleString()} total</span></div>` : ''}
        ${llmCost !== null ? `<div class="cost-row"><span>LLM cost (GPT-4o-mini)</span><span class="cost-val">$${llmCost.toFixed(5)}</span></div>` : ''}
        ${call.retellCostUsd !== null ? `<div class="cost-row"><span>Retell platform cost</span><span class="cost-val">$${call.retellCostUsd.toFixed(4)}</span></div>` : ''}
        ${(llmCost !== null && call.retellCostUsd !== null) ? `<div class="cost-row cost-total-row"><span>Total call cost</span><span class="cost-val">$${(llmCost + call.retellCostUsd).toFixed(4)}</span></div>` : ''}
      </div>` : '';

    const cartHtml = (call.cartItems || []).length === 0
      ? '<div class="cart-empty">No items in cart</div>'
      : (call.cartItems || []).map(i => {
          const mods = i.modifiers && i.modifiers.length ? ` <span class="mods">(${i.modifiers.join(', ')})</span>` : '';
          const note = i.specialInstructions ? ` <span class="note">— ${i.specialInstructions}</span>` : '';
          return `<div class="cart-row">${i.quantity}× ${i.name}${mods}${note} <span class="price">$${Number(i.lineTotal).toFixed(2)}</span></div>`;
        }).join('');

    const when = new Date(call.startTime).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    const costTag = llmCost !== null ? ` &nbsp;|&nbsp; <span class="cost-badge">LLM $${llmCost.toFixed(4)}</span>` : '';
    const retellTag = call.retellCostUsd !== null ? ` <span class="cost-badge retell-badge">Retell $${call.retellCostUsd.toFixed(4)}</span>` : '';
    return `
      <div class="call" id="call-${idx}">
        <div class="call-header" onclick="toggle(${idx})">
          <span class="chevron" id="chev-${idx}">▶</span>
          📞 ${when} &nbsp;|&nbsp; ${call.duration}s &nbsp;|&nbsp;
          ${call.items} item(s) &nbsp;|&nbsp; $${call.total}
          ${avg ? `&nbsp;|&nbsp; <strong>avg ${avg}ms</strong>` : ''}
          ${call.restaurant ? `&nbsp;|&nbsp; ${call.restaurant}` : ''}
          ${costTag}${retellTag}
          <span class="sid">${call.callSid}</span>
        </div>
        <div class="call-body" id="body-${idx}">
          <div class="cart-section"><div class="cart-title">Cart</div>${cartHtml}<div class="cart-total">Total: $${call.total}</div></div>
          ${costHtml}
          <div class="turns">${turns}</div>
        </div>
      </div>`;
  }

  const rows = calls.map((c, i) => renderCall(c, i)).join('');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>Gohlem Call Transcripts</title>
<style>
  body { font-family: sans-serif; background: #0f0f0f; color: #eee; padding: 24px; max-width: 860px; margin: auto; }
  h1 { font-size: 18px; color: #aaa; margin-bottom: 4px; }
  .sub { font-size: 12px; color: #444; margin-bottom: 24px; }
  .call { background: #1a1a1a; border-radius: 10px; margin-bottom: 12px; overflow: hidden; }
  .call-header { background: #222; padding: 10px 16px; font-size: 13px; color: #888; cursor: pointer; user-select: none; }
  .call-header:hover { background: #2a2a2a; }
  .call-header strong { color: #f90; }
  .chevron { display: inline-block; margin-right: 8px; font-size: 10px; color: #555; transition: transform 0.15s; }
  .chevron.open { transform: rotate(90deg); color: #888; }
  .call-body { display: none; }
  .call-body.open { display: block; }
  .sid { float: right; font-size: 11px; color: #444; }
  .turns { padding: 16px; }
  .turn { margin-bottom: 14px; }
  .turn p { margin: 4px 0 0 0; font-size: 15px; line-height: 1.5; }
  .turn.customer p { color: #fff; }
  .turn.ai p { color: #7dd3fc; }
  .label { font-size: 11px; font-weight: bold; text-transform: uppercase; }
  .turn.customer .label { color: #888; }
  .turn.ai .label { color: #3b82f6; }
  .time { font-size: 11px; color: #444; margin-left: 8px; }
  .lat { background: #f90; color: #000; border-radius: 4px; padding: 1px 5px; font-size: 11px; font-weight: bold; margin-left: 4px; }
  .tok { background: #1e3a5f; color: #7dd3fc; border-radius: 4px; padding: 1px 5px; font-size: 10px; margin-left: 4px; }
  .tool-row { margin: 4px 0; display: flex; flex-wrap: wrap; gap: 4px; }
  .tool-pill { font-size: 11px; background: #1a2a1a; color: #a3e635; border: 1px solid #2a3a2a; border-radius: 4px; padding: 2px 7px; }
  .empty { color: #444; text-align: center; padding: 60px; }
  .cart-section { background: #111; border-bottom: 1px solid #222; padding: 12px 16px; }
  .cart-title { font-size: 11px; font-weight: bold; color: #555; text-transform: uppercase; margin-bottom: 8px; }
  .cart-row { font-size: 14px; color: #a3e635; padding: 3px 0; display: flex; justify-content: space-between; }
  .cart-row .mods { color: #6b7280; font-size: 13px; }
  .cart-row .note { color: #f59e0b; font-size: 13px; font-style: italic; }
  .cart-row .price { color: #fff; font-weight: bold; }
  .cart-total { font-size: 13px; color: #fff; font-weight: bold; margin-top: 8px; border-top: 1px solid #222; padding-top: 8px; }
  .cart-empty { font-size: 13px; color: #444; font-style: italic; }
  .cost-section { background: #0d1a0d; border-bottom: 1px solid #1a2a1a; padding: 10px 16px; }
  .cost-title { font-size: 11px; font-weight: bold; color: #3a5a3a; text-transform: uppercase; margin-bottom: 6px; }
  .cost-row { font-size: 12px; color: #6b7280; display: flex; justify-content: space-between; padding: 2px 0; }
  .cost-val { color: #a3e635; font-weight: bold; }
  .cost-total-row { border-top: 1px solid #1a2a1a; margin-top: 4px; padding-top: 6px; color: #9ca3af; font-weight: bold; }
  .cost-badge { font-size: 11px; color: #a3e635; }
  .retell-badge { color: #f59e0b; margin-left: 4px; }
</style>
</head><body>
<h1>Gohlem Call Transcripts</h1>
<div class="sub">${calls.length} call(s) stored &nbsp;·&nbsp; click a call to expand &nbsp;·&nbsp; survives deploys</div>
${calls.length === 0 ? '<div class="empty">No calls yet — make a call and refresh.</div>' : rows}
<script>
  function toggle(idx) {
    document.getElementById('body-' + idx).classList.toggle('open');
    document.getElementById('chev-' + idx).classList.toggle('open');
  }
</script>
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
        name:                i.name,
        quantity:            i.quantity,
        modifiers:           i.modifiers.map(m => m.name),
        specialInstructions: i.specialInstructions || '',
        lineTotal:           i.lineTotal,
      })),
      total: order.total,
    };

    res.json({ transcript, response: responseText, audio, cart });

  } catch (err) {
    log(null, `Voice test error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  log(null, 'DB: DATABASE_URL not set — transcripts will not be saved');
} else {
  transcriptStore.init()
    .then(() => log(null, 'DB: call_transcripts table ready'))
    .catch(err => log(null, `DB init failed: ${err.message || err.code || JSON.stringify(err)}`));
}

const server = http.createServer(app);

if (VOICE_LAYER === 'twilio') {
  // ── TWILIO + DEEPGRAM ─────────────────────────────────────────────────────
  // Registers /voice/inbound, /voice/fallback, and WebSocket at /voice/stream
  twilioHandler.attach(server, app);
  server.listen(PORT, () => {
    log(null, `Gohlem.ai voice server on port ${PORT}`);
    log(null, `Voice layer: Twilio  |  WebSocket: /voice/stream`);
    log(null, `Browser test: GET /voice/test  |  Transcripts: GET /voice/transcripts`);
    log(null, `To switch to Retell: set VOICE_LAYER=retell in Railway`);
  });

} else {
  // ── RETELL (default) ──────────────────────────────────────────────────────
  // Retell connects to wss://your-server/retell/chat/{call_id} via WebSocket
  const retellWss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/retell/chat')) {
      retellWss.handleUpgrade(req, socket, head, ws => retellWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  retellWss.on('connection', (ws, req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean);
    // URL formats:
    //   /retell/chat/{slug}/{call_id}  ← new (each agent has its own slug URL)
    //   /retell/chat/{call_id}         ← old (no slug, defaults to Tony's)
    const callId = parts[parts.length - 1];
    const slug   = parts.length >= 4 ? parts[2] : null;
    retellHandler.handleConnection(ws, callId, slug);
  });

  server.listen(PORT, () => {
    log(null, `Gohlem.ai voice server on port ${PORT}`);
    log(null, `Voice layer: Retell  |  WebSocket: /retell/chat/{slug}/{call_id}`);
    log(null, `Browser test: GET /voice/test  |  Transcripts: GET /voice/transcripts`);
    log(null, `To switch to Twilio: set VOICE_LAYER=twilio in Railway`);
  });
}
