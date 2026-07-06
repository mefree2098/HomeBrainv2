import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/useToast";
import {
  DeployHealthResponse,
  DeployJob,
  DeployPreset,
  DeployPresetId,
  DeployStatusResponse,
  getDeployHealth,
  getDeployJob,
  getDeployPresets,
  getDeployStatus,
  restartPlatformServices,
  startPlatformDeploy
} from "@/api/platformDeploy";
import {
  PlatformService,
  checkPlatformServiceUpdates,
  getPlatformServices,
  installPlatformService,
  runPlatformServicePolicy,
  updatePlatformService,
  updatePlatformServicePolicy
} from "@/api/platformServices";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Rocket, RotateCcw, ShieldAlert } from "lucide-react";
import { AxiosError } from "axios";

const FALLBACK_PRESETS: DeployPreset[] = [
  {
    id: "safe",
    label: "Safe",
    description: "Install dependencies, build, run server tests, then restart services.",
    defaults: {
      allowDirty: false,
      installDependencies: true,
      runServerTests: true,
      runClientLint: false,
      restartServices: true
    }
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "Fastest path: pull/build/restart only. Skips dependency installs and tests.",
    defaults: {
      allowDirty: false,
      installDependencies: false,
      runServerTests: false,
      runClientLint: false,
      restartServices: true
    }
  },
  {
    id: "full",
    label: "Full",
    description: "Most thorough: install deps, lint client, run tests, then restart services.",
    defaults: {
      allowDirty: false,
      installDependencies: true,
      runServerTests: true,
      runClientLint: true,
      restartServices: true
    }
  }
];

type DeployOptionState = {
  allowDirty: boolean;
  installDependencies: boolean;
  runServerTests: boolean;
  runClientLint: boolean;
  restartServices: boolean;
};

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error && typeof error === "object") {
    const axiosError = error as AxiosError<{ message?: string; repoStatus?: { blockingDirtyEntries?: string[] } }>;
    const responseMessage = axiosError.response?.data?.message;
    if (typeof responseMessage === "string" && responseMessage.trim().length > 0) {
      const blockingDirtyEntries = axiosError.response?.data?.repoStatus?.blockingDirtyEntries || [];
      if (blockingDirtyEntries.length > 0) {
        return `${responseMessage} (${blockingDirtyEntries[0]})`;
      }
      return responseMessage;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "object" && error && "message" in error) {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
      return maybeMessage;
    }
  }
  return fallback;
};

const getHealthVariant = (status: "healthy" | "degraded" | undefined) => {
  return status === "healthy" ? "secondary" : "destructive";
};

const formatTimestamp = (value?: string | null) => {
  if (!value) {
    return "unknown";
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Date(parsed).toLocaleString();
};

const formatUptime = (seconds?: number) => {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "unknown";
  }

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
};

