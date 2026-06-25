'use strict';

require('dotenv').config();
const path = require('path');

const MenuEngine = require('../gohlem-menu-engine');
const ConversationEngine = require('../src/conversation/conversationEngine');
const restaurantConfig = require('../src/config/restaurantConfig');

const STANDARD_CASES = require('./benchmark-cases/phase1-standard.json');
const GAP_CASES = require('./benchmark-cases/phase1-embedding-gap.json');

const mode = process.argv[2] || 'engine';  // 'engine' or 'conversation'
const verbose = process.argv.includes('--verbose');

// ─── ENGINE TESTS (no API calls) ────────────────────────────────────────────

function runEngineTests() {
  const engine = new MenuEngine().loadMenu(restaurantConfig.menuFile);
  console.log('\n══════════════════════════════════════════════════');
  console.log('  GOHLEM BENCHMARK — Menu Engine Tests (No API)');
  console.log('══════════════════════════════════════════════════\n');

  let passed = 0;
  const total = SCORING_TESTS.length;

  for (const test of SCORING_TESTS) {
    const results = engine.findItems(test.query, 5);
    const top = results[0];
    const topName = top ? top.item.name : '(no results)';
    const topScore = top ? top.score : 0;

    const ok = topName === test.expected_top;
    if (ok) passed++;

    const status = ok ? '✓' : '✗';
    if (verbose || !ok) {
      console.log(`${status} [${test.id}] "${test.query}"`);
      console.log(`    Expected: ${test.expected_top}`);
      console.log(`    Got:      ${topName} (score ${topScore})`);
      if (results.length > 1) {
        const second = results[1];
        console.log(`    #2:       ${second.item.name} (score ${second.score})`);
        const needsClarity = engine.needsClarification(results);
        if (needsClarity) console.log(`    CLARIFICATION NEEDED`);
      }
    } else {
      console.log(`${status} [${test.id}] "${test.query}" → ${topName}`);
    }
  }

  console.log(`\nEngine score: ${passed}/${total} (${Math.round(passed/total*100)}%)\n`);

  // Embedding gap spot-checks
  console.log('── Embedding Gap Spot-checks ──');
  for (const test of EMBEDDING_SPOT_CHECKS) {
    const results = engine.findItems(test.query, 3);
    const secondary = engine.secondarySearch(test.query);
    const topPrimary = results[0] ? results[0].item.name : '(no primary results)';
    const topSecondary = secondary[0] ? secondary[0].name : '(no secondary results)';

    console.log(`\n  "${test.query}" [E${test.id}]`);
    console.log(`    Primary:   ${topPrimary}${results[0] ? ' ('+results[0].score+')' : ''}`);
    console.log(`    Secondary: ${topSecondary}`);
    console.log(`    Expected:  ${test.expected_note}`);
  }
}

// ─── CONVERSATION TESTS (requires OpenAI API) ────────────────────────────────

async function runConversationTests() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  GOHLEM BENCHMARK — Conversation Tests (API)');
  console.log('══════════════════════════════════════════════════\n');

  if (!process.env.OPENAI_API_KEY) {
    console.log('ERROR: OPENAI_API_KEY not set. Cannot run conversation tests.\n');
    process.exit(1);
  }

  const cases = STANDARD_CASES.cases.filter(c => c.expected_cart && !c.expected_cart.note);
  let passed = 0;
  const total = cases.length;

  for (const testCase of cases) {
    process.stdout.write(`[${testCase.id}] ${testCase.description}... `);

    try {
      const engine = new ConversationEngine(restaurantConfig);
      await engine.open();

      for (const input of testCase.inputs) {
        await engine.chat(input);
      }

      const cart = engine.cart.getOrder();
      const ok = checkCart(cart, testCase.expected_cart);

      if (ok) {
        passed++;
        console.log('✓ PASS');
      } else {
        console.log('✗ FAIL');
        if (verbose) {
          console.log(`    Expected: ${JSON.stringify(testCase.expected_cart, null, 2)}`);
          console.log(`    Cart:     ${engine.cart.getSummary()}`);
        } else {
          console.log(`    Cart: ${engine.cart.getSummary()}`);
        }
      }
    } catch (err) {
      console.log(`✗ ERROR: ${err.message}`);
    }
  }

  console.log(`\nConversation score: ${passed}/${total} (${Math.round(passed/total*100)}%)`);
  console.log('Target: 18/20 (90%)\n');
}

