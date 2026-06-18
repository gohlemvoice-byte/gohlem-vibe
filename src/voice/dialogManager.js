const OpenAI = require('openai');
const orders = require('../orders');
const menu = require('../menu');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const sessions = new Map(); // callSid -> message history

async function respond(callSid, userText) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, [
      {
        role: 'system',
        content:
          'You are a friendly phone ordering assistant for a restaurant. ' +
          'Help the caller build their order. Keep responses concise and clear for audio.',
      },
    ]);
  }

  const history = sessions.get(callSid);
  history.push({ role: 'user', content: userText });

  const completion = await openai.chat.completions.create({
    model: 'claude-sonnet-4-6',
    messages: history,
  });

  const reply = completion.choices[0].message;
  history.push(reply);

  const done =
    reply.content.toLowerCase().includes('your order has been placed') ||
    reply.content.toLowerCase().includes('goodbye');

  if (done) sessions.delete(callSid);

  return { text: reply.content, done };
}

module.exports = { respond };
