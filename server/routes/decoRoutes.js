const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAdmin } = require('./middlewares/auth');
function createDecoRouter(deco = require('../services/decoService'), checkAppliances = () => require('../services/applianceService').sync('midea')) {
  const router = express.Router();

  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.use(requireAdmin());
  router.use((req, res, next) => req.user.isReviewSandbox
    ? res.status(403).json({ success: false, message: 'Deco is not available in the review sandbox.' }) : next());
  router.use(rateLimit({ windowMs: 60000, limit: 60, standardHeaders: true, legacyHeaders: false }));
  const handler = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (error) { res.status(400).json({ success: false, message: /^(Enter |Deco password)/.test(error.message) ? error.message : 'Deco integration is unavailable. Check the hub connection and saved settings.' }); }
  };
  router.get('/status', handler(() => deco.getStatus()));
  router.post('/configure', handler((req) => deco.configure(req.body || {})));
  router.post('/sync', handler(() => deco.sync({ force: true })));
  router.post('/check-appliances', handler(async () => {
    await deco.sync({ force: true });
    return checkAppliances();
  }));
  return router;
}

module.exports = createDecoRouter();
module.exports.createDecoRouter = createDecoRouter;
