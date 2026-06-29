# GOHLEM.AI — MASTER CONTEXT DOCUMENT
# Claude Code reads this every session. Every decision here was made deliberately.
# Never re-derive what is already written here. Never undo a design decision without reading why it exists.

---

## WHAT WE ARE BUILDING

Gohlem.ai — AI phone ordering system for restaurants. Customer calls, the AI takes their complete order and outputs a structured order for the POS (Toast).

Founder: Shulem (non-technical, building via Claude Code).
Restaurants: Hot Bagels 2nd Street (Lakewood NJ), Yummy's Pizza (Monsey NY), That Sushi Spot, The Pizza Place (Lakewood NJ).
Current version: Bravo. All four restaurants loaded and selectable via browser test dropdown.

---

## THE NON-NEGOTIABLE SUCCESS METRIC

Accuracy on REAL spoken orders, measured end to end. Not unit tests on clean text.
The structured cart output must match what the customer actually ordered, against realistic messy transcripts — false starts, corrections, multi-item in one breath, mispronunciations, category words, vague descriptions.

A prior build passed 45/45 clean-text tests and achieved ~20% on real speech. That gap must never happen again. The benchmark is the only number that matters.

Current benchmark: 42/44 (95%) — Static 13/14 | Simulator 29/30.
Run `node tests/conversation-benchmark.js` before AND after every change. Score drops → revert.

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
First result is marked `is_top_result: true`. Guard 7 enforces this at add_to_cart.

**add_to_cart(item_id, modifier_option_ids[], quantity, special_instructions)**
Validates before accepting: item_id in valid set → modifier IDs valid for that item → required groups all filled → max_selections not exceeded → not a catering item → no price anomaly → item is top search result (or clarification was needed).
Returns cart_item_id on success, or error with reason.

**remove_from_cart(cart_item_id)**
Removes by cart_item_id. Always succeeds if ID is valid.

**update_cart_item(cart_item_id, add_modifier_ids[], remove_modifier_ids[], quantity, special_instructions)**
Modifies an existing cart item. Used for all mid-order corrections and modifier additions to existing items.

**get_cart()**
Returns full cart: items with positions, cartItemIds, names, modifiers, quantities, line totals, running total. Call only when customer is done OR when you need a cart_item_id for update/remove.

---

## SYSTEM BEHAVIORAL REQUIREMENTS — THE MUST-PASS LIST

These are universal behaviors the system must produce regardless of restaurant, menu, or channel.
Every bug fix, refactor, or new feature must preserve ALL of these.
These are derived from real speech testing across all four restaurants. Do not remove any without understanding why it was added.

### 1. Semantic Category Understanding
The system must understand what things ARE, not just match exact words.
- "I want a drink" → search_menu("drinks") even if no item is literally named "drink"
- "something cold to drink" → search for cold beverages, identify from category + name context
- "something spicy" → find items with "spicy" in name OR items that have spicy modifier options
- "something light / small" → identify lighter/smaller portions from name and price context
- "do you have vegetables?" → secondary search scans modifier groups — find items that HAVE vegetable modifier options, not items named "vegetables"
- "what are my options for toppings?" → return what the menu actually contains from search results, never from general knowledge
- The secondary modifier content search in gohlem-menu-engine.js handles all of these. It runs automatically when the primary search returns nothing.

### 2. Mispronunciation and Sound-Alike Resolution
- Alias normalization runs in code (restaurantConfig.specialTerminology) before every search — the AI does not decide this
- Known working examples: nachiris/nachiri → nigiri, adamehame/adamame → edamame, canny → kani, pokeball → poke bowl, pinna → penne, barakas → bourekas, charif/harif → spicy instruction note
- If a customer's word is in the specialTerminology map: it ALWAYS resolves correctly. Never say "not on the menu" for a known alias.
- New sound-alikes found in testing → add to restaurantConfig.specialTerminology. Never fix in the prompt.

