const express = require('express');

const oidcService = require('../services/oidcService');

const router = express.Router();

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

router.get('/oauth/authorize', async (req, res, next) => {
  try {
    return await oidcService.handleAuthorize(req, res);
  } catch (error) {
    return next(error);
  }
});

router.post('/oauth/token', async (req, res, next) => {
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
