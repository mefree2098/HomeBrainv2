const express = require('express');
const axios = require('axios');
const brokerStore = require('./store');

function createApp(options = {}) {
  const app = express();
  const store = options.store || brokerStore;

  app.use(express.json({ limit: '4mb' }));

  async function proxyToHub(hubId, kind, method = 'get', body = null) {
    const hub = store.getHub(hubId);
    if (!hub?.registration) {
      const error = new Error(`Hub ${hubId} is not registered with the broker`);
      error.status = 404;
      throw error;
    }

    const url = hub.registration[`${kind}Url`];
    if (!url) {
      const error = new Error(`Hub ${hubId} does not have a ${kind} URL configured`);
      error.status = 501;
      throw error;
    }

    const response = await axios({
      url,
      method,
      data: body,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hub.registration.relayToken}`,
        'X-HomeBrain-Hub-Id': hubId
      }
    });

    return response.data;
  }

  app.get('/health', (_req, res) => {
    res.status(200).json({
      success: true,
      hubs: store.listHubs().length,
      generatedAt: new Date().toISOString()
    });
  });

  app.get('/api/oauth/alexa/authorize', (_req, res) => {
    res.status(501).json({
      success: false,
      error: 'Alexa OAuth authorize flow is not implemented in this starter broker yet'
    });
  });

  app.post('/api/oauth/alexa/token', (_req, res) => {
    res.status(501).json({
      success: false,
      error: 'Alexa OAuth token flow is not implemented in this starter broker yet'
    });
  });

  app.post('/api/alexa/hubs/register', (req, res) => {
    try {
      const hub = store.registerHub(req.body || {});
      res.status(200).json({
        success: true,
        hub
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/hubs/catalog', (req, res) => {
    try {
      const catalog = store.upsertCatalog(req.body || {});
      res.status(200).json({
        success: true,
        catalog
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/hubs/state', (req, res) => {
    try {
      const state = store.upsertState(req.body || {});
      res.status(200).json({
        success: true,
        state
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/hubs/accounts', (req, res) => {
    try {
      const accounts = store.upsertAccounts(req.body || {});
      res.status(200).json({
        success: true,
        accounts
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  });

  app.get('/api/alexa/hubs/:hubId/catalog', async (req, res) => {
    try {
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
      if (refresh) {
        const response = await proxyToHub(req.params.hubId, 'catalog', 'get');
        store.upsertCatalog({
          hubId: req.params.hubId,
          endpoints: response.endpoints,
          reason: 'hub_refresh'
        });
      }

      const hub = store.getHub(req.params.hubId);
      res.status(200).json({
        success: true,
        hubId: req.params.hubId,
        endpoints: hub?.catalog?.endpoints || [],
        updatedAt: hub?.catalog?.updatedAt || null
      });
    } catch (error) {
      res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/directives/state', async (req, res) => {
    try {
      const hubId = req.body?.hubId;
      const endpointIds = Array.isArray(req.body?.endpointIds) ? req.body.endpointIds : [];
      if (!hubId) {
        throw new Error('hubId is required');
      }

      const response = await proxyToHub(hubId, 'state', 'post', { endpointIds });
      store.upsertState({
        hubId,
        states: response.states,
        reason: 'hub_refresh'
      });
      res.status(200).json(response);
    } catch (error) {
      res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/directives/execute', async (req, res) => {
    try {
      const hubId = req.body?.hubId;
      if (!hubId) {
        throw new Error('hubId is required');
      }

      const response = await proxyToHub(hubId, 'execute', 'post', req.body?.directive || req.body);
      res.status(200).json(response);
    } catch (error) {
      res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.get('/api/alexa/hubs/:hubId', (req, res) => {
    const hub = store.getHub(req.params.hubId);
    if (!hub) {
      return res.status(404).json({
        success: false,
        error: 'Hub not found'
      });
    }

    return res.status(200).json({
      success: true,
      hub
    });
  });

  return app;
}

module.exports = {
  createApp
};

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT || 4301);
  app.listen(port, () => {
    console.log(`HomeBrain Alexa broker listening on port ${port}`);
  });
}
