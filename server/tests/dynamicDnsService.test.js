const test = require('node:test');
const assert = require('node:assert/strict');

const axios = require('axios');
const dynamicDnsService = require('../services/dynamicDnsService');
const Settings = require('../models/Settings');
const ReverseProxyRoute = require('../models/ReverseProxyRoute');

function createSettings(overrides = {}) {
  return {
    dynamicDnsEnabled: true,
    dynamicDnsProvider: 'azure',
    dynamicDnsCheckIntervalSeconds: 60,
    dynamicDnsPublicIpUrl: 'https://ip.example.test',
    dynamicDnsPrimaryHostname: 'home.example.com',
    dynamicDnsAzureTenantId: 'tenant-id',
    dynamicDnsAzureClientId: 'client-id',
    dynamicDnsAzureClientSecret: 'client-secret',
    dynamicDnsAzureSubscriptionId: 'subscription-id',
    dynamicDnsAzureResourceGroup: 'homebrain-rg',
    dynamicDnsAzureZoneName: 'example.com',
    dynamicDnsAzureTtlSeconds: 60,
    dynamicDnsLastPublicIp: '',
    ...overrides
  };
}

function mockRouteFind(routes) {
  ReverseProxyRoute.find = () => ({
    sort: () => ({
      lean: async () => routes
    })
  });
}

test('pushNow updates primary and opted-in reverse proxy Azure records', async (t) => {
  dynamicDnsService.stop();
  const originalGetSettings = Settings.getSettings;
  const originalUpdateSettings = Settings.updateSettings;
  const originalRouteFind = ReverseProxyRoute.find;
  const originalAxiosGet = axios.get;
  const originalAxiosPost = axios.post;
  const originalAxiosPut = axios.put;
  const updatePayloads = [];
  const putCalls = [];

  t.after(() => {
    dynamicDnsService.stop();
    Settings.getSettings = originalGetSettings;
    Settings.updateSettings = originalUpdateSettings;
    ReverseProxyRoute.find = originalRouteFind;
    axios.get = originalAxiosGet;
    axios.post = originalAxiosPost;
    axios.put = originalAxiosPut;
  });

  Settings.getSettings = async () => createSettings({ dynamicDnsLastPublicIp: '198.51.100.8' });
  Settings.updateSettings = async (updates) => {
    updatePayloads.push(updates);
    return { ...createSettings(), ...updates };
  };
  mockRouteFind([
    {
      _id: 'route-1',
      hostname: 'mail.example.com',
      enabled: true,
      dynamicDnsEnabled: true
    }
  ]);

  axios.get = async () => ({ data: { ip: '203.0.113.44' } });
  axios.post = async () => ({ data: { access_token: 'azure-token' } });
  axios.put = async (url, body, config) => {
    putCalls.push({ url, body, config });
    return { data: {} };
  };

  const result = await dynamicDnsService.pushNow('admin@example.com');

  assert.equal(result.updated, true);
  assert.equal(result.publicIp, '203.0.113.44');
  assert.deepEqual(result.records.map((record) => record.hostname), [
    'home.example.com',
    'mail.example.com'
  ]);
  assert.equal(putCalls.length, 2);
  assert.match(putCalls[0].url, /\/dnsZones\/example\.com\/A\/home\?/);
  assert.match(putCalls[1].url, /\/dnsZones\/example\.com\/A\/mail\?/);
  assert.deepEqual(putCalls[0].body.properties.ARecords, [{ ipv4Address: '203.0.113.44' }]);
  assert.equal(putCalls[0].config.headers.Authorization, 'Bearer azure-token');
  assert.equal(updatePayloads.at(-1).dynamicDnsLastStatus, 'updated');
});

test('scheduled check skips provider update when cached public IP is unchanged', async (t) => {
  dynamicDnsService.stop();
  const originalGetSettings = Settings.getSettings;
  const originalUpdateSettings = Settings.updateSettings;
  const originalRouteFind = ReverseProxyRoute.find;
  const originalAxiosGet = axios.get;
  const originalAxiosPut = axios.put;
  const updatePayloads = [];
  let putCount = 0;

  t.after(() => {
    dynamicDnsService.stop();
    Settings.getSettings = originalGetSettings;
    Settings.updateSettings = originalUpdateSettings;
    ReverseProxyRoute.find = originalRouteFind;
    axios.get = originalAxiosGet;
    axios.put = originalAxiosPut;
  });

  Settings.getSettings = async () => createSettings({ dynamicDnsLastPublicIp: '203.0.113.44' });
  Settings.updateSettings = async (updates) => {
    updatePayloads.push(updates);
    return { ...createSettings(), ...updates };
  };
  mockRouteFind([]);
  axios.get = async () => ({ data: '203.0.113.44\n' });
  axios.put = async () => {
    putCount += 1;
  };

  const result = await dynamicDnsService.checkAndUpdate({ reason: 'scheduled' });

  assert.equal(result.updated, false);
  assert.equal(result.publicIp, '203.0.113.44');
  assert.equal(putCount, 0);
  assert.equal(updatePayloads.at(-1).dynamicDnsLastStatus, 'unchanged');
});
