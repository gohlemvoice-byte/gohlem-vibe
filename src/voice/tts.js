const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function synthesize(text, voice = 'alloy') {
  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice,
    input: text,
  });
  return Buffer.from(await response.arrayBuffer());
}

module.exports = { synthesize };
