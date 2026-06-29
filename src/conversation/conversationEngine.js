'use strict';

require('dotenv').config();
const path = require('path');
const OpenAI = require('openai');

const MenuEngine = require('../../gohlem-menu-engine');
const { OrderCart } = require('../orders/orderState');
const ToolHandler = require('../tools/toolHandler');
const TOOL_DEFINITIONS = require('../tools/definitions');

const MAX_TOOL_ITERATIONS = 12; // safety guard against infinite tool loops
const HUMAN_FALLBACK_THRESHOLD = 2; // failures before offering human transfer

class ConversationEngine {
  constructor(restaurantConfig) {
    this.config = restaurantConfig;

    // Load menu
    this.menuEngine = new MenuEngine().loadMenu(restaurantConfig.menuFile);

    // Cart
    this.cart = new OrderCart();

    // Tool handler (holds the valid set and all tool implementations)
    this.toolHandler = new ToolHandler(this.menuEngine, this.cart, restaurantConfig);

    // OpenAI client
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Conversation history — does NOT include system prompt (sent separately each turn)
    this.history = [];

    // Delivery address (captured mid-conversation)
    this.deliveryAddress = null;

    // Turn counter: increments on each user message, used by toolHandler for Guard 6.
    this.turnId = 0;

    // Human fallback: tracks failed item queries
    this.failureCounter = new Map();

    // Build system prompt once (static per session)
    this.systemPrompt = this._buildSystemPrompt();
  }

  // ─── PUBLIC API ─────────────────────────────────────────────────────────────

  async open() {
    const { name, version } = this.config.restaurantInfo;
    const greeting = `Thank you for calling ${name}! You've reached our automated ordering system, version ${version}. Will this be for pickup or delivery today?`;
    this.history.push({ role: 'assistant', content: greeting });
    return { message: greeting };
  }

  async chat(userText) {
    this.history.push({ role: 'user', content: userText });

    // Advance turn counter and reset per-turn state in tool handler.
    this.turnId++;
    this.toolHandler.beginTurn(this.turnId);

    // Detect pickup/delivery from user text — store on cart
    this._captureOrderType(userText);

    // Detect delivery address if in delivery mode
    if (this.cart.orderType === 'delivery' && !this.cart.deliveryAddress) {
      this._captureDeliveryAddress(userText);
    }

    const response = await this._runToolLoop();
    this.history.push({ role: 'assistant', content: response });
    return { message: response };
  }

  // ─── TOOL CALLING LOOP ──────────────────────────────────────────────────────

