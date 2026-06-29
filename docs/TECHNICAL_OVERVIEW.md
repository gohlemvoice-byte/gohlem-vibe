# GOHLEM.AI — TECHNICAL OVERVIEW
> For external review by LLMs and human developers.
> Single document covering architecture, code patterns, known issues, decisions, and current status.
> Last updated: June 2026

---

## 1. WHAT THIS SYSTEM DOES

Gohlem.ai is an AI-powered phone ordering system for restaurants. A customer calls a restaurant, the AI answers, takes their complete order over voice (including items, modifiers, quantities, corrections, multi-item), confirms it accurately, and outputs a structured JSON order to the restaurant's POS system (Toast).

**Goal:** Replace human phone order-takers with an AI that is more accurate, always available, and never mishears an order.

**Restaurants currently in production (or near-production):**
- Hot Bagels 2nd Street, Lakewood NJ (289-item menu)
- That Sushi Spot (200-item menu)
- The Pizza Place, Lakewood NJ (218-item menu)
- Tony's Brick Oven Pizzeria (100-item menu — development reference)

**What makes this hard:**
- Customers say "nachiris" (meaning nigiri), "harif" (meaning spicy), "adamehame" (meaning edamame)
- Customers say "I want a sandwich and a coffee and also do you have soup?" — three intents in one breath
- Customers change their mind mid-order: "actually, make the first one toasted"
- Menus have individual items AND bulk/catering versions of the same thing
- Required modifier groups (bagel type, fish for poke bowl, pizza size/crust) must all be filled before ordering
- The AI must never invent items that don't exist or confirm prices it hasn't verified

---

## 2. SYSTEM ARCHITECTURE

```
PHONE CALL (Twilio)
       │
       ▼
DEEPGRAM STT ──────► raw transcript text
       │
       ▼
CONVERSATION ENGINE (Node.js / GPT-4o-mini)
       │
       ├── search_menu(query)
       │         │
       │         ▼
       │    MENU ENGINE (fuzzy match, alias normalization,
       │                  modifier content search)
       │         │
       │         ▼
       │    Returns: item IDs, modifier IDs, prices, clarification flag
       │
       ├── add_to_cart(item_id, modifier_ids[], qty, instructions)
       ├── remove_from_cart(cart_item_id)
       ├── update_cart_item(cart_item_id, ...)
       └── get_cart()
                 │
                 ▼
            ORDER CART (validated, structured)
                 │
                 ▼
       TEXT RESPONSE ──► ElevenLabs/OpenAI TTS ──► AUDIO to customer
                 │
                 ▼ (when order confirmed)
        TOAST POS API
```

**The key architectural insight:** The AI interprets language. Code makes every decision about what exists. The AI never names an item or modifier — it selects IDs returned by `search_menu`. Code validates those IDs, calculates prices, and updates the cart. This makes hallucination structurally impossible at the data layer.

---

## 3. TECHNOLOGY STACK

| Layer | Technology |
|---|---|
| Runtime | Node.js (CommonJS) |
| LLM | OpenAI GPT-4o-mini (tool calling mode) |
| STT | Deepgram Nova-3 (Phase 3 — not yet connected) |
| TTS | OpenAI TTS / ElevenLabs (Phase 3) |
| Phone | Twilio (Phase 3) |
| POS | Toast API (Phase 4) |
| Hosting | Railway (auto-deploy from GitHub) |
| Menu data | Static JSON files (two schemas, auto-normalized) |
| Testing | Custom benchmark runner (Node.js + OpenAI) |

**Current phase:** Phase 2 (multi-restaurant, real speech testing, bug fixing). Phase 3 (voice layer) not yet started.

---

## 4. THE CONVERSATION ENGINE

File: `src/conversation/conversationEngine.js`

The engine runs a tool-calling loop. On each customer message, it calls the LLM repeatedly until the LLM produces a response with no tool calls. Between iterations, tool results are appended to the message history.

