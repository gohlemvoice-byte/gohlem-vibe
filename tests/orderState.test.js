const { OrderState } = require('../src/orders/orderState');

describe('OrderState', () => {
  test('adds a new item', () => {
    const order = new OrderState('call-1');
    order.addItem({ guid: 'a', name: 'Burger', price: 10 });
    expect(order.cart.items).toHaveLength(1);
    expect(order.cart.items[0].quantity).toBe(1);
  });

  test('increments quantity for duplicate item', () => {
    const order = new OrderState('call-1');
    order.addItem({ guid: 'a', name: 'Burger', price: 10 });
    order.addItem({ guid: 'a', name: 'Burger', price: 10, quantity: 2 });
    expect(order.cart.items[0].quantity).toBe(3);
  });

  test('removes an item', () => {
    const order = new OrderState('call-1');
    order.addItem({ guid: 'a', name: 'Burger', price: 10 });
    order.removeItem('a');
    expect(order.cart.items).toHaveLength(0);
  });

  test('calculates total correctly', () => {
    const order = new OrderState('call-1');
    order.addItem({ guid: 'a', price: 10, quantity: 2 });
    order.addItem({ guid: 'b', price: 5, quantity: 1 });
    expect(order.total()).toBe(25);
  });
});
