const PLACEHOLDER_SECRETS = new Set([
  'replace-me-with-a-random-secret',
  'change-me',
  'changeme',
  'secret',
  'password',
  'homebrain-ssl-secret'
]);

function trimSecret(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function describeSecretProblem(name, value) {
  const normalized = trimSecret(value);
  if (!normalized) {
    return `${name} is missing`;
  }

  if (PLACEHOLDER_SECRETS.has(normalized.toLowerCase())) {
    return `${name} is still set to a public placeholder`;
  }

  if (normalized.length < 32) {
    return `${name} must be at least 32 characters`;
  }

  return '';
}

function validateRequiredAuthSecrets(env = process.env) {
  return [
    describeSecretProblem('JWT_SECRET', env.JWT_SECRET),
    describeSecretProblem('REFRESH_TOKEN_SECRET', env.REFRESH_TOKEN_SECRET)
  ].filter(Boolean);
}

function assertRequiredAuthSecrets(env = process.env) {
  const problems = validateRequiredAuthSecrets(env);
  if (problems.length > 0) {
    throw new Error(`Invalid HomeBrain auth secret configuration: ${problems.join('; ')}`);
  }
}

function getJwtSecret() {
  const jwtSecret = trimSecret(process.env.JWT_SECRET);
  const problem = describeSecretProblem('JWT_SECRET', jwtSecret);
  if (problem) {
    throw new Error(problem);
  }
  return jwtSecret;
}

module.exports = {
  assertRequiredAuthSecrets,
  getJwtSecret,
  validateRequiredAuthSecrets
};
