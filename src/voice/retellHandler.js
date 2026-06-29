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

// call_id → { engine, startTime, transcript, ended, promptTokens, completionTokens }
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

// Fetch actual cost from Retell API — requires RETELL_API_KEY in Railway env vars.
// Returns cost in USD (e.g. 0.114) or null if unavailable.
async function fetchRetellCost(callId) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    console.log(`[Retell:${callId.slice(-8)}] RETELL_API_KEY not set — skipping cost fetch`);
    return null;
  }
  try {
    const res = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await res.text();
    if (!res.ok) {
      console.error(`[Retell:${callId.slice(-8)}] Cost fetch HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    let data;
    try { data = JSON.parse(body); } catch { console.error(`[Retell] Cost parse error: ${body.slice(0,100)}`); return null; }

    // call_cost is present but is an OBJECT, not a plain number.
    // Log its structure so we can extract the right sub-field.
    const callCostRaw = data.call_cost;
    if (callCostRaw != null && typeof callCostRaw === 'object') {
      console.log(`[Retell:${callId.slice(-8)}] call_cost object: ${JSON.stringify(callCostRaw)}`);
      // Try the most likely sub-field names for the total
      const total = callCostRaw.combined_cost ?? callCostRaw.total ?? callCostRaw.amount ??
                    callCostRaw.cost ?? callCostRaw.total_cost ?? null;
      if (total != null) {
        // Retell returns combined_cost in cents — divide by 100 for dollars
        const val = Number(total) / 100;
        console.log(`[Retell:${callId.slice(-8)}] Retell call cost: $${val.toFixed(4)} (raw: ${total})`);
        return isNaN(val) ? null : val;
      }
      console.log(`[Retell:${callId.slice(-8)}] call_cost object keys: ${Object.keys(callCostRaw).join(', ')}`);
      return null;
    }

    // Fallback: try top-level number fields
    const flatCost = data.call_cost ?? data.cost_usd ?? data.cost ?? data.total_cost ?? null;
    if (flatCost != null && typeof flatCost === 'number') {
      console.log(`[Retell:${callId.slice(-8)}] Retell call cost: $${flatCost}`);
      return flatCost;
    }

    console.log(`[Retell:${callId.slice(-8)}] Cost not found. Full response: ${body.slice(0, 600)}`);
    return null;
  } catch (err) {
    console.error(`[Retell] Cost fetch exception: ${err.message}`);
    return null;
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

  // GPT-4o-mini pricing: $0.150/1M input, $0.600/1M output
  const llmCostUsd = ((session.promptTokens / 1_000_000) * 0.150) +
                     ((session.completionTokens / 1_000_000) * 0.600);

  console.log(
    `${tag(callId)} Ended — ${duration}s | ${order.items.length} items | $${order.total.toFixed(2)} | ` +
    `tokens: ${session.promptTokens}in/${session.completionTokens}out | LLM cost: $${llmCostUsd.toFixed(5)}`
  );

  // Save transcript immediately (without Retell cost — not yet computed by Retell)
  transcriptStore.save({
    callSid:          callId,
    restaurant:       session.engine.config.restaurantInfo.name,
    startTime:        session.startTime,
    duration,
    items:            order.items.length,
    total:            order.total.toFixed(2),
    transcript:       session.transcript,
    cartItems,
    promptTokens:     session.promptTokens     || null,
    completionTokens: session.completionTokens || null,
    retellCostUsd:    null,
  }).catch(err => console.error(`${tag(callId)} DB save failed: ${err.message}`));

  // Retell finalizes billing a few seconds after the call ends.
  // Fetch and update the cost 15 seconds later.
  setTimeout(async () => {
    const retellCostUsd = await fetchRetellCost(callId);
    if (retellCostUsd != null && retellCostUsd > 0) {
      transcriptStore.updateRetellCost(callId, retellCostUsd)
        .then(() => console.log(`${tag(callId)} Retell cost saved: $${retellCostUsd}`))
        .catch(err => console.error(`${tag(callId)} DB cost update failed: ${err.message}`));
    }
  }, 15000);

  sessions.delete(callId);
}

// slug comes from the URL path: /retell/chat/{slug}/{call_id}
async function handleConnection(ws, callId, slug) {
  const config = getConfig(slug);
  console.log(`${tag(callId)} Connected — slug="${slug}" → restaurant="${config.restaurantInfo.name}"`);

  const session = {
    engine:           new ConversationEngine(config),
    startTime:        Date.now(),
    transcript:       [],
    ended:            false,
    promptTokens:     0,
    completionTokens: 0,
    processing:       false, // lock: prevents parallel response_required handling
  };
  sessions.set(callId, session);

  // Send greeting immediately — Retell v2 doesn't fire call_started first.
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

    // update_only = Retell live transcript updates — no response needed
    if (interaction_type === 'update_only') return;

    console.log(`${tag(callId)} ${interaction_type}`);

    try {
      if (interaction_type === 'call_started' || interaction_type === 'call_details') {
        // Already greeted on connection — nothing to do.
        return;

      } else if (interaction_type === 'response_required' || interaction_type === 'reminder_required') {
        // Retell sends multiple response_required events for the same utterance as STT refines.
        // If we're already processing one, skip the duplicate — only the first one counts.
        if (session.processing) {
          console.log(`${tag(callId)} Skipping duplicate ${interaction_type}`);
          return;
        }
        session.processing = true;

        const userText = lastUserMessage(rtTranscript);
        if (!userText) {
          session.processing = false;
          wsSend(ws, response_id, "I didn't catch that. Could you repeat?", true, false);
          return;
        }

        const userTs = Date.now();
        session.transcript.push({ role: 'customer', text: userText, ts: userTs });

        let message, toolCalls = [], tokenUsage = {};
        try {
          ({ message, toolCalls = [], tokenUsage = {} } = await session.engine.chat(userText));
        } finally {
          session.processing = false;
        }

        const aiTs    = Date.now();
        const latency = aiTs - userTs;

        // Accumulate token usage across all turns
        session.promptTokens     += tokenUsage.promptTokens     || 0;
        session.completionTokens += tokenUsage.completionTokens || 0;

        // Store enriched AI turn in transcript
        const aiEntry = { role: 'ai', text: message, ts: aiTs, latencyMs: latency };
        if (toolCalls.length)             aiEntry.toolCalls = toolCalls;
        if (tokenUsage.promptTokens)      aiEntry.tokens    = tokenUsage;
        session.transcript.push(aiEntry);

        console.log(
          `${tag(callId)} Heard: "${userText}" | ` +
          `[${latency}ms] ${tokenUsage.promptTokens || 0}in/${tokenUsage.completionTokens || 0}out tokens`
        );
        console.log(`${tag(callId)} Speaking: "${message.slice(0, 80)}"`);

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
