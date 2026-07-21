const AZURE_DNS_ZONE_CONTRIBUTOR_ROLE = 'DNS Zone Contributor';

function trimString(value, fallback = '') {
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value).trim();
}

function normalizeHostname(value) {
  return trimString(value).toLowerCase().replace(/\.$/, '');
}

function buildAzureDnsZoneScope(settings = {}) {
  const subscriptionId = trimString(settings.dynamicDnsAzureSubscriptionId);
  const resourceGroup = trimString(settings.dynamicDnsAzureResourceGroup);
  const zoneName = normalizeHostname(settings.dynamicDnsAzureZoneName);

  if (!subscriptionId || !resourceGroup || !zoneName) {
    return '';
  }

  return [
    '/subscriptions',
    subscriptionId,
    'resourceGroups',
    resourceGroup,
    'providers/Microsoft.Network/dnsZones',
    zoneName
  ].join('/');
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') {
    return '';
  }

  const normalizedName = String(name).toLowerCase();
  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === normalizedName);
  return matchingKey ? trimString(headers[matchingKey]) : '';
}

function extractAzureError(error) {
  const response = error?.response || null;
  const responseData = response?.data;
  const cloudError = responseData?.error && typeof responseData.error === 'object'
    ? responseData.error
    : responseData;
  const status = Number(response?.status || error?.status || 0);
  const code = trimString(cloudError?.code || responseData?.error || error?.code);
  const message = trimString(
    cloudError?.message ||
    responseData?.error_description ||
    responseData?.message ||
    error?.message,
    'Azure request failed'
  );
  const requestId = trimString(
    getHeader(response?.headers, 'x-ms-correlation-request-id') ||
    getHeader(response?.headers, 'x-ms-request-id') ||
    cloudError?.requestId
  );

  return {
    status,
    code,
    message,
    requestId
  };
}

function appendAzureDetails(message, details) {
  const parts = [message];
  const azureSummary = [details.code, details.message].filter(Boolean).join(': ');

  if (azureSummary && !message.includes(azureSummary)) {
    parts.push(`Azure returned ${azureSummary}.`);
  }
  if (details.requestId) {
    parts.push(`Azure request ID: ${details.requestId}.`);
  }

  return parts.join(' ');
}

function createAzureDnsError(error, context = {}) {
  const details = extractAzureError(error);
  const settings = context.settings || {};
  const operation = trimString(context.operation, 'access Azure DNS');
  const hostname = normalizeHostname(context.hostname);
  const clientId = trimString(settings.dynamicDnsAzureClientId);
  const resourceGroup = trimString(settings.dynamicDnsAzureResourceGroup);
  const zoneName = normalizeHostname(settings.dynamicDnsAzureZoneName);
  const scope = buildAzureDnsZoneScope(settings);
  let message = '';

  if (context.authentication === true) {
    message = 'Azure sign-in failed for the Dynamic DNS application. Verify the tenant ID, application (client) ID, and client secret value.';
  } else if (details.status === 403) {
    const target = hostname ? ` for "${hostname}"` : '';
    const identity = clientId ? ` application client ID ${clientId}` : ' the configured service principal';
    const location = zoneName
      ? ` on DNS zone "${zoneName}"${resourceGroup ? ` in resource group "${resourceGroup}"` : ''}`
      : '';
    const scopeText = scope ? ` Scope: ${scope}.` : '';

    message = `Azure authenticated the Dynamic DNS application but denied permission to ${operation}${target}. Assign the "${AZURE_DNS_ZONE_CONTRIBUTOR_ROLE}" role to${identity}${location}, wait a few minutes for Azure RBAC propagation, and retry.${scopeText}`;
  } else if (details.status === 404) {
    message = `Azure could not find the configured DNS zone${zoneName ? ` "${zoneName}"` : ''}${resourceGroup ? ` in resource group "${resourceGroup}"` : ''}. Verify the subscription ID, resource group, and DNS zone name.`;
  } else if (details.status === 401) {
    message = 'Azure rejected the Dynamic DNS access token. Verify the tenant ID, application (client) ID, client secret value, and that the application belongs to the configured tenant.';
  } else {
    const target = hostname ? ` for "${hostname}"` : '';
    message = `Azure Dynamic DNS could not ${operation}${target}.`;
  }

  const wrapped = new Error(appendAzureDetails(message, details));
  wrapped.name = 'AzureDnsError';
  wrapped.status = details.status >= 400 && details.status < 500 ? details.status : 502;
  wrapped.code = details.code || 'AZURE_DNS_REQUEST_FAILED';
  wrapped.azureRequestId = details.requestId || undefined;
  wrapped.azureScope = scope || undefined;
  wrapped.cause = error;
  return wrapped;
}

module.exports = {
  AZURE_DNS_ZONE_CONTRIBUTOR_ROLE,
  buildAzureDnsZoneScope,
  createAzureDnsError,
  extractAzureError
};