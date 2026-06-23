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
          nameTokens: this._tokenize(item.name),
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
  // This is what lets customers say "tuna" and find "Tuna Sandwich"
  // Or say "everything bagel" and find the right item
  // Completely generic — works for any menu

  findItems(query, maxResults = 5) {
    const queryTokens = this._tokenize(query);

    if (queryTokens.length === 0) return [];

    const scored = this.itemIndex
      .filter(item => item.available !== false)
      .map(item => {
        let score = 0;

        // Exact name match
        if (item.name.toLowerCase() === query.toLowerCase()) score += 100;

        // Name contains full query string
        if (item.name.toLowerCase().includes(query.toLowerCase())) score += 50;

        const nameTokenSet = new Set(item.nameTokens);
        // descTokenSet = tokens that exist in searchTokens but NOT in nameTokens
        const descTokenSet = new Set(item.searchTokens.filter(t => !nameTokenSet.has(t)));

        let nameMatchCount = 0;
        for (const qToken of queryTokens) {
          let nameHit = false;
          for (const nToken of nameTokenSet) {
            if (nToken === qToken)                             { score += 15; nameHit = true; nameMatchCount++; break; }
            else if (nToken.includes(qToken) && qToken.length > 3) { score += 8;  nameHit = true; nameMatchCount++; break; }
            else if (qToken.includes(nToken) && nToken.length > 3) { score += 5;  nameHit = true; nameMatchCount++; break; }
          }
          if (!nameHit) {
            for (const dToken of descTokenSet) {
              if (dToken === qToken)                             { score += 3; break; }
              else if (dToken.includes(qToken) && qToken.length > 3) { score += 2; break; }
              else if (qToken.includes(dToken) && dToken.length > 3) { score += 1; break; }
            }
          }
        }

        // Bonus: proportion of query tokens matched in name
        if (nameMatchCount > 0) score += Math.round((nameMatchCount / queryTokens.length) * 25);

        // Bonus: every query token matched in name (e.g. "tuna sandwich" → Tuna Sandwich)
        if (nameMatchCount === queryTokens.length && queryTokens.length > 0) score += 30;

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
  // Steps:
  //   0. Split modifier detection — "two X, one with Y, one with Z" pattern.
  //      Returns type:'split' with two instances so the AI can emit two
  //      ADD_ITEM actions without ambiguity.
  //   1. Strip intent words AND quantity words, then direct-match via startsWith.
  //      Quantity stripping fixes "two sourdough challahs" → finds "Sourdough
  //      Challah" correctly instead of failing because the string starts with "two".
  //   2. Combo scan using quantity-stripped tokens so "two" / "three" do not
  //      inflate scores on unrelated items.
  //   3. not_combinable / not_found fallback.

  resolveCombo(query) {
    // Step 0 — split modifier detection (must run before anything else)
    const splitResult = this._detectSplitModifiers(query);
    if (splitResult) return splitResult;

    // Step 1 — strip intent words then quantity words, then try direct match
    const intentStripped = query
      .toLowerCase()
      .replace(
        /^(i want|i'd like|i'll have|can i get|give me|add|i'll take|let me get|order me|i need)\s+(a\s+|an\s+|the\s+|some\s+)?/,
        ''
      )
      .trim();

    // Remove leading quantity word and capture it separately
    const qtyPattern = /^(ten|nine|eight|seven|six|five|four|three|two|one|a\s+couple\s+of|a\s+few|some|10|[1-9])\s+/i;
    const qtyMatch = intentStripped.match(qtyPattern);
    const detectedQuantity = qtyMatch ? qtyMatch[1].replace(/\s+/g, ' ').trim() : null;
    const cleanedQuery = qtyMatch ? intentStripped.slice(qtyMatch[0].length).trim() : intentStripped;

    if (!cleanedQuery) return { type: 'not_found' };

    // Build search tokens from the cleaned (quantity-stripped) query
    const searchTokens = this._tokenize(cleanedQuery);
    if (searchTokens.length === 0) return { type: 'not_found' };

    // Isolate item-name portion before the first preposition / second item
    const itemPart = cleanedQuery
      .split(/\s+(on\s+|with\s+|no\s+|without\s+|and\s+a\s+|and\s+an\s+|but\s+)/)[0]
      .trim();

    const topCandidates = this.findItems(itemPart || cleanedQuery, 8);
    for (const candidate of topCandidates) {
      const cName = candidate.name.toLowerCase();
      // Match if query starts with the item name OR (for short queries) item name starts with query
      if (cleanedQuery.startsWith(cName) ||
          (searchTokens.length <= 2 && cName.startsWith(cleanedQuery))) {
        return { type: 'direct', item: candidate, quantity: detectedQuantity };
      }
    }

    // Step 2 — combo scan using quantity-stripped tokens
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

    // Step 3 — not combinable or not found
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

  // Detects the split modifier pattern:
  //   "[qty] [item], one [prep] [mod1], [and] one [prep] [mod2]"
  // e.g. "two Mediterranean toasts, one with no eggplant, one with extra feta"
  // Returns type:'split' with per-instance modifier descriptions, or null.
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

  // Returns the highest-scoring modifier option on an item whose name tokens
  // overlap with the given query tokens. Returns null if nothing scores ≥ 1.
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

  // Finds modifier options on the given items whose tokens partially overlap
  // with the query tokens — used to build the suggestions list for NOT_COMBINABLE.
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
  // The core logic: for any item, what does the AI need to ask?
  // This is plug-and-play — driven purely by the menu data

  analyzeModifiers(item) {
    const analysis = {
      mustAsk: [],        // Required modifier groups with no default
      shouldAsk: [],      // Optional but high-impact modifier groups  
      willAssume: [],     // Optional with clear defaults — apply silently
      restrictions: []    // Special restrictions on this item
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
        // Required — always ask, no exceptions
        analysis.mustAsk.push({
          ...groupAnalysis,
          reason: 'Required by menu — must be answered before order can proceed'
        });
      } else {
        // Optional — apply intelligence
        const impact = this._assessModifierImpact(group);
        
        if (impact === 'high') {
          // Optional but significantly changes the item — ask
          analysis.shouldAsk.push({
            ...groupAnalysis,
            reason: impact_reason(group)
          });
        } else {
          // Optional, low impact — apply default silently
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

  // Assess whether an optional modifier is high-impact enough to ask about
  // This is the intelligence layer — not hardcoded, but rule-based
  _assessModifierImpact(group) {
    const name = group.name.toLowerCase();
    const options = group.options;
    
    // High impact signals:
    
    // 1. Has pricing differences between options (meaningfully changes cost)
    const hasPriceDifferences = options.some(o => o.price > 0.50);
    if (hasPriceDifferences) return 'high';
    
    // 2. Large number of options suggests meaningful choice
    if (options.length >= 6) return 'high';
    
    // 3. Name suggests it significantly changes the item
    const highImpactKeywords = [
      'size', 'type', 'style', 'base', 'protein', 'main', 
      'flavor', 'liquid', 'milk', 'temperature', 'meat'
    ];
    if (highImpactKeywords.some(k => name.includes(k))) return 'high';
    
    // 4. Multiple selections allowed (suggests meaningful customization)
    if (group.max_selections >= 3) return 'high';
    
    return 'low';
  }

  // Get the sensible default for an optional modifier
  _getDefaultOption(group) {
    const options = group.options;
    
    // Look for options that signal a default
    const defaultSignals = ['regular', 'standard', 'none', 'no ', 'plain', 'original'];
    
    for (const signal of defaultSignals) {
      const match = options.find(o => o.name.toLowerCase().includes(signal));
      if (match) return match;
    }
    
    // Fall back to first option (lowest price usually)
    const freeOptions = options.filter(o => o.price === 0);
    if (freeOptions.length > 0) return freeOptions[0];
    
    return options[0];
  }

  // ─── ORDER VALIDATION ─────────────────────────────────────────────────────
  // Given an item + selected modifiers, what's missing? What's invalid?

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
      // Find this modifier option across all groups
      for (const group of (item.modifier_groups || [])) {
        const option = group.options.find(o => o.id === modifier.optionId);
        if (option) {
          total += (option.price || 0) * (modifier.quantity || 1);
          break;
        }
      }
    }

    return Math.round(total * 100) / 100; // Round to 2 decimal places
  }

  // ─── GENERATE AI QUESTION ─────────────────────────────────────────────────
  // What should the AI actually say to ask about a modifier?
  // Generic — works for any restaurant, any modifier group

  generateQuestion(modifierGroup) {
    const options = modifierGroup.options;
    const name = modifierGroup.name;
    
    if (options.length <= 4) {
      // Short list — read all options
      const optionNames = options.map(o => {
        const priceStr = o.price > 0 ? ` (+$${o.price.toFixed(2)})` : '';
        return `${o.name}${priceStr}`;
      }).join(', ');
      return `What ${name.toLowerCase()} would you like? Options are: ${optionNames}.`;
    } else {
      // Long list — offer to read or let customer choose
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
// Run this file directly to see it working

if (require.main === module) {
  const menuData = JSON.parse(fs.readFileSync(path.join(__dirname, 'hot_bagels_menu_with_real_acai_restaurant.json'), 'utf8'));
  const engine = new GohlemMenuEngine(menuData);

  console.log('\n' + '='.repeat(60));
  console.log('GOHLEM MENU ENGINE — LIVE TEST');
  console.log('='.repeat(60));

  // ── TEST 1: Search for items ──
  console.log('\n📍 TEST 1: Customer says "I want a tuna sandwich"');
  const tunaResults = engine.findItems('tuna sandwich');
  console.log(`Found ${tunaResults.length} result(s):`);
  tunaResults.forEach(item => {
    console.log(`  → ${item.name} (${item.category}) — $${item.base_price}`);
  });

  // ── TEST 2: Fuzzy search ──
  console.log('\n📍 TEST 2: Customer says "something with lox"');
  const loxResults = engine.findItems('lox');
  console.log(`Found ${loxResults.length} result(s):`);
  loxResults.forEach(item => {
    console.log(`  → ${item.name} (${item.category}) — $${item.base_price}`);
  });

  // ── TEST 3: Modifier analysis ──
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

  // ── TEST 4: Order validation ──
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

  // ── TEST 5: Missing required modifier ──
  console.log('\n📍 TEST 5: What happens if bagel type is missing?');
  if (sandwich) {
    const validation = engine.validateOrder(sandwich.id, []);
    console.log(`Valid: ${validation.valid}`);
    console.log('Missing required modifiers:');
    validation.errors.forEach(e => {
      console.log(`  → ${e.message}`);
    });
  }

  // ── TEST 6: Smoothie search (strawberry test) ──
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
