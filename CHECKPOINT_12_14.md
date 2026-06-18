# GOHLEM.AI — Checkpoint 11/14
**Date:** 2026-06-18  
**Score:** 11/14 automated tests passing  
**Failing:** Test 2a (multi-item single turn), Test 7 (gift box needs follow-up turn), Test 11 (challah + barakas single turn)

---

## src/orders/orderState.js

```javascript
const NUMBER_WORDS = ['zero','one','two','three','four','five','six','seven','eight','nine','ten'];

class OrderCart {
  constructor() {
    this.items = [];
    this.orderType = null;
    this.createdAt = new Date();
  }

  // ─── INTERNAL ─────────────────────────────────────────────────────────────

  _generateId() {
    return `ci_${Date.now()}_${Math.floor(Math.random() * 90000 + 10000)}`;
  }

  _calcLineTotal(unitPrice, modifiers, quantity) {
    const modSum = (modifiers || []).reduce((s, m) => s + (m.price || 0), 0);
    return Math.round((unitPrice + modSum) * quantity * 100) / 100;
  }

  _pluralize(name) {
    const w = name.toLowerCase();
    // Items whose names already end in 's' are assumed to be plural (e.g. Hash Browns, Fries)
    if (w.endsWith('s') && !w.endsWith('ss')) return name;
    // Standard English suffix rules — no restaurant-specific cases
    if (w.endsWith('ch') || w.endsWith('sh')) return name + 'es';
    if (w.endsWith('x') || w.endsWith('z') || w.endsWith('ss')) return name + 'es';
    if (w.endsWith('y') && w.length > 1 && !'aeiou'.includes(w[w.length - 2])) {
      return name.slice(0, -1) + 'ies';
    }
    return name + 's';
  }

  // ─── MUTATIONS ────────────────────────────────────────────────────────────

  addItem(menuItem, modifiers = [], quantity = 1, specialInstructions = '') {
    const cartItemId = this._generateId();
    this.items.push({
      cartItemId,
      menuItemId: menuItem.id,
      name: menuItem.name,
      quantity,
      modifiers,
      unitPrice: menuItem.base_price,
      lineTotal: this._calcLineTotal(menuItem.base_price, modifiers, quantity),
      specialInstructions,
      status: 'confirmed',
    });
    return cartItemId;
  }

  removeItem(cartItemId) {
    const item = this.items.find(i => i.cartItemId === cartItemId);
    if (item) item.status = 'removed';
    return "Got it, I've removed that.";
  }

  updateModifiers(cartItemId, newModifiers) {
    const item = this.items.find(i => i.cartItemId === cartItemId && i.status === 'confirmed');
    if (!item) return;
    item.modifiers = newModifiers;
    item.lineTotal = this._calcLineTotal(item.unitPrice, newModifiers, item.quantity);
  }

  updateQuantity(cartItemId, quantity) {
    const item = this.items.find(i => i.cartItemId === cartItemId && i.status === 'confirmed');
    if (!item) return;
    item.quantity = quantity;
    item.lineTotal = this._calcLineTotal(item.unitPrice, item.modifiers, quantity);
  }

  addSpecialInstruction(cartItemId, instruction) {
    const item = this.items.find(i => i.cartItemId === cartItemId && i.status === 'confirmed');
    if (!item) return;
    item.specialInstructions = item.specialInstructions
      ? `${item.specialInstructions}; ${instruction}`
      : instruction;
  }

  clear() {
    this.items = [];
    return 'Order cleared.';
  }

  // ─── READS ────────────────────────────────────────────────────────────────

  getItem(cartItemId) {
    return this.items.find(i => i.cartItemId === cartItemId) || null;
  }

  getActiveItems() {
    return this.items.filter(i => i.status === 'confirmed');
  }

  isEmpty() {
    return this.getActiveItems().length === 0;
  }

  getTotal() {
    return Math.round(
      this.getActiveItems().reduce((s, i) => s + i.lineTotal, 0) * 100
    ) / 100;
  }

  getOrder() {
    return {
      orderType: this.orderType,
      items: this.getActiveItems(),
      total: this.getTotal(),
      itemCount: this.getActiveItems().length,
      createdAt: this.createdAt,
      status: 'pending',
    };
  }

  getSummary() {
    const active = this.getActiveItems();
    if (active.length === 0) return 'Your order is empty.';

    const lines = active.map(item => {
      const qty = item.quantity <= 10 ? NUMBER_WORDS[item.quantity] : String(item.quantity);
      const name = item.quantity > 1 ? this._pluralize(item.name) : item.name;

      const modParts = (item.modifiers || []).map(m => {
        if (m.action === 'REMOVE') return `no ${m.name}`;
        if (m.action === 'EXTRA') return `extra ${m.name}`;
        if (m.action === 'LIGHT') return `light ${m.name}`;
        if (m.action === 'SIDE')  return `${m.name} on the side`;
        return m.name;
      });
      const modDesc = modParts.length > 0 ? ` with ${modParts.join(', ')}` : '';
      const instrDesc = item.specialInstructions ? ` (${item.specialInstructions})` : '';

      return `${qty} ${name}${modDesc}${instrDesc}`;
    });

    return lines.join('; ') + `. Total: $${this.getTotal().toFixed(2)}.`;
  }
}

// ─── SYSTEM PROMPT BUILDER ────────────────────────────────────────────────────

const CORE_RULES = `You are Gohlem, an AI phone ordering assistant. You take orders accurately and naturally, exactly like a skilled human order taker.

ORDER TYPE: Ask at the very start of every call before anything else: "Will this be for pickup or delivery?" Capture the answer. Do not proceed until answered.

