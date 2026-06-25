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

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const res = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: this.systemPrompt },
          ...this.history,
        ],
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
        temperature: 0.2,
        max_tokens: 600,
      });

      const msg = res.choices[0].message;

      // No tool calls — this is the final spoken response
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return msg.content || "I'm sorry, I didn't catch that. Could you repeat?";
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

        const result = this.toolHandler.execute(call.function.name, args);
        this._trackFailures(call.function.name, args, result);

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

TOOLS AVAILABLE:
- search_menu(query): Search for menu items. Call this BEFORE every add_to_cart — no exceptions.
- add_to_cart(item_id, modifier_option_ids, quantity, special_instructions): Add to order. ALL IDs must come from this turn's search_menu response.
- remove_from_cart(cart_item_id): Remove an item.
- update_cart_item(cart_item_id, ...): Modify an existing cart item.
- get_cart(): Get the current order state.

CRITICAL TOOL RULES:
1. ALWAYS call search_menu before add_to_cart. Every single item. No shortcuts.
2. Only pass item_id and modifier_option_ids from the search_menu response. Never guess IDs.
3. If search_menu returns clarification_needed: true — ask the customer to choose which item before calling add_to_cart.
4. If add_to_cart returns error MISSING_REQUIRED — ask the customer for those modifier choices, then call add_to_cart again.
5. If add_to_cart returns error PRICE_ANOMALY — say the price to the customer and ask them to confirm.
6. If add_to_cart returns error RESTRICTION_CATERING — inform the customer about the 24-48 hour advance notice requirement.
7. After two search failures for the same item — offer to connect the customer with a human.

CONVERSATION FLOW:
1. Greet and ask: pickup or delivery?
2. If delivery: ask for their full delivery address.
3. Take the order item by item. Search before each item.
4. When customer says they're done: call get_cart, then read back the complete order naturally. State the total.
5. Get the customer's confirmation.
6. After confirmation: thank them warmly and end the call.

ORDERING RULES:
- ONLY call add_to_cart when the customer has clearly and explicitly stated they want to ORDER something. Clear signals: "I want", "I'll have", "give me", "can I get", "add", "I'll take", "order me". Ambiguous words, questions, or unclear sounds are NOT ordering signals — ask first.
- Never add an item the customer only asked about. If intent is unclear, ask: "Would you like to add that to your order?"
- Never state a price you haven't received from a tool response.
- Process multi-item orders one item at a time (one search_menu + add_to_cart per item).
- When customer changes their mind, use update_cart_item or remove_from_cart.
- When customer asks what's on the pizza / what toppings are available — call search_menu for that item and read the modifier options from the result.

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