```javascript
// Simplified structure of _runToolLoop()
async _runToolLoop() {
  let iterations = 0;
  let searchCalledThisTurn = false;

  while (iterations < MAX_TOOL_ITERATIONS) {  // MAX = 12
    iterations++;

    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [systemPrompt, ...trimmedHistory],
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
      temperature: 0.2,
    });

    const msg = res.choices[0].message;

    // No tool calls = final spoken response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const responseText = msg.content;

      // B01 guard: block denial language if no search was called this turn
      if (hasDenialLanguage(responseText) && !searchCalledThisTurn) {
        history.push({ role: 'user', content: '[System alert: Call search_menu first]' });
        continue;
      }

      // B04 logging: log when human fallback triggers
      if (hasFallbackLanguage(responseText)) {
        console.log('[B04] Fallback triggered. Cart:', getCart());
      }

      return responseText;
    }

    // Process tool calls
    history.push(msg);
    for (const call of msg.tool_calls) {
      if (call.function.name === 'search_menu') searchCalledThisTurn = true;

      const result = toolHandler.execute(call.function.name, args);

      // B13: if MISSING_REQUIRED, inject special instruction hint from history
      if (call.function.name === 'add_to_cart' && result.error === 'MISSING_REQUIRED') {
        const hint = extractSpecialInstructionsFromHistory();
        if (hint) result.special_instructions_reminder = `Customer said: "${hint}"`;
      }

      history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
}
```

**History trimming:** The last 12 messages are sent on each API call. The trimmer always walks back to a clean boundary (a user message or a plain assistant message without tool_calls) to avoid sending an orphaned `tool` message that would cause a 400 error from OpenAI.

**Turn tracking:** Each `chat()` call increments `turnId` and calls `toolHandler.beginTurn(turnId)`, which resets per-turn state (search result registry for Guard 7).

---

## 5. THE FIVE TOOLS

File: `src/tools/toolHandler.js`

### search_menu(query)
Calls the menu engine with the customer's words. Returns up to 5 items with full modifier group data. Populates the "valid set" — only IDs from the current session's search results can be used in add_to_cart.

Key behaviors:
- First result is marked `is_top_result: true`
- Each search registers `{ topResultId, allResultIds, clarificationNeeded }` in `searchResults[]`
- This per-search registry is how Guard 7 works without breaking multi-item orders
- Secondary search (modifier content) runs automatically when primary returns nothing

### add_to_cart(item_id, modifier_option_ids[], quantity, special_instructions)

Guards run in order. First failure stops execution:

```javascript
// Guard 1: item must come from this turn's search
if (!validItemIds.has(item_id)) return INVALID_ITEM_ID_error;

// Guard 2: all modifier IDs must be valid options for this specific item
const invalid = modifier_ids.filter(id => !validModsForItem.has(id));
if (invalid.length > 0) return INVALID_MODIFIER_ID_error;

// Guard 3: all required modifier groups must have a selection
const missing = requiredGroups.filter(group => noSelectionFrom(group));
if (missing.length > 0) return MISSING_REQUIRED_error;

// Guard 3b: no group may have more selections than max_selections (B09)
const overLimit = groups.filter(g => selectedCount > g.max_selections);
if (overLimit.length > 0) return EXCEEDS_MAX_SELECTIONS_error;

// Guard 4: catering items require advance notice
if (item.category === 'Catering') return RESTRICTION_CATERING_error;

// Guard 5: price anomaly — blocks silent bulk/party item adds
const avg = averageCartItemPrice();
if (item.price >= FLOOR_$28 && item.price > avg * 4) return PRICE_ANOMALY_error;

// Guard 7: top-result enforcement (B17 fix)
// Find the specific search that returned this item, check if it was top result
const search = searchResults.find(s => s.allResultIds.has(item_id));
if (search && item_id !== search.topResultId && !search.clarificationNeeded) {
  return NOT_TOP_RESULT_error;  // AI substituted a lower-ranked item
}

// All guards passed — add to cart
const cartItemId = cart.addItem(item, modifiers, quantity, special_instructions);
```

