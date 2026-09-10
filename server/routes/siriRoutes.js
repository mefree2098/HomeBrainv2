const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireUser } = require('./middlewares/auth');
const siriService = require('../services/siriService');

function createSiriRouter(service = siriService) {
  const router = express.Router();
  router.use(rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false }));
  router.use(requireUser());
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  const handle = (operation) => async (req, res) => {
    try {
      const result = await operation(req);
      res.status(result.state === 'running' ? 202 : 200).json(result);
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
      res.status(status).json({ success: false, message: status === 500 ? 'HomeBrain could not process this Siri request.' : error.message });
    }
  };
  router.get('/catalog', handle((req) => service.catalog(req.user)));
  router.post('/commands', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }), handle((req) => service.start(req.user, req.body)));
  router.get('/commands/:requestId', handle((req) => service.get(req.user, req.params.requestId)));
  return router;
}
module.exports = createSiriRouter();
module.exports.createSiriRouter = createSiriRouter;
