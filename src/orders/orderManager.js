const { OrderState } = require('./orderState');
const rules = require('../rules');
const toast = require('../pos/toastConnector');

const activeCarts = new Map(); // callSid -> OrderState

function getOrCreate(callSid) {
  if (!activeCarts.has(callSid)) {
    activeCarts.set(callSid, new OrderState(callSid));
  }
  return activeCarts.get(callSid);
}

function addItem(callSid, item) {
  const order = getOrCreate(callSid);
  order.addItem(item);
  return order;
}

function removeItem(callSid, itemGuid) {
  const order = getOrCreate(callSid);
  order.removeItem(itemGuid);
  return order;
}

async function submitOrder(callSid, menu) {
  const order = getOrCreate(callSid);
  const { valid, errors } = rules.validateOrder(order.cart, menu);
  if (!valid) throw new Error(`Order invalid: ${errors.join(', ')}`);

  const result = await toast.submitOrder(order.cart);
  activeCarts.delete(callSid);
  return result;
}

function abandon(callSid) {
  activeCarts.delete(callSid);
}

module.exports = { getOrCreate, addItem, removeItem, submitOrder, abandon };
