const axios = require('axios');

const BASE_URL = 'https://ws-api.toasttab.com';

let _token = null;
let _tokenExpiry = 0;

async function authenticate() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const { data } = await axios.post(`${BASE_URL}/authentication/v1/authentication/login`, {
    clientId: process.env.TOAST_CLIENT_ID,
    clientSecret: process.env.TOAST_CLIENT_SECRET,
    userAccessType: 'TOAST_MACHINE_CLIENT',
  });

  _token = data.token.accessToken;
  _tokenExpiry = Date.now() + (data.token.expiresIn - 60) * 1000;
  return _token;
}

async function getMenu(restaurantGuid) {
  const token = await authenticate();
  const { data } = await axios.get(`${BASE_URL}/menus/v2/menus`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Toast-Restaurant-External-ID': restaurantGuid,
    },
  });
  return data;
}

async function submitOrder(cart) {
  const token = await authenticate();
  const restaurantGuid = process.env.TOAST_RESTAURANT_GUID;

  const { data } = await axios.post(
    `${BASE_URL}/orders/v2/orders`,
    { ...cart },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Toast-Restaurant-External-ID': restaurantGuid,
      },
    }
  );
  return data;
}

module.exports = { getMenu, submitOrder };
