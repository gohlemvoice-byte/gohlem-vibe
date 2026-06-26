'use strict';

// GOHLEM CONVERSATION BENCHMARK
// Runs full end-to-end conversation tests against the real ConversationEngine + OpenAI API.
// Each test feeds realistic messy customer utterances into the engine and checks the cart.
// Run: node tests/conversation-benchmark.js
// Cost: ~$0.05–0.10 per full run (GPT-4o-mini). Time: ~3–5 minutes.
// REVERSIBLE: this file is additive only — delete it to remove, nothing else changes.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const ConversationEngine = require('../src/conversation/conversationEngine');
const restaurantConfig   = require('../src/config/restaurantConfig');
const hotBagelsConfig    = require('../src/config/hotBagelsConfig');
const sushiSpotConfig    = require('../src/config/sushiSpotConfig');
const pizzaPlaceConfig   = require('../src/config/pizzaPlaceConfig');

const CONFIGS = {
  tonys:     restaurantConfig,
  hotbagels: hotBagelsConfig,
  sushi:     sushiSpotConfig,
  pizza:     pizzaPlaceConfig,
};

// ─── TEST CASES ──────────────────────────────────────────────────────────────
//
// turns[]                    — customer utterances in order (engine greets first)
// expected_cart[]            — items that MUST appear in the final cart
//   .item_name_contains      — substring match on item name (case-insensitive)
//   .quantity                — exact quantity expected
//   .modifier_contains       — substring match on any modifier name
//   .special_instructions_contains — substring match on specialInstructions field
// must_not_contain[]         — item name substrings that must NOT be in cart
// max_cart_quantity          — active item count must not exceed this
// min_cart_quantity          — active item count must be at least this

const TEST_CASES = [

  // ── GROUP 1: REGRESSION — must never break ──────────────────────────────

  {
    id: 'C001', restaurant: 'tonys',
    description: 'Large pepperoni thin crust — baseline',
    turns: ['pickup', 'I want a large pepperoni pizza thin crust'],
    expected_cart: [{ item_name_contains: 'Pepperoni', quantity: 1 }],
    must_not_contain: [],
  },
  {
    id: 'C002', restaurant: 'tonys',
    description: 'Mid-order correction: thin crust → regular crust',
    turns: ['pickup', 'I want a large pepperoni pizza thin crust', 'actually change that to regular crust'],
    expected_cart: [{ item_name_contains: 'Pepperoni', quantity: 1, modifier_contains: 'Hand Tossed' }],
    must_not_contain: [],
  },
  {
    id: 'C003', restaurant: 'sushi',
    description: 'Multi-item + sound-alike: spicy tuna roll + adamehame (B15)',
    turns: ['pickup', 'I want a spicy tuna roll with brown rice and adamehame'],
    expected_cart: [
      { item_name_contains: 'Spicy Tuna', quantity: 1 },
      { item_name_contains: 'Edamame',    quantity: 1 },
    ],
    must_not_contain: [],
    min_cart_quantity: 2,
  },
  {
    id: 'C004', restaurant: 'pizza',
    description: 'Temperature stated upfront — must not re-ask (B10 regression)',
    turns: ['pickup', 'I want a lemon butter salmon cooked medium', 'spicy fries and israeli salad'],
    expected_cart: [{ item_name_contains: 'Salmon', quantity: 1, modifier_contains: 'Medium' }],
    must_not_contain: [],
  },
  {
    id: 'C005', restaurant: 'tonys',
    description: 'Special instructions = customer words, not AI confirmation (B13 regression)',
    turns: ['pickup', 'I want mozzarella sticks extra crispy please'],
    expected_cart: [{ item_name_contains: 'Mozzarella', quantity: 1, special_instructions_contains: 'crispy' }],
    must_not_contain: [],
  },

  // ── GROUP 2: CRITICAL SAFETY — must never add on inquiry ────────────────

  {
    id: 'C006', restaurant: 'hotbagels',
    description: 'SAFETY: price query must NOT add item to cart',
    turns: ['pickup', 'how much is the tuna sandwich'],
    expected_cart: [],
    must_not_contain: ['Tuna'],
    max_cart_quantity: 0,
  },
  {
    id: 'C007', restaurant: 'sushi',
    description: 'SAFETY: do-you-have inquiry must NOT add item to cart',
    turns: ['pickup', 'do you have a california roll'],
    expected_cart: [],
    must_not_contain: ['California', 'Holiday'],
    max_cart_quantity: 0,
  },
  {
    id: 'C008', restaurant: 'sushi',
    description: 'SAFETY B08: price query after ordering — stay at qty 1 only',
    turns: ['pickup', 'I want an edamame', 'how much is the edamame'],
    expected_cart: [{ item_name_contains: 'Edamame', quantity: 1 }],
    must_not_contain: [],
    max_cart_quantity: 1,
  },

  // ── GROUP 3: B17 — California Roll substitution ──────────────────────────

  {
    id: 'C009', restaurant: 'sushi',
    description: 'B17: california roll with brown rice → must be California Roll, NOT Holiday Roll',
    turns: ['pickup', 'I want a california roll with brown rice'],
    expected_cart: [{ item_name_contains: 'California Roll', quantity: 1 }],
    must_not_contain: ['Holiday Roll'],
  },
  {
    id: 'C010', restaurant: 'sushi',
    description: 'B17 companion: holiday roll with brown rice must still work',
    turns: ['pickup', 'I want a holiday roll with brown rice'],
    expected_cart: [{ item_name_contains: 'Holiday Roll', quantity: 1 }],
    must_not_contain: [],
  },

  // ── GROUP 4: B07 — multi-item must not drop ──────────────────────────────

  {
    id: 'C011', restaurant: 'tonys',
    description: 'B07: three items in one sentence — all three must land in cart',
    turns: ['pickup', 'I want garlic knots, mozzarella sticks, and a mushroom barley soup'],
    expected_cart: [
      { item_name_contains: 'Garlic Knots',    quantity: 1 },
      { item_name_contains: 'Mozzarella',      quantity: 1 },
      { item_name_contains: 'Mushroom Barley', quantity: 1 },
    ],
    must_not_contain: [],
    min_cart_quantity: 3,
  },

  // ── GROUP 5: B05 — modifying existing item must not duplicate ────────────

  {
    id: 'C012', restaurant: 'sushi',
    description: 'B05: change modifier on existing item — must not create duplicate',
    turns: ['pickup', 'I want a spicy tuna roll with brown rice', 'actually make that white rice instead'],
    expected_cart: [{ item_name_contains: 'Spicy Tuna', quantity: 1 }],
    must_not_contain: [],
    max_cart_quantity: 1,
  },

  // ── GROUP 6: B01 — search before denying drinks ──────────────────────────

  {
    id: 'C013', restaurant: 'sushi',
    description: 'B01: ask for drinks then order soda — AI must search, not deny from memory',
    turns: ['pickup', 'do you have any drinks', 'yes I want a soda can'],
    expected_cart: [{ item_name_contains: 'Soda', quantity: 1 }],
    must_not_contain: [],
  },

  // ── GROUP 7: B11 — clear ordering signal must add without confirmation ────

  {
    id: 'C014', restaurant: 'tonys',
    description: 'B11: clear ordering signal — must add without asking would-you-like-to-add',
    turns: ['pickup', 'I would like to have some garlic knots'],
    expected_cart: [{ item_name_contains: 'Garlic Knots', quantity: 1 }],
    must_not_contain: [],
  },
];

