const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const fs = require('fs');
const OpenAI = require('openai');
const GohlemMenuEngine = require('../../gohlem-menu-engine');
const { OrderCart, buildSystemPrompt } = require('../orders/orderState');
const MenuResolver = require('../orders/menuResolver');
const restaurantConfig = require('../config/restaurantConfig');
const { ConversationController } = require('./conversationController');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: globalThis.fetch });

class ConversationEngine {
  constructor(menuFilePath) {
    const menuData = JSON.parse(fs.readFileSync(menuFilePath, 'utf8'));
    this.menuEngine   = new GohlemMenuEngine(menuData);
    this.cart         = new OrderCart();
    this.resolver     = new MenuResolver(this.menuEngine);
    this.systemPrompt = buildSystemPrompt(restaurantConfig);
    this.history      = [];
    this.controller   = new ConversationController(this.menuEngine);
    // Per-turn search enforcement state
    this._searchCalledThisTurn = false;
    this._lastSearchResults    = [];
  }

  // ─── OPEN CALL ────────────────────────────────────────────────────────────

  async open() {
    const version = restaurantConfig.restaurantInfo.version;
    const greeting = `${version}. Thank you for calling Hot Bagels on 2nd Street. How can I help you today?`;
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
          `(Call just connected. Your opening greeting must be exactly: "${greeting}")`,
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
    // Reset per-turn search enforcement state
    this._searchCalledThisTurn = false;
    this._lastSearchResults    = [];

    // Order type detection — code-side, never rely on AI action
    if (!this.cart.orderType) {
      const lower = userMessage.toLowerCase();
      if (/\bpick\s*-?\s*up\b|\bpickup\b/.test(lower))   this.cart.orderType = 'pickup';
      else if (/\bdeliver(y|ing)?\b/.test(lower))         this.cart.orderType = 'delivery';
    }

    let messages, raw, parsed, intentResult, splitResults = null;
    let topMatch = null; // best menu item candidate for controller.detectStateFromAIResponse

    // ── Controller routing ──────────────────────────────────────────────────
    const inputResult = this.controller.processInput(userMessage);

    if (inputResult.bypassMenuSearch) {
      // ── AWAITING_MODIFIER path: match customer answer directly ────────────
      const orderContext = this._buildOrderContext();

      if (inputResult.customerDone) {
        // Customer finished modifier collection — add item to cart directly
        const item = this.controller.currentItem;
        const cartItemId = this.cart.addItem(item.menuItem, item.modifiers, 1, '');
        const collected  = item.modifiers.map(m => m.name).join(', ') || 'no extra modifiers';
        intentResult = { ok: true, action: 'ADD_ITEM', cartItemId, name: item.menuItem.name };
        this.controller.currentItem = null;
        topMatch = null;

        messages = [
          { role: 'system', content: this.systemPrompt },
          ...this.history,
          {
            role: 'user',
            content: [
              '[ITEM ADDED TO CART]',
              `"${item.menuItem.name}" added with: ${collected}`,
              `Customer message: "${userMessage}" — they may be done ordering or want to continue.`,
              'Confirm the addition and ask if they want anything else, OR read back the full order if they said that\'s it.',
              '',
              '[ORDER STATE]', this._buildOrderContext(),
              '',
              '[CUSTOMER MESSAGE]', userMessage,
            ].join('\n'),
          },
        ];

        raw    = await this._callOpenAI(messages);
        parsed = this._parseResponse(raw);

      } else if (inputResult.modifierMatched) {
        const opt = inputResult.modifierMatched;
        this.controller.addModifier(opt, inputResult.askedGroup.name);

        const item      = this.controller.currentItem;
        const analysis  = this.menuEngine.analyzeModifiers(item.menuItem);
        const required  = analysis.mustAsk.map(g => g.name);
        const satisfied = new Set(item.modifiers.map(m => m.groupName));
        const missing   = required.filter(n => !satisfied.has(n));
        const collected = item.modifiers.map(m => `${m.name} (${m.groupName})`).join(', ');

        // Advance to next pending group
        const nextGroup = this.controller.advanceToNextGroup();

        let directive;
        if (missing.length > 0) {
          const nextRequired = analysis.mustAsk.find(g => !satisfied.has(g.name));
          directive = [
            `Still need required modifier: "${nextRequired.name}".`,
            `Options: ${nextRequired.options.map(o => o.name).join(', ')}`,
            `Ask the customer for their ${nextRequired.name} choice.`,
          ].join(' ');
        } else if (nextGroup) {
          directive = [
            `Required modifier satisfied. Collected so far: ${collected}`,
            `Now ask specifically about "${nextGroup.name}".`,
            `Options: ${nextGroup.options.map(o => o.name).join(', ')}`,
          ].join(' ');
        } else {
          directive = [
            `All modifier questions answered. Collected: ${collected}`,
            `Add "${item.menuItem.name}" to cart now using ADD_ITEM intent with all collected modifiers.`,
          ].join(' ');
        }

        messages = [
          { role: 'system', content: this.systemPrompt },
          ...this.history,
          {
            role: 'user',
            content: [
              '[MODIFIER RESOLVED]',
              `Customer answered: "${userMessage}"`,
              `Matched to: "${opt.name}" in group "${inputResult.askedGroup.name}"`,
              directive,
              '',
              '[ORDER STATE]', orderContext,
              '',
              '[CUSTOMER MESSAGE]', userMessage,
            ].join('\n'),
          },
        ];
        topMatch = item.menuItem;

        raw    = await this._callOpenAI(messages);
        parsed = this._parseResponse(raw);
        intentResult = this._processIntent(parsed.intent);

        if (intentResult.ok && intentResult.action === 'ADD_ITEM') {
          this.controller.currentItem = null;
        }

      } else if (inputResult.continuationPhrase) {
        // Customer pausing/thinking mid-modifier collection — stay in AWAITING_MODIFIER
        messages = [
          { role: 'system', content: this.systemPrompt },
          ...this.history,
          {
            role: 'user',
            content: [
              '[CUSTOMER PAUSING]',
              `Customer said: "${userMessage}" — they are still deciding.`,
              `We are waiting for their answer about "${inputResult.askedGroup.name}".`,
              'Respond naturally (e.g. "Of course, take your time.") and gently re-ask the same question.',
              '',
              '[ORDER STATE]', orderContext,
              '',
              '[CUSTOMER MESSAGE]', userMessage,
            ].join('\n'),
          },
        ];
        topMatch = this.controller.currentItem?.menuItem || null;

        raw    = await this._callOpenAI(messages);
        parsed = this._parseResponse(raw);
        intentResult = { ok: true, action: 'NONE' };

      } else {
        // No match — ask again
        messages = [
          { role: 'system', content: this.systemPrompt },
          ...this.history,
          {
            role: 'user',
            content: [
              '[MODIFIER NOT MATCHED]',
              `Customer said: "${userMessage}" — no match in "${inputResult.askedGroup.name}".`,
              `Valid options: ${inputResult.askedGroup.options.map(o => o.name).join(', ')}`,
              'Please politely ask again for this modifier.',
              '',
              '[ORDER STATE]', orderContext,
              '',
              '[CUSTOMER MESSAGE]', userMessage,
            ].join('\n'),
          },
        ];
        topMatch = this.controller.currentItem?.menuItem || null;

        raw    = await this._callOpenAI(messages);
        parsed = this._parseResponse(raw);
        intentResult = this._processIntent(parsed.intent);

        if (intentResult.ok && intentResult.action === 'ADD_ITEM') {
          this.controller.currentItem = null;
        }
      }

    } else {
      // ── Normal ORDERING path ─────────────────────────────────────────────
      const orderContext = this._buildOrderContext();

      const cartNonEmpty = !this.cart.isEmpty();

      // "remove that/it/this" → remove most recently added item code-side
      const removeThatPat   = /^(remove|cancel|take off)\s+(that|it|this|the last one)[.!?]*$/i;
      const removeThatMatch = cartNonEmpty && removeThatPat.test(userMessage.trim());

      // "remove the [item name]" → code-side named-item removal (bypasses combo ADD context)
      const REMOVE_GENERIC = new Set(['sandwich', 'bagel', 'wrap', 'bowl', 'item', 'order', 'the', 'and', 'with', 'from', 'please', 'that', 'this', 'one']);
      const removeNamedPat = /^(?:please\s+)?(?:remove|cancel|delete)\s+(?:the\s+|my\s+)?(.+?)[.!?]*$/i;
      const removeNamedExec = cartNonEmpty && !removeThatMatch && removeNamedPat.exec(userMessage.trim());
      const removeNamedItem = removeNamedExec ? (() => {
        const words = removeNamedExec[1].toLowerCase().split(/\s+/)
          .filter(w => w.length > 2 && !REMOVE_GENERIC.has(w));
        if (words.length === 0) return null;
        return this.cart.getActiveItems().find(i =>
          words.some(w => i.name.toLowerCase().includes(w))
        ) || null;
      })() : null;

      // Done-phrase with non-empty cart → skip menu search, prompt order read-back
      const isDonePhrase = cartNonEmpty
        && /^(that('?s)?( it| all)?|nothing(?: else)?|no(?: (?:more|thanks?|thank you))?|done|finished|nope)\b/i
            .test(userMessage.trim());

      // "Keep only / just keep / remove the others" → remove unlisted items code-side
      const keepOnlyPattern = /\b(just keep|keep only|remove (the )?(others?|rest|everything else)|cancel (the )?(others?|rest|everything else))\b/i;
      const keepOnlyMatch   = cartNonEmpty && keepOnlyPattern.test(userMessage);

      // Continuation phrase (thinking, pausing) — only when the phrase IS the entire message
      const isContinuationPhrase = /^(not yet|i'?m not done|wait|hold on|actually|one more thing|also)[.!,?]*$/i
        .test(userMessage.trim());

      if (removeThatMatch) {
        // Remove the most recently added cart item
        const lastItem = this.cart.getActiveItems().slice(-1)[0];
        this.cart.removeItem(lastItem.cartItemId);

        messages = [
          { role: 'system', content: this.systemPrompt },
          ...this.history,
          {
            role: 'user',
            content: [
              '[ITEM REMOVED]',
              `"${lastItem.name}" has been removed from the order.`,
              'Confirm the removal briefly.',
              '',
              '[ORDER STATE]', this._buildOrderContext(),
              '',
              '[CUSTOMER MESSAGE]', userMessage,
            ].join('\n'),
          },
        ];

        raw    = await this._callOpenAI(messages);
        parsed = this._parseResponse(raw);
        intentResult = { ok: true, action: 'NONE' };

      } else if (removeNamedItem) {
        // Remove identified cart item by name, bypassing combo ADD confusion
        this.cart.removeItem(removeNamedItem.cartItemId);
        // If this was the item being built in AWAITING_MODIFIER, clear the pending item
        if (this.controller.currentItem?.menuItem?.id === removeNamedItem.menuItemId) {
          this.controller.currentItem = null;
          this.controller.state = 'ORDERING';
        }

        messages = [
          { role: 'system', content: this.systemPrompt },
          ...this.history,
          {
            role: 'user',
            content: [
              '[ITEM REMOVED]',
              `"${removeNamedItem.name}" has been removed from the order.`,
              'Confirm the removal briefly.',
              '',
              '[ORDER STATE]', this._buildOrderContext(),
              '',
              '[CUSTOMER MESSAGE]', userMessage,
            ].join('\n'),
          },
        ];

        raw    = await this._callOpenAI(messages);
        parsed = this._parseResponse(raw);
        intentResult = { ok: true, action: 'NONE' };

      } else if (isDonePhrase) {
        messages = [
          { role: 'system', content: this.systemPrompt },
          ...this.history,
          {
            role: 'user',
            content: [
              '[CUSTOMER DONE ORDERING]',
              'Customer has indicated they are finished ordering.',
              'Read back their complete order, state the total, and ask for confirmation.',
              '',
              '[ORDER STATE]', orderContext,
              '',
              '[CUSTOMER MESSAGE]', userMessage,
            ].join('\n'),
          },
        ];

        raw    = await this._callOpenAI(messages);
        parsed = this._parseResponse(raw);
        intentResult = { ok: true, action: 'NONE' };

      } else if (keepOnlyMatch) {
        // Remove all items not named in the message
        // Filter out generic nouns that appear in many item names so they don't produce false keeps
        const GENERIC = new Set(['sandwich', 'bagel', 'wrap', 'bowl', 'item', 'order', 'the', 'and', 'with', 'from', 'also', 'for', 'one', 'two', 'please', 'just', 'keep', 'only', 'others', 'rest']);
        const msgLower = userMessage.toLowerCase();
        const active   = this.cart.getActiveItems();
        const removed  = [];
        const kept     = [];
        for (const item of active) {
          const words = item.name.toLowerCase().split(/\s+/)
            .filter(w => w.length > 2 && !GENERIC.has(w));
          // If no distinguishing words remain, fall back to full name substring match
          const named = words.length > 0
            ? words.some(w => msgLower.includes(w))
            : msgLower.includes(item.name.toLowerCase());
          if (named) {
            kept.push(item.name);
          } else {
            this.cart.removeItem(item.cartItemId);
            removed.push(item.name);
          }
        }

        messages = [
          { role: 'system', content: this.systemPrompt },
          ...this.history,
          {
            role: 'user',
            content: [
              '[ITEMS REMOVED]',
              removed.length > 0
                ? `Removed from cart: ${removed.join(', ')}.`
                : 'No items were removed (all named items matched).',
              kept.length > 0
                ? `Remaining in cart: ${kept.join(', ')}.`
                : 'Cart is now empty.',
              'Confirm what was removed and what remains.',
              '',
              '[ORDER STATE]', this._buildOrderContext(),
              '',
              '[CUSTOMER MESSAGE]', userMessage,
            ].join('\n'),
          },
        ];

        raw    = await this._callOpenAI(messages);
        parsed = this._parseResponse(raw);
        intentResult = { ok: true, action: 'NONE' };

      } else if (isContinuationPhrase) {
        // Customer pausing/thinking — don't search menu, wait for their actual request
        messages = [
          { role: 'system', content: this.systemPrompt },
          ...this.history,
          {
            role: 'user',
            content: [
              '[CUSTOMER CONTINUING]',
              'Customer is still deciding or has more to add.',
              'Respond naturally and wait for them to tell you what they want.',
              '',
              '[ORDER STATE]', orderContext,
              '',
              '[CUSTOMER MESSAGE]', userMessage,
            ].join('\n'),
          },
        ];

        raw    = await this._callOpenAI(messages);
        parsed = this._parseResponse(raw);
        intentResult = { ok: true, action: 'NONE' };

      } else {

      const matches      = this.menuEngine.findItems(userMessage);
      const combo        = this.menuEngine.resolveCombo(userMessage);
      const menuContext  = this._buildMenuContext(matches);
      const comboContext = this._buildComboContext(combo);
      topMatch = matches[0] || null;

      // Record which item names are valid for this turn
      this._searchCalledThisTurn = true;
      this._lastSearchResults = [...new Set([
        ...matches.map(m => m.name),
        ...(combo?.item ? [combo.item.name] : []),
      ])];

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
              resolved.menuItem, resolved.validatedModifiers, 1, resolved.specialInstructions
            );
            return { ok: true, cartItemId, name: resolved.menuItem.name };
          }
          return { ok: false, reason: resolved.reason };
        });
      }

      const parts = ['[ORDER STATE]', orderContext, ''];
      if (comboContext) parts.push(comboContext, '');
      parts.push('[MENU SEARCH RESULTS]', menuContext, '', '[CUSTOMER MESSAGE]', userMessage);

      messages = [
        { role: 'system', content: this.systemPrompt },
        ...this.history,
        { role: 'user', content: parts.join('\n') },
      ];

      raw    = await this._callOpenAI(messages);
      parsed = this._parseResponse(raw);
      intentResult = splitResults
        ? { ok: true, action: 'SPLIT', results: splitResults }
        : this._processIntent(parsed.intent);

      // Search enforcement: if AI named an item not in search results, retry once
      if (!intentResult.ok && intentResult.searchEnforced) {
        const retryMessages = [
          { role: 'system', content: this.systemPrompt },
          ...this.history,
          {
            role: 'user',
            content: [
              '[MANDATORY ENFORCEMENT ERROR]',
              intentResult.error,
              'You must only use item names that appear in the MENU SEARCH RESULTS below.',
              '',
              '[MENU SEARCH RESULTS]', menuContext,
              '',
              '[ORDER STATE]', orderContext,
              '',
              '[CUSTOMER MESSAGE]', userMessage,
            ].join('\n'),
          },
        ];
        raw    = await this._callOpenAI(retryMessages);
        parsed = this._parseResponse(raw);
        intentResult = this._processIntent(parsed.intent);
      }

      // Use resolved item as topMatch so detectStateFromAIResponse can find
      // the right modifier groups whether the item was added or is still pending
      if (intentResult.ok && intentResult.menuItem) {
        topMatch = intentResult.menuItem;
        this.controller.currentItem = null; // item is in cart, no longer pending
      } else if (!intentResult.ok && intentResult.pendingItem) {
        topMatch = intentResult.pendingItem; // item blocked — controller will collect modifiers
      }

      } // end else (menu search path)
    }

    // ── Update controller state from AI response ────────────────────────────
    this.controller.detectStateFromAIResponse(parsed.message, topMatch);

    this.history.push({ role: 'user', content: userMessage });
    this.history.push({ role: 'assistant', content: raw });

    return {
      message:         parsed.message,
      intent:          parsed.intent || {},
      intentResult,
      controllerState: this.controller.getState(),
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
      // Enforce: itemName must match one of the names returned by search_menu this turn
      if (this._searchCalledThisTurn) {
        const nameMatch = this._lastSearchResults.some(
          n => n.toLowerCase() === (itemName || '').toLowerCase().trim()
        );
        if (!nameMatch) {
          return {
            ok: false,
            action,
            searchEnforced: true,
            error: `"${itemName}" was not in the search results for this turn.` +
              (this._lastSearchResults.length > 0
                ? ` You must call add_to_cart with one of these names: ${this._lastSearchResults.join(', ')}`
                : ' No items matched the search. Do not add anything.'),
          };
        }
      }

      const resolved = this.resolver.resolve({ itemName, modifiers, quantity, specialInstructions });
      if (!resolved.resolved) {
        return { ok: false, action, error: resolved.reason };
      }
      // Block add when required modifiers are missing — controller will collect them
      if (resolved.missingRequired && resolved.missingRequired.length > 0) {
        return {
          ok: false,
          action,
          pendingItem: resolved.menuItem,
          missingRequired: resolved.missingRequired,
          error: `Missing required: ${resolved.missingRequired.map(e => e.groupName).join(', ')}`,
        };
      }
      const cartItemId = this.cart.addItem(
        resolved.menuItem,
        resolved.validatedModifiers,
        quantity || 1,
        resolved.specialInstructions
      );
      return { ok: true, action, cartItemId, name: resolved.menuItem.name, menuItem: resolved.menuItem };
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
      ctx += `Running total: $${this.cart.getTotal().toFixed(2)}\n`;
      ctx += 'IMPORTANT: The cartItemId entries above are the ONLY confirmed items in this order. Do not reference, modify, or remove any item that does not appear in this list. If an item appears here, it exists — do not say it is unavailable.';
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
    this.cart                   = new OrderCart();
    this.history                = [];
    this.controller             = new ConversationController(this.menuEngine);
    this._searchCalledThisTurn  = false;
    this._lastSearchResults     = [];
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