### remove_from_cart(cart_item_id)
Simple removal. Always succeeds if cart_item_id is valid.

### update_cart_item(cart_item_id, add_modifier_ids[], remove_modifier_ids[], quantity, special_instructions)
Used for all mid-order corrections. "Make the first one toasted" → AI calls get_cart() to get cart_item_id, then calls update_cart_item. This is structurally separate from add_to_cart to prevent duplicates.

### get_cart()
Returns the full order state. AI calls this when the customer says they're done (before reading back the order) or when it needs a cart_item_id for update/remove. Not called after every add — add_to_cart already returns a cart summary.

---

## 6. THE MENU MATCHING ENGINE

File: `gohlem-menu-engine.js`

Fuzzy text matching with several specific fixes for restaurant ordering:

### Scoring Algorithm
```
Base score = 0
+ 100 if query tokens are a subset of item name tokens
+ 50 if item name starts with query
+ 30 for each matching word
+ 20 if item name includes the full query as a substring
- 10 for each word in item name that does NOT appear in the query
```

The extra-word penalty (`-10 per unmatched word`) is the key fix for the "Hot Coffee vs Hot Coffee Box" problem. "hot coffee" query: Hot Coffee scores 100, Hot Coffee Box scores 90 (penalty for "Box"). The shorter exact match wins.

### Two-Pass Search
**Primary:** Scores all items by name match.
**Secondary:** When primary returns nothing or all scores < 20, scan modifier group names and modifier option names across all items. "vegetables" → finds items that have vegetable modifier groups. "spicy" → finds items with spicy modifier options. This is how the system handles category words.

### Alias Normalization
Before any search, the query is normalized through `restaurantConfig.specialTerminology`:
```
nachiris → nigiri
adamehame → edamame
harif → (used as special instruction, not item search)
pokeball → poke bowl
barakas → bourekas
lox → search both "lox" and "sliced lox"
```
This runs at the tool layer, not in the AI prompt. The AI doesn't decide what "nachiris" means.

### Confidence Threshold
If the top two results score within 15 points of each other: `clarification_needed: true`. The AI must ask the customer to choose rather than silently picking one. When `clarificationNeeded` is true, Guard 7 does not fire (the customer may legitimately want the second result).

