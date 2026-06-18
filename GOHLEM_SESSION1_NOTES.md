# GOHLEM.AI — SESSION 1 COMPLETE NOTES
**Date:** June 18, 2026  
**Duration:** Full day session  
**Status:** Foundation built and tested

---

## WHO WE ARE

**Company:** Gohlem.ai (G-O-H-L-E-M)  
**Founder:** Shulem  
**Mission:** AI-powered restaurant phone ordering platform that fully replaces the human order-taker on inbound calls  
**First test restaurant:** Hot Bagels 2nd Street, Lakewood NJ  
**Background:** Two failed developer attempts before this session. Developer 1 used Retell — wrong tool. Developer 2 built a demo that failed real tests. Both failed because they used AI as the state manager instead of building proper backend logic.

---

## THE CORE PHILOSOPHY
**Wrong approach (what both developers did):**
Customer → AI → POS

**Correct approach (what we are building):**
Customer → Speech Layer → Rules Engine → Order State Manager → Normalized Order Model → POS Mapper → POS

**The single most important principle:**
The AI owns conversation. The backend owns business logic. They never cross.

**The moat of Gohlem is NOT:**
- Twilio
- Deepgram
- GPT
- Redis

**The moat IS:**
1. Restaurant Rules Engine
2. Normalized Order Model
3. POS Integration Layer
4. Order State Management
5. Reliable order execution

**Voice AI is the easiest part. Reliable order execution is the product.**

---

## FULL TECHNICAL ARCHITECTURE

### Layer 1 — Telephony
- **Technology:** Twilio
- **Job:** Answer calls, stream audio, send SMS confirmations, handle failover
- **Cost:** $0.010/minute

### Layer 2 — Speech to Text
- **Technology:** Deepgram
- **Job:** Real-time streaming transcription, sub-300ms
- **Cost:** $0.007/minute
- **Critical addition:** Custom vocabulary per restaurant loaded at call start

### Layer 3 — Mismatch Detection (Sound-Alike Layer)
- **Technology:** Custom code
- **Job:** Catch mishearing before AI sees transcript
- **How:** Restaurant-specific pronunciation dictionary + Deepgram confidence scores
- **Example:** "loaches" → "lox", "barakas" → "bourekas", "wax" → "lox"
- **Threshold:** Words below 0.75 confidence that don't match menu trigger targeted re-ask
- **NOT a generic "I didn't understand" — a specific "Did you say lox?"**

### Layer 4 — Menu Database
- **Technology:** PostgreSQL + pgvector
- **Job:** Store complete menu — items, modifiers, prices, rules, restrictions
- **Critical:** Also stores semantic meaning vectors for semantic search
- **Populated:** Via POS API pull at restaurant onboarding

### Layer 5 — Semantic Search
- **Technology:** pgvector similarity search
- **Job:** Find relevant items by MEANING not keywords
- **Example:** "anything with strawberry" finds Strawberry Spring Smoothie even if not named "strawberry drink"
- **Speed:** ~100ms
- **Why it matters:** Solves the cold drinks problem — customer asks for cold drinks, POS just says "drinks", semantic search finds Snapple, Coke, etc. by understanding they are cold

### Layer 6 — Conversation Engine
- **Technology:** GPT-4o mini (NOT Claude for production — faster and cheaper for live calls)
- **Job:** Natural language conversation, ask clarifying questions, never invent items
- **Receives every turn:** Relevant menu slice + full conversation history + current order state
- **Hard rule:** Can only confirm items from engine response. Cannot generate item names or prices.
- **Output:** Structured JSON with database IDs — not free text

### Layer 7 — Order State Manager
- **Technology:** Redis
- **Job:** Hold live order in memory during entire call
- **Critical rule:** AI NEVER remembers the order. Redis remembers the order.
- **Supports:** Add, remove, edit, quantity changes, identical items with different modifiers

### Layer 8 — Restaurant Rules Engine
- **Technology:** Custom service — standalone, separate from AI
- **Job:** Enforce all restaurant-specific rules that POS doesn't capture
- **Examples:**
  - Giant Pizza Bagel requires 24hr notice and must call store
  - Bagels default toasted unless specified
  - Tuna comes with certain vegetables by default
