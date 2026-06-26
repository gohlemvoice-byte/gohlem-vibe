# GOHLEM.AI — MASTER CONTEXT DOCUMENT
# Claude Code reads this every session. Every decision in here was made deliberately.
# Never re-derive what is already written here. Never undo a design decision without reading why it exists.

---

## WHAT WE ARE BUILDING

Gohlem.ai — AI voice phone ordering system for restaurants. A customer calls, the AI takes their
complete order (items, modifiers, quantities, corrections, multi-item), confirms it accurately,
and outputs a structured order for the POS (Toast). Goal: replace human phone order-takers.

Founder: Shulem (non-technical, building via Claude Code).
Restaurant 1: Hot Bagels 2nd Street, Lakewood NJ.
Restaurant 2: Yummy's Pizza, Monsey NY.
Restaurant 3: That Sushi Spot (added Phase 2 — menu loaded, tested manually).
Restaurant 4: The Pizza Place, Lakewood NJ (added Phase 2 — menu loaded, tested manually).

Current version tag: Bravo. All four restaurants are loaded and selectable via the browser test dropdown.

---

## THE NON-NEGOTIABLE SUCCESS METRIC

**Accuracy on REAL spoken orders, measured end to end.**

Not unit tests on clean text. Not "the AI said the right thing." The structured cart output
must match what the customer actually ordered, measured against a benchmark of realistic messy
transcripts — false starts, corrections, "actually no," multiple items in one breath, category
words, mispronunciations, sound-alikes, vague descriptions.

The prior build passed 45/45 automated tests on clean text and achieved ~20% accuracy on real
speech. That gap must never happen again. The benchmark is the only number that matters.

---

## THE PRIOR BUILD — WHAT FAILED AND WHY

We had a working system (codenamed up to "India"). It was rebuilt iteratively and accumulated
patches. Do not repeat these mistakes:

**Failure 1 — Wrong item matching**
"Hot coffee" matched "Hot Coffee Box ($25)" instead of "Hot Coffee ($5.27)."
Root cause: The substring bonus (`name.includes(query)`) fired on both items. The `resolveCombo`
startsWith search returned the first-indexed match, which was Hot Coffee Box. Fix: extra-word
penalty + exact-match priority (see Matching Rules below).

**Failure 2 — AI invented modifier names**
The AI wrote modifier names in free text (`"modifiers": ["sesame bagel"]`). Code then
fuzzy-matched that text back to a menu option. If the AI wrote "wheat sesame" instead of
"Whole Wheat Sesame Bagel," matching silently failed or matched the wrong option.
Fix: AI never names modifiers. It selects modifier option IDs returned by search_menu.

**Failure 3 — Multi-item orders dropped items**
System prompt said "ONE INTENT PER RESPONSE." Customer says "sandwich and a coffee" — only
the sandwich was processed. Coffee required a second turn that never came in real speech.
Fix: Tool calling allows unlimited sequential tool calls per turn.

**Failure 4 — Category words returned nothing**
"What vegetables do you have?" — search ran against item names, found nothing, AI said
"we don't have vegetables." Modifier groups had 10 vegetable options.
Fix: Secondary search pass scans modifier group names and option names.

**Failure 5 — Patch-on-patch cycle**
Every fix was a new prompt instruction. Prompt instructions are suggestions the model can ignore.
The only reliable fix is structural: make wrong output physically impossible at the code layer.

**The rule this establishes**: If you are adding a prompt instruction to fix a bug that code
should enforce — stop. Build the enforcement in code instead.

---

## CORE ARCHITECTURE PRINCIPLE (NEVER VIOLATE)

**The AI interprets language. Code makes every decision about what exists.**

- AI understands what the customer said in natural language
- CODE searches the menu and returns candidates with IDs
- AI selects from those candidates by ID — it never generates item names or modifier names
- CODE validates all IDs, calculates all prices, updates the cart
- The AI cannot confirm, name, or price anything that code has not first verified from data

This is not a suggestion. It is the structural guarantee that makes the system reliable.

---

## THE TOOL CALLING ARCHITECTURE

This is the core change from the prior build. The AI does not output a JSON intent with
free-text item names. It calls tools. Tools return IDs. The AI passes IDs back. Code validates.

### The Five Tools