INTENT DETECTION — most critical rule:
Only add items to the order when customer clearly intends to order.
Clear intent words: I want, I'll have, Can I get, Give me, Add, I'd like, I'll take, Order me, Let me get.
If customer asks a question about an item — answer the question, then ask "Would you like to add that to your order?"
If intent is unclear — ask "Would you like to order that?"
NEVER add an item just because the customer mentioned it or asked about it.

PRICING:
Never mention item prices unless customer specifically asks.
Never say the price of an item unprompted.
Only state the order total at final confirmation — never before.

INTELLIGENCE:
Use real world knowledge to reason about menu items.
When a customer describes what they want by temperature, mood, or category rather than a specific item name, use common sense to identify the best matching items from the menu context.
Cold — identify items that are typically served cold based on the item name and category.
Warm or hot — identify items typically served hot.
Light — identify smaller or lower-calorie options.
Sweet — identify desserts and sweet items.
Size intelligence — if multiple sizes exist and context suggests individual portion, ask which size before adding.
You may reason using common sense but may never confirm items not on the menu.

QUANTITY:
Two sandwiches = two separate line items, not one item with quantity 2.
Three of those = three instances of the last mentioned item.
Make that two = update quantity of last mentioned item.
Always confirm quantity: "Got it, I have two [item name]s."

When a customer orders multiple identical items with the same modifiers — confirm them together as a single quantity. Say 'Got it, three cream cheese sandwiches on everything bagel toasted' and add as one cart item with quantity 3. Never ask about the same item three separate times.

When a customer orders multiple items with different modifiers in one sentence — do NOT process them one at a time across multiple turns. Instead: collect all the information from what the customer said, then read back the complete list in one natural sentence and confirm everything together before adding to cart. Example: 'So I have three tuna sandwiches — first on everything bagel toasted, second on sesame not toasted, third on poppy with tomatoes. Does that sound right?' Only after customer confirms — add all items to cart at once.

When a customer orders five or more different items — acknowledge all of them first: 'Got it, let me make sure I have everything.' Then list them all back naturally and confirm once. Never make the customer go through each item one by one unless modifiers are genuinely missing.

MODIFICATIONS:
Customer can change anything at any point in the call.
Always confirm changes: "Got it, I've updated that."
Never lose track of previously confirmed items when processing a change.

REMOVAL:
Remove the item = remove it from order, confirm removal.
Take off the modifier = remove that modifier from that specific item.
Start over = ask customer to confirm before clearing entire order.
Always confirm: "Got it, I've removed that."

DUPLICATE DETECTION:
This rule is VERY NARROW. Read it exactly.
A duplicate only exists when the customer's new request is for the EXACT SAME item name already in the ORDER STATE.
When adding a new item: do NOT mention other items already in the cart. Do NOT comment on the existing order. Just add the new item and confirm it.
ONLY ask the duplicate question if the item the customer just requested has the same name as something already confirmed in the cart.
Example of TRUE duplicate: Cart already contains [Item X]. Customer says "I want [Item X]." → Ask: "You already have [Item X] in your order. Did you want to add another, or modify the existing one?"
Example of NOT a duplicate: Cart has [Item X]. Customer orders [Item Y] (a different item). → Add [Item Y] without any comment about [Item X].
Example of NOT a duplicate: Cart has any item. Customer orders any different item. → Add the new item. Say nothing about the existing cart contents.

SPECIAL INSTRUCTIONS:
Any free-form preparation request that does not match a modifier option — extra crispy, well done, on the side, light sauce, no ice, extra toasted — capture as a special instruction attached to that specific item.
Never try to match special instructions to modifier groups.
Always confirm: "Got it, I've noted that."

SPLIT MODIFIERS:
When customer orders multiple of the same item with different modifiers — treat each as a completely separate line item with its own modifier set.
Two Mediterranean toasts one with no eggplant one with extra feta = two separate ADD_ITEM actions with different modifiers.
Never merge modifiers across multiple instances of the same item.

INFORMATION QUESTIONS:
If customer asks about dietary restrictions, allergens, kosher certification, parking, or any business information — answer from the restaurant knowledge base below.
If the answer is not in the knowledge base — say "I don't have that information but I can connect you with someone who can help."
Never guess or invent answers to factual questions about the restaurant.

PRE-CHECKOUT:
When customer says that's it / that's all / nothing else / that's everything / I'm done / that's my order — read back the complete order.
Speak quantities as words: three burgers not 3x Burger. Pluralize item names correctly.
Pluralize items correctly.
Include special instructions per item.
State total only at this point.
Customer must confirm before order is finalized.

ESCALATION:
After two failed attempts at the same item — offer to connect with someone.
If customer requests human at any point — immediately offer transfer.
Never leave customer stuck in a loop.

NEVER:
Invent menu items that don't exist.
State prices not calculated from the menu.
Add items without clear customer intent.
Forget previously confirmed items.
Contradict what is already in the order.`;

const RESPONSE_FORMAT = `RESPONSE FORMAT — CRITICAL:
You must ALWAYS respond with valid JSON only. No text before or after the JSON. Every single response must be JSON.