function checkCart(cart, expected) {
  if (expected.item_count !== undefined && cart.itemCount !== expected.item_count) {
    return false;
  }
  if (expected.items) {
    for (const exp of expected.items) {
      const found = cart.items.find(i => i.name === exp.name);
      if (!found) return false;
      if (exp.quantity !== undefined && found.quantity !== exp.quantity) return false;
      if (exp.price_max !== undefined && found.unitPrice > exp.price_max) return false;
    }
  }
  return true;
}

// ─── SCORING TEST CASES (engine unit tests, no API) ──────────────────────────

const SCORING_TESTS = [
  // Core fix: exact match wins over substring match with extra word
  { id: 'SC01', query: 'hot coffee',         expected_top: 'Hot Coffee' },
  { id: 'SC02', query: 'cheese pizza',        expected_top: 'Cheese Pizza' },
  { id: 'SC03', query: 'pepperoni pizza',     expected_top: 'Pepperoni Pizza' },
  { id: 'SC04', query: 'cheese slice',        expected_top: 'Cheese Slice' },
  { id: 'SC05', query: 'caesar salad',        expected_top: 'Caesar Salad' },
  { id: 'SC06', query: 'mozzarella sticks',   expected_top: 'Mozzarella Sticks' },
  { id: 'SC07', query: 'calzone',             expected_top: 'Calzone' },
  { id: 'SC08', query: 'garlic bread',        expected_top: 'Garlic Bread' },
  { id: 'SC09', query: 'garlic knots',        expected_top: 'Garlic Knots' },
  { id: 'SC10', query: 'chicken wings',       expected_top: 'Chicken Wings' },
  { id: 'SC11', query: 'baked ziti',          expected_top: 'Baked Ziti' },
  // Alias normalization
  { id: 'SC12', query: 'cheese pie',          expected_top: 'Cheese Pizza' },
  { id: 'SC13', query: 'chicken parm',         expected_top: 'Chicken Parm Hero' }, // "parm" partial-matches "parmigiana"; clarification expected between Parm Hero and Parmigiana
  { id: 'SC14', query: 'chicken parm hero',   expected_top: 'Chicken Parm Hero' },
  // Disambiguation — top two should be within 15 points (clarification_needed true)
  { id: 'SC15', query: 'margherita',          expected_top: 'Margherita Pizza' },  // tied — clarification expected
  // Extra-word penalty working
  { id: 'SC16', query: 'four cheese pizza',   expected_top: 'Four Cheese Pizza' },
  { id: 'SC17', query: 'white pizza',         expected_top: 'White Pizza' },
  { id: 'SC18', query: 'buffalo chicken pizza', expected_top: 'Buffalo Chicken Pizza' },
  { id: 'SC19', query: 'fountain soda',       expected_top: 'Fountain Soda' },
  { id: 'SC20', query: 'new york cheesecake', expected_top: 'New York Cheesecake' },
  { id: 'SC21', query: 'italian cheesecake',  expected_top: 'Italian Cheesecake' },
  { id: 'SC22', query: 'grandma slice',       expected_top: 'Grandma Slice' },
  { id: 'SC23', query: 'philly cheesesteak',  expected_top: 'Philly Cheesesteak' },
  { id: 'SC24', query: 'stromboli',           expected_top: 'Stromboli' },
  { id: 'SC25', query: 'tiramisu',            expected_top: 'Tiramisu' },
];

const EMBEDDING_SPOT_CHECKS = [
  { id: '01', query: 'something cold to drink',  expected_note: 'Should fail primary, secondary might find Drinks category items' },
  { id: '02', query: 'vegetarian option',         expected_note: 'Should fail primary, secondary might find Veggie Lovers Pizza' },
  { id: '03', query: 'gluten free',               expected_note: 'Should fail primary (no item named "gluten free"), secondary should find items with Gluten Free crust option' },
  { id: '04', query: 'spicy food',                expected_note: 'Should fail primary, secondary might find jalapeno-related items' },
  { id: '05', query: 'club sandwich',             expected_note: "Should match Turkey Club Hero via 'club' token" },
];

// ─── MAIN ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\nRestaurant: ${restaurantConfig.restaurantInfo.name} (${restaurantConfig.restaurantInfo.version})`);
  console.log(`Menu: ${path.basename(restaurantConfig.menuFile)}`);

  if (mode === 'conversation') {
    await runConversationTests();
  } else {
    runEngineTests();
  }
})();
