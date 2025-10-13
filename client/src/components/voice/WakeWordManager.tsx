import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  getWakeWordQueueStatus
} from "@/api/wakeWords";
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

export function WakeWordManager() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<WakeWordModel[]>([]);
  const [queueSummary, setQueueSummary] = useState<{ active: any[]; pending: string[] } | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newPhrase, setNewPhrase] = useState("");
  const [sampleCount, setSampleCount] = useState(600);
  const [submitting, setSubmitting] = useState(false);
  const [polling, setPolling] = useState(false);

  const loadData = async () => {
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
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!polling) return;
    const interval = setInterval(() => {
      loadData().catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [polling]);

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
      await createWakeWordModel({
        phrase: newPhrase.trim(),
        options: {
          dataset: {
            positive: { syntheticSamples: sampleCount }
          }
        }
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
    return (
      <div className="mt-2 space-y-1">
        <Progress value={percent} />
        <p className="text-xs text-muted-foreground">
          {model.statusMessage || "Preparing"} • {percent}%
        </p>
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
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Queue status</span>
          <span className="font-medium text-foreground">{activeQueueDescription}</span>
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