{
  "message": "What you say to the customer — this is spoken on the phone. Natural, conversational, no bullet points.",
  "actions": [
    // Include ONLY when customer is actually placing/modifying an order. Empty array [] if no order changes.

    {"type": "SET_ORDER_TYPE", "orderType": "pickup or delivery"},

    {"type": "ADD_ITEM",
     "name": "item name exactly as shown in menu context — no IDs, names only",
     "quantity": 1,
     "modifiers": [{"name": "modifier name", "action": "ADD|REMOVE|EXTRA|LIGHT|SIDE", "price": 0}],
     "specialInstructions": "free text or empty string"},

    {"type": "REMOVE_ITEM", "cartItemId": "cartItemId from ORDER STATE context"},

    {"type": "UPDATE_QUANTITY", "cartItemId": "cartItemId from ORDER STATE context", "quantity": 2},

    {"type": "UPDATE_MODIFIERS",
     "cartItemId": "cartItemId from ORDER STATE context",
     "modifiers": [{"name": "modifier name", "action": "ADD|REMOVE|EXTRA|LIGHT|SIDE", "price": 0}]},

    {"type": "ADD_SPECIAL_INSTRUCTION",
     "cartItemId": "cartItemId from ORDER STATE context",
     "instruction": "text"},

    {"type": "CLEAR_ORDER"}
  ]
}`;

function buildSystemPrompt(restaurantConfig) {
  const { restaurantInfo, specialTerminology, faqKnowledgeBase, storeSpecificInstructions } = restaurantConfig;

  const restaurantSection = `
--- RESTAURANT CONFIGURATION ---

RESTAURANT: ${restaurantInfo.name}
LOCATION: ${restaurantInfo.location}
PICKUP HOURS: ${restaurantInfo.pickupHours}
DELIVERY HOURS: ${restaurantInfo.deliveryHours}
ORDER TYPES ACCEPTED: ${restaurantInfo.orderTypes.join(', ')}

SPECIAL TERMINOLOGY AND PRONUNCIATIONS:
${specialTerminology.trim()}

FAQ AND KNOWLEDGE BASE:
${faqKnowledgeBase.trim()}

STORE-SPECIFIC INSTRUCTIONS:
${storeSpecificInstructions.trim()}`;

  return [CORE_RULES, restaurantSection, RESPONSE_FORMAT].join('\n\n');
}

module.exports = { OrderCart, buildSystemPrompt };
```

---

## src/conversation/conversationEngine.js

