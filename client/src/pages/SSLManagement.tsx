import React, { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/useToast';
import { Shield, Upload, FileKey, Zap, RefreshCw } from 'lucide-react';
import CertificateStatus from '@/components/ssl/CertificateStatus';
import {
  getSSLStatus,
  generateCSR,
  uploadCertificate,
  setupLetsEncrypt,
  activateCertificate,
  deactivateCertificate,
  deleteCertificate,
  renewLetsEncryptCertificate
} from '@/api/ssl';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const SSLManagement = () => {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [sslStatus, setSSLStatus] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);

  // CSR Generation State
  const [csrForm, setCSRForm] = useState({
    commonName: '',
    organization: '',
    organizationalUnit: '',
    locality: '',
    state: '',
    country: '',
    emailAddress: '',
    keySize: 2048
  });
  const [generatedCSR, setGeneratedCSR] = useState('');

  // Certificate Upload State
  const [uploadForm, setUploadForm] = useState({
    certificate: '',
    privateKey: '',
    certificateChain: '',
    domain: ''
  });

  // Let's Encrypt State
  const [letsEncryptForm, setLetsEncryptForm] = useState({
    domain: '',
    email: '',
    staging: false
  });

  // Confirmation dialog state
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    action: () => void;
  }>({
    open: false,
    title: '',
    description: '',
    action: () => {}
  });

  useEffect(() => {
    loadSSLStatus();
  }, []);

  const loadSSLStatus = async () => {
    try {
      setRefreshing(true);
      const status = await getSSLStatus();
      setSSLStatus(status);
    } catch (error: any) {
      console.error('Error loading SSL status:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to load SSL status'
      });
    } finally {
      setRefreshing(false);
    }
  };

  const handleGenerateCSR = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const result = await generateCSR(csrForm);
      setGeneratedCSR(result.csr);

      toast({
        title: 'Success',
        description: result.message
      });

      // Reset form
      setCSRForm({
        commonName: '',
        organization: '',
        organizationalUnit: '',
        locality: '',
        state: '',
        country: '',
        emailAddress: '',
        keySize: 2048
      });

      await loadSSLStatus();
    } catch (error: any) {
      console.error('CSR generation error:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to generate CSR'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleUploadCertificate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const result = await uploadCertificate(uploadForm);

      toast({
        title: 'Success',
        description: result.message
      });

      // Reset form
      setUploadForm({
        certificate: '',
        privateKey: '',
        certificateChain: '',
        domain: ''
      });

      await loadSSLStatus();
    } catch (error: any) {
      console.error('Certificate upload error:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to upload certificate'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSetupLetsEncrypt = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const result = await setupLetsEncrypt(letsEncryptForm);

      toast({
        title: 'Success',
        description: result.message + (result.requiresRestart ? ' Please restart the server.' : '')
      });

      // Reset form
      setLetsEncryptForm({
        domain: '',
        email: '',
        staging: false
      });

      await loadSSLStatus();
    } catch (error: any) {
      console.error('Let\'s Encrypt setup error:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to setup Let\'s Encrypt'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleActivate = async (id: string) => {
    try {
      const result = await activateCertificate(id);
      toast({
        title: 'Success',
        description: result.message + (result.requiresRestart ? ' Please restart the server.' : '')
      });
      await loadSSLStatus();
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message
      });
    }
  };

  const handleDeactivate = async (id: string) => {
    setConfirmDialog({
      open: true,
      title: 'Deactivate Certificate',
      description: 'Are you sure you want to deactivate this certificate? HTTPS will be disabled.',
      action: async () => {
        try {
          const result = await deactivateCertificate(id);
          toast({
            title: 'Success',
            description: result.message
          });
          await loadSSLStatus();
        } catch (error: any) {
          toast({
            variant: 'destructive',
            title: 'Error',
            description: error.message
          });
        }
      }
    });
  };

  const handleDelete = async (id: string) => {
    setConfirmDialog({
      open: true,
      title: 'Delete Certificate',
      description: 'Are you sure you want to delete this certificate? This action cannot be undone.',
      action: async () => {
        try {
          const result = await deleteCertificate(id);
          toast({
            title: 'Success',
            description: result.message
          });
          await loadSSLStatus();
        } catch (error: any) {
          toast({
            variant: 'destructive',
            title: 'Error',
            description: error.message
          });
        }
      }
    });
  };

  const handleRenew = async (id: string) => {
    setLoading(true);
    try {
      const result = await renewLetsEncryptCertificate(id);
      toast({
        title: 'Success',
        description: result.message + (result.requiresRestart ? ' Please restart the server.' : '')
      });
      await loadSSLStatus();
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto py-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Shield className="h-8 w-8" />
            SSL Certificate Management
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage SSL/TLS certificates for secure HTTPS connections
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={loadSSLStatus}
          disabled={refreshing}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <Tabs defaultValue="status" className="space-y-6">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="status">Status</TabsTrigger>
          <TabsTrigger value="letsencrypt">Let's Encrypt</TabsTrigger>
          <TabsTrigger value="upload">Upload Certificate</TabsTrigger>
          <TabsTrigger value="csr">Generate CSR</TabsTrigger>
        </TabsList>

        {/* Status Tab */}
        <TabsContent value="status">
          {sslStatus ? (
            <CertificateStatus
              sslEnabled={sslStatus.sslEnabled}
              activeCertificate={sslStatus.activeCertificate}
              certificates={sslStatus.certificates}
              expiringSoon={sslStatus.expiringSoon}
              warnings={sslStatus.warnings}
              onActivate={handleActivate}
              onDeactivate={handleDeactivate}
              onDelete={handleDelete}
              onRenew={handleRenew}
            />
          ) : (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-muted-foreground">Loading SSL status...</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Let's Encrypt Tab */}
        <TabsContent value="letsencrypt">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Let's Encrypt - Free Automated Certificates
              </CardTitle>
              <CardDescription>
                Obtain and automatically renew free SSL certificates from Let's Encrypt
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSetupLetsEncrypt} className="space-y-4">
                <div>
                  <Label htmlFor="le-domain">Domain Name *</Label>
                  <Input
                    id="le-domain"
                    placeholder="example.com"
                    value={letsEncryptForm.domain}
                    onChange={(e) => setLetsEncryptForm({ ...letsEncryptForm, domain: e.target.value })}
                    required
                  />
                  <p className="text-sm text-muted-foreground mt-1">
                    The domain must point to this server's public IP address
                  </p>
                </div>

                <div>
                  <Label htmlFor="le-email">Email Address *</Label>
                  <Input
                    id="le-email"
                    type="email"
                    placeholder="admin@example.com"
                    value={letsEncryptForm.email}
                    onChange={(e) => setLetsEncryptForm({ ...letsEncryptForm, email: e.target.value })}
                    required
                  />
                  <p className="text-sm text-muted-foreground mt-1">
                    Used for renewal notifications and account recovery
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="le-staging"
                    checked={letsEncryptForm.staging}
                    onChange={(e) => setLetsEncryptForm({ ...letsEncryptForm, staging: e.target.checked })}
                    className="rounded"
                  />
                  <Label htmlFor="le-staging" className="cursor-pointer">
                    Use staging environment (for testing)
                  </Label>
                </div>

                <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
                  <h4 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">Requirements:</h4>
                  <ul className="text-sm text-blue-800 dark:text-blue-200 space-y-1">
                    <li>• Your domain must be publicly accessible via HTTP on port 80</li>
                    <li>• DNS records must be configured to point to this server</li>
                    <li>• The server must be able to respond to HTTP-01 challenges</li>
                    <li>• Certificates are automatically renewed 30 days before expiry</li>
                  </ul>
                </div>

                <Button type="submit" disabled={loading} className="w-full">
                  {loading ? 'Obtaining Certificate...' : 'Obtain Certificate'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Upload Certificate Tab */}
        <TabsContent value="upload">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5" />
                Upload Certificate
              </CardTitle>
              <CardDescription>
                Upload a certificate obtained from any certificate authority
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleUploadCertificate} className="space-y-4">
                <div>
                  <Label htmlFor="cert-domain">Domain Name (optional)</Label>
                  <Input
                    id="cert-domain"
                    placeholder="example.com"
                    value={uploadForm.domain}
                    onChange={(e) => setUploadForm({ ...uploadForm, domain: e.target.value })}
                  />
                  <p className="text-sm text-muted-foreground mt-1">
                    Leave empty to auto-detect from certificate
                  </p>
                </div>

                <div>
                  <Label htmlFor="certificate">Certificate (PEM format) *</Label>
                  <Textarea
                    id="certificate"
                    placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                    rows={8}
                    value={uploadForm.certificate}
                    onChange={(e) => setUploadForm({ ...uploadForm, certificate: e.target.value })}
                    required
                    className="font-mono text-sm"
                  />
                </div>

                <div>
                  <Label htmlFor="privateKey">Private Key (PEM format) *</Label>
                  <Textarea
                    id="privateKey"
                    placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                    rows={8}
                    value={uploadForm.privateKey}
                    onChange={(e) => setUploadForm({ ...uploadForm, privateKey: e.target.value })}
                    required
                    className="font-mono text-sm"
                  />
                </div>

                <div>
                  <Label htmlFor="certificateChain">Certificate Chain (optional)</Label>
                  <Textarea
                    id="certificateChain"
                    placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                    rows={6}
                    value={uploadForm.certificateChain}
                    onChange={(e) => setUploadForm({ ...uploadForm, certificateChain: e.target.value })}
                    className="font-mono text-sm"
                  />
                  <p className="text-sm text-muted-foreground mt-1">
                    Intermediate certificates from your CA
                  </p>
                </div>

                <Button type="submit" disabled={loading} className="w-full">
                  {loading ? 'Uploading...' : 'Upload Certificate'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        {/* CSR Generation Tab */}
        <TabsContent value="csr">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileKey className="h-5 w-5" />
                Generate Certificate Signing Request (CSR)
              </CardTitle>
              <CardDescription>
                Generate a CSR to obtain a certificate from a certificate authority
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleGenerateCSR} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="commonName">Common Name (Domain) *</Label>
                    <Input
                      id="commonName"
                      placeholder="example.com"
                      value={csrForm.commonName}
                      onChange={(e) => setCSRForm({ ...csrForm, commonName: e.target.value })}
                      required
                    />
                  </div>

                  <div>
                    <Label htmlFor="organization">Organization</Label>
                    <Input
                      id="organization"
                      placeholder="My Company"
                      value={csrForm.organization}
                      onChange={(e) => setCSRForm({ ...csrForm, organization: e.target.value })}
                    />
                  </div>

                  <div>
                    <Label htmlFor="organizationalUnit">Department</Label>
                    <Input
                      id="organizationalUnit"
                      placeholder="IT"
                      value={csrForm.organizationalUnit}
                      onChange={(e) => setCSRForm({ ...csrForm, organizationalUnit: e.target.value })}
                    />
                  </div>

                  <div>
                    <Label htmlFor="locality">City</Label>
                    <Input
                      id="locality"
                      placeholder="San Francisco"
                      value={csrForm.locality}
                      onChange={(e) => setCSRForm({ ...csrForm, locality: e.target.value })}
                    />
                  </div>

                  <div>
                    <Label htmlFor="state">State/Province</Label>
                    <Input
                      id="state"
                      placeholder="California"
                      value={csrForm.state}
                      onChange={(e) => setCSRForm({ ...csrForm, state: e.target.value })}
                    />
                  </div>

                  <div>
                    <Label htmlFor="country">Country Code (2 letters)</Label>
                    <Input
                      id="country"
                      placeholder="US"
                      maxLength={2}
                      value={csrForm.country}
                      onChange={(e) => setCSRForm({ ...csrForm, country: e.target.value.toUpperCase() })}
                    />
                  </div>

                  <div>
                    <Label htmlFor="emailAddress">Email Address</Label>
                    <Input
                      id="emailAddress"
                      type="email"
                      placeholder="admin@example.com"
                      value={csrForm.emailAddress}
                      onChange={(e) => setCSRForm({ ...csrForm, emailAddress: e.target.value })}
                    />
                  </div>

                  <div>
                    <Label htmlFor="keySize">Key Size (bits)</Label>
                    <select
                      id="keySize"
                      value={csrForm.keySize}
                      onChange={(e) => setCSRForm({ ...csrForm, keySize: parseInt(e.target.value) })}
                      className="w-full px-3 py-2 border rounded-md"
                    >
                      <option value={2048}>2048</option>
                      <option value={4096}>4096</option>
                    </select>
                  </div>
                </div>

                <Button type="submit" disabled={loading} className="w-full">
                  {loading ? 'Generating...' : 'Generate CSR'}
                </Button>

                {generatedCSR && (
                  <div className="mt-4 space-y-2">
                    <Label>Generated CSR</Label>
                    <Textarea
                      value={generatedCSR}
                      readOnly
                      rows={12}
                      className="font-mono text-sm"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        navigator.clipboard.writeText(generatedCSR);
                        toast({
                          title: 'Copied',
                          description: 'CSR copied to clipboard'
                        });
                      }}
                    >
                      Copy to Clipboard
                    </Button>
                    <p className="text-sm text-muted-foreground">
                      Submit this CSR to your certificate authority to obtain a certificate.
                      Once you receive the certificate, upload it in the "Upload Certificate" tab.
                    </p>
                  </div>
                )}
              </form>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Confirmation Dialog */}
      <AlertDialog open={confirmDialog.open} onOpenChange={(open) => setConfirmDialog({ ...confirmDialog, open })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmDialog.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmDialog.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              confirmDialog.action();
              setConfirmDialog({ ...confirmDialog, open: false });
            }}>
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default SSLManagement;
