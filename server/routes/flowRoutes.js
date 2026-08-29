const express = require('express');

const passthrough = (req, res, next) => next();

// REST surface for the flow (five thieves) report. Read-only, so everything is
// policy-`read`.
function createFlowRoutes({ flowVisibilityService, logger = console, requireRead = passthrough } = {}) {
  const router = express.Router();

  router.get('/report', requireRead, async (req, res) => {
    try {
      const result = await flowVisibilityService.report({
        days: req.query.days,
        refresh: req.query.refresh === '1' || req.query.refresh === 'true'
      });
      res.json(result);
    } catch (error) {
      logger.error('Failed to build flow report', { error: error.message });
      res.status(500).json({ ok: false, error: 'Failed to build flow report' });
    }
  });

  return router;
}

module.exports = { createFlowRoutes };
