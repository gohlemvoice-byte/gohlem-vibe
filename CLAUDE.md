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
- `src/voice/voiceServer.js` — Twilio server. Leave alone until Phase 3.
- `src/voice/callHandler.js` — Twilio routing. Leave alone until Phase 3.
- `src/dashboard/` — Leave alone.

### REWRITE (same filename, new implementation)
- `gohlem-menu-engine.js` — Keep structure, rewrite scoring with the three fixes.
- `src/config/restaurantConfig.js` — Keep pattern, add pizza shop config for Phase 1.

### REPLACE COMPLETELY (new file, old file archived or deleted)
- `src/conversation/conversationEngine.js` — New tool-calling architecture replaces this.
- `src/conversation/conversationController.js` — New stateManager.js replaces this.
- `src/orders/menuResolver.js` — Replaced by tool implementations in src/tools/.

### NEW FILES
- `src/tools/searchMenu.js` — search_menu tool implementation
- `src/tools/addToCart.js` — add_to_cart tool with all guards
- `src/tools/removeFromCart.js`
- `src/tools/updateCartItem.js`
- `src/tools/getCart.js`
- `src/conversation/stateManager.js` — new state machine
- `menus/pizza_shop_100.json` — Phase 1 test menu (100-item synthetic pizza shop)
- `tests/benchmark.js` — the accuracy test runner
- `tests/benchmark-cases/phase1-standard.json` — cases the design should pass
- `tests/benchmark-cases/phase1-embedding-gap.json` — cases that expose the embedding gap

### DELETE
- `src/voice/dialogManager.js` — broken (calls Claude model via OpenAI SDK). Remove.
- `tests/fullTest.js`, `tests/autoTest.js`, `tests/toolTest.js` — replaced by benchmark.

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

### Phase 0 — THIS DOCUMENT (complete)
Write the master context document. Decide architecture. No code yet.

### Phase 1 — Prove the Architecture (current phase)
**Goal**: Build the new conversation engine on a 100-item synthetic pizza shop menu.
Prove that structural tool-calling architecture eliminates the prior build's core failures.

Steps in order:
1. Build `menus/pizza_shop_100.json` — 100 items covering all hard cases
2. Rewrite `gohlem-menu-engine.js` with the three scoring fixes
3. Build `src/tools/` — all five tool implementations with all guards
4. Build `src/conversation/stateManager.js` — new state machine
5. Build `src/conversation/conversationEngine.js` — new tool-calling engine
6. Build `tests/benchmark.js` + write all test cases
7. Run benchmark. Fix failures. Re-run. Reach 18/20 on standard cases.

**What Phase 1 does NOT include**: Toast integration, real voice, delivery zones, 86 list,
menu refresh. Keep it simple. Prove the brain works first.

**Test method**: `node tests/benchmark.js` in terminal. No phone calls needed.

### Phase 2 — Full Hot Bagels Menu
Swap in the 289-item Hot Bagels menu. Add 20 more benchmark cases. Add delivery zone
validation, store hours enforcement, stockout (86 list), menu cache with TTL.
Target: 40/50 on expanded benchmark.

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