export function PlatformDeploy() {
  const { toast } = useToast();
  const [status, setStatus] = useState<DeployStatusResponse | null>(null);
  const [activeJob, setActiveJob] = useState<DeployJob | null>(null);
  const [presets, setPresets] = useState<DeployPreset[]>(FALLBACK_PRESETS);
  const [selectedPreset, setSelectedPreset] = useState<DeployPresetId>("safe");
  const [health, setHealth] = useState<DeployHealthResponse | null>(null);
  const [platformServices, setPlatformServices] = useState<PlatformService[]>([]);
  const [loading, setLoading] = useState(true);
  const [startingDeploy, setStartingDeploy] = useState(false);
  const [restartingServices, setRestartingServices] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [serviceAction, setServiceAction] = useState<string | null>(null);
  const [deployOptions, setDeployOptions] = useState<DeployOptionState>({
    ...FALLBACK_PRESETS[0].defaults
  });

  const wasRunningRef = useRef(false);

  const loadStatus = useCallback(async () => {
    const response = await getDeployStatus();
    setStatus(response);
    if (response.latestJob) {
      setActiveJob(response.latestJob);
      const preset = response.latestJob.options?.preset;
      if (preset === "safe" || preset === "minimal" || preset === "full") {
        setSelectedPreset(preset);
      }
    }
  }, []);

  const loadPresets = useCallback(async () => {
    const response = await getDeployPresets();
    if (response.success && Array.isArray(response.presets) && response.presets.length > 0) {
      setPresets(response.presets);
    }
  }, []);

  const loadHealth = useCallback(async (showToast = false) => {
    setCheckingHealth(true);
    try {
      const response = await getDeployHealth();
      setHealth(response);
      if (showToast) {
        toast({
          title: response.overallStatus === "healthy" ? "Health check passed" : "Health check found issues",
          description: `Status: ${response.overallStatus}`
        });
      }
    } catch (error: unknown) {
      if (showToast) {
        toast({
          title: "Health check failed",
          description: getErrorMessage(error, "Unable to run deployment health check."),
          variant: "destructive"
        });
      }
    } finally {
      setCheckingHealth(false);
    }
  }, [toast]);

  const loadPlatformServices = useCallback(async () => {
    const response = await getPlatformServices();
    if (response.success) {
      setPlatformServices(response.services);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([loadStatus(), loadPresets(), loadHealth(false), loadPlatformServices()]);
    } catch (error: unknown) {
      toast({
        title: "Deploy data unavailable",
        description: getErrorMessage(error, "Unable to fetch deployment data."),
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  }, [loadStatus, loadPresets, loadHealth, loadPlatformServices, toast]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const interval = setInterval(() => {
      void loadStatus();
    }, 10_000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  useEffect(() => {
    if (!activeJob || activeJob.status !== "running") {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const response = await getDeployJob(activeJob.id);
        setActiveJob(response.job);
      } catch {
        // Keep polling status endpoint as fallback.
      }
    }, 3_000);

    return () => clearInterval(interval);
  }, [activeJob]);

  useEffect(() => {
    const running = activeJob?.status === "running";
    if (wasRunningRef.current && !running) {
      void loadHealth(true);
      void loadStatus();
    }
    wasRunningRef.current = running;
  }, [activeJob, loadHealth, loadStatus]);

  const dirtyCount = status?.repo?.dirtyEntries?.length || 0;
  const ignoredDirtyCount = status?.repo?.ignoredDirtyEntries?.length || 0;
  const isDeployRunning = activeJob?.status === "running";
  const runtimeMismatch = status?.runtime?.repoMatchesRuntime === false;
  const restartPending = Boolean(status?.pendingRestart);

  const stepSummary = useMemo(() => {
    if (!activeJob?.steps || activeJob.steps.length === 0) {
      return [];
    }
    return activeJob.steps.map((step) => ({
      ...step,
      label: `${step.name} - ${step.status}`
    }));
  }, [activeJob]);

  const applyPreset = (presetId: DeployPresetId) => {
    const preset = presets.find((entry) => entry.id === presetId) || FALLBACK_PRESETS.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }
    setSelectedPreset(presetId);
    setDeployOptions({ ...preset.defaults });
  };

  const handleStartDeploy = async () => {
    setStartingDeploy(true);
    try {
      const response = await startPlatformDeploy({
        preset: selectedPreset,
        ...deployOptions
      });
      setActiveJob(response.job);
      toast({
        title: "Deployment started",
        description: `Preset "${selectedPreset}" is now running.`
      });
      await loadStatus();
    } catch (error: unknown) {
      toast({
        title: "Deploy failed to start",
        description: getErrorMessage(error, "Unable to start deployment job."),
        variant: "destructive"
      });
    } finally {
      setStartingDeploy(false);
    }
  };

  const handleRestartServices = async () => {
    setRestartingServices(true);
    try {
      const response = await restartPlatformServices();
      toast({
        title: "Restart queued",
        description: response.message || "Service restart command queued."
      });
    } catch (error: unknown) {
      toast({
        title: "Restart failed",
        description: getErrorMessage(error, "Unable to restart services."),
        variant: "destructive"
      });
    } finally {
      setRestartingServices(false);
    }
  };

  const runServiceAction = async (
    actionKey: string,
    title: string,
    action: () => Promise<{ service?: PlatformService }>
  ) => {
    setServiceAction(actionKey);
    try {
      const response = await action();
      if (response.service) {
        setPlatformServices((current) => current.map((service) => (
          service.serviceId === response.service?.serviceId ? response.service : service
        )));
      } else {
        await loadPlatformServices();
      }
      toast({ title, description: "Platform service state refreshed." });
    } catch (error: unknown) {
      toast({
        title: `${title} failed`,
        description: getErrorMessage(error, "Unable to update platform service."),
        variant: "destructive"
      });
    } finally {
      setServiceAction(null);
    }
  };

  const handleRunPlatformPolicy = async () => {
    setServiceAction("policy:run");
    try {
      const result = await runPlatformServicePolicy();
      await loadPlatformServices();
      toast({
        title: "Platform policy run complete",
        description: `Checked: ${result.checked.length}, updated: ${result.updated.length}.`
      });
    } catch (error: unknown) {
      toast({
        title: "Policy run failed",
        description: getErrorMessage(error, "Unable to run platform service policy."),
        variant: "destructive"
      });
    } finally {
      setServiceAction(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const healthItems = [
    {
      key: "api",
      title: "API",
      message: health?.checks.api.message || "Unknown",
      status: health?.checks.api.status
    },
    {
      key: "websocket",
      title: "WebSocket",
      message: `${health?.checks.websocket.message || "Unknown"} Connected devices: ${health?.checks.websocket.connectedDevices ?? 0}`,
      status: health?.checks.websocket.status
    },
    {
      key: "database",
      title: "Database",
      message: `${health?.checks.database.message || "Unknown"} State: ${health?.checks.database.state || "n/a"}`,
      status: health?.checks.database.status
    },
    {
      key: "wakeword",
      title: "Wake-Word Worker",
      message: `${health?.checks.wakeWordWorker.message || "Unknown"} Active jobs: ${health?.checks.wakeWordWorker.activeJobs ?? 0}, Pending: ${health?.checks.wakeWordWorker.pendingJobs ?? 0}`,
      status: health?.checks.wakeWordWorker.status
    },
    {
      key: "reverseProxy",
      title: "Reverse Proxy",
      message: health?.checks.reverseProxy.message || "Unknown",
      status: health?.checks.reverseProxy.status
    },
    {
      key: "mqttBroker",
      title: "MQTT Broker",
      message: `${health?.checks.mqttBroker?.message || "Unknown"} Prefix: ${health?.checks.mqttBroker?.topicPrefix || "n/a"}`,
      status: health?.checks.mqttBroker?.status
    },
    {
      key: "deployment",
      title: "Backend Runtime",
      message: health?.checks.deployment.message || "Unknown",
      status: health?.checks.deployment.status
    }
  ] as const;

  const renderServiceActionButton = (
    service: PlatformService,
    action: "install" | "check" | "update",
    label: string,
    onClick: () => void,
    disabled = false
  ) => {
    const key = `${service.serviceId}:${action}`;
    const busy = serviceAction === key;
    return (
      <Button size="sm" variant={action === "update" ? "default" : "outline"} onClick={onClick} disabled={busy || disabled}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : action === "check" ? <RefreshCw className="mr-2 h-4 w-4" /> : null}
        {label}
      </Button>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="bg-gradient-to-r from-blue-600 to-green-600 bg-clip-text text-3xl font-bold text-transparent">
            Platform Deploy
          </h1>
          <p className="mt-2 text-muted-foreground">
            Pull the latest GitHub code on this HomeBrain host, rebuild the frontend, and roll the backend onto the new commit.
          </p>
        </div>
        <Button variant="outline" onClick={() => void refreshAll()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Repository Status</CardTitle>
          <CardDescription>Compare code on disk with the backend process currently serving API traffic.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">Branch: {status?.repo?.branch || "unknown"}</Badge>
            <Badge variant="outline">Repo commit: {status?.repo?.shortCommit || "unknown"}</Badge>
            <Badge variant={runtimeMismatch ? "destructive" : "secondary"}>
              Backend loaded: {status?.runtime?.loadedShortCommit || "unknown"}
            </Badge>
            <Badge variant="outline">Backend booted: {formatTimestamp(status?.runtime?.bootedAt)}</Badge>
            <Badge variant="outline">Uptime: {formatUptime(status?.runtime?.uptimeSeconds)}</Badge>
            <Badge variant={dirtyCount > 0 ? "destructive" : "secondary"}>
              {dirtyCount > 0 ? `Dirty (${dirtyCount})` : "Clean"}
            </Badge>
            {ignoredDirtyCount > 0 ? (
              <Badge variant="outline">Ignored dist artifacts: {ignoredDirtyCount}</Badge>
            ) : null}
            {restartPending ? (
              <Badge variant="destructive">
                Restart pending: {status?.pendingRestart?.expectedShortCommit || "unknown"}
              </Badge>
            ) : null}
            {typeof status?.repo?.behind === "number" ? (
              <Badge variant="outline">Behind: {status.repo.behind}</Badge>
            ) : null}
            {typeof status?.repo?.ahead === "number" ? (
              <Badge variant="outline">Ahead: {status.repo.ahead}</Badge>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground">Remote: {status?.repo?.remote || "unknown"}</div>
          {runtimeMismatch ? (
            <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-100">
              <div className="mb-1 flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4" />
                Backend restart still required
              </div>
              The repo is on {status?.repo?.shortCommit || "unknown"}, but the running backend is still serving {status?.runtime?.loadedShortCommit || "unknown"}.
              New API routes and backend behavior will not be live until the service finishes restarting.
            </div>
          ) : null}
          {restartPending ? (
            <div className="rounded-md border border-blue-300 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
              <div className="mb-1 flex items-center gap-2 font-semibold">
                <RefreshCw className="h-4 w-4" />
                Restart handoff pending
              </div>
              Waiting for a new backend process to boot commit {status?.pendingRestart?.expectedShortCommit || "unknown"}.
              Requested at {formatTimestamp(status?.pendingRestart?.requestedAt)} by {status?.pendingRestart?.actor || "unknown"}.
            </div>
          ) : null}
          {dirtyCount > 0 ? (
            <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-100">
              <div className="mb-1 flex items-center gap-2 font-semibold">
                <ShieldAlert className="h-4 w-4" />
                Uncommitted changes detected
              </div>
              <div className="max-h-28 overflow-auto whitespace-pre-wrap font-mono">
                {status?.repo?.dirtyEntries?.join("\n")}
              </div>
            </div>
          ) : null}
          {dirtyCount === 0 && ignoredDirtyCount > 0 ? (
            <div className="rounded-md border border-blue-300 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
              <div className="mb-1 flex items-center gap-2 font-semibold">
                <ShieldAlert className="h-4 w-4" />
                Generated client/dist artifacts ignored
              </div>
              <div className="max-h-28 overflow-auto whitespace-pre-wrap font-mono">
                {status?.repo?.ignoredDirtyEntries?.join("\n")}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deploy Presets</CardTitle>
          <CardDescription>Apply a preset, then optionally fine-tune advanced toggles below.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset.id)}
                className={`rounded-md border p-3 text-left transition ${
                  selectedPreset === preset.id
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                    : "hover:border-blue-300"
                }`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-semibold">{preset.label}</span>
                  {selectedPreset === preset.id ? (
                    <CheckCircle2 className="h-4 w-4 text-blue-600" />
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">{preset.description}</p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deploy Controls</CardTitle>
          <CardDescription>One-click backend + frontend deploy workflow.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex items-center justify-between rounded-md border p-3 text-sm">
              Allow deploy when repo is dirty
              <Switch
                checked={deployOptions.allowDirty}
                onCheckedChange={(checked) => setDeployOptions((prev) => ({ ...prev, allowDirty: checked }))}
              />
            </label>
            <label className="flex items-center justify-between rounded-md border p-3 text-sm">
              Reinstall npm dependencies
              <Switch
                checked={deployOptions.installDependencies}
                onCheckedChange={(checked) => setDeployOptions((prev) => ({ ...prev, installDependencies: checked }))}
              />
            </label>
            <label className="flex items-center justify-between rounded-md border p-3 text-sm">
              Run server tests
              <Switch
                checked={deployOptions.runServerTests}
                onCheckedChange={(checked) => setDeployOptions((prev) => ({ ...prev, runServerTests: checked }))}
              />
            </label>
            <label className="flex items-center justify-between rounded-md border p-3 text-sm">
              Run client lint
              <Switch
                checked={deployOptions.runClientLint}
                onCheckedChange={(checked) => setDeployOptions((prev) => ({ ...prev, runClientLint: checked }))}
              />
            </label>
            <label className="flex items-center justify-between rounded-md border p-3 text-sm">
              Restart backend services after deploy
              <Switch
                checked={deployOptions.restartServices}
                onCheckedChange={(checked) => setDeployOptions((prev) => ({ ...prev, restartServices: checked }))}
              />
            </label>
          </div>

          {!deployOptions.restartServices ? (
            <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-100">
              Frontend assets and backend files can still update with restart disabled, but the running API will stay on the old commit until services are restarted.
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button onClick={handleStartDeploy} disabled={isDeployRunning || startingDeploy}>
              {isDeployRunning || startingDeploy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="mr-2 h-4 w-4" />
              )}
              Deploy Backend + Frontend
            </Button>
            <Button variant="outline" onClick={handleRestartServices} disabled={restartingServices}>
              {restartingServices ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" />
              )}
              Restart Services
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Post-Deploy Health Check</span>
            <Badge variant={getHealthVariant(health?.overallStatus)}>
              {health?.overallStatus || "unknown"}
            </Badge>
          </CardTitle>
          <CardDescription>
            API, runtime commit, websocket, database, and worker verification on the hub.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Last checked: {health?.checkedAt ? new Date(health.checkedAt).toLocaleString() : "never"}</span>
            <Button variant="outline" size="sm" onClick={() => void loadHealth(true)} disabled={checkingHealth}>
              {checkingHealth ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Run Health Check
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {healthItems.map((item) => (
              <div key={item.key} className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium">{item.title}</span>
                  <Badge variant={getHealthVariant(item.status)}>{item.status || "unknown"}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{item.message}</p>
              </div>
            ))}
          </div>
          {health?.overallStatus === "degraded" ? (
            <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-100">
              <div className="mb-1 flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4" />
                Some checks are degraded
              </div>
              Review the check messages above before the next production deployment.
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Managed Platform Services</span>
            <Button variant="outline" size="sm" onClick={handleRunPlatformPolicy} disabled={serviceAction === "policy:run"}>
              {serviceAction === "policy:run" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Run Update Policy
            </Button>
          </CardTitle>
          <CardDescription>
            Caddy, MQTT, and Pi-hole are provisioned during deploy and can be updated after a stability delay.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-3">
          {platformServices.map((service) => (
            <div key={service.serviceId} className="rounded-md border p-3">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{service.displayName}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{service.managementNotes}</div>
                </div>
                <Badge variant={service.active ? "secondary" : "destructive"}>
                  {service.active ? "running" : service.installed ? "stopped" : "missing"}
                </Badge>
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div>Current: {service.currentVersion || "unknown"}</div>
                <div>Latest: {service.latestVersion || "unknown"}</div>
                <div>Last checked: {formatTimestamp(service.lastCheckedAt)}</div>
                <div>Auto eligible: {formatTimestamp(service.eligibleForAutoUpdateAt)}</div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {renderServiceActionButton(service, "install", service.installed ? "Repair" : "Install", () => {
                  void runServiceAction(`${service.serviceId}:install`, `${service.displayName} install`, () => installPlatformService(service.serviceId));
                })}
                {renderServiceActionButton(service, "check", "Check", () => {
                  void runServiceAction(`${service.serviceId}:check`, `${service.displayName} update check`, () => checkPlatformServiceUpdates(service.serviceId));
                })}
                {renderServiceActionButton(service, "update", "Update", () => {
                  void runServiceAction(`${service.serviceId}:update`, `${service.displayName} update`, () => updatePlatformService(service.serviceId));
                }, !service.installed || !service.updateAvailable)}
              </div>
              <div className="mt-4 space-y-3 border-t pt-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">Weekly checks</span>
                  <Switch
                    checked={service.policy.autoCheckEnabled}
                    onCheckedChange={(checked) => {
                      void runServiceAction(`${service.serviceId}:policy-check`, `${service.displayName} policy`, () => updatePlatformServicePolicy(service.serviceId, {
                        autoCheckEnabled: checked
                      }));
                    }}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">Auto-update after {service.policy.stabilityDelayDays}d</span>
                  <Switch
                    checked={service.policy.autoUpdateEnabled}
                    onCheckedChange={(checked) => {
                      void runServiceAction(`${service.serviceId}:policy-update`, `${service.displayName} policy`, () => updatePlatformServicePolicy(service.serviceId, {
                        autoUpdateEnabled: checked
                      }));
                    }}
                  />
                </div>
                {service.updateAvailable ? (
                  <div className="rounded-md border border-yellow-300 bg-yellow-50 p-2 text-xs text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-100">
                    Update candidate is waiting for the stability window.
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {platformServices.length === 0 ? (
            <div className="rounded-md border p-3 text-sm text-muted-foreground lg:col-span-3">
              Platform service inventory is not available yet.
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Latest Job</CardTitle>
          <CardDescription>{activeJob ? `Job ${activeJob.id}` : "No deployment jobs have run yet."}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {activeJob ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge variant={activeJob.status === "failed" ? "destructive" : "secondary"}>{activeJob.status}</Badge>
                <Badge variant="outline">Preset: {activeJob.options?.preset || "custom"}</Badge>
                <Badge variant="outline">Step: {activeJob.currentStep}</Badge>
                <Badge variant="outline">Started: {new Date(activeJob.startedAt).toLocaleString()}</Badge>
                {activeJob.completedAt ? (
                  <Badge variant="outline">Completed: {new Date(activeJob.completedAt).toLocaleString()}</Badge>
                ) : null}
              </div>

              <div className="space-y-1 text-sm">
                {stepSummary.map((step) => (
                  <div key={step.name} className="rounded border px-3 py-2">
                    <span className="font-medium">{step.label}</span>
                    {step.error ? <div className="mt-1 text-xs text-destructive">{step.error}</div> : null}
                  </div>
                ))}
              </div>

              <div>
                <p className="mb-2 text-sm font-medium">Log tail</p>
                <pre className="max-h-80 overflow-auto rounded-md border bg-black/90 p-3 text-xs text-green-300">
                  {activeJob.logTail || "No logs yet."}
                </pre>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Run a deployment to see status and logs.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
