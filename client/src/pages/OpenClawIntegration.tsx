import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/useToast';
import {
  downloadOpenClawBundle,
  getOpenClawStatus,
  revokeOpenClawToken,
  rotateOpenClawToken,
  type OpenClawIntegrationStatusResponse,
  updateOpenClawSettings
} from '@/api/openclaw';
import { Bot, Copy, Download, KeyRound, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';

const formatTimestamp = (value?: string | null) => {
  if (!value) {
    return 'Never';
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Date(parsed).toLocaleString();
};

type OpenClawIntegrationProps = {
  embedded?: boolean;
};

export function OpenClawIntegration({ embedded = false }: OpenClawIntegrationProps) {
  const { toast } = useToast();
  const [status, setStatus] = useState<OpenClawIntegrationStatusResponse | null>(null);
  const [displayName, setDisplayName] = useState('HomeBrain OpenClaw Admin');
  const [publishedBaseUrl, setPublishedBaseUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rotatingToken, setRotatingToken] = useState(false);
  const [revokingToken, setRevokingToken] = useState(false);
  const [downloadingBundle, setDownloadingBundle] = useState(false);
  const [freshToken, setFreshToken] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const applyStatus = (nextStatus: OpenClawIntegrationStatusResponse) => {
    setStatus(nextStatus);
    setDisplayName(nextStatus.integration.displayName || 'HomeBrain OpenClaw Admin');
    setPublishedBaseUrl(nextStatus.integration.publishedBaseUrl || '');
    setNotes(nextStatus.integration.notes || '');
    setEnabled(nextStatus.integration.enabled !== false);
  };

  const loadStatus = async (preserveToken = true) => {
    try {
      setLoading(true);
      setErrorMessage('');
      const response = await getOpenClawStatus();
      applyStatus(response);
      if (!preserveToken) {
        setFreshToken('');
      }
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to load OpenClaw integration status.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({
        title: `${label} copied`,
        description: `${label} is now in your clipboard.`
      });
    } catch (error: any) {
      toast({
        title: `Unable to copy ${label.toLowerCase()}`,
        description: error.message || 'Clipboard access failed.',
        variant: 'destructive'
      });
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setErrorMessage('');
      const response = await updateOpenClawSettings({
        enabled,
        displayName,
        publishedBaseUrl,
        notes
      });
      applyStatus(response);
      toast({
        title: 'OpenClaw integration updated',
        description: response.message
      });
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to update OpenClaw settings.');
      toast({
        title: 'Unable to save settings',
        description: error.message || 'Failed to update OpenClaw settings.',
        variant: 'destructive'
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRotateToken = async () => {
    try {
      setRotatingToken(true);
      setErrorMessage('');
      const response = await rotateOpenClawToken();
      applyStatus(response);
      setFreshToken(response.token);
      toast({
        title: 'OpenClaw token rotated',
        description: 'Copy the new token now. It will not be shown again after you leave this page.'
      });
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to rotate OpenClaw token.');
      toast({
        title: 'Unable to rotate token',
        description: error.message || 'Failed to rotate OpenClaw token.',
        variant: 'destructive'
      });
    } finally {
      setRotatingToken(false);
    }
  };

  const handleRevokeToken = async () => {
    try {
      setRevokingToken(true);
      setErrorMessage('');
      const response = await revokeOpenClawToken();
      setFreshToken('');
      await loadStatus(false);
      toast({
        title: 'OpenClaw token revoked',
        description: response.message
      });
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to revoke OpenClaw token.');
      toast({
        title: 'Unable to revoke token',
        description: error.message || 'Failed to revoke OpenClaw token.',
        variant: 'destructive'
      });
    } finally {
      setRevokingToken(false);
    }
  };

  const handleDownloadBundle = async () => {
    if (!freshToken) {
      toast({
        title: 'Rotate token first',
        description: 'Generate a fresh token before downloading a deploy-ready OpenClaw bundle.',
        variant: 'destructive'
      });
      return;
    }

    try {
      setDownloadingBundle(true);
      const { blob, suggestedFileName } = await downloadOpenClawBundle(freshToken);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = suggestedFileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      toast({
        title: 'OpenClaw bundle downloaded',
        description: 'The bundle includes the current token and a ready-to-run Jetson installer.'
      });
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to download the OpenClaw bundle.');
      toast({
        title: 'Unable to download bundle',
        description: error.message || 'Failed to download the OpenClaw bundle.',
        variant: 'destructive'
      });
    } finally {
      setDownloadingBundle(false);
    }
  };

  const configText = JSON.stringify(status?.mcp.serverDefinition || {}, null, 2);
  const skillText = status?.skill.markdown || '';
  const jetsonGuide = status?.jetsonGuide || '';

  return (
    <div className="space-y-6">
      {!embedded ? (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-400/30 bg-cyan-500/10 text-cyan-300">
                <Bot className="h-6 w-6" />
              </div>
              <div>
                <p className="section-kicker">External Admin Agent</p>
                <h1 className="text-3xl font-semibold tracking-tight text-foreground">OpenClaw Integration</h1>
              </div>
            </div>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              Connect an existing OpenClaw instance to HomeBrain through a dedicated MCP endpoint, a managed admin token,
              and the shipped <code>homebrain-admin</code> skill pack.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => void loadStatus()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <Button onClick={() => void handleDownloadBundle()} disabled={!freshToken || downloadingBundle}>
              <Download className="mr-2 h-4 w-4" />
              {downloadingBundle ? 'Preparing Bundle...' : 'Download Ready Bundle'}
            </Button>
          </div>
        </div>
      ) : null}

      {errorMessage ? (
        <Card className="border-red-500/40 bg-red-500/10">
          <CardContent className="pt-6 text-sm text-red-100">{errorMessage}</CardContent>
        </Card>
      ) : null}

      {loading ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">Loading OpenClaw integration details...</CardContent>
        </Card>
      ) : null}

      {!loading && status ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Integration State</CardDescription>
                <CardTitle className="flex items-center gap-2 text-xl">
                  {status.integration.enabled ? (
                    <ShieldCheck className="h-5 w-5 text-emerald-400" />
                  ) : (
                    <ShieldOff className="h-5 w-5 text-amber-400" />
                  )}
                  {status.integration.enabled ? 'Enabled' : 'Disabled'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <div className="flex items-center justify-between">
                  <span>Token</span>
                  <Badge variant={status.integration.tokenConfigured ? 'default' : 'outline'}>
                    {status.integration.tokenConfigured ? 'Configured' : 'Missing'}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>Transport</span>
                  <Badge variant="outline">{status.mcp.transport}</Badge>
                </div>
                <div className="text-xs">
                  Last used: {formatTimestamp(status.integration.lastUsedAt)}
                  {status.integration.lastUsedIp ? ` from ${status.integration.lastUsedIp}` : ''}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardDescription>MCP Endpoint</CardDescription>
                <CardTitle className="text-xl">External OpenClaw URL</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <div className="rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs text-cyan-100">
                  {status.mcp.endpointUrl}
                </div>
                <Button variant="outline" size="sm" onClick={() => void copyText(status.mcp.endpointUrl, 'Endpoint URL')}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy Endpoint
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Shipped Skill</CardDescription>
                <CardTitle className="text-xl">{status.skill.directory}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <div>Checksum: <span className="font-mono text-xs text-cyan-100">{status.skill.checksum}</span></div>
                <div>Bundle: <span className="font-mono text-xs text-cyan-100">{status.skill.fileName}</span></div>
                <Button variant="outline" size="sm" onClick={() => void copyText(skillText, 'Skill markdown')}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy Skill
                </Button>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
            <Card>
              <CardHeader>
                <CardTitle>Integration Settings</CardTitle>
                <CardDescription>
                  Manage the published admin identity that OpenClaw uses when its actions are logged in HomeBrain Operations.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="openclaw-display-name">Display Name</Label>
                  <Input
                    id="openclaw-display-name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="HomeBrain OpenClaw Admin"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="openclaw-published-url">Published HomeBrain URL</Label>
                  <Input
                    id="openclaw-published-url"
                    value={publishedBaseUrl}
                    onChange={(event) => setPublishedBaseUrl(event.target.value)}
                    placeholder="https://homebrain.example.com"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave blank to use the current HomeBrain browser origin. Set this when OpenClaw should reach HomeBrain through a specific public URL.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="openclaw-notes">Notes</Label>
                  <Textarea
                    id="openclaw-notes"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    rows={4}
                    placeholder="Optional internal notes about the paired OpenClaw instance."
                  />
                </div>

                <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Integration Enabled</p>
                    <p className="text-xs text-muted-foreground">
                      Disable this to block the external OpenClaw MCP endpoint without deleting its settings.
                    </p>
                  </div>
                  <Switch checked={enabled} onCheckedChange={setEnabled} />
                </div>

                <Button onClick={() => void handleSave()} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Integration Settings'}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Admin Token</CardTitle>
                <CardDescription>
                  Rotate the dedicated HomeBrain token that the external OpenClaw instance sends in its MCP request headers.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Button onClick={() => void handleRotateToken()} disabled={rotatingToken}>
                    <KeyRound className="mr-2 h-4 w-4" />
                    {rotatingToken ? 'Rotating...' : 'Rotate Token'}
                  </Button>
                  <Button onClick={() => void handleDownloadBundle()} disabled={!freshToken || downloadingBundle}>
                    <Download className="mr-2 h-4 w-4" />
                    {downloadingBundle ? 'Preparing...' : 'Download Ready Bundle'}
                  </Button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Button variant="outline" onClick={() => void handleRevokeToken()} disabled={revokingToken}>
                    {revokingToken ? 'Revoking...' : 'Revoke Token'}
                  </Button>
                  <Button variant="outline" onClick={() => void loadStatus(false)}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Clear Fresh Token
                  </Button>
                </div>

                <div className="text-sm text-muted-foreground">
                  Current token prefix: <span className="font-mono text-cyan-100">{status.integration.tokenPrefix || 'not configured'}</span>
                </div>

                <p className="text-xs text-muted-foreground">
                  Rotate a token immediately before deployment. The fresh token powers the inline JSON, CLI command, and ready-to-run Jetson bundle shown here.
                </p>

                <div className="space-y-2">
                  <Label>Fresh Token</Label>
                  <Textarea
                    value={freshToken || 'Rotate the token to reveal a new value once.'}
                    readOnly
                    rows={4}
                    className="font-mono text-xs"
                  />
                </div>

                <Button
                  variant="outline"
                  disabled={!freshToken}
                  onClick={() => void copyText(freshToken, 'Fresh token')}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  Copy Fresh Token
                </Button>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>MCP Server Definition</CardTitle>
                <CardDescription>
                  Register this server in the existing OpenClaw instance. Rotate a token to get the deploy-ready inline version.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Textarea value={configText} readOnly rows={12} className="font-mono text-xs" />
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" onClick={() => void copyText(configText, 'MCP server definition')}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy JSON
                  </Button>
                  <Button variant="outline" onClick={() => void copyText(status.mcp.cliCommand, 'OpenClaw CLI command')}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy `openclaw mcp set`
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Jetson Deployment Guide</CardTitle>
                <CardDescription>
                  Download the ready bundle after rotation, unzip it on the Jetson, and run the packaged installer.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Textarea value={jetsonGuide} readOnly rows={12} className="font-mono text-xs" />
                <Button variant="outline" onClick={() => void copyText(jetsonGuide, 'Jetson setup guide')}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy Guide
                </Button>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Shipped OpenClaw Skill</CardTitle>
              <CardDescription>
                This is the exact <code>homebrain-admin</code> skill HomeBrain bundles for OpenClaw.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea value={skillText} readOnly rows={18} className="font-mono text-xs" />
              <Button variant="outline" onClick={() => void copyText(skillText, 'OpenClaw skill')}>
                <Copy className="mr-2 h-4 w-4" />
                Copy Skill Markdown
              </Button>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

export default OpenClawIntegration;
