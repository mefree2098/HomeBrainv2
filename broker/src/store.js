class BrokerStore {
  constructor() {
    this.hubs = new Map();
  }

  ensureHub(hubId) {
    const key = String(hubId || '').trim();
    if (!key) {
      throw new Error('hubId is required');
    }

    if (!this.hubs.has(key)) {
      this.hubs.set(key, {
        hubId: key,
        registration: null,
        catalog: {
          endpoints: [],
          updatedAt: null,
          reason: 'never'
        },
        state: {
          states: [],
          updatedAt: null,
          reason: 'never'
        },
        accounts: [],
        updatedAt: null
      });
    }

    return this.hubs.get(key);
  }

  registerHub(payload = {}) {
    const hub = this.ensureHub(payload.hubId);
    hub.registration = {
      hubId: hub.hubId,
      catalogUrl: payload.catalogUrl || '',
      stateUrl: payload.stateUrl || '',
      executeUrl: payload.executeUrl || '',
      healthUrl: payload.healthUrl || '',
      relayToken: payload.relayToken || '',
      brokerClientId: payload.brokerClientId || '',
      mode: payload.mode || 'private',
      publicOrigin: payload.publicOrigin || '',
      updatedAt: new Date().toISOString()
    };
    hub.updatedAt = hub.registration.updatedAt;
    return hub;
  }

  upsertCatalog(payload = {}) {
    const hub = this.ensureHub(payload.hubId);
    hub.catalog = {
      endpoints: Array.isArray(payload.endpoints) ? payload.endpoints : [],
      updatedAt: new Date().toISOString(),
      reason: payload.reason || 'hub_push'
    };
    hub.updatedAt = hub.catalog.updatedAt;
    return hub.catalog;
  }

  upsertState(payload = {}) {
    const hub = this.ensureHub(payload.hubId);
    hub.state = {
      states: Array.isArray(payload.states) ? payload.states : [],
      updatedAt: new Date().toISOString(),
      reason: payload.reason || 'hub_push'
    };
    hub.updatedAt = hub.state.updatedAt;
    return hub.state;
  }

  upsertAccounts(payload = {}) {
    const hub = this.ensureHub(payload.hubId);
    hub.accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    hub.updatedAt = new Date().toISOString();
    return hub.accounts;
  }

  getHub(hubId) {
    return this.hubs.get(String(hubId || '').trim()) || null;
  }

  listHubs() {
    return Array.from(this.hubs.values());
  }
}

module.exports = new BrokerStore();
module.exports.BrokerStore = BrokerStore;
