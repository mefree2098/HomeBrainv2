import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  getOllamaStatus,
  getOllamaLogs,
  installOllama,
  startOllamaService,
  stopOllamaService,
  checkOllamaUpdates,
  updateOllama,
} from '@/api/ollama';
import ModelManager from '@/components/ollama/ModelManager';
import ChatInterface from '@/components/ollama/ChatInterface';
import ResourceMonitor from '@/components/ollama/ResourceMonitor';
import {
  CheckCircleIcon,
  XCircleIcon,
  ArrowPathIcon,
  PlayIcon,
  StopIcon,
  CloudArrowDownIcon,
} from '@heroicons/react/24/outline';
import { useToast } from '@/hooks/useToast';

interface OllamaStatus {
  isInstalled: boolean;
  version: string | null;
  serviceRunning: boolean;
  serviceStatus: string;
  serviceOwner?: string | null;
  installedModels: any[];
  activeModel: string | null;
  updateAvailable: boolean;
  latestVersion: string | null;
  lastUpdateCheck: Date | null;
}

export default function OllamaManagement() {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('models');
  const [logs, setLogs] = useState<string[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [logSource, setLogSource] = useState<string | null>(null);
  const [logMessage, setLogMessage] = useState<string | null>(null);
  const [logLineCount, setLogLineCount] = useState(200);
  const [logReturnedCount, setLogReturnedCount] = useState(0);
  const [logTruncated, setLogTruncated] = useState(false);
  const [logFetchedOnce, setLogFetchedOnce] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    loadStatus();

    // Poll status every 30 seconds
    const interval = setInterval(loadStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadStatus = async () => {
    try {
      const data = await getOllamaStatus();
      setStatus(data);
    } catch (error: any) {
      console.error('Error loading Ollama status:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to load Ollama status',
      });
    } finally {
      setLoading(false);
    }
  };

  const loadLogs = useCallback(
    async (lineCount?: number) => {
      const requested = lineCount ?? logLineCount;
      const normalized = Number.isFinite(requested) ? requested : 200;
      const safeLineCount = Math.min(Math.max(normalized, 50), 2000);

      setLogLoading(true);
      setLogError(null);

      try {
        const data = await getOllamaLogs(safeLineCount);
        const entries = Array.isArray(data?.lines) ? data.lines : [];
        setLogs(entries);
        setLogSource(data?.source || null);
        setLogMessage(data?.message || null);
        setLogLineCount(safeLineCount);
        setLogReturnedCount(
          typeof data?.lineCount === 'number' ? data.lineCount : entries.length
        );
        setLogTruncated(Boolean(data?.truncated));
        setLogFetchedOnce(true);
      } catch (error: any) {
        console.error('Error loading Ollama logs:', error);
        setLogError(error?.message || 'Failed to fetch logs');
        setLogs([]);
        setLogSource(null);
        setLogMessage(null);
        setLogReturnedCount(0);
        setLogTruncated(false);
        setLogFetchedOnce(true);
      } finally {
        setLogLoading(false);
      }
    },
    [logLineCount]
  );

  useEffect(() => {
    if (activeTab === 'logs') {
      if (!logFetchedOnce && !logLoading) {
        loadLogs();
      }
    } else if (logFetchedOnce) {
      setLogFetchedOnce(false);
    }
  }, [activeTab, logFetchedOnce, logLoading, loadLogs]);

  const handleRefreshLogs = () => {
    loadLogs();
  };

  const handleLogLineCountChange = (value: string) => {
    const parsed = parseInt(value, 10);
    loadLogs(Number.isNaN(parsed) ? logLineCount : parsed);
  };

  const handleInstall = async () => {
    setActionLoading('install');
    toast({
      title: 'Installing Ollama',
      description: 'This may take several minutes. Please wait...',
    });

    try {
      await installOllama();
      toast({
        title: 'Success',
        description: 'Ollama installed successfully',
      });
      await loadStatus();
    } catch (error: any) {
      console.error('Error installing Ollama:', error);
      toast({
        variant: 'destructive',
        title: 'Installation Failed',
        description: error.message || 'Failed to install Ollama',
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleStartService = async () => {
    setActionLoading('start');

    try {
      await startOllamaService();
      toast({
        title: 'Success',
        description: 'Ollama service started',
      });
      await loadStatus();
    } catch (error: any) {
      console.error('Error starting service:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to start service',
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleStopService = async () => {
    setActionLoading('stop');

    try {
      const result = await stopOllamaService();
      if (result.success) {
        toast({
          title: 'Success',
          description: result.message || 'Ollama service stopped',
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Unable to stop service',
          description:
            result.message ||
            'Ollama is being managed outside HomeBrain. Stop it manually or grant sudo access.',
        });
      }
      await loadStatus();
    } catch (error: any) {
      console.error('Error stopping service:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to stop service',
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleCheckUpdates = async () => {
    setActionLoading('check-updates');

    try {
      const updateInfo = await checkOllamaUpdates();
      await loadStatus();

      if (updateInfo.updateAvailable) {
        toast({
          title: 'Update Available',
          description: `New version ${updateInfo.latestVersion} is available`,
        });
      } else {
        toast({
          title: 'Up to Date',
          description: 'You are running the latest version',
        });
      }
    } catch (error: any) {
      console.error('Error checking updates:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to check for updates',
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleUpdate = async () => {
    setActionLoading('update');
    toast({
      title: 'Updating Ollama',
      description: 'This may take several minutes. Please wait...',
    });

    try {
      await updateOllama();
      toast({
        title: 'Success',
        description: 'Ollama updated successfully',
      });
      await loadStatus();
    } catch (error: any) {
      console.error('Error updating Ollama:', error);
      toast({
        variant: 'destructive',
        title: 'Update Failed',
        description: error.message || 'Failed to update Ollama',
      });
    } finally {
      setActionLoading(null);
    }
  };

  const isExternalService = status?.serviceStatus === 'running_external';
  const isServiceRunning =
    status?.serviceStatus === 'running' || status?.serviceStatus === 'running_external';

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <ArrowPathIcon className="h-8 w-8 animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading Ollama status...</p>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Failed to load Ollama status</AlertDescription>
      </Alert>
    );
  }

  // Not installed view
  if (!status.isInstalled) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Ollama Management</h1>
          <p className="text-muted-foreground">
            Run local LLM models directly on your Jetson device
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Ollama Not Installed</CardTitle>
            <CardDescription>
              Install Ollama to run powerful language models locally on your device
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p>
              Ollama allows you to run large language models like Llama, Mistral, and others
              directly on your Jetson Orin Nano. This provides:
            </p>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground">
              <li>Complete privacy - all processing happens locally</li>
              <li>No API costs or rate limits</li>
              <li>Fast responses with GPU acceleration</li>
              <li>Works offline without internet connection</li>
            </ul>
            <Button
              size="lg"
              onClick={handleInstall}
              disabled={actionLoading === 'install'}
            >
              {actionLoading === 'install' ? (
                <>
                  <ArrowPathIcon className="h-5 w-5 mr-2 animate-spin" />
                  Installing...
                </>
              ) : (
                <>
                  <CloudArrowDownIcon className="h-5 w-5 mr-2" />
                  Install Ollama
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        <ResourceMonitor />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2">Ollama Management</h1>
        <p className="text-muted-foreground">
          Manage local LLM models and chat with AI directly on your device
        </p>
      </div>

      {/* Status Card */}
      <Card>
        <CardHeader>
          <CardTitle>Ollama Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm text-muted-foreground">Installation</span>
                {status.isInstalled ? (
                  <CheckCircleIcon className="h-5 w-5 text-green-500" />
                ) : (
                  <XCircleIcon className="h-5 w-5 text-red-500" />
                )}
              </div>
              <p className="font-semibold">
                {status.isInstalled ? `Version ${status.version}` : 'Not Installed'}
              </p>
            </div>

            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm text-muted-foreground">Service</span>
                {isServiceRunning ? (
                  <Badge className={isExternalService ? 'bg-slate-500' : 'bg-green-500'}>
                    {isExternalService ? 'External Service' : 'Running'}
                  </Badge>
                ) : (
                  <Badge variant="destructive">Stopped</Badge>
                )}
              </div>
              <div className="space-x-2">
                {isServiceRunning ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleStopService}
                    disabled={actionLoading === 'stop' || isExternalService}
                  >
                    <StopIcon className="h-4 w-4 mr-1" />
                    {isExternalService ? 'Managed Externally' : 'Stop'}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={handleStartService}
                    disabled={actionLoading === 'start'}
                  >
                    <PlayIcon className="h-4 w-4 mr-1" />
                    Start
                  </Button>
                )}
              </div>
            </div>

            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm text-muted-foreground">Updates</span>
                {status.updateAvailable ? (
                  <Badge className="bg-orange-500">Available</Badge>
                ) : (
                  <Badge variant="outline">Up to Date</Badge>
                )}
              </div>
              <div className="space-x-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCheckUpdates}
                  disabled={actionLoading === 'check-updates'}
                >
                  <ArrowPathIcon className="h-4 w-4 mr-1" />
                  Check
                </Button>
                {status.updateAvailable && (
                  <Button
                    size="sm"
                    onClick={handleUpdate}
                    disabled={actionLoading === 'update'}
                  >
                    <CloudArrowDownIcon className="h-4 w-4 mr-1" />
                    Update Ollama (sudo)
                  </Button>
                )}
              </div>
            </div>
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            Note: this updates the Ollama service binary (requires sudo). To update models, use the
            Models tab and click Update on a model.
          </p>

          {status.activeModel && (
            <div className="mt-4 pt-4 border-t">
              <span className="text-sm text-muted-foreground">Active Model:</span>
              <Badge className="ml-2 bg-blue-500">{status.activeModel}</Badge>
            </div>
          )}

          {isExternalService && (
            <Alert className="mt-4">
              <AlertDescription>
                Ollama is currently managed by{' '}
                <span className="font-semibold">
                  {status.serviceOwner || 'another user'}
                </span>
                . HomeBrain can connect but cannot stop or restart this service. Use&nbsp;
                <code className="rounded bg-muted px-2 py-1 text-xs">
                  sudo systemctl stop ollama
                </code>{' '}
                (or grant this service sudo access) if you need to control it here.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Main Content Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="resources">Resources</TabsTrigger>
        </TabsList>

        <TabsContent value="models" className="space-y-6">
          <ModelManager activeModel={status.activeModel} onModelChange={loadStatus} />
        </TabsContent>

        <TabsContent value="chat" className="space-y-6">
          {!isServiceRunning ? (
            <Alert>
              <AlertDescription>
                Ollama service is not running. Please start the service to use chat.
              </AlertDescription>
            </Alert>
          ) : !status.activeModel ? (
            <Alert>
              <AlertDescription>
                No active model selected. Please activate a model in the Models tab.
              </AlertDescription>
            </Alert>
          ) : (
            <ChatInterface activeModel={status.activeModel} />
          )}
        </TabsContent>

        <TabsContent value="logs" className="space-y-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">
                {logSource
                  ? `Showing ${logReturnedCount} line${logReturnedCount === 1 ? '' : 's'} from ${logSource}${
                      logTruncated ? ' (truncated)' : ''
                    }.`
                  : 'View recent Ollama service output.'}
              </p>
              {logMessage && (
                <p className="text-xs text-muted-foreground">{logMessage}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={String(logLineCount)}
                onValueChange={handleLogLineCountChange}
                disabled={logLoading}
              >
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Lines" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="100">Last 100 lines</SelectItem>
                  <SelectItem value="200">Last 200 lines</SelectItem>
                  <SelectItem value="500">Last 500 lines</SelectItem>
                  <SelectItem value="1000">Last 1000 lines</SelectItem>
                  <SelectItem value="2000">Last 2000 lines</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={handleRefreshLogs}
                disabled={logLoading}
              >
                <ArrowPathIcon className={`h-4 w-4 mr-1 ${logLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </div>
          <div className="rounded-md border bg-muted/40">
            {logLoading ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <ArrowPathIcon className="h-4 w-4 animate-spin" />
                Loading logs...
              </div>
            ) : logError ? (
              <div className="p-4 text-sm text-destructive">{logError}</div>
            ) : logs.length ? (
              <pre className="max-h-[420px] overflow-auto p-4 text-xs leading-5 font-mono whitespace-pre-wrap">
                {logs.join('\n')}
              </pre>
            ) : (
              <div className="p-4 text-sm text-muted-foreground">
                No logs available yet. Trigger an Ollama request and refresh.
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="resources" className="space-y-6">
          <ResourceMonitor />
        </TabsContent>
      </Tabs>
    </div>
  );
}
