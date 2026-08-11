const forge = require('node-forge');
const MAX_PEM_BYTES = 512 * 1024;
const MAX_CHAIN_CERTIFICATES = 10;
const CERTIFICATE_BEGIN = '-----BEGIN CERTIFICATE-----';
const CERTIFICATE_END = '-----END CERTIFICATE-----';

function validatePemSize(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  if (Buffer.byteLength(value, 'utf8') > MAX_PEM_BYTES) throw new Error(`${label} is too large`);
}

function extractCertificateBlocks(chainPem) {
  validatePemSize(chainPem, 'Certificate chain');
  const blocks = [];
  let cursor = 0;
  while (cursor < chainPem.length && blocks.length <= MAX_CHAIN_CERTIFICATES) {
    const begin = chainPem.indexOf(CERTIFICATE_BEGIN, cursor);
    if (begin === -1) break;
    const endMarker = chainPem.indexOf(CERTIFICATE_END, begin + CERTIFICATE_BEGIN.length);
    if (endMarker === -1) throw new Error('Certificate chain contains an incomplete PEM block');
    const end = endMarker + CERTIFICATE_END.length;
    blocks.push(`${chainPem.slice(begin, end)}\n`);
    cursor = end;
  }
  if (blocks.length > MAX_CHAIN_CERTIFICATES) {
    throw new Error(`Certificate chain exceeds ${MAX_CHAIN_CERTIFICATES} certificates`);
  }
  return blocks;
}

/**
 * Parse and validate a PEM certificate
 * @param {string} certPem - PEM formatted certificate
 * @returns {Object} Parsed certificate information
 */
function parseCertificate(certPem) {
  try {
    validatePemSize(certPem, 'Certificate');
    const cert = forge.pki.certificateFromPem(certPem);

    const notBefore = cert.validity.notBefore;
    const notAfter = cert.validity.notAfter;

    // Extract subject information
    const subject = {};
    cert.subject.attributes.forEach(attr => {
      if (attr.shortName === 'CN') subject.commonName = attr.value;
      if (attr.shortName === 'O') subject.organization = attr.value;
      if (attr.shortName === 'OU') subject.organizationalUnit = attr.value;
      if (attr.shortName === 'L') subject.locality = attr.value;
      if (attr.shortName === 'ST') subject.state = attr.value;
      if (attr.shortName === 'C') subject.country = attr.value;
      if (attr.name === 'emailAddress') subject.emailAddress = attr.value;
    });

    // Extract issuer information
    const issuer = {};
    cert.issuer.attributes.forEach(attr => {
      if (attr.shortName === 'CN') issuer.commonName = attr.value;
      if (attr.shortName === 'O') issuer.organization = attr.value;
      if (attr.shortName === 'C') issuer.country = attr.value;
    });

    // Extract Subject Alternative Names (SANs)
    const subjectAltNames = [];
    const altNamesExt = cert.getExtension('subjectAltName');
    if (altNamesExt && altNamesExt.altNames) {
      altNamesExt.altNames.forEach(altName => {
        if (altName.type === 2) { // DNS name
          subjectAltNames.push(altName.value);
        }
      });
    }

    return {
      valid: true,
      subject,
      issuer,
      notBefore,
      notAfter,
      subjectAltNames,
      serialNumber: cert.serialNumber,
      fingerprint: forge.md.sha256.create().update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()).digest().toHex()
    };
  } catch (error) {
    console.error('Certificate parsing error:', error);
    return {
      valid: false,
      error: error.message
    };
  }
}

/**
 * Validate a private key
 * @param {string} keyPem - PEM formatted private key
 * @returns {Object} Validation result
 */
function validatePrivateKey(keyPem) {
  try {
    validatePemSize(keyPem, 'Private key');
    // Try to parse as RSA key
    try {
      const key = forge.pki.privateKeyFromPem(keyPem);
      return {
        valid: true,
        type: 'RSA',
        bitSize: key.n.bitLength()
      };
    } catch (rsaError) {
      // Try to parse as EC key
      forge.pki.privateKeyFromPem(keyPem);
      return {
        valid: true,
        type: 'EC'
      };
    }
  } catch (error) {
    console.error('Private key validation error:', error);
    return {
      valid: false,
      error: error.message
    };
  }
}

/**
 * Verify that certificate and private key match
 * @param {string} certPem - PEM formatted certificate
 * @param {string} keyPem - PEM formatted private key
 * @returns {boolean} True if they match
 */
function verifyCertificateKeyPair(certPem, keyPem) {
  try {
    validatePemSize(certPem, 'Certificate');
    validatePemSize(keyPem, 'Private key');
    const cert = forge.pki.certificateFromPem(certPem);
    const privateKey = forge.pki.privateKeyFromPem(keyPem);
    const publicKey = cert.publicKey;

    // Create a test message
    const testMessage = 'test-message-for-verification';

    // Create signature with private key
    const md = forge.md.sha256.create();
    md.update(testMessage, 'utf8');
    const signature = privateKey.sign(md);

    // Verify signature with public key
    const verifyMd = forge.md.sha256.create();
    verifyMd.update(testMessage, 'utf8');
    const verified = publicKey.verify(verifyMd.digest().bytes(), signature);

    return verified;
  } catch (error) {
    console.error('Certificate-key pair verification error:', error);
    return false;
  }
}