- **Execution order:**
  1. Intent extracted
  2. Item matched
  3. Item loaded
  4. Modifier groups loaded
  5. Restrictions checked
  6. Customer modifiers applied
  7. Defaults applied
  8. Validation runs
  9. Order state updated
  10. Confirmation generated
- **Priority:** Customer override > restriction > default

### Layer 9 — Normalized Order Model
- **Purpose:** Single canonical order format between AI and every POS
- **Structure:**
  - Order ID, Restaurant ID, Customer, Order Type, Items, Notes, Status
  - Each item: Item ID, Name, Quantity, Modifier Set, Instructions
  - Each modifier: Modifier ID, Name, Action (ADD/REMOVE/EXTRA/LIGHT/SIDE)
- **Critical:** Voice → Normalized Order → POS Format. Never Voice → Toast directly.

### Layer 10 — POS Mapper
- **Connectors:** Toast (Phase 1), Clover (Phase 2), Square (Phase 3)
- **Two functions only:** PULL menu on onboarding, PUSH completed order to kitchen
- **Toast-specific challenge:** Modifier GUID mapping — Toast identifies everything by internal IDs not names
- **Solution:** Menu sync with versioning and validation checks

### Layer 11 — Text to Speech
- **Technology:** Deepgram Aura (v1), ElevenLabs (upgrade later)
- **Cost:** $0.010/minute

### Layer 12 — Dashboard
- **Built by:** Developer 1 (frontend exists)
- **Must show:** Calls, orders, transcripts, revenue, failed orders, escalated calls, unrecognized items, POS failures, menu sync failures, accuracy metrics

---

## INTELLIGENCE DESIGN — AI BEHAVIOR RULES

### Modifier Logic
- Required modifier missing → ALWAYS ask, no exceptions
- Optional modifier with default → apply silently, never ask
- Item exists in multiple categories → ask which type
- Conflicting combination requested → explain and offer alternatives
- Never confirm item until all required modifiers resolved

### Menu Grounding (Anti-Hallucination)
- AI may ONLY confirm items that exist in menu database
- AI may use common sense to reason about items (Snapple is cold) but NEVER invent items
- If item not found → say so and offer closest alternatives
- Prices, availability, restrictions come from database ONLY

### Conversation Behavior
- Ask only ONE clarifying question at a time
- Do NOT confirm each item individually — confirm full order ONCE at end
- Handle mid-order changes without losing context
- Escalate to human when frustrated or order cannot be resolved
- After two failed attempts at same item → escalate

### The Cold Drinks Problem — SOLVED
When customer asks "cold drinks" and POS just says "Drinks":
- AI receives relevant menu section
- AI uses real-world knowledge to identify cold vs hot items
- Returns only items from the menu — cannot invent
- This handles ALL common sense scenarios without pre-classification

### Anti-Hallucination Guardrails (Three Layers)
1. AI only sees items the engine returned — cannot mention anything else
2. After AI responds, engine validates every item against database before adding to order
3. AI outputs structured JSON with database IDs — not free text. Invalid ID = rejected.

---

## COST MODEL

| Component | Technology | Cost/Minute |
|-----------|-----------|-------------|
| Phone | Twilio | $0.010 |
| Speech to Text | Deepgram | $0.007 |
| AI Brain | GPT-4o mini | $0.010-0.020 |
| Text to Speech | Deepgram Aura | $0.010 |
| Server | Railway | <$0.001 |
| **TOTAL** | | **$0.03-0.04** |

**Target:** Under $0.05/minute ✓  
**Latency target:** Under 2 seconds per response ✓  
**Realistic latency breakdown:**
- Deepgram STT: ~300ms
- Semantic search: ~100ms
- GPT-4o mini: ~800ms-1.2 seconds
- Deepgram TTS: ~300ms
- Total: 1.5-1.8 seconds ✓

**Unit Economics per restaurant (100 calls/day, 3 min avg):**
- Revenue @ $0.15/min: $1,350/month
- Cost @ $0.04/min: $360/month
- Gross profit: $990/month per restaurant
- Gross margin: 73%

