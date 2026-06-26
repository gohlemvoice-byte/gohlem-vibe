'use strict';

const path = require('path');

module.exports = {
  restaurantInfo: {
    name: 'That Sushi Spot',
    location: 'Lakewood, NJ',
    pickupHours: 'Monday-Thursday 10:30am-9pm, Friday 10:30am-2:30pm, Saturday 7:30pm-11:30pm, Sunday 10:30am-9pm',
    deliveryHours: 'Monday-Thursday 10:30am-9pm, Friday 10:30am-2:30pm, Saturday 7:30pm-11:30pm, Sunday 10:30am-9pm',
    orderTypes: ['pickup', 'delivery'],
    deliveryMinimum: 20.00,
    deliveryRadiusMiles: 5,
    version: 'Bravo',
  },

  menuFile: path.join(__dirname, '../../menus/that_sushi_spot.json'),

  cateringItemIds: [],

  specialTerminology: `
    kani = imitation crab
    crab = kani (imitation crab, not real crab)
    nigiri = nigiri (fish over rice, priced per piece — NOT a roll)
    najiri = nigiri
    nachiris = nigiri
    nachiri = nigiri
    sashimi = sashimi (fish only, no rice — NOT a roll)
    maki = sushi roll
    roll = sushi roll
    spicy = spicy version (e.g. spicy salmon roll, spicy tuna roll)
    hand roll = sushi burrito
    poke = poke bowl
    pokeball = poke bowl
    edamame = edamame
    adamame = edamame
  `,

  faqKnowledgeBase: `
    We are a kosher establishment under reliable hashgacha.
    All sushi is kosher certified.
    Hours: Monday-Thursday 10:30am-9pm, Friday 10:30am-2:30pm, Saturday 7:30pm-11:30pm, Sunday 10:30am-9pm.
    Delivery minimum: $20.00.
    All rolls available with white or brown rice unless otherwise noted.
    Shabbos specials are available for Shabbos orders only.
    Party platters are available — assorted chef's choice.
    Allergens: please inform us of any allergies. We cannot guarantee allergen-free preparation.
  `,

  storeSpecificInstructions: `
    RICE CHOICE: Many rolls have a Rice Choice modifier (white or brown rice). Only ask about rice if the search_menu result for that item actually includes a Rice Choice modifier group. If the item has no rice modifier option, do not ask — add it as-is. Never substitute a lower-ranked search result just because it has a rice modifier and the top result does not.

    PARTY PLATTERS: When customer asks about platters for a group, ask how many people and present the size options.

    SHABBOS SPECIALS: Only available for Shabbos orders. If customer orders on a weekday, let them know.

    DELIVERY ORDERS: Always capture the full delivery address before finalizing.

    RAW FISH: Some items contain raw fish. If customer asks about raw vs cooked options, clarify based on the item description.
  `,
};