### 3. Multi-Item in One Turn
- "A sandwich, a coffee, and a soup" → ALL THREE must be added before any spoken response
- Never drop an item because an earlier item required clarification
- Never stop mid-list to ask a question — finish all tool calls for all items, then speak once
- If 3 items were mentioned and only 2 were added, search and add the 3rd BEFORE generating any text

### 4. Required Modifier Already Stated — Never Re-Ask
- If the customer states a modifier in their order ("cooked medium", "large", "thin crust", "brown rice", "boneless") → map it to the matching option ID and add_to_cart immediately
- Never ask "what temperature?" when they said "medium." Never ask "what size?" when they said "large."
- Required groups only need to be asked about when the customer has NOT already provided them

### 5. Special Instructions — Customer's Actual Words
- The special_instructions field must contain exactly what the customer said: "harif", "extra crispy", "no onions", "well done", "cut in half"
- Never pass the AI's verbal response ("I'll note that for the kitchen") as the value
- Special instructions mentioned at ANY point during modifier collection must be captured — including when said before the AI asks the modifier question. The B13 code injection in conversationEngine adds a reminder to the MISSING_REQUIRED tool result when keywords are detected in history.
- The kitchen reads this field — it must say what the customer actually wants

### 6. Never Deny Without Searching
- "Do you have Coke?" → call search_menu("coke") BEFORE answering. Always.
- "We don't have X" is only valid after search_menu returned found: false
- Applies to every category: drinks, desserts, sides, sauces, condiments, anything
- Code-enforced: conversationEngine intercepts denial language in the response. If denial language is present and search_menu was NOT called that turn, the response is blocked and the AI is forced to search first.

### 7. Never Suggest Without Searching
- Never say "try the iced tea" or "we also have lemonade" unless those items appeared in a search_menu result this session
- Training data knowledge must never substitute for actual menu data
- If customer asks for alternatives → call search_menu first, then suggest from what the results actually contain

### 8. Always Use the Top Search Result (Guard 7 in toolHandler)
- The first result from search_menu is marked is_top_result: true
- Always use it. Never substitute a lower-ranked item because the top result lacks a modifier the customer mentioned
- If the top result has no rice choice, no sauce option, no size option → add it as-is and inform: "The [item] doesn't come with a rice choice — I've added it as-is."
- Code-enforced: Guard 7 in toolHandler blocks add_to_cart when the item being added is not the top result of its search and clarification was not needed. Prevents California Roll → Holiday Roll substitution.

### 9. Searching Per-Turn, Not Per-Conversation
- Each search_menu call registers its own top result independently
- Multi-item orders (3 separate search calls in one turn) each get their own top-result record — Guard 7 applies per-search, not globally
- After a search's item is added, that item is removed from the valid set, but other searches' items remain valid

### 10. Update vs Add (Mid-Customization)
- If the customer is modifying an item already in the cart → call update_cart_item, never add_to_cart
- "Add broccoli to my mac and cheese" when mac and cheese is in the cart → update_cart_item with broccoli modifier ID
- "Make the falafel spicy" → update_cart_item on the falafel, not a new item search
- Only call add_to_cart again if the customer explicitly wants a SECOND item ("I'll take another falafel")

### 11. Positional References
- "Make the first one toasted" → maps to cart position 1, calls update_cart_item
- "Remove the second sandwich" → maps to second instance of that item in the cart
- "Make both of them large" → update both items in sequence before responding
- Cart positions always come from get_cart(), never from memory

### 12. Price Queries — Intent is NONE, Not ADD
- "How much is the X?" → search_menu, read the price from results, state it, ask "Would you like to add that?"
- Never add the item from a price query — always wait for an explicit "yes" or "I'll take it"
- Never state a price that did not come from a tool response

### 13. Individual vs Bulk Default
- When individual and bulk versions of the same item both exist, always default to individual
- Code-enforced: Guard 5 (price anomaly) blocks silent addition of items priced more than 4× the average cart item price and above $28 floor
- Bulk triggers: "for the office", "for 15 people", "for the team", explicit quantity ≥ 6 of the same item

