'use strict';

// Price anomaly guard: prevents accidentally adding bulk/party items.
// Only fires when the item's base price is BOTH above the absolute floor
// AND more than the multiplier × average cart price.
// The absolute floor prevents the guard from blocking regular menu items
// (pizzas, entrees) when the cart contains mostly cheap drinks.
const PRICE_ANOMALY_MULTIPLIER = 4;
const PRICE_ANOMALY_FLOOR = 28;        // items under $28 never trigger this guard
const PRICE_ANOMALY_EMPTY_CART_FLOOR = 45; // threshold when cart is empty (no average to compare against)

// Catering item IDs. These require 24-48 hour advance notice.
// Populated from restaurantConfig.cateringItems.
const CATERING_CATEGORIES = ['Catering'];

class ToolHandler {
  constructor(menuEngine, cart, restaurantConfig) {
    this.engine = menuEngine;
    this.cart = cart;
    this.config = restaurantConfig;

    // Valid set: populated by search_menu, consumed by add_to_cart.
    // Reset after each successful add_to_cart (forces a fresh search per item).
    this.validItemIds = new Set();
    this.validModifierIds = new Map(); // itemId -> Set<optionId>
    this.lastSearchItems = [];         // full item objects from last search

    // Turn tracking: prevents cross-turn duplicate adds (B08/B05 fix).
    this.currentTurnId = 0;
    this.cartItemsAddedThisTurn = new Set(); // menu item IDs added this turn

    // Per-search result tracking for top-result enforcement (B17 fix).
    // Each search_menu call appends one entry: { topResultId, allResultIds, clarificationNeeded }
    // Guard 7 checks each add_to_cart against the search that returned that item.
    this.searchResults = [];

    // Failure counter: tracks how many times the same query has failed.
    this.failureCounts = new Map();
  }

  // Called at the start of each user turn to reset per-turn state.
  beginTurn(turnId) {
    this.currentTurnId = turnId;
    this.cartItemsAddedThisTurn.clear();
    this.searchResults = [];
  }

  execute(toolName, args) {
    switch (toolName) {
      case 'search_menu':      return this._searchMenu(args);
      case 'add_to_cart':      return this._addToCart(args);
      case 'remove_from_cart': return this._removeFromCart(args);
      case 'update_cart_item': return this._updateCartItem(args);
      case 'get_cart':         return this._getCart();
      default:
        return { success: false, error: 'UNKNOWN_TOOL', message: `Unknown tool: ${toolName}` };
    }
  }

  // ─── search_menu ────────────────────────────────────────────────────────────

  _searchMenu({ query }) {
    if (!query || !query.trim()) {
      return { found: false, message: 'Empty search query.' };
    }

    // Primary search
    let scored = this.engine.findItems(query, 5);

    // Secondary search on modifier content when primary fails
    if (scored.length === 0 || scored[0].score < 20) {
      const secondary = this.engine.secondarySearch(query);
      if (secondary.length > 0) {
        // Return the secondary results as a loose category match
        const results = secondary.slice(0, 5).map(item => this._formatItem(item));
        this._populateValidSet(secondary.slice(0, 5));
        return {
          found: true,
          clarification_needed: false,
          search_type: 'modifier_content',
          message: `Found ${results.length} items that include "${query}" as a modifier option.`,
          items: results,
        };
      }
      return {
        found: false,
        message: `"${query}" is not on our menu.`,
        suggestion: 'Let the customer know and offer to help them find something else.',
      };
    }

    const clarification_needed = this.engine.needsClarification(scored);
    const items = scored.map((r, i) => {
      const formatted = this._formatItem(r.item);
      if (i === 0) formatted.is_top_result = true;
      return formatted;
    });

    this._populateValidSet(scored.map(r => r.item));

    // Register this search for Guard 7 (B17 — top result enforcement).
    // Tracked per-search so multi-item orders (multiple search calls per turn)
    // each get their own top-result record and don't interfere with each other.
    this.searchResults.push({
      topResultId: scored[0].item.id,
      allResultIds: new Set(scored.map(r => r.item.id)),
      clarificationNeeded: clarification_needed,
    });

    return {
      found: true,
      clarification_needed,
      items,
      top_score: scored[0].score,
    };
  }