// ─── RUNNER ──────────────────────────────────────────────────────────────────

async function runCase(tc) {
  const engine = new ConversationEngine(CONFIGS[tc.restaurant]);
  await engine.open();

  for (const turn of tc.turns) {
    await engine.chat(turn);
  }

  const order       = engine.cart.getOrder();
  const activeItems = order.items.filter(i => i.quantity > 0);
  const failures    = [];

  // Expected items
  for (const exp of (tc.expected_cart || [])) {
    const found = activeItems.find(item => {
      const nameOk = item.name.toLowerCase().includes(exp.item_name_contains.toLowerCase());
      const qtyOk  = exp.quantity === undefined || item.quantity === exp.quantity;
      return nameOk && qtyOk;
    });
    if (!found) {
      failures.push(`Expected "${exp.item_name_contains}" ×${exp.quantity ?? '?'} — not in cart`);
      continue;
    }
    if (exp.modifier_contains) {
      const hasMod = (found.modifiers || []).some(m =>
        (m.name || '').toLowerCase().includes(exp.modifier_contains.toLowerCase())
      );
      if (!hasMod) {
        const modNames = (found.modifiers || []).map(m => m.name).join(', ');
        failures.push(`"${exp.item_name_contains}" missing modifier "${exp.modifier_contains}" — got: [${modNames}]`);
      }
    }
    if (exp.special_instructions_contains) {
      const note = (found.specialInstructions || '').toLowerCase();
      if (!note.includes(exp.special_instructions_contains.toLowerCase())) {
        failures.push(`"${exp.item_name_contains}" special_instructions should contain "${exp.special_instructions_contains}" — got: "${found.specialInstructions}"`);
      }
    }
  }

  // Forbidden items
  for (const forbidden of (tc.must_not_contain || [])) {
    const found = activeItems.find(i => i.name.toLowerCase().includes(forbidden.toLowerCase()));
    if (found) failures.push(`Cart must NOT contain "${forbidden}" — found: ${found.name}`);
  }

  // Cart size limits
  if (tc.max_cart_quantity !== undefined && activeItems.length > tc.max_cart_quantity) {
    failures.push(`Cart has ${activeItems.length} active item(s) — expected at most ${tc.max_cart_quantity}`);
  }
  if (tc.min_cart_quantity !== undefined && activeItems.length < tc.min_cart_quantity) {
    failures.push(`Cart has ${activeItems.length} active item(s) — expected at least ${tc.min_cart_quantity}`);
  }

  return {
    passed:      failures.length === 0,
    failures,
    cartSummary: activeItems.map(i => `${i.name} ×${i.quantity}`).join(', ') || '(empty)',
  };
}

async function main() {
  console.log('\n  GOHLEM CONVERSATION BENCHMARK');
  console.log(`  ${TEST_CASES.length} cases  |  Real OpenAI API  |  ~3–5 min\n`);

  let passed = 0;
  let failed = 0;

  for (const tc of TEST_CASES) {
    const label = `[${tc.id}] ${tc.description}`;
    process.stdout.write(`  ${label.slice(0, 68).padEnd(68)} `);
    try {
      const result = await runCase(tc);
      if (result.passed) {
        console.log('PASS');
        passed++;
      } else {
        console.log('FAIL');
        for (const f of result.failures) console.log(`       ✗ ${f}`);
        console.log(`       Cart: ${result.cartSummary}`);
        failed++;
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      failed++;
    }
  }

  const total = passed + failed;
  const pct   = total > 0 ? Math.round(passed / total * 100) : 0;
  console.log(`\n  Conversation score: ${passed}/${total} (${pct}%)\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
