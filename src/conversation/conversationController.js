const STATES = {
  GREETING:          'GREETING',
  ORDERING:          'ORDERING',
  AWAITING_MODIFIER: 'AWAITING_MODIFIER',
  CONFIRMING:        'CONFIRMING',
  REVIEWING:         'REVIEWING',
  COMPLETE:          'COMPLETE',
};

// Keyword patterns keyed on fragment of group name (lowercase)
const GROUP_QUESTION_PATTERNS = [
  { key: 'bagel',     re: /what (type|kind) of bagel|which bagel|on (a |what |which )bagel|bagel (type|would|prefer)|which bagel/ },
  { key: 'toast',     re: /would you like (it |that )?(toasted|toast)|how.*toasted|like.*toast/ },
  { key: 'vegetable', re: /any (vegetable|veggies|toppings|add-?on)|want.*vegetable|vegetable.*like/ },
  { key: 'dressing',  re: /dressing|sauce/ },
  { key: 'cheese',    re: /what (type|kind) of cheese|which cheese|cheese option/ },
  { key: 'size',      re: /what size|which size|small.*medium.*large/ },
  { key: 'milk',      re: /what (type|kind) of milk|which milk|dairy|almond|oat/ },
  { key: 'spread',    re: /spread|schmear/ },
];

class ConversationController {
  constructor(menuEngine) {
    this.menuEngine = menuEngine;
    this.state      = STATES.GREETING;
    // currentItem: { menuItem, modifiers[], askedGroup }
    this.currentItem = null;
  }

  getState() { return this.state; }

  setState(newState, context = {}) {
    this.state = newState;
    if (context.currentItem !== undefined) this.currentItem = context.currentItem;
  }

  // Called by engine when we know which menu item is being built
  setCurrentItem(menuItem) {
    if (!menuItem) { this.currentItem = null; return; }
    if (this.currentItem && this.currentItem.menuItem.id === menuItem.id) return;
    this.currentItem = { menuItem, modifiers: [], askedGroup: null, pendingGroups: [] };
  }

  addModifier(option, groupName) {
    if (!this.currentItem) return;
    this.currentItem.modifiers = this.currentItem.modifiers.filter(m => m.groupName !== groupName);
    this.currentItem.modifiers.push({
      id: option.id, name: option.name, action: 'ADD', price: option.price || 0, groupName,
    });
  }

  // Advance to next pending group; returns the new askedGroup or null if done
  advanceToNextGroup() {
    if (!this.currentItem) return null;
    const next = (this.currentItem.pendingGroups || []).shift() || null;
    this.currentItem.askedGroup = next;
    return next;
  }