  async _runToolLoop() {
    let iterations = 0;
    let searchCalledThisTurn = false;  // B01: track whether search_menu was called
    const currentTurnToolCalls = [];   // B04: log all tool calls for investigation

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      // Keep last 28 messages to limit token usage per API call.
      // Tool calls add 2-3 messages per turn, so 12 was stripping too much context
      // and causing the AI to lose conversation state mid-call.
      // Never start in the middle of a tool exchange: drop leading messages until
      // we reach a clean boundary (user message, or plain assistant message).
      // A "tool" message without its preceding assistant+tool_calls is orphaned
      // and will cause a 400 from the API.
      let trimmedHistory = this.history.slice(-28);
      while (trimmedHistory.length > 0) {
        const first = trimmedHistory[0];
        if (first.role === 'user') break;
        if (first.role === 'assistant' && !(first.tool_calls && first.tool_calls.length)) break;
        trimmedHistory = trimmedHistory.slice(1);
      }

      // Inject confirmed order state as a persistent system message so it
      // survives history trimming. Without this, the AI loses pickup/delivery
      // context once early messages scroll out of the 12-message window and
      // restarts the greeting flow mid-conversation.
      const persistentState = [];
      if (this.cart.orderType) {
        let stateNote = `[Order state: customer has already confirmed "${this.cart.orderType}" — do NOT ask about pickup or delivery again.`;
        if (this.cart.deliveryAddress) {
          stateNote += ` Delivery address already captured: "${this.cart.deliveryAddress}".`;
        }
        const order = this.cart.getOrder();
        if (order.items.length > 0) {
          const itemSummary = order.items
            .map((it, i) => `${i + 1}. ${it.quantity}x ${it.name}${it.modifiers.length ? ' (' + it.modifiers.map(m => m.name).join(', ') + ')' : ''}`)
            .join('; ');
          stateNote += ` Cart so far (${order.items.length} item(s)): ${itemSummary}.`;
        }
        stateNote += ']';
        persistentState.push({ role: 'system', content: stateNote });
      }

      const res = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: this.systemPrompt },
          ...persistentState,
          ...trimmedHistory,
        ],
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
        temperature: 0.2,
        max_tokens: 600,
      });

      const msg = res.choices[0].message;

      // No tool calls — this is the final spoken response
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const responseText = msg.content || "I'm sorry, I didn't catch that. Could you repeat?";

        // B01: intercept denial language when no search was called this turn.
        // If the AI says "we don't have X" without ever calling search_menu, force a search.
        const hasDenialLanguage = /\b(don't have|not on (our |the )?menu|we don't carry|not (currently )?available|do not (currently )?have|we don't (currently )?offer|isn't on our menu|not something we (carry|have|offer))\b/i.test(responseText);
        if (hasDenialLanguage && !searchCalledThisTurn) {
          this.history.push({
            role: 'user',
            content: '[System alert: You responded with denial language but did not call search_menu first. You MUST call search_menu before telling a customer an item is unavailable. Call search_menu now for the customer\'s request.]',
          });
          continue;
        }

        // B04 investigation: log when human fallback is triggered.
        // Do NOT change fallback behavior — log only until root cause is known.
        if (/connect you (with|to) someone|transfer you|let me get someone/i.test(responseText)) {
          console.log('[B04] Human fallback triggered on turn', this.turnId);
          console.log('[B04] Tool calls this turn:', JSON.stringify(currentTurnToolCalls));
          console.log('[B04] Cart state:', JSON.stringify(this.toolHandler._getCart()));
        }

        return responseText;
      }

      // Process tool calls and add results to history
      this.history.push(msg);

      for (const call of msg.tool_calls) {
        let args;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = {};
        }

        if (call.function.name === 'search_menu') searchCalledThisTurn = true;
        currentTurnToolCalls.push({ name: call.function.name, args });

        const result = this.toolHandler.execute(call.function.name, args);
        this._trackFailures(call.function.name, args, result);

        // B13: when add_to_cart fails with MISSING_REQUIRED, check if the customer
        // mentioned special instructions earlier and remind the AI to include them on retry.
        if (call.function.name === 'add_to_cart' && result.error === 'MISSING_REQUIRED') {
          const specialHint = this._extractSpecialInstructionsFromHistory();
          if (specialHint) {
            result.special_instructions_reminder =
              `Customer previously said: "${specialHint}" — when retrying add_to_cart after getting the modifier answer, pass this in special_instructions.`;
          }
        }

        this.history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    // Safety fallback if tool loop hits max iterations
    return "I'm having trouble with that. Let me connect you with someone who can help.";
  }

  // B13 helper: scan recent user messages for special instruction keywords.
  _extractSpecialInstructionsFromHistory() {
    const keywords = [
      'harif', 'charif', 'spicy', 'extra crispy', 'well done', 'medium', 'rare',
      'toasted', 'untoasted', 'light sauce', 'extra sauce', 'no onion', 'no lettuce',
      'no tomato', 'extra pickles', 'no pickles', 'crispy', 'burnt', 'light ice',
      'no ice', 'extra cheese', 'no cheese',
    ];
    const userMsgs = this.history
      .filter(m => m.role === 'user' && !m.content.startsWith('[System'))
      .slice(-4);
    for (const msg of [...userMsgs].reverse()) {
      const lower = msg.content.toLowerCase();
      const found = keywords.filter(kw => lower.includes(kw));
      if (found.length > 0) return found.join(', ');
    }
    return null;
  }

  // ─── ORDER TYPE & ADDRESS CAPTURE ───────────────────────────────────────────

  _captureOrderType(text) {
    const lower = text.toLowerCase();
    if (/\bpickup\b|\bpick up\b|\bpick-up\b|\bfor pick\b/.test(lower)) {
      this.cart.orderType = 'pickup';
    } else if (/\bdelivery\b|\bdeliver\b|\bdeliver to\b/.test(lower)) {
      this.cart.orderType = 'delivery';
    }
  }

  _captureDeliveryAddress(text) {
    // Heuristic: if the text contains a number followed by words, treat as an address.
    // This is intentionally simple — the AI is already instructed to ask for the address.
    const match = text.match(/\d+\s+[a-zA-Z].{5,}/);
    if (match) {
      this.cart.deliveryAddress = match[0].trim();
    }
  }

  // ─── FAILURE TRACKING ───────────────────────────────────────────────────────

  _trackFailures(toolName, args, result) {
    if (toolName !== 'search_menu') return;
    if (result.found) {
      this.failureCounter.delete(args.query);
      return;
    }
    const count = (this.failureCounter.get(args.query) || 0) + 1;
    this.failureCounter.set(args.query, count);
  }

  needsHumanFallback(query) {
    return (this.failureCounter.get(query) || 0) >= HUMAN_FALLBACK_THRESHOLD;
  }

  // ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────

  _buildSystemPrompt() {
    const { restaurantInfo, specialTerminology, faqKnowledgeBase, storeSpecificInstructions } = this.config;

    return `You are the ordering assistant for ${restaurantInfo.name}. You take phone orders accurately and naturally, exactly like a skilled human order taker.

VOICE FORMAT — READ THIS FIRST:
You are speaking on a phone call. Your words are read aloud by a text-to-speech engine.
- NEVER use markdown. No asterisks, no stars, no bullet points, no dashes, no bold, no numbered lists.
- NEVER read out a list of options unless the customer explicitly asks "what are my options?" or "what do you have?"
- When a required modifier is missing, ask for it in ONE natural question: "What bagel would you like with that?" — not a list of 15 options.
- Keep every response to 1 to 3 spoken sentences. Short and natural.
- When confirming an item was added, say it conversationally: "Got it, one tuna sandwich on sesame with pickles." Not a formatted summary.
- When reading back the full order at confirmation, speak it naturally like a person: "You have a tuna sandwich on sesame, a large coffee, and a challah. Total is twenty-two dollars."
- Never say "star star" or read punctuation symbols out loud. Never use formatting characters in your speech.
- Do NOT say "one moment please" or "let me search for that" or narrate that you are searching. Execute searches silently. If you need to acknowledge before the result is ready, say "Sure" or "Got it" — one word only.

TOOLS AVAILABLE:
- search_menu(query): Search for menu items. Call this BEFORE every add_to_cart — no exceptions.
- add_to_cart(item_id, modifier_option_ids, quantity, special_instructions): Add to order. ALL IDs must come from this turn's search_menu response.
- remove_from_cart(cart_item_id): Remove an item.
- update_cart_item(cart_item_id, ...): Modify an existing cart item.
- get_cart(): Get the current order state.

CRITICAL TOOL RULES:
1. ALWAYS call search_menu before add_to_cart. Every single item. No shortcuts.
1a. When calling search_menu, pass ONLY the base item name — never include modifier words. Search "california roll", not "california roll with brown rice". Search "tuna sandwich", not "tuna sandwich on sesame toasted". Modifiers are resolved separately via modifier_option_ids in add_to_cart.
2. Only pass item_id and modifier_option_ids from the search_menu response. Never guess IDs.
3. If search_menu returns clarification_needed: true — ask the customer to choose which item before calling add_to_cart.
4. If add_to_cart returns error MISSING_REQUIRED — ask the customer for those modifier choices, then call add_to_cart again.
5. If add_to_cart returns error PRICE_ANOMALY — say the price to the customer and ask them to confirm.
6. If add_to_cart returns error RESTRICTION_CATERING — inform the customer about the 24-48 hour advance notice requirement.
7. After two search failures for the same item — offer to connect the customer with a human.
8. NEVER tell a customer an item is not on the menu without calling search_menu first. If a customer asks "do you have espresso?" or "what hot drinks do you have?" — call search_menu("espresso") or search_menu("hot drinks") BEFORE answering. Never deny a menu item from memory. This applies to EVERY category including drinks, desserts, sides — anything.
9. Only call get_cart() when: (a) the customer has said they are done and you need to read back the full order, or (b) you need a cart_item_id for an update or removal. Do NOT call get_cart() after every item add — the add_to_cart response already confirms what was added.
10. NEVER suggest a specific item by name unless you have seen it in a search_menu result this session. Do not use general restaurant knowledge to suggest items. If the customer asks for alternatives, call search_menu first, then suggest from what the results actually contain.
11. ALWAYS use the TOP-SCORED search result. Never substitute a lower-ranked item because the top result does not support a modifier the customer mentioned. If the top result has no such modifier option, add it as-is and say "The [item] doesn't come with a rice/sauce/side choice — I've added it as-is." Do not pick a different item that happens to have that modifier.

CONVERSATION FLOW:
1. Greet and ask: pickup or delivery?
2. If delivery: ask for their full delivery address.
3. Take the order item by item. Search before each item.
4. When customer says they're done: call get_cart, then read back the complete order naturally. State the total.
5. Get the customer's confirmation.
6. After confirmation: thank them warmly and end the call.

ORDERING RULES:
- ONLY call add_to_cart when the customer has clearly and explicitly stated they want to ORDER something. Clear signals: "I want", "I'll have", "give me", "can I get", "add", "I'll take", "order me". Ambiguous words, questions, or unclear sounds are NOT ordering signals — ask first.
- Never add an item the customer only asked about. "Do you have X?" is a question, not an order. Only add if they say "yes" or "I'll take it" after you describe it.
- Never state a price you haven't received from a tool response.
- MULTI-ITEM ORDERS: When the customer names multiple items in one sentence, you MUST add ALL of them before generating any spoken response. Your tool calls must include search_menu + add_to_cart for EVERY item the customer mentioned. If you added 2 items and the customer mentioned 3, search and add the 3rd BEFORE producing any text. Never stop mid-list to ask a question or confirm — finish all adds first, then speak.

- When customer changes their mind, use update_cart_item or remove_from_cart.
- When customer asks what's on the pizza / what toppings are available — call search_menu for that item and read the modifier options from the result.

MODIFIER RULES:
- REQUIRED modifiers (required: true): You must have a selection before calling add_to_cart. If the customer mentioned the modifier in their order (e.g., "large", "thin crust", "boneless", "medium", "brown rice"), map it to the matching option ID and add_to_cart immediately — do NOT ask for confirmation of modifiers the customer already stated. If the customer said "medium" you do not ask "what temperature." If they said "brown rice" you do not ask "what rice." Map it and move on.
- OPTIONAL modifiers (required: false): Add the item WITHOUT asking about them. Do not mention optional modifier groups unless the customer brings them up. The customer can always customize later.
- When the customer says "large", match to the "Large 16 inch" or similar option. When they say "thin crust", match to "Thin Crust". Use the IDs from the search result.
- Wing sauces: match the customer's heat level exactly. "Hot buffalo" or "hot" → "Hot Buffalo". "Mild" → "Mild Buffalo". "Medium" → "Medium Buffalo". Read the exact option names from the search result and pick the correct one.
- After add_to_cart succeeds, tell the customer what was added. Do NOT ask "does that sound right?" unless something is genuinely ambiguous.
- When capturing special instructions (e.g. "extra crispy", "well done", "cut in half", "charif", "harif", "no onions", "spicy") — pass the customer's ACTUAL WORDS in the special_instructions field. Do NOT pass your spoken response ("I'll note that for the kitchen") as the special_instructions value. The kitchen reads this field — it must say what the customer actually wants.
- If the customer gives a special instruction at ANY point during modifier collection (not just at the end), capture it in special_instructions when you call add_to_cart. Do not wait for them to repeat it. If they said "harif" or "spicy" or "extra crispy" earlier in the conversation, include it in the add_to_cart call.

RESTAURANT INFO:
Name: ${restaurantInfo.name}
Hours: ${restaurantInfo.pickupHours}
Delivery minimum: $${restaurantInfo.deliveryMinimum} within ${restaurantInfo.deliveryRadiusMiles} miles

TERMINOLOGY:
${(specialTerminology || '').trim()}

FAQ:
${(faqKnowledgeBase || '').trim()}

STORE-SPECIFIC INSTRUCTIONS:
${(storeSpecificInstructions || '').trim()}`;
  }
}

module.exports = ConversationEngine;
