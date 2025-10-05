const SSLCertificate = require('../models/SSLCertificate');
const certificateValidator = require('../utils/certificateValidator');
const letsEncryptService = require('./letsEncryptService');
const fs = require('fs').promises;
const path = require('path');

class SSLService {
  constructor() {
    this.certificatesDir = path.join(__dirname, '..', 'certificates');
  }

  /**
   * Get SSL configuration status
   */
  async getSSLStatus() {
    try {
      console.log('Retrieving SSL status...');

      const certificates = await SSLCertificate.find()
        .sort({ createdAt: -1 })
        .select('-privateKey'); // Don't send private keys to frontend

      const activeCert = certificates.find(cert => cert.status === 'active' && !cert.isExpired());

      // Check for expiring certificates
      const expiringSoon = await SSLCertificate.getExpiringSoon(30);

      const status = {
        sslEnabled: !!activeCert,
        activeCertificate: activeCert ? {
          _id: activeCert._id,
          domain: activeCert.domain,
          provider: activeCert.provider,
          status: activeCert.status,
          expiryDate: activeCert.expiryDate,
          issuedDate: activeCert.issuedDate,
          issuer: activeCert.issuer,
          subject: activeCert.subject,
          subjectAltNames: activeCert.subjectAltNames,
          daysUntilExpiry: Math.floor((activeCert.expiryDate - Date.now()) / (1000 * 60 * 60 * 24))
        } : null,
        certificates: certificates.map(cert => ({
          _id: cert._id,
          domain: cert.domain,
          provider: cert.provider,
          status: cert.status,
          expiryDate: cert.expiryDate,
          issuedDate: cert.issuedDate,
          issuer: cert.issuer,
          isExpired: cert.isExpired(),
          isExpiringSoon: cert.isExpiringSoon(),
          autoRenew: cert.autoRenew
        })),
        expiringSoon: expiringSoon.length,
        warnings: []
      };

      if (expiringSoon.length > 0) {
        status.warnings.push(`${expiringSoon.length} certificate(s) expiring within 30 days`);
      }

      console.log('SSL status retrieved successfully');
      return status;
    } catch (error) {
      console.error('Error getting SSL status:', error);
      throw error;
    }
  }

  /**
   * Generate a Certificate Signing Request (CSR)
   */
  async generateCSR(csrData) {
    try {
      console.log(`Generating CSR for ${csrData.commonName}...`);

      const result = certificateValidator.generateCSR(csrData);

      if (!result.success) {
        throw new Error(result.error);
      }

      // Save CSR to database for tracking
      const certificate = new SSLCertificate({
        domain: csrData.commonName,
        certificate: '', // Will be filled when certificate is uploaded
        privateKey: '', // Will be filled when certificate is uploaded
        status: 'pending',
        provider: 'manual',
        csr: result.csr,
        subject: {
          commonName: csrData.commonName,
          organization: csrData.organization,
          organizationalUnit: csrData.organizationalUnit,
          locality: csrData.locality,
          state: csrData.state,
          country: csrData.country,
          emailAddress: csrData.emailAddress
        },
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // Placeholder
        issuedDate: new Date()
      });

      // Encrypt and store private key
      certificate.privateKey = certificate.encryptPrivateKey(result.privateKey);

      await certificate.save();

      console.log('CSR generated and saved successfully');

      return {
        success: true,
        certificateId: certificate._id,
        csr: result.csr,
        message: 'CSR generated successfully. Use this CSR to obtain a certificate from your certificate provider.'
      };
    } catch (error) {
      console.error('CSR generation error:', error);
      throw error;
    }
  }

  /**
   * Upload and install a certificate manually
   */
  async uploadCertificate(uploadData) {
    const { certificate, privateKey, certificateChain, domain, certificateId } = uploadData;

    try {
      console.log(`Uploading certificate for ${domain}...`);

      // Validate certificate
      const certInfo = certificateValidator.parseCertificate(certificate);
      if (!certInfo.valid) {
        throw new Error(`Invalid certificate: ${certInfo.error}`);
      }

      // Validate private key
      const keyInfo = certificateValidator.validatePrivateKey(privateKey);
      if (!keyInfo.valid) {
        throw new Error(`Invalid private key: ${keyInfo.error}`);
      }

      // Verify certificate and key match
      const keysMatch = certificateValidator.verifyCertificateKeyPair(certificate, privateKey);
      if (!keysMatch) {
        throw new Error('Certificate and private key do not match');
      }

      // Validate certificate chain if provided
      if (certificateChain) {
        const chainInfo = certificateValidator.validateCertificateChain(certificate, certificateChain);
        if (!chainInfo.valid) {
          console.warn('Certificate chain validation warning:', chainInfo.error || chainInfo.warning);
        }
      }

      // Check if certificate is already expired
      const expiryCheck = certificateValidator.checkCertificateExpiry(certificate);
      if (expiryCheck.expired) {
        throw new Error('Certificate is already expired');
      }

      let sslCert;

      if (certificateId) {
        // Update existing certificate (e.g., from CSR)
        sslCert = await SSLCertificate.findById(certificateId);
        if (!sslCert) {
          throw new Error('Certificate record not found');
        }
      } else {
        // Create new certificate
        sslCert = new SSLCertificate({
          domain: domain || certInfo.subject.commonName
        });
      }

      // Update certificate data
      sslCert.certificate = certificate;
      sslCert.privateKey = sslCert.encryptPrivateKey(privateKey);
      sslCert.certificateChain = certificateChain || '';
      sslCert.provider = 'manual';
      sslCert.status = 'inactive'; // Admin needs to activate it
      sslCert.expiryDate = certInfo.notAfter;
      sslCert.issuedDate = certInfo.notBefore;
      sslCert.subject = certInfo.subject;
      sslCert.issuer = certInfo.issuer;
      sslCert.subjectAltNames = certInfo.subjectAltNames;

      await sslCert.save();

      console.log(`Certificate for ${sslCert.domain} uploaded successfully`);

      return {
        success: true,
        certificateId: sslCert._id,
        message: 'Certificate uploaded successfully. You can now activate it.',
        certificate: {
          domain: sslCert.domain,
          expiryDate: sslCert.expiryDate,
          issuer: sslCert.issuer,
          subject: sslCert.subject
        }
      };
    } catch (error) {
      console.error('Certificate upload error:', error);
      throw error;
    }
  }

