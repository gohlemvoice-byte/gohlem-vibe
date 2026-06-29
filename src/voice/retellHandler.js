'use strict';

const ConversationEngine = require('../conversation/conversationEngine');
const transcriptStore    = require('../db/transcriptStore');
const restaurantConfig   = require('../config/restaurantConfig');
const hotBagelsConfig    = require('../config/hotBagelsConfig');
const sushiSpotConfig    = require('../config/sushiSpotConfig');
const pizzaPlaceConfig   = require('../config/pizzaPlaceConfig');

// Map Retell agent_id → restaurant config.
// Set these in Railway env vars, then add your Retell agent IDs there.
// Example: RETELL_AGENT_HOTBAGELS=agent_abc123
const AGENT_RESTAURANT_MAP = {
  [process.env.RETELL_AGENT_TONYS]:     restaurantConfig,
  [process.env.RETELL_AGENT_HOTBAGELS]: hotBagelsConfig,
  [process.env.RETELL_AGENT_SUSHI]:     sushiSpotConfig,
  [process.env.RETELL_AGENT_PIZZA]:     pizzaPlaceConfig,
};

// call_id → { engine, startTime, transcript, lastUserTs, ended }
const sessions = new Map();

// Purge sessions idle more than 60 minutes (handles missed call_ended events)
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
  return lower.includes('goodbye') ||
         lower.includes('take care') ||
         lower.includes('order has been placed') ||
         lower.includes('have a great');
}

// Retell SSE format: each event is a JSON line prefixed with "data: "
function sseChunk(res, responseId, content, contentComplete, endCall = false) {
  res.write(`data: ${JSON.stringify({
    response_id:      responseId,
    content,
    content_complete: contentComplete,
    end_call:         endCall,
  })}\n\n`);
}

// Stream sentence-by-sentence so Retell's TTS starts playing the first
// sentence while subsequent sentences are still being sent.
function streamText(res, responseId, text, endCall = false) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (let i = 0; i < sentences.length; i++) {
    const isLast  = i === sentences.length - 1;
    const content = sentences[i] + (isLast ? '' : ' ');
    sseChunk(res, responseId, content, isLast, isLast && endCall);
  }
}

function tag(callId) {
  return `[${new Date().toISOString()}] [Retell:${callId.slice(-8)}]`;
}

async function saveAndCleanup(callId, session) {
  if (session.ended) return;
  session.ended = true;

  const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
  const order    = session.engine.cart.getOrder();

  console.log(`${tag(callId)} Ended — ${duration}s | ${order.items.length} items | $${order.total.toFixed(2)}`);

  transcriptStore.save({
    callSid:    callId,
    restaurant: session.engine.config.restaurantInfo.name,
    startTime:  session.startTime,
    duration,
    items:      order.items.length,
    total:      order.total.toFixed(2),
    transcript: session.transcript,
  }).catch(err => console.error(`${tag(callId)} DB save failed: ${err.message}`));

  sessions.delete(callId);
}

async function handleWebhook(req, res) {
  // Retell Custom LLM webhook payload:
  // { call_id, agent_id, transcript: [{role:'agent'|'user', content}], interaction_type, response_id }
  const {
    call_id,
    agent_id,
    transcript    = [],
    interaction_type,
    response_id   = 0,
  } = req.body;

  if (!call_id) return res.status(400).json({ error: 'call_id required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  console.log(`${tag(call_id)} ${interaction_type}`);

  try {
    // ── CALL STARTED ────────────────────────────────────────────────────────────
    if (interaction_type === 'call_started') {
      const config  = getConfig(agent_id);
      const session = {
        engine:     new ConversationEngine(config),
        startTime:  Date.now(),
        transcript: [],
        lastUserTs: null,
        ended:      false,
      };
      sessions.set(call_id, session);

      const { message } = await session.engine.open();
      session.transcript.push({ role: 'ai', text: message, ts: Date.now(), latencyMs: null });

      console.log(`${tag(call_id)} Greeting: "${message.slice(0, 80)}"`);
      streamText(res, response_id, message, false);

    // ── CUSTOMER SPOKE ──────────────────────────────────────────────────────────
    } else if (interaction_type === 'response_required' || interaction_type === 'reminder_required') {
      let session = sessions.get(call_id);

      // Session missing (server restarted mid-call) — rebuild with no history
      if (!session) {
        console.log(`${tag(call_id)} Session missing — rebuilding`);
        const config = getConfig(agent_id);
        session = {
          engine:     new ConversationEngine(config),
          startTime:  Date.now(),
          transcript: [],
          lastUserTs: null,
          ended:      false,
        };
        sessions.set(call_id, session);
        await session.engine.open();
      }

      const userText = lastUserMessage(transcript);
      if (!userText) {
        sseChunk(res, response_id, "I didn't catch that. Could you repeat?", true, false);
        return res.end();
      }

      const userTs = Date.now();
      session.transcript.push({ role: 'customer', text: userText, ts: userTs });

      const { message } = await session.engine.chat(userText);

      const aiTs    = Date.now();
      const latency = aiTs - userTs;
      session.transcript.push({ role: 'ai', text: message, ts: aiTs, latencyMs: latency });

      console.log(`${tag(call_id)} Heard: "${userText}"`);
      console.log(`${tag(call_id)} Speaking [${latency}ms]: "${message.slice(0, 80)}"`);

      const endCall = isEndOfCall(message);
      streamText(res, response_id, message, endCall);

      if (endCall) await saveAndCleanup(call_id, session);

    // ── CALL ENDED ──────────────────────────────────────────────────────────────
    } else if (interaction_type === 'call_ended') {
      const session = sessions.get(call_id);
      if (session) await saveAndCleanup(call_id, session);
      sseChunk(res, response_id, '', true, true);

    // ── OTHER (update_only, etc.) ────────────────────────────────────────────────
    } else {
      sseChunk(res, response_id, '', true, false);
    }

  } catch (err) {
    console.error(`${tag(call_id)} Error: ${err.message}`);
    sseChunk(res, response_id, "I'm having some trouble. Let me get someone to help you.", true, true);
    const session = sessions.get(call_id);
    if (session) await saveAndCleanup(call_id, session);
  }

  res.end();
}

function getActiveCallCount() {
  return sessions.size;
}

module.exports = { handleWebhook, getActiveCallCount };
