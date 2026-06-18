const UPSELL_MAP = {
  // itemGuid -> suggested upsell itemGuid
};

function applyUpsells(cart) {
  const suggestions = [];
  for (const item of cart.items) {
    const upsell = UPSELL_MAP[item.guid];
    if (upsell) suggestions.push(upsell);
  }
  return suggestions;
}

module.exports = { applyUpsells };