### 14. Same Item, Different Modifiers = Separate Cart Items
- "Two sandwiches — one toasted, one not" → two separate add_to_cart calls, each with their own modifier IDs
- Same modifiers = one cart item with quantity 2. Different modifiers = two separate cart items.

### 15. Confirmation Flow
- When customer says they're done: call get_cart(), read back ALL items naturally, state the total
- Wait for explicit confirmation before completing
- After confirmation: customer adds something → re-open ordering for that item only, then return to confirmed state
- After confirmed + customer agrees → order is locked, no further modifications

### 16. Cultural and Dietary Questions
- Answer ONLY from restaurantConfig.faqKnowledgeBase
- If the question is not in the FAQ: "I don't have that information — let me connect you with someone who can help"
- Never invent or guess answers to kosher, allergen, or dietary questions

### 17. Human Fallback — Triggered by Failures, Not Impatience
- After 2 failed search_menu calls for the same item → offer to transfer to a human
- Failure = search_menu returns found: false. NOT customer impatience, confusion, or general questions.
- Counter resets when a different item succeeds
- Failure counter increments inside the tool result handler, not the conversation loop

### 18. Max Selections Enforced in Code
- If a modifier group has max_selections: 1, only one option is accepted
- Guard 3b in toolHandler enforces this at add_to_cart. AI asks customer to pick one when exceeded.
- Example: poke bowl fish group (max 1) must block "grilled tuna AND raw salmon"

---

## THE MENU MATCHING RULES (gohlem-menu-engine.js)

**Extra-word penalty** — For every word in an item name that has no match in the query, subtract 10 points. Prevents "Hot Coffee Box" from beating "Hot Coffee" on a "hot coffee" query.

**Exact-match priority** — When multiple items match, rank exact name matches first, then shortest name. Never return the first-indexed result arbitrarily.

**Modifier content search** — When primary search returns zero results OR all scores below threshold, run a secondary pass scanning modifier group names and modifier option names. "Vegetables" → finds items that have vegetable modifier groups. "Spicy" → finds items with spicy options. This is how category and semantic queries work.

**Alias normalization** — Before any search runs, normalize the query through the restaurant's specialTerminology map. Runs in the tool layer, not the AI prompt.

**Confidence threshold** — If the top two search results are within 15 points of each other, set clarification_needed: true. The AI must ask the customer to choose. Never silently pick. When clarification_needed is true, Guard 7 does not fire (customer may legitimately want the second result).

---

## PROTECTIVE GUARDS (all enforced in code — toolHandler.js)

| Guard | What it prevents | Trigger |
|---|---|---|
| Guard 1 — Valid item ID | AI inventing item IDs | add_to_cart |
| Guard 2 — Valid modifier ID | AI inventing modifier IDs | add_to_cart |
| Guard 3 — Required groups | Missing required selections | add_to_cart |
| Guard 3b — Max selections | Over-selecting within a group | add_to_cart |
| Guard 4 — Catering restriction | Adding advance-notice items without notice | add_to_cart |
| Guard 5 — Price anomaly | Silently adding bulk/party items | add_to_cart |
| Guard 7 — Top result enforcement | Silent item substitution (B17 California Roll pattern) | add_to_cart |
| Confidence threshold | Silently picking a close wrong match | search_menu |
| Human fallback counter | Customer stuck forever on same item | conversationEngine |

**Note on Guard 6 (duplicate detection):** Three implementations were built and reverted. Each broke poke bowl multi-modifier flow, nigiri multi-quantity orders, or two-bowl orders. Deferred. Root cause is item lifecycle complexity — same item_id can legitimately appear in cart multiple times or be re-searched in same turn.

---

## THE STATE MACHINE

**GREETING** — Ask pickup or delivery. Check store hours first. If closed, speak hours and end.
**ORDERING** — All tools available. Handles all ordering, corrections, questions, removals.
**AWAITING_CLARIFICATION** — Low-confidence search. AI asked customer to choose. Next turn: re-run search with clarification, do not treat customer response as a new item.
**AWAITING_MODIFIER** — Required modifier group missing. AI asked for it. Next turn: match answer to modifier options. Do not run a new item search.
**CONFIRMING** — Customer said they're done. AI calls get_cart(), reads back full order, states total. Waits for yes/no.
**POST_CONFIRMATION** — Customer confirmed. If they add something → re-enter ORDERING for that item only, then return here. If they confirm it's correct → COMPLETE.
**COMPLETE** — Order locked. Submit to POS.

---

## OPEN BUGS — MUST FIX BEFORE GO-LIVE

### B04 — Phantom item added to cart after human fallback (HARD BLOCKER)
A $40 Vegetable Platter appeared in cart when the customer never ordered it. Happened around the time human fallback triggered. Root cause unknown. B04 logging is now in conversationEngine — every tool call is logged by turn, cart state is logged when fallback phrase detected. Investigate logs before touching anything else.
**Do NOT modify the fallback mechanism until root cause is known.**

### BN2 — Extra items disappear on large multi-quantity orders (HIGH PRIORITY)
Customer orders 3 pies (2 cut into 16 slices, 1 normal). Only 1 pie lands in cart. Test: S006 confirms this. Suspected cause: AI tries to represent 3 pies with different special instructions in one add_to_cart call (quantity: 3) and loses the differentiation. Fix: Prompt rule — "When the same item needs different special instructions across units, place them as separate add_to_cart calls."

### B08 — Price query after ordering can re-add the item (HIGH PRIORITY)
Item in cart. Customer asks "how much was that?" → AI searches → finds it → re-offers → customer says "sure" (meaning the price is fine) → AI adds a second one. Guard 6 was implemented and reverted three times. Needs a new approach — possibly detecting price-query context from conversation history before add_to_cart runs.

### B05 + B06 — Mid-customization triggers add_to_cart instead of update_cart_item
B05: Customer asks to add modifiers to an existing item → AI calls add_to_cart → creates a duplicate.
B06: Customer says "add broccoli to my mac and cheese" → AI searches "broccoli" → adds Broccoli Calzone.
Root cause is the same: when customer is mid-customization of an existing cart item, the AI must call update_cart_item using the existing cartItemId. Only call add_to_cart for genuinely new items.

### B16 — Poke bowl requires too many separate exchanges (UX — deferred)
5 required modifier groups = 5+ exchanges. Poor phone experience. Fix: collect all modifiers the customer mentioned upfront, ask only about missing groups in one question. Low priority — deferred until after core accuracy is solid.

### B14 — Zero-quantity items visible in cart UI (UI only — deferred)
After size upgrade, old item shows ×0 — $0.00. Fix: filter quantity === 0 items from voiceTest.html render. No engine change.

---

## BUGS FIXED (for reference — do not revert these)

| Bug | Fix | Location |
|---|---|---|
| B01 Denial without search | Code-layer interception — blocks denial response if no search was called that turn | conversationEngine._runToolLoop |
| B02 AI suggests unverified items | Prompt rule 10 | conversationEngine system prompt |
| B07 Third item dropped | Was a broken test (wrong restaurant) — not an engine bug | — |
| B09 Max selections not enforced | Guard 3b added | toolHandler._addToCart |
| B10 Re-asks for stated modifier | Prompt REQUIRED modifier rule | conversationEngine system prompt |
| B12 One moment please filler | Prompt voice format rule | conversationEngine system prompt |
| B13 Special instructions lost in retry | Code: MISSING_REQUIRED result includes special_instructions_reminder from history scan | conversationEngine._runToolLoop |
| B13 Special instructions = AI text | Prompt rule | conversationEngine system prompt |
| B15 Nigiri mapped to roll | nigiri aliases added to sushiSpotConfig.specialTerminology | sushiSpotConfig.js |
| B17 California Roll → Holiday Roll | Guard 7: blocks adding non-top-result when search was confident | toolHandler._addToCart |
| BN1 History trimming caused 400 | Trimming walks back to clean boundary before tool exchange | conversationEngine._runToolLoop |

