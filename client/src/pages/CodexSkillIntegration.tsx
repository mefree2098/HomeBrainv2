import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/useToast';
import {
  downloadCodexSkillBundle,
  getCodexSkillStatus,
  revokeCodexSkillToken,
  rotateCodexSkillToken,
  type CodexSkillIntegrationStatusResponse,
  updateCodexSkillSettings
} from '@/api/codexSkill';
import { Bot, Copy, Download, KeyRound, RefreshCw, ShieldCheck, ShieldOff, Terminal } from 'lucide-react';

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

type CodexSkillIntegrationProps = {
  embedded?: boolean;
};

export function CodexSkillIntegration({ embedded = false }: CodexSkillIntegrationProps) {
  const { toast } = useToast();
  const [status, setStatus] = useState<CodexSkillIntegrationStatusResponse | null>(null);
  const [displayName, setDisplayName] = useState('HomeBrain Codex Live Admin');
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

  const applyStatus = (nextStatus: CodexSkillIntegrationStatusResponse) => {
    setStatus(nextStatus);
    setDisplayName(nextStatus.integration.displayName || 'HomeBrain Codex Live Admin');
    setPublishedBaseUrl(nextStatus.integration.publishedBaseUrl || '');
    setNotes(nextStatus.integration.notes || '');
    setEnabled(nextStatus.integration.enabled !== false);
  };

  const loadStatus = async (preserveToken = true) => {
    try {
      setLoading(true);
      setErrorMessage('');
      const response = await getCodexSkillStatus();
      applyStatus(response);
      if (!preserveToken) {
        setFreshToken('');
      }
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to load Codex skill integration status.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const exportSnippet = useMemo(() => {
    if (!status) {
      return '';
    }

    return status.setup.exportSnippet;
  }, [status]);

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
      const response = await updateCodexSkillSettings({
        enabled,
        displayName,
        publishedBaseUrl,
        notes
      });
      applyStatus(response);
      toast({
        title: 'Codex skill integration updated',
        description: response.message
      });
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to update Codex skill integration.');
      toast({
        title: 'Unable to save settings',
        description: error.message || 'Failed to update Codex skill integration.',
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
      const response = await rotateCodexSkillToken();
      applyStatus(response);
      setFreshToken(response.token);
      toast({
        title: 'Codex skill token rotated',
        description: 'Copy the new token now. It will not be shown again after you leave this page.'
      });
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to rotate Codex skill token.');
      toast({
        title: 'Unable to rotate token',
        description: error.message || 'Failed to rotate Codex skill token.',
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
      const response = await revokeCodexSkillToken();
      setFreshToken('');
      await loadStatus(false);
      toast({
        title: 'Codex skill token revoked',
        description: response.message
      });
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to revoke Codex skill token.');
      toast({
        title: 'Unable to revoke token',
        description: error.message || 'Failed to revoke Codex skill token.',
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
        description: 'Generate a fresh token before downloading a ready-to-install Codex skill bundle.',
        variant: 'destructive'
      });
      return;
    }

    try {
      setDownloadingBundle(true);
      const { blob, suggestedFileName } = await downloadCodexSkillBundle(freshToken);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = suggestedFileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      toast({
        title: 'Codex skill bundle downloaded',
        description: 'The bundle includes the skill, helper script, installer, and current token exports.'
      });
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to download the Codex skill bundle.');
      toast({
        title: 'Unable to download bundle',
        description: error.message || 'Failed to download the Codex skill bundle.',
        variant: 'destructive'
      });
    } finally {
      setDownloadingBundle(false);
    }
  };

  const skillText = status?.skill.markdown || '';

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
                <p className="section-kicker">Live Codex Access</p>
                <h1 className="text-3xl font-semibold tracking-tight text-foreground">Codex Skill Integration</h1>
              </div>
            </div>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              Generate a dedicated HomeBrain admin token for Codex, ship the <code>homebrain-live</code> skill bundle,
              and let Codex inspect live state, run HomeBrain deploys, and verify results without manual UI mediation.
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
          <CardContent className="pt-6 text-sm text-muted-foreground">Loading Codex skill integration details...</CardContent>
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
                  <span>Issued To</span>
                  <span className="font-mono text-xs text-cyan-100">{status.integration.issuedToEmail || 'Unassigned'}</span>
                </div>
                <div className="text-xs">
                  Last used: {formatTimestamp(status.integration.lastUsedAt)}
                  {status.integration.lastUsedIp ? ` from ${status.integration.lastUsedIp}` : ''}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Published URL</CardDescription>
                <CardTitle className="text-xl">Live HomeBrain Target</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <div className="rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs text-cyan-100">
                  {status.setup.baseUrl || 'Not resolved yet'}
                </div>
                <Button variant="outline" size="sm" onClick={() => void copyText(status.setup.baseUrl, 'Published URL')}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy URL
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
                <div>Helper: <span className="font-mono text-xs text-cyan-100">{status.helper.relativePath}</span></div>
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
                  Configure the published HomeBrain URL and token owner that the live Codex skill will use for authenticated platform reads and deploy actions.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="codex-skill-display-name">Display Name</Label>
                  <Input
                    id="codex-skill-display-name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="HomeBrain Codex Live Admin"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="codex-skill-published-url">Published HomeBrain URL</Label>
                  <Input
                    id="codex-skill-published-url"
                    value={publishedBaseUrl}
                    onChange={(event) => setPublishedBaseUrl(event.target.value)}
                    placeholder="https://homebrain.example.com"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave blank to use the current HomeBrain browser origin. Set this when Codex should reach HomeBrain through a specific public URL.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="codex-skill-notes">Notes</Label>
                  <Textarea
                    id="codex-skill-notes"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    rows={4}
                    placeholder="Optional notes about how this Codex integration should be used."
                  />
                </div>

                <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Integration Enabled</p>
                    <p className="text-xs text-muted-foreground">
                      Disable this to block the dedicated Codex token without deleting the integration settings.
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
                  Rotate the dedicated HomeBrain token that the Codex skill uses as a fully authenticated admin credential across the existing HomeBrain APIs.
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
                  Rotate immediately before handing the live environment to Codex. The fresh token powers the export snippet and ready-to-install bundle shown here.
                </p>

                <div className="space-y-2">
                  <Label>Fresh Token</Label>
                  <Textarea
                    value={freshToken || 'Rotate the token to reveal a new value once.'}
                    readOnly
                    rows={3}
                    className="font-mono text-xs"
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Terminal className="h-5 w-5 text-cyan-300" />
                  Codex Setup
                </CardTitle>
                <CardDescription>
                  Export these values into the Codex shell session or use the downloaded bundle to install the shipped skill locally.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Environment Exports</Label>
                  <Textarea value={exportSnippet} readOnly rows={4} className="font-mono text-xs" />
                </div>
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" onClick={() => void copyText(exportSnippet, 'Env exports')}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy Exports
                  </Button>
                  <Button variant="outline" onClick={() => void copyText(status.helper.source, 'Helper script')}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy Helper Script
                  </Button>
                </div>
                <div className="space-y-2">
                  <Label>Example Commands</Label>
                  <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-4">
                    {status.setup.helperExamples.map((example) => (
                      <button
                        key={example}
                        type="button"
                        className="block w-full rounded-lg border border-transparent px-3 py-2 text-left font-mono text-xs text-cyan-100 transition hover:border-cyan-400/30 hover:bg-cyan-500/5"
                        onClick={() => void copyText(example, 'Helper command')}
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>How Codex Uses This</CardTitle>
                <CardDescription>
                  The generated token authenticates against HomeBrain’s existing admin APIs, so Codex can inspect live state and operate the platform directly after code changes.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p>Typical loop: edit code locally, push changes with git or GitHub, trigger a HomeBrain deploy, then verify the result with live deploy health, resource checks, and event streams.</p>
                <p>The bundled helper script is intentionally small and uses the platform as the source of truth for current runtime state instead of stale local assumptions.</p>
                <p>Because this token is fully authenticated, treat it like an admin secret and rotate it whenever you want to cut off Codex access.</p>
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default CodexSkillIntegration;
