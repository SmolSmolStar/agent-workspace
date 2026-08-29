const express = require('express');

const passthrough = (req, res, next) => next();

// `/api/flow/*`: the derived report plus the thief log it charts alongside.
function createFlowRoutes({ flowVisibilityService, thiefLogService, logger = console, requireRead = passthrough, requireWrite = passthrough } = {}) {
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

  router.get('/thieves/catalog', requireRead, (req, res) => {
    res.json({ ok: true, ...thiefLogService.catalog() });
  });

  router.get('/thieves', requireRead, (req, res) => {
    try {
      const days = Number.parseInt(req.query.days, 10);
      const sinceMs = Number.isFinite(days) ? Date.now() - days * 86400000 : null;
      res.json({ ok: true, entries: thiefLogService.list({ sinceMs }).slice().reverse() });
    } catch (error) {
      logger.error('Failed to list thief log', { error: error.message });
      res.status(500).json({ ok: false, error: 'Failed to list thief log' });
    }
  });

  router.post('/thieves', requireWrite, express.json(), (req, res) => {
    try {
      const entry = thiefLogService.add(req.body || {});
      flowVisibilityService.invalidate();
      res.status(201).json({ ok: true, entry });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.delete('/thieves/:id', requireWrite, (req, res) => {
    const removed = thiefLogService.remove(req.params.id);
    if (!removed) return res.status(404).json({ ok: false, error: 'No such entry' });
    flowVisibilityService.invalidate();
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createFlowRoutes };
