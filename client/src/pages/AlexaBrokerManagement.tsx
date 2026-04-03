import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/useToast';
import {
  deployAlexaBrokerService,
  flushAlexaBrokerEvents,
  generateAlexaLinkCode,
  getAlexaBrokerServiceStatus,
  getAlexaSummary,
  installAlexaBrokerService,
  pairAlexaBroker,
  restartAlexaBrokerService,
  revokeAlexaHousehold,
  startAlexaBrokerService,
  stopAlexaBrokerService,
  syncAlexaDiscovery,
  syncAlexaHouseholdDiscovery,
  updateAlexaBrokerServiceConfig,
  type AlexaBrokerServiceStatus
} from '@/api/alexa';
import {
  Activity,
  AlertCircle,
  CheckCircle,
  Globe,
  HardDrive,
  Link2,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  Shield,
  Square,
  UploadCloud,
  XCircle
} from 'lucide-react';

type BrokerDraft = {
  publicBaseUrl: string;
  bindHost: string;
  servicePort: string;
  displayName: string;
  oauthClientId: string;
  oauthClientSecret: string;
  allowedClientIds: string;
  allowedRedirectUris: string;
  eventClientId: string;
  eventClientSecret: string;
  storeFile: string;
  authCodeTtlMs: string;
  accessTokenTtlSeconds: string;
  refreshTokenTtlSeconds: string;
  lwaTokenUrl: string;
  eventGatewayUrl: string;
  rateLimitWindowMs: string;
  rateLimitMax: string;
  allowManualRegistration: boolean;
  autoStart: boolean;
};

const emptyDraft: BrokerDraft = {
  publicBaseUrl: '',
  bindHost: '127.0.0.1',
  servicePort: '4301',
  displayName: 'HomeBrain Alexa Broker',
  oauthClientId: 'homebrain-alexa-skill',
  oauthClientSecret: '',
  allowedClientIds: 'homebrain-alexa-skill',
  allowedRedirectUris: '',
  eventClientId: '',
  eventClientSecret: '',
  storeFile: '',
  authCodeTtlMs: '300000',
  accessTokenTtlSeconds: '3600',
  refreshTokenTtlSeconds: '15552000',
  lwaTokenUrl: 'https://api.amazon.com/auth/o2/token',
  eventGatewayUrl: 'https://api.amazonalexa.com/v3/events',
  rateLimitWindowMs: '60000',
  rateLimitMax: '120',
  allowManualRegistration: false,
  autoStart: true
};

function hydrateDraftFromStatus(status: AlexaBrokerServiceStatus | null): BrokerDraft {
  if (!status) {
    return emptyDraft;
  }

  return {
    publicBaseUrl: status.publicBaseUrl || '',
    bindHost: status.bindHost || '127.0.0.1',
    servicePort: String(status.servicePort || 4301),
    displayName: status.displayName || 'HomeBrain Alexa Broker',
    oauthClientId: status.oauthClientId || 'homebrain-alexa-skill',
    oauthClientSecret: '',
    allowedClientIds: Array.isArray(status.allowedClientIds) ? status.allowedClientIds.join('\n') : '',
    allowedRedirectUris: Array.isArray(status.allowedRedirectUris) ? status.allowedRedirectUris.join('\n') : '',
    eventClientId: status.eventClientId || '',
    eventClientSecret: '',
    storeFile: status.storeFile || '',
    authCodeTtlMs: String(status.authCodeTtlMs || 300000),
    accessTokenTtlSeconds: String(status.accessTokenTtlSeconds || 3600),
    refreshTokenTtlSeconds: String(status.refreshTokenTtlSeconds || 15552000),
    lwaTokenUrl: status.lwaTokenUrl || 'https://api.amazon.com/auth/o2/token',
    eventGatewayUrl: status.eventGatewayUrl || 'https://api.amazonalexa.com/v3/events',
    rateLimitWindowMs: String(status.rateLimitWindowMs || 60000),
    rateLimitMax: String(status.rateLimitMax || 120),
    allowManualRegistration: status.allowManualRegistration === true,
    autoStart: status.autoStart !== false
  };
}

