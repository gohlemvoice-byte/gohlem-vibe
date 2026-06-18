const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const ConversationEngine = require('../src/conversation/conversationEngine');

const MENU_PATH = path.join(__dirname, '../hot_bagels_menu_with_real_acai_restaurant.json');

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Returns true if ANY response contains ALL of the given keywords
function hasText(responses, ...keywords) {
  return responses.some(r =>
    keywords.every(kw => r.toLowerCase().includes(kw.toLowerCase()))
  );
}

function cartHasItem(cart, fragment) {
  return cart.getActiveItems().some(i => i.name.toLowerCase().includes(fragment.toLowerCase()));
}

function cartDoesNotHaveItem(cart, fragment) {
  return !cartHasItem(cart, fragment);
}

function cartItemHasInstruction(cart, nameFragment, instrFragment) {
  return cart.getActiveItems().some(i =>
    i.name.toLowerCase().includes(nameFragment.toLowerCase()) &&
    i.specialInstructions &&
    i.specialInstructions.toLowerCase().includes(instrFragment.toLowerCase())
  );
}

function cartItemHasModifier(cart, nameFragment, modFragment) {
  return cart.getActiveItems().some(i =>
    i.name.toLowerCase().includes(nameFragment.toLowerCase()) &&
    i.modifiers.some(m => m.name.toLowerCase().includes(modFragment.toLowerCase()))
  );
}

// ─── TEST CASES ───────────────────────────────────────────────────────────────