```javascript
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const fs = require('fs');
const OpenAI = require('openai');
const GohlemMenuEngine = require('../../gohlem-menu-engine');
const { OrderCart, buildSystemPrompt } = require('../orders/orderState');
const restaurantConfig = require('../config/restaurantConfig');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: globalThis.fetch });

class ConversationEngine {
  constructor(menuFilePath) {
    const menuData = JSON.parse(fs.readFileSync(menuFilePath, 'utf8'));
    this.menuEngine = new GohlemMenuEngine(menuData);
    this.cart = new OrderCart();
    this.systemPrompt = buildSystemPrompt(restaurantConfig);
    this.history = [];
  }

  // ─── OPEN CALL ────────────────────────────────────────────────────────────
  // Generates the first spoken greeting without any customer input.

  async open() {
    const messages = [
      { role: 'system', content: this.systemPrompt },
      {
        role: 'user',
        content: [
          '[ORDER STATE]',
          'Order type: not yet specified',
          'No items in order yet.',
          '',
          '[CUSTOMER MESSAGE]',
          '(Call just connected. Generate your opening greeting.)',
        ].join('\n'),
      },
    ];

    const raw = await this._callOpenAI(messages);
    const parsed = this._parseResponse(raw);

    this.history.push({ role: 'user', content: '(Call connected)' });
    this.history.push({ role: 'assistant', content: raw });

    return parsed;
  }

  // ─── CHAT TURN ────────────────────────────────────────────────────────────

  async chat(userMessage) {
    // Capture order type directly from keywords — never rely on the AI for this.
    if (!this.cart.orderType) {
      const lower = userMessage.toLowerCase();
      if (/\bpick\s*-?\s*up\b|\bpickup\b/.test(lower)) {
        this.cart.orderType = 'pickup';
      } else if (/\bdeliver(y|ing)?\b/.test(lower)) {
        this.cart.orderType = 'delivery';
      }
    }

    const matches = this.menuEngine.findItems(userMessage);
    const combo = this.menuEngine.resolveCombo(userMessage);
    const menuContext = this._buildMenuContext(matches);
    const comboContext = this._buildComboContext(combo);
    const orderContext = this._buildOrderContext();

    const parts = ['[ORDER STATE]', orderContext, ''];
    if (comboContext) parts.push(comboContext, '');
    parts.push('[MENU SEARCH RESULTS]', menuContext, '', '[CUSTOMER MESSAGE]', userMessage);

    const augmentedMessage = parts.join('\n');

    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...this.history,
      { role: 'user', content: augmentedMessage },
    ];

    const raw = await this._callOpenAI(messages);
    const parsed = this._parseResponse(raw);
    const actionResults = this._executeActions(parsed.actions || []);

    this.history.push({ role: 'user', content: userMessage });
    this.history.push({ role: 'assistant', content: raw });

    return { message: parsed.message, actions: parsed.actions || [], actionResults };
  }

  // ─── OPENAI CALL ──────────────────────────────────────────────────────────

  async _callOpenAI(messages) {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });
    return completion.choices[0].message.content;
  }

  // ─── PARSE RESPONSE ───────────────────────────────────────────────────────

  _parseResponse(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return { message: raw, actions: [] };
    }
  }

  // ─── EXECUTE ACTIONS ──────────────────────────────────────────────────────

  _executeActions(actions) {
    const results = [];

    for (const action of actions) {
      switch (action.type) {
        case 'SET_ORDER_TYPE': {
          this.cart.orderType = action.orderType;
          results.push({ type: action.type, ok: true, orderType: action.orderType });
          break;
        }

        case 'ADD_ITEM': {
          // Name-only resolution. The AI never returns an ID — code resolves
          // item name → real menu item with real ID and real price.
          const menuItem = action.name
            ? this.menuEngine.findItems(action.name)[0] || null
            : null;

          if (!menuItem) {
            results.push({
              type: action.type,
              ok: false,
              error: `Item not found: "${action.name}" — ask customer to clarify`,
            });
            break;
          }

          const cartItemId = this.cart.addItem(
            menuItem,
            action.modifiers || [],
            action.quantity || 1,
            action.specialInstructions || ''
          );
          results.push({ type: action.type, ok: true, cartItemId, name: menuItem.name });
          break;
        }

        case 'REMOVE_ITEM': {
          const msg = this.cart.removeItem(action.cartItemId);
          results.push({ type: action.type, ok: true, message: msg });
          break;
        }

        case 'UPDATE_QUANTITY': {
          this.cart.updateQuantity(action.cartItemId, action.quantity);
          results.push({ type: action.type, ok: true });
          break;
        }

        case 'UPDATE_MODIFIERS': {
          this.cart.updateModifiers(action.cartItemId, action.modifiers || []);
          results.push({ type: action.type, ok: true });
          break;
        }

        case 'ADD_SPECIAL_INSTRUCTION': {
          this.cart.addSpecialInstruction(action.cartItemId, action.instruction);
          results.push({ type: action.type, ok: true });
          break;
        }

        case 'CLEAR_ORDER': {
          const msg = this.cart.clear();
          results.push({ type: action.type, ok: true, message: msg });
          break;
        }

        default:
          results.push({ type: action.type, ok: false, error: 'Unknown action type' });
      }
    }

    return results;
  }

  // ─── CONTEXT BUILDERS ─────────────────────────────────────────────────────

  _buildOrderContext() {
    const active = this.cart.getActiveItems();
    const orderType = this.cart.orderType || 'not yet specified';
    let ctx = `Order type: ${orderType}\n`;

    if (active.length === 0) {
      ctx += 'No items in order yet.';
    } else {
      ctx += 'Current items:\n';
      for (const item of active) {
        const modDesc = item.modifiers.length > 0
          ? ' | modifiers: ' + item.modifiers.map(m => `${m.action} ${m.name}`).join(', ')
          : '';
        const instrDesc = item.specialInstructions ? ` | note: "${item.specialInstructions}"` : '';
        ctx += `  - cartItemId: ${item.cartItemId} | ${item.name} x${item.quantity} | $${item.lineTotal.toFixed(2)}${modDesc}${instrDesc}\n`;
      }
      ctx += `Running total: $${this.cart.getTotal().toFixed(2)}`;
    }

    return ctx;
  }

  _buildMenuContext(matches) {
    if (matches.length === 0) {
      return 'No matching items found in the menu for this query.';
    }

    let ctx = '';

    for (const item of matches) {
      const price = item.base_price != null ? ` — $${item.base_price.toFixed(2)}` : '';
      ctx += `\n• id: ${item.id} | ${item.name}${price} (${item.category})\n`;

      if (item.description) ctx += `  ${item.description}\n`;

      const analysis = this.menuEngine.analyzeModifiers(item);

      if (analysis.mustAsk.length > 0) {
        ctx += `  REQUIRED (must ask before confirming):\n`;
        for (const g of analysis.mustAsk) {
          const opts = g.options
            .map(o => o.price > 0 ? `${o.name} (+$${o.price.toFixed(2)})` : o.name)
            .join(', ');
          ctx += `    - ${g.name}: ${opts}\n`;
        }
      }

      if (analysis.shouldAsk.length > 0) {
        ctx += `  OPTIONAL (ask if not specified):\n`;
        for (const g of analysis.shouldAsk) {
          const opts = g.options
            .map(o => o.price > 0 ? `${o.name} (+$${o.price.toFixed(2)})` : o.name)
            .join(', ');
          ctx += `    - ${g.name}: ${opts}\n`;
        }
      }

      if (analysis.willAssume.length > 0) {
        ctx += `  AUTO-APPLIED defaults:\n`;
        for (const g of analysis.willAssume) {
          ctx += `    - ${g.name}: "${g.assumedDefault?.name}"\n`;
        }
      }
    }

    return ctx;
  }

  _buildComboContext(combo) {
    if (!combo) return null;

    if (combo.type === 'direct') {
      const lines = [
        '[COMBINATION ANALYSIS — MENU DATA VERIFIED]',
        `Status   : DIRECT MENU ITEM MATCH`,
        `Item     : ${combo.item.name} — $${combo.item.base_price.toFixed(2)} (id: ${combo.item.id})`,
      ];
      if (combo.quantity && combo.quantity !== '1' && combo.quantity !== 'one') {
        lines.push(`Quantity : ${combo.quantity} — add as separate line items per the QUANTITY rule`);
      }
      lines.push(`Action   : This item exists directly on the menu. Use ADD_ITEM with this menuItemId. Ask any required modifier questions, then confirm.`);
      return lines.join('\n');
    }

    if (combo.type === 'combo') {
      const modPrice = combo.modifier.price > 0
        ? ` +$${combo.modifier.price.toFixed(2)}`
        : ' $0.00';
      const lines = [
        '[COMBINATION ANALYSIS — MENU DATA VERIFIED]',
        `Status   : VALID COMBINATION`,
        `Base item: ${combo.item.name} — $${combo.item.base_price.toFixed(2)} (id: ${combo.item.id})`,
        `Modifier : "${combo.modifier.name}"${modPrice} (group: "${combo.modifier.groupName}")`,
      ];
      if (combo.quantity && combo.quantity !== '1' && combo.quantity !== 'one') {
        lines.push(`Quantity : ${combo.quantity} — add as separate line items`);
      }
      lines.push(`Action   : Use ADD_ITEM with this menuItemId and include this modifier. Then ask any remaining required modifier questions before confirming.`);
      return lines.join('\n');
    }

    if (combo.type === 'split') {
      const lines = [
        '[COMBINATION ANALYSIS — MENU DATA VERIFIED]',
        `Status   : SPLIT MODIFIER ORDER — ${combo.quantity} separate line items required`,
        `Item     : ${combo.item.name} — $${combo.item.base_price.toFixed(2)} (id: ${combo.item.id})`,
      ];
      combo.instances.forEach((inst, i) => {
        lines.push(`Instance ${i + 1} of ${combo.instances.length}: ${inst.description}`);
      });
      lines.push(
        `Action   : Output EXACTLY ${combo.instances.length} ADD_ITEM actions, each with the same menuItemId.`,
        `           Match each instance's description to the closest modifier option in the MENU SEARCH RESULTS.`,
        `           Do NOT merge into one item. Do NOT emit fewer than ${combo.instances.length} ADD_ITEM actions.`
      );
      return lines.join('\n');
    }

    if (combo.type === 'not_combinable') {
      const suggestLine = combo.suggestions.length > 0
        ? `Closest menu options: ${combo.suggestions.map(s => `"${s.name}"`).join(', ')}`
        : 'No similar modifier options found in menu data.';
      return [
        '[COMBINATION ANALYSIS — MENU DATA VERIFIED]',
        `Status   : NOT A VALID COMBINATION`,
        `Requested: "${combo.queriedComponent}" — this does NOT exist as a modifier on any matching menu item.`,
        suggestLine,
        `Action   : Do NOT add this item. Tell the customer this combination is not available. Use SPECIAL TERMINOLOGY from your config to suggest the closest real alternative.`,
      ].join('\n');
    }

    if (combo.type === 'not_found') {
      return [
        '[COMBINATION ANALYSIS — MENU DATA VERIFIED]',
        `Status   : NO MATCH FOUND`,
        `Action   : Tell the customer this item is not on the menu. Offer to help with something else.`,
      ].join('\n');
    }

    return null;
  }

  reset() {
    this.cart = new OrderCart();
    this.history = [];
  }
}

