const redis = require('../../config/redis');

const TTL_SECONDS = 60 * 60; // 1 hour

function key(restaurantGuid) {
  return `menu:${restaurantGuid}`;
}

async function save(restaurantGuid, menu) {
  await redis.set(key(restaurantGuid), JSON.stringify(menu), 'EX', TTL_SECONDS);
}

async function get(restaurantGuid) {
  const raw = await redis.get(key(restaurantGuid));
  return raw ? JSON.parse(raw) : null;
}

module.exports = { save, get };
