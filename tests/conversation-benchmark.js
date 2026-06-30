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
    turns: ['pickup', 'I want a california roll with brown rice', 'yes'],
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
    id: 'C011', restaurant: 'pizza',
    description: 'B07: three items in one sentence — all three must land in cart',
    turns: ['pickup', 'I want french fries, baked ziti, and a mushroom barley soup'],
    expected_cart: [
      { item_name_contains: 'French Fries',    quantity: 1 },
      { item_name_contains: 'Baked Ziti',      quantity: 1 },
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
    id: 'S003', restaurant: 'pizza',
    description: 'B07: three items in one breath — all three must land',
    scenario: `You are calling The Pizza Place to order for pickup. In your very first order message, say all three items at once:
"I want french fries, baked ziti, and a mushroom barley soup."
Answer any questions the agent asks. Once all three are confirmed, say "that's everything."`,
    expected_cart: [
      { item_name_contains: 'French Fries',    quantity: 1 },
      { item_name_contains: 'Baked Ziti',      quantity: 1 },
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

  // ── GROUP 8: BN2 — partial special instructions with quantity ────────────

  {
    id: 'S006', restaurant: 'pizza',
    description: 'BN2: 3 pies + fries, cut only 2 pies into 16 slices — all must land',
    scenario: `You are calling The Pizza Place for pickup. Order three regular pies and one french fries.
Mention that you want two of the pies cut into 16 slices — the third pie is normal.
Answer any clarifying questions. Once all items are confirmed, say "that's all."`,
    expected_cart: [
      { item_name_contains: 'French Fries', quantity: 1 },
    ],
    must_not_contain: [],
    min_cart_quantity: 4,
    max_turns: 14,
  },

  // ── GROUP 9: B01 — search before denying drinks ──────────────────────────

  {
    id: 'S007', restaurant: 'sushi',
    description: 'B01: ask for Coke, get graceful answer, then order soda can',
    scenario: `You are calling That Sushi Spot for pickup.
First ask: "Do you have Coke?"
If they say no or don't have it, ask "what drinks do you have?"
Then order a soda can.
Once the soda is added, say "that's it."`,
    expected_cart: [{ item_name_contains: 'Soda', quantity: 1 }],
    must_not_contain: [],
    max_turns: 8,
  },

  // ── GROUP 10: B08 — price query must not re-add ──────────────────────────

  {
    id: 'S008', restaurant: 'hotbagels',
    description: 'B08: order hot coffee, then ask the price — must stay at exactly 1',
    scenario: `You are calling Hot Bagels for pickup.
Order a hot coffee.
After the agent confirms it, ask "by the way, how much is the hot coffee?"
Do NOT say you want to add another one. Just say "oh ok thanks" when they tell you the price.
Then say "that's all."`,
    expected_cart: [{ item_name_contains: 'Coffee', quantity: 1 }],
    must_not_contain: [],
    max_cart_quantity: 1,
    max_turns: 8,
  },

  // ── GROUP 11: B06 — wrong item added during customization ────────────────

  {
    id: 'S009', restaurant: 'pizza',
    description: 'B06: order Mac & Cheese, ask to add broccoli — must NOT get Broccoli Calzone',
    scenario: `You are calling The Pizza Place for pickup.
Order a macaroni and cheese.
After it is added, say "can you add some broccoli to that?"
If they say broccoli is not available on the mac and cheese, say "ok no problem, that's all."
If they add a Broccoli Calzone by mistake, say "no I wanted broccoli ON the mac and cheese, not a separate calzone."`,
    expected_cart: [{ item_name_contains: 'Macaroni', quantity: 1 }],
    must_not_contain: ['Broccoli Calzone', 'Calzone'],
    max_turns: 10,
  },

  // ── GROUP 12: B13+B05 — special instructions in retry, no duplicate ──────

  {
    id: 'S010', restaurant: 'hotbagels',
    description: 'B13+B05: tuna with harif + bagel type stated together — one item only',
    scenario: `You are calling Hot Bagels for pickup.
Order a tuna sandwich. In the same sentence, say you want it on an everything bagel and you want it harif (spicy).
If they ask for the bagel type again, say "I said everything bagel."
If they ask about spicy again, say "yes harif."
Once the sandwich is added, say "that's it, thanks."`,
    expected_cart: [{ item_name_contains: 'Tuna', quantity: 1, special_instructions_contains: 'harif' }],
    must_not_contain: [],
    max_cart_quantity: 1,
    max_turns: 10,
  },

  // ── GROUP 13: BN1 regression — no mid-conversation reset ─────────────────

  {
    id: 'S011', restaurant: 'pizza',
    description: 'BN1 regression: long multi-turn order — no mid-conversation reset',
    scenario: `You are calling The Pizza Place for pickup.
Order these four items ONE AT A TIME across separate turns — do not order them all at once:
1. First say you want french fries.
2. After that is confirmed, say you want a baked ziti.
3. After that is confirmed, say you want a mushroom barley soup.
4. After that is confirmed, say you want a vegetable soup.
If at any point the agent asks "is this for pickup or delivery?" as if starting over, say "I already said pickup" and continue.
Once all four are in, say "that's everything."`,
    expected_cart: [
      { item_name_contains: 'French Fries',    quantity: 1 },
      { item_name_contains: 'Baked Ziti',      quantity: 1 },
      { item_name_contains: 'Mushroom Barley', quantity: 1 },
      { item_name_contains: 'Vegetable Soup',  quantity: 1 },
    ],
    must_not_contain: [],
    min_cart_quantity: 4,
    max_turns: 16,
  },

  // ── GROUP 14: B16 — poke bowl upfront ────────────────────────────────────

  {
    id: 'S012', restaurant: 'sushi',
    description: 'B16: poke bowl — all preferences stated upfront, minimal back-and-forth',
    scenario: `You are calling That Sushi Spot for pickup.
In your first order message, say everything at once:
"I want a large poke bowl with brown rice, raw salmon, avocado and cucumber, crunch, and soy sauce."
Answer any follow-up questions briefly but do not repeat what you already said.
Once the poke bowl is added, say "that's all."`,
    expected_cart: [{ item_name_contains: 'Poke Bowl', quantity: 1, modifier_contains: 'Salmon' }],
    must_not_contain: [],
    max_turns: 12,
  },

  // ── GROUP 15: B10 regression — required modifiers stated upfront ──────────

  {
    id: 'S013', restaurant: 'tonys',
    description: 'B10 regression: wings with all 3 required groups stated upfront — no re-asking',
    scenario: `You are calling Tony's for pickup.
Order "6 boneless wings with hot buffalo sauce."
You have stated everything — count, style, and sauce.
If the agent asks for count, style, or sauce again despite you already stating them, give the same answer.
Once the wings are added, say "that's all."`,
    expected_cart: [{ item_name_contains: 'Wing', quantity: 1 }],
    must_not_contain: [],
    max_turns: 8,
  },

  // ── GROUP 16: Alias — lox ────────────────────────────────────────────────

  {
    id: 'S014', restaurant: 'hotbagels',
    description: 'Alias: customer asks for lox — AI must search, not deny',
    scenario: `You are calling Hot Bagels for pickup.
First ask "do you have lox?"
If they say yes or describe a lox item, order it on an everything bagel.
If they seem confused, say "you know, smoked salmon."
Once the item is added, say "perfect, that's all."`,
    expected_cart: [{ item_name_contains: 'Lox', quantity: 1 }],
    must_not_contain: [],
    max_turns: 10,
  },

  // ── GROUP 17: B15 regression — nigiri not rolls ──────────────────────────

  {
    id: 'S015', restaurant: 'sushi',
    description: 'B15 regression: nigiri order — must get nigiri not rolls',
    scenario: `You are calling That Sushi Spot for pickup.
Order two salmon nigiri and one tuna nigiri.
If the agent adds rolls instead of nigiri, correct them: "No, I said nigiri not a roll."
Once you have the nigiri, say "that's it."`,
    expected_cart: [
      { item_name_contains: 'Salmon Nigiri' },
      { item_name_contains: 'Tuna Nigiri',   quantity: 1 },
    ],
    must_not_contain: ['Roll'],
    max_turns: 10,
  },

  // ── GROUP 18: Price anomaly — individual vs catering ─────────────────────

  {
    id: 'S016', restaurant: 'pizza',
    description: 'Price anomaly: "baked ziti" must get $14 individual, not $55 catering pan',
    scenario: `You are calling The Pizza Place for pickup.
Order a baked ziti.
You want the regular individual portion, not a catering pan.
Once it is added, say "that's all."`,
    expected_cart: [{ item_name_contains: 'Baked Ziti', quantity: 1 }],
    must_not_contain: ['9x13'],
    max_turns: 6,
  },

  // ── GROUP 19: Positional removal ─────────────────────────────────────────

  {
    id: 'S017', restaurant: 'tonys',
    description: 'Positional removal: order garlic knots then remove them',
    scenario: `You are calling Tony's for pickup.
Order garlic knots.
After they are added, say "actually, never mind, remove the garlic knots."
Once removed, say "yeah that's all, nothing."`,
    expected_cart: [],
    must_not_contain: ['Garlic'],
    max_cart_quantity: 0,
    max_turns: 8,
  },

  // ── GROUP 20: Post-confirmation add ──────────────────────────────────────

  {
    id: 'S018', restaurant: 'tonys',
    description: 'Post-confirmation: confirm order then add one more item',
    scenario: `You are calling Tony's for pickup.
Order garlic knots. When asked if that is everything, say "yes that's it."
After the agent confirms and gives you the total, say "oh wait, can I also add mozzarella sticks?"
Once mozzarella sticks are added, say "yes that's everything now."`,
    expected_cart: [
      { item_name_contains: 'Garlic Knots',  quantity: 1 },
      { item_name_contains: 'Mozzarella',    quantity: 1 },
    ],
    must_not_contain: [],
    min_cart_quantity: 2,
    max_turns: 12,
  },

  // ── GROUP 21: Modifier content search ────────────────────────────────────

  {
    id: 'S019', restaurant: 'hotbagels',
    description: 'Modifier content search: "what vegetables?" then order with them',
    scenario: `You are calling Hot Bagels for pickup.
Ask "what vegetables can I get on a sandwich?"
After the agent tells you, order a tuna sandwich on a sesame bagel with tomatoes and pickles.
Answer any questions. Once added, say "that's everything."`,
    expected_cart: [{ item_name_contains: 'Tuna', quantity: 1 }],
    must_not_contain: [],
    max_turns: 12,
  },

  // ── GROUP 22: Two poke bowls different modifiers ──────────────────────────

  {
    id: 'S020', restaurant: 'sushi',
    description: 'Two poke bowls with different fish — must be two separate items',
    scenario: `You are calling That Sushi Spot for pickup.
Order a small poke bowl with brown rice and salmon.
For vegetables, toppings, and sauce — say "whatever you recommend" or "you choose."
After that is added, order a second small poke bowl with white rice and tuna.
For vegetables, toppings, and sauce on the second bowl — say "same as the first."
Once both are added, say "that's all."`,
    expected_cart: [
      { item_name_contains: 'Poke Bowl', quantity: 1 },
    ],
    must_not_contain: [],
    min_cart_quantity: 2,
    max_turns: 20,
  },

  // ── GROUP 23: Impatience — no fallback triggered ──────────────────────────

  {
    id: 'S021', restaurant: 'pizza',
    description: 'B03: "are you there?" mid-order must not trigger human transfer',
    scenario: `You are calling The Pizza Place for pickup.
Order french fries.
After a moment, say "hello? are you still there?" as if the call went quiet.
Do not ask for a human or transfer.
Once the french fries are confirmed, say "ok great, that's all."`,
    expected_cart: [{ item_name_contains: 'French Fries', quantity: 1 }],
    must_not_contain: [],
    max_turns: 8,
  },

  // ── GROUP 24: Three items clean — Tony's ──────────────────────────────────

  {
    id: 'S022', restaurant: 'tonys',
    description: 'Three items one breath: large thin crust pepperoni + garlic knots + mozz sticks',
    scenario: `You are calling Tony's for pickup.
In your first order message say all three at once:
"I want a large pepperoni pizza thin crust, garlic knots, and mozzarella sticks."
Answer any questions. Once all three are confirmed, say "that's everything."`,
    expected_cart: [
      { item_name_contains: 'Pepperoni', quantity: 1 },
      { item_name_contains: 'Garlic',    quantity: 1 },
      { item_name_contains: 'Mozzarella', quantity: 1 },
    ],
    must_not_contain: [],
    min_cart_quantity: 3,
    max_turns: 12,
  },

  // ── GROUP 25: Delivery address captured ──────────────────────────────────

  {
    id: 'S023', restaurant: 'hotbagels',
    description: 'Delivery: address captured before finalizing order',
    scenario: `You are calling Hot Bagels and you want delivery to 123 Oak Street, Lakewood NJ.
When asked pickup or delivery, say delivery.
Give your address when asked.
Then order a tuna sandwich on a plain bagel.
Answer modifier questions. Once added, say "that's everything."`,
    expected_cart: [{ item_name_contains: 'Tuna', quantity: 1 }],
    must_not_contain: [],
    max_turns: 14,
  },

  // ── GROUP 26: Out of stock item ───────────────────────────────────────────

  {
    id: 'S024', restaurant: 'pizza',
    description: 'Out of stock: Sicilian pie unavailable — customer accepts regular pie',
    scenario: `You are calling The Pizza Place for pickup.
Order a Sicilian pie.
If they say it is unavailable or out of stock, say "ok, then give me a regular pie instead."
Once the regular pie is added, say "that's all."`,
    expected_cart: [{ item_name_contains: 'Regular', quantity: 1 }],
    must_not_contain: ['Sicilian'],
    max_turns: 8,
  },

  // ── GROUP 27: Half-and-half pizza ────────────────────────────────────────

  {
    id: 'S025', restaurant: 'tonys',
    description: 'Half-and-half: large hand tossed half pepperoni half mushrooms',
    scenario: `You are calling Tony's for pickup.
Order a large hand tossed pizza with half pepperoni and half mushrooms.
Answer any clarifying questions about size or crust if needed.
Once added, say "that's all."`,
    expected_cart: [{ item_name_contains: 'Pizza', quantity: 1 }],
    must_not_contain: [],
    max_turns: 10,
  },

  // ── GROUP 28: Vegetarian request ─────────────────────────────────────────

  {
    id: 'S026', restaurant: 'hotbagels',
    description: 'Open-ended: "something vegetarian" — AI must search not invent',
    scenario: `You are calling Hot Bagels for pickup.
Say "I want something vegetarian, what do you have?"
After the agent suggests something or asks what you are in the mood for, say "an avocado sandwich sounds good."
Order it on an everything bagel.
Once added, say "that's it."`,
    expected_cart: [{ item_name_contains: 'Avocado', quantity: 1 }],
    must_not_contain: [],
    max_turns: 10,
  },

  // ── GROUP 29: B17 simulator version ──────────────────────────────────────

  {
    id: 'S027', restaurant: 'sushi',
    description: 'B17 simulator: California Roll with brown rice — must not become Holiday Roll',
    scenario: `You are calling That Sushi Spot for pickup.
Order a California roll with brown rice.
If the agent says the California Roll does not come with a rice choice, say "ok that is fine, add it as-is."
If the agent asks if you still want it, say "yes."
Once the California Roll is added, say "that's all."`,
    expected_cart: [{ item_name_contains: 'California Roll', quantity: 1 }],
    must_not_contain: ['Holiday Roll'],
    max_turns: 10,
  },

  // ── GROUP 30: French fries disambiguation ────────────────────────────────

  {
    id: 'S028', restaurant: 'pizza',
    description: 'Disambiguation: "french fries" must get $5.79 portion not $29.99 pie',
    scenario: `You are calling The Pizza Place for pickup.
Order french fries — a regular portion for one person.
If they ask you to confirm a large or party size, say "no, just a regular fries for me."
Once added, say "that's it."`,
    expected_cart: [{ item_name_contains: 'French Fries', quantity: 1 }],
    must_not_contain: ['Pie', '9x13'],
    max_cart_quantity: 1,
    max_turns: 8,
  },

  // ── GROUP 31: Knowledge boundary ─────────────────────────────────────────

  {
    id: 'S029', restaurant: 'hotbagels',
    description: 'Knowledge boundary: "what\'s your most popular bagel?" then order',
    scenario: `You are calling Hot Bagels for pickup.
Ask "what is your most popular bagel?"
After the agent responds (whether they know or not), order a tuna sandwich on a sesame bagel.
Once added, say "that's all."`,
    expected_cart: [{ item_name_contains: 'Tuna', quantity: 1 }],
    must_not_contain: [],
    max_turns: 10,
  },

  // ── GROUP 32: Ambiguous order type ───────────────────────────────────────

  {
    id: 'S030', restaurant: 'tonys',
    description: 'Ambiguous: customer says "yeah" to pickup/delivery — must clarify',
    scenario: `You are calling Tony's. When asked if this is for pickup or delivery, say only "yeah."
If the agent asks you to clarify, say "pickup."
Then order garlic knots.
Once added, say "that's it."`,
    expected_cart: [{ item_name_contains: 'Garlic', quantity: 1 }],
    must_not_contain: [],
    max_turns: 8,
  },

  // ── GROUP 33: B04 — phantom item during human fallback (empty cart) ────────
  // Reproduction test: trigger human fallback on an empty cart, assert nothing
  // was added. Cart must be completely empty when the fallback fires.

  {
    id: 'S031', restaurant: 'hotbagels',
    description: 'B04 empty-cart: human fallback fires — cart must stay completely empty',
    scenario: `You are calling Hot Bagels for pickup.
Tell the agent you are looking for "lobster bisque". Say exactly those words.
If the agent says they do not have it or offers alternatives, insist: "I really wanted lobster bisque, are you sure you don't have it?"
If they offer to connect you with a human or transfer you, say "yes please" and then output exactly: DONE
Do NOT order anything else under any circumstances. Do NOT say DONE until the agent offers to transfer or connect you with someone.`,
    expected_cart: [],
    must_not_contain: ['Vegetable', 'Platter', 'Salad', 'Sandwich', 'Bagel'],
    max_cart_quantity: 0,
    max_turns: 12,
  },

  // ── GROUP 34: B04 — phantom item during human fallback (item already in cart) ──
  // The production incident happened with items already in cart. This tests whether
  // a phantom item appears alongside the legitimate one after fallback fires.

  {
    id: 'S032', restaurant: 'hotbagels',
    description: 'B04 mid-order: human fallback fires after real add — only real item stays in cart',
    scenario: `You are calling Hot Bagels for pickup.
First, order a plain bagel with butter. Once it is added, say "thanks."
Then tell the agent you also want "lobster bisque". Say exactly those words.
If they say they do not have it or offer alternatives, say "I really need lobster bisque, are you sure?"
If they offer to connect you with a human, say "yes please" and then output exactly: DONE
Do NOT say DONE until the agent offers to transfer you.`,
    expected_cart: [{ item_name_contains: 'Bagel' }],
    must_not_contain: ['Vegetable Platter', 'Soup', 'Bisque'],
    max_cart_quantity: 2,
    max_turns: 14,
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
  // --only C001,C002,S001  →  run only those test IDs
  const onlyArg = process.argv.find(a => a.startsWith('--only='));
  const onlyIds = onlyArg ? new Set(onlyArg.replace('--only=', '').split(',').map(s => s.trim())) : null;

  const staticCases = onlyIds ? TEST_CASES.filter(tc => onlyIds.has(tc.id)) : TEST_CASES;
  const simCases    = onlyIds ? SIMULATOR_CASES.filter(tc => onlyIds.has(tc.id)) : SIMULATOR_CASES;

  console.log('\n  GOHLEM CONVERSATION BENCHMARK');
  if (onlyIds) console.log(`  Running: ${[...onlyIds].join(', ')}\n`);
  else console.log(`  ${TEST_CASES.length} static + ${SIMULATOR_CASES.length} simulator cases  |  Real OpenAI API  |  ~4–7 min\n`);

  let passed = 0;
  let failed = 0;

  // ── Static cases (scripted turns) ──────────────────────────────────────────
  if (staticCases.length) console.log('  ── STATIC CASES (scripted) ──────────────────────────────────────────────\n');
  for (const tc of staticCases) {
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
  if (simCases.length) console.log('\n  ── SIMULATOR CASES (AI customer) ────────────────────────────────────────\n');
  let simPassed = 0;
  let simFailed = 0;

  for (const tc of simCases) {
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
  const staticTotal = staticCases.length;
  const simTotal    = simCases.length;
  const staticPct   = Math.round(passed / staticTotal * 100);
  const simPct      = simTotal > 0 ? Math.round(simPassed / simTotal * 100) : 0;

  console.log('\n  ─────────────────────────────────────────────────────────────────────────');
  console.log(`  Static:    ${passed}/${staticTotal} (${staticPct}%)`);
  console.log(`  Simulator: ${simPassed}/${simTotal} (${simPct}%)`);
  console.log(`  Overall:   ${passed + simPassed}/${staticTotal + simTotal} (${Math.round((passed + simPassed) / (staticTotal + simTotal) * 100)}%)\n`);

  process.exit((failed + simFailed) > 0 ? 1 : 0);
}

main();
