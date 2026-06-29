'use strict';

const ConversationEngine = require('../conversation/conversationEngine');
const transcriptStore    = require('../db/transcriptStore');
const restaurantConfig   = require('../config/restaurantConfig');
const hotBagelsConfig    = require('../config/hotBagelsConfig');
const sushiSpotConfig    = require('../config/sushiSpotConfig');
const pizzaPlaceConfig   = require('../config/pizzaPlaceConfig');

const AGENT_RESTAURANT_MAP = {
  [process.env.RETELL_AGENT_TONYS]:     restaurantConfig,
  [process.env.RETELL_AGENT_HOTBAGELS]: hotBagelsConfig,
  [process.env.RETELL_AGENT_SUSHI]:     sushiSpotConfig,
  [process.env.RETELL_AGENT_PIZZA]:     pizzaPlaceConfig,
};

// call_id → { engine, startTime, transcript, ended }
const sessions = new Map();

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.startTime < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000);

function getConfig(agentId) {
  return (agentId && AGENT_RESTAURANT_MAP[agentId]) || restaurantConfig;
}

function lastUserMessage(transcript) {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === 'user') return transcript[i].content;
  }
  return null;
}

function isEndOfCall(text) {
  const lower = text.toLowerCase();
  return lower.includes('goodbye') || lower.includes('take care') ||
         lower.includes('order has been placed') || lower.includes('have a great');
}

function tag(callId) {
  return `[${new Date().toISOString()}] [Retell:${callId.slice(-8)}]`;
}

// Retell WebSocket format: send JSON objects back on the same WS connection.
// ws.readyState 1 = OPEN
function wsSend(ws, responseId, content, contentComplete, endCall = false) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    response_id:      responseId,
    content,
    content_complete: contentComplete,
    end_call:         endCall,
  }));
}

// Stream sentence-by-sentence so Retell's TTS starts playing the first sentence
// while remaining sentences are still being sent.
function streamText(ws, responseId, text, endCall = false) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (let i = 0; i < sentences.length; i++) {
    const isLast = i === sentences.length - 1;
    wsSend(ws, responseId, sentences[i] + (isLast ? '' : ' '), isLast, isLast && endCall);
  }
}

async function saveAndCleanup(callId, session) {
  if (session.ended) return;
  session.ended = true;

  const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
  const order    = session.engine.cart.getOrder();
  const cartItems = order.items.map(i => ({
    name:                i.name,
    quantity:            i.quantity,
    modifiers:           i.modifiers.map(m => m.name),
    specialInstructions: i.specialInstructions || '',
    lineTotal:           i.lineTotal,
  }));

  console.log(`${tag(callId)} Ended — ${duration}s | ${order.items.length} items | $${order.total.toFixed(2)}`);

  transcriptStore.save({
    callSid:    callId,
    restaurant: session.engine.config.restaurantInfo.name,
    startTime:  session.startTime,
    duration,
    items:      order.items.length,
    total:      order.total.toFixed(2),
    transcript: session.transcript,
    cartItems,
  }).catch(err => console.error(`${tag(callId)} DB save failed: ${err.message}`));

  sessions.delete(callId);
}

// Called by voiceServer.js once per WebSocket connection from Retell.
// callId comes from the URL path: /retell/chat/{call_id}
async function handleConnection(ws, callId) {
  console.log(`${tag(callId)} WebSocket connected`);
  let session = null;

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // Retell sends: { interaction_type, response_id, call: { call_id, agent_id, ... }, transcript: [...] }
    const { interaction_type, response_id = 0, transcript: rtTranscript = [], call = {} } = data;
    const agentId = call.agent_id;

    console.log(`${tag(callId)} ${interaction_type}`);

    try {
      // ── CALL STARTED ──────────────────────────────────────────────────────────
      if (interaction_type === 'call_started') {
        const config = getConfig(agentId);
        session = {
          engine:     new ConversationEngine(config),
          startTime:  Date.now(),
          transcript: [],
          ended:      false,
        };
        sessions.set(callId, session);

        const { message } = await session.engine.open();
        session.transcript.push({ role: 'ai', text: message, ts: Date.now(), latencyMs: null });
        console.log(`${tag(callId)} Greeting: "${message.slice(0, 80)}"`);
        streamText(ws, response_id, message, false);

      // ── CUSTOMER SPOKE ────────────────────────────────────────────────────────
      } else if (interaction_type === 'response_required' || interaction_type === 'reminder_required') {
        // Session missing (server restarted mid-call) — rebuild
        if (!session) {
          console.log(`${tag(callId)} Session missing — rebuilding`);
          const config = getConfig(agentId);
          session = {
            engine:     new ConversationEngine(config),
            startTime:  Date.now(),
            transcript: [],
            ended:      false,
          };
          sessions.set(callId, session);
          await session.engine.open();
        }

        const userText = lastUserMessage(rtTranscript);
        if (!userText) {
          wsSend(ws, response_id, "I didn't catch that. Could you repeat?", true, false);
          return;
        }

        const userTs = Date.now();
        session.transcript.push({ role: 'customer', text: userText, ts: userTs });

        const { message } = await session.engine.chat(userText);

        const aiTs    = Date.now();
        const latency = aiTs - userTs;
        session.transcript.push({ role: 'ai', text: message, ts: aiTs, latencyMs: latency });

        console.log(`${tag(callId)} Heard: "${userText}"`);
        console.log(`${tag(callId)} Speaking [${latency}ms]: "${message.slice(0, 80)}"`);

        const endCall = isEndOfCall(message);
        streamText(ws, response_id, message, endCall);
        if (endCall) await saveAndCleanup(callId, session);

      // ── CALL ENDED ────────────────────────────────────────────────────────────
      } else if (interaction_type === 'call_ended') {
        if (session) await saveAndCleanup(callId, session);

      } else {
        wsSend(ws, response_id, '', true, false);
      }

    } catch (err) {
      console.error(`${tag(callId)} Error: ${err.message}`);
      wsSend(ws, response_id, "I'm having some trouble. Let me get someone to help you.", true, true);
      if (session) await saveAndCleanup(callId, session);
    }
  });

  ws.on('close', async () => {
    console.log(`${tag(callId)} WebSocket closed`);
    if (session && !session.ended) await saveAndCleanup(callId, session);
  });

  ws.on('error', (err) => {
    console.error(`${tag(callId)} WS error: ${err.message}`);
  });
}

function getActiveCallCount() { return sessions.size; }

module.exports = { handleConnection, getActiveCallCount };