**search_menu(query: string)**
Returns: array of items, each with `id`, `name`, `price`, `category`, `description`,
and `modifierGroups` (each group has `id`, `name`, `required`, `max_selections`,
and `options` array with `id`, `name`, `price`).
Side effect: stores the returned item IDs and modifier option IDs as "valid for this turn."
A search clears the previous turn's valid set.

**add_to_cart(item_id, modifier_option_ids[], quantity, special_instructions)**
Validates BEFORE accepting:
1. `item_id` must be in the valid set from this turn's search_menu call
2. Every `modifier_option_id` must be a valid option on that specific item
3. Required modifier groups must have a selection
4. Item must not be on the 86 list (sold out today)
5. Item must not have unmet restrictions (advance notice, etc.)
6. Price anomaly guard: if item price > 3x average cart item price, block and force clarification
Returns: `cart_item_id` on success, or `error` with reason on failure.

**remove_from_cart(cart_item_id)**
Removes item by cart_item_id. Always succeeds if ID is valid.

**update_cart_item(cart_item_id, add_modifier_ids[], remove_modifier_ids[], quantity, special_instructions)**
Updates an existing cart item. Validates modifier IDs against the item's modifier groups.
Used for mid-order corrections ("make the first sandwich toasted").

**get_cart()**
Returns the full current cart: all active items with cartItemIds, names, modifiers, quantities,
line totals, and running total. AI calls this when it needs to read back the order.

### Why This Prevents Modifier Hallucination Structurally

The AI receives modifier option IDs from search_menu. It passes those same IDs to add_to_cart.
It cannot pass an ID that was not in the search results because the validator will reject it.
The AI never writes a modifier name. It cannot invent what it cannot name.

### Why This Handles Multi-Item Orders

The AI can make multiple tool calls in a single turn response:
search_menu("tuna sandwich") → add_to_cart(...) → search_menu("hot coffee") → add_to_cart(...)
All of this happens before the AI generates its spoken response. No extra turns needed.

---

## THE MENU MATCHING RULES (gohlem-menu-engine.js)

The fuzzy matcher has three mandatory fixes over the prior build:

**Fix 1 — Extra-word penalty (solves hot coffee vs hot coffee box)**
For every word in an item name that has no match in the query, subtract 20 points.
"hot coffee" query: "Hot Coffee" (0 extra words, 0 penalty) beats "Hot Coffee Box"
(1 extra word, -20 penalty) even when both get the substring bonus.

**Fix 2 — Exact-match priority in resolveCombo (solves first-indexed wins)**
When multiple items match via startsWith or substring, rank exact matches first, then
prefer the shortest name. Never return the first-indexed result arbitrarily.

**Fix 3 — Modifier content search (solves category words)**
When primary search returns zero results OR all results score below threshold, run a
secondary pass that searches modifier group names and modifier option names across all items.
"Vegetables" → finds all items with vegetable modifier groups → returns those items.
"Spicy" → finds items with spicy options → returns them.

**Fix 4 — Alias normalization (solves sound-alikes, P17)**
Before any search runs, normalize the query through the restaurant's specialTerminology map.
"barakas" → "bourekas", "lox" → searches "lox" AND "sliced lox", "schmear" → "cream cheese".
This runs in the tool layer, not in the AI prompt.

**Confidence threshold (solves silent wrong-item selection, P10)**
If the top two search results are within 15 points of each other in score, set
`clarification_needed: true` in the search response. The AI must ask the customer to choose
rather than picking one silently. "Did you mean the Tuna Sandwich or the Tuna Melt?"

---

## ALL PROTECTIVE GUARDS (The 10 Gaps Closed)

These were identified as missing from the prior build. Every one must be implemented before
the system is considered production-ready.

| Guard | Problem | Where it lives |
|---|---|---|
| POST_CONFIRMATION state | P08: post-confirm additions re-open order | stateManager.js |
| Confidence threshold | P10: close scores force clarification | search_menu tool |
| Alias normalization | P17: sound-alikes resolved before search | search_menu tool |
| Restriction check | P21: advance-notice items blocked | add_to_cart tool |
| Hours check | P22: call rejected if store is closed | conversationEngine.js (on open()) |
| Delivery zone validation | P23: delivery address captured + validated | stateManager.js |
| Human fallback counter | P30: 2 failures on same item → offer transfer | conversationEngine.js |
| Menu cache with TTL | P35: menu refreshed from Toast, not static | menuLoader.js |
| 86 list check | P40: sold-out items blocked at add_to_cart | add_to_cart tool |
| Price anomaly guard | cheesecake/coffee box problem | add_to_cart tool |

