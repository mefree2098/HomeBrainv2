import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Copy, Plus, Smartphone, Speaker, Monitor, Mic, Download, Terminal, CheckCircle, XCircle } from "lucide-react";
import { registerRemoteDevice, getRemoteDeviceSetupInstructions } from "@/api/remoteDevices";
import { useToast } from "@/hooks/useToast";

interface SetupInstructions {
  overview: string;
  requirements: string[];
  steps: Array<{
    title: string;
    description: string;
    commands?: string[];
  }>;
  downloadUrl: string;
  configTemplate: {
    hubUrl: string;
    audioConfig: {
      sampleRate: number;
      channels: number;
      recordingDevice: string;
      playbackDevice: string;
    };
  };
}

interface RemoteDeviceSetupProps {
  onDeviceRegistered: () => void;
}

export function RemoteDeviceSetup({ onDeviceRegistered }: RemoteDeviceSetupProps) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [setupInstructions, setSetupInstructions] = useState<SetupInstructions | null>(null);

  // Device registration form
  const [deviceName, setDeviceName] = useState("");
  const [room, setRoom] = useState("");
  const [deviceType, setDeviceType] = useState("speaker");
  const [macAddress, setMacAddress] = useState("");

  // Registration result
  const [registrationResult, setRegistrationResult] = useState<{
    device: any;
    registrationCode: string;
  } | null>(null);

  const handleOpenDialog = async () => {
    setIsOpen(true);
    try {
      const instructions = await getRemoteDeviceSetupInstructions();
      setSetupInstructions(instructions.instructions);
    } catch (error) {
      console.error('Failed to fetch setup instructions:', error);
      toast({
        title: "Error",
        description: "Failed to load setup instructions",
        variant: "destructive"
      });
    }
  };

  const handleRegisterDevice = async () => {
    if (!deviceName.trim() || !room.trim()) {
      toast({
        title: "Validation Error",
        description: "Device name and room are required",
        variant: "destructive"
      });
      return;
    }

    setLoading(true);
    try {
      const result = await registerRemoteDevice({
        name: deviceName.trim(),
        room: room.trim(),
        deviceType,
        macAddress: macAddress.trim() || undefined
      });

      setRegistrationResult({
        device: result.device,
        registrationCode: result.registrationCode
      });

      setStep(2);

      toast({
        title: "Device Registered",
        description: "Remote device registered successfully. Use the registration code to complete setup.",
      });

      onDeviceRegistered();

    } catch (error) {
      console.error('Failed to register device:', error);
      toast({
        title: "Registration Failed",
        description: error.message || "Failed to register remote device",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast({
      title: "Copied",
      description: `${label} copied to clipboard`,
    });
  };

  const resetDialog = () => {
    setStep(1);
    setDeviceName("");
    setRoom("");
    setDeviceType("speaker");
    setMacAddress("");
    setRegistrationResult(null);
    setIsOpen(false);
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

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button onClick={handleOpenDialog} className="flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Add Remote Device
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {getDeviceIcon(deviceType)}
            Remote Device Setup
          </DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-6">
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="deviceName">Device Name</Label>
                  <Input
                    id="deviceName"
                    placeholder="e.g., Living Room Speaker"
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="room">Room</Label>
                  <Input
                    id="room"
                    placeholder="e.g., Living Room"
                    value={room}
                    onChange={(e) => setRoom(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Device Type</Label>
                  <Select value={deviceType} onValueChange={setDeviceType}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select device type" />
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
                <div className="space-y-2">
                  <Label htmlFor="macAddress">MAC Address (Optional)</Label>
                  <Input
                    id="macAddress"
                    placeholder="e.g., AA:BB:CC:DD:EE:FF"
                    value={macAddress}
                    onChange={(e) => setMacAddress(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={resetDialog}>
                Cancel
              </Button>
              <Button onClick={handleRegisterDevice} disabled={loading}>
                {loading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                    Registering...
                  </>
                ) : (
                  'Register Device'
                )}
              </Button>
            </div>
          </div>
        )}

        {step === 2 && registrationResult && (
          <div className="space-y-6">
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle className="h-5 w-5" />
              <span className="font-semibold">Device Registered Successfully!</span>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Registration Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-semibold">Device Name</Label>
                    <p className="text-sm text-muted-foreground">{registrationResult.device.name}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-semibold">Room</Label>
                    <p className="text-sm text-muted-foreground">{registrationResult.device.room}</p>
                  </div>
                </div>

                <div>
                  <Label className="text-sm font-semibold">Registration Code</Label>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="secondary" className="text-lg font-mono px-4 py-2">
                      {registrationResult.registrationCode}
                    </Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => copyToClipboard(registrationResult.registrationCode, 'Registration code')}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    This code expires in 24 hours
                  </p>
                </div>
              </CardContent>
            </Card>

            {setupInstructions && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Terminal className="h-5 w-5" />
                    Setup Instructions
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <h4 className="font-semibold mb-2">Overview</h4>
                    <p className="text-sm text-muted-foreground">{setupInstructions.overview}</p>
                  </div>

                  <div>
                    <h4 className="font-semibold mb-2">Requirements</h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      {setupInstructions.requirements.map((req, index) => (
                        <li key={index} className="flex items-center gap-2">
                          <div className="w-1 h-1 bg-current rounded-full" />
                          {req}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <h4 className="font-semibold mb-2">Quick Setup Commands</h4>
                    <div className="space-y-3">
                      {setupInstructions.steps.slice(0, 2).map((step, index) => (
                        <div key={index} className="border rounded-lg p-3">
                          <h5 className="font-medium text-sm mb-1">{step.title}</h5>
                          <p className="text-xs text-muted-foreground mb-2">{step.description}</p>
                          {step.commands && (
                            <div className="space-y-1">
                              {step.commands.map((command, cmdIndex) => (
                                <div key={cmdIndex} className="flex items-center gap-2">
                                  <code className="text-xs bg-muted px-2 py-1 rounded flex-1 font-mono">
                                    {command}
                                  </code>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => copyToClipboard(command, 'Command')}
                                  >
                                    <Copy className="h-3 w-3" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}

                      <div className="border rounded-lg p-3 bg-blue-50 dark:bg-blue-950/20">
                        <h5 className="font-medium text-sm mb-1">Start Remote Service</h5>
                        <p className="text-xs text-muted-foreground mb-2">
                          Run this command with your registration code:
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="text-xs bg-white dark:bg-gray-800 px-2 py-1 rounded flex-1 font-mono">
                            npm start -- --register {registrationResult.registrationCode}
                          </code>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => copyToClipboard(
                              `npm start -- --register ${registrationResult.registrationCode}`,
                              'Start command'
                            )}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => window.open(setupInstructions.downloadUrl, '_blank')}
                    >
                      <Download className="h-4 w-4 mr-2" />
                      Download Setup Script
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={resetDialog}>
                Add Another Device
              </Button>
              <Button onClick={resetDialog}>
                Done
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}