---

## PRONUNCIATION SOLUTION — HOT BAGELS SPECIFIC

### Three-Layer Approach:
1. **Deepgram custom vocabulary** — feed restaurant-specific words before calls start
2. **Sound-alike dictionary** — built per restaurant at onboarding
3. **Confidence-based re-ask** — targeted not generic

### Hot Bagels Sound-Alike Dictionary (to build):
- lox → locks, lucks, wax, lax, loaches
- challah → holla, hala, kala, challa
- bourekas → barakas, bureka, burekas, boreka
- schmear → smear, shmir, schmere
- babka → bapka, bobka
- kishke → kishka, kishki
- kugel → koogle, kugel
- farina → fureena, ferina

---

## WHAT WAS BUILT TODAY

### File: gohlem-menu-engine.js
**Status:** Complete and tested  
**Location:** Saved to outputs, ready to drop into gohlem-ai folder  

**What it does:**
- Loads any restaurant menu JSON — completely plug and play
- Indexes all items with fuzzy search tokens
- Finds items by meaning not exact keywords
- Analyzes modifier groups — determines must ask vs should ask vs will assume
- Validates orders against menu rules
- Calculates accurate pricing including modifier add-ons
- Generates natural AI questions for each modifier group

**Test results against real Hot Bagels menu (289 items, 32 categories):**
- "I want a tuna sandwich" → Found Tuna Sandwich $5.72 ✓
- "Something with lox" → Found 5 lox items ✓
- "Anything with strawberry" → Found Strawberry Spring Smoothie, Strawberry Slush, Boba ✓
- "I want an egg sandwich" → Found Scrambled Egg and Egg Salad — correctly flagged as ambiguous ✓
- American Cheese Sandwich modifier analysis → Correctly identified 2 required, 3 should-ask ✓
- Two sandwich order with split modifiers → $19.70 total calculated correctly ✓

**What it cannot do alone (needs AI layer):**
- Natural language conversation
- Common sense reasoning (cold drinks, etc.)
- Sound-alike matching (barakas → bourekas)
- Special instructions (scoop the dough)
- Order history (post-order modification)

---

## 14 TEST CASES — CURRENT STATUS

| # | Test | Engine Status | What's Missing |
|---|------|--------------|----------------|
| 1 | Everything bagel, lox, scoop the dough | Item found ✓ | Scoop the dough = special instruction layer |
| 2a | Cream cheese sandwich, coffee milk no sugar | Item found ✓ | Modifier parsing needs AI |
| 2b | Two sourdough challahs | Both variations found ✓ | AI needs to ask which one |
| 3 | Egg sandwich ambiguity | Both egg types found ✓ | AI needed to filter and ask |
| 4 | Split modifiers — two Mediterranean toasts | Item found ✓ | Order state manager needed |
| 5 | Conflicting modifiers — red milk, blue milk | Not found ✓ (correct) | AI needed for conflict explanation |
| 6 | Breakfast for two | Breakfast items found ✓ | AI needed to explain no package |
| 7 | Gift box + gift card note | Gift Box found ✓ | Gift card = special instruction layer |
| 8 | Giant Pizza Bagel restriction | Item found ✓ | Restriction not in POS — needs rules engine |
| 10 | Special instructions — smear tuna both sides | Item found ✓ | Special instruction capture needed |
| 11 | Challah and barakas | Challah found ✓, Barakas failed ✗ | Sound-alike dictionary needed |
| 12 | Payment handling | Not built | Future phase |
| 13 | SMS consistency | Order object correct ✓ | SMS layer future phase |
| 14 | Post-order modification | Hash Browns found ✓ | Order lifecycle layer needed |

**Engine score: 11/14 items found correctly**  
**All gaps have known solutions — all buildable**

---

## WHAT DOES NOT EXIST YET

In priority order for next sessions:

