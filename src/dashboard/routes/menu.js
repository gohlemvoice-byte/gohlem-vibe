const router = require('express').Router();
const menu = require('../../menu');

router.get('/', async (req, res) => {
  try {
    const { restaurantGuid = process.env.TOAST_RESTAURANT_GUID } = req.query;
    const data = await menu.getMenu(restaurantGuid);
    res.json(data || { message: 'No menu cached. Trigger a sync first.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const { restaurantGuid = process.env.TOAST_RESTAURANT_GUID } = req.body;
    const data = await menu.syncMenu(restaurantGuid);
    res.json({ ok: true, itemCount: data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