const TEST_CASES = [
  // ── Test 1 ──────────────────────────────────────────────────────────────────
  {
    id: '1',
    name: 'Lox on everything bagel — scoop the dough captured',
    turns: [
      'Pickup',
      'I want lox on an everything bagel, scoop the dough',
    ],
    check(responses, cart) {
      if (!cartHasItem(cart, 'lox')) {
        return { pass: false, reason: 'Lox not found in cart' };
      }
      const scoopCaptured =
        cartItemHasInstruction(cart, 'lox', 'scoop') ||
        cartItemHasModifier(cart, 'lox', 'scoop') ||
        hasText(responses, 'scoop');
      if (!scoopCaptured) {
        return { pass: false, reason: '"Scoop the dough" not captured as instruction or confirmed in response' };
      }
      return { pass: true, reason: 'Lox in cart with scoop instruction' };
    },
  },

  // ── Test 2a ─────────────────────────────────────────────────────────────────
  {
    id: '2a',
    name: 'Cream cheese sandwich + coffee milk no sugar — both items added',
    turns: [
      'Pickup',
      'I want a cream cheese sandwich on a plain bagel and a coffee milk with no sugar',
    ],
    check(responses, cart) {
      if (!cartHasItem(cart, 'cream cheese')) {
        return { pass: false, reason: 'Cream cheese sandwich not in cart' };
      }
      if (!cartHasItem(cart, 'coffee milk')) {
        return { pass: false, reason: 'Coffee milk not in cart' };
      }
      return { pass: true, reason: 'Both cream cheese sandwich and coffee milk in cart' };
    },
  },

  // ── Test 2b ─────────────────────────────────────────────────────────────────
  {
    id: '2b',
    name: 'Two sourdough challahs — AI asks which variation',
    turns: [
      'Pickup',
      'I want two sourdough challahs',
    ],
    check(responses, cart) {
      const askedClarification =
        hasText(responses, 'which') ||
        hasText(responses, 'large') ||
        hasText(responses, 'small') ||
        hasText(responses, 'whole') ||
        hasText(responses, 'half') ||
        hasText(responses, 'size');
      const challahAdded = cartHasItem(cart, 'challah');
      if (!askedClarification && !challahAdded) {
        return { pass: false, reason: 'AI neither asked a clarifying question nor added challah to cart' };
      }
      const reason = challahAdded
        ? `Challah added to cart (${cart.getActiveItems().filter(i => i.name.toLowerCase().includes('challah')).length} item(s))`
        : 'AI asked clarifying question about which sourdough challah variation';
      return { pass: true, reason };
    },
  },

  // ── Test 3 ──────────────────────────────────────────────────────────────────
  {
    id: '3',
    name: 'Egg sandwich ambiguity — AI asks scrambled or egg salad',
    turns: [
      'Pickup',
      'I want an egg sandwich',
    ],
    check(responses, cart) {
      const askedClarification =
        hasText(responses, 'scrambled') ||
        hasText(responses, 'egg salad') ||
        hasText(responses, 'which type') ||
        hasText(responses, 'which kind') ||
        hasText(responses, 'what kind');
      if (!askedClarification) {
        return { pass: false, reason: 'AI did not ask to clarify scrambled vs egg salad' };
      }
      return { pass: true, reason: 'AI correctly asked for clarification on egg sandwich type' };
    },
  },

  // ── Test 4 ──────────────────────────────────────────────────────────────────
  {
    id: '4',
    name: 'Split modifiers — two Mediterranean toasts as separate line items with different modifiers',
    turns: [
      'Pickup',
      'I want two Mediterranean toasts, one with no eggplant, one with extra feta',
    ],
    check(responses, cart) {
      const toasts = cart.getActiveItems().filter(i =>
        i.name.toLowerCase().includes('mediterranean')
      );
      if (toasts.length < 2) {
        return { pass: false, reason: `Expected 2 Mediterranean Toast line items, got ${toasts.length}` };
      }
      const sig = t => t.modifiers.map(m => `${m.action}:${m.name.toLowerCase()}`).sort().join('|');
      if (sig(toasts[0]) === sig(toasts[1])) {
        return { pass: false, reason: 'Both toasts have identical modifiers — split not applied correctly' };
      }
      return { pass: true, reason: `Two Mediterranean Toasts in cart with distinct modifier sets` };
    },
  },

  // ── Test 5 ──────────────────────────────────────────────────────────────────
  {
    id: '5',
    name: 'Conflicting/unavailable modifiers — red milk and blue milk',
    turns: [
      'Pickup',
      'I want a coffee with red milk and blue milk',
    ],
    check(responses, cart) {
      const handledCorrectly =
        hasText(responses, "don't have") ||
        hasText(responses, 'not available') ||
        hasText(responses, 'not sure') ||
        hasText(responses, 'red milk') ||
        hasText(responses, 'blue milk') ||
        hasText(responses, 'which milk') ||
        hasText(responses, 'what kind of milk') ||
        hasText(responses, 'type of milk');
      if (!handledCorrectly) {
        return { pass: false, reason: 'AI did not acknowledge that red/blue milk are unavailable or ask for clarification' };
      }
      return { pass: true, reason: 'AI correctly handled unavailable milk modifiers' };
    },
  },

  // ── Test 6 ──────────────────────────────────────────────────────────────────
  {
    id: '6',
    name: 'Breakfast for two — AI explains no package, offers individual items',
    turns: [
      'Pickup',
      'I want breakfast for two',
    ],
    check(responses, cart) {
      const handledCorrectly =
        hasText(responses, 'package') ||
        hasText(responses, 'combination') ||
        hasText(responses, 'individual') ||
        hasText(responses, 'separately') ||
        hasText(responses, 'what would') ||
        hasText(responses, 'which items') ||
        hasText(responses, 'build') ||
        hasText(responses, 'like to order');
      if (!handledCorrectly) {
        return { pass: false, reason: 'AI did not explain there is no breakfast-for-two package or ask for individual items' };
      }
      return { pass: true, reason: 'AI correctly handled breakfast-for-two by asking for individual items' };
    },
  },

  // ── Test 7 ──────────────────────────────────────────────────────────────────
  {
    id: '7',
    name: 'Gift box + personalized note captured',
    turns: [
      'Pickup',
      "I want a gift box and please add a note that says Happy Birthday from Shulem",
    ],
    check(responses, cart) {
      if (!cartHasItem(cart, 'gift')) {
        return { pass: false, reason: 'Gift box not found in cart' };
      }
      const noteCaptured =
        cartItemHasInstruction(cart, 'gift', 'happy birthday') ||
        cartItemHasInstruction(cart, 'gift', 'shulem') ||
        cartItemHasInstruction(cart, 'gift', 'note') ||
        hasText(responses, 'noted') ||
        hasText(responses, 'note');
      if (!noteCaptured) {
        return { pass: false, reason: 'Gift note not captured as special instruction' };
      }
      return { pass: true, reason: 'Gift box in cart with personalized note captured' };
    },
  },

  // ── Test 8 ──────────────────────────────────────────────────────────────────
  {
    id: '8',
    name: 'Giant Pizza Bagel restriction — mentions 24hr notice, NOT added to cart',
    turns: [
      'Pickup',
      'I want to order a Giant Pizza Bagel',
    ],
    check(responses, cart) {
      const mentioned24hrs =
        hasText(responses, '24') ||
        hasText(responses, 'advance notice') ||
        hasText(responses, 'advance') ||
        hasText(responses, 'prior notice');
      if (!mentioned24hrs) {
        return { pass: false, reason: 'AI did not mention the 24-hour advance notice requirement' };
      }
      const notInCart = cart.getActiveItems().length === 0;
      if (!notInCart) {
        return { pass: false, reason: `Giant Pizza Bagel was incorrectly added to cart (${cart.getActiveItems().length} item(s) found)` };
      }
      return { pass: true, reason: 'AI mentioned 24-hour notice and correctly kept item out of cart' };
    },
  },

  // ── Test 10 ─────────────────────────────────────────────────────────────────
  {
    id: '10',
    name: 'Special instruction — smear tuna on both sides',
    turns: [
      'Pickup',
      'I want a tuna sandwich on an everything bagel, smear the tuna on both sides of the bagel',
    ],
    check(responses, cart) {
      if (!cartHasItem(cart, 'tuna')) {
        return { pass: false, reason: 'Tuna sandwich not found in cart' };
      }
      const instructionCaptured =
        cartItemHasInstruction(cart, 'tuna', 'smear') ||
        cartItemHasInstruction(cart, 'tuna', 'both sides') ||
        cartItemHasModifier(cart, 'tuna', 'smear') ||
        hasText(responses, 'smear') ||
        hasText(responses, 'both sides') ||
        hasText(responses, 'noted');
      if (!instructionCaptured) {
        return { pass: false, reason: 'Smear instruction not captured in special instructions or confirmed in response' };
      }
      return { pass: true, reason: 'Tuna sandwich in cart with smear instruction captured' };
    },
  },

  // ── Test 11 ─────────────────────────────────────────────────────────────────
  {
    id: '11',
    name: 'Sound-alike — barakas recognized as bourekas',
    turns: [
      'Pickup',
      'I want a challah and some barakas',
    ],
    check(responses, cart) {
      if (!cartHasItem(cart, 'challah')) {
        return { pass: false, reason: 'Challah not found in cart' };
      }
      const bourekasHandled =
        cartHasItem(cart, 'boureka') ||
        cartHasItem(cart, 'boreka') ||
        hasText(responses, 'boureka') ||
        hasText(responses, 'boreka') ||
        hasText(responses, 'did you mean') ||
        hasText(responses, 'barakas');
      if (!bourekasHandled) {
        return { pass: false, reason: 'Barakas not recognized as bourekas — sound-alike not applied' };
      }
      const reason = cartHasItem(cart, 'boureka') || cartHasItem(cart, 'boreka')
        ? 'Challah in cart, barakas correctly resolved to bourekas and added'
        : 'Challah in cart, AI recognized barakas and asked about bourekas';
      return { pass: true, reason };
    },
  },

  // ── Test 12 ─────────────────────────────────────────────────────────────────
  {
    id: '12',
    name: 'Payment handling — graceful response (future feature)',
    turns: [
      'Pickup',
      'I want a tuna sandwich on everything bagel',
      'Can I pay with a credit card over the phone?',
    ],
    check(responses, cart) {
      const last = responses[responses.length - 1].toLowerCase();
      const handledGracefully =
        last.includes('connect') ||
        last.includes('transfer') ||
        last.includes("can't") ||
        last.includes('cannot') ||
        last.includes('not able') ||
        last.includes('payment') ||
        last.includes('store') ||
        last.includes('call') ||
        last.includes('phone');
      if (!handledGracefully) {
        return { pass: false, reason: 'AI did not handle payment question gracefully or offer an alternative' };
      }
      return { pass: true, reason: 'AI handled payment request gracefully' };
    },
  },

  // ── Test 13 ─────────────────────────────────────────────────────────────────
  {
    id: '13',
    name: 'Order object structure — SMS-ready after complete order',
    turns: [
      'Pickup',
      'I want a tuna sandwich on everything bagel',
      "That's it",
    ],
    check(responses, cart) {
      const order = cart.getOrder();
      if (!order.orderType) return { pass: false, reason: 'order.orderType is missing' };
      if (!Array.isArray(order.items) || order.items.length === 0) {
        return { pass: false, reason: 'order.items is empty or missing' };
      }
      const item = order.items[0];
      if (!item.cartItemId) return { pass: false, reason: 'item.cartItemId is missing' };
      if (!item.menuItemId) return { pass: false, reason: 'item.menuItemId is missing' };
      if (!item.name) return { pass: false, reason: 'item.name is missing' };
      if (item.unitPrice == null || item.unitPrice <= 0) {
        return { pass: false, reason: `item.unitPrice is invalid: ${item.unitPrice}` };
      }
      if (item.lineTotal == null || item.lineTotal <= 0) {
        return { pass: false, reason: `item.lineTotal is invalid: ${item.lineTotal}` };
      }
      if (!Array.isArray(item.modifiers)) {
        return { pass: false, reason: 'item.modifiers is not an array' };
      }
      if (!order.total || order.total <= 0) {
        return { pass: false, reason: `order.total is invalid: ${order.total}` };
      }
      return {
        pass: true,
        reason: `Order object complete — ${order.items.length} item(s), $${order.total.toFixed(2)}, type: ${order.orderType}`,
      };
    },
  },

  // ── Test 14 ─────────────────────────────────────────────────────────────────
  {
    id: '14',
    name: 'Post-order modification — add hash browns after initial item',
    turns: [
      'Pickup',
      'I want a tuna sandwich on everything bagel',
      'Actually, also add hash browns',
      "That's it",
    ],
    check(responses, cart) {
      if (!cartHasItem(cart, 'tuna')) {
        return { pass: false, reason: 'Tuna sandwich missing from final order' };
      }
      if (!cartHasItem(cart, 'hash')) {
        return { pass: false, reason: 'Hash browns not added after initial order was placed' };
      }
      if (cart.getActiveItems().length < 2) {
        return { pass: false, reason: `Expected at least 2 items in final order, got ${cart.getActiveItems().length}` };
      }
      return {
        pass: true,
        reason: `Both tuna sandwich and hash browns in final order (${cart.getActiveItems().length} items, $${cart.getTotal().toFixed(2)} total)`,
      };
    },
  },
];

