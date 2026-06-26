'use strict';

// GOHLEM CONVERSATION BENCHMARK
// Two modes:
//   Static cases  — scripted customer turns, deterministic, fast
//   Simulator cases — a second LLM plays the customer dynamically, catches unknown regressions
// Run: node tests/conversation-benchmark.js
// Cost: ~$0.10–0.30 per full run (GPT-4o-mini). Time: ~4–7 minutes.
// REVERSIBLE: this file is additive only — delete it to remove, nothing else changes.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const OpenAI             = require('openai');
const ConversationEngine = require('../src/conversation/conversationEngine');
const restaurantConfig   = require('../src/config/restaurantConfig');
const hotBagelsConfig    = require('../src/config/hotBagelsConfig');
const sushiSpotConfig    = require('../src/config/sushiSpotConfig');
const pizzaPlaceConfig   = require('../src/config/pizzaPlaceConfig');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

// ─── SIMULATOR CASES ─────────────────────────────────────────────────────────
//
// These use a second LLM to play the customer dynamically.
// The simulator responds to whatever the agent actually says — it does not follow
// a script. This catches regressions that static cases miss because the AI's behavior
// changed in a way the hardcoded turns didn't exercise.
//
// scenario   — what the customer wants and how they behave (given to the simulator)
// expected_cart / must_not_contain — same assertions as static cases
// max_turns  — safety cap on conversation length

const SIMULATOR_CASES = [

  {
    id: 'S001', restaurant: 'sushi',
    description: 'Poke bowl — customer says you choose for optional modifiers',
    scenario: `You are calling to order ONE regular poke bowl for pickup.
You want brown rice and raw salmon.
For vegetables, toppings, and sauce you have no preference at all — say "I don't care", "you choose", or "whatever" for any of those questions.
Once the poke bowl is confirmed in your order, say "that's all, thank you."`,
    expected_cart: [{ item_name_contains: 'Poke Bowl', quantity: 1, modifier_contains: 'Salmon' }],
    must_not_contain: [],
    max_cart_quantity: 1,
    max_turns: 14,
  },

  {
    id: 'S002', restaurant: 'pizza',
    description: 'Customer asks for pizza slices — menu has pies, not slices',
    scenario: `You are calling to order 2 regular pizza slices for pickup.
You specifically want slices, not a whole pie.
If the restaurant tells you they only sell whole pies and not slices, be understanding and order a regular pie instead.
Once your order is confirmed, say "perfect, thank you."`,
    expected_cart: [{ item_name_contains: 'Regular', quantity: 1 }],
    must_not_contain: [],
    max_turns: 10,
  },

  {
    id: 'S003', restaurant: 'tonys',
    description: 'B07: three items in one breath — all three must land',
    scenario: `You are calling to order for pickup. In your very first order message, say all three items at once:
"I want garlic knots, mozzarella sticks, and a mushroom barley soup."
Answer any questions the agent asks. Once all three are confirmed, say "that's everything."`,
    expected_cart: [
      { item_name_contains: 'Garlic Knots',    quantity: 1 },
      { item_name_contains: 'Mozzarella',      quantity: 1 },
      { item_name_contains: 'Mushroom Barley', quantity: 1 },
    ],
    must_not_contain: [],
    min_cart_quantity: 3,
    max_turns: 8,
  },

  {
    id: 'S004', restaurant: 'hotbagels',
    description: 'B08: customer asks price then says no — cart stays empty',
    scenario: `You are calling a bagel shop. Ask how much a tuna sandwich costs.
When the agent tells you the price, say "oh that's too expensive, never mind" and end the call.
Do NOT order anything.`,
    expected_cart: [],
    must_not_contain: ['Tuna', 'Sandwich'],
    max_cart_quantity: 0,
    max_turns: 6,
  },

  {
    id: 'S005', restaurant: 'hotbagels',
    description: 'Special instructions captured during modifier Q&A (B13)',
    scenario: `You are calling to order a tuna sandwich for pickup.
You want it on a sesame bagel with extra pickles and you want it spicy — use the word "harif" which means spicy.
Answer any modifier questions the agent asks. Make sure to mention "harif" at least once.
Once the sandwich is added, say "that's all."`,
    expected_cart: [{ item_name_contains: 'Tuna', quantity: 1, special_instructions_contains: 'harif' }],
    must_not_contain: [],
    max_turns: 12,
  },

];

// ─── SIMULATOR RUNNER ────────────────────────────────────────────────────────

async function generateUserTurn(scenario, conversationHistory) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are simulating a customer calling a restaurant to place a phone order over the phone.

Your goal for this call:
${scenario}

