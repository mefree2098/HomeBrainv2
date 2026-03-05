import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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

export default function ModelManager({ activeModel, onModelChange }: ModelManagerProps) {
  const [installedModels, setInstalledModels] = useState<InstalledModel[]>([]);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>([]);
  const [nanoFitOnly, setNanoFitOnly] = useState(false);
  const [sortMode, setSortMode] = useState<'popular' | 'newest' | 'name'>('popular');
  const { toast } = useToast();

  useEffect(() => {
    loadModels();
  }, []);

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

  const handlePullModel = async (modelName: string, isUpdate = false) => {
    setDownloadingModel(modelName);
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
      onModelChange();
      setDialogOpen(false);
    } catch (error: any) {
      console.error('Error pulling model:', error);
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
          <DialogContent className="max-w-4xl max-h-[80vh]">
            <DialogHeader>
              <DialogTitle>Available Models</DialogTitle>
              <DialogDescription>
                Live Ollama catalog. Use search + filters to find models quickly.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search models (e.g. phi4-mini, qwen, vision)"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              />
              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as 'popular' | 'newest' | 'name')}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="popular">Sort: Popular</option>
                <option value="newest">Sort: Newest</option>
                <option value="name">Sort: Name</option>
              </select>
            </div>
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
            <p className="text-xs text-muted-foreground">
              Nano fit is an estimate based on smallest listed parameter size (&lt;= 8B).
            </p>
            <div className="overflow-auto max-h-[60vh]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Sizes</TableHead>
                    <TableHead>Meta</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAvailableModels.map(model => {
                    const isInstalled = installedModels.some(m => m.name === model.name);
                    const isDownloading = downloadingModel === model.name;

                    return (
                      <TableRow key={model.name}>
                        <TableCell className="font-medium">
                          {model.libraryUrl ? (
                            <a
                              href={model.libraryUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:underline"
                            >
                              {model.name}
                            </a>
                          ) : (
                            model.name
                          )}
                          {model.parameterSize && (
                            <Badge variant="outline" className="ml-2">
                              {model.parameterSize}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{model.description}</TableCell>
                        <TableCell>{model.parameterSize || model.size || 'N/A'}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            {model.nanoFit && (
                              <Badge className="bg-emerald-600 text-white">Nano fit</Badge>
                            )}
                            {(model.capabilities || []).map((capability) => (
                              <Badge key={`${model.name}-${capability}`} variant="outline" className="capitalize">
                                {capability}
                              </Badge>
                            ))}
                            {model.pullCount && (
                              <Badge variant="outline">{model.pullCount} pulls</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          {isInstalled ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handlePullModel(model.name, true)}
                              disabled={isDownloading}
                            >
                              {isDownloading ? 'Refreshing...' : 'Re-pull'}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              onClick={() => handlePullModel(model.name)}
                              disabled={isDownloading}
                            >
                              {isDownloading ? (
                                'Downloading...'
                              ) : (
                                <>
                                  <ArrowDownTrayIcon className="h-4 w-4 mr-1" />
                                  Download
                                </>
                              )}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filteredAvailableModels.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                        No models matched your search/filters.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
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
              {installedModels.map(model => {
                const isActive = activeModel === model.name;

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
                        disabled={downloadingModel === model.name}
                      >
                        {downloadingModel === model.name ? (
                          'Refreshing...'
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