// ─── TEST RUNNER ──────────────────────────────────────────────────────────────

async function runTest(tc) {
  const engine = new ConversationEngine(MENU_PATH);
  const allResponses = [];

  try {
    const greeting = await engine.open();
    allResponses.push(greeting.message || '');

    for (const turn of tc.turns) {
      const result = await engine.chat(turn);
      allResponses.push(result.message || '');
    }

    const verdict = tc.check(allResponses, engine.cart);
    return { ...verdict, responses: allResponses };
  } catch (err) {
    return { pass: false, reason: `Runtime error: ${err.message}`, responses: allResponses };
  }
}

async function runAll() {
  console.log('\n' + '='.repeat(68));
  console.log('GOHLEM.AI — Automated Test Suite');
  console.log(`Running ${TEST_CASES.length} test cases against Hot Bagels 2nd Street menu`);
  console.log('='.repeat(68));

  let passed = 0;
  const failures = [];

  for (const tc of TEST_CASES) {
    process.stdout.write(`\n[Test ${tc.id.padEnd(3)}] ${tc.name}\n`);

    const result = await runTest(tc);

    if (result.pass) {
      passed++;
      console.log(`         ✓ PASS — ${result.reason}`);
    } else {
      failures.push({ id: tc.id, name: tc.name, reason: result.reason, lastResponse: result.responses[result.responses.length - 1] });
      console.log(`         ✗ FAIL — ${result.reason}`);
      if (result.responses.length > 0) {
        const last = result.responses[result.responses.length - 1];
        if (last) console.log(`         Last AI response: "${last.substring(0, 140)}${last.length > 140 ? '...' : ''}"`);
      }
    }
  }

  console.log('\n' + '='.repeat(68));
  console.log(`FINAL SCORE: ${passed} / ${TEST_CASES.length} passed`);

  if (failures.length > 0) {
    console.log(`\nFailed tests:`);
    failures.forEach(f => console.log(`  [${f.id}] ${f.name}\n       → ${f.reason}`));
  } else {
    console.log('All tests passed.');
  }

  console.log('='.repeat(68));
}

runAll().catch(console.error);
