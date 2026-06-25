'use strict';

const path = require('path');

module.exports = {
  restaurantInfo: {
    name: 'The Pizza Place',
    location: 'Lakewood, NJ',
    pickupHours: 'Sunday-Wednesday 10:45am-7pm, Thursday 10:45am-8pm, Friday 10:45am-1:45pm, Saturday closed (opens post-Shabbos around 9:30pm)',
    deliveryHours: 'Sunday-Wednesday 10:45am-7pm, Thursday 10:45am-8pm, Friday 10:45am-1:45pm',
    orderTypes: ['pickup', 'delivery'],
    deliveryMinimum: 15.00,
    deliveryRadiusMiles: 5,
    version: 'Bravo',
  },

  menuFile: path.join(__dirname, '../../menus/pizza_place_lakewood.json'),

  cateringItemIds: [],

  specialTerminology: `
    pie = pizza pie
    plain pie = regular pie (cheese pizza)
    sicilian = square deep dish pizza
    grandma = square pie with pesto and marinara
    stromboli = eggplant stromboli calzone
    ziti = baked ziti pasta
    vodka = penne alla vodka
    parm = eggplant parmesan
    knots = garlic knots
    mozz sticks = mozzarella sticks
    whole wheat = whole wheat dough
    gluten free = gluten free crust
  `,

  faqKnowledgeBase: `
    We are a kosher establishment under reliable hashgacha.
    Hours: Sunday-Wednesday 10:45am-7pm, Thursday 10:45am-8pm, Friday 10:45am-1:45pm, Saturday closed (opens post-Shabbos around 9:30pm).
    Delivery minimum: $15.00.
    Gluten free pies are available (made with potato starch, 8 inch).
    Whole wheat dough is available.
    Cream cheese rolls available Thursdays only.
    Allergens: please inform us of any allergies.
  `,

  storeSpecificInstructions: `
    CREAM CHEESE ROLL: Only available on Thursdays. If customer orders on another day, let them know.

    SICILIAN PIE: Currently unavailable (marked out of stock). Suggest regular pie or grandma pie instead.

    CATERING PANS: Catering items (9x13 pans) are large orders. Confirm the customer intends to order a full pan.

    DELIVERY ORDERS: Always capture the full delivery address before finalizing.

    CUSTOM PIES: When customer wants a custom veggie pie, ask which vegetables they want (up to 6 toppings).
  `,
};
