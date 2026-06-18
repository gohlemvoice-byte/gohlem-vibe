class MenuResolver {
  constructor(menuEngine) {
    this.menuEngine = menuEngine;
  }

  // Takes raw intent from AI and returns a validated order item from menu data.
  // modifiers in intent are plain text as customer said them ("sesame bagel",
  // "no eggplant"). This method matches them to real modifier options in the menu.
  resolve(intent) {
    const itemName = (intent.itemName || '').trim();
    if (!itemName) return { resolved: false, reason: 'No item name provided' };

    // Step 1 — find best matching menu item
    const matches = this.menuEngine.findItems(itemName, 3);
    if (!matches.length) {
      return { resolved: false, reason: `"${itemName}" not found on the menu` };
    }
    const menuItem = matches[0];

    // Step 2 — match each plain-text modifier to a real modifier option
    const validatedModifiers = [];
    const unmatchedText = [];

    for (const modText of (intent.modifiers || [])) {
      const match = this._findModifierOnItem(menuItem, modText);
      if (match) {
        validatedModifiers.push({
          id: match.id,
          name: match.name,
          action: this._inferAction(modText),
          price: match.price || 0,
          groupName: match.groupName,
        });
      } else {
        unmatchedText.push(modText);
      }
    }

    // Step 3 — unmatched modifier text becomes free-text special instructions
    const instrParts = [intent.specialInstructions || '', ...unmatchedText].filter(Boolean);
    const specialInstructions = instrParts.join('; ');

    // Step 4 — validate required modifiers
    const validation = this.menuEngine.validateOrder(
      menuItem.id,
      validatedModifiers.map(m => ({ optionId: m.id }))
    );

    const missingRequired = (validation.errors || []).filter(e => e.type === 'MISSING_REQUIRED');

    return {
      resolved: true,
      menuItem,
      validatedModifiers,
      specialInstructions,
      unitPrice: menuItem.base_price,
      missingRequired,
    };
  }

  // Fuzzy match a plain-text modifier description to a modifier option on the item.
  _findModifierOnItem(item, modText) {
    const tokens = this._tokenize(modText);
    let bestOption = null;
    let bestScore = 0;

    for (const group of (item.modifier_groups || [])) {
      for (const option of group.options) {
        const optTokens = this._tokenize(option.name);
        let score = 0;
        for (const t of tokens) {
          if (t.length <= 2) continue;
          for (const ot of optTokens) {
            if (ot === t) score += 10;
            else if (ot.includes(t) && t.length > 3) score += 5;
            else if (t.includes(ot) && ot.length > 3) score += 3;
          }
        }
        if (score >= 5 && score > bestScore) {
          bestScore = score;
          bestOption = { ...option, groupName: group.name };
        }
      }
    }

    return bestOption;
  }

  // Infer the modifier action from the customer's phrasing.
  _inferAction(modText) {
    const lower = modText.toLowerCase().trim();
    if (/^(no |without |remove )/.test(lower)) return 'REMOVE';
    if (/^(extra |more )/.test(lower)) return 'EXTRA';
    if (/^(light |less )/.test(lower)) return 'LIGHT';
    if (/on the side$|^on the side/.test(lower)) return 'SIDE';
    return 'ADD';
  }

  _tokenize(text) {
    return text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }
}

module.exports = MenuResolver;
