const router = require('express').Router();
const orders = require('../../orders');

router.get('/:callSid', (req, res) => {
  const order = orders.getOrCreate(req.params.callSid);
  res.json(order.cart);
});

router.delete('/:callSid', (req, res) => {
  orders.abandon(req.params.callSid);
  res.json({ ok: true });
});

module.exports = router;
