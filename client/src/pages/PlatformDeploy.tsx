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

export function PlatformDeploy() {
  const { toast } = useToast();
  const [status, setStatus] = useState<DeployStatusResponse | null>(null);
  const [activeJob, setActiveJob] = useState<DeployJob | null>(null);
  const [presets, setPresets] = useState<DeployPreset[]>(FALLBACK_PRESETS);
  const [selectedPreset, setSelectedPreset] = useState<DeployPresetId>("safe");
  const [health, setHealth] = useState<DeployHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [startingDeploy, setStartingDeploy] = useState(false);
  const [restartingServices, setRestartingServices] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(false);
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

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([loadStatus(), loadPresets(), loadHealth(false)]);
    } catch (error: unknown) {
      toast({
        title: "Deploy data unavailable",
        description: getErrorMessage(error, "Unable to fetch deployment data."),
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  }, [loadStatus, loadPresets, loadHealth, toast]);

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
    }
  ] as const;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="bg-gradient-to-r from-blue-600 to-green-600 bg-clip-text text-3xl font-bold text-transparent">
            Platform Deploy
          </h1>
          <p className="mt-2 text-muted-foreground">
            Pull latest GitHub code on this Jetson and deploy from the HomeBrain UI.
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
          <CardDescription>Current local repository state on the HomeBrain host.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">Branch: {status?.repo?.branch || "unknown"}</Badge>
            <Badge variant="outline">Commit: {status?.repo?.shortCommit || "unknown"}</Badge>
            <Badge variant={dirtyCount > 0 ? "destructive" : "secondary"}>
              {dirtyCount > 0 ? `Dirty (${dirtyCount})` : "Clean"}
            </Badge>
            {ignoredDirtyCount > 0 ? (
              <Badge variant="outline">Ignored dist artifacts: {ignoredDirtyCount}</Badge>
            ) : null}
            {typeof status?.repo?.behind === "number" ? (
              <Badge variant="outline">Behind: {status.repo.behind}</Badge>
            ) : null}
            {typeof status?.repo?.ahead === "number" ? (
              <Badge variant="outline">Ahead: {status.repo.ahead}</Badge>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground">Remote: {status?.repo?.remote || "unknown"}</div>
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
          <CardDescription>One-click pull/build/test/restart workflow.</CardDescription>
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
              Restart services after deploy
              <Switch
                checked={deployOptions.restartServices}
                onCheckedChange={(checked) => setDeployOptions((prev) => ({ ...prev, restartServices: checked }))}
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={handleStartDeploy} disabled={isDeployRunning || startingDeploy}>
              {isDeployRunning || startingDeploy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="mr-2 h-4 w-4" />
              )}
              Pull + Deploy Latest
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
            API, websocket, database, and wake-word worker verification on the hub.
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
