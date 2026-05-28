const express = require('express');
const rateLimit = require('express-rate-limit');

const oidcService = require('../services/oidcService');

const router = express.Router();
const { ipKeyGenerator } = rateLimit;

function rateLimitIpKey(req) {
  return typeof ipKeyGenerator === 'function'
    ? ipKeyGenerator(req.ip)
    : (req.ip || req.socket?.remoteAddress || 'unknown');
}

const oidcAuthorizeRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_OIDC_AUTHORIZE_RATE_LIMIT_WINDOW_MS || 5 * 60 * 1000)),
  limit: Math.max(30, Number(process.env.HOMEBRAIN_OIDC_AUTHORIZE_RATE_LIMIT_MAX || 300)),
  keyGenerator: rateLimitIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'rate_limited',
    error_description: 'Too many authorization requests. Please retry shortly.'
  }
});

const oidcTokenRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_OIDC_TOKEN_RATE_LIMIT_WINDOW_MS || 5 * 60 * 1000)),
  limit: Math.max(10, Number(process.env.HOMEBRAIN_OIDC_TOKEN_RATE_LIMIT_MAX || 120)),
  keyGenerator(req) {
    const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id.trim() : '';
    return `${rateLimitIpKey(req)}:${clientId || 'unknown-client'}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'rate_limited',
    error_description: 'Too many token requests. Please retry shortly.'
  }
});

router.get('/.well-known/openid-configuration', async (req, res, next) => {
  try {
    await oidcService.ensureBootstrapState({ actor: 'system:oidc-discovery' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(oidcService.buildDiscoveryDocument(req));
  } catch (error) {
    return next(error);
  }
});

router.get('/.well-known/jwks.json', async (req, res, next) => {
  try {
    await oidcService.ensureBootstrapState({ actor: 'system:oidc-jwks' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await oidcService.buildJwks());
  } catch (error) {
    return next(error);
  }
});

router.get('/oauth/authorize', oidcAuthorizeRateLimit, async (req, res, next) => {
  try {
    return await oidcService.handleAuthorize(req, res);
  } catch (error) {
    return next(error);
  }
});

router.post('/oauth/token', oidcTokenRateLimit, async (req, res, next) => {
  try {
    return await oidcService.handleToken(req, res);
  } catch (error) {
    return next(error);
  }
});

const handleUserInfo = async (req, res, next) => {
  try {
    return await oidcService.handleUserInfo(req, res);
  } catch (error) {
    return next(error);
  }
};

router.get('/oauth/userinfo', handleUserInfo);
router.post('/oauth/userinfo', handleUserInfo);

module.exports = router;
