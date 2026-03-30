import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { getResourceUtilization } from '@/api/resources';
import { CpuChipIcon, CircleStackIcon, ServerIcon, FireIcon } from '@heroicons/react/24/outline';

interface ResourceData {
  cpu: {
    usagePercent: number;
    cores: number;
    model: string;
  };
  memory: {
    usagePercent: number;
    usedGB: number;
    totalGB: number;
  };
  disk: {
    usagePercent: number;
    usedGB: number;
    totalGB: number;
  };
  gpu?: {
    available: boolean;
    detected?: boolean;
    usagePercent: number;
    type: string;
    message?: string;
  };
  temperature?: {
    available: boolean;
    average: number;
    maximum: number;
    unit: string;
  };
  uptime: {
    formatted: string;
  };
  systemInfo: {
    hostname: string;
    platform: string;
    arch: string;
    osName?: string;
    isJetson?: boolean;
    jetsonModel?: string;
  };
}

export default function ResourceMonitor() {
  const [resources, setResources] = useState<ResourceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchResources = async () => {
    try {
      const data = await getResourceUtilization();
      setResources(data);
      setError(null);
    } catch (err: any) {
      console.error('Error fetching resources:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchResources();

    // Poll every 5 seconds
    const interval = setInterval(fetchResources, 5000);

    return () => clearInterval(interval);
  }, []);

  const getUsageColor = (percent: number) => {
    if (percent >= 90) return 'text-red-500';
    if (percent >= 70) return 'text-yellow-500';
    return 'text-green-500';
  };

  const gpuDetected = Boolean(resources?.gpu?.detected ?? resources?.gpu?.available);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>System Resources</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Loading resource data...</p>
        </CardContent>
      </Card>
    );
  }

  if (error || !resources) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>System Resources</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-500">Error: {error || 'Failed to load resources'}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ServerIcon className="h-5 w-5" />
          System Resources
        </CardTitle>
        {resources.systemInfo.isJetson && (
          <p className="text-sm text-muted-foreground">
            {resources.systemInfo.jetsonModel || 'NVIDIA Jetson'} • Uptime: {resources.uptime.formatted}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {/* CPU */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CpuChipIcon className="h-5 w-5 text-blue-500" />
              <span className="font-medium">CPU</span>
            </div>
            <span className={`font-semibold ${getUsageColor(resources.cpu.usagePercent)}`}>
              {resources.cpu.usagePercent}%
            </span>
          </div>
          <Progress value={resources.cpu.usagePercent} className="h-2" />
          <p className="text-xs text-muted-foreground">
            {resources.cpu.cores} cores • {resources.cpu.model}
          </p>
        </div>

        {/* Memory */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CircleStackIcon className="h-5 w-5 text-purple-500" />
              <span className="font-medium">Memory</span>
            </div>
            <span className={`font-semibold ${getUsageColor(resources.memory.usagePercent)}`}>
              {resources.memory.usagePercent}%
            </span>
          </div>
          <Progress value={resources.memory.usagePercent} className="h-2" />
          <p className="text-xs text-muted-foreground">
            {resources.memory.usedGB.toFixed(2)} GB / {resources.memory.totalGB.toFixed(2)} GB
          </p>
        </div>

        {/* Disk */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ServerIcon className="h-5 w-5 text-orange-500" />
              <span className="font-medium">Disk</span>
            </div>
            <span className={`font-semibold ${getUsageColor(resources.disk.usagePercent)}`}>
              {resources.disk.usagePercent}%
            </span>
          </div>
          <Progress value={resources.disk.usagePercent} className="h-2" />
          <p className="text-xs text-muted-foreground">
            {resources.disk.usedGB?.toFixed(2) || 'N/A'} GB / {resources.disk.totalGB?.toFixed(2) || 'N/A'} GB used
          </p>
        </div>

        {/* GPU */}
        {gpuDetected && resources.gpu && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CpuChipIcon className="h-5 w-5 text-green-500" />
                <span className="font-medium">GPU</span>
              </div>
              <span className={`font-semibold ${resources.gpu.available ? getUsageColor(resources.gpu.usagePercent) : 'text-muted-foreground'}`}>
                {resources.gpu.available ? `${resources.gpu.usagePercent}%` : 'Detected'}
              </span>
            </div>
            <Progress value={resources.gpu.available ? resources.gpu.usagePercent : 0} className="h-2" />
            <p className="text-xs text-muted-foreground">
              {resources.gpu.available ? resources.gpu.type : resources.gpu.message || resources.gpu.type}
            </p>
          </div>
        )}

        {/* Temperature (if available) */}
        {resources.temperature?.available && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FireIcon className="h-5 w-5 text-red-500" />
                <span className="font-medium">Temperature</span>
              </div>
              <span className="font-semibold">
                {resources.temperature.average}°C / {resources.temperature.maximum}°C
              </span>
            </div>
            <p className="text-xs text-muted-foreground">Average / Maximum</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
