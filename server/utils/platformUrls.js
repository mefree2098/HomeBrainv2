const { getConfiguredPublicOrigin, getRequestOrigin } = require('./publicOrigin');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOrigin(value) {
  const candidate = trimString(value).replace(/\/+$/, '');
  if (!candidate) {
    return '';
  }

  try {
    return new URL(candidate).origin;
  } catch (_error) {
    return '';
  }
}

function getHomeBrainPublicOrigin(req = null) {
  return req ? getRequestOrigin(req) : getConfiguredPublicOrigin();
}

function buildOriginFromHostname(hostname, fallbackOrigin = '') {
  const normalizedHostname = trimString(hostname).toLowerCase();
  if (!normalizedHostname) {
    return '';
  }

  try {
    const parsed = new URL(fallbackOrigin || 'https://freestonefamily.com');
    parsed.hostname = normalizedHostname;
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.origin;
  } catch (_error) {
    return '';
  }
}

function getAxiomPublicOrigin(req = null) {
  const explicitBaseUrl = normalizeOrigin(process.env.AXIOM_PUBLIC_BASE_URL || '');
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }

  const explicitRedirectUriOrigin = normalizeOrigin(
    process.env.OIDC_AXIOM_REDIRECT_URI || process.env.AXIOM_OIDC_REDIRECT_URI || ''
  );
  if (explicitRedirectUriOrigin) {
    return explicitRedirectUriOrigin;
  }

  const homeBrainOrigin = getHomeBrainPublicOrigin(req);
  const explicitHost = trimString(process.env.AXIOM_PUBLIC_HOST).toLowerCase();
  if (explicitHost) {
    return buildOriginFromHostname(explicitHost, homeBrainOrigin);
  }

  if (!homeBrainOrigin) {
    return '';
  }

  try {
    const parsed = new URL(homeBrainOrigin);
    const hostname = parsed.hostname.replace(/^www\./, '');
    parsed.hostname = `mail.${hostname}`;
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.origin;
  } catch (_error) {
    return '';
  }
}

function getAxiomCallbackUrl(req = null) {
  const axiomOrigin = getAxiomPublicOrigin(req);
  return axiomOrigin ? `${axiomOrigin}/api/identity/homebrain/callback` : '';
}

module.exports = {
  getHomeBrainPublicOrigin,
  getAxiomPublicOrigin,
  getAxiomCallbackUrl
};
