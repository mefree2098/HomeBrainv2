import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/useToast";
import {
  listWakeWordModels,
  createWakeWordModel,
  retrainWakeWordModel,
  deleteWakeWordModel,
  getWakeWordQueueStatus,
  broadcastWakeWordUpdate
} from "@/api/wakeWords";
import { getPiperVoices, downloadPiperVoice, removePiperVoice, PiperVoice, probePiperDevice } from "@/api/wakeWordVoices";
import { getSetting, updateSettings } from "@/api/settings";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

type WakeWordStatus =
  | "pending"
  | "queued"
  | "generating"
  | "training"
  | "exporting"
  | "ready"
  | "error";

interface WakeWordMetadata {
  threshold?: number;
  recommendedSensitivity?: number;
  validation?: {
    falsePositiveRate?: number;
    falseNegativeRate?: number;
  };
  artifacts?: Array<{
    format: string;
    path: string;
    size?: number;
  }>;
}

interface WakeWordTrainingMetadata {
  samplesGenerated?: number;
  durationMs?: number;
}

interface WakeWordModel {
  id: string;
  phrase: string;
  slug: string;
  status: WakeWordStatus;
  progress?: number;
  statusMessage?: string;
  engine?: string;
  format?: string;
  metadata?: WakeWordMetadata;
  trainingMetadata?: WakeWordTrainingMetadata;
  createdAt?: string;
  updatedAt?: string;
  lastTrainedAt?: string;
}

const TRAINING_STATUSES: WakeWordStatus[] = ["pending", "queued", "generating", "training", "exporting"];
const QUICK_WAKE_WORDS = ["Anna", "Hey Anna", "Henry", "Hey Henry", "Home Brain"];

