const twilio = require('twilio');
const stt = require('./stt');
const tts = require('./tts');
const dialogManager = require('./dialogManager');

function handleInboundCall(req, res) {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say('Welcome to Gohlem ordering. How can I help you today?');

  twiml.gather({
    input: 'speech',
    action: '/voice/process',
    method: 'POST',
    speechTimeout: 'auto',
  });

  res.type('text/xml');
  res.send(twiml.toString());
}

async function processSpeech(req, res) {
  const { CallSid, SpeechResult } = req.body;
  const twiml = new twilio.twiml.VoiceResponse();

  const reply = await dialogManager.respond(CallSid, SpeechResult);
  twiml.say(reply.text);

  if (!reply.done) {
    twiml.gather({
      input: 'speech',
      action: '/voice/process',
      method: 'POST',
      speechTimeout: 'auto',
    });
  }

  res.type('text/xml');
  res.send(twiml.toString());
}

module.exports = { handleInboundCall, processSpeech };
