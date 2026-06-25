'use strict';

const path = require('path');

module.exports = {
  restaurantInfo: {
    name: 'Hot Bagels 2nd Street',
    location: 'Lakewood, NJ',
    pickupHours: 'Sunday-Thursday 6am-6pm, Friday 6am-2pm',
    deliveryHours: 'Sunday-Thursday 6am-6pm, Friday 6am-2pm',
    orderTypes: ['pickup', 'delivery'],
    deliveryMinimum: 15.00,
    deliveryRadiusMiles: 5,
    version: 'Bravo',
  },

  menuFile: path.join(__dirname, '../../menus/hot_bagels.json'),

  cateringItemIds: [],

  specialTerminology: `
    schmear = cream cheese
    lox = smoked salmon
    nova = smoked salmon
    everything = everything bagel
    sesame = sesame bagel
    plain = plain bagel
    whole wheat = whole wheat bagel
    pumpernickel = pumpernickel bagel
    egg = egg bagel
    onion = onion bagel
    garlic = garlic bagel
    rye = rye bread
    bourekas = bourekas (savory pastry)
    barakas = bourekas
    tofu = tofu scramble
  `,

  faqKnowledgeBase: `
    We are a kosher establishment under reliable hashgacha.
    All products are kosher certified.
    Hours: Sunday-Thursday 6am-6pm, Friday 6am-2pm. Closed Saturday.
    Delivery minimum: $15.00.
    We offer fresh-baked bagels, sandwiches, salads, soups, pastries, and specialty beverages.
    Allergens: please inform us of any allergies. We cannot guarantee allergen-free preparation.
  `,

  storeSpecificInstructions: `
    KOSHER: This is a kosher restaurant. Do not suggest non-kosher combinations.
    Do not suggest meat and dairy together.

    BAGEL ORDERS: When a customer orders a bagel sandwich, always confirm the bagel type
    (plain, everything, sesame, etc.) if not specified.

    CATERING: Catering platters require advance notice. Confirm timing with the customer.

    DELIVERY ORDERS: Always capture the full delivery address before finalizing.
  `,
};
