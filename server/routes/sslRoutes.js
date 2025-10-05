const express = require('express');
const router = express.Router();
const { requireUser } = require('./middlewares/auth');
const sslService = require('../services/sslService');
const { ROLES } = require('../../shared/config/roles');

// All SSL routes require authentication and admin role
router.use(requireUser([ROLES.ADMIN]));

// Description: Get SSL configuration status
// Endpoint: GET /api/ssl/status
// Request: {}
// Response: { sslEnabled: boolean, activeCertificate: Object, certificates: Array, expiringSoon: number, warnings: Array }
router.get('/status', async (req, res) => {
  try {
    console.log('GET /api/ssl/status - Retrieving SSL status');

    const status = await sslService.getSSLStatus();

    res.status(200).json(status);
  } catch (error) {
    console.error('Error getting SSL status:', error);
    res.status(500).json({
      error: 'Failed to get SSL status',
      message: error.message
    });
  }
});

// Description: List all certificates
// Endpoint: GET /api/ssl/certificates
// Request: {}
// Response: { certificates: Array }
router.get('/certificates', async (req, res) => {
  try {
    console.log('GET /api/ssl/certificates - Listing all certificates');

    const certificates = await sslService.listCertificates();

    res.status(200).json({ certificates });
  } catch (error) {
    console.error('Error listing certificates:', error);
    res.status(500).json({
      error: 'Failed to list certificates',
      message: error.message
    });
  }
});

// Description: Generate Certificate Signing Request (CSR)
// Endpoint: POST /api/ssl/generate-csr
// Request: { commonName: string, organization?: string, organizationalUnit?: string, locality?: string, state?: string, country?: string, emailAddress?: string, keySize?: number }
// Response: { success: boolean, certificateId: string, csr: string, message: string }
router.post('/generate-csr', async (req, res) => {
  try {
    const csrData = req.body;

    console.log('POST /api/ssl/generate-csr - Generating CSR for:', csrData.commonName);

    if (!csrData.commonName) {
      return res.status(400).json({
        error: 'Common name (domain) is required'
      });
    }

    const result = await sslService.generateCSR(csrData);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error generating CSR:', error);
    res.status(500).json({
      error: 'Failed to generate CSR',
      message: error.message
    });
  }
});

// Description: Upload certificate manually
// Endpoint: POST /api/ssl/upload
// Request: { certificate: string, privateKey: string, certificateChain?: string, domain?: string, certificateId?: string }
// Response: { success: boolean, certificateId: string, message: string, certificate: Object }
router.post('/upload', async (req, res) => {
  try {
    const uploadData = req.body;

    console.log('POST /api/ssl/upload - Uploading certificate for:', uploadData.domain || 'auto-detect');

    if (!uploadData.certificate || !uploadData.privateKey) {
      return res.status(400).json({
        error: 'Certificate and private key are required'
      });
    }

    const result = await sslService.uploadCertificate(uploadData);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error uploading certificate:', error);
    res.status(500).json({
      error: 'Failed to upload certificate',
      message: error.message
    });
  }
});

// Description: Activate a certificate
// Endpoint: POST /api/ssl/certificates/:id/activate
// Request: {}
// Response: { success: boolean, message: string, requiresRestart: boolean }
router.post('/certificates/:id/activate', async (req, res) => {
  try {
    const { id } = req.params;

    console.log('POST /api/ssl/certificates/:id/activate - Activating certificate:', id);

    const result = await sslService.activateCertificate(id);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error activating certificate:', error);
    res.status(500).json({
      error: 'Failed to activate certificate',
      message: error.message
    });
  }
});

// Description: Deactivate a certificate
// Endpoint: POST /api/ssl/certificates/:id/deactivate
// Request: {}
// Response: { success: boolean, message: string }
router.post('/certificates/:id/deactivate', async (req, res) => {
  try {
    const { id } = req.params;

    console.log('POST /api/ssl/certificates/:id/deactivate - Deactivating certificate:', id);

    const result = await sslService.deactivateCertificate(id);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error deactivating certificate:', error);
    res.status(500).json({
      error: 'Failed to deactivate certificate',
      message: error.message
    });
  }
});

// Description: Delete a certificate
// Endpoint: DELETE /api/ssl/certificates/:id
// Request: {}
// Response: { success: boolean, message: string }
router.delete('/certificates/:id', async (req, res) => {
  try {
    const { id } = req.params;

    console.log('DELETE /api/ssl/certificates/:id - Deleting certificate:', id);

    const result = await sslService.deleteCertificate(id);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error deleting certificate:', error);
    res.status(500).json({
      error: 'Failed to delete certificate',
      message: error.message
    });
  }
});

// Description: Setup Let's Encrypt and obtain certificate
// Endpoint: POST /api/ssl/letsencrypt/setup
// Request: { domain: string, email: string, staging?: boolean }
// Response: { success: boolean, certificateId: string, message: string, certificate: Object, requiresRestart: boolean }
router.post('/letsencrypt/setup', async (req, res) => {
  try {
    const letsEncryptData = req.body;

    console.log('POST /api/ssl/letsencrypt/setup - Setting up Let\'s Encrypt for:', letsEncryptData.domain);

    if (!letsEncryptData.domain || !letsEncryptData.email) {
      return res.status(400).json({
        error: 'Domain and email are required'
      });
    }

    const result = await sslService.setupLetsEncrypt(letsEncryptData);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error setting up Let\'s Encrypt:', error);
    res.status(500).json({
      error: 'Failed to setup Let\'s Encrypt',
      message: error.message
    });
  }
});

// Description: Renew Let's Encrypt certificate
// Endpoint: POST /api/ssl/letsencrypt/renew/:id
// Request: {}
// Response: { success: boolean, message: string, certificate: Object, requiresRestart: boolean }
router.post('/letsencrypt/renew/:id', async (req, res) => {
  try {
    const { id } = req.params;

    console.log('POST /api/ssl/letsencrypt/renew/:id - Renewing certificate:', id);

    const result = await sslService.renewLetsEncryptCertificate(id);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error renewing certificate:', error);
    res.status(500).json({
      error: 'Failed to renew certificate',
      message: error.message
    });
  }
});

module.exports = router;