Rules:
- Speak naturally, like a real phone customer. Short sentences — 1 to 2 sentences max.
- Never use markdown, lists, or formatting.
- Never break character or mention you are an AI or that this is a test.
- If the agent asks something you have no preference about, say "I don't care" or "whatever" or "you choose."
- When your order is complete and the agent has confirmed everything, respond with only the word: DONE`,
      },
      ...conversationHistory,
    ],
    temperature: 0.6,
    max_tokens: 80,
  });

  const content = (res.choices[0].message.content || '').trim();
  if (/^DONE$/i.test(content) || content.toUpperCase().startsWith('DONE')) return '__DONE__';
  return content;
}

async function runSimulatorCase(tc) {
  const engine = new ConversationEngine(CONFIGS[tc.restaurant]);
  const { message: greeting } = await engine.open();

  const history = [{ role: 'assistant', content: greeting }];
  let turns = 0;

  while (turns < (tc.max_turns || 14)) {
    turns++;

    const userText = await generateUserTurn(tc.scenario, history);
    if (userText === '__DONE__') break;

    history.push({ role: 'user', content: userText });

    const { message: agentResponse } = await engine.chat(userText);
    history.push({ role: 'assistant', content: agentResponse });

    // Stop if agent has confirmed and thanked (order complete)
    const lower = agentResponse.toLowerCase();
    if (
      (lower.includes('thank you') || lower.includes('see you') || lower.includes('your order is')) &&
      (lower.includes('total') || lower.includes('confirmed') || lower.includes('ready'))
    ) break;
  }

  // Reuse the same assertion logic as static cases
  const order = engine.cart.getOrder();
  const activeItems = order.items.filter(i => i.quantity > 0);
  const failures = [];

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

  for (const forbidden of (tc.must_not_contain || [])) {
    const found = activeItems.find(i => i.name.toLowerCase().includes(forbidden.toLowerCase()));
    if (found) failures.push(`Cart must NOT contain "${forbidden}" — found: ${found.name}`);
  }

  if (tc.max_cart_quantity !== undefined && activeItems.length > tc.max_cart_quantity) {
    failures.push(`Cart has ${activeItems.length} active item(s) — expected at most ${tc.max_cart_quantity}`);
  }
  if (tc.min_cart_quantity !== undefined && activeItems.length < tc.min_cart_quantity) {
    failures.push(`Cart has ${activeItems.length} active item(s) — expected at least ${tc.min_cart_quantity}`);
  }

  return {
    passed:      failures.length === 0,
    failures,
    turns,
    cartSummary: activeItems.map(i => `${i.name} ×${i.quantity}`).join(', ') || '(empty)',
  };
}

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
  console.log(`  ${TEST_CASES.length} static + ${SIMULATOR_CASES.length} simulator cases  |  Real OpenAI API  |  ~4–7 min\n`);

  let passed = 0;
  let failed = 0;

  // ── Static cases (scripted turns) ──────────────────────────────────────────
  console.log('  ── STATIC CASES (scripted) ──────────────────────────────────────────────\n');
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

  // ── Simulator cases (LLM plays customer) ───────────────────────────────────
  console.log('\n  ── SIMULATOR CASES (AI customer) ────────────────────────────────────────\n');
  let simPassed = 0;
  let simFailed = 0;

  for (const tc of SIMULATOR_CASES) {
    const label = `[${tc.id}] ${tc.description}`;
    process.stdout.write(`  ${label.slice(0, 68).padEnd(68)} `);
    try {
      const result = await runSimulatorCase(tc);
      if (result.passed) {
        console.log(`PASS  (${result.turns} turns)`);
        simPassed++;
      } else {
        console.log(`FAIL  (${result.turns} turns)`);
        for (const f of result.failures) console.log(`       ✗ ${f}`);
        console.log(`       Cart: ${result.cartSummary}`);
        simFailed++;
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      simFailed++;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const staticTotal = TEST_CASES.length;
  const simTotal    = SIMULATOR_CASES.length;
  const staticPct   = Math.round(passed / staticTotal * 100);
  const simPct      = simTotal > 0 ? Math.round(simPassed / simTotal * 100) : 0;

  console.log('\n  ─────────────────────────────────────────────────────────────────────────');
  console.log(`  Static:    ${passed}/${staticTotal} (${staticPct}%)`);
  console.log(`  Simulator: ${simPassed}/${simTotal} (${simPct}%)`);
  console.log(`  Overall:   ${passed + simPassed}/${staticTotal + simTotal} (${Math.round((passed + simPassed) / (staticTotal + simTotal) * 100)}%)\n`);

  process.exit((failed + simFailed) > 0 ? 1 : 0);
}

main();
