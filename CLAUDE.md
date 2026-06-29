# GOHLEM.AI — MASTER CONTEXT DOCUMENT
# Claude Code reads this every session. Every decision here was made deliberately.
# Never re-derive what is already written here. Never undo a design decision without reading why it exists.

---

## WHAT WE ARE BUILDING

Gohlem.ai — AI ordering system for restaurants. Customers call (voice) or message (WhatsApp), the AI takes their complete order and outputs a structured order for the POS (Toast).

Founder: Shulem (non-technical, building via Claude Code).
Restaurants: Hot Bagels 2nd Street (Lakewood NJ), Yummy's Pizza (Monsey NY), That Sushi Spot, The Pizza Place (Lakewood NJ).
Current version: Bravo. All four restaurants loaded and selectable via browser test dropdown.
WhatsApp channel: separate project at gohlem-whatsapp (github.com/gohlemvoice-byte/gohlem-whatsapp). Same engine logic, rebuilt cleanly there. When fixing engine bugs here, apply the same fix there.

---

## THE NON-NEGOTIABLE SUCCESS METRIC

Accuracy on REAL spoken orders, measured end to end. Not unit tests on clean text.
The structured cart output must match what the customer actually ordered, against realistic messy transcripts — false starts, corrections, multi-item in one breath, mispronunciations, category words, vague descriptions.

A prior build passed 45/45 clean-text tests and achieved ~20% on real speech. That gap must never happen again. The benchmark is the only number that matters.

---

## CORE ARCHITECTURE PRINCIPLE (NEVER VIOLATE)

**The AI interprets language. Code makes every decision about what exists.**

- AI understands what the customer said in natural language
- CODE searches the menu and returns candidates with IDs
- AI selects from those candidates by ID — it never generates item names or modifier names
- CODE validates all IDs, calculates all prices, updates the cart
- The AI cannot confirm, name, or price anything that code has not first verified from data

If you are fixing a bug with a prompt instruction — stop. Build the enforcement in code instead.

---

## THE TOOL CALLING ARCHITECTURE

The AI calls tools. Tools return IDs. The AI passes IDs back. Code validates.

**search_menu(query)**
Returns items with `id`, `name`, `price`, `category`, `description`, and `modifier_groups` (each with `id`, `name`, `required`, `max_selections`, and `options` with `id`, `name`, `price`).
Stores returned IDs as valid for this turn. Accumulates across parallel searches (multi-item orders).

**add_to_cart(item_id, modifier_option_ids[], quantity, special_instructions)**
Validates before accepting: item_id in valid set → modifier IDs valid for that item → required groups all filled → max_selections not exceeded → not a catering item → no price anomaly.
Returns cart_item_id on success, or error with reason.

**remove_from_cart(cart_item_id)**
Removes by cart_item_id. Always succeeds if ID is valid.

**update_cart_item(cart_item_id, add_modifier_ids[], remove_modifier_ids[], quantity, special_instructions)**
Modifies an existing cart item. Used for all mid-order corrections.

**get_cart()**
Returns full cart: items with positions, cartItemIds, names, modifiers, quantities, line totals, running total. Call only when customer is done OR when you need a cart_item_id for update/remove.

---

## SYSTEM BEHAVIORAL REQUIREMENTS — THE MUST-PASS LIST

These are universal behaviors the system must handle regardless of restaurant, menu, or channel.
Every bug fix, refactor, or new feature must preserve ALL of these.

### 1. Semantic Category Understanding
The system must understand what things ARE, not just match exact names.
- "I want a drink" → search_menu("drinks") even if no item is literally named "drink"
- "something cold" → identify items served cold by name/category context
- "something spicy" → find items with "spicy" in name OR spicy modifier options
- "something light / small" → identify lighter/smaller portions from menu context
- "do you have vegetables?" → search modifier groups, not just item names — find items that HAVE vegetable modifier options
- "what are my options?" → return what the menu actually contains, never from general knowledge

