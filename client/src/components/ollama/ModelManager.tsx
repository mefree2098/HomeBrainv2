import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

  const handlePullModel = async (modelName: string) => {
    setDownloadingModel(modelName);
    toast({
      title: 'Downloading Model',
      description: `Starting download of ${modelName}. This may take several minutes...`,
    });

    try {
      await pullModel(modelName);
      toast({
        title: 'Success',
        description: `Model ${modelName} downloaded successfully`,
      });
      await loadModels();
      onModelChange();
      setDialogOpen(false);
    } catch (error: any) {
      console.error('Error pulling model:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to download model',
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

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Model Management</CardTitle>
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
                Select a model to download. Larger models provide better quality but require more resources.
              </DialogDescription>
            </DialogHeader>
            <div className="overflow-auto max-h-[60vh]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {availableModels.map(model => {
                    const isInstalled = installedModels.some(m => m.name === model.name);
                    const isDownloading = downloadingModel === model.name;

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
                        <TableCell className="text-sm">{model.description}</TableCell>
                        <TableCell>{model.size}</TableCell>
                        <TableCell className="text-right">
                          {isInstalled ? (
                            <Badge variant="secondary">Installed</Badge>
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
                        <Badge className="bg-green-500">
                          <CheckCircleIcon className="h-3 w-3 mr-1" />
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline">Inactive</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
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