/**
 * Generate a Certificate Signing Request (CSR)
 * @param {Object} options - CSR options
 * @returns {Object} Generated CSR and private key
 */
function generateCSR(options) {
  try {
    const {
      commonName,
      organization,
      organizationalUnit,
      locality,
      state,
      country,
      emailAddress,
      keySize = 2048
    } = options;

    const normalizedKeySize = [2048, 3072, 4096].includes(Number(keySize)) ? Number(keySize) : 2048;

    // Generate key pair
    console.log(`Generating ${normalizedKeySize}-bit RSA key pair for CSR...`);
    const keys = forge.pki.rsa.generateKeyPair(normalizedKeySize);

    // Create CSR
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;

    // Set subject
    const subjectAttrs = [];
    if (commonName) subjectAttrs.push({ name: 'commonName', value: commonName });
    if (country) subjectAttrs.push({ name: 'countryName', value: country });
    if (state) subjectAttrs.push({ name: 'stateOrProvinceName', value: state });
    if (locality) subjectAttrs.push({ name: 'localityName', value: locality });
    if (organization) subjectAttrs.push({ name: 'organizationName', value: organization });
    if (organizationalUnit) subjectAttrs.push({ name: 'organizationalUnitName', value: organizationalUnit });
    if (emailAddress) subjectAttrs.push({ name: 'emailAddress', value: emailAddress });

    csr.setSubject(subjectAttrs);

    // Sign CSR
    csr.sign(keys.privateKey);

    // Convert to PEM
    const csrPem = forge.pki.certificationRequestToPem(csr);
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

    console.log('CSR generated successfully');

    return {
      success: true,
      csr: csrPem,
      privateKey: privateKeyPem,
      publicKey: forge.pki.publicKeyToPem(keys.publicKey)
    };
  } catch (error) {
    console.error('CSR generation error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Validate certificate chain
 * @param {string} certPem - PEM formatted certificate
 * @param {string} chainPem - PEM formatted certificate chain
 * @returns {Object} Validation result
 */
function validateCertificateChain(certPem, chainPem) {
  try {
    validatePemSize(certPem, 'Certificate');
    const cert = forge.pki.certificateFromPem(certPem);

    if (!chainPem) {
      return { valid: true, warning: 'No chain provided' };
    }

    const chainCerts = extractCertificateBlocks(chainPem)
      .map((block) => forge.pki.certificateFromPem(block));

    if (chainCerts.length === 0) {
      return { valid: false, error: 'Invalid certificate chain format' };
    }

    const certificates = [cert, ...chainCerts];
    const now = new Date();
    for (const certificate of certificates) {
      if (certificate.validity.notBefore > now || certificate.validity.notAfter < now) {
        return { valid: false, error: 'Certificate chain contains a certificate outside its validity period' };
      }
    }
    for (let index = 0; index < certificates.length - 1; index += 1) {
      const child = certificates[index];
      const issuer = certificates[index + 1];
      if (!issuer.verify(child)) {
        return { valid: false, error: `Certificate chain signature verification failed at position ${index + 1}` };
      }
    }

    const root = certificates.at(-1);
    let rootIsSelfSigned = false;
    try {
      rootIsSelfSigned = root.isIssuer(root) && root.verify(root);
    } catch (_error) {
      rootIsSelfSigned = false;
    }
    return {
      valid: true,
      chainLength: chainCerts.length,
      ...(rootIsSelfSigned ? {} : { warning: 'Chain is internally valid but does not include a self-signed root' })
    };
  } catch (error) {
    console.error('Certificate chain validation error:', error);
    return {
      valid: false,
      error: error.message
    };
  }
}

/**
 * Check if certificate is expired or expiring soon
 * @param {string} certPem - PEM formatted certificate
 * @param {number} daysThreshold - Days before expiry to warn
 * @returns {Object} Expiry check result
 */
function checkCertificateExpiry(certPem, daysThreshold = 30) {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const now = new Date();
    const notAfter = cert.validity.notAfter;
    const daysUntilExpiry = Math.floor((notAfter - now) / (1000 * 60 * 60 * 24));

    return {
      expired: notAfter < now,
      expiringSoon: daysUntilExpiry <= daysThreshold && daysUntilExpiry > 0,
      daysUntilExpiry,
      expiryDate: notAfter
    };
  } catch (error) {
    console.error('Certificate expiry check error:', error);
    return {
      error: error.message
    };
  }
}

module.exports = {
  parseCertificate,
  validatePrivateKey,
  verifyCertificateKeyPair,
  generateCSR,
  validateCertificateChain,
  checkCertificateExpiry
};
module.exports.__private__ = { extractCertificateBlocks, validatePemSize };