---

## FILE STRUCTURE

### Core engine (do not rename)
- `gohlem-menu-engine.js` — fuzzy search, alias normalization, confidence threshold
- `src/conversation/conversationEngine.js` — tool loop, B01 denial guard, B13 injection, B04 logging
- `src/tools/toolHandler.js` — all five tools + all guards including Guard 7
- `src/tools/definitions.js` — OpenAI tool schemas
- `src/orders/orderState.js` — OrderCart class (do not change)

### Restaurant configs (one per restaurant)
- `src/config/hotBagelsConfig.js` — specialTerminology, faqKnowledgeBase, storeSpecificInstructions
- `src/config/sushiSpotConfig.js` — includes California Roll no-rice-modifier instruction
- `src/config/pizzaPlaceConfig.js`
- `src/config/restaurantConfig.js` — Tony's (Phase 1 reference)

### Menus (two schemas both auto-normalized by _canonicalizeItem)
- Schema A (modifier_groups, base_price): hot_bagels.json, tonys_pizzeria.json
- Schema B (modifiers, price_delta): that_sushi_spot.json, pizza_place_lakewood.json
- Never manually convert — the engine normalizes on load

### Tests + UI
- `tests/conversation-benchmark.js` — full test runner, 14 static + 30 simulator cases
- `tests/benchmark.js` — menu engine only (25 cases, no API)
- `src/dashboard/voiceTest.html` — browser test UI

### Do not touch until Phase 3
- `src/voice/voiceServer.js`
- `src/voice/callHandler.js`

---

## DEPLOYMENT

- GitHub: github.com/gohlemvoice-byte/gohlem-vibe (auto-deploys to Railway on push)
- Railway: web-production-ef867.up.railway.app
- Start command: node src/voice/voiceServer.js
- Browser test: web-production-ef867.up.railway.app/voice/test

---

## LLM

OpenAI GPT-4o-mini. API key in .env as OPENAI_API_KEY.
Do not switch models without running the full benchmark before and after.

---

## STANDARD WORKFLOW FOR EVERY CODE CHANGE

1. Read the relevant file fully before editing
2. Make the change
3. Run `node tests/conversation-benchmark.js`
4. If score drops below 42/44 — revert and diagnose before proceeding
5. Commit and push

---

## HARD RULES — NEVER VIOLATE

1. The AI never generates an item name. It selects item IDs returned by search_menu.
2. The AI never generates a modifier name. It selects modifier option IDs returned by search_menu.
3. add_to_cart always validates IDs against the current turn's valid set. No exceptions.
4. All prices come from menu data. The AI never states a price it calculated itself.
5. The cart is always the source of truth. The AI reads from get_cart(), never from memory.
6. If two search results are within 15 points, ask the customer to choose. Never silently pick.
7. Never add an item priced more than 4× the average cart price (above $28 floor) without explicit customer confirmation.
8. Fixing a bug with a prompt instruction = stop. Build the enforcement in code.
9. Benchmark must use messy realistic transcripts only. No clean-text test cases.
10. Do not touch voiceServer.js or callHandler.js until Phase 3.
11. Run benchmark before AND after every change. Score drops = revert immediately.
12. Do NOT modify the human fallback mechanism until B04 (phantom item) is root-caused.
13. Before adding any item to the cart, search_menu must have been called this turn. No exceptions.
14. special_instructions must contain the customer's actual words, never the AI's verbal response.
15. Guard 7 enforces top-result use at the code layer. Do not weaken it without understanding the California Roll substitution bug it was built to fix.