### 2. Mispronunciation and Sound-Alike Resolution
- Alias normalization runs in code (specialTerminology map) before every search — never rely on the AI to resolve it
- Known examples: "nachiris/nachiri" → nigiri, "barakas" → bourekas, "adamehame/adamame" → edamame, "canny" → kani, "pokeball" → poke bowl, "pinna" → penne, "charif/harif" → spicy instruction
- If a customer's word is in the specialTerminology map: it ALWAYS resolves. Never say "not on the menu" for a known alias.
- New sound-alikes discovered in testing → add to the restaurant's specialTerminology config, not to the prompt.

### 3. Multi-Item in One Turn
- "A sandwich, a coffee, and a soup" → ALL THREE must be added before any spoken response
- Never drop an item because an earlier item required clarification
- Never stop mid-list to ask a question — finish all tool calls, then speak once
- If 3 items were mentioned and only 2 were added, search and add the 3rd before generating any text

### 4. Modifier Already Stated — Don't Re-Ask
- If the customer states a modifier while ordering ("cooked medium", "large", "thin crust", "brown rice") — map it to the option ID and add_to_cart immediately
- Never ask "what temperature?" when they said "medium." Never ask "what size?" when they said "large."
- Required modifier groups only need to be asked about when the customer has NOT provided them

### 5. Never Deny Without Searching
- "Do you have Coke?" → call search_menu("coke") BEFORE answering. Always.
- "We don't have X" is only valid after search_menu returned found: false
- Applies to every category: drinks, desserts, sides, sauces, condiments — anything
- This is the most-broken rule in testing. It must be enforced structurally, not just in the prompt.

### 6. Never Suggest Without Searching
- Never say "try the X" or "we also have Y" unless X or Y appeared in a search_menu result this session
- General restaurant knowledge (training data) must never substitute for actual menu data
- If customer asks for alternatives → call search_menu first, then suggest from what the results contain

### 7. Always Use the Top Search Result
- Use the highest-scored search result. Period.
- Never substitute a lower-ranked item because the top result lacks a modifier the customer mentioned
- If the top result has no rice choice, no sauce option, no size option → add it as-is and inform the customer: "The [item] doesn't come with a rice choice — I've added it as-is."
- Do not pick a different item that happens to have that modifier

### 8. Update vs Add (Mid-Customization)
- If the customer is modifying an item already in the cart → call update_cart_item, never add_to_cart again
- "Add broccoli to my mac and cheese" when mac and cheese is in the cart → update_cart_item with broccoli modifier
- "Make the falafel spicy" → update_cart_item on the falafel, not a new search for "spicy falafel"
- Only call add_to_cart again if the customer explicitly wants a SECOND item ("I'll take another falafel")

### 9. Positional References
- "Make the first one toasted" → maps to cart position 1, calls update_cart_item
- "Remove the second sandwich" → maps to second instance of that item in the cart
- "Make both of them large" → update both items in sequence before responding
- Cart positions are sequential (1, 2, 3...) and always read from get_cart(), never from memory

### 10. Price Queries Don't Add to Cart
- "How much is the X?" → search_menu, read the price from results, state it, ask "Would you like to add that?"
- Intent is NONE — never ADD_ITEM
- Never state a price that did not come from a tool response
- Never state the running total until the customer says they are done

### 11. Duplicate Detection — Narrow Rule
- Only flag a duplicate when the EXACT SAME item name is already in the cart
- Do NOT mention the existing cart when adding a different item
- When a true duplicate is detected: "You already have [X] in your order — did you want another, or modify the existing one?"
- Do not apply this to: similar items, same category, or anything that isn't an exact name match

### 12. Special Instructions = Customer's Actual Words
- The special_instructions field must contain exactly what the customer said: "harif", "extra crispy", "no onions", "well done"
- Never pass the AI's verbal response ("I'll note that for the kitchen") as the value
- The kitchen reads this field — it must say what the customer actually wants

