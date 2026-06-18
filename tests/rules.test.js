const { validateOrder } = require('../src/rules/orderValidator');
const { isItemAvailable } = require('../src/rules/availabilityRules');

describe('orderValidator', () => {
  const menu = {
    items: [
      { guid: 'item-1', name: 'Burger', available: true },
      { guid: 'item-2', name: 'Fries', available: false },
    ],
  };

  test('passes a valid cart', () => {
    const cart = { items: [{ guid: 'item-1' }] };
    expect(validateOrder(cart, menu)).toEqual({ valid: true, errors: [] });
  });

  test('rejects an unavailable item', () => {
    const cart = { items: [{ guid: 'item-2' }] };
    const { valid, errors } = validateOrder(cart, menu);
    expect(valid).toBe(false);
    expect(errors[0]).toMatch(/unavailable/i);
  });

  test('rejects an unknown item', () => {
    const cart = { items: [{ guid: 'item-999' }] };
    const { valid, errors } = validateOrder(cart, menu);
    expect(valid).toBe(false);
    expect(errors[0]).toMatch(/not found/i);
  });
});

describe('isItemAvailable', () => {
  test('returns true when within window', () => {
    const item = { availability: { startTime: '11:00', endTime: '15:00' } };
    const noon = new Date();
    noon.setHours(12, 0, 0);
    expect(isItemAvailable(item, noon)).toBe(true);
  });

  test('returns false when outside window', () => {
    const item = { availability: { startTime: '11:00', endTime: '15:00' } };
    const evening = new Date();
    evening.setHours(18, 0, 0);
    expect(isItemAvailable(item, evening)).toBe(false);
  });
});
