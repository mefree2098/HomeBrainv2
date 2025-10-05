const acme = require('acme-client');
const fs = require('fs').promises;
const path = require('path');
const SSLCertificate = require('../models/SSLCertificate');

class LetsEncryptService {
  constructor() {
    this.certificatesDir = path.join(__dirname, '..', 'certificates');
    this.challengeDir = path.join(__dirname, '..', 'public', '.well-known', 'acme-challenge');
    this.accountKeyPath = path.join(this.certificatesDir, 'letsencrypt-account-key.pem');
  }

  /**
   * Initialize directories for certificates and challenges
   */
  async initializeDirectories() {
    try {
      await fs.mkdir(this.certificatesDir, { recursive: true });
      await fs.mkdir(this.challengeDir, { recursive: true });
      console.log('Let\'s Encrypt directories initialized');
    } catch (error) {
      console.error('Error initializing directories:', error);
      throw error;
    }
  }

  /**
   * Get or create ACME account key
   */
  async getOrCreateAccountKey() {
    try {
      // Try to read existing account key
      try {
        const accountKey = await fs.readFile(this.accountKeyPath, 'utf8');
        console.log('Using existing Let\'s Encrypt account key');
        return accountKey;
      } catch (readError) {
        // Generate new account key
        console.log('Generating new Let\'s Encrypt account key...');
        const accountKey = await acme.forge.createPrivateKey();
        await fs.writeFile(this.accountKeyPath, accountKey);
        console.log('Let\'s Encrypt account key generated and saved');
        return accountKey;
      }
    } catch (error) {
      console.error('Error with account key:', error);
      throw error;
    }
  }

  /**
   * Create ACME client
   * @param {boolean} staging - Use staging environment
   */
  async createClient(staging = false) {
    try {
      await this.initializeDirectories();
      const accountKey = await this.getOrCreateAccountKey();

      const directoryUrl = staging
        ? acme.directory.letsencrypt.staging
        : acme.directory.letsencrypt.production;

      console.log(`Creating ACME client (${staging ? 'staging' : 'production'})...`);

      const client = new acme.Client({
        directoryUrl,
        accountKey
      });

      return client;
    } catch (error) {
      console.error('Error creating ACME client:', error);
      throw error;
    }
  }