---

## THE STATE MACHINE (stateManager.js)

States and what is allowed in each:

**GREETING** — No orders accepted. Collect pickup or delivery. Check store hours first.
If closed: speak hours, end call. If open: greet, ask pickup or delivery.

**ORDERING** — Main state. All tools available. Handles corrections, removals, questions.

**AWAITING_CLARIFICATION** — search_menu returned low-confidence results. AI has asked
customer to choose. On next turn, re-run search with customer's clarification.

**AWAITING_MODIFIER** — A required modifier group was not answered. AI has asked for it.
On next turn, match customer answer to modifier options. Do not run a new item search.

**CONFIRMING** — Customer said "that's it" / "nothing else" / "I'm done."
AI reads back the full order from get_cart() and states the total. Waits for confirmation.

**POST_CONFIRMATION** — Customer confirmed. Order is final. BUT if customer says "oh wait,
add a coffee" — re-enter ORDERING state for that item, then return here.
If customer says "yes that's right" / "correct" — move to COMPLETE.

**COMPLETE** — Order locked. No further modifications. Submit to POS.

### The Cheesecake / Bulk Item Rule (P18 + price anomaly)
When search returns both a single-serving and a bulk version of the same thing
(slice vs whole, single coffee vs coffee box), ALWAYS ask before adding the expensive one.
Never silently add an item that is more than 3x the average price of other cart items.
Default assumption: customer wants the individual serving unless they say otherwise.
Exception triggers for bulk: "for the whole office," "for 15 people," "for the team,"
explicit quantity ≥ 6 of the same item (at that point suggest the bulk option).

---

## CART ACCURACY ON LONG ORDERS (P09)

The full cart is injected into every AI turn via get_cart() result in the system context.
Cart items are displayed with:
- Sequential position number ("Item 1", "Item 2") so customer can reference by position
- cartItemId (for code use)
- Name, modifiers, quantity, line total

The AI never holds cart state in memory. It always reads from get_cart(). On long orders,
this is the only source of truth. "Make the first sandwich toasted" → AI maps "first sandwich"
to cartItemId of item 1, calls update_cart_item with that ID.

---

## PRICING RULES (P26, P29)

- All prices come from menu data. The AI never states a price it calculated itself.
- search_menu returns item prices and modifier prices.
- The cart calculates line totals and running total from data.
- The AI states the total only at CONFIRMING state, reading it from get_cart().
- When customer asks "how much is the X?" — AI calls search_menu, reads the price from
  the result, states it, then asks "Would you like to add that?" Intent is NONE, not ADD_ITEM.
- If the AI ever states a price not sourced from a tool response, that is a bug.

---

## CULTURAL / DIETARY QUESTIONS (P24)

Answers live in restaurantConfig.faqKnowledgeBase. The AI reads from there only.
If the question is not in the FAQ: "I don't have that information, but I can connect you with
someone who can help." Never invent an answer to a religious or dietary question.

---

## HUMAN FALLBACK (P30)

A per-session failure counter tracks failed search_menu attempts and rejected add_to_cart calls
on the same item. Counter increments when the same item request fails twice in a row.
On third failure for the same item: AI says "I'm having trouble with that one — let me connect
you with someone who can help" and triggers transfer. The counter resets when a different item
succeeds. This is code-side enforcement, not an AI decision.

---

## VOICE LAYER (P01–P05, P34) — PHASE 3 ONLY

These problems exist at the infrastructure layer, not in the conversation brain. The brain is
completely independent of the voice layer and testable without it.

P01 turn detection — Deepgram endpointing configuration
P02 latency — Stream TTS, use fast model (Haiku if we upgrade)
P03 background noise — Deepgram Nova-3 model
P04 caller silence — Twilio gather timeout 10+ seconds
P05 barge-in — Requires Retell or OpenAI Realtime (native interruption support)
P34 race condition — Per-callSid request lock on the server

Do not attempt to address these before Phase 3. They cannot be fixed in the brain.

---

## THE PROBLEM REGISTRY — CURRENT STATUS

