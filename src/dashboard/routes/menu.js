'use strict';

const router = require('express').Router();
const fs = require('fs');
const restaurantConfig = require('../../config/restaurantConfig');

// Returns the current menu from the local JSON file.
// In Phase 3 this will be replaced by a live Toast API pull.
router.get('/', (_req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(restaurantConfig.menuFile, 'utf8'));
    res.json({ source: 'local', itemCount: data.items.length, menu: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', (_req, res) => {
  res.json({ ok: false, message: 'Toast menu sync not yet implemented (Phase 3).' });
});

module.exports = router;