function formatStatusLabel(status: string | null | undefined) {
  const normalized = String(status || 'unknown').replace(/_/g, ' ');
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export default function AlexaBrokerManagement() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [serviceStatus, setServiceStatus] = useState<AlexaBrokerServiceStatus | null>(null);
  const [alexaSummary, setAlexaSummary] = useState<any>(null);
  const [draft, setDraft] = useState<BrokerDraft>(emptyDraft);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [generatingLinkCode, setGeneratingLinkCode] = useState<'private' | 'public' | ''>('');
  const [latestLinkCode, setLatestLinkCode] = useState<any>(null);
  const [pairingBaseUrl, setPairingBaseUrl] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [pairingBroker, setPairingBroker] = useState(false);
  const [syncingDiscovery, setSyncingDiscovery] = useState(false);
  const [flushingEvents, setFlushingEvents] = useState(false);
  const [householdActionKey, setHouseholdActionKey] = useState('');

  const hydrateLocalDraft = useCallback((status: AlexaBrokerServiceStatus | null) => {
    setDraft(hydrateDraftFromStatus(status));
    setDraftHydrated(true);
    setPairingBaseUrl((current) => current || status?.localBaseUrl || status?.publicBaseUrl || '');
  }, []);

  const loadData = useCallback(async ({ hydrate = false }: { hydrate?: boolean } = {}) => {
    const [serviceResult, summaryResult] = await Promise.allSettled([
      getAlexaBrokerServiceStatus(),
      getAlexaSummary()
    ]);

    if (serviceResult.status === 'fulfilled') {
      const nextStatus = serviceResult.value?.status || null;
      setServiceStatus(nextStatus);
      if (hydrate || !draftHydrated) {
        hydrateLocalDraft(nextStatus);
      }
    } else if (!draftHydrated) {
      setServiceStatus(null);
    }

    if (summaryResult.status === 'fulfilled') {
      setAlexaSummary(summaryResult.value?.summary || null);
      setPairingBaseUrl((current) => current || summaryResult.value?.summary?.brokerBaseUrl || '');
    } else {
      setAlexaSummary(null);
    }

    if (serviceResult.status === 'rejected' && summaryResult.status === 'rejected') {
      throw new Error(serviceResult.reason?.message || summaryResult.reason?.message || 'Failed to load Alexa broker state');
    }
  }, [draftHydrated, hydrateLocalDraft]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        await loadData({ hydrate: true });
      } catch (error: any) {
        if (!cancelled) {
          toast({
            variant: 'destructive',
            title: 'Unable to load Alexa broker',
            description: error?.message || 'Check the server logs for more details.'
          });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [loadData, toast]);

  useEffect(() => {
    const interval = setInterval(() => {
      void loadData();
    }, 20000);

    return () => clearInterval(interval);
  }, [loadData]);

  const pairedToManagedUrl = useMemo(() => {
    if (!serviceStatus?.localBaseUrl || !alexaSummary?.brokerBaseUrl) {
      return false;
    }

    return serviceStatus.localBaseUrl === alexaSummary.brokerBaseUrl;
  }, [alexaSummary?.brokerBaseUrl, serviceStatus?.localBaseUrl]);

  const currentServiceTone = useMemo(() => {
    const status = serviceStatus?.serviceStatus || 'unknown';
    if (status === 'running') {
      return 'default';
    }
    if (status === 'error') {
      return 'destructive';
    }
    return 'secondary';
  }, [serviceStatus?.serviceStatus]);

  const reverseProxyTone = useMemo(() => {
    const proxy = serviceStatus?.reverseProxy;
    if (proxy?.routeExists && proxy?.enabled && proxy?.validationStatus === 'valid' && proxy?.lastApplyStatus === 'applied') {
      return 'default';
    }
    if (!proxy?.expectedHostname) {
      return 'secondary';
    }
    return 'outline';
  }, [serviceStatus?.reverseProxy]);

  const updateDraft = useCallback((key: keyof BrokerDraft, value: string | boolean) => {
    setDraft((current) => ({
      ...current,
      [key]: value
    }));
  }, []);

  const persistConfig = useCallback(async ({ showToast = true }: { showToast?: boolean } = {}) => {
    const response = await updateAlexaBrokerServiceConfig({
      publicBaseUrl: draft.publicBaseUrl,
      bindHost: draft.bindHost,
      servicePort: draft.servicePort,
      displayName: draft.displayName,
      oauthClientId: draft.oauthClientId,
      oauthClientSecret: draft.oauthClientSecret,
      allowedClientIds: draft.allowedClientIds,
      allowedRedirectUris: draft.allowedRedirectUris,
      eventClientId: draft.eventClientId,
      eventClientSecret: draft.eventClientSecret,
      storeFile: draft.storeFile,
      authCodeTtlMs: draft.authCodeTtlMs,
      accessTokenTtlSeconds: draft.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: draft.refreshTokenTtlSeconds,
      lwaTokenUrl: draft.lwaTokenUrl,
      eventGatewayUrl: draft.eventGatewayUrl,
      rateLimitWindowMs: draft.rateLimitWindowMs,
      rateLimitMax: draft.rateLimitMax,
      allowManualRegistration: draft.allowManualRegistration,
      autoStart: draft.autoStart
    });

    const nextStatus = response?.status || null;
    setServiceStatus(nextStatus);
    hydrateLocalDraft(nextStatus);

    if (showToast) {
      toast({
        title: 'Broker configuration saved',
        description: response?.restartRequired
          ? 'Configuration saved. Restart the broker to apply runtime changes.'
          : 'Alexa broker settings are up to date.'
      });
    }

    return response;
  }, [draft, hydrateLocalDraft, toast]);

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      await persistConfig();
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Save failed',
        description: error?.message || 'Unable to save Alexa broker configuration.'
      });
    } finally {
      setSavingConfig(false);
    }
  };

  const runServiceAction = async (
    key: string,
    action: () => Promise<any>,
    successTitle: string,
    successDescription: string
  ) => {
    setActionLoading(key);
    try {
      const response = await action();
      if (response?.status) {
        setServiceStatus(response.status);
      }
      await loadData();
      toast({
        title: successTitle,
        description: response?.message || successDescription
      });
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Broker action failed',
        description: error?.message || 'Unable to complete the Alexa broker action.'
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeployBroker = async () => {
    setActionLoading('deploy');
    try {
      await persistConfig({ showToast: false });
      const response = await deployAlexaBrokerService();
      if (response?.status) {
        setServiceStatus(response.status);
      }
      await loadData();
      toast({
        title: 'Broker deployed',
        description: response?.message || 'Alexa broker, reverse proxy route, and runtime were refreshed.'
      });
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Deploy failed',
        description: error?.message || 'Unable to deploy the Alexa broker and reverse proxy route.'
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleGenerateLinkCode = async (mode: 'private' | 'public') => {
    setGeneratingLinkCode(mode);
    try {
      const response = await generateAlexaLinkCode({ mode });
      if (response.success) {
        setLatestLinkCode(response);
        setPairingCode(response.code || '');
        toast({
          title: 'Alexa link code ready',
          description: `${mode === 'public' ? 'Public' : 'Private'} code ${response.code} expires ${new Date(response.expiresAt).toLocaleString()}.`
        });
        await loadData();
      }
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Link code failed',
        description: error?.message || 'Unable to generate an Alexa link code.'
      });
    } finally {
      setGeneratingLinkCode('');
    }
  };

  const handlePairBroker = async () => {
    const brokerBaseUrl = pairingBaseUrl.trim() || serviceStatus?.localBaseUrl || '';
    if (!brokerBaseUrl) {
      toast({
        variant: 'destructive',
        title: 'Broker URL required',
        description: 'Start the managed broker first or enter a broker control URL.'
      });
      return;
    }

    if (!pairingCode.trim()) {
      toast({
        variant: 'destructive',
        title: 'Pairing code required',
        description: 'Generate or paste a HomeBrain Alexa pairing code before pairing.'
      });
      return;
    }

    setPairingBroker(true);
    try {
      const response = await pairAlexaBroker({
        brokerBaseUrl,
        linkCode: pairingCode.trim(),
        mode: latestLinkCode?.mode === 'public' ? 'public' : 'private'
      });
      if (response.success) {
        toast({
          title: 'HomeBrain paired',
          description: 'The HomeBrain hub is now paired with the Alexa broker.'
        });
        await loadData();
      }
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Pairing failed',
        description: error?.message || 'Unable to pair HomeBrain with the Alexa broker.'
      });
    } finally {
      setPairingBroker(false);
    }
  };

  const handleSyncDiscovery = async () => {
    setSyncingDiscovery(true);
    try {
      const response = await syncAlexaDiscovery({ reason: 'alexa_broker_management_manual_sync' });
      toast({
        title: response?.result?.skipped ? 'Broker not paired yet' : 'Alexa discovery synced',
        description: response?.result?.reason || 'HomeBrain pushed the current Alexa catalog to the broker.'
      });
      await loadData();
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Discovery sync failed',
        description: error?.message || 'Unable to sync Alexa discovery.'
      });
    } finally {
      setSyncingDiscovery(false);
    }
  };

  const handleFlushEvents = async () => {
    setFlushingEvents(true);
    try {
      const response = await flushAlexaBrokerEvents({ limit: 25 });
      toast({
        title: 'Broker queue flushed',
        description: `Processed ${response?.result?.processed ?? 0} queued Alexa event(s).`
      });
      await loadData();
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Flush failed',
        description: error?.message || 'Unable to flush queued Alexa events.'
      });
    } finally {
      setFlushingEvents(false);
    }
  };

  const handleHouseholdDiscovery = async (brokerAccountId: string) => {
    const actionKey = `${brokerAccountId}:sync`;
    setHouseholdActionKey(actionKey);
    try {
      const response = await syncAlexaHouseholdDiscovery(brokerAccountId);
      toast({
        title: 'Rediscovery queued',
        description: `Queued ${response?.result?.queued ?? 0} discovery update(s) for ${brokerAccountId}.`
      });
      await loadData();
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Rediscovery failed',
        description: error?.message || 'Unable to queue household rediscovery.'
      });
    } finally {
      setHouseholdActionKey('');
    }
  };

  const handleRevokeHousehold = async (brokerAccountId: string) => {
    if (!window.confirm(`Revoke linked Alexa household ${brokerAccountId}?`)) {
      return;
    }

    const actionKey = `${brokerAccountId}:revoke`;
    setHouseholdActionKey(actionKey);
    try {
      await revokeAlexaHousehold(brokerAccountId, {
        reason: 'Revoked from Alexa Broker management UI'
      });
      toast({
        title: 'Household revoked',
        description: `${brokerAccountId} was revoked and proactive delivery was disabled for that household.`
      });
      await loadData();
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Revoke failed',
        description: error?.message || 'Unable to revoke the linked household.'
      });
    } finally {
      setHouseholdActionKey('');
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              Alexa Broker
            </CardTitle>
            <CardDescription>Loading broker status and HomeBrain pairing state…</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Alexa Broker</h1>
          <p className="text-muted-foreground">
            Deploy and manage the separate Alexa OAuth broker from HomeBrain instead of handling it manually in the shell.
          </p>
        </div>
        <Button variant="outline" onClick={() => loadData({ hydrate: true })}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Alexa still requires the broker to live at its own HTTPS origin for account-linking and proactive events. The new managed service keeps that separation, but HomeBrain now owns the install, runtime, and config.
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Managed Service</CardDescription>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Server className="h-5 w-5 text-cyan-600" />
              {formatStatusLabel(serviceStatus?.serviceStatus)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <Badge variant={currentServiceTone}>{serviceStatus?.serviceRunning ? 'Healthy' : 'Idle'}</Badge>
            <p className="mt-3">Install: {serviceStatus?.isInstalled ? 'ready' : 'missing dependencies'}</p>
            <p>PID: {serviceStatus?.servicePid || 'not running'}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>HomeBrain Pairing</CardDescription>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Link2 className="h-5 w-5 text-emerald-600" />
              {alexaSummary?.status === 'paired' ? `Paired (${alexaSummary?.mode || 'private'})` : 'Not paired'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>Hub ID: {alexaSummary?.hubId || 'Unavailable'}</p>
            <p>Linked households: {alexaSummary?.linkedAccounts?.length ?? 0}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Local Control URL</CardDescription>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Activity className="h-5 w-5 text-violet-600" />
              {serviceStatus?.servicePort || 4301}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p className="break-all">{serviceStatus?.localBaseUrl || 'Unavailable'}</p>
            <p className="mt-1">Bind host: {serviceStatus?.bindHost || '127.0.0.1'}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Public Broker Origin</CardDescription>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Globe className="h-5 w-5 text-amber-600" />
              {serviceStatus?.publicBaseUrl ? 'Configured' : 'Missing'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p className="break-all">{serviceStatus?.publicBaseUrl || 'Set this before Alexa account linking.'}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Reverse Proxy Route</CardDescription>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Shield className="h-5 w-5 text-sky-600" />
              {serviceStatus?.reverseProxy?.routeExists ? 'Managed' : 'Missing'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <Badge variant={reverseProxyTone}>
              {serviceStatus?.reverseProxy?.lastApplyStatus === 'applied'
                ? 'Applied'
                : formatStatusLabel(serviceStatus?.reverseProxy?.validationStatus || 'unknown')}
            </Badge>
            <p className="mt-3 break-all">
              {serviceStatus?.reverseProxy?.hostname || serviceStatus?.reverseProxy?.expectedHostname || 'Set a public broker URL first.'}
            </p>
            <p className="mt-1">
              Upstream: {serviceStatus?.reverseProxy?.upstreamHost || '127.0.0.1'}:{serviceStatus?.reverseProxy?.upstreamPort || serviceStatus?.servicePort || 4301}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Broker Queue</CardDescription>
            <CardTitle className="flex items-center gap-2 text-xl">
              <HardDrive className="h-5 w-5 text-rose-600" />
              {alexaSummary?.brokerDelivery?.available ? `${alexaSummary?.brokerDelivery?.queuedCount ?? 0} queued` : 'Unavailable'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>{alexaSummary?.brokerDelivery?.failedCount ?? 0} failed</p>
            <p>{alexaSummary?.brokerDelivery?.deliveredCount ?? 0} delivered</p>
          </CardContent>
        </Card>
      </div>

      {!pairedToManagedUrl && alexaSummary?.status === 'paired' && serviceStatus?.localBaseUrl ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            HomeBrain is currently paired to <span className="font-mono">{alexaSummary?.brokerBaseUrl}</span>, not the managed broker at{' '}
            <span className="font-mono">{serviceStatus.localBaseUrl}</span>. Re-pair if you want HomeBrain to use the managed service endpoint.
          </AlertDescription>
        </Alert>
      ) : null}

      {serviceStatus?.publicBaseUrl && (!serviceStatus?.reverseProxy?.routeExists || serviceStatus?.reverseProxy?.matchesConfig === false) ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            The managed reverse-proxy route is missing or out of sync with the saved broker URL. Use <span className="font-medium">Deploy Broker</span> to create or refresh the route and apply the live Caddy config.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Broker Controls</CardTitle>
          <CardDescription>
            This replaces the manual `npm run broker-install` flow. Deploy Broker saves the current config, installs broker dependencies, creates or updates the reverse-proxy route, applies Caddy, then starts or restarts the broker.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleDeployBroker} disabled={actionLoading !== null}>
              {actionLoading === 'deploy' ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Deploying…
                </>
              ) : (
                <>
                  <Shield className="mr-2 h-4 w-4" />
                  Deploy Broker
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => runServiceAction('install', installAlexaBrokerService, 'Broker installed', 'Alexa broker dependencies are ready.')}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'install' ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Installing…
                </>
              ) : (
                <>
                  <UploadCloud className="mr-2 h-4 w-4" />
                  Install Broker
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => runServiceAction('start', startAlexaBrokerService, 'Broker started', 'Alexa broker is running locally.')}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'start' ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Starting…
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Start
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => runServiceAction('stop', stopAlexaBrokerService, 'Broker stopped', 'Alexa broker is no longer running.')}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'stop' ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Stopping…
                </>
              ) : (
                <>
                  <Square className="mr-2 h-4 w-4" />
                  Stop
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => runServiceAction('restart', restartAlexaBrokerService, 'Broker restarted', 'Alexa broker restarted with the latest config.')}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'restart' ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Restarting…
                </>
              ) : (
                <>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Restart
                </>
              )}
            </Button>
          </div>

          {serviceStatus?.lastError?.message ? (
            <Alert variant="destructive">
              <XCircle className="h-4 w-4" />
              <AlertDescription>
                {serviceStatus.lastError.message}
                {serviceStatus.lastError.timestamp ? ` (${new Date(serviceStatus.lastError.timestamp).toLocaleString()})` : ''}
              </AlertDescription>
            </Alert>
          ) : null}

          {serviceStatus?.healthAvailable && serviceStatus?.health ? (
            <div className="grid gap-3 md:grid-cols-4">
              <div className="rounded-lg border border-border/60 bg-background/50 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Registered Hubs</p>
                <p className="mt-1 text-lg font-semibold">{serviceStatus.health?.hubs ?? 0}</p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/50 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Queued Events</p>
                <p className="mt-1 text-lg font-semibold">{serviceStatus.health?.queuedEvents ?? 0}</p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/50 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Active Grants</p>
                <p className="mt-1 text-lg font-semibold">{serviceStatus.health?.activePermissionGrants ?? 0}</p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/50 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Failed Events</p>
                <p className="mt-1 text-lg font-semibold">{serviceStatus.health?.failedEvents ?? 0}</p>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Broker Configuration</CardTitle>
          <CardDescription>
            These values now live in HomeBrain instead of shell exports. Save here to update the managed broker settings, then use Deploy Broker when you want HomeBrain to push the route and runtime changes live together.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Public Broker Base URL</label>
              <Input value={draft.publicBaseUrl} onChange={(event) => updateDraft('publicBaseUrl', event.target.value)} placeholder="https://alexa-broker.example.com" />
              <p className="text-xs text-muted-foreground">Alexa uses this HTTPS origin for OAuth, token exchange, and event delivery.</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Broker Display Name</label>
              <Input value={draft.displayName} onChange={(event) => updateDraft('displayName', event.target.value)} placeholder="HomeBrain Alexa Broker" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Bind Host</label>
              <Input value={draft.bindHost} onChange={(event) => updateDraft('bindHost', event.target.value)} placeholder="127.0.0.1" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Port</label>
              <Input value={draft.servicePort} onChange={(event) => updateDraft('servicePort', event.target.value)} placeholder="4301" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">OAuth Client ID</label>
              <Input value={draft.oauthClientId} onChange={(event) => updateDraft('oauthClientId', event.target.value)} placeholder="homebrain-alexa-skill" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">OAuth Client Secret</label>
              <Input
                value={draft.oauthClientSecret}
                onChange={(event) => updateDraft('oauthClientSecret', event.target.value)}
                placeholder={serviceStatus?.oauthClientSecretConfigured ? 'Configured. Enter a new value to replace it.' : 'Long random secret'}
                type="password"
              />
              <p className="text-xs text-muted-foreground">
                {serviceStatus?.oauthClientSecretConfigured
                  ? 'A secret is already stored. Leave this blank to keep it unchanged.'
                  : 'Use a long random secret shared with the Alexa skill account-linking setup.'}
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Event Client ID</label>
              <Input value={draft.eventClientId} onChange={(event) => updateDraft('eventClientId', event.target.value)} placeholder="Amazon event client ID" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Event Client Secret</label>
              <Input
                value={draft.eventClientSecret}
                onChange={(event) => updateDraft('eventClientSecret', event.target.value)}
                placeholder={serviceStatus?.eventClientSecretConfigured ? 'Configured. Enter a new value to replace it.' : 'Amazon event client secret'}
                type="password"
              />
              <p className="text-xs text-muted-foreground">
                {serviceStatus?.eventClientSecretConfigured
                  ? 'An Alexa event secret is already stored. Leave this blank to keep it unchanged.'
                  : 'Amazon provides this after you enable proactive Alexa events.'}
              </p>
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium">Allowed Client IDs</label>
              <Textarea value={draft.allowedClientIds} onChange={(event) => updateDraft('allowedClientIds', event.target.value)} rows={3} placeholder="One client ID per line" />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium">Allowed Redirect URIs</label>
              <Textarea value={draft.allowedRedirectUris} onChange={(event) => updateDraft('allowedRedirectUris', event.target.value)} rows={5} placeholder="https://pitangui.amazon.com/api/skill/link/..." />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium">Store File</label>
              <Input value={draft.storeFile} onChange={(event) => updateDraft('storeFile', event.target.value)} placeholder="/var/lib/homebrain-alexa/store.json" />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Auth Code TTL (ms)</label>
              <Input value={draft.authCodeTtlMs} onChange={(event) => updateDraft('authCodeTtlMs', event.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Access Token TTL (s)</label>
              <Input value={draft.accessTokenTtlSeconds} onChange={(event) => updateDraft('accessTokenTtlSeconds', event.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Refresh Token TTL (s)</label>
              <Input value={draft.refreshTokenTtlSeconds} onChange={(event) => updateDraft('refreshTokenTtlSeconds', event.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Login with Amazon Token URL</label>
              <Input value={draft.lwaTokenUrl} onChange={(event) => updateDraft('lwaTokenUrl', event.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Alexa Event Gateway URL</label>
              <Input value={draft.eventGatewayUrl} onChange={(event) => updateDraft('eventGatewayUrl', event.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Rate Limit Window (ms)</label>
              <Input value={draft.rateLimitWindowMs} onChange={(event) => updateDraft('rateLimitWindowMs', event.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Rate Limit Max Requests</label>
              <Input value={draft.rateLimitMax} onChange={(event) => updateDraft('rateLimitMax', event.target.value)} />
            </div>
            <div className="rounded-lg border border-border/60 bg-background/50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Auto-start Managed Broker</p>
                  <p className="text-xs text-muted-foreground">Start the broker automatically when HomeBrain boots.</p>
                </div>
                <Switch checked={draft.autoStart} onCheckedChange={(checked) => updateDraft('autoStart', checked === true)} />
              </div>
            </div>
            <div className="rounded-lg border border-border/60 bg-background/50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Allow Manual Hub Registration</p>
                  <p className="text-xs text-muted-foreground">Keep the broker’s manual `/api/alexa/hubs/register` path enabled.</p>
                </div>
                <Switch checked={draft.allowManualRegistration} onCheckedChange={(checked) => updateDraft('allowManualRegistration', checked === true)} />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={saveConfig} disabled={savingConfig}>
              {savingConfig ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                'Save Configuration'
              )}
            </Button>
            <Button variant="outline" onClick={() => hydrateLocalDraft(serviceStatus)}>
              Reset Draft
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pairing and Discovery</CardTitle>
          <CardDescription>
            Once the managed broker is running, pair HomeBrain to its local control URL. Alexa itself will still use the public broker origin you configured above.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
            <div className="space-y-2">
              <label className="text-sm font-medium">Broker Control URL</label>
              <Input value={pairingBaseUrl} onChange={(event) => setPairingBaseUrl(event.target.value)} placeholder={serviceStatus?.localBaseUrl || 'http://127.0.0.1:4301'} />
              <p className="text-xs text-muted-foreground">For the managed broker this is normally the local control endpoint, not the public Alexa hostname.</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">HomeBrain Pairing Code</label>
              <Input value={pairingCode} onChange={(event) => setPairingCode(event.target.value.toUpperCase())} placeholder="HBAX-XXXX-XXXX-XXXX" />
            </div>
            <div className="flex items-end">
              <Button onClick={handlePairBroker} disabled={pairingBroker}>
                {pairingBroker ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    Pairing…
                  </>
                ) : (
                  <>
                    <Link2 className="mr-2 h-4 w-4" />
                    Pair Broker
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => handleGenerateLinkCode('private')} disabled={generatingLinkCode !== ''}>
              {generatingLinkCode === 'private' ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Generating…
                </>
              ) : (
                'Generate Private Link Code'
              )}
            </Button>
            <Button variant="outline" onClick={() => handleGenerateLinkCode('public')} disabled={generatingLinkCode !== ''}>
              {generatingLinkCode === 'public' ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Generating…
                </>
              ) : (
                'Generate Public Link Code'
              )}
            </Button>
            <Button variant="outline" onClick={handleSyncDiscovery} disabled={syncingDiscovery}>
              {syncingDiscovery ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Syncing…
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Force Discovery Sync
                </>
              )}
            </Button>
            <Button variant="outline" onClick={handleFlushEvents} disabled={flushingEvents}>
              {flushingEvents ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Flushing…
                </>
              ) : (
                'Flush Broker Events'
              )}
            </Button>
            {serviceStatus?.localBaseUrl ? (
              <Button variant="ghost" onClick={() => setPairingBaseUrl(serviceStatus.localBaseUrl)}>
                Use Managed Broker URL
              </Button>
            ) : null}
          </div>

          {latestLinkCode?.code ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-900/60 dark:bg-emerald-950/10">
              <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">Active HomeBrain pairing code</p>
              <p className="mt-2 font-mono text-lg">{latestLinkCode.code}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {latestLinkCode.mode === 'public' ? 'Public' : 'Private'} mode. Expires {new Date(latestLinkCode.expiresAt).toLocaleString()}.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Readiness and Activity</CardTitle>
            <CardDescription>Use this to validate the public Alexa path after the managed broker is up.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-border/60 bg-background/50 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Readiness</p>
                <div className="mt-1 flex items-center gap-2">
                  {alexaSummary?.readiness?.status === 'pass' ? (
                    <CheckCircle className="h-4 w-4 text-emerald-600" />
                  ) : alexaSummary?.readiness?.status === 'fail' ? (
                    <XCircle className="h-4 w-4 text-red-600" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-amber-600" />
                  )}
                  <p className="text-lg font-semibold">
                    {alexaSummary?.readiness?.status === 'pass'
                      ? 'Ready'
                      : alexaSummary?.readiness?.status === 'fail'
                        ? 'Blocked'
                        : 'Needs Attention'}
                  </p>
                </div>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/50 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">TLS</p>
                <p className="mt-1 text-lg font-semibold">{formatStatusLabel(alexaSummary?.readiness?.certificate?.status || 'unknown')}</p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/50 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Reverse Proxy</p>
                <p className="mt-1 text-lg font-semibold">{alexaSummary?.readiness?.reverseProxy?.enabled ? 'Configured' : 'Missing'}</p>
              </div>
            </div>

            {Array.isArray(alexaSummary?.readiness?.checks) && alexaSummary.readiness.checks.length > 0 ? (
              <div className="space-y-2">
                {alexaSummary.readiness.checks.map((check: any, index: number) => (
                  <div key={check?.key || check?.label || `check-${index}`} className="rounded-md border border-border/60 bg-background/50 p-3">
                    <div className="flex items-center gap-2">
                      {check?.status === 'pass' ? (
                        <Shield className="h-4 w-4 text-emerald-600" />
                      ) : check?.status === 'fail' ? (
                        <XCircle className="h-4 w-4 text-red-600" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-amber-600" />
                      )}
                      <p className="text-sm font-medium">{check?.label || 'Readiness check'}</p>
                      <Badge variant="outline" className="ml-auto capitalize">{check?.status || 'info'}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{check?.message || ''}</p>
                  </div>
                ))}
              </div>
            ) : null}

            {Array.isArray(alexaSummary?.recentActivity) && alexaSummary.recentActivity.length > 0 ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">Recent Alexa activity</p>
                {alexaSummary.recentActivity.slice(0, 5).map((entry: any, index: number) => (
                  <div key={`${entry?.type || 'activity'}-${index}`} className="rounded-md border border-border/60 bg-background/50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium">{entry?.message || entry?.type || 'Alexa activity'}</p>
                      <p className="text-xs text-muted-foreground">
                        {entry?.occurredAt ? new Date(entry.occurredAt).toLocaleString() : 'Just now'}
                      </p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Direction: {entry?.direction || 'system'} • Status: {entry?.status || 'info'}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Logs</CardTitle>
            <CardDescription>Captured stdout and stderr from the managed broker process.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-[30rem] overflow-y-auto rounded-md border border-border/60 bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-100">
              {Array.isArray(serviceStatus?.logs) && serviceStatus.logs.length > 0 ? (
                serviceStatus.logs.map((entry, index) => (
                  <p key={`broker-log-${index}`}>{entry}</p>
                ))
              ) : (
                <p className="text-slate-400">No broker logs yet. Install or start the service to populate this stream.</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {Array.isArray(alexaSummary?.linkedAccounts) && alexaSummary.linkedAccounts.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Linked Alexa Households</CardTitle>
            <CardDescription>Manage rediscovery and household revocation without leaving the broker page.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {alexaSummary.linkedAccounts.map((account: any, index: number) => {
              const brokerAccountId = account?.brokerAccountId || `account-${index}`;
              const syncActionKey = `${brokerAccountId}:sync`;
              const revokeActionKey = `${brokerAccountId}:revoke`;

              return (
                <div key={brokerAccountId} className="rounded-md border border-border/60 bg-background/50 p-4">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{brokerAccountId}</p>
                      <p className="text-xs text-muted-foreground">
                        Status: {account?.status || 'unknown'} • Locale: {account?.locale || 'en-US'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Household: {account?.alexaHouseholdId || 'Not reported'} • Last seen {account?.lastSeenAt ? new Date(account.lastSeenAt).toLocaleString() : 'never'}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => handleHouseholdDiscovery(brokerAccountId)} disabled={householdActionKey !== ''}>
                        {householdActionKey === syncActionKey ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                            Queueing…
                          </>
                        ) : (
                          'Force Rediscovery'
                        )}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => handleRevokeHousehold(brokerAccountId)} disabled={householdActionKey !== ''}>
                        {householdActionKey === revokeActionKey ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                            Revoking…
                          </>
                        ) : (
                          'Revoke Household'
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
