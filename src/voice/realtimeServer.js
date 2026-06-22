const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const fs = require('fs');
const Fastify = require('fastify');
const WebSocket = require('ws');

const GohlemMenuEngine = require('../../gohlem-menu-engine');
const { OrderCart } = require('../orders/orderState');
const MenuResolver = require('../orders/menuResolver');
const restaurantConfig = require('../config/restaurantConfig');

// ─── SHARED MENU ENGINE ───────────────────────────────────────────────────────

const MENU_PATH = path.join(__dirname, '../../hot_bagels_menu_with_real_acai_restaurant.json');
const menuData = JSON.parse(fs.readFileSync(MENU_PATH, 'utf8'));
const menuEngine = new GohlemMenuEngine(menuData);
const sharedResolver = new MenuResolver(menuEngine);

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
const VOICE = 'alloy';
const { restaurantInfo } = restaurantConfig;

// Short system prompt — AI calls search_menu instead of receiving the full menu.
const SYSTEM_MESSAGE = `You are Gohlem, a phone ordering assistant for ${restaurantInfo.name} in ${restaurantInfo.location}.

RULES — follow exactly:
1. When call starts, immediately ask: "Will this be for pickup or delivery?"
2. When customer mentions any food item, IMMEDIATELY call search_menu with that item name. Do not respond conversationally first.
3. After search_menu returns results, ask any required modifier questions from the mustAsk list.
4. After customer answers modifier questions, call add_to_cart with the item name and all modifiers collected.
5. "Toasted" "not toasted" "plain bagel" "everything bagel" are modifiers — include them in add_to_cart modifiers array, never search for them.
6. After add_to_cart succeeds, confirm the item was added and ask "Anything else?"
7. When customer says done/that's it/nothing else, call confirm_order then read the summary back.
8. NEVER describe or discuss menu items without first calling search_menu.
9. NEVER add items without calling add_to_cart first.
10. Tool calls are mandatory — they are not optional suggestions.

HOURS: ${restaurantInfo.pickupHours}
KOSHER: Under kosher supervision.
Special terms: lox = smoked salmon, schmear = cream cheese, bourekas = savory pastry.`;

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    name: 'search_menu',
    description: 'Search the menu for items. Always call this before adding to cart.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What the customer is looking for, e.g. "tuna sandwich" or "cold drinks"',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'add_to_cart',
    description: 'Add a confirmed menu item to the order.',
    parameters: {
      type: 'object',
      properties: {
        itemName: { type: 'string', description: 'Item name as found in search_menu results' },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifier choices as customer said them: ["sesame bagel", "toasted", "no tomatoes"]',
        },
        quantity: { type: 'integer', description: 'Number of this item', default: 1 },
        specialInstructions: {
          type: 'string',
          description: 'Free-text preparation notes',
          default: '',
        },
      },
      required: ['itemName'],
    },
  },
  {
    type: 'function',
    name: 'get_cart',
    description: 'Get current order contents and running total.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'confirm_order',
    description: 'Called when customer says they are done. Returns summary for readback.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'transfer_to_human',
    description: 'Transfer to restaurant staff. Use when customer requests a person or order cannot be resolved.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the transfer is needed' },
      },
      required: ['reason'],
    },
  },
];

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function log(id, msg) {
  const tag = id ? String(id).slice(-8) : 'SERVER';
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function logCallSummary(session) {
  const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
  const order = session.cart.getOrder();
  log(session.callSid, `── CALL ENDED ──────────────────────────`);
  log(session.callSid, `Duration : ${duration}s`);
  log(session.callSid, `Items    : ${order.items.length} | Total: $${order.total.toFixed(2)}`);
  log(session.callSid, `Summary  : ${session.cart.getSummary()}`);
  if (session.transcript.length) {
    log(session.callSid, `Transcript:`);
    session.transcript.forEach(t => log(session.callSid, `  [${t.role}] ${t.text}`));
  }
}

// ─── TOOL EXECUTOR ────────────────────────────────────────────────────────────

async function executeTool(name, args, session) {
  log(session.callSid, `Tool: ${name}(${JSON.stringify(args)})`);

  if (name === 'search_menu') {
    const items = menuEngine.findItems(args.query || '', 5);
    if (!items.length) return { found: false, message: 'No items found for that query.' };
    return {
      found: true,
      items: items.map(item => {
        const analysis = menuEngine.analyzeModifiers(item);
        return {
          name: item.name,
          category: item.category,
          price: item.base_price,
          description: item.description || '',
          mustAsk: analysis.mustAsk.map(g => g.name),
        };
      }),
    };
  }

  if (name === 'add_to_cart') {
    const resolved = sharedResolver.resolve({
      itemName: args.itemName,
      modifiers: args.modifiers || [],
      quantity: args.quantity || 1,
      specialInstructions: args.specialInstructions || '',
    });
    if (!resolved.resolved) {
      return { success: false, error: resolved.reason };
    }
    if (resolved.missingRequired.length > 0) {
      return {
        success: false,
        missingRequired: resolved.missingRequired.map(e => e.groupName),
        message: `Please ask for: ${resolved.missingRequired.map(e => e.groupName).join(', ')}`,
      };
    }
    const cartItemId = session.cart.addItem(
      resolved.menuItem,
      resolved.validatedModifiers,
      args.quantity || 1,
      resolved.specialInstructions
    );
    return {
      success: true,
      cartItemId,
      name: resolved.menuItem.name,
      unitPrice: resolved.unitPrice,
      runningTotal: session.cart.getTotal(),
    };
  }

  if (name === 'get_cart') {
    const order = session.cart.getOrder();
    return {
      orderType: order.orderType || 'not set',
      itemCount: order.items.length,
      total: order.total,
      items: order.items.map(i => ({
        name: i.name,
        quantity: i.quantity,
        modifiers: i.modifiers.map(m => m.name),
        specialInstructions: i.specialInstructions || '',
        lineTotal: i.lineTotal,
      })),
    };
  }

  if (name === 'confirm_order') {
    const order = session.cart.getOrder();
    return {
      summary: session.cart.getSummary(),
      itemCount: order.items.length,
      total: order.total,
      orderType: order.orderType || 'not set — ask customer',
      readyToConfirm: order.items.length > 0,
    };
  }

  if (name === 'transfer_to_human') {
    session.transferring = true;
    log(session.callSid, `Transfer requested: ${args.reason}`);
    const phone = process.env.RESTAURANT_PHONE || 'the restaurant directly';
    return {
      success: true,
      message: `Transferring now. Restaurant: ${phone}`,
    };
  }

  return { error: `Unknown tool: ${name}` };
}

// ─── FASTIFY SETUP ────────────────────────────────────────────────────────────

const fastify = Fastify({ logger: false });
fastify.register(require('@fastify/formbody'));
fastify.register(require('@fastify/websocket'));

// ─── ROUTES ───────────────────────────────────────────────────────────────────

fastify.get('/health', async (_req, reply) => {
  reply.send({
    status: 'ok',
    restaurant: restaurantInfo.name,
    activeCalls: sessions.size,
    model: 'gpt-4o-realtime-preview',
  });
});

fastify.post('/voice/inbound', async (request, reply) => {
  const callSid = request.body?.CallSid || 'unknown';
  const rawHost = process.env.SERVER_URL
    ? process.env.SERVER_URL.replace(/^https?:\/\//, '')
    : request.headers.host;

  log(callSid, 'Inbound call → opening Realtime stream');

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${rawHost}/voice/stream" />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twiml);
});

// ─── PER-CALL SESSIONS ────────────────────────────────────────────────────────

const sessions = new Map(); // streamSid → session

// ─── WEBSOCKET BRIDGE ─────────────────────────────────────────────────────────

fastify.get('/voice/stream', { websocket: true }, (twilioSocket, _req) => {
  let session = null;
  let openAiWs = null;

  // ── Twilio events ─────────────────────────────────────────────────────────
  // OpenAI WS is opened AFTER session is created from the 'start' event so
  // that tool calls are never dispatched against a null session.

  twilioSocket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.event === 'connected') return; // handshake only

    // ── start: session created → NOW open OpenAI WS ──────────────────────────
    if (msg.event === 'start') {
      const { callSid, streamSid } = msg.start;
      session = {
        callSid,
        streamSid,
        cart: new OrderCart(),
        startTime: Date.now(),
        transcript: [],
        transferring: false,
      };
      sessions.set(streamSid, session);
      log(callSid, `Stream started (${streamSid}) — connecting to OpenAI`);

      // Open OpenAI Realtime WebSocket now that session is guaranteed to exist
      openAiWs = new WebSocket(REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      openAiWs.on('open', () => {
        log(session.callSid, 'OpenAI Realtime connected');
      });

      openAiWs.on('message', async (data) => {
        let event;
        try { event = JSON.parse(data); } catch { return; }

        if (event.type !== 'response.audio.delta' && event.type !== 'response.output_audio.delta') {
          log(session?.callSid || 'OPENAI', `EVENT: ${event.type}`);
        }

        // ── Session created → send config ────────────────────────────────────
        if (event.type === 'session.created') {
          const sessionUpdate = {
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions: SYSTEM_MESSAGE,
              voice: VOICE,
              input_audio_format: 'g711_ulaw',
              output_audio_format: 'g711_ulaw',
              input_audio_transcription: { model: 'whisper-1' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 800,
              },
              tools: TOOLS,
              tool_choice: 'auto',
              temperature: 0.7,
            },
          };
          openAiWs.send(JSON.stringify(sessionUpdate));

          // Trigger initial greeting after config settles
          setTimeout(() => {
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['text', 'audio'],
                  instructions: 'Greet the customer warmly and ask: will this be for pickup or delivery?',
                },
              }));
            }
          }, 300);
        }

        // ── Audio from AI → forward to Twilio ────────────────────────────────
        if ((event.type === 'response.audio.delta' || event.type === 'response.output_audio.delta')
            && event.delta && session?.streamSid) {
          try {
            twilioSocket.send(JSON.stringify({
              event: 'media',
              streamSid: session.streamSid,
              media: { payload: event.delta },
            }));
          } catch {}
        }

        // ── Barge-in: user spoke while AI was talking ────────────────────────
        if (event.type === 'input_audio_buffer.speech_started' && session?.streamSid) {
          try {
            twilioSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
          } catch {}
        }

        // ── Tool call — session is always set here ───────────────────────────
        if (event.type === 'response.function_call_arguments.done') {
          let args = {};
          try { args = JSON.parse(event.arguments || '{}'); } catch {}

          const result = await executeTool(event.name, args, session);

          openAiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: event.call_id,
              output: JSON.stringify(result),
            },
          }));
          openAiWs.send(JSON.stringify({ type: 'response.create' }));
        }

        // ── AI speech transcript (for log) ───────────────────────────────────
        if (event.type === 'response.audio_transcript.done' && session) {
          session.transcript.push({ role: 'ai', text: event.transcript });
        }

        // ── Customer speech transcript ───────────────────────────────────────
        if (event.type === 'conversation.item.input_audio_transcription.completed' && session) {
          session.transcript.push({ role: 'customer', text: event.transcript });
        }

        // ── Errors ───────────────────────────────────────────────────────────
        if (event.type === 'error') {
          log(session?.callSid, `OpenAI error: ${JSON.stringify(event.error)}`);
        }
      });

      openAiWs.on('error', (err) => {
        log(session?.callSid, `OpenAI WS error: ${err.message}`);
      });

      openAiWs.on('close', () => {
        log(session?.callSid, 'OpenAI WS closed');
      });
    }

    // ── media: forward audio to OpenAI (openAiWs set after 'start') ──────────
    if (msg.event === 'media') {
      if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload,
        }));
      }
    }

    if (msg.event === 'stop') {
      teardown('Twilio stop');
    }
  });

  twilioSocket.on('close', () => teardown('WebSocket closed'));
  twilioSocket.on('error', (err) => log(session?.callSid, `Twilio WS error: ${err.message}`));

  // ── Teardown ───────────────────────────────────────────────────────────────

  function teardown(reason) {
    if (!session) return;
    const s = session;
    session = null;

    sessions.delete(s.streamSid);
    logCallSummary(s);
    log(s.callSid, `Ended — ${reason}`);

    try { if (openAiWs) openAiWs.close(); } catch {}
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  log(null, `Gohlem.ai Realtime server on port ${PORT}`);
  log(null, `Restaurant: ${restaurantInfo.name}`);
  log(null, `Model: gpt-4o-realtime-preview  Voice: ${VOICE}`);
  log(null, `Routes: POST /voice/inbound  GET /voice/stream  GET /health`);
});