### Two Menu Schemas
The system supports two JSON schemas without requiring manual conversion:
- **Schema A** (Hot Bagels, Tony's): `modifier_groups`, `base_price`, option `.price`
- **Schema B** (Sushi, Pizza Place): `modifiers`, `max_select`, `price`, option `.price_delta`
`_canonicalizeItem()` normalizes both to Schema A on load.

---

## 7. RESTAURANT CONFIGURATION

File pattern: `src/config/[restaurant]Config.js`

Each restaurant exports a single config object:

```javascript
module.exports = {
  restaurantInfo: { name, pickupHours, deliveryMinimum, orderTypes, ... },
  menuFile: path.join(__dirname, '../../menus/restaurant.json'),
  cateringItemIds: [],   // IDs that require 24-48 hour advance notice
  specialTerminology: `
    nachiri = nigiri
    adamame = edamame
    harif = spicy (special instruction)
  `,
  faqKnowledgeBase: `
    We are kosher certified under reliable hashgacha.
    Hours: Monday-Thursday 10:30am-9pm ...
    Delivery minimum: $20.
    We cannot guarantee allergen-free preparation.
  `,
  storeSpecificInstructions: `
    CALIFORNIA ROLL: Has no rice modifier. Add as-is with no rice question.
    RICE CHOICE: Only ask if search result includes a Rice Choice modifier group.
  `,
};
```

The conversation engine injects `specialTerminology`, `faqKnowledgeBase`, and `storeSpecificInstructions` into the system prompt. Zero restaurant-specific logic lives in the engine. Same engine serves all four restaurants.

---

## 8. THE SYSTEM PROMPT

The system prompt is built once per session and includes:
- Voice format rules (no markdown, 1-3 spoken sentences, no "one moment please")
- Tool descriptions and when to call each one
- 11 critical tool rules (search before add, only use IDs from results, etc.)
- Conversation flow (greeting → ordering → confirming → complete)
- Ordering rules (what counts as a clear ordering signal vs a question)
- Modifier rules (required vs optional, don't re-ask for stated modifiers)
- Restaurant info (name, hours, delivery minimum)
- Injected: specialTerminology, faqKnowledgeBase, storeSpecificInstructions

The system prompt is about 600 tokens. Temperature is 0.2 (low randomness — this is a functional task, not creative).

---

## 9. STATE MACHINE

States and transitions:

| State | What's allowed | Transition |
|---|---|---|
| GREETING | No orders. Capture pickup/delivery. | → ORDERING |
| ORDERING | All tools. Handle corrections, questions, removals. | → CONFIRMING |
| AWAITING_CLARIFICATION | Low-confidence search. AI asked customer to choose. | → ORDERING |
| AWAITING_MODIFIER | Required group missing. AI asked. | → ORDERING |
| CONFIRMING | get_cart → read back order → state total. Wait for yes/no. | → POST_CONFIRMATION |
| POST_CONFIRMATION | If customer adds item → ORDERING for that item only, then back here. | → COMPLETE |
| COMPLETE | Order locked. Submit to POS. | — |

---

## 10. BEHAVIORAL REQUIREMENTS (THE MUST-PASS LIST)

These 18 behaviors must survive every code change. Derived from real speech testing.

1. **Semantic category understanding** — "something cold to drink" → search for cold beverages; "do you have vegetables?" → secondary modifier search finds items with vegetable modifier options. System must understand WHAT things are, not just match exact words.

2. **Mispronunciation/sound-alike resolution** — alias normalization in code (never prompt). "nachiris" → nigiri. "adamehame" → edamame. New discoveries → add to specialTerminology config, not the prompt.

3. **Multi-item in one turn** — "A sandwich, coffee, and soup" → all three must be added before any spoken response. Never drop an item because an earlier item needed clarification.

4. **Stated modifier — never re-ask** — "medium temperature salmon" → add immediately without asking temperature. "thin crust large pepperoni" → add immediately without asking size or crust.

5. **Special instructions = customer's actual words** — `special_instructions: "harif"` not `"I'll note that for the kitchen"`. The kitchen reads this field.

6. **Special instructions survive modifier retry** — If customer says "harif" then AI asks "what bagel?" then customer answers — "harif" must appear in the final add_to_cart. Code-enforced via B13 injection into MISSING_REQUIRED result.

7. **Never deny without searching** — Code-enforced. If AI response contains denial language and search_menu was not called that turn, response is blocked and AI is forced to search first.

8. **Never suggest without searching** — Cannot say "try the iced tea" unless iced tea appeared in a search result this session.

9. **Always use the top search result** — Code-enforced via Guard 7. If AI tries to add a non-top result on a confident search, blocked and redirected to correct item.

10. **Update vs Add** — Modifying an existing cart item → update_cart_item. Never add_to_cart again for an item being customized.

11. **Positional references** — "Make the first one toasted" → get_cart(), map "first" to position 1, call update_cart_item.

12. **Price queries do not add** — "How much is the X?" → search → state price → ask "would you like to add that?" — intent is NONE.

13. **Individual vs bulk default** — When individual and bulk versions of same item both exist, always default to individual. Price anomaly guard (Guard 5) enforces at code level.

14. **Same item, different modifiers = separate cart items** — "One toasted, one not" → two separate add_to_cart calls.

15. **Confirmation flow** — get_cart → read back all items → state total → wait for explicit confirmation → lock order.

16. **Cultural/dietary — FAQ only** — Never invent kosher or allergen answers. If not in FAQ: "I don't have that information."

17. **Human fallback — failures only** — Fires after 2 failed search_menu returns for the same item. Not on customer impatience. Counter lives in tool result handler, not conversation loop.

18. **Max selections — code enforced** — Guard 3b blocks over-selection within any modifier group. Poke bowl fish group max 1 cannot accept "grilled tuna AND raw salmon."

---

## 11. TEST METHODOLOGY

### Benchmark
Two test suites run from `tests/conversation-benchmark.js`. Both make real OpenAI API calls.

**Static cases (14):** Scripted turn-by-turn conversations. Deterministic. Assert exact cart contents.
**Simulator cases (30):** A second GPT-4o-mini LLM plays the customer dynamically, adapting to the agent's responses. Each scenario has a goal (e.g., "order a tuna sandwich with harif on an everything bagel") and assertion on cart contents.

Simulator cases cover: BN2 (partial special instructions), B01 (drinks denial), B08 (price re-add), B06 (wrong item on customization), B13+B05 combo, BN1 regression, B16 (poke bowl upfront), B10 regression, lox alias, B15 regression, price anomaly, positional removal, post-confirmation add, modifier content search, two poke bowls, impatience, three items in one breath, delivery address, out of stock, half-and-half, vegetarian request, B17, french fries disambiguation, knowledge boundary, ambiguous order type.

**Current score: 42/44 (95%)**
- Static: 13/14 (93%) — C009 non-deterministic (California Roll B17 flip ~50%)
- Simulator: 29/30 (97%) — S006 is the known BN2 open bug

### Rule
Every test uses realistic messy transcripts. No clean-text inputs. If a human would not say it exactly that way in a real call, it does not belong in the benchmark.

---

## 12. KNOWN ISSUES & STATUS

### HARD BLOCKER
**B04 — Phantom item in cart after human fallback**
A $40 Vegetable Platter appeared in cart. Customer never ordered it. Happened around the same time human fallback triggered. Root cause unknown. B04 logging is now in the tool loop — every tool call is logged by turn, cart state is logged when fallback language is detected in the response. Do not touch the fallback mechanism until root cause is known. Suspected cause: tool calls execute after the AI has already decided to output the fallback message, and the cart add completes before the transfer.

### MUST FIX BEFORE LIVE

**BN2 — Extra pies disappear on multi-quantity orders (S006 FAIL)**
Customer orders 3 pies (2 cut into 16 slices, 1 normal). Only 1 pie lands in cart. Suspected: AI tries to use quantity:3 with one special_instructions value and loses the differentiation between the two subgroups. Fix: prompt rule — when same item needs different special instructions per unit, separate them into individual add_to_cart calls.

**B08 — Price query can re-add existing cart item**
Item in cart. Customer asks "how much was that?" → AI searches → finds it → re-offers → customer says "sure" (meaning the price is fine) → AI adds a second one. Three Guard 6 implementations all reverted:
- Attempt 1: any duplicate blocked → broke poke bowl optional modifier flow
- Attempt 2: same-turn exemption → poke bowl search-twice flow bypassed the guard, adding 2 poke bowls
- Attempt 3: update_cart_item guidance in ALREADY_IN_CART error → broke S015 (nigiri multi-quantity) and S020 (two distinct poke bowls)
Root issue: the same item can legitimately need to be added twice (different modifier sets), re-searched in same turn (poke bowl optional mods), or requested as a genuine second item. Any simple "already in cart" guard hits one of these cases.

**B05 + B06 — Mid-customization triggers wrong tool**
B05: Customer asks to add modifiers to existing item → AI calls add_to_cart → duplicate created.
B06: "Add broccoli to my mac and cheese" → AI searches "broccoli" → adds Broccoli Calzone.
Same root cause: the AI loses context that the customer is customizing an existing cart item, not ordering a new one. Correct: AI should call get_cart(), get the cart_item_id, then call update_cart_item.

### OPEN / LOWER PRIORITY
**B16 — Poke bowl exchanges** — 5 required groups = 5 separate exchanges. Fix: ask only about missing groups after collecting what the customer stated upfront. Deferred.
**B14 — Zero-quantity items in UI** — After size upgrade, ×0 items show. Filter in voiceTest.html. No engine change. Deferred.

### RECENTLY FIXED (do not revert)
| Bug | Fix type | Location |
|---|---|---|
| B01 — AI denies without searching | Code (denial interception) | conversationEngine._runToolLoop |
| B09 — Max selections not enforced | Code (Guard 3b) | toolHandler._addToCart |
| B10 — Re-asks for stated modifier | Prompt | conversationEngine system prompt |
| B13 — Special instructions lost in retry | Code (MISSING_REQUIRED injection) | conversationEngine._runToolLoop |
| B13 — Special instructions = AI text | Prompt | conversationEngine system prompt |
| B15 — Nigiri mapped to roll | Config (aliases) | sushiSpotConfig.specialTerminology |
| B17 — Item substitution on confident search | Code (Guard 7) | toolHandler._addToCart |
| BN1 — History trimming caused 400 errors | Code (boundary check) | conversationEngine._runToolLoop |

---

## 13. ARCHITECTURAL DECISIONS & TRADEOFFS

### Why tool calling instead of intent extraction?
The prior build had the AI output a JSON blob like `{ "intent": "ADD_ITEM", "item_name": "tuna sandwich", "modifiers": ["sesame bagel"] }`. The problem: the AI would invent modifier names like "sesame bagel" instead of using an actual menu option ID. Fuzzy matching that back to real IDs was unreliable. With tool calling, the AI receives option IDs from search_menu and passes them back — it cannot invent an ID that wasn't returned.

### Why GPT-4o-mini instead of a larger model?
Latency. Phone calls need responses in 1-2 seconds. GPT-4o-mini is fast and cheap. At 0.2 temperature, it performs reliably on structured tasks. The benchmark runs before and after every model consideration — any model change requires a benchmark comparison.

### Why not embeddings/vector search?
Semantic similarity search ("something cheesy" → finds cheesy items) was evaluated but deferred. The fuzzy text match + modifier content search handles ~90% of real-world queries. Embeddings would add latency, cost, and infrastructure complexity. The benchmark has an "embedding gap" category that documents which queries fail without it — those are known edge cases.

### Why static JSON menus instead of live Toast API?
Phase 4 concern. Static menus are deterministic and testable. Live menus introduce TTL, caching, and sync complexity. The architecture already stores POS GUIDs in the JSON — swapping to live pull requires only menuLoader.js changes, not the engine.

### Why keep the valid set per-turn instead of per-session?
Cross-turn ID reuse is dangerous. If the customer orders a sandwich in turn 1, the sandwich modifier IDs are valid in turn 1. In turn 3, when they say "and a coffee," the system should search fresh. A per-session valid set would let stale IDs be used without re-searching. Per-turn forces a search before every add — at the cost of slightly more API calls.

### Why accumulate valid set across parallel searches in the same turn?
Multi-item orders. "A sandwich and a coffee" → two search_menu calls in one turn (for sandwich, then for coffee). Both need to be in the valid set before the two add_to_cart calls execute. If the valid set cleared on each search, the first item's IDs would be gone by the time the second search ran.

---

## 14. FILE MAP

```
gohlem-ai/
├── gohlem-menu-engine.js          # Fuzzy search, alias normalization, secondary search
├── src/
│   ├── conversation/
│   │   └── conversationEngine.js  # Tool calling loop, state, B01/B13/B04 guards
│   ├── tools/
│   │   ├── toolHandler.js         # All 5 tools + Guards 1-5, 3b, 7
│   │   └── definitions.js         # OpenAI tool schemas
│   ├── orders/
│   │   └── orderState.js          # OrderCart class (battle-tested, do not change)
│   ├── config/
│   │   ├── hotBagelsConfig.js     # Hot Bagels restaurant config
│   │   ├── sushiSpotConfig.js     # Sushi Spot config (incl. California Roll instruction)
│   │   ├── pizzaPlaceConfig.js    # Pizza Place config
│   │   └── restaurantConfig.js    # Tony's (Phase 1 reference)
│   ├── pos/
│   │   └── toastConnector.js      # Toast API wiring (Phase 4 — not yet connected)
│   ├── voice/
│   │   ├── voiceServer.js         # Twilio server (Phase 3 — do not touch)
│   │   └── callHandler.js         # Twilio routing (Phase 3 — do not touch)
│   └── dashboard/
│       └── voiceTest.html         # Browser test UI with restaurant dropdown
├── menus/
│   ├── hot_bagels.json            # 289 items, Schema A
│   ├── that_sushi_spot.json       # 200 items, Schema B
│   ├── pizza_place_lakewood.json  # 218 items, Schema B
│   └── tonys_pizzeria.json        # 100 items, Schema A (dev reference)
├── tests/
│   ├── conversation-benchmark.js  # 14 static + 30 simulator cases
│   └── benchmark.js               # Menu engine only (25 cases, no API)
├── CLAUDE.md                      # Master context for Claude Code (source of truth)
└── docs/
    └── TECHNICAL_OVERVIEW.md      # This document
```

---

## 15. WHAT'S NEXT (PHASE PLAN)

### Phase 2 (current — IN PROGRESS)
Fix remaining pre-live bugs in priority order:
1. Root-cause B04 (phantom item) — investigate Railway logs from B04 logging
2. Fix BN2 (3 pies / multi-quantity with different special instructions)
3. Fix B08 (price re-add) with an approach that doesn't break poke bowl or multi-bowl orders
4. Fix B05+B06 (mid-customization context awareness)
5. Achieve 45/44 or better on benchmark (stretch: 44/44)

### Phase 3 — Voice Layer
Connect Twilio + Deepgram. The conversation engine does not change. Only `voiceServer.js` and `callHandler.js` are touched. Key concerns at this layer:
- Turn detection (Deepgram endpointing config)
- Latency (stream TTS, consider Haiku if latency is unacceptable)
- Background noise (Deepgram Nova-3)
- Barge-in (requires Retell or OpenAI Realtime for native interruption)

### Phase 4 — Toast Integration
Live menu pull from Toast API. Push confirmed orders to POS. GUIDs are already stored in menu JSON files — the mapping layer is ready. The main work is menuLoader.js TTL caching and the order submission call.

### Phase 5 — First Live Restaurant
Hot Bagels goes live. Real calls. Human graders score accuracy on real calls.

---

## 16. QUESTIONS FOR EXTERNAL REVIEWER

If you are reviewing this architecture, these are the open questions we'd most value feedback on:

1. **Guard 6 (duplicate add detection):** Three implementations all regressed existing tests. Is there a canonical pattern for "detect if this add_to_cart is a duplicate vs a legitimate second order vs a modifier add to an existing item" without explicit state tracking that would block the poke bowl flow?

2. **B04 (phantom item):** The suspected cause is that tool calls continue executing after the LLM has already decided to output the fallback message (since content + tool_calls can arrive in the same message from OpenAI). Is there a clean way to atomically freeze the cart when a fallback response is generated?

3. **History boundary trimming:** We trim to last 12 messages and walk back to a clean boundary (user message or plain assistant message). Is 12 messages the right window? At what point does conversation quality degrade due to context loss on long orders?

4. **Temperature 0.2:** Is this the right setting for tool-calling tasks? Higher temperature might cause more hallucination on IDs; lower temperature might reduce natural language quality in responses.

5. **Simulator as quality gate:** The simulator cases use GPT-4o-mini to play the customer. The simulator customer is too cooperative — it naturally gives clear answers that avoid edge cases. Real customers don't. How can we make the simulator customer more adversarial without making it impossible for the agent to succeed?
