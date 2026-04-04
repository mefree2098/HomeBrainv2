import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  getInstalledModels,
  getAvailableModels,
  pullModel,
  getModelPullStatus,
  deleteModel,
  activateModel,
} from '@/api/ollama';
import {
  ArrowPathIcon,
  ArrowDownTrayIcon,
  TrashIcon,
  CheckCircleIcon,
  CloudArrowDownIcon,
} from '@heroicons/react/24/outline';
import { useToast } from '@/hooks/useToast';

interface InstalledModel {
  name: string;
  size: number;
  modifiedAt: Date;
  parameterSize?: string;
  family?: string;
}

interface AvailableModel {
  name: string;
  description: string;
  size: string;
  parameterSize: string;
  parameterSizes?: string[];
  capabilities?: string[];
  pullCount?: string | null;
  pullCountValue?: number | null;
  updated?: string | null;
  updatedDaysAgo?: number | null;
  nanoFit?: boolean;
  smallestParameterB?: number | null;
  libraryUrl?: string;
}

interface ModelManagerProps {
  activeModel: string | null;
  onModelChange: () => void;
}

interface ModelPullStatus {
  active: boolean;
  modelName: string | null;
  action?: string | null;
  phase?: string | null;
  status?: string | null;
  message?: string | null;
  percent?: number | null;
  completed?: number | null;
  total?: number | null;
  digest?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  finishedAt?: string | null;
  success?: boolean | null;
  error?: string | null;
  source?: string | null;
  wasInstalled?: boolean | null;
  modelUpdated?: boolean | null;
}

interface AvailableModelVariant extends AvailableModel {
  familyName: string;
  tagName: string | null;
  displayTag: string;
}

interface AvailableModelGroup {
  familyName: string;
  description: string;
  capabilities: string[];
  pullCount?: string | null;
  pullCountValue?: number | null;
  updated?: string | null;
  updatedDaysAgo?: number | null;
  nanoFit: boolean;
  smallestParameterB?: number | null;
  libraryUrl?: string;
  variants: AvailableModelVariant[];
}

function splitAvailableModelName(name: string, parameterSize?: string) {
  const normalizedName = String(name || '').trim();
  const tagIndex = normalizedName.lastIndexOf(':');

  if (tagIndex <= 0) {
    return {
      familyName: normalizedName,
      tagName: null,
      displayTag: parameterSize || 'default'
    };
  }

  const familyName = normalizedName.slice(0, tagIndex);
  const tagName = normalizedName.slice(tagIndex + 1) || 'latest';

  return {
    familyName,
    tagName,
    displayTag: tagName === 'latest' && parameterSize ? parameterSize : tagName
  };
}

function parseModelScale(value?: string | null) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const moeMatch = normalized.match(/^([0-9]+(?:\.[0-9]+)?)x([0-9]+(?:\.[0-9]+)?)b$/);
  if (moeMatch) {
    return Number.parseFloat(moeMatch[1]) * Number.parseFloat(moeMatch[2]);
  }

  const billionsMatch = normalized.match(/^e?([0-9]+(?:\.[0-9]+)?)b$/);
  if (billionsMatch) {
    return Number.parseFloat(billionsMatch[1]);
  }

  const millionsMatch = normalized.match(/^([0-9]+(?:\.[0-9]+)?)m$/);
  if (millionsMatch) {
    return Number.parseFloat(millionsMatch[1]) / 1000;
  }

  return null;
}

