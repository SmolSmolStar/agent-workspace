const express = require('express');

const passthrough = (req, res, next) => next();

// REST surface for the team activity digest. Read-only, so everything is
// policy-`read`.
function createTeamRoutes({ teamActivityService, logger = console, requireRead = passthrough } = {}) {
  const router = express.Router();

  router.get('/config', requireRead, (req, res) => {
    try {
      res.json({ ok: true, ...teamActivityService.teamConfig() });
    } catch (error) {
      logger.error('Failed to read team config', { error: error.message });
      res.status(500).json({ ok: false, error: 'Failed to read team config' });
    }
  });

  router.get('/activity', requireRead, async (req, res) => {
    try {
      const result = await teamActivityService.activity({
        days: req.query.days,
        authors: req.query.authors,
        refresh: req.query.refresh === '1' || req.query.refresh === 'true'
      });
      res.json(result);
    } catch (error) {
      logger.error('Failed to build team activity', { error: error.message });
      res.status(502).json({ ok: false, error: 'Team activity lookup failed. Is `gh` authenticated?' });
    }
  });

  return router;
}

module.exports = { createTeamRoutes };
