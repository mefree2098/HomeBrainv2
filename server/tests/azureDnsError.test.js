const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AZURE_DNS_ZONE_CONTRIBUTOR_ROLE,
  buildAzureDnsZoneScope,
  createAzureDnsError,
  extractAzureError
} = require('../services/azureDnsError');

function createSettings(overrides = {}) {
  return {
    dynamicDnsAzureTenantId: 'tenant-id',
    dynamicDnsAzureClientId: 'client-id',
    dynamicDnsAzureClientSecret: 'client-secret',
    dynamicDnsAzureSubscriptionId: 'subscription-id',
    dynamicDnsAzureResourceGroup: 'homebrain-rg',
    dynamicDnsAzureZoneName: 'example.com',
    ...overrides
  };
}

test('buildAzureDnsZoneScope returns the exact Azure DNS zone resource ID', () => {
  assert.equal(
    buildAzureDnsZoneScope(createSettings()),
    '/subscriptions/subscription-id/resourceGroups/homebrain-rg/providers/Microsoft.Network/dnsZones/example.com'
  );
});

test('Azure DNS 403 becomes actionable DNS Zone Contributor guidance', () => {
  const upstream = new Error('Request failed with status code 403');
  upstream.response = {
    status: 403,
    data: {
      error: {
        code: 'AuthorizationFailed',
        message: "The client does not have authorization to perform action 'Microsoft.Network/dnsZones/A/write' over the requested scope."
      }
    },
    headers: {
      'x-ms-correlation-request-id': 'azure-request-id'
    }
  };

  const wrapped = createAzureDnsError(upstream, {
    settings: createSettings(),
    operation: 'write the Azure DNS A record',
    hostname: 'home.example.com'
  });

  assert.equal(wrapped.name, 'AzureDnsError');
  assert.equal(wrapped.status, 403);
  assert.equal(wrapped.code, 'AuthorizationFailed');
  assert.equal(wrapped.azureRequestId, 'azure-request-id');
  assert.equal(
    wrapped.azureScope,
    '/subscriptions/subscription-id/resourceGroups/homebrain-rg/providers/Microsoft.Network/dnsZones/example.com'
  );
  assert.match(wrapped.message, new RegExp(AZURE_DNS_ZONE_CONTRIBUTOR_ROLE));
  assert.match(wrapped.message, /application client ID client-id/);
  assert.match(wrapped.message, /home\.example\.com/);
  assert.match(wrapped.message, /Microsoft\.Network\/dnsZones\/A\/write/);
  assert.match(wrapped.message, /azure-request-id/);
  assert.doesNotMatch(wrapped.message, /client-secret/);
});

test('Azure OAuth errors preserve the provider description without exposing the secret', () => {
  const upstream = new Error('Request failed with status code 400');
  upstream.response = {
    status: 400,
    data: {
      error: 'invalid_client',
      error_description: 'AADSTS7000215: Invalid client secret provided.'
    },
    headers: {}
  };

  const details = extractAzureError(upstream);
  assert.equal(details.status, 400);
  assert.equal(details.code, 'invalid_client');
  assert.match(details.message, /AADSTS7000215/);

  const wrapped = createAzureDnsError(upstream, {
    authentication: true,
    settings: createSettings()
  });

  assert.equal(wrapped.status, 400);
  assert.match(wrapped.message, /Azure sign-in failed/);
  assert.match(wrapped.message, /Invalid client secret provided/);
  assert.doesNotMatch(wrapped.message, /client-secret/);
});