function formatModelScale(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'Mixed sizes';
  }

  if (value >= 1) {
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}B`;
  }

  return `${Math.round(value * 1000)}M`;
}

function truncateModelDescription(value?: string | null, maxLength = 180) {
  const text = String(value || '').trim();
  if (!text || text.length <= maxLength) {
    return text;
  }

  const sliced = text.slice(0, maxLength);
  const breakpoint = sliced.lastIndexOf(' ');
  const safeIndex = breakpoint > Math.floor(maxLength * 0.6) ? breakpoint : maxLength;
  return `${sliced.slice(0, safeIndex).trim()}...`;
}

export default function ModelManager({ activeModel, onModelChange }: ModelManagerProps) {
  const [installedModels, setInstalledModels] = useState<InstalledModel[]>([]);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [pullStatus, setPullStatus] = useState<ModelPullStatus | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>([]);
  const [nanoFitOnly, setNanoFitOnly] = useState(false);
  const [sortMode, setSortMode] = useState<'popular' | 'newest' | 'name'>('popular');
  const { toast } = useToast();

  useEffect(() => {
    loadModels();
  }, []);

  useEffect(() => {
    loadPullStatus();
  }, []);

  useEffect(() => {
    if (!pullStatus?.active && !downloadingModel) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      loadPullStatus();
    }, 1200);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [pullStatus?.active, downloadingModel]);

  const loadModels = async () => {
    try {
      setLoading(true);
      const [installed, available] = await Promise.all([
        getInstalledModels(),
        getAvailableModels(),
      ]);
      setInstalledModels(installed.models || []);
      setAvailableModels(available.models || []);
    } catch (error: any) {
      console.error('Error loading models:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to load models',
      });
    } finally {
      setLoading(false);
    }
  };

  const loadPullStatus = async () => {
    try {
      const status = await getModelPullStatus();
      setPullStatus(status);
    } catch (error) {
      console.error('Error loading model pull status:', error);
    }
  };

  const handlePullModel = async (modelName: string, isUpdate = false) => {
    setDownloadingModel(modelName);
    setPullStatus({
      active: true,
      modelName,
      action: isUpdate ? 'refresh' : 'download',
      phase: 'starting',
      status: 'starting',
      message: `${isUpdate ? 'Refreshing' : 'Downloading'} ${modelName}...`,
      percent: null,
      completed: null,
      total: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      success: null,
      error: null,
      source: 'homebrain',
      wasInstalled: isUpdate,
      modelUpdated: null,
    });
    toast({
      title: isUpdate ? 'Refreshing Model' : 'Downloading Model',
      description: `${isUpdate ? 'Re-pulling tag for' : 'Starting download of'} ${modelName}. This may take several minutes...`,
    });

    try {
      const result = await pullModel(modelName);
      const upToDate = Boolean(result && result.modelUpdated === false && result.wasInstalled === true);
      toast({
        title: upToDate ? 'Already Current' : 'Success',
        description:
          result?.message ||
          `Model ${modelName} ${isUpdate ? 'refreshed' : 'downloaded'} successfully`,
      });
      await loadModels();
      await loadPullStatus();
      onModelChange();
      setDialogOpen(false);
    } catch (error: any) {
      console.error('Error pulling model:', error);
      setPullStatus((current) => current && current.modelName === modelName ? {
        ...current,
        active: false,
        phase: 'error',
        status: 'error',
        message: error.message || 'Failed to download model',
        finishedAt: new Date().toISOString(),
        success: false,
        error: error.message || 'Failed to download model',
      } : current);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || (isUpdate ? 'Failed to refresh model' : 'Failed to download model'),
      });
    } finally {
      setDownloadingModel(null);
    }
  };

  const handleDeleteModel = async (modelName: string) => {
    if (!confirm(`Are you sure you want to delete ${modelName}?`)) {
      return;
    }

    try {
      await deleteModel(modelName);
      toast({
        title: 'Success',
        description: `Model ${modelName} deleted successfully`,
      });
      await loadModels();
      onModelChange();
    } catch (error: any) {
      console.error('Error deleting model:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to delete model',
      });
    }
  };

  const handleActivateModel = async (modelName: string) => {
    try {
      await activateModel(modelName);
      toast({
        title: 'Success',
        description: `Model ${modelName} activated`,
      });
      onModelChange();
    } catch (error: any) {
      console.error('Error activating model:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to activate model',
      });
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const capabilityOptions = useMemo(() => {
    const values = new Set<string>();
    for (const model of availableModels) {
      for (const capability of (model.capabilities || [])) {
        values.add(capability);
      }
    }
    return Array.from(values).sort((left, right) => left.localeCompare(right));
  }, [availableModels]);

  const installedModelNames = useMemo(
    () => new Set(installedModels.map((model) => model.name)),
    [installedModels]
  );

  const toggleCapability = (capability: string) => {
    setSelectedCapabilities((current) => (
      current.includes(capability)
        ? current.filter((item) => item !== capability)
        : [...current, capability]
    ));
  };

  const filteredAvailableModels = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    const filtered = availableModels.filter((model) => {
      if (normalizedQuery) {
        const searchable = [
          model.name,
          model.description,
          model.parameterSize,
          ...(model.capabilities || [])
        ].join(' ').toLowerCase();
        if (!searchable.includes(normalizedQuery)) {
          return false;
        }
      }

      if (nanoFitOnly && !model.nanoFit) {
        return false;
      }

      if (selectedCapabilities.length) {
        const modelCaps = model.capabilities || [];
        for (const selected of selectedCapabilities) {
          if (!modelCaps.includes(selected)) {
            return false;
          }
        }
      }

      return true;
    });

    filtered.sort((left, right) => {
      if (sortMode === 'name') {
        return left.name.localeCompare(right.name);
      }

      if (sortMode === 'newest') {
        const leftAge = typeof left.updatedDaysAgo === 'number' ? left.updatedDaysAgo : Number.POSITIVE_INFINITY;
        const rightAge = typeof right.updatedDaysAgo === 'number' ? right.updatedDaysAgo : Number.POSITIVE_INFINITY;
        if (leftAge !== rightAge) {
          return leftAge - rightAge;
        }
        return left.name.localeCompare(right.name);
      }

      const leftPulls = typeof left.pullCountValue === 'number' ? left.pullCountValue : -1;
      const rightPulls = typeof right.pullCountValue === 'number' ? right.pullCountValue : -1;
      if (leftPulls !== rightPulls) {
        return rightPulls - leftPulls;
      }
      return left.name.localeCompare(right.name);
    });

    return filtered;
  }, [availableModels, nanoFitOnly, searchQuery, selectedCapabilities, sortMode]);

  const groupedAvailableModels = useMemo(() => {
    type MutableAvailableModelGroup = AvailableModelGroup & { sortIndex: number };

    const groups = new Map<string, MutableAvailableModelGroup>();

    filteredAvailableModels.forEach((model, sortIndex) => {
      const identity = splitAvailableModelName(model.name, model.parameterSize);
      const variant: AvailableModelVariant = {
        ...model,
        familyName: identity.familyName,
        tagName: identity.tagName,
        displayTag: identity.displayTag
      };

      const existing = groups.get(identity.familyName);
      if (!existing) {
        groups.set(identity.familyName, {
          familyName: identity.familyName,
          description: model.description,
          capabilities: [...new Set(model.capabilities || [])],
          pullCount: model.pullCount || null,
          pullCountValue: model.pullCountValue ?? null,
          updated: model.updated || null,
          updatedDaysAgo: model.updatedDaysAgo ?? null,
          nanoFit: Boolean(model.nanoFit),
          smallestParameterB: Number.isFinite(model.smallestParameterB) ? model.smallestParameterB : null,
          libraryUrl: model.libraryUrl,
          variants: [variant],
          sortIndex
        });
        return;
      }

      existing.variants.push(variant);
      existing.capabilities = [...new Set([...existing.capabilities, ...(model.capabilities || [])])];
      existing.nanoFit = existing.nanoFit || Boolean(model.nanoFit);
      existing.description = existing.description || model.description;
      existing.libraryUrl = existing.libraryUrl || model.libraryUrl;

      if (
        !Number.isFinite(existing.smallestParameterB) ||
        (Number.isFinite(model.smallestParameterB) && model.smallestParameterB < (existing.smallestParameterB ?? Number.POSITIVE_INFINITY))
      ) {
        existing.smallestParameterB = Number.isFinite(model.smallestParameterB) ? model.smallestParameterB : existing.smallestParameterB;
      }

      if (
        !Number.isFinite(existing.pullCountValue) ||
        (Number.isFinite(model.pullCountValue) && model.pullCountValue > (existing.pullCountValue ?? 0))
      ) {
        existing.pullCount = model.pullCount || existing.pullCount;
        existing.pullCountValue = model.pullCountValue ?? existing.pullCountValue;
      }

      if (
        !Number.isFinite(existing.updatedDaysAgo) ||
        (Number.isFinite(model.updatedDaysAgo) && model.updatedDaysAgo < (existing.updatedDaysAgo ?? Number.POSITIVE_INFINITY))
      ) {
        existing.updated = model.updated || existing.updated;
        existing.updatedDaysAgo = model.updatedDaysAgo ?? existing.updatedDaysAgo;
      }
    });

    return Array.from(groups.values())
      .sort((left, right) => left.sortIndex - right.sortIndex)
      .map(({ sortIndex: _sortIndex, ...group }) => ({
        ...group,
        variants: [...group.variants].sort((left, right) => {
          const leftScale = parseModelScale(left.displayTag) ?? parseModelScale(left.parameterSize);
          const rightScale = parseModelScale(right.displayTag) ?? parseModelScale(right.parameterSize);

          if (leftScale !== null && rightScale !== null && leftScale !== rightScale) {
            return leftScale - rightScale;
          }

          return left.displayTag.localeCompare(right.displayTag, undefined, {
            numeric: true,
            sensitivity: 'base'
          });
        })
      }));
  }, [filteredAvailableModels]);

  const activePullModelName = pullStatus?.modelName || downloadingModel;
  const activePullPercent = typeof pullStatus?.percent === 'number' ? pullStatus.percent : null;
  const anyPullActive = Boolean(pullStatus?.active || downloadingModel);
  const showPullStatus = Boolean(
    pullStatus &&
    pullStatus.modelName &&
    (pullStatus.active || downloadingModel === pullStatus.modelName)
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <CardTitle>Model Management</CardTitle>
          <CardDescription>
            `Re-pull` refreshes a model tag (like <code>llama3.2:latest</code>) and downloads new weights only if that tag changed upstream.
          </CardDescription>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <CloudArrowDownIcon className="h-5 w-5 mr-2" />
              Download Models
            </Button>
          </DialogTrigger>
          <DialogContent className="h-[min(92vh,960px)] w-[min(96vw,1120px)] max-w-none overflow-hidden border border-primary/20 bg-background/95 p-0 dark:bg-slate-950/95">
            <div className="flex h-full flex-col">
              <div className="border-b border-border/60 px-6 py-6 sm:px-8">
                <DialogHeader className="space-y-2 text-left">
                  <DialogTitle>Available Models</DialogTitle>
                  <DialogDescription>
                    Explore the live Ollama catalog by model family, then choose the exact version you want to download.
                  </DialogDescription>
                </DialogHeader>

                <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search families, versions, or capabilities"
                    className="h-11 rounded-2xl border border-input bg-background/70 px-4 text-sm"
                  />
                  <select
                    value={sortMode}
                    onChange={(event) => setSortMode(event.target.value as 'popular' | 'newest' | 'name')}
                    className="h-11 rounded-2xl border border-input bg-background/70 px-4 text-sm"
                  >
                    <option value="popular">Sort: Popular</option>
                    <option value="newest">Sort: Newest</option>
                    <option value="name">Sort: Name</option>
                  </select>
                </div>

                <div className="mt-4 rounded-2xl border border-border/60 bg-black/10 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={nanoFitOnly ? 'default' : 'outline'}
                      onClick={() => setNanoFitOnly((current) => !current)}
                    >
                      Nano fit (estimated)
                    </Button>
                    {capabilityOptions.map((capability) => (
                      <Button
                        key={capability}
                        type="button"
                        size="sm"
                        variant={selectedCapabilities.includes(capability) ? 'default' : 'outline'}
                        onClick={() => toggleCapability(capability)}
                        className="capitalize"
                      >
                        {capability}
                      </Button>
                    ))}
                    {(searchQuery || nanoFitOnly || selectedCapabilities.length > 0) && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setSearchQuery('');
                          setNanoFitOnly(false);
                          setSelectedCapabilities([]);
                        }}
                      >
                        Clear filters
                      </Button>
                    )}
                  </div>
                  <div className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    <span>
                      Nano fit is estimated from the smallest listed variant size. Pick the exact version you want before downloading.
                    </span>
                    <span>
                      {groupedAvailableModels.length} families • {filteredAvailableModels.length} versions
                    </span>
                  </div>
                </div>

                {showPullStatus && pullStatus && (
                  <div className="mt-4 rounded-2xl border border-primary/20 bg-primary/5 p-4 space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="capitalize">
                            {pullStatus.action === 'refresh' ? 'Refreshing' : 'Downloading'}
                          </Badge>
                          {pullStatus.source && (
                            <Badge variant="outline" className="uppercase tracking-wide text-[10px]">
                              {pullStatus.source}
                            </Badge>
                          )}
                        </div>
                        <p className="font-medium">{pullStatus.modelName}</p>
                        <p className="text-sm text-muted-foreground">
                          {pullStatus.message || 'Waiting for Ollama progress...'}
                        </p>
                      </div>
                      <div className="text-sm font-medium text-right">
                        {activePullPercent !== null ? `${Math.round(activePullPercent)}%` : 'Working...'}
                      </div>
                    </div>
                    {activePullPercent !== null && (
                      <Progress value={activePullPercent} className="h-2.5" />
                    )}
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto px-6 pb-6 pt-5 sm:px-8">
                {groupedAvailableModels.length === 0 ? (
                  <div className="flex h-full min-h-[260px] items-center justify-center rounded-[1.75rem] border border-dashed border-border/60 bg-black/10 px-6 text-center">
                    <div className="space-y-2">
                      <p className="text-lg font-semibold">No models matched your filters</p>
                      <p className="text-sm text-muted-foreground">
                        Try clearing one or two filters, or search by a broader family name like <code>gemma</code>, <code>qwen</code>, or <code>phi</code>.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-4 xl:grid-cols-2">
                    {groupedAvailableModels.map((group) => (
                      <article
                        key={group.familyName}
                        className="flex h-full flex-col rounded-[1.75rem] border border-border/60 bg-black/10 p-5 shadow-[0_20px_60px_rgba(2,8,23,0.18)]"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              {group.libraryUrl ? (
                                <a
                                  href={group.libraryUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-lg font-semibold leading-tight hover:underline break-all"
                                >
                                  {group.familyName}
                                </a>
                              ) : (
                                <h3 className="text-lg font-semibold leading-tight break-all">
                                  {group.familyName}
                                </h3>
                              )}
                              {group.variants.length > 1 && (
                                <Badge variant="outline">
                                  {group.variants.length} variants
                                </Badge>
                              )}
                              {group.nanoFit && (
                                <Badge className="bg-emerald-600 text-white">Nano-friendly options</Badge>
                              )}
                            </div>
                            <p className="mt-3 text-sm leading-6 text-muted-foreground">
                              {truncateModelDescription(group.description) || 'Official Ollama library model.'}
                            </p>
                          </div>
                        </div>

                        <div className="mt-4 grid gap-3 sm:grid-cols-3">
                          <div className="rounded-2xl border border-border/50 bg-background/40 p-3">
                            <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Smallest</p>
                            <p className="mt-1 text-sm font-semibold">{formatModelScale(group.smallestParameterB)}</p>
                          </div>
                          <div className="rounded-2xl border border-border/50 bg-background/40 p-3">
                            <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Popularity</p>
                            <p className="mt-1 text-sm font-semibold">{group.pullCount ? `${group.pullCount} pulls` : 'Unknown'}</p>
                          </div>
                          <div className="rounded-2xl border border-border/50 bg-background/40 p-3">
                            <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Updated</p>
                            <p className="mt-1 text-sm font-semibold">{group.updated || 'Unknown'}</p>
                          </div>
                        </div>

                        {group.capabilities.length > 0 && (
                          <div className="mt-4 flex flex-wrap gap-2">
                            {group.capabilities.map((capability) => (
                              <Badge key={`${group.familyName}-${capability}`} variant="outline" className="capitalize">
                                {capability}
                              </Badge>
                            ))}
                          </div>
                        )}

                        <div className="mt-5 space-y-3">
                          {group.variants.map((variant) => {
                            const isInstalled = installedModelNames.has(variant.name);
                            const isDownloading = activePullModelName === variant.name && anyPullActive;
                            const disablePullAction = anyPullActive && activePullModelName !== variant.name;
                            const actionNoun = isInstalled ? 'Re-pull' : 'Download';
                            const actionLabel = variant.displayTag && variant.displayTag !== 'default'
                              ? `${actionNoun} ${variant.displayTag}`
                              : actionNoun;

                            return (
                              <div
                                key={variant.name}
                                className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-background/35 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                              >
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Badge variant="outline" className="font-medium">
                                      {variant.displayTag}
                                    </Badge>
                                    {isInstalled && (
                                      <Badge className="bg-primary/15 text-primary border border-primary/20">
                                        Installed
                                      </Badge>
                                    )}
                                    {variant.nanoFit && (
                                      <Badge className="bg-emerald-600 text-white">Nano fit</Badge>
                                    )}
                                  </div>
                                  <p className="mt-2 text-sm text-muted-foreground">
                                    {(variant.parameterSize || 'Unknown size')}
                                    {variant.updated ? ` • Updated ${variant.updated}` : ''}
                                    {variant.pullCount ? ` • ${variant.pullCount} pulls` : ''}
                                  </p>
                                </div>
                                <Button
                                  size="sm"
                                  variant={isInstalled ? 'outline' : 'default'}
                                  onClick={() => handlePullModel(variant.name, isInstalled)}
                                  disabled={isDownloading || disablePullAction}
                                  className="sm:min-w-[160px]"
                                >
                                  {isDownloading
                                    ? `${isInstalled ? 'Refreshing' : 'Downloading'}${activePullPercent !== null ? ` ${Math.round(activePullPercent)}%` : '...'}`
                                    : (
                                      <>
                                        <ArrowDownTrayIcon className="mr-1 h-4 w-4" />
                                        {actionLabel}
                                      </>
                                    )}
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {showPullStatus && pullStatus && (
          <div className="mb-5 rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="capitalize">
                    {pullStatus.action === 'refresh' ? 'Refreshing' : 'Downloading'}
                  </Badge>
                  {pullStatus.source && (
                    <Badge variant="outline" className="uppercase tracking-wide text-[10px]">
                      {pullStatus.source}
                    </Badge>
                  )}
                </div>
                <p className="font-medium">{pullStatus.modelName}</p>
                <p className="text-sm text-muted-foreground">
                  {pullStatus.message || 'Waiting for Ollama progress...'}
                </p>
              </div>
              <div className="text-sm font-medium text-right">
                {activePullPercent !== null ? `${Math.round(activePullPercent)}%` : 'Working...'}
              </div>
            </div>
            {activePullPercent !== null && (
              <Progress value={activePullPercent} className="h-2.5" />
            )}
            <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span>
                {typeof pullStatus.completed === 'number' && typeof pullStatus.total === 'number'
                  ? `${formatBytes(pullStatus.completed)} of ${formatBytes(pullStatus.total)} transferred`
                  : pullStatus.updatedAt
                    ? `Last update ${new Date(pullStatus.updatedAt).toLocaleTimeString()}`
                    : 'Waiting for progress details...'}
              </span>
              {pullStatus.phase && (
                <span className="capitalize">{pullStatus.phase.replace(/_/g, ' ')}</span>
              )}
            </div>
          </div>
        )}
        {loading ? (
          <p className="text-muted-foreground">Loading models...</p>
        ) : installedModels.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-muted-foreground mb-4">No models installed yet</p>
            <Button onClick={() => setDialogOpen(true)}>
              <CloudArrowDownIcon className="h-5 w-5 mr-2" />
              Download Your First Model
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Modified</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {installedModels.map((model) => {
                const isActive = activeModel === model.name;
                const isDownloading = activePullModelName === model.name && anyPullActive;

                return (
                  <TableRow key={model.name}>
                    <TableCell className="font-medium">
                      {model.name}
                      {model.parameterSize && (
                        <Badge variant="outline" className="ml-2">
                          {model.parameterSize}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{formatBytes(model.size)}</TableCell>
                    <TableCell>
                      {model.modifiedAt
                        ? new Date(model.modifiedAt).toLocaleDateString()
                        : 'N/A'}
                    </TableCell>
                    <TableCell>
                      {isActive ? (
                        <Badge className="bg-green-500 text-white">
                          <CheckCircleIcon className="h-3 w-3 mr-1" />
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline">Inactive</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handlePullModel(model.name, true)}
                        disabled={isDownloading || (anyPullActive && activePullModelName !== model.name)}
                      >
                        {isDownloading ? (
                          `Refreshing${activePullPercent !== null ? ` ${Math.round(activePullPercent)}%` : '...'}`
                        ) : (
                          <>
                            <ArrowPathIcon className="h-4 w-4 mr-1" />
                            Re-pull
                          </>
                        )}
                      </Button>
                      {!isActive && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleActivateModel(model.name)}
                        >
                          Activate
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleDeleteModel(model.name)}
                      >
                        <TrashIcon className="h-4 w-4" />
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
