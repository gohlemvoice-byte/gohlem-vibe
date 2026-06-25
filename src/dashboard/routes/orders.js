'use strict';

const router = require('express').Router();

// Orders are now session-local (inside ConversationEngine instances).
// There is no global order store in Phase 1.
// Phase 3 will connect to Toast POS for order history.

router.get('/:callSid', (req, res) => {
  res.json({ message: 'Per-session order lookup not yet implemented (Phase 3).', callSid: req.params.callSid });
});

router.delete('/:callSid', (req, res) => {
  res.json({ ok: false, message: 'Order cancellation not yet implemented (Phase 3).' });
});

module.exports = router;