export function WakeWordManager() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<WakeWordModel[]>([]);
  const [queueSummary, setQueueSummary] = useState<{ active: any[]; pending: string[] } | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newPhrase, setNewPhrase] = useState("");
  const [sampleCount, setSampleCount] = useState(600);
  const [submitting, setSubmitting] = useState(false);
  const [clipDurationSeconds, setClipDurationSeconds] = useState<number>(1.5);
  const [windowFrames, setWindowFrames] = useState<number>(16);
  const [polling, setPolling] = useState(false);
  const [voices, setVoices] = useState<PiperVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voiceActionId, setVoiceActionId] = useState<string | null>(null);
  const [selectedVoiceIds, setSelectedVoiceIds] = useState<string[]>([]);
  const [languageFilter, setLanguageFilter] = useState<string>("all");
  const [savingRegion, setSavingRegion] = useState(false);
  const saveRegionRequestId = useRef(0);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<null | { using: string; provider: string; reason?: string; executable?: string | null; voices: number; platform: string; gpuAvailable: boolean; cudaDeviceCount: number }>(null);

  const formatBytes = (bytes?: number | null) => {
    if (!bytes || bytes <= 0) {
      return "-";
    }
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const digits = value >= 100 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
  };

  const loadVoices = useCallback(async () => {
    try {
      setLoadingVoices(true);
      const response = await getPiperVoices();
      if (response?.success && Array.isArray(response.voices)) {
        setVoices(response.voices);
        const installedIds = response.voices.filter((voice) => voice.installed).map((voice) => voice.id);
        setSelectedVoiceIds((prev) => {
          const preserved = prev.filter((id) => installedIds.includes(id));
          if (preserved.length > 0) {
            const newlyInstalled = installedIds.filter((id) => !preserved.includes(id));
            return [...preserved, ...newlyInstalled];
          }
          return installedIds;
        });
        setLanguageFilter((current) => {
          if (current === "all") {
            return current;
          }
          const hasMatch = response.voices.some((voice) => {
            const code = voice.languageCode || voice.language || voice.id;
            return code === current;
          });
          return hasMatch ? current : "all";
        });
      }
    } catch (error: any) {
      console.error("Failed to load Piper voices", error);
      toast({
        title: "Failed to load voices",
        description: error?.message || "Unable to load Piper voice catalog.",
        variant: "destructive"
      });
    } finally {
      setLoadingVoices(false);
    }
  }, [toast]);

  const loadSavedVoiceRegion = useCallback(async () => {
    try {
      const response = await getSetting("voiceRegion");
      const savedValue = response?.value;
      if (typeof savedValue === "string" && savedValue.trim().length > 0) {
        setLanguageFilter(savedValue);
      }
    } catch (error) {
      console.warn("Failed to load saved voice region preference", error);
    }
  }, []);

  const persistVoiceRegion = useCallback(async (value: string) => {
    const requestId = ++saveRegionRequestId.current;
    try {
      await updateSettings({ voiceRegion: value });
    } catch (error: any) {
      console.error("Failed to save voice region preference", error);
      toast({
        title: "Failed to save region",
        description: error?.message || "Unable to save voice region preference.",
        variant: "destructive"
      });
    } finally {
      if (saveRegionRequestId.current === requestId) {
        setSavingRegion(false);
      }
    }
  }, [toast]);

  const handleLanguageFilterChange = (value: string) => {
    if (value === languageFilter) {
      return;
    }
    setLanguageFilter(value);
    setSavingRegion(true);
    void persistVoiceRegion(value);
  };

  const handleVoiceCheckboxChange = (voiceId: string, checked: boolean | "indeterminate") => {
    const isChecked = checked === true;
    setSelectedVoiceIds((prev) => {
      if (isChecked) {
        if (prev.includes(voiceId)) {
          return prev;
        }
        return [...prev, voiceId];
      }
      return prev.filter((id) => id !== voiceId);
    });
  };

  const handleDownloadVoice = async (voiceId: string) => {
    try {
      setVoiceActionId(voiceId);
      await downloadPiperVoice(voiceId);
      toast({
        title: "Voice downloaded",
        description: "The Piper voice model is ready for training."
      });
      await loadVoices();
    } catch (error: any) {
      console.error("Failed to download voice", error);
      toast({
        title: "Download failed",
        description: error?.message || "Unable to download the Piper voice.",
        variant: "destructive"
      });
    } finally {
      setVoiceActionId(null);
    }
  };

  const handleRemoveVoice = async (voiceId: string) => {
    try {
      setVoiceActionId(voiceId);
      await removePiperVoice(voiceId);
      toast({
        title: "Voice removed",
        description: "The Piper voice model has been deleted."
      });
      setSelectedVoiceIds((prev) => prev.filter((id) => id !== voiceId));
      await loadVoices();
    } catch (error: any) {
      console.error("Failed to remove voice", error);
      toast({
        title: "Remove failed",
        description: error?.message || "Unable to remove the Piper voice.",
        variant: "destructive"
      });
    } finally {
      setVoiceActionId(null);
    }
  };

  const installedVoices = useMemo(() => voices.filter((voice) => voice.installed), [voices]);
  const totalInstalledBytes = useMemo(
    () => installedVoices.reduce((total, voice) => total + (voice.sizeBytes || 0), 0),
    [installedVoices]
  );
  const languageOptions = useMemo(() => {
    const entries = new Map<string, { code: string; label: string }>();
    voices.forEach((voice) => {
      const code = voice.languageCode || voice.language || voice.id;
      const label = voice.language || "Unknown region";
      if (!entries.has(code)) {
        entries.set(code, { code, label });
      }
    });
    return Array.from(entries.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [voices]);
  const filteredVoices = useMemo(() => {
    if (languageFilter === "all") {
      return voices;
    }
    return voices.filter((voice) => {
      const code = voice.languageCode || voice.language || voice.id;
      return code === languageFilter;
    });
  }, [voices, languageFilter]);
  const selectedVoiceDetails = useMemo(
    () => installedVoices.filter((voice) => selectedVoiceIds.includes(voice.id)),
    [installedVoices, selectedVoiceIds]
  );
  const hasInstalledVoices = installedVoices.length > 0;

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const response = await listWakeWordModels();
      const fetchedModels: WakeWordModel[] = (response?.models || []).map((model: any) => ({
        id: model.id,
        phrase: model.phrase,
        slug: model.slug,
        status: model.status,
        progress: typeof model.progress === "number" ? model.progress : 0,
        statusMessage: model.statusMessage,
        engine: model.engine,
        format: model.format,
        metadata: model.metadata,
        trainingMetadata: model.trainingMetadata,
        createdAt: model.createdAt,
        updatedAt: model.updatedAt,
        lastTrainedAt: model.lastTrainedAt
      }));
      setModels(fetchedModels);

      const queue = await getWakeWordQueueStatus();
      setQueueSummary(queue?.queue || null);

      const shouldPoll = fetchedModels.some((model) => TRAINING_STATUSES.includes(model.status));
      setPolling(shouldPoll);
    } catch (error: any) {
      console.error("Failed to load wake word models", error);
      toast({
        title: "Failed to load wake words",
        description: error?.message || "Unable to fetch wake word list from hub.",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    const initialize = async () => {
      await loadSavedVoiceRegion();
      await loadData();
      await loadVoices();
    };

    void initialize();
  }, [loadData, loadVoices, loadSavedVoiceRegion]);

  useEffect(() => {
    if (!polling) return;
    const interval = setInterval(() => {
      void loadData();
      void loadVoices();
    }, 5000);
    return () => clearInterval(interval);
  }, [polling, loadData, loadVoices]);

  const handleCreate = async () => {
    if (!newPhrase.trim()) {
      toast({
        title: "Wake word phrase required",
        description: "Enter a phrase that is uncommon to avoid accidental activations.",
        variant: "destructive"
      });
      return;
    }

    setSubmitting(true);
    try {
      const selectedVoices = selectedVoiceDetails
        .filter((voice) => voice.modelPath && voice.configPath)
        .map((voice) => ({
          id: voice.id,
          name: voice.name,
          language: voice.language,
          speaker: voice.speaker,
          modelPath: voice.modelPath,
          configPath: voice.configPath,
          quality: voice.quality
        }));

      const options: any = {
        dataset: {
          clipDurationSeconds,
          windowFrames,
          positive: {
            syntheticSamples: sampleCount
          }
        }
      };

      if (selectedVoices.length > 0) {
        options.dataset.positive.tts = {
          voices: selectedVoices
        };
      }

      await createWakeWordModel({
        phrase: newPhrase.trim(),
        options
      });
      toast({
        title: "Wake word queued",
        description: "Training has been queued. Progress will appear momentarily."
      });
      setCreateDialogOpen(false);
      setNewPhrase("");
      await loadData();
    } catch (error: any) {
      console.error("Failed to queue wake word training", error);
      toast({
        title: "Failed to queue wake word",
        description: error?.message || "Hub rejected the training request.",
        variant: "destructive"
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetrain = async (model: WakeWordModel) => {
    try {
      await retrainWakeWordModel(model.id);
      toast({
        title: `Retraining "${model.phrase}"`,
        description: "Wake word retraining has been queued."
      });
      await loadData();
    } catch (error: any) {
      console.error("Failed to retrain wake word", error);
      toast({
        title: "Retraining failed",
        description: error?.message || "Unable to queue retraining.",
        variant: "destructive"
      });
    }
  };

  const handleDelete = async (model: WakeWordModel) => {
    if (!confirm(`Delete custom wake word "${model.phrase}"?`)) {
      return;
    }
    try {
      await deleteWakeWordModel(model.id);
      toast({
        title: "Wake word deleted",
        description: `"${model.phrase}" has been removed.`
      });
      await loadData();
    } catch (error: any) {
      console.error("Failed to delete wake word", error);
      toast({
        title: "Delete failed",
        description: error?.message || "Unable to delete wake word model.",
        variant: "destructive"
      });
    }
  };

  const statusBadge = (status: WakeWordStatus) => {
    switch (status) {
      case "ready":
        return <Badge variant="outline" className="bg-emerald-50 text-emerald-600 border-emerald-200">Ready</Badge>;
      case "error":
        return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">Error</Badge>;
      case "queued":
      case "pending":
        return <Badge variant="outline" className="bg-slate-100 text-slate-600 border-slate-200">Queued</Badge>;
      case "generating":
      case "training":
      case "exporting":
        return <Badge variant="outline" className="bg-amber-100 text-amber-700 border-amber-200 capitalize">{status}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const activeQueueDescription = useMemo(() => {
    if (!queueSummary) return "Idle";
    const active = queueSummary.active?.length || 0;
    const pending = queueSummary.pending?.length || 0;
    if (active === 0 && pending === 0) return "Idle";
    if (active > 0 && pending > 0) return `${active} active, ${pending} pending`;
    if (active > 0) return `${active} training`;
    return `${pending} queued`;
  }, [queueSummary]);

  const renderProgress = (model: WakeWordModel) => {
    if (!TRAINING_STATUSES.includes(model.status)) return null;
    const percent = Math.max(0, Math.min(100, Math.round((model.progress ?? 0) * 100)));
    const piperInfo = (model as any)?.metadata?.piper as
      | { using?: string; provider?: string; reason?: string; executable?: string }
      | undefined;
    const usingLabel = piperInfo?.using ? piperInfo.using.toString().toUpperCase() : undefined;
    return (
      <div className="mt-2 space-y-1">
        <Progress value={percent} />
        <p className="text-xs text-muted-foreground">
          {model.statusMessage || "Preparing"} • {percent}%
        </p>
        {piperInfo ? (
          <p className="text-[11px] text-muted-foreground/80">
            Piper: {usingLabel || "UNKNOWN"}
            {piperInfo.provider ? ` (${piperInfo.provider})` : ""}
            {piperInfo.using?.toLowerCase() === "cpu" && piperInfo.reason ? ` — ${piperInfo.reason}` : ""}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Wake Word Models</CardTitle>
          <CardDescription>
            Train custom wake words locally and deploy them to HomeBrain listeners.
          </CardDescription>
        </div>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create Wake Word
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Custom Wake Word</DialogTitle>
              <DialogDescription>
                Pick a phrase that is easy to pronounce but uncommon in daily conversation. The hub will synthesize
                diversified samples using Piper and augmentations before training.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="wake-word-phrase">Wake word phrase</Label>
                <Input
                  id="wake-word-phrase"
                  placeholder="e.g. Hey Aurora"
                  value={newPhrase}
                  onChange={(event) => setNewPhrase(event.target.value)}
                  autoFocus
                />
                <div className="flex flex-wrap gap-2">
                  {QUICK_WAKE_WORDS.map((phrase) => (
                    <Button
                      key={phrase}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setNewPhrase(phrase)}
                    >
                      {phrase}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sample-count">Synthetic samples</Label>
                <Input
                  id="sample-count"
                  type="number"
                  min={100}
                  max={2000}
                  value={sampleCount}
                  onChange={(event) => setSampleCount(Number(event.target.value || 0))}
                />
                <p className="text-xs text-muted-foreground">
                  Higher counts improve robustness at the cost of longer training time. Defaults to 600.
                </p>
              </div>
              <details className="group">
                <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">Advanced training options</summary>
                <div className="mt-3 grid gap-2">
                  <Label htmlFor="clip-duration">Clip duration (seconds)</Label>
                  <Input
                    id="clip-duration"
                    type="number"
                    step={0.1}
                    min={0.8}
                    max={5}
                    value={clipDurationSeconds}
                    onChange={(e) => setClipDurationSeconds(Number(e.target.value || 0))}
                  />
                  <p className="text-xs text-muted-foreground">
                    Minimum is auto-enforced to ensure enough context windows for training.
                  </p>
                  <Label htmlFor="window-frames">Context window (frames)</Label>
                  <Input
                    id="window-frames"
                    type="number"
                    step={1}
                    min={4}
                    max={64}
                    value={windowFrames}
                    onChange={(e) => setWindowFrames(Number(e.target.value || 0))}
                  />
                  <p className="text-xs text-muted-foreground">
                    Default 16. Lowering allows shorter clips; increasing may improve temporal context.
                  </p>
                </div>
              </details>
            </div>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setCreateDialogOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Queue Training
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="rounded-lg border border-dashed bg-white/60 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-semibold">Synthetic Voices</p>
              <p className="text-xs text-muted-foreground">
                Download Piper voices to synthesize wake word samples locally. Select which voices to include during training.
              </p>
            </div>
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <Select
                value={languageFilter}
                onValueChange={handleLanguageFilterChange}
                disabled={voices.length === 0 || savingRegion}
              >
                <SelectTrigger
                  className="w-[210px]"
                  aria-label="Filter voices by region"
                  disabled={voices.length === 0 || savingRegion}
                >
                  <SelectValue placeholder="Filter voices" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All regions</SelectItem>
                  {languageOptions.map((option) => (
                    <SelectItem key={option.code} value={option.code}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={loadVoices}
                disabled={loadingVoices || voiceActionId !== null}
              >
                {loadingVoices ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  setProbing(true);
                  setProbeResult(null);
                  try {
                    const resp = await probePiperDevice();
                    if (resp?.success && resp.info) {
                      setProbeResult(resp.info);
                      const label = `${resp.info.using?.toUpperCase?.() || 'UNKNOWN'}${resp.info.provider ? ` (${resp.info.provider})` : ''}`;
                      toast({ title: 'Piper device', description: resp.info.reason ? `${label} — ${resp.info.reason}` : label });
                    } else {
                      toast({ title: 'Piper probe failed', description: resp?.message || 'Unable to determine Piper device', variant: 'destructive' });
                    }
                  } catch (err: any) {
                    toast({ title: 'Piper probe failed', description: err?.message || 'Unable to determine Piper device', variant: 'destructive' });
                  } finally {
                    setProbing(false);
                  }
                }}
                disabled={probing}
              >
                {probing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Test Piper device
              </Button>
            </div>
          </div>

          <div className="mt-3 text-xs text-muted-foreground">
            {hasInstalledVoices ? (
              <span>
                {installedVoices.length} installed | {formatBytes(totalInstalledBytes)} on disk
                {selectedVoiceDetails.length > 0 ? ` | ${selectedVoiceDetails.length} selected for training` : ""}
              </span>
            ) : (
              <span>No voices installed yet.</span>
            )}
            {probeResult ? (
              <div className="mt-1 text-[11px]">
                Piper: {probeResult.using?.toUpperCase?.() || 'UNKNOWN'}{probeResult.provider ? ` (${probeResult.provider})` : ''}
                {probeResult.using?.toLowerCase() === 'cpu' && probeResult.reason ? ` — ${probeResult.reason}` : ''}
              </div>
            ) : null}
          </div>

          <div className="mt-4 space-y-3">
            {loadingVoices ? (
              <div className="flex items-center justify-center py-4 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading voice catalog.
              </div>
            ) : voices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Voice catalog unavailable. Ensure the hub has internet access and try refreshing.
              </p>
            ) : filteredVoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No voices match the current region filter.
              </p>
            ) : (
              filteredVoices.map((voice) => {
                const isInstalled = voice.installed && voice.modelPath && voice.configPath;
                const selected = selectedVoiceIds.includes(voice.id);
                return (
                  <div
                    key={voice.id}
                    className="flex flex-col gap-3 rounded-md border border-border/60 bg-white/70 p-3 shadow-sm md:flex-row md:items-center md:justify-between"
                  >
                    <div className="space-y-2">
                      <div>
                        <p className="font-medium">
                          {voice.name}{" "}
                          <span className="text-xs text-muted-foreground">
                            {voice.language} | {voice.quality ?? "standard"}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Speaker: {voice.speaker || "Unknown"} | Size: {formatBytes(voice.sizeBytes)}
                        </p>
                      </div>
                      {isInstalled ? (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Checkbox
                            checked={selected}
                            onCheckedChange={(checked) => handleVoiceCheckboxChange(voice.id, checked)}
                            disabled={voiceActionId === voice.id}
                          />
                          Use this voice when generating synthetic samples
                        </label>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      {isInstalled ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRemoveVoice(voice.id)}
                          disabled={voiceActionId === voice.id}
                        >
                          {voiceActionId === voice.id ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : null}
                          Remove
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => handleDownloadVoice(voice.id)}
                          disabled={voiceActionId === voice.id}
                        >
                          {voiceActionId === voice.id ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : null}
                          Download
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            {!hasInstalledVoices && !loadingVoices ? (
              <p className="text-xs text-amber-600">
                Install at least one voice to synthesize varied training samples. You can still queue training, but the
                trainer will fall back to default behaviour.
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Queue status</span>
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{activeQueueDescription}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  const resp = await broadcastWakeWordUpdate();
                  toast({
                    title: 'Wake words pushed',
                    description: `Broadcasted updates for ${resp.count ?? 0} phrase(s)`
                  });
                } catch (err: any) {
                  toast({ title: 'Broadcast failed', description: err?.message || 'Unable to push updates', variant: 'destructive' });
                }
              }}
            >
              Push to devices
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading wake words…
          </div>
        ) : models.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No custom wake words yet. Create one to start training offline.
            </p>
            <Button variant="outline" onClick={() => setCreateDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create wake word
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Wake Word</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Threshold</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model) => {
                const threshold = model.metadata?.threshold ?? model.metadata?.recommendedSensitivity ?? undefined;
                const updated = model.updatedAt ? new Date(model.updatedAt).toLocaleString() : "—";
                return (
                  <TableRow key={model.id}>
                    <TableCell>
                      <div className="font-medium">{model.phrase}</div>
                      {model.statusMessage && (
                        <div className="text-xs text-muted-foreground">{model.statusMessage}</div>
                      )}
                      {renderProgress(model)}
                    </TableCell>
                    <TableCell>{statusBadge(model.status)}</TableCell>
                    <TableCell>{threshold != null ? threshold.toFixed(2) : "—"}</TableCell>
                    <TableCell>{updated}</TableCell>
                    <TableCell className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleRetrain(model)}
                        disabled={TRAINING_STATUSES.includes(model.status)}
                      >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Retrain
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => handleDelete(model)}>
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