### CONFIRMED WORKING IN REAL SPEECH TESTING (Phase 2 manual tests)
The following were tested with real messy voice input across all four restaurants:
- "canny salad" → Kani Salad ✓
- "pokeball" → poke bowl (asked small/large) ✓
- "Bensi/Bency/bentzy" → Bentzy Roll ✓ (3-attempt correction recovery)
- "candies sticks tempura" → Kani Sticks ✓
- "salmon pepper roll" → Black Pepper Salmon Roll ✓
- "pinna of vodka" → Penne à la Vodka ✓
- "harif/charif" → modifier note ✓
- "coni salad / connie / spicy county roll" → Kani Salad / Spicy Kani Roll ✓
- Large poke bowl with 5 required groups, all filled in one customer turn ✓
- Two poke bowls with different modifiers including no-fish option ✓
- Mid-order correction ("no, that was cucumber") ✓
- Upgrading both items from small to large in one correction ✓
- Remove one of two identical items ✓
- Two different cheese pastries in one turn ✓
- "nachiris" → nigiri (partially — mapped to roll instead; see bugs below)
- "adamehame" → edamame ✓ (B15 fix verified)
- Temperature stated upfront ("cooked medium") → not re-asked ✓ (B10 fix verified)
- Special instructions show customer's actual words ("harif") not AI confirmation ✓ (B13 fix verified)
- Spicy tuna roll + edamame in one sentence → both added correctly ✓ (B07 fix verified)
- Mid-order correction (thin crust → hand tossed) ✓ (regression confirmed still working)
- California Roll with no rice modifier — AI sometimes substitutes Holiday Roll (see B17)

### SOLVED STRUCTURALLY BY ARCHITECTURE
P06 modifier context loss — tool calling + state machine prevents new searches during modifier collection
P09 cart accuracy — get_cart() is always the source of truth, injected every turn
P11 multi-item single turn — sequential tool calls per turn, no limit
P13 wrong item matching — extra-word penalty + exact-match priority
P14 AI inventing modifiers — ID-based tool calling makes hallucination structurally impossible
P19 split modifiers — each item gets its own add_to_cart call with its own modifier IDs
P20 quantity handling — same modifiers = quantity param, different modifiers = separate calls
P25 modifier validation — add_to_cart validates modifier IDs against item's actual groups
P26 price accuracy — all prices from data, never from AI
P29 pricing questions — search_menu returns price, AI reads and states it, NONE intent
P31 greeting — hardcoded in engine.open(), not AI-generated
P32 plug and play — zero restaurant-specific logic in engine; all config in restaurantConfig.js
P33 real speech vs clean text gap — benchmark uses only messy realistic transcripts

### REQUIRES SPECIFIC IMPLEMENTATION (built in Phase 1 and 2)
P07 mid-order corrections — cartItemId + sequential numbering → update_cart_item
P08 post-confirmation additions — POST_CONFIRMATION state
P10 clarification policy — confidence threshold in search_menu
P12 fuzzy matching on real speech — extra-word penalty + modifier content search
P15 real-world knowledge — AI reasons to form search query; must verify in results before stating
P16 combination intelligence — resolveCombo from prior build carries forward with fixes
P17 sound-alikes — alias normalization layer before every search
P18 portion/size intelligence — confidence threshold + price anomaly guard
P21 special restrictions — restriction flags in menu data, enforced in add_to_cart
P22 store hours — hours check runs before greeting in engine.open()
P23 delivery zones — address capture + zone validation in GREETING state
P24 cultural/dietary — FAQ in restaurantConfig, AI reads only from there
P27 POS GUID mapping — menu JSON stores IDs used directly at Toast submission
P30 human fallback — failure counter in conversation engine
P35 menu cache/refresh — menu loader with TTL, not static file (Phase 2+)
P40 stockout handling — 86 list store, checked in add_to_cart (Phase 2+)

### VOICE LAYER ONLY — PHASE 3
P01 turn detection
P02 latency
P03 background noise
P04 caller silence
P05 barge-in
P34 race condition

---

## FILE STRUCTURE