  /**
   * Activate a certificate
   */
  async activateCertificate(certificateId) {
    try {
      console.log(`Activating certificate ${certificateId}...`);

      const certificate = await SSLCertificate.findById(certificateId);
      if (!certificate) {
        throw new Error('Certificate not found');
      }

      // Check if certificate is expired
      if (certificate.isExpired()) {
        throw new Error('Cannot activate an expired certificate');
      }

      // Check if certificate has all required data
      if (!certificate.certificate || !certificate.privateKey) {
        throw new Error('Certificate is incomplete');
      }

      // Deactivate other certificates for this domain
      await SSLCertificate.deactivateOldCertificates(certificate.domain, certificateId);

      // Activate this certificate
      certificate.status = 'active';
      await certificate.save();

      // Write certificate files to disk for server use
      await this.writeCertificateToDisk(certificate);

      console.log(`Certificate ${certificateId} activated successfully`);

      return {
        success: true,
        message: 'Certificate activated successfully. Server will use this certificate for HTTPS.',
        requiresRestart: true
      };
    } catch (error) {
      console.error('Certificate activation error:', error);
      throw error;
    }
  }

  /**
   * Deactivate a certificate
   */
  async deactivateCertificate(certificateId) {
    try {
      console.log(`Deactivating certificate ${certificateId}...`);

      const certificate = await SSLCertificate.findById(certificateId);
      if (!certificate) {
        throw new Error('Certificate not found');
      }

      certificate.status = 'inactive';
      await certificate.save();

      console.log(`Certificate ${certificateId} deactivated successfully`);

      return {
        success: true,
        message: 'Certificate deactivated successfully'
      };
    } catch (error) {
      console.error('Certificate deactivation error:', error);
      throw error;
    }
  }

  /**
   * Delete a certificate
   */
  async deleteCertificate(certificateId) {
    try {
      console.log(`Deleting certificate ${certificateId}...`);

      const certificate = await SSLCertificate.findById(certificateId);
      if (!certificate) {
        throw new Error('Certificate not found');
      }

      if (certificate.status === 'active') {
        throw new Error('Cannot delete an active certificate. Deactivate it first.');
      }

      await certificate.deleteOne();

      console.log(`Certificate ${certificateId} deleted successfully`);

      return {
        success: true,
        message: 'Certificate deleted successfully'
      };
    } catch (error) {
      console.error('Certificate deletion error:', error);
      throw error;
    }
  }

