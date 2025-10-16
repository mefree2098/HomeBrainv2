import { useEffect, useMemo, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  getWhisperStatus,
  installWhisperDependencies,
  startWhisperService,
  stopWhisperService,
  getAvailableWhisperModels,
  getInstalledWhisperModels,
  downloadWhisperModel,
  activateWhisperModel,
  getWhisperLogs
} from '@/api/whisper';
import { useToast } from '@/hooks/useToast';
import {
  Cpu,
  Play,
  Square,
  Download,
  RefreshCw,
  CheckCircle,
  XCircle,
  HardDrive,
  Wrench,
  Terminal
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface WhisperModelInfo {
  name: string;
  variant?: string;
  sizeBytes?: number;
  computeType?: string;
  languages?: string[];
  path?: string;
  downloadedAt?: string;
}

interface WhisperStatus {
  isInstalled: boolean;
  serviceStatus: string;
  serviceRunning: boolean;
  servicePid: number | null;
  serviceOwner: string | null;
  activeModel: string | null;
  installedModels: WhisperModelInfo[];
  availableModels: Array<{
    name: string;
    sizeLabel: string;
    notes?: string;
    languages?: string[];
  }>;
  modelDirectory?: string;
  lastError?: {
    message: string;
    timestamp?: string;
  };
  logs?: string[];
}

function formatBytes(bytes?: number) {
  if (!bytes || Number.isNaN(bytes)) {
    return 'Unknown size';
  }
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

export default function WhisperManagement() {
  const { toast } = useToast();
  const [status, setStatus] = useState<WhisperStatus | null>(null);
  const [availableModels, setAvailableModels] = useState<WhisperStatus['availableModels']>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [selectedDownloadModel, setSelectedDownloadModel] = useState<string>('small');
  const [logs, setLogs] = useState<string[]>([]);
  const [refreshingLogs, setRefreshingLogs] = useState(false);

  const serviceHealthy = status?.serviceRunning && status.serviceStatus === 'running';

  const installedModelNames = useMemo(
    () => new Set((status?.installedModels || []).map((model) => model.name)),
    [status?.installedModels]
  );

  const loadStatus = useCallback(async () => {
    try {
      const [statusResponse, modelsResponse] = await Promise.all([
        getWhisperStatus(),
        getAvailableWhisperModels()
      ]);
      setStatus(statusResponse);
      setAvailableModels(modelsResponse?.models || []);
      setLoading(false);
    } catch (error: any) {
      console.error('Failed to load Whisper status', error);
      toast({
        variant: 'destructive',
        title: 'Unable to load status',
        description: error.message || 'Check the server logs for more details.'
      });
      setLoading(false);
    }
  }, [toast]);

  const loadModels = useCallback(async () => {
    try {
      const response = await getInstalledWhisperModels();
      setStatus((prev) =>
        prev ? { ...prev, installedModels: response.models || [] } : prev
      );
    } catch (error) {
      console.warn('Unable to refresh installed models list:', error);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      setRefreshingLogs(true);
      const data = await getWhisperLogs();
      setLogs(Array.isArray(data?.logs) ? data.logs : []);
    } catch (error) {
      console.warn('Unable to load Whisper logs:', error);
    } finally {
      setRefreshingLogs(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const interval = setInterval(() => {
      void loadStatus();
    }, 20000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const handleInstall = async () => {
    try {
      setActionLoading('install');
      await installWhisperDependencies();
      toast({
        title: 'Dependencies installed',
        description: 'faster-whisper is ready to use.'
      });
      await loadStatus();
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Installation failed',
        description: error.message || 'Unable to install dependencies.'
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleStart = async () => {
    try {
      setActionLoading('start');
      await startWhisperService(status?.activeModel || undefined);
      toast({
        title: 'Whisper started',
        description: 'Local speech-to-text will run on the Jetson.'
      });
      await loadStatus();
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Failed to start service',
        description: error.message || 'Check the logs for more details.'
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleStop = async () => {
    try {
      setActionLoading('stop');
      await stopWhisperService();
      toast({
        title: 'Whisper stopped',
        description: 'You can restart it anytime.'
      });
      await loadStatus();
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Failed to stop service',
        description: error.message || 'Service may already be stopped.'
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDownload = async () => {
    if (!selectedDownloadModel) {
      return;
    }
    try {
      setActionLoading('download');
      await downloadWhisperModel(selectedDownloadModel);
      toast({
        title: 'Model downloaded',
        description: `${selectedDownloadModel} is ready for activation.`
      });
      await Promise.all([loadStatus(), loadModels()]);
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Download failed',
        description: error.message || 'Unable to download model.'
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleActivate = async (modelName: string) => {
    try {
      setActionLoading(modelName);
      await activateWhisperModel(modelName);
      toast({
        title: 'Active model updated',
        description: `${modelName} will be used for live transcription.`
      });
      await loadStatus();
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Activation failed',
        description: error.message || 'Unable to activate model.'
      });
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="h-5 w-5" />
              Whisper Management
            </CardTitle>
            <CardDescription>Loading status…</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin" />
              Gathering service information…
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!status) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Unable to load Whisper status. Verify the server is running and try again.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Whisper Management</h1>
          <p className="text-sm text-muted-foreground">
            Control the on-device Whisper service, download models, and review health at a glance.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => loadStatus()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="bg-white/80 backdrop-blur-sm dark:bg-slate-900/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="h-5 w-5 text-indigo-500" />
              Service Status
            </CardTitle>
            <CardDescription>
              Monitor dependency installation and the background transcription worker.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              {serviceHealthy ? (
                <CheckCircle className="h-5 w-5 text-emerald-500" />
              ) : (
                <XCircle className="h-5 w-5 text-rose-500" />
              )}
              <div>
                <p className="font-medium">
                  {serviceHealthy ? 'Service running' : `Service ${status.serviceStatus}`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {status.serviceRunning
                    ? `PID ${status.servicePid || 'unknown'} · Owner ${status.serviceOwner || 'homebrain'}`
                    : 'Start the service to enable local speech-to-text.'}
                </p>
              </div>
            </div>

            {status.lastError?.message && (
              <Alert variant="destructive">
                <AlertDescription>
                  {status.lastError.message}
                  {status.lastError.timestamp && (
                    <span className="ml-1 text-xs opacity-80">
                      ({formatDistanceToNow(new Date(status.lastError.timestamp), { addSuffix: true })})
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )}

            <div className="grid gap-3 md:grid-cols-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleInstall}
                disabled={actionLoading !== null}
              >
                <Wrench className="mr-2 h-4 w-4" />
                {status.isInstalled ? 'Reinstall Dependencies' : 'Install Dependencies'}
              </Button>
              {status.serviceRunning ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleStop}
                  disabled={actionLoading !== null}
                >
                  <Square className="mr-2 h-4 w-4" />
                  Stop Service
                </Button>
              ) : (
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleStart}
                  disabled={!status.isInstalled || actionLoading !== null}
                >
                  <Play className="mr-2 h-4 w-4" />
                  Start Service
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white/80 backdrop-blur-sm dark:bg-slate-900/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="h-5 w-5 text-blue-500" />
              Model Library
            </CardTitle>
            <CardDescription>
              Download and activate local Whisper models optimized for the Jetson.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <div className="flex-1">
                <label className="text-sm font-medium">Install a new model</label>
                <Select
                  value={selectedDownloadModel}
                  onValueChange={setSelectedDownloadModel}
                  disabled={availableModels.length === 0}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableModels.map((model) => (
                      <SelectItem key={model.name} value={model.name}>
                        {model.name} · {model.sizeLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  {availableModels.find((model) => model.name === selectedDownloadModel)?.notes ||
                    'Select a model size that balances latency and accuracy.'}
                </p>
              </div>
              <Button
                variant="default"
                size="sm"
                onClick={handleDownload}
                disabled={actionLoading !== null || !status.isInstalled}
              >
                <Download className="mr-2 h-4 w-4" />
                Download
              </Button>
            </div>

            <div className="space-y-3">
              <p className="text-sm font-medium">Installed Models</p>
              {status.installedModels?.length ? (
                <div className="space-y-2">
                  {status.installedModels.map((model) => (
                    <div
                      key={model.name}
                      className="flex flex-col gap-2 rounded-lg border border-border/60 bg-white/60 p-3 dark:bg-slate-950/30 md:flex-row md:items-center md:justify-between"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{model.name}</span>
                          {status.activeModel === model.name && (
                            <Badge className="bg-emerald-500 text-white">Active</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {formatBytes(model.sizeBytes)} ·{' '}
                          {model.computeType ? `compute ${model.computeType}` : 'default precision'}
                        </p>
                        {model.downloadedAt && (
                          <p className="text-xs text-muted-foreground">
                            Installed {formatDistanceToNow(new Date(model.downloadedAt), { addSuffix: true })}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={status.activeModel === model.name || actionLoading === model.name}
                          onClick={() => handleActivate(model.name)}
                        >
                          {status.activeModel === model.name ? 'In Use' : 'Activate'}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Alert>
                  <AlertDescription>
                    No models downloaded yet. Grab the recommended <strong>small</strong> model to get started.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-white/80 backdrop-blur-sm dark:bg-slate-900/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5 text-slate-500" />
            Whisper Logs
          </CardTitle>
          <CardDescription>Review the most recent log lines captured from the Python worker.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {logs.length ? `Showing ${logs.length} log entries.` : 'No logs yet. Start the service to begin logging.'}
            </p>
            <Button variant="outline" size="sm" onClick={() => loadLogs()} disabled={refreshingLogs}>
              <RefreshCw className={`mr-2 h-4 w-4 ${refreshingLogs ? 'animate-spin' : ''}`} />
              Refresh Logs
            </Button>
          </div>
          <div className="max-h-80 overflow-auto rounded-lg border border-border/70 bg-slate-950/90 p-4 font-mono text-xs text-slate-100">
            {logs.length ? logs.map((line, index) => <div key={index}>{line}</div>) : 'No log output yet.'}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
