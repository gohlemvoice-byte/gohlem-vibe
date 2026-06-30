'use strict';

const fs = require('fs');

// Word-level alias normalization. Runs before every search.
// Only add aliases for words that do NOT appear as tokens in item names.
// If the word already matches a token, no alias is needed — use TOKEN_EQUIVALENTS instead.
const WORD_ALIASES = {
  sub: 'hero',
  subs: 'hero',
  hoagie: 'hero',
  hoagies: 'hero',
  grinder: 'hero',
  grinders: 'hero',
  // "parmesan" does not appear in item names; items say "parm" or "parmigiana"
  parmesan: 'parmigiana',
};

// Semantic token equivalence groups used in scoring only — does NOT change the query.
// Tokens within the same Set match each other at the +15 level (same as exact match).
// Use this when different restaurants name the same concept differently (pie vs pizza).
const TOKEN_EQUIVALENTS = [
  new Set(['pizza', 'pie']),
];

function tokensMatch(t1, t2) {
  if (t1 === t2) return true;
  return TOKEN_EQUIVALENTS.some(group => group.has(t1) && group.has(t2));
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'with', 'for', 'to', 'in',
  'some', 'me', 'can', 'get', 'have', 'like', 'want', 'please', 'just',
  'i', "i'd", "i'll", "i'm",
]);

class MenuEngine {
  constructor() {
    this.items = [];
    this.restaurantMeta = {};
  }

  // ─── LOADING ────────────────────────────────────────────────────────────────

  loadMenu(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    this.restaurantMeta = raw.restaurant || {};
    this.items = this._normalize(raw);
    return this;
  }

  loadMenuFromData(data) {
    this.restaurantMeta = data.restaurant || {};
    this.items = this._normalize(data);
    return this;
  }

  // Accepts flat items[] (Tony's format) or nested menu.categories[].items[] (Hot Bagels / sushi format).
  _normalize(data) {
    let rawItems = [];

    if (Array.isArray(data.items)) {
      rawItems = data.items;
    } else if (data.menu && Array.isArray(data.menu.categories)) {
      for (const cat of data.menu.categories) {
        for (const item of (cat.items || [])) {
          rawItems.push({ ...item, category: item.category || cat.name });
        }
      }
    }

    return rawItems.map(item => ({
      ...this._canonicalizeItem(item),
      available: item.available !== false,
      nameTokens: this._tokenize(item.name),
      descTokens: this._tokenize(item.description || ''),
    }));
  }

  // Convert sushi/pizza schema (modifiers, max_select, price_delta, price) to
  // canonical schema (modifier_groups, max_selections, price, base_price).
  _canonicalizeItem(item) {
    const out = { ...item };

    // base_price: use existing base_price, or fall back to price
    if (out.base_price === undefined && out.price !== undefined) {
      out.base_price = out.price;
    }

    // modifier_groups: convert from modifiers array if needed
    if (!out.modifier_groups && Array.isArray(out.modifiers)) {
      out.modifier_groups = out.modifiers.map(g => ({
        id: g.id,
        name: g.name,
        required: g.required || false,
        max_selections: g.max_select !== undefined ? g.max_select : (g.max_selections !== undefined ? g.max_selections : 1),
        options: (g.options || []).map(o => ({
          id: o.id,
          name: o.name,
          price: o.price_delta !== undefined ? o.price_delta : (o.price !== undefined ? o.price : 0),
        })),
      }));
    }

    return out;
  }

  // ─── TOKENIZATION & NORMALIZATION ───────────────────────────────────────────

  _tokenize(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(t => t.length > 1 && !STOP_WORDS.has(t));
  }

  normalizeQuery(query) {
    let q = query.toLowerCase().trim();

    // Full-phrase aliases first (must come before word-level to avoid partial clobbers)
    const phraseAliases = {
      'plain pizza': 'cheese pizza',
      'cheese pie': 'cheese pizza',   // Tony's: restores substring-match bonus for Cheese Pizza
      'plain slice': 'cheese slice',
      'regular slice': 'cheese slice',
      'chicken wing': 'chicken wings',
    };
    for (const [alias, canonical] of Object.entries(phraseAliases)) {
      q = q.replace(new RegExp(`\\b${alias}\\b`, 'gi'), canonical);
    }

    // Word-level aliases
    const words = q.split(/\s+/);
    q = words.map(w => WORD_ALIASES[w] || w).join(' ');

    return q;
  }

  // ─── PRIMARY SEARCH ─────────────────────────────────────────────────────────

  findItems(query, maxResults = 5) {
    const normalized = this.normalizeQuery(query);
    const queryTokens = this._tokenize(normalized);
    if (queryTokens.length === 0) return [];

    const scored = this.items
      .filter(item => item.available)
      .map(item => {
        const { score, unmatchedNameTokens } = this._score(item, normalized, queryTokens);
        return { item, score, unmatchedNameTokens };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Tiebreaker 1: fewer unmatched name tokens (more specific match wins)
        if (a.unmatchedNameTokens !== b.unmatchedNameTokens) return a.unmatchedNameTokens - b.unmatchedNameTokens;
        // Tiebreaker 2: shorter name (avoid "Pizza Wrap" beating "Cheese Pizza" on ties)
        return a.item.nameTokens.length - b.item.nameTokens.length;
      })
      .slice(0, maxResults);

    return scored;
  }

