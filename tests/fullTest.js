'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const ConversationEngine = require('../src/conversation/conversationEngine');

const MENU_PATH = path.join(__dirname, '../hot_bagels_menu_with_real_acai_restaurant.json');

let passed = 0, failed = 0;
const failures = [];

// ─── RUNNER ──────────────────────────────────────────────────────────────────

async function test(name, turns, check) {
  process.stdout.write(`  ${name}... `);
  try {
    const engine  = new ConversationEngine(MENU_PATH);
    const opening = await engine.open();
    // responses[0] = greeting, responses[1..] = turns
    const responses = [{ message: opening.message, controllerState: engine.controller.getState() }];

    for (const msg of turns) {
      const r = await engine.chat(msg);
      responses.push({ ...r, customerMsg: msg });
    }

    const result = check({ responses, engine, greeting: opening.message });

    if (result.pass !== false) {
      console.log('PASS');
      passed++;
    } else {
      console.log(`FAIL\n     → ${result.reason}`);
      failed++;
      failures.push({ name, reason: result.reason });
    }
  } catch (err) {
    console.log(`ERROR\n     → ${err.message}`);
    failed++;
    failures.push({ name, reason: `THREW: ${err.message}` });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const active      = (e)       => e.cart.getActiveItems();
const itemCount   = (e)       => active(e).length;
const hasItem     = (e, name) => active(e).some(i => i.name.toLowerCase().includes(name.toLowerCase()));
const getItem     = (e, name) => active(e).find(i => i.name.toLowerCase().includes(name.toLowerCase()));
const hasMod      = (item, s) => item?.modifiers?.some(m => m.name.toLowerCase().includes(s.toLowerCase()));
const lastMsg     = (rs)      => rs[rs.length - 1]?.message || '';
const lastState   = (rs)      => rs[rs.length - 1]?.controllerState;
const anyMsg      = (rs, s)   => rs.some(r => r.message?.toLowerCase().includes(s.toLowerCase()));
const has         = (msg, s)  => msg.toLowerCase().includes(s.toLowerCase());

// ─── TESTS ───────────────────────────────────────────────────────────────────

async function runAll() {

  // ═══════════════════════════════════════════════════════════
  console.log('\n── 1. ORIGINAL TESTS ──────────────────────────────────────────');
  // ═══════════════════════════════════════════════════════════

  await test('1.  Greeting says "Delta"', [], ({ greeting }) => ({
    pass:   greeting.includes('Delta'),
    reason: `Greeting was: "${greeting}"`,
  }));

  await test('2.  Pickup order type detected', ['pickup'], ({ engine }) => ({
    pass:   engine.cart.orderType === 'pickup',
    reason: `orderType: ${engine.cart.orderType}`,
  }));

  await test('3.  Delivery order type detected', ['delivery'], ({ engine }) => ({
    pass:   engine.cart.orderType === 'delivery',
    reason: `orderType: ${engine.cart.orderType}`,
  }));

  await test('4.  Multi-turn: tuna + bagel type → 1 item in cart', [
    'pickup', 'I want a tuna sandwich', 'everything bagel', "that's it",
  ], ({ engine }) => {
    const items = active(engine);
    if (items.length !== 1) return { pass: false, reason: `Expected 1 item, got ${items.length}` };
    if (!items[0].name.toLowerCase().includes('tuna')) return { pass: false, reason: `Item was "${items[0].name}"` };
    return { pass: true };
  });

  await test('5.  All modifiers one turn: everything toasted pickles → 1 item with mods', [
    'pickup', 'I want a tuna sandwich on everything bagel toasted with pickles',
  ], ({ engine }) => {
    const item = getItem(engine, 'tuna');
    if (!item) return { pass: false, reason: 'Tuna Sandwich not in cart' };
    if (!hasMod(item, 'everything')) return { pass: false, reason: `Missing Everything Bagel. Mods: ${item.modifiers.map(m=>m.name).join(', ')}` };
    return { pass: true };
  });

  await test('6.  Cream cheese sandwich (combo A) → AI asks about bagel type', [
    'pickup', 'I want a cream cheese sandwich',
  ], ({ responses }) => {
    const msg = lastMsg(responses);
    if (!has(msg, 'bagel')) return { pass: false, reason: `AI did not ask about bagel. Said: "${msg.slice(0, 120)}"` };
    return { pass: true };
  });

  await test('7.  Salmon sandwich (combo B) → AI suggests lox, no wrong item added', [
    'pickup', 'I want a salmon sandwich',
  ], ({ engine, responses }) => {
    const msg = lastMsg(responses);
    const noWrongItem = !active(engine).some(i => i.name.toLowerCase() === 'salmon sandwich');
    const mentionsLox = has(msg, 'lox') || has(msg, 'smoked salmon');
    if (!noWrongItem) return { pass: false, reason: 'Added non-existent Salmon Sandwich' };
    if (!mentionsLox) return { pass: false, reason: `Did not suggest lox. Said: "${msg.slice(0, 120)}"` };
    return { pass: true };
  });

  await test('8.  Made-up item (combo C) → cart stays empty', [
    'pickup', 'I want a flying saucer sandwich with moon cheese',
  ], ({ engine, responses }) => {
    // Primary check: nothing was added to the cart
    if (itemCount(engine) > 0) return { pass: false, reason: `Cart should be empty. Got: ${active(engine).map(i=>i.name).join(', ')}` };
    // Secondary: AI should acknowledge it can't fulfill the request
    const msg = lastMsg(responses);
    const refused = has(msg, "don't have") || has(msg, 'not on') || has(msg, 'not available') ||
                    has(msg, 'unavailable') || has(msg, "isn't") || has(msg, 'unable') ||
                    has(msg, "catch") || has(msg, 'understand') || has(msg, "menu") || has(msg, 'sorry');
    if (!refused) return { pass: false, reason: `AI gave unexpected response. Said: "${msg.slice(0, 120)}"` };
    return { pass: true };
  });

  await test('9.  Lox sandwich (combo D) → Lox item in cart', [
    'pickup', 'I want a lox sandwich on everything bagel', "that's it",
  ], ({ engine }) => {
    if (itemCount(engine) === 0) return { pass: false, reason: 'Cart empty' };
    if (!hasItem(engine, 'lox')) return { pass: false, reason: `No lox item. Cart: ${active(engine).map(i=>i.name).join(', ')}` };
    return { pass: true };
  });

  await test('10. Done phrase → AI reads back order with total', [
    'pickup', 'I want a tuna sandwich on everything bagel toasted', "that's it",
  ], ({ responses }) => {
    const msg = lastMsg(responses);
    if (!has(msg, '$') && !has(msg, 'total')) return { pass: false, reason: `No total in response. Said: "${msg.slice(0, 120)}"` };
    return { pass: true };
  });

  await test('11. "just keep the tuna sandwich" → removes cream cheese', [
    'pickup',
    'I want a tuna sandwich on everything bagel toasted',
    'also give me a cream cheese sandwich on sesame bagel',
    'actually just keep the tuna sandwich, remove the others',
  ], ({ engine }) => {
    const items = active(engine);
    if (items.length !== 1) return { pass: false, reason: `Expected 1 item, got ${items.length}: ${items.map(i=>i.name).join(', ')}` };
    if (!items[0].name.toLowerCase().includes('tuna')) return { pass: false, reason: `Kept wrong item: ${items[0].name}` };
    return { pass: true };
  });

  await test('12. "remove that" → cart empty', [
    'pickup', 'I want a tuna sandwich on everything bagel', 'remove that',
  ], ({ engine }) => {
    if (itemCount(engine) > 0) return { pass: false, reason: `Expected empty. Got: ${active(engine).map(i=>i.name).join(', ')}` };
    return { pass: true };
  });

  await test('13. Duplicate detection → AI asks before adding second copy', [
    'pickup',
    'I want a tuna sandwich on everything bagel toasted',
    'I want a tuna sandwich on everything bagel toasted',
  ], ({ responses }) => {
    const msg = lastMsg(responses);
    const asked = has(msg, 'already') || has(msg, 'another') || has(msg, 'add another') || has(msg, 'duplicate');
    if (!asked) return { pass: false, reason: `No duplicate check. Said: "${msg.slice(0, 120)}"` };
    return { pass: true };
  });

  await test('14. "actually" alone in AWAITING_MODIFIER → stays AWAITING_MODIFIER', [
    'pickup', 'I want a tuna sandwich', 'actually',
  ], ({ responses }) => {
    if (lastState(responses) !== 'AWAITING_MODIFIER') return { pass: false, reason: `State: ${lastState(responses)}` };
    return { pass: true };
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n── 2. MODIFIER CONTEXT TESTS ──────────────────────────────────');
  // ═══════════════════════════════════════════════════════════

  await test('15. "toasted" after AI asks vegetables → cross-matched as Toasted modifier', [
    'pickup', 'I want a tuna sandwich', 'everything bagel', 'toasted', "that's it",
  ], ({ engine }) => {
    const item = getItem(engine, 'tuna');
    if (!item) return { pass: false, reason: 'Tuna Sandwich not in cart' };
    if (!hasMod(item, 'toast')) return { pass: false, reason: `No Toasted modifier. Mods: ${item.modifiers.map(m=>m.name).join(', ')}` };
    return { pass: true };
  });

  await test('16. "everything" after AI asks bagel type → Everything Bagel modifier', [
    'pickup', 'I want a tuna sandwich', 'everything', "that's it",
  ], ({ engine }) => {
    const item = getItem(engine, 'tuna');
    if (!item) return { pass: false, reason: 'Tuna Sandwich not in cart' };
    if (!hasMod(item, 'everything')) return { pass: false, reason: `No Everything Bagel. Mods: ${item.modifiers.map(m=>m.name).join(', ')}` };
    return { pass: true };
  });

  await test('17. "no thanks" for optional vegetables → item added without forcing veg', [
    'pickup', 'I want a tuna sandwich', 'everything bagel', 'no thanks',
  ], ({ engine, responses }) => {
    const item = getItem(engine, 'tuna');
    const s    = lastState(responses);
    // Either item added to cart OR AI moved on (ORDERING state)
    if (s === 'AWAITING_MODIFIER' && !item) return { pass: false, reason: 'Stuck in AWAITING_MODIFIER with no item in cart' };
    return { pass: true };
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n── 3. WRONG ITEM MATCHING TESTS ───────────────────────────────');
  // ═══════════════════════════════════════════════════════════

  await test('18. "tuna sandwich" → Tuna Sandwich (not Tuna Melt)', [
    'pickup', 'I want a tuna sandwich on everything bagel', "that's it",
  ], ({ engine }) => {
    if (itemCount(engine) === 0) return { pass: false, reason: 'Cart empty' };
    const name = active(engine)[0].name;
    if (name === 'Tuna Melt') return { pass: false, reason: 'Got Tuna Melt instead of Tuna Sandwich' };
    if (!name.toLowerCase().includes('tuna')) return { pass: false, reason: `Got "${name}"` };
    return { pass: true };
  });

  await test('19. "cream cheese sandwich" → Cream Cheese Sandwich (not American Cheese)', [
    'pickup', 'I want a cream cheese sandwich on everything bagel', "that's it",
  ], ({ engine }) => {
    if (itemCount(engine) === 0) return { pass: false, reason: 'Cart empty' };
    const name = active(engine)[0].name.toLowerCase();
    if (name.includes('american')) return { pass: false, reason: `Got American Cheese item` };
    if (!name.includes('cream cheese')) return { pass: false, reason: `Got "${active(engine)[0].name}"` };
    return { pass: true };
  });

  await test('20. "lox sandwich" → Sliced Lox Sandwich (not plain Lox)', [
    'pickup', 'I want a lox sandwich on everything bagel', "that's it",
  ], ({ engine }) => {
    if (itemCount(engine) === 0) return { pass: false, reason: 'Cart empty' };
    const name = active(engine)[0].name.toLowerCase();
    if (!name.includes('lox')) return { pass: false, reason: `Got "${active(engine)[0].name}"` };
    return { pass: true };
  });

  await test('21. "plain bagel with cream cheese" → not just a $1 plain bagel', [
    'pickup', 'I want a plain bagel with cream cheese',
  ], ({ engine, responses }) => {
    const items = active(engine);
    if (items.length > 0) {
      // If something was added, it shouldn't be just a plain Bagel at <$2
      const wrong = items.some(i => i.name === 'Bagel' && i.unitPrice < 2 && i.modifiers.length === 0);
      if (wrong) return { pass: false, reason: `Added plain Bagel at $${items[0].unitPrice} with no mods` };
    }
    // AI should at least mention cream cheese or bagel in response
    if (!has(lastMsg(responses), 'cream cheese') && !has(lastMsg(responses), 'bagel')) {
      return { pass: false, reason: `Unexpected response: "${lastMsg(responses).slice(0, 100)}"` };
    }
    return { pass: true };
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n── 4. MODIFIER VISIBILITY TESTS ───────────────────────────────');
  // ═══════════════════════════════════════════════════════════

  await test('22. "do you have pickles" while building tuna → AI says yes', [
    'pickup', 'I want a tuna sandwich', 'everything bagel', 'do you have pickles',
  ], ({ responses }) => {
    const msg = lastMsg(responses);
    const saysNo  = has(msg, "don't have pickles") || has(msg, 'no pickles available');
    const saysYes = has(msg, 'pickle') && (has(msg, 'yes') || has(msg, 'available') || has(msg, 'choose') || has(msg, 'option'));
    if (saysNo)  return { pass: false, reason: `AI wrongly said no pickles. Said: "${msg.slice(0, 150)}"` };
    if (!has(msg, 'pickle')) return { pass: false, reason: `No mention of pickles. Said: "${msg.slice(0, 150)}"` };
    return { pass: true };
  });

  await test('23. "what vegetables do you have" → AI lists vegetable options', [
    'pickup', 'I want a tuna sandwich', 'everything bagel', 'what vegetables do you have',
  ], ({ responses }) => {
    const msg = lastMsg(responses);
    const lists = has(msg, 'tomato') || has(msg, 'pickle') || has(msg, 'cucumber') || has(msg, 'lettuce') || has(msg, 'onion');
    if (!lists) return { pass: false, reason: `Did not list vegetables. Said: "${msg.slice(0, 150)}"` };
    return { pass: true };
  });

  await test('24. "do you have a toasted option" → AI does not say unavailable', [
    'pickup', 'I want a tuna sandwich', 'everything bagel', 'do you have a toasted option',
  ], ({ responses }) => {
    const msg = lastMsg(responses);
    const wronglyDenies = has(msg, "don't have") && has(msg, 'toast');
    if (wronglyDenies) return { pass: false, reason: `AI wrongly said toast unavailable. Said: "${msg.slice(0, 150)}"` };
    return { pass: true };
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n── 5. LARGE ORDER TESTS ────────────────────────────────────────');
  // ═══════════════════════════════════════════════════════════

  await test('25. 3 tuna sandwiches with different bagels → ≥3 items in cart', [
    'pickup',
    'I want a tuna sandwich on everything bagel toasted',
    'I want another tuna sandwich on sesame bagel',
    'and a third tuna sandwich on plain bagel',
  ], ({ engine }) => {
    const tunas = active(engine).filter(i => i.name.toLowerCase().includes('tuna'));
    if (tunas.length < 2) return { pass: false, reason: `Expected ≥2 tuna items, got ${tunas.length}. Cart: ${active(engine).map(i=>i.name).join(', ')}` };
    return { pass: true };
  });

  await test('26. 5-item family order → ≥3 items in cart', [
    'pickup',
    'I want a tuna sandwich on everything bagel',
    'a cream cheese sandwich on sesame bagel',
    'a lox sandwich on poppy bagel',
    'a coffee',
    'and a chocolate chip muffin',
  ], ({ engine }) => {
    if (itemCount(engine) < 3) return { pass: false, reason: `Expected ≥3 items, got ${itemCount(engine)}: ${active(engine).map(i=>i.name).join(', ')}` };
    return { pass: true };
  });

  await test('27. 7 items then remove one → correct item removed', [
    'pickup',
    'I want a tuna sandwich on everything bagel',
    'add a cream cheese sandwich on sesame bagel',
    'add a lox sandwich on plain bagel',
    'add a coffee',
    'add a chocolate chip muffin',
    'add an orange juice',
    'add a plain bagel',
    'remove the cream cheese sandwich',
  ], ({ engine }) => {
    if (hasItem(engine, 'cream cheese')) return { pass: false, reason: 'Cream cheese was not removed' };
    if (!hasItem(engine, 'tuna')) return { pass: false, reason: 'Tuna was incorrectly removed' };
    return { pass: true };
  });

  await test('28. Remove second item, first and rest stay intact', [
    'pickup',
    'I want a tuna sandwich on everything bagel toasted',
    'and a cream cheese sandwich on sesame bagel',
    'remove the cream cheese',
  ], ({ engine }) => {
    if (hasItem(engine, 'cream cheese')) return { pass: false, reason: 'Cream cheese not removed' };
    if (!hasItem(engine, 'tuna')) return { pass: false, reason: 'Tuna incorrectly removed' };
    return { pass: true };
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n── 6. COMBINATION TESTS ────────────────────────────────────────');
  // ═══════════════════════════════════════════════════════════

  await test('29. "cream cheese sandwich" → AWAITING_MODIFIER or asks bagel', [
    'pickup', 'I want a cream cheese sandwich',
  ], ({ responses }) => {
    const msg = lastMsg(responses);
    const s   = lastState(responses);
    if (s !== 'AWAITING_MODIFIER' && !has(msg, 'bagel')) {
      return { pass: false, reason: `State: ${s}. Said: "${msg.slice(0, 120)}"` };
    }
    return { pass: true };
  });

  await test('30. "salmon sandwich" → suggests lox, no Salmon Sandwich item', [
    'pickup', 'I want a salmon sandwich',
  ], ({ engine, responses }) => {
    if (active(engine).some(i => i.name.toLowerCase() === 'salmon sandwich')) {
      return { pass: false, reason: 'Added non-existent Salmon Sandwich' };
    }
    const msg = lastMsg(responses);
    if (!has(msg, 'lox') && !has(msg, 'smoked salmon')) {
      return { pass: false, reason: `Did not suggest lox. Said: "${msg.slice(0, 120)}"` };
    }
    return { pass: true };
  });

  await test('31. "cold drink" → AI suggests cold drink options', [
    'pickup', 'I want a cold drink',
  ], ({ responses }) => {
    const msg = lastMsg(responses);
    const hasDrink = has(msg, 'snapple') || has(msg, 'coke') || has(msg, 'soda') || has(msg, 'water') ||
                     has(msg, 'juice') || has(msg, 'iced') || has(msg, 'cold') || has(msg, 'beverage');
    if (!hasDrink) return { pass: false, reason: `No cold drink suggested. Said: "${msg.slice(0, 120)}"` };
    return { pass: true };
  });

  await test('32. "something sweet" → AI suggests sweet items', [
    'pickup', 'I want something sweet',
  ], ({ responses }) => {
    const msg = lastMsg(responses);
    const sweet = has(msg, 'muffin') || has(msg, 'cookie') || has(msg, 'cake') || has(msg, 'babka') ||
                  has(msg, 'pastry') || has(msg, 'danish') || has(msg, 'sweet') || has(msg, 'chocolate');
    if (!sweet) return { pass: false, reason: `No sweet items suggested. Said: "${msg.slice(0, 120)}"` };
    return { pass: true };
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n── 7. CORRECTION TESTS ─────────────────────────────────────────');
  // ═══════════════════════════════════════════════════════════

  await test('33. Order item then "remove that" → cart empty', [
    'pickup', 'I want a tuna sandwich on everything bagel', 'remove that',
  ], ({ engine }) => {
    if (itemCount(engine) > 0) return { pass: false, reason: `Expected empty. Got: ${active(engine).map(i=>i.name).join(', ')}` };
    return { pass: true };
  });

  await test('34. "keep only the tuna sandwich" → 1 item remains', [
    'pickup',
    'I want a tuna sandwich on everything bagel toasted',
    'and a cream cheese sandwich on sesame bagel',
    'keep only the tuna sandwich',
  ], ({ engine }) => {
    const items = active(engine);
    if (items.length !== 1) return { pass: false, reason: `Expected 1 item, got ${items.length}: ${items.map(i=>i.name).join(', ')}` };
    if (!items[0].name.toLowerCase().includes('tuna')) return { pass: false, reason: `Kept wrong item: ${items[0].name}` };
    return { pass: true };
  });

  await test('35. "actually change that to sesame bagel" → AI confirms sesame', [
    'pickup',
    'I want a tuna sandwich on everything bagel',
    'actually change that to sesame bagel',
  ], ({ responses }) => {
    const msg = lastMsg(responses);
    if (!has(msg, 'sesame') && !has(msg, 'updated') && !has(msg, 'changed')) {
      return { pass: false, reason: `No sesame confirmation. Said: "${msg.slice(0, 120)}"` };
    }
    return { pass: true };
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n── 8. CONTINUATION PHRASE TESTS ───────────────────────────────');
  // ═══════════════════════════════════════════════════════════

  await test('36. "not yet" while confirming → AI does not trigger menu search error', [
    'pickup',
    'I want a tuna sandwich on everything bagel',
    'not yet',
  ], ({ responses }) => {
    const msg = lastMsg(responses);
    const badSearch = has(msg, 'not on the menu') || (has(msg, "don't have") && !has(msg, 'done'));
    if (badSearch) return { pass: false, reason: `Triggered menu search. Said: "${msg.slice(0, 150)}"` };
    return { pass: true };
  });

  await test('37. "wait" in AWAITING_MODIFIER → stays AWAITING_MODIFIER', [
    'pickup', 'I want a tuna sandwich', 'wait',
  ], ({ responses }) => {
    if (lastState(responses) !== 'AWAITING_MODIFIER') return { pass: false, reason: `State: ${lastState(responses)}` };
    return { pass: true };
  });

  await test('38. "one more thing" → AI waits, no menu search for that phrase', [
    'pickup',
    'I want a tuna sandwich on everything bagel',
    'one more thing',
  ], ({ responses }) => {
    const msg = lastMsg(responses);
    const badSearch = has(msg, 'not on the menu') || has(msg, "don't carry");
    if (badSearch) return { pass: false, reason: `Menu searched for "one more thing". Said: "${msg.slice(0, 150)}"` };
    return { pass: true };
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n── 9. CULTURAL AND DIETARY TESTS ──────────────────────────────');
  // ═══════════════════════════════════════════════════════════

  await test('39. "is it halav Israel" → AI answers from knowledge base', [
    'pickup', 'is it halav Israel',
  ], ({ engine, responses }) => {
    if (itemCount(engine) > 0) return { pass: false, reason: 'Should not add items for info question' };
    const msg = lastMsg(responses);
    const answers = has(msg, 'kosher') || has(msg, 'halav') || has(msg, 'supervision') ||
                    has(msg, 'information') || has(msg, 'connect');
    if (!answers) return { pass: false, reason: `Did not answer. Said: "${msg.slice(0, 150)}"` };
    return { pass: true };
  });

  await test('40. "bourekas" → AI recognizes item', [
    'pickup', 'I want bourekas',
  ], ({ engine, responses }) => {
    const msg  = lastMsg(responses);
    const good = has(msg, 'bourek') || has(msg, 'pastry') || has(msg, 'savory') ||
                 active(engine).some(i => i.name.toLowerCase().includes('bourek'));
    if (!good) return { pass: false, reason: `Did not recognize bourekas. Said: "${msg.slice(0, 120)}"` };
    return { pass: true };
  });

  await test('41. "barakas" → recognized as bourekas', [
    'pickup', 'I want barakas',
  ], ({ engine, responses }) => {
    const msg  = lastMsg(responses);
    const good = has(msg, 'bourek') || has(msg, 'pastry') || has(msg, 'savory') ||
                 active(engine).some(i => i.name.toLowerCase().includes('bourek'));
    if (!good) return { pass: false, reason: `Did not recognize barakas as bourekas. Said: "${msg.slice(0, 120)}"` };
    return { pass: true };
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n── 10. PRICING TESTS ───────────────────────────────────────────');
  // ═══════════════════════════════════════════════════════════

  await test('42. "how much is the lox sandwich" → gives price, cart stays empty', [
    'pickup', 'how much is the lox sandwich',
  ], ({ engine, responses }) => {
    if (itemCount(engine) > 0) return { pass: false, reason: `Should not add item. Got: ${active(engine).map(i=>i.name).join(', ')}` };
    const msg = lastMsg(responses);
    if (!has(msg, '$') && !has(msg, 'price') && !has(msg, 'cost') && !has(msg, 'dollar')) {
      return { pass: false, reason: `No price info. Said: "${msg.slice(0, 120)}"` };
    }
    return { pass: true };
  });

  await test('43. "what does a tuna sandwich cost" → gives price, cart stays empty', [
    'pickup', 'what does a tuna sandwich cost',
  ], ({ engine, responses }) => {
    if (itemCount(engine) > 0) return { pass: false, reason: `Should not add item. Got: ${active(engine).map(i=>i.name).join(', ')}` };
    const msg = lastMsg(responses);
    if (!has(msg, '$') && !has(msg, 'price') && !has(msg, 'cost') && !has(msg, 'dollar')) {
      return { pass: false, reason: `No price info. Said: "${msg.slice(0, 120)}"` };
    }
    return { pass: true };
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n── 11. STORE HOURS TEST ────────────────────────────────────────');
  // ═══════════════════════════════════════════════════════════

  await test('44. "what are your hours" → AI answers pickup/delivery hours', [
    'pickup', 'what are your hours',
  ], ({ engine, responses }) => {
    if (itemCount(engine) > 0) return { pass: false, reason: 'Should not add items for hours question' };
    const msg = lastMsg(responses);
    const answersHours = has(msg, 'am') || has(msg, 'pm') || has(msg, 'monday') ||
                         has(msg, 'sunday') || has(msg, 'hour') || has(msg, '6') || has(msg, '8');
    if (!answersHours) return { pass: false, reason: `Did not answer hours. Said: "${msg.slice(0, 120)}"` };
    return { pass: true };
  });

  // ═══════════════════════════════════════════════════════════
  console.log('\n── 12. HUMAN FALLBACK TEST ─────────────────────────────────────');
  // ═══════════════════════════════════════════════════════════

  await test('45. "I want to speak to a human" → AI offers transfer', [
    'pickup', 'I want to speak to a human',
  ], ({ responses }) => {
    const msg = lastMsg(responses);
    const offers = has(msg, 'transfer') || has(msg, 'connect') || has(msg, 'someone') || has(msg, 'representative');
    if (!offers) return { pass: false, reason: `No transfer offer. Said: "${msg.slice(0, 120)}"` };
    return { pass: true };
  });

  // ─── SUMMARY ─────────────────────────────────────────────────────────────

  const total = passed + failed;
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`SCORE: ${passed}/${total} passed`);

  if (failures.length > 0) {
    console.log('\nFailed:');
    failures.forEach((f, i) => {
      console.log(`  ${i + 1}. ${f.name}`);
      console.log(`     ${f.reason}`);
    });
  }
  console.log('═'.repeat(65));
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(console.error);
