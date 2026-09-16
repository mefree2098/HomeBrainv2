const router = require('express').Router();
const { requireAdmin } = require('./middlewares/auth');
const service = require('../services/applianceService');

router.use(requireAdmin());
const handler = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (error) { res.status(400).json({ success: false, message: error.message }); }
};
router.get('/:provider/status', handler((req) => service.getStatus(req.params.provider)));
router.post('/:provider/configure', handler((req) => service.configure(req.params.provider, req.body || {})));
router.post('/:provider/sync', handler((req) => service.sync(req.params.provider)));
router.post('/midea/discover', handler((req) => service.discover(req.body || {})));
router.post('/midea/pair', handler((req) => service.pair(req.body || {})));

module.exports = router;
