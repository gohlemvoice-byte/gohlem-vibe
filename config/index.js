require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY,
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
  },
  toast: {
    clientId: process.env.TOAST_CLIENT_ID,
    clientSecret: process.env.TOAST_CLIENT_SECRET,
    restaurantGuid: process.env.TOAST_RESTAURANT_GUID,
  },
};
