'use strict';

const ConversationEngine = require('../conversation/conversationEngine');
const transcriptStore    = require('../db/transcriptStore');
const restaurantConfig   = require('../config/restaurantConfig');
const hotBagelsConfig    = require('../config/hotBagelsConfig');
const sushiSpotConfig    = require('../config/sushiSpotConfig');
const pizzaPlaceConfig   = require('../config/pizzaPlaceConfig');

// Route by URL slug — each Retell agent has its own Custom LLM URL:
//   https://server/retell/chat/tonys     → Tony's
//   https://server/retell/chat/hotbagels → Hot Bagels
//   https://server/retell/chat/sushi     → That Sushi Spot
//   https://server/retell/chat/pizza     → The Pizza Place
const SLUG_MAP = {
  'tonys':     restaurantConfig,
  'hotbagels': hotBagelsConfig,
  'sushi':     sushiSpotConfig,
  'pizza':     pizzaPlaceConfig,
};

console.log(`[Retell] Restaurant slugs: ${Object.keys(SLUG_MAP).join(', ')}`);

// call_id → { engine, startTime, transcript, ended }
const sessions = new Map();

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.startTime < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000);

function getConfig(slug) {
  const config = SLUG_MAP[slug];
  if (!config) console.log(`[Retell] Unknown slug "${slug}" — defaulting to Tony's`);
  return config || restaurantConfig;
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

function wsSend(ws, responseId, content, contentComplete, endCall = false) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    response_id:      responseId,
    content,
    content_complete: contentComplete,
    end_call:         endCall,
  }));
}

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

  const duration  = ((Date.now() - session.startTime) / 1000).toFixed(1);
  const order     = session.engine.cart.getOrder();
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

// slug comes from the URL path: /retell/chat/{slug}/{call_id}
// voiceServer.js extracts both and passes them here.
async function handleConnection(ws, callId, slug) {
  const config = getConfig(slug);
  console.log(`${tag(callId)} Connected — slug="${slug}" → restaurant="${config.restaurantInfo.name}"`);

  const session = {
    engine:     new ConversationEngine(config),
    startTime:  Date.now(),
    transcript: [],
    ended:      false,
  };
  sessions.set(callId, session);

  // Send greeting immediately on connection.
  // Retell v2 does NOT send call_started — it goes straight to update_only/response_required.
  // The greeting must be pushed as soon as the WebSocket opens.
  try {
    const { message } = await session.engine.open();
    session.transcript.push({ role: 'ai', text: message, ts: Date.now(), latencyMs: null });
    console.log(`${tag(callId)} Greeting: "${message.slice(0, 80)}"`);
    streamText(ws, 0, message, false);
  } catch (err) {
    console.error(`${tag(callId)} Greeting error: ${err.message}`);
  }

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    const { interaction_type, response_id = 0, transcript: rtTranscript = [] } = data;

    // update_only = Retell sending live transcript updates, no response needed
    if (interaction_type === 'update_only') return;

    console.log(`${tag(callId)} ${interaction_type}`);

    try {
      if (interaction_type === 'call_started' || interaction_type === 'call_details') {
        // Already greeted on connection — nothing to do here.
        return;

      } else if (interaction_type === 'response_required' || interaction_type === 'reminder_required') {
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

      } else if (interaction_type === 'call_ended') {
        await saveAndCleanup(callId, session);

      } else {
        console.log(`${tag(callId)} Unhandled: "${interaction_type}"`);
      }

    } catch (err) {
      console.error(`${tag(callId)} Error: ${err.message}`);
      wsSend(ws, response_id, "I'm having some trouble. Let me get someone to help you.", true, true);
      await saveAndCleanup(callId, session);
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
