import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Settings as SettingsIcon,
  Wifi,
  Volume2,
  Mic,
  MapPin,
  Key,
  Shield,
  Smartphone,
  Home,
  Save
} from "lucide-react"
import { useToast } from "@/hooks/useToast"
import { useForm } from "react-hook-form"

export function Settings() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const { register, handleSubmit, setValue } = useForm({
    defaultValues: {
      location: "New York, NY",
      timezone: "America/New_York",
      wakeWordSensitivity: 0.7,
      voiceVolume: 0.8,
      microphoneSensitivity: 0.6,
      enableVoiceConfirmation: true,
      enableNotifications: true,
      insteonPort: "/dev/ttyUSB0",
      smartthingsToken: "",
      elevenlabsApiKey: "",
      enableSecurityMode: false
    }
  })

  const handleSaveSettings = async (data: any) => {
    setLoading(true)
    try {
      console.log('Saving settings:', data)
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 1000))
      
      toast({
        title: "Settings Saved",
        description: "Your settings have been saved successfully"
      })
    } catch (error) {
      console.error('Failed to save settings:', error)
      toast({
        title: "Error",
        description: "Failed to save settings",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            Settings
          </h1>
          <p className="text-muted-foreground mt-2">
            Configure your Home Brain system preferences
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit(handleSaveSettings)}>
        <Tabs defaultValue="general" className="space-y-6">
          <TabsList className="bg-white/80 backdrop-blur-sm">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="voice">Voice & Audio</TabsTrigger>
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-6">
            <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Home className="h-5 w-5 text-blue-600" />
                  Location & Time
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="text-sm font-medium">Location</label>
                    <Input
                      {...register("location")}
                      placeholder="City, State"
                      className="mt-1"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Used for sunrise/sunset automations
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium">Timezone</label>
                    <Select onValueChange={(value) => setValue("timezone", value)}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select timezone" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="America/New_York">Eastern Time</SelectItem>
                        <SelectItem value="America/Chicago">Central Time</SelectItem>
                        <SelectItem value="America/Denver">Mountain Time</SelectItem>
                        <SelectItem value="America/Los_Angeles">Pacific Time</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Smartphone className="h-5 w-5 text-green-600" />
                  Notifications
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Enable Notifications</p>
                    <p className="text-sm text-muted-foreground">
                      Receive notifications for device status and automations
                    </p>
                  </div>
                  <Switch {...register("enableNotifications")} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Voice Confirmations</p>
                    <p className="text-sm text-muted-foreground">
                      Hear spoken confirmations for voice commands
                    </p>
                  </div>
                  <Switch {...register("enableVoiceConfirmation")} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="voice" className="space-y-6">
            <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mic className="h-5 w-5 text-blue-600" />
                  Voice Recognition
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <label className="text-sm font-medium">Wake Word Sensitivity</label>
                  <div className="mt-2 space-y-2">
                    <input
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.1"
                      {...register("wakeWordSensitivity")}
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Less Sensitive</span>
                      <span>More Sensitive</span>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium">Microphone Sensitivity</label>
                  <div className="mt-2 space-y-2">
                    <input
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.1"
                      {...register("microphoneSensitivity")}
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Quiet</span>
                      <span>Loud</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Volume2 className="h-5 w-5 text-purple-600" />
                  Audio Output
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <label className="text-sm font-medium">Voice Response Volume</label>
                  <div className="mt-2 space-y-2">
                    <input
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.1"
                      {...register("voiceVolume")}
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Quiet</span>
                      <span>Loud</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="integrations" className="space-y-6">
            <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wifi className="h-5 w-5 text-blue-600" />
                  Device Integrations
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <label className="text-sm font-medium">INSTEON PLM Port</label>
                  <Input
                    {...register("insteonPort")}
                    placeholder="/dev/ttyUSB0"
                    className="mt-1"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Serial port for INSTEON PowerLinc Modem
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium">SmartThings Token</label>
                  <Input
                    {...register("smartthingsToken")}
                    type="password"
                    placeholder="Enter SmartThings API token"
                    className="mt-1"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Personal access token for SmartThings integration
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Key className="h-5 w-5 text-green-600" />
                  API Keys
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <label className="text-sm font-medium">ElevenLabs API Key</label>
                  <Input
                    {...register("elevenlabsApiKey")}
                    type="password"
                    placeholder="Enter ElevenLabs API key"
                    className="mt-1"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Required for text-to-speech voice responses
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="security" className="space-y-6">
            <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="h-5 w-5 text-red-600" />
                  Security Settings
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Security Mode</p>
                    <p className="text-sm text-muted-foreground">
                      Enhanced security features and monitoring
                    </p>
                  </div>
                  <Switch {...register("enableSecurityMode")} />
                </div>
                <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800">
                  <p className="text-sm text-yellow-800 dark:text-yellow-200">
                    <strong>Privacy Notice:</strong> All voice processing happens locally on your device. 
                    No voice data is sent to external servers except for ElevenLabs TTS generation.
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={loading}
              className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white shadow-lg"
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" />
                  Save Settings
                </>
              )}
            </Button>
          </div>
        </Tabs>
      </form>
    </div>
  )
}