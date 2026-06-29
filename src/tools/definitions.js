'use strict';

// OpenAI tool definitions. Passed to the API on every turn.
// The AI uses these to call the right function with the right arguments.

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_menu',
      description:
        'Search the menu for items matching what the customer wants. ' +
        'MUST be called before every add_to_cart — no exceptions. ' +
        'Returns item IDs and modifier option IDs to use in add_to_cart.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: "The customer's words — what they're looking for.",
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_to_cart',
      description:
        'Add an item to the order. item_id and all modifier_option_ids ' +
        'MUST come from this turn\'s search_menu response — never invent them. ' +
        'Will return an error if required modifier groups are missing.',
      parameters: {
        type: 'object',
        properties: {
          item_id: {
            type: 'string',
            description: 'The item ID from search_menu results.',
          },
          modifier_option_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Option IDs from search_menu results for modifiers the customer chose.',
          },
          quantity: {
            type: 'integer',
            description: 'How many of this item.',
            default: 1,
          },
          special_instructions: {
            type: 'string',
            description: 'Free-text preparation notes (e.g. "well done", "light sauce").',
          },
          price_confirmed: {
            type: 'boolean',
            description: 'Set to true ONLY when retrying after a PRICE_ANOMALY error and the customer has explicitly confirmed the price. Never set on first attempt.',
          },
        },
        required: ['item_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_from_cart',
      description: 'Remove an item from the order by its cart_item_id.',
      parameters: {
        type: 'object',
        properties: {
          cart_item_id: {
            type: 'string',
            description: 'The cart_item_id from a previous add_to_cart response or get_cart.',
          },
        },
        required: ['cart_item_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_cart_item',
      description:
        'Update an existing cart item — change modifiers, quantity, or special instructions. ' +
        'Modifier IDs must come from the most recent search_menu call for that item.',
      parameters: {
        type: 'object',
        properties: {
          cart_item_id: {
            type: 'string',
            description: 'The cart_item_id to update.',
          },
          add_modifier_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Modifier option IDs to add.',
          },
          remove_modifier_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Modifier option IDs to remove.',
          },
          quantity: {
            type: 'integer',
            description: 'New quantity (replaces existing).',
          },
          special_instructions: {
            type: 'string',
            description: 'Updated special instructions (replaces existing).',
          },
        },
        required: ['cart_item_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_cart',
      description:
        'Get the current cart — all items, modifiers, quantities, and total. ' +
        'Use before reading back the order or when you need to reference cart_item_ids.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

module.exports = TOOL_DEFINITIONS;
