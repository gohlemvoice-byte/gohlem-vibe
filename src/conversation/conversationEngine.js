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

    // Test A — cream cheese exists as a modifier → COMBO
    await runComboTest('Test A: "I want a cream cheese sandwich"', [
      'Pickup',
      'I want a cream cheese sandwich',
    ]);

    // Test B — salmon is not a modifier → NOT_COMBINABLE, AI should suggest lox
    await runComboTest('Test B: "I want a salmon sandwich"', [
      'Pickup',
      'I want a salmon sandwich',
    ]);

    // Test C — nothing matches at all → NOT_FOUND
    await runComboTest('Test C: "I want something completely made up"', [
      'Pickup',
      'I want something completely made up',
    ]);

    // Test D — lox IS a modifier → COMBO
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