  _formatItem(item) {
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      price: item.base_price,
      description: item.description || '',
      modifier_groups: (item.modifier_groups || []).map(g => ({
        id: g.id,
        name: g.name,
        required: g.required,
        max_selections: g.max_selections,
        options: g.options.map(o => ({
          id: o.id,
          name: o.name,
          price: o.price,
        })),
      })),
    };
  }

  _populateValidSet(items) {
    // ACCUMULATE: do not clear — allow multiple parallel searches to coexist
    // so multi-item orders can call search_menu twice before add_to_cart.
    // The valid set is cleared per-turn (in conversationEngine.chat) and
    // per-item (in _addToCart) so cross-turn ID reuse is still blocked.
    for (const item of items) {
      this.validItemIds.add(item.id);
      this.validModifierIds.set(item.id, this.engine.getAllOptionIds(item));
    }
    this.lastSearchItems = [...this.lastSearchItems, ...items.filter(
      i => !this.lastSearchItems.find(e => e.id === i.id)
    )];
  }

  clearValidSet() {
    this.validItemIds.clear();
    this.validModifierIds.clear();
    this.lastSearchItems = [];
  }

  // ─── add_to_cart ────────────────────────────────────────────────────────────

  _addToCart({ item_id, modifier_option_ids = [], quantity = 1, special_instructions = '' }) {

    // Guard 1: item must come from the most recent search_menu call
    if (!this.validItemIds.has(item_id)) {
      return {
        success: false,
        error: 'INVALID_ITEM_ID',
        message: 'This item ID was not returned by the most recent search_menu call. Call search_menu first.',
      };
    }

    const menuItem = this.engine.getItemById(item_id);
    if (!menuItem) {
      return { success: false, error: 'ITEM_NOT_FOUND', message: 'Item not found in menu.' };
    }

    // Guard 2: validate all modifier IDs against the valid set for this item
    const validModsForItem = this.validModifierIds.get(item_id) || new Set();
    const invalidIds = modifier_option_ids.filter(id => !validModsForItem.has(id));
    if (invalidIds.length > 0) {
      return {
        success: false,
        error: 'INVALID_MODIFIER_ID',
        message: `These modifier IDs were not in the search results: ${invalidIds.join(', ')}. Only use IDs from the search_menu response.`,
      };
    }

    // Guard 3: check required modifier groups
    const requiredGroups = this.engine.getRequiredGroups(menuItem);
    const missing = [];
    for (const group of requiredGroups) {
      const groupOptionIds = new Set(group.options.map(o => o.id));
      const selectedFromGroup = modifier_option_ids.filter(id => groupOptionIds.has(id));
      if (selectedFromGroup.length === 0) {
        missing.push({
          group_id: group.id,
          group_name: group.name,
          options: group.options.map(o => ({ id: o.id, name: o.name, price: o.price })),
        });
      }
    }
    if (missing.length > 0) {
      return {
        success: false,
        error: 'MISSING_REQUIRED',
        message: `Missing required selections for: ${missing.map(g => g.group_name).join(', ')}.`,
        missing_required: missing,
        prompt: `Ask the customer to choose from: ${missing.map(g => g.group_name).join(', ')}.`,
      };
    }

    // Guard 3b: max_selections — prevent over-selection within a modifier group (B09)
    const allModGroups = menuItem.modifier_groups || [];
    const overLimit = [];
    for (const group of allModGroups) {
      if (group.max_selections && group.max_selections > 0) {
        const groupOptionIds = new Set(group.options.map(o => o.id));
        const selectedFromGroup = modifier_option_ids.filter(id => groupOptionIds.has(id));
        if (selectedFromGroup.length > group.max_selections) {
          overLimit.push({
            group_name: group.name,
            max_allowed: group.max_selections,
            selected_count: selectedFromGroup.length,
            options: group.options.map(o => ({ id: o.id, name: o.name, price: o.price })),
          });
        }
      }
    }
    if (overLimit.length > 0) {
      return {
        success: false,
        error: 'EXCEEDS_MAX_SELECTIONS',
        message: `Too many selections for: ${overLimit.map(g => `${g.group_name} (max ${g.max_allowed}, got ${g.selected_count})`).join(', ')}.`,
        over_limit_groups: overLimit,
        prompt: `Ask the customer to pick only ${overLimit.map(g => g.max_allowed === 1 ? `one from ${g.group_name}` : `${g.max_allowed} from ${g.group_name}`).join(', ')}.`,
      };
    }

    // Guard 4: catering items require advance notice
    if (CATERING_CATEGORIES.includes(menuItem.category)) {
      return {
        success: false,
        error: 'RESTRICTION_CATERING',
        message: `${menuItem.name} is a catering item requiring 24-48 hours advance notice.`,
        prompt: 'Inform the customer that catering orders require 24-48 hours advance notice. Ask if they are placing a future order.',
      };
    }

    // Guard 5: price anomaly — block silent addition of bulk/party items.
    // When cart has items: block if price > 4× the average.
    // When cart is empty: block if price > PRICE_ANOMALY_EMPTY_CART_FLOOR.
    // Previously the guard was skipped entirely on empty carts (avgCartPrice > 0 was false),
    // allowing any item — including party trays — to be added as the first item with no confirmation.
    const avgCartPrice = this._getAvgCartItemPrice();
    const priceThreshold = avgCartPrice > 0
      ? avgCartPrice * PRICE_ANOMALY_MULTIPLIER
      : PRICE_ANOMALY_EMPTY_CART_FLOOR;
    if (menuItem.base_price >= PRICE_ANOMALY_FLOOR && menuItem.base_price > priceThreshold) {
      const context = avgCartPrice > 0
        ? `higher than your average cart item ($${avgCartPrice.toFixed(2)})`
        : `high for a first item`;
      return {
        success: false,
        error: 'PRICE_ANOMALY',
        message: `${menuItem.name} costs $${menuItem.base_price.toFixed(2)}, which is significantly ${context}.`,
        prompt: `Confirm with the customer: "Just to confirm, you'd like to add ${menuItem.name} at $${menuItem.base_price.toFixed(2)}?"`,
      };
    }

    // Guard 7: top-result enforcement (B17 fix).
    // Find the specific search that returned this item, then check if the item
    // was the top result for that search. Only blocks when the search was confident
    // (clarification not needed). Prevents silent item substitution (California
    // Roll → Holiday Roll) without breaking multi-item orders.
    const relevantSearch = this.searchResults.find(s => s.allResultIds.has(item_id));
    if (relevantSearch && item_id !== relevantSearch.topResultId && !relevantSearch.clarificationNeeded) {
      const topItem = this.engine.getItemById(relevantSearch.topResultId);
      if (topItem) {
        return {
          success: false,
          error: 'NOT_TOP_RESULT',
          message: `The best match was "${topItem.name}" (ID: ${relevantSearch.topResultId}), not "${menuItem.name}". Use the top result unless the customer explicitly asked for a different item.`,
          top_result_id: relevantSearch.topResultId,
          top_result_name: topItem.name,
          prompt: `Use item_id "${relevantSearch.topResultId}" (${topItem.name}) instead. Only proceed with "${menuItem.name}" if the customer specifically requested it.`,
        };
      }
    }

    // Build modifier objects for the cart
    const modifiers = modifier_option_ids.map(optId => {
      const opt = this.engine.getOptionById(menuItem, optId);
      return {
        id: optId,
        name: opt ? opt.name : optId,
        price: opt ? opt.price : 0,
        groupId: opt ? opt.groupId : null,
        groupName: opt ? opt.groupName : null,
      };
    });

    const cartItemId = this.cart.addItem(menuItem, modifiers, quantity, special_instructions);

    // Track this add for Guard 6 same-turn detection.
    this.cartItemsAddedThisTurn.add(item_id);

    // Remove ONLY this item from the valid set. Other items searched in the
    // same turn (parallel searches for multi-item orders) remain valid.
    this.validItemIds.delete(item_id);
    this.validModifierIds.delete(item_id);
    this.lastSearchItems = this.lastSearchItems.filter(i => i.id !== item_id);

    const addedItem = this.cart.getItem(cartItemId);
    return {
      success: true,
      cart_item_id: cartItemId,
      item_name: menuItem.name,
      quantity,
      modifiers_applied: modifiers.map(m => m.name),
      line_total: addedItem ? addedItem.lineTotal : null,
      cart_summary: this.cart.getSummary(),
    };
  }

  // ─── remove_from_cart ───────────────────────────────────────────────────────

  _removeFromCart({ cart_item_id }) {
    const item = this.cart.getItem(cart_item_id);
    if (!item) {
      return { success: false, error: 'NOT_IN_CART', message: `No cart item found with ID ${cart_item_id}.` };
    }
    const name = item.name;
    this.cart.removeItem(cart_item_id);
    return { success: true, removed_item: name, cart_summary: this.cart.getSummary() };
  }

  // ─── update_cart_item ───────────────────────────────────────────────────────

  _updateCartItem({ cart_item_id, add_modifier_ids = [], remove_modifier_ids = [], quantity, special_instructions }) {
    const item = this.cart.getItem(cart_item_id);
    if (!item || item.status !== 'confirmed') {
      return { success: false, error: 'NOT_IN_CART', message: `No active cart item found with ID ${cart_item_id}.` };
    }

    const menuItem = this.engine.getItemById(item.menuItemId);

    // Validate any add_modifier_ids against the current valid set (or item's own options)
    if (add_modifier_ids.length > 0 && menuItem) {
      const allItemOptionIds = this.engine.getAllOptionIds(menuItem);
      const invalid = add_modifier_ids.filter(id => !allItemOptionIds.has(id));
      if (invalid.length > 0) {
        return {
          success: false,
          error: 'INVALID_MODIFIER_ID',
          message: `Invalid modifier IDs: ${invalid.join(', ')}. Search the item first to get valid IDs.`,
        };
      }
    }

    // Build updated modifiers
    let currentModifiers = [...item.modifiers];

    // Remove specified modifiers
    if (remove_modifier_ids.length > 0) {
      currentModifiers = currentModifiers.filter(m => !remove_modifier_ids.includes(m.id));
    }

    // Add new modifiers
    if (add_modifier_ids.length > 0 && menuItem) {
      for (const optId of add_modifier_ids) {
        if (!currentModifiers.find(m => m.id === optId)) {
          const opt = this.engine.getOptionById(menuItem, optId);
          currentModifiers.push({
            id: optId,
            name: opt ? opt.name : optId,
            price: opt ? opt.price : 0,
            groupId: opt ? opt.groupId : null,
            groupName: opt ? opt.groupName : null,
          });
        }
      }
    }

    this.cart.updateModifiers(cart_item_id, currentModifiers);
    if (quantity !== undefined) this.cart.updateQuantity(cart_item_id, quantity);
    if (special_instructions !== undefined) {
      const updated = this.cart.getItem(cart_item_id);
      if (updated) updated.specialInstructions = special_instructions;
    }

    const updated = this.cart.getItem(cart_item_id);
    return {
      success: true,
      cart_item_id,
      item_name: item.name,
      updated_modifiers: updated ? updated.modifiers.map(m => m.name) : [],
      cart_summary: this.cart.getSummary(),
    };
  }

  // ─── get_cart ───────────────────────────────────────────────────────────────

  _getCart() {
    const active = this.cart.getActiveItems();
    return {
      order_type: this.cart.orderType || null,
      delivery_address: this.cart.deliveryAddress || null,
      items: active.map((item, i) => ({
        position: i + 1,
        cart_item_id: item.cartItemId,
        name: item.name,
        quantity: item.quantity,
        modifiers: item.modifiers.map(m => ({ name: m.name, price: m.price })),
        unit_price: item.unitPrice,
        line_total: item.lineTotal,
        special_instructions: item.specialInstructions || '',
      })),
      item_count: active.length,
      subtotal: this.cart.getTotal(),
      is_empty: this.cart.isEmpty(),
      summary: this.cart.getSummary(),
    };
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────────

  _getAvgCartItemPrice() {
    const active = this.cart.getActiveItems();
    if (active.length === 0) return 0;
    const total = active.reduce((s, item) => s + item.unitPrice, 0);
    return total / active.length;
  }
}

module.exports = ToolHandler;