  /**
   * Setup Let's Encrypt and obtain certificate
   */
  async setupLetsEncrypt(letsEncryptData) {
    const { domain, email, staging = false } = letsEncryptData;

    try {
      console.log(`Setting up Let's Encrypt for ${domain}...`);

      // Check if domain already has an active certificate
      const existing = await SSLCertificate.findOne({ domain, status: 'active' });
      if (existing && !existing.isExpired()) {
        console.warn(`Domain ${domain} already has an active certificate`);
      }

      // Obtain certificate from Let's Encrypt
      const result = await letsEncryptService.obtainCertificate({
        domain,
        email,
        staging,
        challengeType: 'http-01'
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      // Parse certificate
      const certInfo = certificateValidator.parseCertificate(result.certificate);

      // Deactivate old certificates for this domain
      await SSLCertificate.deactivateOldCertificates(domain);

      // Create new certificate in database
      const certificate = new SSLCertificate({
        domain,
        certificate: result.certificate,
        privateKey: '', // Will be set below
        certificateChain: result.chain,
        provider: 'letsencrypt',
        status: 'active',
        expiryDate: certInfo.notAfter,
        issuedDate: certInfo.notBefore,
        subject: certInfo.subject,
        issuer: certInfo.issuer,
        subjectAltNames: certInfo.subjectAltNames,
        autoRenew: true,
        letsEncrypt: {
          accountEmail: email,
          challengeType: 'http-01',
          autoRenew: true
        }
      });

      // Encrypt and store private key
      certificate.privateKey = certificate.encryptPrivateKey(result.privateKey);

      await certificate.save();

      // Write certificate files to disk
      await this.writeCertificateToDisk(certificate);

      console.log('Let\'s Encrypt certificate obtained and saved successfully');

      return {
        success: true,
        certificateId: certificate._id,
        message: 'Certificate obtained from Let\'s Encrypt successfully',
        certificate: {
          domain: certificate.domain,
          expiryDate: certificate.expiryDate,
          issuer: certificate.issuer,
          autoRenew: certificate.autoRenew
        },
        requiresRestart: true
      };
    } catch (error) {
      console.error('Let\'s Encrypt setup error:', error);
      throw error;
    }
  }

  /**
   * Renew a Let's Encrypt certificate
   */
  async renewLetsEncryptCertificate(certificateId) {
    try {
      console.log(`Renewing Let's Encrypt certificate ${certificateId}...`);

      const certificate = await SSLCertificate.findById(certificateId);
      if (!certificate) {
        throw new Error('Certificate not found');
      }

      const result = await letsEncryptService.renewCertificate(certificate);

      if (!result.success) {
        throw new Error(result.error);
      }

      // Parse new certificate
      const certInfo = certificateValidator.parseCertificate(result.certificate);

      // Update certificate
      certificate.certificate = result.certificate;
      certificate.privateKey = certificate.encryptPrivateKey(result.privateKey);
      certificate.certificateChain = result.chain;
      certificate.expiryDate = certInfo.notAfter;
      certificate.issuedDate = certInfo.notBefore;
      certificate.letsEncrypt.lastRenewalAttempt = new Date();
      certificate.letsEncrypt.renewalErrors = [];

      await certificate.save();

      // Write certificate files to disk
      if (certificate.status === 'active') {
        await this.writeCertificateToDisk(certificate);
      }

      console.log('Certificate renewed successfully');

      return {
        success: true,
        message: 'Certificate renewed successfully',
        certificate: {
          domain: certificate.domain,
          expiryDate: certificate.expiryDate,
          issuer: certificate.issuer
        },
        requiresRestart: certificate.status === 'active'
      };
    } catch (error) {
      console.error('Certificate renewal error:', error);
      throw error;
    }
  }

  /**
   * Get active certificate for HTTPS server
   */
  async getActiveCertificateForServer() {
    try {
      const activeCert = await SSLCertificate.findOne({
        status: 'active',
        expiryDate: { $gt: new Date() }
      }).sort({ expiryDate: -1 });

      if (!activeCert) {
        return null;
      }

      const privateKey = activeCert.decryptPrivateKey();
      const fullChain = activeCert.certificate + '\n' + (activeCert.certificateChain || '');

      return {
        key: privateKey,
        cert: fullChain,
        domain: activeCert.domain
      };
    } catch (error) {
      console.error('Error getting active certificate:', error);
      return null;
    }
  }

  /**
   * Write certificate to disk for server use
   */
  async writeCertificateToDisk(certificate) {
    try {
      await fs.mkdir(this.certificatesDir, { recursive: true });

      const certPath = path.join(this.certificatesDir, 'active-cert.pem');
      const keyPath = path.join(this.certificatesDir, 'active-key.pem');
      const chainPath = path.join(this.certificatesDir, 'active-chain.pem');

      const privateKey = certificate.decryptPrivateKey();
      const fullChain = certificate.certificate + '\n' + (certificate.certificateChain || '');

      await fs.writeFile(certPath, certificate.certificate, { mode: 0o600 });
      await fs.writeFile(keyPath, privateKey, { mode: 0o600 });
      await fs.writeFile(chainPath, fullChain, { mode: 0o600 });

      console.log('Certificate files written to disk');
    } catch (error) {
      console.error('Error writing certificate to disk:', error);
      throw error;
    }
  }

  /**
   * List all certificates
   */
  async listCertificates() {
    try {
      const certificates = await SSLCertificate.find()
        .sort({ createdAt: -1 })
        .select('-privateKey'); // Don't send private keys

      return certificates.map(cert => ({
        _id: cert._id,
        domain: cert.domain,
        provider: cert.provider,
        status: cert.status,
        expiryDate: cert.expiryDate,
        issuedDate: cert.issuedDate,
        issuer: cert.issuer,
        subject: cert.subject,
        subjectAltNames: cert.subjectAltNames,
        isExpired: cert.isExpired(),
        isExpiringSoon: cert.isExpiringSoon(),
        autoRenew: cert.autoRenew,
        letsEncrypt: cert.letsEncrypt,
        createdAt: cert.createdAt
      }));
    } catch (error) {
      console.error('Error listing certificates:', error);
      throw error;
    }
  }
}

module.exports = new SSLService();