module.exports = ConversationEngine;

// ─── COMBINATION RESOLVER TESTS ──────────────────────────────────────────────

if (require.main === module) {
  const MENU_PATH = path.join(__dirname, '../../hot_bagels_menu_with_real_acai_restaurant.json');

  async function runComboTest(label, turns) {
    console.log(`\n${'─'.repeat(65)}`);
    console.log(label);
    console.log('─'.repeat(65));

    const engine = new ConversationEngine(MENU_PATH);
    const greeting = await engine.open();
    console.log(`Gohlem: ${greeting.message}`);

    for (const message of turns) {
      console.log(`\nCustomer: ${message}`);
      const result = await engine.chat(message);
      console.log(`Gohlem:   ${result.message}`);

      for (let i = 0; i < result.actions.length; i++) {
        const action = result.actions[i];
        const outcome = result.actionResults[i];
        const ok = outcome.ok ? '✓' : '✗';
        const detail = outcome.cartItemId
          ? ` → ${outcome.cartItemId} (${action.name || ''})`
          : outcome.error ? ` → ${outcome.error}` : '';
        console.log(`  [${ok}] ${action.type}${detail}`);
      }
    }

    const order = engine.cart.getOrder();
    console.log(`\nCart: ${order.items.length} item(s) | Total: $${order.total.toFixed(2)}`);
    order.items.forEach(item => {
      const mods = item.modifiers.map(m => m.name).join(', ');
      console.log(`  • ${item.name} $${item.unitPrice.toFixed(2)}${mods ? ' | ' + mods : ''}`);
    });
  }

  async function runTest() {
    console.log('\n' + '='.repeat(65));
    console.log('GOHLEM.AI — Combination Resolver Tests (A–D)');
    console.log('='.repeat(65));

    await runComboTest('Test A: "I want a cream cheese sandwich"', [
      'Pickup',
      'I want a cream cheese sandwich',
    ]);

    await runComboTest('Test B: "I want a salmon sandwich"', [
      'Pickup',
      'I want a salmon sandwich',
    ]);

    await runComboTest('Test C: "I want something completely made up"', [
      'Pickup',
      'I want something completely made up',
    ]);

    await runComboTest('Test D: "I want a lox sandwich"', [
      'Pickup',
      'I want a lox sandwich',
    ]);

    console.log('\n' + '='.repeat(65));
    console.log('Combination resolver tests complete');
    console.log('='.repeat(65));
  }

  runTest().catch(console.error);
}
```

---

## gohlem-menu-engine.js

```javascript
/**
 * GOHLEM.AI — Universal Menu Engine
 * 
 * This engine is completely plug-and-play.
 * Feed it any restaurant's menu JSON and it works.
 * No restaurant-specific hardcoding anywhere.
 * 
 * What it does:
 * 1. Loads any menu JSON
 * 2. Finds items by natural language (fuzzy matching)
 * 3. Returns full modifier rules for any item
 * 4. Validates orders against menu rules
 * 5. Calculates accurate pricing
 * 6. Decides intelligently when to ask vs when to assume
 */

const fs = require('fs');
const path = require('path');

class GohlemMenuEngine {
  constructor(menuJson) {
    this.restaurant = menuJson.name || 'Restaurant';
    this.restaurantId = menuJson.restaurant_id;
    this.categories = menuJson.menu.categories;
    
    // Build a flat searchable index of all items
    this.itemIndex = this._buildItemIndex();
    
    console.log(`✓ Gohlem Menu Engine loaded for: ${this.restaurant}`);
    console.log(`✓ ${this.itemIndex.length} items indexed across ${this.categories.length} categories`);
  }

  // ─── BUILD SEARCH INDEX ───────────────────────────────────────────────────

