'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireUser, requireAdmin } = require('./middlewares/auth');

function createAppleHomeRouter(service = require('../services/appleHomeBridgeService')) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.use(requireUser());
  router.use((req, res, next) => req.user.isReviewSandbox
    ? res.status(403).json({ success: false, message: 'Apple Home is not available in the review sandbox.' }) : next());
  router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
  const handle = (operation) => async (req, res) => {
    try { await service.initialize(); res.json(await operation(req)); }
    catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      res.status(status).json({ success: false, message: status < 500 ? error.message : 'Apple Home bridge is unavailable. Check the hub LAN, storage, and server logs.' });
    }
  };
  router.get('/status', handle((req) => service.status(req.user)));
  router.put('/configuration', requireAdmin(), handle((req) => service.configure(req.user, req.body)));
  router.post('/pairing', requireAdmin(), rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }),
    handle((req) => service.pairing(req.user)));
  router.post('/sync', requireAdmin(), handle(async (req) => { await service.refresh(); return service.status(req.user); }));
  return router;
}
module.exports = createAppleHomeRouter();
module.exports.createAppleHomeRouter = createAppleHomeRouter;
