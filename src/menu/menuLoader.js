const toast = require('../pos/toastConnector');

async function fetchFromPOS(restaurantGuid) {
  return toast.getMenu(restaurantGuid);
}

module.exports = { fetchFromPOS };
