const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const fs = require('fs');
const OpenAI = require('openai');
const GohlemMenuEngine = require('../../gohlem-menu-engine');
const { OrderCart, buildSystemPrompt } = require('../orders/orderState');
const MenuResolver = require('../orders/menuResolver');
const restaurantConfig = require('../config/restaurantConfig');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: globalThis.fetch });

class ConversationEngine {
  constructor(menuFilePath) {
    const menuData = JSON.parse(fs.readFileSync(menuFilePath, 'utf8'));
    this.menuEngine = new GohlemMenuEngine(menuData);
    this.cart = new OrderCart();
    this.resolver = new MenuResolver(this.menuEngine);
    this.systemPrompt = buildSystemPrompt(restaurantConfig);
    this.history = [];
  }

  // ─── OPEN CALL ────────────────────────────────────────────────────────────

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
    // Capture order type from keywords — code-side, never rely on AI action
    if (!this.cart.orderType) {
      const lower = userMessage.toLowerCase();
      if (/\bpick\s*-?\s*up\b|\bpickup\b/.test(lower)) {
        this.cart.orderType = 'pickup';
      } else if (/\bdeliver(y|ing)?\b/.test(lower)) {
        this.cart.orderType = 'delivery';
      }
    }

    // Resolve combo (for context injection and split modifier detection)
    const matches = this.menuEngine.findItems(userMessage);
    const combo = this.menuEngine.resolveCombo(userMessage);
    const menuContext = this._buildMenuContext(matches);
    const comboContext = this._buildComboContext(combo);
    const orderContext = this._buildOrderContext();

    // Handle split modifiers entirely in code — AI just provides verbal confirmation
    let splitResults = null;
    if (combo && combo.type === 'split') {
      splitResults = combo.instances.map(inst => {
        const splitIntent = {
          itemName: combo.item.name,
          modifiers: inst.description.split(/,\s*/),
          quantity: 1,
          specialInstructions: '',
        };
        const resolved = this.resolver.resolve(splitIntent);
        if (resolved.resolved) {
          const cartItemId = this.cart.addItem(
            resolved.menuItem,
            resolved.validatedModifiers,
            1,
            resolved.specialInstructions
          );
          return { ok: true, cartItemId, name: resolved.menuItem.name };
        }
        return { ok: false, reason: resolved.reason };
      });
    }

    // Build augmented message for AI
    const parts = ['[ORDER STATE]', orderContext, ''];
    if (comboContext) parts.push(comboContext, '');
    parts.push('[MENU SEARCH RESULTS]', menuContext, '', '[CUSTOMER MESSAGE]', userMessage);

    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...this.history,
      { role: 'user', content: parts.join('\n') },
    ];

    const raw = await this._callOpenAI(messages);
    const parsed = this._parseResponse(raw);

    // Process AI intent through MenuResolver (skip if split modifiers handled above)
    const intentResult = splitResults
      ? { ok: true, action: 'SPLIT', results: splitResults }
      : this._processIntent(parsed.intent);

    this.history.push({ role: 'user', content: userMessage });
    this.history.push({ role: 'assistant', content: raw });

    return {
      message: parsed.message,
      intent: parsed.intent || {},
      intentResult,
    };
  }

  // ─── INTENT PROCESSOR ────────────────────────────────────────────────────
  // Receives the AI's raw intent, validates through MenuResolver, updates cart.

  _processIntent(intent) {
    if (!intent || intent.action === 'NONE' || !intent.action) {
      return { ok: true, action: 'NONE' };
    }

    const { action, itemName, modifiers, quantity, specialInstructions } = intent;

    if (action === 'SET_ORDER_TYPE') {
      const val = (itemName || '').toLowerCase();
      if (val.includes('pickup') || val.includes('pick')) {
        this.cart.orderType = 'pickup';
      } else if (val.includes('delivery') || val.includes('deliver')) {
        this.cart.orderType = 'delivery';
      }
      return { ok: true, action };
    }

    if (action === 'ADD_ITEM') {
      const resolved = this.resolver.resolve({ itemName, modifiers, quantity, specialInstructions });
      if (!resolved.resolved) {
        return { ok: false, action, error: resolved.reason };
      }
      const cartItemId = this.cart.addItem(
        resolved.menuItem,
        resolved.validatedModifiers,
        quantity || 1,
        resolved.specialInstructions
      );
      return { ok: true, action, cartItemId, name: resolved.menuItem.name };
    }

    if (action === 'REMOVE_ITEM') {
      const needle = (itemName || '').toLowerCase();
      const item = this.cart.getActiveItems().find(i =>
        i.name.toLowerCase().includes(needle)
      );
      if (!item) return { ok: false, action, error: `"${itemName}" not found in cart` };
      this.cart.removeItem(item.cartItemId);
      return { ok: true, action };
    }

    if (action === 'UPDATE_ITEM') {
      const needle = (itemName || '').toLowerCase();
      const item = this.cart.getActiveItems().find(i =>
        i.name.toLowerCase().includes(needle)
      );
      if (!item) return { ok: false, action, error: `"${itemName}" not found in cart` };

      if (modifiers && modifiers.length > 0) {
        const resolved = this.resolver.resolve({ itemName, modifiers, specialInstructions });
        if (resolved.resolved && resolved.validatedModifiers.length > 0) {
          this.cart.updateModifiers(item.cartItemId, resolved.validatedModifiers);
        }
      }
      if (specialInstructions) {
        this.cart.addSpecialInstruction(item.cartItemId, specialInstructions);
      }
      if (quantity && quantity !== item.quantity) {
        this.cart.updateQuantity(item.cartItemId, quantity);
      }
      return { ok: true, action };
    }

    return { ok: true, action: 'NONE' };
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
      return { message: raw, intent: { action: 'NONE' } };
    }
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
    if (!matches.length) {
      return 'No matching items found for this query.';
    }

    let ctx = '';
    for (const item of matches.slice(0, 10)) {
      const price = item.base_price != null ? ` — $${item.base_price.toFixed(2)}` : '';
      ctx += `\n• ${item.name}${price} (${item.category})\n`;

      if (item.description) ctx += `  ${item.description}\n`;

      const analysis = this.menuEngine.analyzeModifiers(item);
      for (const g of analysis.mustAsk) {
        ctx += `  ${g.name} (required): ${g.options.map(o => o.name).join(', ')}\n`;
      }
      for (const g of analysis.shouldAsk) {
        ctx += `  ${g.name} (optional): ${g.options.map(o => o.name).join(', ')}\n`;
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
        `Item     : ${combo.item.name} — $${combo.item.base_price.toFixed(2)}`,
      ];
      if (combo.quantity && combo.quantity !== '1' && combo.quantity !== 'one') {
        lines.push(`Quantity : ${combo.quantity} — add as separate line items per the QUANTITY rule`);
      }
      lines.push(`Action   : Return ADD_ITEM intent with itemName "${combo.item.name}". Ask any required questions.`);
      return lines.join('\n');
    }

    if (combo.type === 'combo') {
      const lines = [
        '[COMBINATION ANALYSIS — MENU DATA VERIFIED]',
        `Status   : VALID COMBINATION`,
        `Base item: ${combo.item.name} — $${combo.item.base_price.toFixed(2)}`,
        `Modifier : "${combo.modifier.name}" (group: "${combo.modifier.groupName}")`,
      ];
      if (combo.quantity && combo.quantity !== '1' && combo.quantity !== 'one') {
        lines.push(`Quantity : ${combo.quantity} — add as separate line items`);
      }
      lines.push(`Action   : Return ADD_ITEM intent with itemName "${combo.item.name}" and include the modifier in intent.modifiers[]. Ask remaining required questions.`);
      return lines.join('\n');
    }

    if (combo.type === 'split') {
      const lines = [
        '[COMBINATION ANALYSIS — MENU DATA VERIFIED]',
        `Status   : SPLIT MODIFIER ORDER — ${combo.quantity} separate items — CODE HANDLES CART AUTOMATICALLY`,
        `Item     : ${combo.item.name} — $${combo.item.base_price.toFixed(2)}`,
      ];
      combo.instances.forEach((inst, i) => {
        lines.push(`Instance ${i + 1}: ${inst.description}`);
      });
      lines.push(`Action   : Set intent.action to NONE. Provide verbal confirmation only. The code will add both items.`);
      return lines.join('\n');
    }

    if (combo.type === 'not_combinable') {
      const suggestLine = combo.suggestions.length > 0
        ? `Closest menu options: ${combo.suggestions.map(s => `"${s.name}"`).join(', ')}`
        : 'No similar modifier options found in menu data.';
      return [
        '[COMBINATION ANALYSIS — MENU DATA VERIFIED]',
        `Status   : NOT A VALID COMBINATION`,
        `Requested: "${combo.queriedComponent}" — does NOT exist as a modifier on any matching item.`,
        suggestLine,
        `Action   : Set intent.action to NONE. Tell the customer this combination is not available. Suggest the closest real alternative using SPECIAL TERMINOLOGY.`,
      ].join('\n');
    }

    if (combo.type === 'not_found') {
      return [
        '[COMBINATION ANALYSIS — MENU DATA VERIFIED]',
        `Status   : NO MATCH FOUND`,
        `Action   : Set intent.action to NONE. Tell the customer this item is not on the menu.`,
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

      const ir = result.intentResult;
      if (ir && ir.action && ir.action !== 'NONE') {
        const ok = ir.ok ? '✓' : '✗';
        const detail = ir.cartItemId ? ` → ${ir.cartItemId}` : ir.error ? ` → ${ir.error}` : '';
        const name = ir.name ? ` "${ir.name}"` : result.intent?.itemName ? ` "${result.intent.itemName}"` : '';
        console.log(`  [${ok}] ${ir.action}${name}${detail}`);
      }
      if (ir && ir.results) {
        ir.results.forEach(r => {
          const ok = r.ok ? '✓' : '✗';
          console.log(`  [${ok}] SPLIT ADD_ITEM "${r.name || ''}"${r.cartItemId ? ' → ' + r.cartItemId : ''}`);
        });
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