1. **Sound-alike pronunciation dictionary** — Hot Bagels specific
2. **Order State Manager** — Redis, holds live order during call, handles split modifiers
3. **Restaurant Rules Engine** — Giant Pizza Bagel restriction, defaults, conflicts
4. **AI Conversation Layer** — GPT-4o mini connected to engine with guardrails
5. **Special Instructions Handler** — scoop the dough, smear on both sides, gift card notes
6. **Toast API Connection** — live menu pull and order push
7. **Voice Layer** — Twilio + Deepgram connected to everything above
8. **SMS Confirmation** — Twilio SMS after order confirmed
9. **Post-Order Lifecycle** — modification and cancellation after POS submission
10. **Payment Handling** — spoken card capture
11. **Dashboard Integration** — connect engine data to existing frontend
12. **Menu Sync** — scheduled polling for menu changes

---

## DEVELOPMENT ENVIRONMENT

**Office computer:**
- VS Code installed
- Claude Code extension installed and signed in
- gohlem-ai project folder created at: C:\Users\shule\OneDrive\Documents\gohlem-ai
- Project structure created by Claude Code (package.json, all folders)

**Laptop:**
- gohlem-menu-engine.js downloaded
- Hot Bagels menu JSON: hot_bagels_menu_with_real_acai_restaurant.json

**Still needed:**
- GitHub account and repository — sync between office and laptop
- Node.js installed on both computers
- Toast sandbox credentials: dev.toasttab.com

---

## BUILD APPROACH

**Method:** Vibe coding — Shulem directs, Claude Code builds, Claude (this chat) architects and reviews  
**Workflow:**
1. Come to this chat first — get the plan and exact prompt
2. Take prompt to Claude Code — it builds
3. Bring results back here — review together
4. Repeat

**Rule:** Never move to next layer until current layer passes all relevant test cases.

**Tools:**
- Claude Code (VS Code extension) — primary builder, $100/month Max plan
- This chat — architect, reviewer, strategist
- ChatGPT — second opinion, pressure testing
- GitHub — sync and version control
- Railway — deployment when ready

---

## IMPORTANT DISCOVERIES THIS SESSION

1. **The Two Cream Cheese Problem** — Scrambled Egg Sandwich has cream cheese in TWO different modifier groups at different prices ($1.50 and $0.99). AI must recognize they're the same thing and pick correctly.

2. **Giant Pizza Bagel has ZERO modifier groups in POS** — The 24hr restriction doesn't exist in the menu data. Must be stored in the Rules Engine separately.

3. **"No Bagel" exists as a modifier** — Some sandwiches can be ordered without a bagel. System must handle gracefully. Not Gohlem's job to fix restaurant POS setup.

4. **Bourekas appears as both "Bourekas" and "Boreka" in same menu** — Inconsistent naming within same restaurant's POS. System must handle both.

5. **Vegetables appear in multiple modifier groups** — Lettuce and tomato exist in both "Vegetables Choose Up To 3" AND "Vegetables in Omelets" with different prices ($0 vs $0.50). Engine must pick correct group based on item context.

6. **Menu has 289 items across 32 categories** — Far more complex than typical restaurant. Semantic search and dynamic context loading are non-negotiable, not optional.

---

## SESSION 2 GOALS (TOMORROW)

**Hour 1:** GitHub setup — project synced, accessible from anywhere  
**Hour 2:** Sound-alike pronunciation dictionary for Hot Bagels  
**Hour 3:** Order State Manager — Redis structure, split modifier support  
**Hour 4:** Restaurant Rules Engine — Giant Pizza Bagel restriction, defaults  
**Hour 5:** First AI conversation layer — GPT-4o mini connected to engine  
**Hour 6:** Run all 14 test cases against complete system

**Definition of Session 2 success:**  
Type a full order in text. System processes it correctly. All required modifiers asked. All defaults applied silently. Split modifiers on same item handled. Giant Pizza Bagel blocked with correct message. Order total calculated accurately.

---

## CONTEXT FOR NEXT SESSION

Paste this entire document at the start of next session with this message:

*"This is the complete context from our last Gohlem session. We are continuing to build the AI voice ordering engine. Pick up exactly where we left off. Next step is Hour 1 — GitHub setup."*

