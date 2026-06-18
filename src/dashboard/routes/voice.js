const router = require('express').Router();
const { handleInboundCall, processSpeech } = require('../../voice/callHandler');

router.post('/inbound', handleInboundCall);
router.post('/process', processSpeech);

module.exports = router;
