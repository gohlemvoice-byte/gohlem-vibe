const menuLoader = require('./menuLoader');
const menuStore = require('./menuStore');

async function syncMenu(restaurantGuid) {
  const raw = await menuLoader.fetchFromPOS(restaurantGuid);
  await menuStore.save(restaurantGuid, raw);
  return raw;
}

async function getMenu(restaurantGuid) {
  return menuStore.get(restaurantGuid);
}

module.exports = { syncMenu, getMenu };