### 13. Individual vs Bulk Default
- When individual and bulk versions of the same item both exist, always default to individual
- Never silently add an item priced more than 3× the average cart item price
- Bulk triggers: "for the office", "for 15 people", "for the team", explicit quantity ≥ 6 of the same item

### 14. Same Item, Different Modifiers = Separate Cart Items
- "Two sandwiches — one toasted, one not" → two separate add_to_cart calls, each with their own modifier IDs
- Never merge different modifier sets onto a single cart item with quantity > 1
- Same modifiers = one cart item with quantity 2. Different modifiers = two separate cart items.

### 15. Confirmation Flow
- When customer says they're done: call get_cart(), read back ALL items naturally, state the total
- Wait for explicit confirmation ("yes", "correct", "that's right") before completing
- After confirmation: if customer says "oh wait, add a coffee" → re-open ordering for that item, then return to confirmed state
- After confirmed + customer agrees it's correct → order is locked, no further modifications

### 16. Cultural and Dietary Questions
- Answer ONLY from restaurantConfig.faqKnowledgeBase
- If the question is not in the FAQ: "I don't have that information — let me connect you with someone who can help"
- Never invent or guess answers to kosher, allergen, or dietary questions

### 17. Human Fallback — Triggered by Failures, Not Impatience
- After 2 failed search_menu calls for the same item → offer to transfer to a human
- Failure = search_menu returns found: false. NOT customer impatience, confusion, or general questions.
- Counter resets when a different item succeeds
- Failure counter increments in the tool result handler, not the conversation loop

### 18. Max Selections Enforced in Code
- If a modifier group has max_selections: 1, only one option is accepted — enforced at add_to_cart, not just in the prompt
- When exceeded: EXCEEDS_MAX_SELECTIONS error returned, AI asks customer to pick one
- Example: poke bowl fish group (max 1) must block "grilled tuna AND raw salmon"

---

## THE MENU MATCHING RULES (gohlem-menu-engine.js)

**Extra-word penalty** — For every word in an item name that has no match in the query, subtract 10 points. Prevents "Hot Coffee Box" from beating "Hot Coffee" on a "hot coffee" query.

**Exact-match priority** — When multiple items match, rank exact name matches first, then shortest name. Never return the first-indexed result arbitrarily.

**Modifier content search** — When primary search returns zero results OR all scores below threshold, run a secondary pass scanning modifier group names and modifier option names. "Vegetables" → finds items with vegetable modifier groups. "Spicy" → finds items with spicy options.

**Alias normalization** — Before any search runs, normalize the query through the restaurant's specialTerminology map. Runs in the tool layer, not in the AI prompt.

**Confidence threshold** — If the top two search results are within 15 points of each other, set clarification_needed: true. The AI must ask the customer to choose. Never silently pick.

---

## PROTECTIVE GUARDS (all enforced in code)

| Guard | What it prevents | Location |
|---|---|---|
| Valid set check | AI inventing item IDs | add_to_cart |
| Modifier ID validation | AI inventing modifier IDs | add_to_cart |
| Required group check | Missing required selections | add_to_cart |
| Max selections ceiling | Over-selecting within a group | add_to_cart |
| Catering restriction | Advance-notice items added without notice | add_to_cart |
| Price anomaly guard | Silently adding bulk/party items | add_to_cart |
| Confidence threshold | Silently picking a wrong close match | search_menu |
| Human fallback counter | Customer stuck forever on same item | conversationEngine |
| POST_CONFIRMATION state | Post-confirm additions without acknowledgment | stateManager |
| 86 list check | Adding sold-out items | add_to_cart |

---

## THE STATE MACHINE

**GREETING** — Ask pickup or delivery. Check store hours first. If closed, speak hours and end.
**ORDERING** — All tools available. Handles all ordering, corrections, questions, removals.
**AWAITING_CLARIFICATION** — Low-confidence search. AI asked customer to choose. Next turn: re-run search with clarification, do not treat response as a new item.
**AWAITING_MODIFIER** — Required modifier group missing. AI asked for it. Next turn: match answer to modifier options. Do not run a new item search.
**CONFIRMING** — Customer said they're done. AI calls get_cart(), reads back full order, states total. Waits for yes/no.
**POST_CONFIRMATION** — Customer confirmed. If they add something → re-enter ORDERING for that item only, then return here. If they confirm it's correct → COMPLETE.
**COMPLETE** — Order locked. Submit to POS.

---

## OPEN BUGS — MUST FIX BEFORE GO-LIVE

### B01 — AI denies items without searching (OPEN — HIGH PRIORITY)
Seen in every restaurant. AI says "we don't have Coke" without calling search_menu.
Fix: Code-layer guard — if response contains denial language and no search_menu was called that turn, block it and force a search.

### B03 — Human fallback fires on impatience (OPEN)
"Are you here?" during a slow turn → AI offered human transfer. Impatience is not a search failure.
Fix: Failure counter must only increment inside the tool result handler when search_menu returns found: false.

### B04 — Phantom item added to cart after human fallback (OPEN — PRODUCTION BLOCKER)
Small Vegetable Platter ($40) appeared in cart, customer never ordered it. Happened when fallback triggered.
Fix: Unknown. Root cause must be identified before touching fallback code. Do NOT modify fallback until this is understood.

### B05 — Modifying existing item adds duplicate (OPEN)
Customer asked to modify falafel already in cart → AI called add_to_cart → second falafel added.
Fix: Prompt rule + code context check. If item name is in cart and customer is modifying (not re-ordering) → update_cart_item.

### B06 — Wrong item added when customer requests a modifier mid-customization (OPEN)
"Add broccoli" while customizing Mac & Cheese → AI searched "broccoli" → added Broccoli Calzone.
Fix: Same root cause as B05. Context awareness: if customer is mid-customization → update_cart_item, not new search.

### B08 — Double add on price query re-offer (OPEN)
Item in cart. Customer asked price. AI re-offered it. Customer said "you already added it." AI added a second one.
Guard 6 (ALREADY_IN_CART) was implemented then reverted — it broke poke bowl multi-modifier flow.
Fix: Needs a new approach that distinguishes "customer is checking price of an existing cart item" from "customer wants a new item."

### B11 — Unnecessary confirmation on clear ordering intent (OPEN)
"I would like to have a regular pie" → AI asked "Would you like to add that?" Wastes a turn.
Fix: Prompt rule. Clear signals (I want, I'll have, give me, can I get, add, I'll take) → add immediately.

### B14 — Zero-quantity items show in cart UI (OPEN — UI only)
After size upgrade, old item shows ×0 — $0.00. Confuses customers and staff.
Fix: Filter quantity === 0 items from voiceTest.html cart render. No engine change needed.

### B16 — Poke bowl asks each modifier group in separate turns (OPEN)
5 required groups = 5+ exchanges. Poor UX.
Fix: Collect all modifiers the customer mentioned upfront. Only ask about genuinely missing groups in one question.

### B17 — AI substitutes lower-ranked item when top result has no matching modifier (OPEN)
"California roll with brown rice" → Holiday Roll added instead. California Roll was the correct top result (score 210) but has no rice modifier. AI picked Holiday Roll (score 28) because it has a rice modifier.
Fix: Prompt rule already added. Also: qualify sushiSpotConfig storeSpecificInstructions — "all rolls require a rice choice" is incorrect for California Roll and is causing the substitution.

---

## FILE STRUCTURE

### Core engine files (do not rename)
- `gohlem-menu-engine.js` — fuzzy search, alias normalization, confidence threshold
- `src/conversation/conversationEngine.js` — tool calling loop, system prompt
- `src/tools/toolHandler.js` — all five tool implementations + all guards
- `src/tools/definitions.js` — OpenAI tool schemas
- `src/orders/orderState.js` — OrderCart class (solid, keep as-is)

### Restaurant configs (one per restaurant)
- `src/config/hotBagelsConfig.js` — specialTerminology, FAQ, storeSpecificInstructions
- `src/config/sushiSpotConfig.js`
- `src/config/pizzaPlaceConfig.js`
- `src/config/restaurantConfig.js` — Tony's (Phase 1 reference)