  /**
   * Obtain certificate from Let's Encrypt
   * @param {Object} options - Certificate options
   */
  async obtainCertificate(options) {
    const {
      domain,
      email,
      staging = false,
      challengeType = 'http-01'
    } = options;

    console.log(`Starting Let's Encrypt certificate obtainment for ${domain}...`);

    try {
      // Create ACME client
      const client = await this.createClient(staging);

      // Create certificate signing request
      console.log('Creating CSR...');
      const [certificateKey, csr] = await acme.forge.createCsr({
        commonName: domain,
        altNames: [domain]
      });

      // Create account or use existing
      console.log('Creating/updating ACME account...');
      await client.createAccount({
        termsOfServiceAgreed: true,
        contact: [`mailto:${email}`]
      });

      // Start certificate order
      console.log('Creating certificate order...');
      const order = await client.createOrder({
        identifiers: [
          { type: 'dns', value: domain }
        ]
      });

      // Get authorizations
      const authorizations = await client.getAuthorizations(order);
      console.log(`Processing ${authorizations.length} authorization(s)...`);

      // Process each authorization
      for (const authz of authorizations) {
        const challenge = authz.challenges.find(c => c.type === challengeType);

        if (!challenge) {
          throw new Error(`Challenge type ${challengeType} not available`);
        }

        if (challengeType === 'http-01') {
          // Handle HTTP-01 challenge
          const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
          const challengePath = path.join(this.challengeDir, challenge.token);

          console.log(`Setting up HTTP-01 challenge at: ${challengePath}`);
          await fs.writeFile(challengePath, keyAuthorization);

          try {
            // Verify challenge
            console.log('Verifying challenge...');
            await client.verifyChallenge(authz, challenge);

            // Complete challenge
            console.log('Completing challenge...');
            await client.completeChallenge(challenge);

            // Wait for validation
            console.log('Waiting for validation...');
            await client.waitForValidStatus(challenge);

            console.log('Challenge validated successfully');
          } finally {
            // Clean up challenge file
            try {
              await fs.unlink(challengePath);
            } catch (unlinkError) {
              console.error('Error removing challenge file:', unlinkError);
            }
          }
        } else {
          throw new Error(`Challenge type ${challengeType} not implemented yet`);
        }
      }

      // Finalize order
      console.log('Finalizing certificate order...');
      await client.finalizeOrder(order, csr);

      // Get certificate
      console.log('Retrieving certificate...');
      const certificate = await client.getCertificate(order);

      // Parse certificate to extract chain
      const certMatch = certificate.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
      const mainCert = certMatch ? certMatch[0] : certificate;
      const chainCerts = certMatch && certMatch.length > 1 ? certMatch.slice(1).join('\n') : '';

      console.log('Certificate obtained successfully from Let\'s Encrypt');

      return {
        success: true,
        certificate: mainCert,
        privateKey: certificateKey,
        chain: chainCerts,
        fullChain: certificate
      };
    } catch (error) {
      console.error('Let\'s Encrypt certificate obtainment error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Renew an existing Let's Encrypt certificate
   * @param {Object} sslCertificate - SSL certificate document from database
   */
  async renewCertificate(sslCertificate) {
    console.log(`Starting certificate renewal for ${sslCertificate.domain}...`);

    if (sslCertificate.provider !== 'letsencrypt') {
      throw new Error('Certificate is not from Let\'s Encrypt');
    }

    if (!sslCertificate.letsEncrypt || !sslCertificate.letsEncrypt.accountEmail) {
      throw new Error('Let\'s Encrypt configuration missing');
    }

    try {
      const result = await this.obtainCertificate({
        domain: sslCertificate.domain,
        email: sslCertificate.letsEncrypt.accountEmail,
        staging: false,
        challengeType: sslCertificate.letsEncrypt.challengeType
      });

      if (!result.success) {
        // Update renewal error
        sslCertificate.letsEncrypt.lastRenewalAttempt = new Date();
        sslCertificate.letsEncrypt.renewalErrors = sslCertificate.letsEncrypt.renewalErrors || [];
        sslCertificate.letsEncrypt.renewalErrors.push(`${new Date().toISOString()}: ${result.error}`);
        await sslCertificate.save();

        throw new Error(result.error);
      }

      return result;
    } catch (error) {
      console.error('Certificate renewal error:', error);
      throw error;
    }
  }

  /**
   * Check and auto-renew expiring certificates
   */
  async autoRenewCertificates() {
    console.log('Checking for certificates that need renewal...');

    try {
      const expiringSoon = await SSLCertificate.getExpiringSoon(30);

      if (expiringSoon.length === 0) {
        console.log('No certificates need renewal');
        return { renewed: 0, failed: 0 };
      }

      console.log(`Found ${expiringSoon.length} certificate(s) expiring soon`);

      let renewed = 0;
      let failed = 0;

      for (const cert of expiringSoon) {
        if (cert.provider === 'letsencrypt' && cert.letsEncrypt && cert.letsEncrypt.autoRenew) {
          try {
            console.log(`Renewing certificate for ${cert.domain}...`);
            const result = await this.renewCertificate(cert);

            if (result.success) {
              // Update certificate in database
              const certValidator = require('../utils/certificateValidator');
              const parsed = certValidator.parseCertificate(result.certificate);

              cert.certificate = result.certificate;
              cert.privateKey = cert.encryptPrivateKey(result.privateKey);
              cert.certificateChain = result.chain;
              cert.expiryDate = parsed.notAfter;
              cert.issuedDate = parsed.notBefore;
              cert.letsEncrypt.lastRenewalAttempt = new Date();
              cert.letsEncrypt.renewalErrors = [];

              await cert.save();

              renewed++;
              console.log(`Certificate for ${cert.domain} renewed successfully`);
            }
          } catch (error) {
            console.error(`Failed to renew certificate for ${cert.domain}:`, error);
            failed++;
          }
        }
      }

      console.log(`Auto-renewal complete: ${renewed} renewed, ${failed} failed`);

      return { renewed, failed };
    } catch (error) {
      console.error('Auto-renewal check error:', error);
      throw error;
    }
  }
}

module.exports = new LetsEncryptService();
