import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckCircle2, AlertTriangle, XCircle, Calendar, Shield, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';

interface Certificate {
  _id: string;
  domain: string;
  provider: 'manual' | 'letsencrypt';
  status: 'active' | 'inactive' | 'expired' | 'pending';
  expiryDate: string;
  issuedDate: string;
  issuer: {
    commonName?: string;
    organization?: string;
  };
  isExpired: boolean;
  isExpiringSoon: boolean;
  autoRenew: boolean;
}

interface CertificateStatusProps {
  sslEnabled: boolean;
  activeCertificate: any;
  certificates: Certificate[];
  expiringSoon: number;
  warnings: string[];
  onActivate: (id: string) => void;
  onDeactivate: (id: string) => void;
  onDelete: (id: string) => void;
  onRenew: (id: string) => void;
}

const CertificateStatus: React.FC<CertificateStatusProps> = ({
  sslEnabled,
  activeCertificate,
  certificates,
  expiringSoon,
  warnings,
  onActivate,
  onDeactivate,
  onDelete,
  onRenew
}) => {
  const getStatusIcon = (cert: Certificate) => {
    if (cert.status === 'active' && !cert.isExpired) {
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    } else if (cert.isExpired) {
      return <XCircle className="h-5 w-5 text-red-500" />;
    } else if (cert.isExpiringSoon) {
      return <AlertTriangle className="h-5 w-5 text-yellow-500" />;
    }
    return <Shield className="h-5 w-5 text-gray-500" />;
  };

  const getStatusBadge = (cert: Certificate) => {
    if (cert.isExpired) {
      return <Badge variant="destructive">Expired</Badge>;
    } else if (cert.status === 'active') {
      return <Badge className="bg-green-600">Active</Badge>;
    } else if (cert.status === 'pending') {
      return <Badge variant="outline">Pending</Badge>;
    }
    return <Badge variant="secondary">Inactive</Badge>;
  };

  const formatDate = (dateString: string) => {
    try {
      return format(new Date(dateString), 'MMM dd, yyyy');
    } catch {
      return dateString;
    }
  };

  const getDaysUntilExpiry = (expiryDate: string) => {
    const days = Math.floor((new Date(expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    return days;
  };

  return (
    <div className="space-y-6">
      {/* SSL Status Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-6 w-6" />
            SSL/TLS Status
          </CardTitle>
          <CardDescription>
            Current SSL certificate configuration and status
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">HTTPS Enabled:</span>
              <Badge variant={sslEnabled ? "default" : "secondary"}>
                {sslEnabled ? 'Yes' : 'No'}
              </Badge>
            </div>

            {activeCertificate && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Domain:</span>
                  <span className="text-sm">{activeCertificate.domain}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Expires:</span>
                  <span className="text-sm">{formatDate(activeCertificate.expiryDate)}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Days Remaining:</span>
                  <Badge variant={activeCertificate.daysUntilExpiry < 30 ? "destructive" : "default"}>
                    {activeCertificate.daysUntilExpiry} days
                  </Badge>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Issuer:</span>
                  <span className="text-sm">{activeCertificate.issuer?.commonName || 'Unknown'}</span>
                </div>
              </>
            )}

            {warnings.length > 0 && (
              <div className="mt-4 p-3 bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5" />
                  <div className="flex-1">
                    <h4 className="text-sm font-medium text-yellow-800 dark:text-yellow-200 mb-1">Warnings</h4>
                    <ul className="text-sm text-yellow-700 dark:text-yellow-300 space-y-1">
                      {warnings.map((warning, index) => (
                        <li key={index}>• {warning}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Certificates List */}
      <Card>
        <CardHeader>
          <CardTitle>Installed Certificates</CardTitle>
          <CardDescription>
            Manage your SSL certificates
          </CardDescription>
        </CardHeader>
        <CardContent>
          {certificates.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Shield className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>No certificates installed</p>
              <p className="text-sm">Upload a certificate or obtain one from Let's Encrypt</p>
            </div>
          ) : (
            <div className="space-y-4">
              {certificates.map((cert) => (
                <div
                  key={cert._id}
                  className="p-4 border rounded-lg space-y-3"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      {getStatusIcon(cert)}
                      <div>
                        <h4 className="font-semibold">{cert.domain}</h4>
                        <p className="text-sm text-muted-foreground">
                          {cert.provider === 'letsencrypt' ? "Let's Encrypt" : 'Manual Upload'}
                        </p>
                      </div>
                    </div>
                    {getStatusBadge(cert)}
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-muted-foreground">Issued:</span>
                      <br />
                      <span>{formatDate(cert.issuedDate)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Expires:</span>
                      <br />
                      <span className={cert.isExpiringSoon || cert.isExpired ? 'text-red-600' : ''}>
                        {formatDate(cert.expiryDate)}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Issuer:</span>
                      <br />
                      <span>{cert.issuer?.commonName || 'Unknown'}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Auto-Renew:</span>
                      <br />
                      <Badge variant={cert.autoRenew ? "default" : "outline"} className="text-xs">
                        {cert.autoRenew ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </div>
                  </div>

                  {cert.isExpiringSoon && !cert.isExpired && (
                    <div className="flex items-center gap-2 p-2 bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800 rounded text-sm">
                      <AlertTriangle className="h-4 w-4 text-yellow-600" />
                      <span className="text-yellow-700 dark:text-yellow-300">
                        Expires in {getDaysUntilExpiry(cert.expiryDate)} days
                      </span>
                    </div>
                  )}

                  <div className="flex gap-2 pt-2">
                    {cert.status === 'active' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onDeactivate(cert._id)}
                      >
                        Deactivate
                      </Button>
                    ) : (
                      !cert.isExpired && cert.status !== 'pending' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onActivate(cert._id)}
                        >
                          Activate
                        </Button>
                      )
                    )}

                    {cert.provider === 'letsencrypt' && !cert.isExpired && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onRenew(cert._id)}
                      >
                        <RefreshCw className="h-4 w-4 mr-1" />
                        Renew
                      </Button>
                    )}

                    {cert.status !== 'active' && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => onDelete(cert._id)}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default CertificateStatus;