### Menus (JSON data, two schemas both supported)
- `menus/hot_bagels.json` — Schema A (modifier_groups, base_price)
- `menus/that_sushi_spot.json` — Schema B (modifiers, price_delta) — auto-normalized on load
- `menus/pizza_place_lakewood.json` — Schema B
- `menus/tonys_pizzeria.json` — Schema A

### Test + UI
- `tests/benchmark.js` — accuracy test runner
- `tests/benchmark-cases/phase1-standard.json` — standard cases
- `tests/benchmark-cases/phase1-embedding-gap.json` — semantic gap cases
- `src/dashboard/voiceTest.html` — browser test UI (restaurant dropdown)

### Do not touch until Phase 3
- `src/voice/voiceServer.js`
- `src/voice/callHandler.js`

---

## BENCHMARK

Run: `node tests/benchmark.js` — outputs score + failure list. Takes ~3 minutes.
Run before AND after every change. If score drops → revert, diagnose, fix before proceeding.

Every test case must use realistic messy transcripts. No clean-text inputs. If a human would not say it exactly that way in a real call, it does not belong in the benchmark.

Current score: 25/25 menu engine cases passing (version Bravo).
Phase 2 target before Phase 3: 40/50 on expanded benchmark.

---

## CURRENT PHASE AND WHAT'S NEXT

**Phase 2 — IN PROGRESS**
Remaining: Fix B01, B03, B05, B06, B08, B11, B14, B16, B17. Root-cause B04 before touching fallback.
Add hours enforcement. Convert all manual test failures to benchmark cases.

**Phase 3** — Voice layer: Twilio + Deepgram. Engine does not change, only input/output layer.
**Phase 4** — Toast integration: live menu pull, push confirmed orders to POS.
**Phase 5** — Hot Bagels goes live. Real calls. Human graders score accuracy.

---

## DEPLOYMENT

- GitHub (voice): github.com/gohlemvoice-byte/gohlem-vibe (auto-deploys to Railway on push)
- Railway (voice): web-production-ef867.up.railway.app
- Start command: node src/voice/voiceServer.js
- Browser test: web-production-ef867.up.railway.app/voice/test
- GitHub (WhatsApp): github.com/gohlemvoice-byte/gohlem-whatsapp (separate Railway project)

---

## LLM

OpenAI GPT-4o-mini. API key in .env as OPENAI_API_KEY.
Do not switch models without running the full benchmark before and after. Model changes require a benchmark comparison.

---

## STANDARD WORKFLOW FOR EVERY CODE CHANGE

1. Read the relevant file fully before editing
2. Make the change
3. Run `node tests/benchmark.js`
4. If score drops — revert and diagnose before proceeding
5. Push: `git add . && git commit -m "description" && git push`

---

## HARD RULES — NEVER VIOLATE

1. The AI never generates an item name. It selects item IDs returned by search_menu.
2. The AI never generates a modifier name. It selects modifier option IDs returned by search_menu.
3. add_to_cart always validates IDs against the current turn's valid set. No exceptions.
4. All prices come from menu data. The AI never states a price it calculated itself.
5. The cart is always the source of truth. The AI reads from get_cart(), never from memory.
6. If two search results are within 15 points, ask the customer to choose. Never silently pick.
7. Never add an item priced more than 3× the average cart price without explicit customer confirmation.
8. Fixing a bug with a prompt instruction = stop. Build the enforcement in code.
9. Benchmark must use messy realistic transcripts only. No clean-text test cases.
10. Do not touch voiceServer.js or callHandler.js until Phase 3.
11. Run benchmark before AND after every change. Score drops = revert immediately.
12. Do NOT touch the human fallback mechanism until B04 (phantom item) is root-caused.
13. Before adding any item, search_menu must have been called this turn. No exceptions.
14. special_instructions must contain the customer's actual words, never the AI's verbal response.
