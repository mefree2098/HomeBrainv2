import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Clock,
  Check,
  X,
  Smartphone,
  Speaker,
  Monitor,
  Mic,
  Trash2,
  RefreshCw,
  Wifi
} from "lucide-react";
import {
  getPendingDevices,
  approvePendingDevice,
  rejectPendingDevice,
  clearAllPendingDevices
} from "@/api/discovery";
import { useToast } from "@/hooks/useToast";

interface PendingDevice {
  id: string;
  name: string;
  type: string;
  macAddress?: string;
  ipAddress: string;
  firmwareVersion?: string;
  capabilities: string[];
  timestamp: string;
  status: string;
}

interface PendingDevicesProps {
  onDeviceApproved: () => void;
  isVisible: boolean;
}

export function PendingDevices({ onDeviceApproved, isVisible }: PendingDevicesProps) {
  const { toast } = useToast();
  const [pendingDevices, setPendingDevices] = useState<PendingDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [approvalDialog, setApprovalDialog] = useState<{
    isOpen: boolean;
    device: PendingDevice | null;
  }>({ isOpen: false, device: null });

  // Approval form state
  const [deviceName, setDeviceName] = useState("");
  const [room, setRoom] = useState("");
  const [deviceType, setDeviceType] = useState("speaker");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isVisible) {
      fetchPendingDevices();

      // Set up polling for new devices
      const interval = setInterval(() => {
        fetchPendingDevices();
      }, 5000); // Poll every 5 seconds

      return () => clearInterval(interval);
    }
  }, [isVisible]);

  const fetchPendingDevices = async () => {
    if (loading) return;

    try {
      setLoading(true);
      const response = await getPendingDevices();
      setPendingDevices(response.devices || []);
    } catch (error) {
      console.error('Failed to fetch pending devices:', error);
      // Don't show error toast for polling to avoid spam
    } finally {
      setLoading(false);
    }
  };

  const handleApproveClick = (device: PendingDevice) => {
    setDeviceName(device.name);
    setRoom("");
    setDeviceType(device.type || "speaker");
    setApprovalDialog({ isOpen: true, device });
  };

  const handleApprove = async () => {
    if (!approvalDialog.device || !deviceName.trim() || !room.trim()) {
      toast({
        title: "Validation Error",
        description: "Device name and room are required",
        variant: "destructive"
      });
      return;
    }

    setSubmitting(true);
    try {
      await approvePendingDevice(approvalDialog.device.id, {
        name: deviceName.trim(),
        room: room.trim(),
        deviceType
      });

      toast({
        title: "Device Approved",
        description: `${deviceName} has been added to your voice devices`,
      });

      // Close dialog and refresh
      setApprovalDialog({ isOpen: false, device: null });
      fetchPendingDevices();
      onDeviceApproved();

    } catch (error) {
      console.error('Failed to approve device:', error);
      toast({
        title: "Approval Failed",
        description: error.message || "Failed to approve device",
        variant: "destructive"
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async (deviceId: string, deviceName: string) => {
    try {
      await rejectPendingDevice(deviceId);

      toast({
        title: "Device Rejected",
        description: `${deviceName} was rejected and removed from pending list`,
      });

      fetchPendingDevices();

    } catch (error) {
      console.error('Failed to reject device:', error);
      toast({
        title: "Rejection Failed",
        description: error.message || "Failed to reject device",
        variant: "destructive"
      });
    }
  };

  const handleClearAll = async () => {
    if (!confirm(`Are you sure you want to clear all ${pendingDevices.length} pending devices?`)) {
      return;
    }

    try {
      const response = await clearAllPendingDevices();

      toast({
        title: "Pending Devices Cleared",
        description: `Cleared ${response.cleared} pending devices`,
      });

      fetchPendingDevices();

    } catch (error) {
      console.error('Failed to clear pending devices:', error);
      toast({
        title: "Clear Failed",
        description: error.message || "Failed to clear pending devices",
        variant: "destructive"
      });
    }
  };

  const getDeviceIcon = (type: string) => {
    switch (type) {
      case 'speaker':
        return <Speaker className="h-5 w-5" />;
      case 'display':
        return <Monitor className="h-5 w-5" />;
      case 'mobile':
        return <Smartphone className="h-5 w-5" />;
      case 'microphone':
        return <Mic className="h-5 w-5" />;
      default:
        return <Speaker className="h-5 w-5" />;
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return date.toLocaleDateString();
  };

  if (!isVisible || pendingDevices.length === 0) {
    return null;
  }

  return (
    <>
      <Card className="bg-orange-50 dark:bg-orange-950/20 border-orange-200 dark:border-orange-800">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-orange-600" />
              <CardTitle className="text-lg text-orange-700 dark:text-orange-300">
                Pending Devices ({pendingDevices.length})
              </CardTitle>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={fetchPendingDevices}
                disabled={loading}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
              {pendingDevices.length > 1 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleClearAll}
                  className="text-red-600 hover:text-red-700"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-orange-600 dark:text-orange-400 mb-4">
            New devices have been discovered on your network and are waiting for approval.
          </div>

          <div className="space-y-3">
            {pendingDevices.map((device) => (
              <div
                key={device.id}
                className="flex items-center justify-between p-3 bg-white dark:bg-gray-800 rounded-lg border"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-orange-100 dark:bg-orange-900/30 rounded-lg">
                    {getDeviceIcon(device.type)}
                  </div>
                  <div>
                    <div className="font-medium">{device.name}</div>
                    <div className="text-sm text-muted-foreground flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <Wifi className="h-3 w-3" />
                        {device.ipAddress}
                      </span>
                      <span>Discovered {formatTimestamp(device.timestamp)}</span>
                      {device.firmwareVersion && (
                        <span>v{device.firmwareVersion}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="capitalize">
                    {device.type}
                  </Badge>
                  <Button
                    size="sm"
                    onClick={() => handleApproveClick(device)}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    <Check className="h-4 w-4 mr-1" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleReject(device.id, device.name)}
                    className="text-red-600 hover:text-red-700"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Approval Dialog */}
      <Dialog
        open={approvalDialog.isOpen}
        onOpenChange={(open) => setApprovalDialog({ isOpen: open, device: null })}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {approvalDialog.device && getDeviceIcon(approvalDialog.device.type)}
              Approve Device
            </DialogTitle>
          </DialogHeader>

          {approvalDialog.device && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground bg-gray-50 dark:bg-gray-800 p-3 rounded">
                <strong>Device Info:</strong><br/>
                IP: {approvalDialog.device.ipAddress}<br/>
                {approvalDialog.device.macAddress && (
                  <>MAC: {approvalDialog.device.macAddress}<br/></>
                )}
                {approvalDialog.device.firmwareVersion && (
                  <>Version: {approvalDialog.device.firmwareVersion}</>
                )}
              </div>

              <div className="space-y-3">
                <div>
                  <Label htmlFor="deviceName">Device Name</Label>
                  <Input
                    id="deviceName"
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    placeholder="e.g., Kitchen Speaker"
                  />
                </div>

                <div>
                  <Label htmlFor="room">Room</Label>
                  <Input
                    id="room"
                    value={room}
                    onChange={(e) => setRoom(e.target.value)}
                    placeholder="e.g., Kitchen"
                  />
                </div>

                <div>
                  <Label>Device Type</Label>
                  <Select value={deviceType} onValueChange={setDeviceType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="speaker">
                        <div className="flex items-center gap-2">
                          <Speaker className="h-4 w-4" />
                          Speaker
                        </div>
                      </SelectItem>
                      <SelectItem value="display">
                        <div className="flex items-center gap-2">
                          <Monitor className="h-4 w-4" />
                          Smart Display
                        </div>
                      </SelectItem>
                      <SelectItem value="mobile">
                        <div className="flex items-center gap-2">
                          <Smartphone className="h-4 w-4" />
                          Mobile Device
                        </div>
                      </SelectItem>
                      <SelectItem value="microphone">
                        <div className="flex items-center gap-2">
                          <Mic className="h-4 w-4" />
                          Microphone Only
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-4">
                <Button
                  variant="outline"
                  onClick={() => setApprovalDialog({ isOpen: false, device: null })}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleApprove}
                  disabled={submitting || !deviceName.trim() || !room.trim()}
                  className="bg-green-600 hover:bg-green-700"
                >
                  {submitting ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                      Approving...
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4 mr-2" />
                      Approve Device
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}