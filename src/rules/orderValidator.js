function validateOrder(cart, menu) {
  const errors = [];

  for (const item of cart.items) {
    const menuItem = menu.items.find((m) => m.guid === item.guid);
    if (!menuItem) {
      errors.push(`Item not found: ${item.guid}`);
      continue;
    }
    if (!menuItem.available) {
      errors.push(`Item unavailable: ${menuItem.name}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateOrder };
