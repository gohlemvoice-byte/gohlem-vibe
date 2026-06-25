'use strict';

const path = require('path');

module.exports = {
  restaurantInfo: {
    name: "Tony's Brick Oven Pizzeria",
    location: 'Anytown',
    pickupHours: 'Monday-Thursday 11am-10pm, Friday-Saturday 11am-11pm, Sunday 12pm-9pm',
    deliveryHours: 'Monday-Thursday 11am-10pm, Friday-Saturday 11am-11pm, Sunday 12pm-9pm',
    orderTypes: ['pickup', 'delivery'],
    deliveryMinimum: 15.00,
    deliveryRadiusMiles: 5,
    version: 'Bravo',
  },

  menuFile: path.join(__dirname, '../../menus/tonys_pizzeria.json'),

  // Items in the Catering category require 24-48 hour advance notice.
  // toolHandler checks the category name "Catering" directly on the menu item.
  // This list is here for reference; the enforcement uses item.category === 'Catering'.
  cateringItemIds: [
    'item_824429', // Party Pizza Tray
    'item_216559', // Pasta Catering Tray
    'item_843165', // Wing Party Pack 50
    'item_951724', // Hero Party Platter
    'item_447556', // Salad Catering Bowl
  ],

  specialTerminology: `
    pie = pizza
    hero / sub / hoagie / grinder = hero sandwich
    wings = chicken wings
    plain / regular = cheese (as in "plain pizza" = cheese pizza, "plain slice" = cheese slice)
    philly = philly cheesesteak hero
    sicilian = square pizza
    grandma = grandma square pizza
    ziti = baked ziti
    parm / parmigiana = parmesan (as in chicken parm = chicken parmesan)
    stromboli = rolled sandwich
    zeppoles = fried dough dessert
    cannoli = Italian pastry dessert
  `,

  faqKnowledgeBase: `
    Gluten free crust: available on pizzas (+$4.00). Gluten free penne: available for pasta (+$3.00). Gluten free roll: available for heroes (+$3.00).
    Cauliflower crust: available on pizzas (+$4.50).
    Delivery minimum: $15.00. Delivery radius: 5 miles.
    Catering: all catering trays require 24-48 hours advance notice. We do not accept same-day catering orders.
    We are not a kosher establishment.
    Allergens: we cannot guarantee allergen-free preparation. Please inform us of allergies.
    Hours: Monday-Thursday 11am-10pm, Friday-Saturday 11am-11pm, Sunday 12pm-9pm.
  `,

  storeSpecificInstructions: `
    CATERING (24-48 hour advance notice required — never accept same-day):
    Party Pizza Tray, Pasta Catering Tray, Wing Party Pack 50, Hero Party Platter, Salad Catering Bowl.
    When customer orders any of these: inform them of the advance notice requirement and do not add to cart without confirming they understand.

    SIMILAR ITEMS — ALWAYS CLARIFY BEFORE ADDING:
    "cheesecake" alone: ask "Did you want New York Cheesecake or Italian Cheesecake? Both are $6.99 a slice."
    "margherita" alone: ask "Did you mean Margherita Pizza or Margherita Sicilian?"
    "2 liter" with a personal order: ask whether they want the 2 Liter Soda ($3.99) as a separate item, or a size upgrade on a Fountain Soda.

    DELIVERY ORDERS: always capture the full delivery address before finalizing.
  `,
};