  _score(item, normalizedQuery, queryTokens) {
    const nameLower = item.name.toLowerCase();
    let score = 0;
    let nameMatchCount = 0;
    const matchedNameTokenSet = new Set();

    // 1. Exact full-name match — highest priority
    if (nameLower === normalizedQuery) {
      score += 100;
    }

    // 2. Item name contains the full query as a substring
    if (nameLower.includes(normalizedQuery)) {
      score += 40;
    }

    // 3. Token matching against item name tokens (uses TOKEN_EQUIVALENTS for semantic matches)
    for (const qt of queryTokens) {
      let matched = false;
      for (const nt of item.nameTokens) {
        if (tokensMatch(nt, qt)) {
          score += 15;
          matched = true;
          matchedNameTokenSet.add(nt);
          break;
        }
        // Partial match only when BOTH tokens are long enough to be meaningful.
        // nt.length > 3 prevents "san" in "sandwich" from matching San Pellegrino.
        // isNegatingModifier check: prevents "cheeseless" from matching "cheese" query.
        const isNegatingModifier = nt.startsWith(qt) && (nt.endsWith('less') || nt.endsWith('free'));
        if (!isNegatingModifier && qt.length > 4 && nt.length > 3 && (nt.includes(qt) || qt.includes(nt))) {
          score += 7;
          matched = true;
          matchedNameTokenSet.add(nt);
          break;
        }
      }
      if (matched) nameMatchCount++;
    }

    // 4. All query tokens found in item name
    if (nameMatchCount === queryTokens.length) {
      score += 20;
    }

    // 5. Proportion of query tokens matched
    if (queryTokens.length > 0) {
      score += Math.round((nameMatchCount / queryTokens.length) * 20);
    }

    // 6. Category name match (low weight) + coverage bonus
    const catTokens = this._tokenize(item.category);
    for (const qt of queryTokens) {
      if (catTokens.some(ct => tokensMatch(ct, qt))) score += 5;
    }
    // Bonus when query completely covers the category name via equivalence.
    // "cheese pizza" covers "Pizza Pie" category (pizza≡pie) — boosts items in the
    // right category and differentiates "Pizza Pie" items from "Pizza Wrap" items.
    if (catTokens.length > 0 && catTokens.every(ct => queryTokens.some(qt => tokensMatch(ct, qt)))) {
      score += 15;
    }

    // 7. Description token match (very low weight)
    if (score > 0 && item.descTokens) {
      for (const qt of queryTokens) {
        if (item.descTokens.includes(qt)) score += 3;
      }
      // Phrase bonus: full query appears verbatim in description (e.g. "cheese pizza" in
      // "Classic cheese pizza - pizza sauce and mozzarella" → differentiates Regular Pie
      // from other pizza pies that also mention cheese and pizza in their descriptions).
      if (normalizedQuery.length > 4 && (item.description || '').toLowerCase().includes(normalizedQuery)) {
        score += 15;
      }
    }

    // 8. UNMATCHED NAME TOKEN PENALTY: each name token with no matching query token costs 10 points.
    // Replaces the old length-difference penalty — this version catches equal-length wrong matches
    // (e.g. "Pizza Wrap" for "cheese pizza" query: "wrap" has no match → -10).
    const unmatchedNameTokens = item.nameTokens.filter(nt => !matchedNameTokenSet.has(nt)).length;
    score -= unmatchedNameTokens * 10;

    return { score: Math.max(0, score), unmatchedNameTokens };
  }

  // ─── SECONDARY SEARCH (modifier content) ────────────────────────────────────
  // Used when customer says words like "gluten free", "vegetables", "spicy" —
  // terms that live in modifier groups, not item names.

  secondarySearch(query) {
    const queryTokens = this._tokenize(this.normalizeQuery(query));
    if (queryTokens.length === 0) return [];

    return this.items.filter(item => {
      if (!item.available) return false;
      return this._matchesModifierContent(item, queryTokens);
    });
  }

  _matchesModifierContent(item, queryTokens) {
    for (const group of (item.modifier_groups || [])) {
      const groupTokens = this._tokenize(group.name);
      if (queryTokens.some(qt => groupTokens.some(gt => gt === qt || gt.includes(qt)))) {
        return true;
      }
      for (const opt of (group.options || [])) {
        const optTokens = this._tokenize(opt.name);
        if (queryTokens.some(qt => optTokens.some(ot => ot === qt || ot.includes(qt)))) {
          return true;
        }
      }
    }
    return false;
  }

  // ─── CONFIDENCE ─────────────────────────────────────────────────────────────

  // Returns true when the top two results are close enough that the AI should ask
  // the customer to clarify rather than picking silently.
  needsClarification(scored) {
    if (scored.length < 2) return false;
    return (scored[0].score - scored[1].score) < 15;
  }

  // ─── LOOKUPS ────────────────────────────────────────────────────────────────

  getItemById(id) {
    return this.items.find(item => item.id === id) || null;
  }

  getOptionById(item, optionId) {
    for (const group of (item.modifier_groups || [])) {
      const opt = group.options.find(o => o.id === optionId);
      if (opt) return { ...opt, groupId: group.id, groupName: group.name, required: group.required };
    }
    return null;
  }

  getRequiredGroups(item) {
    return (item.modifier_groups || []).filter(g => g.required);
  }

  // Returns all option IDs for an item, used to populate the valid set after a search.
  getAllOptionIds(item) {
    const ids = new Set();
    for (const group of (item.modifier_groups || [])) {
      for (const opt of group.options) {
        ids.add(opt.id);
      }
    }
    return ids;
  }
}

module.exports = MenuEngine;
