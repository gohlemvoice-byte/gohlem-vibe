const { createClient } = require('@deepgram/sdk');

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

async function transcribe(audioBuffer, mimeType = 'audio/wav') {
  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
    audioBuffer,
    { model: 'nova-2', smart_format: true, mimetype: mimeType }
  );

  if (error) throw error;

  return result.results.channels[0].alternatives[0].transcript;
}

module.exports = { transcribe };