  // Returns routing decision for chat()
  // If AWAITING_MODIFIER: skips menu search and matches modifier directly.
  // Also handles cross-group matching (customer answers out of order) and
  // done-phrases when all required groups are satisfied.
  processInput(customerMessage) {
    if (this.state !== STATES.AWAITING_MODIFIER || !this.currentItem?.askedGroup) {
      return { bypassMenuSearch: false };
    }

    // 1. Try current asked group first
    const matched = this._matchOption(customerMessage, this.currentItem.askedGroup.options);
    if (matched) {
      return { bypassMenuSearch: true, modifierMatched: matched, askedGroup: this.currentItem.askedGroup };
    }

    // 2. Try pending groups — customer may answer a different group out of order
    for (const group of (this.currentItem.pendingGroups || [])) {
      const cross = this._matchOption(customerMessage, group.options);
      if (cross) {
        // Swap: put the currently asked group back in pending, activate this one
        const prev = this.currentItem.askedGroup;
        this.currentItem.pendingGroups = this.currentItem.pendingGroups
          .filter(g => g.name !== group.name);
        this.currentItem.pendingGroups.unshift(prev);
        this.currentItem.askedGroup = group;
        return { bypassMenuSearch: true, modifierMatched: cross, askedGroup: group };
      }
    }

    // 3. Done-phrase while all required groups are satisfied → customer finished
    const analysis  = this.menuEngine.analyzeModifiers(this.currentItem.menuItem);
    const satisfied = new Set(this.currentItem.modifiers.map(m => m.groupName));
    const requiredDone = analysis.mustAsk.every(g => satisfied.has(g.name));
    const isDone = /^(that('?s)?( it| all)?|nothing(?: else)?|no(?: (?:more|thanks?|thank you))?|done|finished|nope)\b/i
      .test(customerMessage.trim());

    if (isDone && requiredDone) {
      return { bypassMenuSearch: true, modifierMatched: null, customerDone: true, askedGroup: this.currentItem.askedGroup };
    }

    // 4. No match
    return { bypassMenuSearch: true, modifierMatched: null, askedGroup: this.currentItem.askedGroup };
  }

  // Read AI message after it's generated; topMatch is the best menu item candidate
  // from the current turn (null when menu search was bypassed — use currentItem.menuItem)
  detectStateFromAIResponse(aiMessage, topMatch) {
    const msg = aiMessage.toLowerCase();

    // Terminal state
    if (/(thank you for.*order|have a (great|wonderful|good) (day|one)|goodbye|bye now|order (has been|is) confirmed)/i.test(msg)) {
      this.state       = STATES.COMPLETE;
      this.currentItem = null;
      return;
    }

    // Full order review
    if (/(your (full|complete|total) order|let me (read|go over) (that|your order)|here('s| is) (your )?order|to summarize)/i.test(msg)) {
      this.state = STATES.REVIEWING;
      return;
    }

    // Item confirmation
    if (/(does that sound right|is that (right|correct)|sound(s)? good.*\?|shall i place|confirm (this|your) order|does that work)/i.test(msg)) {
      this.state = STATES.CONFIRMING;
      return;
    }

    // Modifier question — identify which group the AI is asking about
    const menuItem = topMatch || this.currentItem?.menuItem;
    if (menuItem) {
      const analysis  = this.menuEngine.analyzeModifiers(menuItem);
      const allGroups = [...analysis.mustAsk, ...analysis.shouldAsk];

      for (const group of allGroups) {
        if (this._aiAsksAboutGroup(msg, group)) {
          if (!this.currentItem || this.currentItem.menuItem.id !== menuItem.id) {
            // Fresh item — set up full ordered pending list
            const pending = allGroups.filter(g => g.name !== group.name);
            this.currentItem = {
              menuItem,
              modifiers:     this.currentItem?.modifiers || [],
              askedGroup:    group,
              pendingGroups: pending,
            };
          } else {
            // Same item — just update asked group
            this.currentItem.askedGroup    = group;
            this.currentItem.pendingGroups = (this.currentItem.pendingGroups || [])
              .filter(g => g.name !== group.name);
          }
          this.state = STATES.AWAITING_MODIFIER;
          return;
        }
      }
    }

    // Fallback generic modifier question — only when there's active item context
    if (menuItem && /\b(what|which|how would you like|would you like)\b.{1,60}\b(bagel|toast|vegetable|topping|size|milk|cheese|dressing|spread)\b.*\?/i.test(msg)) {
      this.state = STATES.AWAITING_MODIFIER;
      return;
    }

    // Default transitions when no specific pattern was detected
    if (this.state === STATES.AWAITING_MODIFIER) {
      this.state       = STATES.ORDERING;
      this.currentItem = null;
    } else if (this.state === STATES.GREETING) {
      this.state = STATES.ORDERING;
    }
  }

  // ─── PRIVATE ────────────────────────────────────────────────────────────────

  _aiAsksAboutGroup(msgLower, group) {
    const gLower = group.name.toLowerCase();
    if (msgLower.includes(gLower)) return true;

    for (const { key, re } of GROUP_QUESTION_PATTERNS) {
      if (gLower.includes(key) && re.test(msgLower)) return true;
    }
    return false;
  }

  _matchOption(text, options) {
    const tokens = this._tokenize(text);
    let best = null, bestScore = 0;

    for (const option of options) {
      const optTokens = this._tokenize(option.name);
      let score = 0;
      for (const t of tokens) {
        if (t.length <= 2) continue;
        for (const ot of optTokens) {
          if (ot === t)                          score += 10;
          else if (ot.includes(t) && t.length > 3) score += 5;
          else if (t.includes(ot) && ot.length > 3) score += 3;
        }
      }
      if (score >= 5 && score > bestScore) { bestScore = score; best = option; }
    }
    return best;
  }

  _tokenize(text) {
    return text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }
}

module.exports = { ConversationController, STATES };
