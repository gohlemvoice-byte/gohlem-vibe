require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path = require('path');
const ConversationEngine = require('../src/conversation/conversationEngine');
const MENU = path.join(__dirname, '../hot_bagels_menu_with_real_acai_restaurant.json');

async function run() {
  const engine = new ConversationEngine(MENU);

  const turns = [
    'Pickup',
    'I want three tuna sandwiches, one on everything bagel toasted, one on sesame not toasted, one on poppy with tomatoes and cream cheese',
    "Yes that's right",
    'Also two scrambled egg sandwiches, both on plain bagel toasted',
    'Yes',
    'And a large coffee',
    "That's it",
  ];

  const greeting = await engine.open();
  console.log('Gohlem: ' + greeting.message);

  for (const msg of turns) {
    console.log('\nCustomer: ' + msg);
    const r = await engine.chat(msg);
    console.log('Gohlem:   ' + r.message);

    if (r.actionResults.length) {
      r.actionResults.forEach((a, i) => {
        const act = r.actions[i];
        const ok = a.ok ? '✓' : '✗';
        const detail = a.cartItemId ? ' → ' + a.cartItemId : a.error ? ' → ERROR: ' + a.error : '';
        const mods = act.modifiers && act.modifiers.length
          ? ' [' + act.modifiers.map(m => m.action + ':' + m.name).join(', ') + ']'
          : '';
        const qty = act.quantity && act.quantity > 1 ? ' qty:' + act.quantity : '';
        console.log('  [' + ok + '] ' + act.type + (act.name ? ' "' + act.name + '"' : '') + qty + mods + detail);
      });
    }
  }

  const order = engine.cart.getOrder();

  console.log('\n' + '='.repeat(65));
  console.log('COMPLETE ORDER OBJECT');
  console.log('='.repeat(65));
  console.log(JSON.stringify(order, null, 2));

  console.log('\n' + '='.repeat(65));
  console.log('CART SUMMARY: ' + order.items.length + ' items | Total: $' + order.total.toFixed(2));
  console.log('='.repeat(65));
  order.items.forEach((item, n) => {
    const mods = item.modifiers.map(m => m.name).join(', ');
    const instr = item.specialInstructions ? ' | note: ' + item.specialInstructions : '';
    console.log(
      '  ' + (n + 1) + '. ' + item.name +
      ' x' + item.quantity +
      ' $' + item.unitPrice.toFixed(2) +
      (mods ? ' | ' + mods : '') +
      instr
    );
  });
  console.log('='.repeat(65));
}

run().catch(console.error);