### KEEP FROM PRIOR BUILD (do not rewrite these)
- `src/orders/orderState.js` — OrderCart class is solid. Keep exactly as-is.
- `src/pos/toastConnector.js` — Toast API wiring. Keep, update when connecting Toast.
- `src/voice/voiceServer.js` — Twilio server. Leave alone until Phase 3. (Has browser test routes added — those are safe.)
- `src/voice/callHandler.js` — Twilio routing. Leave alone until Phase 3.
- `src/dashboard/voiceTest.html` — Browser test UI. Has restaurant dropdown. Touch only for UI changes.

### REWRITE (same filename, new implementation)
- `gohlem-menu-engine.js` — Rewritten with three scoring fixes + _canonicalizeItem() schema normalizer.
- `src/config/restaurantConfig.js` — Tony's Brick Oven Pizzeria (Phase 1 reference config).

### BUILT IN PHASE 2
- `src/conversation/conversationEngine.js` — Tool-calling engine. Built and working.
- `src/tools/toolHandler.js` — All five tool implementations.
- `src/tools/definitions.js` — OpenAI tool definitions.
- `menus/tonys_pizzeria.json` — 100-item Tony's menu (Phase 1, benchmark passes 14/14).
- `menus/hot_bagels.json` — 289-item Hot Bagels menu. Canonical schema (modifier_groups, base_price).
- `menus/that_sushi_spot.json` — 200-item Sushi Spot menu. Sushi schema (modifiers, price_delta). Auto-normalized.
- `menus/pizza_place_lakewood.json` — 218-item Pizza Place menu. Same sushi schema. Auto-normalized.
- `src/config/hotBagelsConfig.js` — Hot Bagels config with kosher FAQ, special terminology.
- `src/config/sushiSpotConfig.js` — Sushi Spot config with hours, Shabbos notes.
- `src/config/pizzaPlaceConfig.js` — Pizza Place config with hours, cream cheese roll Thursday rule.
- `tests/benchmark.js` — Accuracy test runner (menu engine: 25/25 passing as of version Bravo).
- `tests/benchmark-cases/phase1-standard.json` — Standard test cases.
- `tests/benchmark-cases/phase1-embedding-gap.json` — Embedding gap cases.