  _buildItemIndex() {
    const index = [];
    
    for (const category of this.categories) {
      for (const item of category.items) {
        index.push({
          ...item,
          category: category.name,
          searchTokens: this._tokenize(`${item.name} ${category.name} ${item.description || ''}`)
        });
      }
    }
    
    return index;
  }

  _tokenize(text) {
    return text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  // ─── FUZZY ITEM SEARCH ────────────────────────────────────────────────────

  findItems(query, maxResults = 5) {
    const queryTokens = this._tokenize(query);
    
    if (queryTokens.length === 0) return [];

    const scored = this.itemIndex
      .filter(item => item.available !== false)
      .map(item => {
        let score = 0;
        
        if (item.name.toLowerCase() === query.toLowerCase()) score += 100;
        if (item.name.toLowerCase().includes(query.toLowerCase())) score += 50;
        
        for (const qToken of queryTokens) {
          for (const iToken of item.searchTokens) {
            if (iToken === qToken) score += 10;
            else if (iToken.includes(qToken) && qToken.length > 3) score += 5;
            else if (qToken.includes(iToken) && iToken.length > 3) score += 3;
          }
        }
        
        return { item, score };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(r => r.item);

    return scored;
  }

  // ─── GET ITEM DETAILS ─────────────────────────────────────────────────────

  getItemDetails(itemId) {
    return this.itemIndex.find(i => i.id === itemId) || null;
  }

  // ─── COMBINATION RESOLVER ─────────────────────────────────────────────────

  resolveCombo(query) {
    const splitResult = this._detectSplitModifiers(query);
    if (splitResult) return splitResult;

    const intentStripped = query
      .toLowerCase()
      .replace(
        /^(i want|i'd like|i'll have|can i get|give me|add|i'll take|let me get|order me|i need)\s+(a\s+|an\s+|the\s+|some\s+)?/,
        ''
      )
      .trim();

    const qtyPattern = /^(ten|nine|eight|seven|six|five|four|three|two|one|a\s+couple\s+of|a\s+few|some|10|[1-9])\s+/i;
    const qtyMatch = intentStripped.match(qtyPattern);
    const detectedQuantity = qtyMatch ? qtyMatch[1].replace(/\s+/g, ' ').trim() : null;
    const cleanedQuery = qtyMatch ? intentStripped.slice(qtyMatch[0].length).trim() : intentStripped;

    if (!cleanedQuery) return { type: 'not_found' };

    const searchTokens = this._tokenize(cleanedQuery);
    if (searchTokens.length === 0) return { type: 'not_found' };

    const itemPart = cleanedQuery
      .split(/\s+(on\s+|with\s+|no\s+|without\s+|and\s+a\s+|and\s+an\s+|but\s+)/)[0]
      .trim();

    const topCandidates = this.findItems(itemPart || cleanedQuery, 8);
    for (const candidate of topCandidates) {
      if (cleanedQuery.startsWith(candidate.name.toLowerCase())) {
        return { type: 'direct', item: candidate, quantity: detectedQuantity };
      }
    }

    let bestCombo = null;
    let bestScore = 0;

    for (const item of this.itemIndex) {
      if (item.available === false) continue;

      const modMatch = this._findBestModifierMatch(item, searchTokens);
      if (!modMatch || modMatch.score < 10) continue;

      const modTokenSet = new Set(this._tokenize(modMatch.name));

      let itemScore = 0;
      for (const sToken of searchTokens) {
        if (modTokenSet.has(sToken)) continue;
        for (const iToken of item.searchTokens) {
          if (iToken === sToken) itemScore += 10;
          else if (iToken.includes(sToken) && sToken.length > 3) itemScore += 5;
          else if (sToken.includes(iToken) && iToken.length > 3) itemScore += 3;
        }
      }

      if (itemScore === 0) continue;

      const totalScore = itemScore + modMatch.score * 2;
      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestCombo = { item, modifier: modMatch };
      }
    }

    if (bestCombo) {
      return { type: 'combo', item: bestCombo.item, modifier: bestCombo.modifier, quantity: detectedQuantity };
    }

    const baseItems = this.findItems(cleanedQuery, 3);
    if (baseItems.length > 0) {
      return {
        type: 'not_combinable',
        baseItems,
        queriedComponent: searchTokens.filter(t => t.length > 2).join(' '),
        suggestions: this._findSimilarModifiers(baseItems, searchTokens),
      };
    }

    return { type: 'not_found' };
  }

  _detectSplitModifiers(query) {
    const cleaned = query
      .toLowerCase()
      .replace(
        /^(i want|i'd like|i'll have|can i get|give me|add|i'll take|let me get|order me|i need)\s+(a\s+|an\s+|the\s+|some\s+)?/,
        ''
      )
      .trim();

    const m = cleaned.match(
      /^(two|three|four|five|2|3|4|5)\s+(.+?),\s*one\s+(with(?:\s+no)?|with(?:\s+extra)?|without|no|extra)\s+(.+?),\s*(?:and\s+)?one\s+(with(?:\s+no)?|with(?:\s+extra)?|without|no|extra)\s+(.+)/i
    );
    if (!m) return null;

    const [, qtyWord, itemPhrase, prep1, mod1Phrase, prep2, mod2Phrase] = m;

    const baseItems = this.findItems(itemPhrase.trim(), 3);
    if (!baseItems.length) return null;

    const qtyMap = { two: 2, three: 3, four: 4, five: 5, '2': 2, '3': 3, '4': 4, '5': 5 };
    const quantity = qtyMap[qtyWord.toLowerCase()] || 2;

    const describeInstance = (prep, phrase) => {
      const p = phrase.trim();
      const n = prep.replace(/\s+/g, ' ').trim().toLowerCase();
      if (n === 'no' || n === 'without' || n === 'with no') return `no ${p}`;
      if (n === 'extra' || n === 'with extra') return `extra ${p}`;
      return p;
    };

    return {
      type: 'split',
      item: baseItems[0],
      quantity,
      instances: [
        { description: describeInstance(prep1, mod1Phrase) },
        { description: describeInstance(prep2, mod2Phrase) },
      ],
    };
  }

  _findBestModifierMatch(item, queryTokens) {
    let bestOption = null;
    let bestScore = 0;
    let bestGroupName = null;

    for (const group of (item.modifier_groups || [])) {
      for (const option of group.options) {
        const optTokens = this._tokenize(option.name);
        let score = 0;

        for (const qToken of queryTokens) {
          if (qToken.length <= 2) continue;
          for (const oToken of optTokens) {
            if (oToken === qToken) score += 10;
            else if (oToken.includes(qToken) && qToken.length > 3) score += 5;
            else if (qToken.includes(oToken) && oToken.length > 3) score += 3;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestOption = option;
          bestGroupName = group.name;
        }
      }
    }

    if (!bestOption || bestScore === 0) return null;

    return {
      id: bestOption.id,
      name: bestOption.name,
      price: bestOption.price || 0,
      groupName: bestGroupName,
      score: bestScore,
    };
  }

  _findSimilarModifiers(baseItems, queryTokens) {
    const seen = new Map();

    for (const item of baseItems) {
      for (const group of (item.modifier_groups || [])) {
        for (const option of group.options) {
          if (seen.has(option.name)) continue;
          const optTokens = this._tokenize(option.name);
          const hasOverlap = queryTokens.some(qt =>
            qt.length > 2 &&
            optTokens.some(ot => ot.length > 2 && (ot.includes(qt) || qt.includes(ot)))
          );
          if (hasOverlap) {
            seen.set(option.name, { name: option.name, group: group.name });
          }
        }
      }
    }

    return Array.from(seen.values()).slice(0, 3);
  }

  // ─── MODIFIER INTELLIGENCE ────────────────────────────────────────────────

  analyzeModifiers(item) {
    const analysis = {
      mustAsk: [],
      shouldAsk: [],
      willAssume: [],
      restrictions: []
    };

    for (const group of (item.modifier_groups || [])) {
      const groupAnalysis = {
        name: group.name,
        required: group.required,
        maxSelections: group.max_selections,
        options: group.options,
        optionCount: group.options.length
      };

      if (group.required) {
        analysis.mustAsk.push({
          ...groupAnalysis,
          reason: 'Required by menu — must be answered before order can proceed'
        });
      } else {
        const impact = this._assessModifierImpact(group);
        
        if (impact === 'high') {
          analysis.shouldAsk.push({
            ...groupAnalysis,
            reason: impact_reason(group)
          });
        } else {
          const defaultOption = this._getDefaultOption(group);
          analysis.willAssume.push({
            ...groupAnalysis,
            assumedDefault: defaultOption,
            reason: 'Optional modifier with clear default — applied silently'
          });
        }
      }
    }

    return analysis;
  }

  _assessModifierImpact(group) {
    const name = group.name.toLowerCase();
    const options = group.options;
    
    const hasPriceDifferences = options.some(o => o.price > 0.50);
    if (hasPriceDifferences) return 'high';
    
    if (options.length >= 6) return 'high';
    
    const highImpactKeywords = [
      'size', 'type', 'style', 'base', 'protein', 'main', 
      'flavor', 'liquid', 'milk', 'temperature', 'meat'
    ];
    if (highImpactKeywords.some(k => name.includes(k))) return 'high';
    
    if (group.max_selections >= 3) return 'high';
    
    return 'low';
  }

  _getDefaultOption(group) {
    const options = group.options;
    const defaultSignals = ['regular', 'standard', 'none', 'no ', 'plain', 'original'];
    
    for (const signal of defaultSignals) {
      const match = options.find(o => o.name.toLowerCase().includes(signal));
      if (match) return match;
    }
    
    const freeOptions = options.filter(o => o.price === 0);
    if (freeOptions.length > 0) return freeOptions[0];
    
    return options[0];
  }

  // ─── ORDER VALIDATION ─────────────────────────────────────────────────────

  validateOrder(itemId, selectedModifiers) {
    const item = this.getItemDetails(itemId);
    if (!item) return { valid: false, errors: ['Item not found in menu'] };

    const errors = [];
    const warnings = [];
    const applied = [];

    for (const group of (item.modifier_groups || [])) {
      const selected = selectedModifiers.filter(m => 
        group.options.some(o => o.id === m.optionId)
      );

      if (group.required && selected.length === 0) {
        errors.push({
          type: 'MISSING_REQUIRED',
          groupName: group.name,
          message: `Please choose ${group.name}`,
          options: group.options
        });
      } else if (selected.length > group.max_selections) {
        errors.push({
          type: 'TOO_MANY_SELECTIONS',
          groupName: group.name,
          message: `Maximum ${group.max_selections} selection(s) allowed for ${group.name}`,
          maxAllowed: group.max_selections
        });
      } else if (selected.length > 0) {
        applied.push({ group: group.name, selections: selected });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      applied,
      item: item.name
    };
  }

  // ─── PRICE CALCULATION ────────────────────────────────────────────────────

  calculatePrice(itemId, selectedModifiers) {
    const item = this.getItemDetails(itemId);
    if (!item) return null;

    let total = item.base_price;
    
    for (const modifier of selectedModifiers) {
      for (const group of (item.modifier_groups || [])) {
        const option = group.options.find(o => o.id === modifier.optionId);
        if (option) {
          total += (option.price || 0) * (modifier.quantity || 1);
          break;
        }
      }
    }

    return Math.round(total * 100) / 100;
  }

  // ─── GENERATE AI QUESTION ─────────────────────────────────────────────────

  generateQuestion(modifierGroup) {
    const options = modifierGroup.options;
    const name = modifierGroup.name;
    
    if (options.length <= 4) {
      const optionNames = options.map(o => {
        const priceStr = o.price > 0 ? ` (+$${o.price.toFixed(2)})` : '';
        return `${o.name}${priceStr}`;
      }).join(', ');
      return `What ${name.toLowerCase()} would you like? Options are: ${optionNames}.`;
    } else {
      return `What would you like for ${name.toLowerCase()}? I have ${options.length} options available — would you like me to list them, or do you already know what you'd like?`;
    }
  }

  // ─── MENU SUMMARY ─────────────────────────────────────────────────────────

  getMenuSummary() {
    return {
      restaurant: this.restaurant,
      totalItems: this.itemIndex.length,
      categories: this.categories.map(c => ({
        name: c.name,
        itemCount: c.items.length
      }))
    };
  }
}

// Helper function (outside class to avoid this binding issues)
function impact_reason(group) {
  const options = group.options;
  const hasPriceDiff = options.some(o => o.price > 0.50);
  if (hasPriceDiff) return 'Optional but has significant price variations between options';
  if (options.length >= 6) return 'Optional but has many choices — customer likely has a preference';
  return 'Optional but meaningfully changes the item';
}

module.exports = GohlemMenuEngine;

// ─── TEST THE ENGINE ──────────────────────────────────────────────────────────

if (require.main === module) {
  const menuData = JSON.parse(fs.readFileSync(path.join(__dirname, 'hot_bagels_menu_with_real_acai_restaurant.json'), 'utf8'));
  const engine = new GohlemMenuEngine(menuData);

  console.log('\n' + '='.repeat(60));
  console.log('GOHLEM MENU ENGINE — LIVE TEST');
  console.log('='.repeat(60));

  console.log('\n📍 TEST 1: Customer says "I want a tuna sandwich"');
  const tunaResults = engine.findItems('tuna sandwich');
  console.log(`Found ${tunaResults.length} result(s):`);
  tunaResults.forEach(item => {
    console.log(`  → ${item.name} (${item.category}) — $${item.base_price}`);
  });

  console.log('\n📍 TEST 2: Customer says "something with lox"');
  const loxResults = engine.findItems('lox');
  console.log(`Found ${loxResults.length} result(s):`);
  loxResults.forEach(item => {
    console.log(`  → ${item.name} (${item.category}) — $${item.base_price}`);
  });

  console.log('\n📍 TEST 3: Modifier intelligence for "American Cheese Sandwich"');
  const sandwich = engine.findItems('american cheese sandwich')[0];
  if (sandwich) {
    const analysis = engine.analyzeModifiers(sandwich);
    
    console.log(`\nItem: ${sandwich.name} — Base price: $${sandwich.base_price}`);
    
    console.log(`\n❗ MUST ASK (${analysis.mustAsk.length} required modifier groups):`);
    analysis.mustAsk.forEach(g => {
      console.log(`  → "${g.name}" — ${g.optionCount} options`);
      console.log(`     AI will say: "${engine.generateQuestion(g)}"`);
    });

    console.log(`\n💬 SHOULD ASK (${analysis.shouldAsk.length} high-impact optional groups):`);
    analysis.shouldAsk.forEach(g => {
      console.log(`  → "${g.name}" — ${g.reason}`);
    });

    console.log(`\n✅ WILL ASSUME (${analysis.willAssume.length} low-impact optional groups):`);
    analysis.willAssume.forEach(g => {
      console.log(`  → "${g.name}" — will default to "${g.assumedDefault?.name}"`);
    });
  }

  console.log('\n📍 TEST 4: Validate order — American Cheese Sandwich');
  console.log('Customer said: "American cheese sandwich on everything bagel with tomatoes"');
  
  if (sandwich) {
    const everythingBagelId = sandwich.modifier_groups[0]?.options
      .find(o => o.name === 'Everything Bagel')?.id;
    const tomatoId = sandwich.modifier_groups[1]?.options
      .find(o => o.name === 'Tomatoes Sliced')?.id;

    const validation = engine.validateOrder(sandwich.id, [
      { optionId: everythingBagelId },
      { optionId: tomatoId }
    ]);

    console.log(`Valid: ${validation.valid}`);
    if (validation.errors.length > 0) {
      console.log('Errors:', validation.errors);
    } else {
      console.log('✓ Order is valid — all required modifiers present');
      const price = engine.calculatePrice(sandwich.id, [
        { optionId: everythingBagelId },
        { optionId: tomatoId }
      ]);
      console.log(`Total price: $${price}`);
    }
  }

  console.log('\n📍 TEST 5: What happens if bagel type is missing?');
  if (sandwich) {
    const validation = engine.validateOrder(sandwich.id, []);
    console.log(`Valid: ${validation.valid}`);
    console.log('Missing required modifiers:');
    validation.errors.forEach(e => {
      console.log(`  → ${e.message}`);
    });
  }

  console.log('\n📍 TEST 6: Customer asks "do you have anything with strawberry?"');
  const strawberryResults = engine.findItems('strawberry');
  console.log(`Found ${strawberryResults.length} result(s):`);
  strawberryResults.forEach(item => {
    console.log(`  → ${item.name} (${item.category}) — $${item.base_price}`);
  });

  console.log('\n' + '='.repeat(60));
  console.log('ENGINE READY — All tests complete');
  console.log('='.repeat(60));
}
```
