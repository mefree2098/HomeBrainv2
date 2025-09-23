import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Radar,
  Wifi,
  Shield,
  Info,
  RefreshCw,
  Settings,
  Network
} from "lucide-react";
import {
  getDiscoveryStatus,
  toggleAutoDiscovery
} from "@/api/discovery";
import { useToast } from "@/hooks/useToast";

interface DiscoveryStats {
  enabled: boolean;
  available: boolean;
  port?: number;
  pendingDevices?: number;
  broadcastInterval?: number;
  hubId?: string;
  localIp?: string;
  message?: string;
}

interface AutoDiscoverySettingsProps {
  onStatusChange?: (enabled: boolean) => void;
}

export function AutoDiscoverySettings({ onStatusChange }: AutoDiscoverySettingsProps) {
  const { toast } = useToast();
  const [stats, setStats] = useState<DiscoveryStats>({ enabled: false, available: false });
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    fetchDiscoveryStatus();

    // Refresh status periodically
    const interval = setInterval(() => {
      fetchDiscoveryStatus();
    }, 10000); // Every 10 seconds

    return () => clearInterval(interval);
  }, []);

  const fetchDiscoveryStatus = async () => {
    try {
      const response = await getDiscoveryStatus();
      setStats(response.stats);
      onStatusChange?.(response.stats.enabled);
    } catch (error) {
      console.error('Failed to fetch discovery status:', error);
      setStats({ enabled: false, available: false, message: 'Service unavailable' });
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      const response = await toggleAutoDiscovery(enabled);

      toast({
        title: enabled ? "Auto-Discovery Enabled" : "Auto-Discovery Disabled",
        description: response.message,
      });

      // Refresh status
      await fetchDiscoveryStatus();

    } catch (error) {
      console.error('Failed to toggle auto-discovery:', error);
      toast({
        title: "Toggle Failed",
        description: error.message || "Failed to toggle auto-discovery",
        variant: "destructive"
      });
    } finally {
      setToggling(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-6">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radar className="h-5 w-5 text-blue-600" />
            <CardTitle className="text-lg">Auto-Discovery</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={stats.enabled ? "default" : "secondary"}>
              {stats.enabled ? "Active" : "Inactive"}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              onClick={fetchDiscoveryStatus}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label htmlFor="auto-discovery-toggle" className="text-sm font-medium">
              Enable Auto-Discovery
            </Label>
            <p className="text-xs text-muted-foreground">
              Automatically detect new HomeBrain devices on your network
            </p>
          </div>
          <Switch
            id="auto-discovery-toggle"
            checked={stats.enabled}
            onCheckedChange={handleToggle}
            disabled={toggling || !stats.available}
          />
        </div>

        {!stats.available && (
          <div className="flex items-start gap-2 p-3 bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <Info className="h-4 w-4 text-yellow-600 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-yellow-700 dark:text-yellow-300">
              {stats.message || "Auto-discovery service is not available"}
            </div>
          </div>
        )}

        {stats.enabled && stats.available && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  <Network className="h-3 w-3" />
                  Discovery Port
                </div>
                <div className="text-sm font-mono">{stats.port || 'N/A'}</div>
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  <Wifi className="h-3 w-3" />
                  Local IP
                </div>
                <div className="text-sm font-mono">{stats.localIp || 'N/A'}</div>
              </div>

              {stats.pendingDevices !== undefined && (
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Pending Devices</div>
                  <div className="text-sm">{stats.pendingDevices}</div>
                </div>
              )}

              {stats.broadcastInterval && (
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Broadcast Interval</div>
                  <div className="text-sm">{stats.broadcastInterval / 1000}s</div>
                </div>
              )}
            </div>

            {stats.hubId && (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Hub ID</div>
                <div className="text-xs font-mono bg-gray-100 dark:bg-gray-800 p-2 rounded">
                  {stats.hubId}
                </div>
              </div>
            )}

            <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <Shield className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-blue-700 dark:text-blue-300">
                <strong>How it works:</strong> Your HomeBrain hub broadcasts its presence on the local network.
                New remote devices can automatically discover and connect to your hub.
                You'll be prompted to approve each device before it's added to your system.
              </div>
            </div>
          </div>
        )}

        {!stats.enabled && stats.available && (
          <div className="text-xs text-muted-foreground bg-gray-50 dark:bg-gray-800 p-3 rounded">
            When enabled, your HomeBrain hub will broadcast its presence on UDP port {stats.port || 12345},
            allowing new remote devices to automatically discover and request connection to your system.
          </div>
        )}
      </CardContent>
    </Card>
  );
}