### TWO MENU JSON SCHEMAS — BOTH SUPPORTED
The menu engine auto-detects and normalizes on load via `_canonicalizeItem()`.
Schema A (Tony's, Hot Bagels): `modifier_groups`, `max_selections`, `base_price`, option `.price`
Schema B (Sushi Spot, Pizza Place): `modifiers`, `max_select`, `price`, option `.price_delta`
Never manually convert — let the engine handle it.

### DELETE
- `src/voice/dialogManager.js` — broken (calls Claude model via OpenAI SDK). Remove.
- `tests/fullTest.js`, `tests/autoTest.js`, `tests/toolTest.js` — replaced by benchmark.

---

## BUGS DISCOVERED IN REAL SPEECH TESTING — PHASE 2

These were found during manual voice tests across all four restaurants. Not in the original spec.
Every one must be addressed before going live. Status tracked here.

### B01 — AI denies items without searching (OPEN)
Rule 8 says "never deny without searching first." The AI ignores this for beverages —
says "we don't have Coke" without calling search_menu("coke"). Seen in every restaurant.
Fix: Prompt reinforcement + code-layer check. Do not call AI's response final if it
contains denial language and no search_menu was called that turn.
Risk to fix: Low (prompt only is safe; code guard needs care with false positives).

### B02 — AI suggests items it has not verified (FIXED — prompt)
AI said "try iced tea or lemonade" (from training data), then when asked for iced tea
said it wasn't on the menu. Never suggest an item by name without seeing it in a search result.
Fix applied: Added CRITICAL TOOL RULES rule 10 to conversationEngine.js system prompt.
"Never name a specific alternative without searching for it first."

### B03 — Human fallback fires on impatience, not just failures (OPEN)
Customer said "are you here?" during processing → AI immediately offered human transfer.
"Are you here?" is not a search failure — it is impatience during a slow turn.
Failure counter must only increment when search_menu returns found: false, not on any utterance.
Fix: Move counter increment into tool result handler, not the conversation loop.
Risk to fix: Medium (code change to failure tracking logic).

### B04 — Phantom item added to cart after human fallback triggered (OPEN — CRITICAL)
In one test: Small Vegetable Platter ($40) appeared in cart. Customer never ordered it.
This happened around the same time human fallback triggered. Suspected cause: tool calls
ran in the background after transfer was initiated.
Fix: Unknown until root cause is confirmed. Must investigate before touching fallback code.
Never change the fallback mechanism until this is understood.
Risk: This is a production blocker. A customer could be charged for items they didn't order.

### B05 — Modifying existing cart item adds duplicate instead of updating (OPEN)
Customer had 1 falafel in cart. Asked to add modifiers to it.
AI called add_to_cart → added a second falafel. Should have called update_cart_item.
Same happened with Macaroni & Cheese — ended up with 2 in cart.
Fix: Prompt rule + optionally a code guard. "If the customer is asking to modify an item
already in the cart, get cart_item_id and call update_cart_item — never add_to_cart again."
Risk to fix: Medium — must not block legitimate duplicate orders ("I'll take another falafel").

### B06 — Wrong item added when customer requests a modifier (OPEN)
Customer said "add broccoli" while customizing Mac & Cheese → AI searched "broccoli" →
found "Broccoli Calzone" → added it to the cart.
Note: Pizza Place menu HAS a "broccoli" modifier option on Mac & Cheese. The search
found the wrong thing (item name match beat modifier content match).
Fix: When a customer is mid-customization of an existing item, the AI must use
update_cart_item rather than treating the request as a new item search.
Risk to fix: Medium (same as B05 — context awareness during customization).

### B07 — Dropped items in multi-item turn (FIXED — prompt)
"Regular pie, baked ziti, and mushroom barley soup" → soup never added.
The AI processed the pie and ziti but dropped the third item.
Likely cause: baked ziti required a confirmation exchange which consumed the turn.
Fix applied: Updated MULTI-ITEM ORDERS rule in conversationEngine.js system prompt.
"Note ALL items, process each in sequence, do not drop items because one required clarification."

### B08 — Double add when price check triggers re-offer (OPEN)
Baked ziti already in cart. Customer asked "how much is the baked ziti?" →
AI searched → found it → asked "would you like to add that?" → customer said
"you already added it, I need only one" → AI added a second one anyway.
Fix: Before add_to_cart, check cart for existing item. If already present, confirm
duplication intent rather than silently adding again.
Risk to fix: Medium (requires cart check on every add).

### B09 — max_selections ceiling not enforced in code (OPEN)
Customer ordered "grilled tuna AND raw salmon" for poke bowl fish group (max_selections: 1).
Both were accepted. Cart showed two fish choices on an item that allows only one.
This sends an invalid order to the kitchen.
Fix: Code guard in toolHandler — if modifier selection count for a group exceeds
max_selections, return error and prompt AI to ask customer to pick one.
Risk to fix: Low-medium (additive validation, won't affect valid orders).

### B10 — AI re-asks for modifier customer already stated (FIXED — prompt)
"Lemon butter salmon, a medium" → AI found item → asked "What temperature? Rare, medium, or well done?"
Customer had to repeat "I said medium."
Fix applied: Strengthened REQUIRED modifiers rule in conversationEngine.js system prompt.
"If the customer said medium you do not ask what temperature. Map it and move on."
Verified working in testing: lemon butter salmon cooked medium added correctly without re-asking.

### B11 — Unnecessary confirmation on clear intent (OPEN)
"I would like to have a regular pie" → AI found it → "Would you like to add that to your order?"
Wastes a turn. Clear ordering language must trigger add_to_cart directly, not a confirmation.
Fix: Prompt rule. "If ordering signal is unambiguous, add immediately. Do not confirm."
Must be precise — "do you have X?" is NOT an ordering signal; "I'll have X" IS.
Risk to fix: Low (prompt only), but see concern above about browsing vs ordering edge case.

### B12 — "One moment please" filler creates phone silence (FIXED — prompt, partially)
On a phone call, TTS says "one moment please" then 4 seconds of silence.
Callers hang up thinking the call dropped.
Fix applied: Added rule to VOICE FORMAT section in conversationEngine.js system prompt.
"Do NOT say one moment please. Say Sure or Got it — one word only."
Status: Mostly working in testing. One session still triggered the filler. Monitor in further tests.

### B13 — Special instructions field contains AI's spoken confirmation (FIXED — prompt)
Tuna sandwich cart showed special_instructions = "I'll note that for the kitchen."
That is the AI's verbal response, not the actual kitchen note.
The kitchen should receive "harif, pickles" not "I'll note that for the kitchen."
Fix applied: Updated special_instructions rule in conversationEngine.js system prompt.
"Pass the customer's ACTUAL WORDS. The kitchen reads this field."
Verified working: tuna sandwich with harif now shows 📝 harif in cart, not the AI's spoken line.

### B14 — Zero-quantity items visible in cart (OPEN)
When size was upgraded (small → large), old small poke bowl showed as "×0 — $0.00" in cart.
This confuses customers and staff.
Fix: UI fix in voiceTest.html — filter out items with quantity === 0 before rendering.
Risk to fix: None (UI only, no engine logic).

### B15 — Nigiri ordered, roll added instead (FIXED — config)
Customer said "two black pepper tuna nachiris" (nigiri) → added as "Black Pepper Tuna Roll."
These are different items with different prices.
Fix applied: Added nigiri/najiri/nachiris/nachiri to sushiSpotConfig.js specialTerminology.
Also added pokeball → poke bowl, adamame → edamame.
Verified: "adamehame" → edamame found and added correctly in testing.

### B17 — AI substitutes lower-ranked item when top result has no matching modifier (OPEN)
"California roll with brown rice" → Holiday Roll added instead of California Roll.
Root cause: California Roll has NO rice modifier group. The AI searched, got California Roll
as top result (score 210), but because California Roll doesn't support a rice choice, the AI
autonomously switched to Holiday Roll (score 28) which does have a Rice Choice modifier.
This is NOT a search scoring bug — the engine returns the correct item. It is an AI
decision bug: the AI is substituting items based on modifier availability instead of
using the top-scored result.
Fix: Prompt rule. "Always use the top-scored search result. Never substitute a lower-ranked
item because the top result doesn't support a modifier the customer mentioned. If the item
has no such modifier option, add it as-is and inform the customer."
Risk to fix: Low (prompt only).
Note: California Roll in the sushi menu has no rice modifier — it comes as standard.
The sushiSpotConfig storeSpecificInstructions says "all rolls require a rice choice" which
is incorrect for California Roll. This instruction may be causing the AI to seek a roll
with a rice modifier. The instruction needs to be qualified.

### B16 — Poke bowl asks each modifier group separately — poor UX (OPEN)
5 required groups (base, fish, vegetables×4, toppings×3, sauce×2) = 5+ separate exchanges.
Customer said "That's complicated. Give me one at a time."
Fix: Collect all modifiers the customer mentioned upfront. Only ask about genuinely
missing groups. "I still need your vegetable choices — what would you like?" not
asking about groups that were already stated.
Risk to fix: Medium (requires prompt pattern change for multi-required-group items).

---

## THE BENCHMARK — HOW WE MEASURE ACCURACY

### The Only Rule
Every test case is a realistic messy transcript. No clean-text inputs. If a human would
not say it exactly that way in a real call, it does not belong in the benchmark.

### Format of Each Test Case
```json
{
  "id": "001",
  "description": "Basic single item, clean",
  "turns": ["pickup", "I want a pepperoni pizza"],
  "expected_cart": [
    { "item_name_contains": "Pepperoni Pizza", "quantity": 1, "modifiers": [] }
  ],
  "must_not_contain": [],
  "notes": "Baseline — this should always pass"
}
```

### Two Categories of Test Cases

**Phase 1 Standard** — Tests the design should pass without embeddings:
- Single item orders with modifiers
- Multi-item single turn
- Mid-order corrections
- Quantity handling
- Post-confirmation additions
- Sound-alike inputs (barakas, lox, schmear)
- Price queries without triggering add
- Category modifier questions ("what vegetables?")
- The cheesecake/coffee box disambiguation
- "Remove the first one" with positional reference

**Phase 1 Embedding Gap** — Tests that will likely fail without embeddings:
- "something cold to drink"
- "I want something vegetarian"
- "give me something spicy"
- "what's your lightest option"
- "do you have anything without meat"
- "give me the house special" (if no item named that exactly)
- "I'm in the mood for something cheesy"
- "what's popular here"
- "something that's good for sharing"
- "I want what my friend had last time" (impossible, but test that it fails gracefully)

The score on each category is reported separately. This tells us exactly what we're
shipping without and whether deferring embeddings is safe.

### Passing Threshold Before Moving Phases
- Phase 1 Standard: 18/20 minimum (90%) before starting Phase 2
- Phase 1 Embedding Gap: Document the failures. If ≤ 4/10 pass, decide on embedding.
- Phase 2 (full menu): 40/50 (80%) before starting Phase 3.

### How to Run
`node tests/benchmark.js` — outputs score, lists each failure with reason.
Running takes ~3 minutes for 30 cases. Run after every significant change.

---

## PHASE PLAN

### Phase 0 — THIS DOCUMENT (COMPLETE)
Write the master context document. Decide architecture. No code yet.

### Phase 1 — Prove the Architecture (COMPLETE)
Built and benchmarked on Tony's Brick Oven Pizzeria (100-item synthetic menu).
Benchmark result: 14/14 passing (100%). Architecture validated.
Engine: tool-calling, ID-based, no modifier hallucination.

### Phase 2 — Multi-Restaurant + Real Speech Testing (IN PROGRESS)
Four restaurants loaded: Tony's, Hot Bagels, That Sushi Spot, The Pizza Place.
Browser test widget with restaurant dropdown.
History trimming (12 messages, safe boundary).
Voice format rules in system prompt (no markdown, no unprompted lists, short sentences).
Manual speech testing completed: ~20 sessions across all four restaurants.
16 bugs documented (B01–B16 above). None are architecture failures — all are fixable.

**Remaining Phase 2 work:**
- Fix B01–B16 in priority order (B04 phantom item must be root-caused before touching)
- Convert every manual test failure into a benchmark case
- Run benchmark before and after every fix
- Add hours enforcement, store hours check before greeting
- Add zero-quantity item filter to cart UI (B14)
- Target: 40/50 on expanded benchmark before Phase 3

### Phase 3 — Voice Layer
Connect Twilio + Deepgram. Address P01-P05, P34 at infrastructure level.
The conversation engine does not change — only the input/output layer.

### Phase 4 — Toast Integration
Live menu pull from Toast API. Push confirmed orders to Toast POS. GUID mapping.

### Phase 5 — First Live Test
Hot Bagels goes live. Real calls. Human graders score accuracy on real calls.

---

## DEPLOYMENT

- GitHub: github.com/gohlemvoice-byte/gohlem-vibe (auto-deploys to Railway on push)
- Railway: web-production-ef867.up.railway.app
- Railway Start Command: node src/voice/voiceServer.js
- Browser test: web-production-ef867.up.railway.app/voice/test
- Health check: web-production-ef867.up.railway.app/health
- Git on Windows: "C:\Program Files\Git\bin\git.exe"

---

## LLM

OpenAI GPT-4o-mini. API key in .env as OPENAI_API_KEY.
Do not switch models without running the full benchmark before and after to confirm
the change does not reduce accuracy. Model changes require a benchmark comparison.

---

## STANDARD WORKFLOW FOR EVERY CODE CHANGE

1. Read the relevant file fully before editing
2. Make the change
3. Run `node tests/benchmark.js`
4. If score drops below threshold — revert and diagnose before proceeding
5. Push: `git add . && git commit -m "description" && git push`

Do NOT push if the benchmark score dropped. Fix first.

---

## HARD RULES — NEVER VIOLATE THESE

1. The AI never generates an item name. It selects item IDs returned by search_menu.
2. The AI never generates a modifier name. It selects modifier option IDs returned by search_menu.
3. add_to_cart always validates IDs against the current turn's search results. No exceptions.
4. All prices come from menu data. The AI never states a price it calculated itself.
5. The cart is always the source of truth. The AI reads cart state from get_cart(), never from memory.
6. If two search results are within 15 points, ask the customer to choose. Never silently pick.
7. Never add an item priced more than 3x the average cart price without explicit customer confirmation.
8. If you are fixing a bug with a prompt instruction — stop. Build the enforcement in code.
9. The benchmark must use messy realistic transcripts. No clean-text test cases.
10. Do not touch voice server files (voiceServer.js, callHandler.js) until Phase 3.
11. Run `node tests/benchmark.js` before AND after every code or prompt change. If score drops — revert immediately.
12. Do NOT modify the human fallback mechanism until B04 (phantom item) is root-caused. The cause is unknown.
13. Before adding any item to the cart, the AI must have called search_menu this turn. No exceptions.
14. Special_instructions must contain the customer's actual request — never the AI's verbal confirmation of it.
