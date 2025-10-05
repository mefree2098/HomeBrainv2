import api from './api';

// Description: Get SSL configuration status
// Endpoint: GET /api/ssl/status
// Request: {}
// Response: { sslEnabled: boolean, activeCertificate: Object | null, certificates: Array, expiringSoon: number, warnings: Array }
export const getSSLStatus = async () => {
  try {
    const response = await api.get('/api/ssl/status');
    return response.data;
  } catch (error: any) {
    console.error('Error getting SSL status:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: List all SSL certificates
// Endpoint: GET /api/ssl/certificates
// Request: {}
// Response: { certificates: Array }
export const listCertificates = async () => {
  try {
    const response = await api.get('/api/ssl/certificates');
    return response.data;
  } catch (error: any) {
    console.error('Error listing certificates:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Generate Certificate Signing Request (CSR)
// Endpoint: POST /api/ssl/generate-csr
// Request: { commonName: string, organization?: string, organizationalUnit?: string, locality?: string, state?: string, country?: string, emailAddress?: string, keySize?: number }
// Response: { success: boolean, certificateId: string, csr: string, message: string }
export const generateCSR = async (csrData: {
  commonName: string;
  organization?: string;
  organizationalUnit?: string;
  locality?: string;
  state?: string;
  country?: string;
  emailAddress?: string;
  keySize?: number;
}) => {
  try {
    const response = await api.post('/api/ssl/generate-csr', csrData);
    return response.data;
  } catch (error: any) {
    console.error('Error generating CSR:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Upload certificate manually
// Endpoint: POST /api/ssl/upload
// Request: { certificate: string, privateKey: string, certificateChain?: string, domain?: string, certificateId?: string }
// Response: { success: boolean, certificateId: string, message: string, certificate: Object }
export const uploadCertificate = async (uploadData: {
  certificate: string;
  privateKey: string;
  certificateChain?: string;
  domain?: string;
  certificateId?: string;
}) => {
  try {
    const response = await api.post('/api/ssl/upload', uploadData);
    return response.data;
  } catch (error: any) {
    console.error('Error uploading certificate:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Activate a certificate
// Endpoint: POST /api/ssl/certificates/:id/activate
// Request: {}
// Response: { success: boolean, message: string, requiresRestart: boolean }
export const activateCertificate = async (certificateId: string) => {
  try {
    const response = await api.post(`/api/ssl/certificates/${certificateId}/activate`);
    return response.data;
  } catch (error: any) {
    console.error('Error activating certificate:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Deactivate a certificate
// Endpoint: POST /api/ssl/certificates/:id/deactivate
// Request: {}
// Response: { success: boolean, message: string }
export const deactivateCertificate = async (certificateId: string) => {
  try {
    const response = await api.post(`/api/ssl/certificates/${certificateId}/deactivate`);
    return response.data;
  } catch (error: any) {
    console.error('Error deactivating certificate:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Delete a certificate
// Endpoint: DELETE /api/ssl/certificates/:id
// Request: {}
// Response: { success: boolean, message: string }
export const deleteCertificate = async (certificateId: string) => {
  try {
    const response = await api.delete(`/api/ssl/certificates/${certificateId}`);
    return response.data;
  } catch (error: any) {
    console.error('Error deleting certificate:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Setup Let's Encrypt and obtain certificate
// Endpoint: POST /api/ssl/letsencrypt/setup
// Request: { domain: string, email: string, staging?: boolean }
// Response: { success: boolean, certificateId: string, message: string, certificate: Object, requiresRestart: boolean }
export const setupLetsEncrypt = async (letsEncryptData: {
  domain: string;
  email: string;
  staging?: boolean;
}) => {
  try {
    const response = await api.post('/api/ssl/letsencrypt/setup', letsEncryptData);
    return response.data;
  } catch (error: any) {
    console.error('Error setting up Let\'s Encrypt:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Renew Let's Encrypt certificate
// Endpoint: POST /api/ssl/letsencrypt/renew/:id
// Request: {}
// Response: { success: boolean, message: string, certificate: Object, requiresRestart: boolean }
export const renewLetsEncryptCertificate = async (certificateId: string) => {
  try {
    const response = await api.post(`/api/ssl/letsencrypt/renew/${certificateId}`);
    return response.data;
  } catch (error: any) {
    console.error('Error renewing certificate:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};
