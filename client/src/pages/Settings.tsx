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
  Save,
  TestTube,
  Brain,
  Cpu,
  Server,
  ExternalLink,
  CheckCircle,
  XCircle,
  AlertCircle,
  Trash2,
  RefreshCw,
  Database,
  FileDown,
  Activity,
  HardDrive,
  Wrench
} from "lucide-react"
import { useToast } from "@/hooks/useToast"
import { useForm } from "react-hook-form"
import {
  getSettings,
  updateSettings,
  testElevenLabsApiKey,
  testOpenAIApiKey,
  testAnthropicApiKey,
  testLocalLLM,
  getSetting
} from "@/api/settings"
import {
  getSmartThingsStatus,
  configureSmartThingsOAuth,
  getSmartThingsAuthUrl,
  testSmartThingsConnection,
  disconnectSmartThings
} from "@/api/smartThings"
import {
  clearAllFakeData,
  injectFakeData,
  forceSmartThingsSync,
  forceInsteonSync,
  clearSmartThingsDevices,
  clearInsteonDevices,
  resetSettingsToDefaults,
  clearSmartThingsIntegration,
  clearVoiceCommandHistory,
  performHealthCheck,
  exportConfiguration
} from "@/api/maintenance"

export function Settings() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [testingApiKey, setTestingApiKey] = useState(false)
  const [testingOpenAI, setTestingOpenAI] = useState(false)
  const [testingAnthropic, setTestingAnthropic] = useState(false)
  const [testingLocalLLM, setTestingLocalLLM] = useState(false)
  const [smartthingsStatus, setSmartthingsStatus] = useState(null)
  const [testingSmartThings, setTestingSmartThings] = useState(false)
  const [configuringSmartThings, setConfiguringSmartThings] = useState(false)
  const [disconnectingSmartThings, setDisconnectingSmartThings] = useState(false)

  // Maintenance operation states
  const [clearingFakeData, setClearingFakeData] = useState(false)
  const [injectingFakeData, setInjectingFakeData] = useState(false)
  const [syncingSmartThings, setSyncingSmartThings] = useState(false)
  const [syncingInsteon, setSyncingInsteon] = useState(false)
  const [clearingSTDevices, setClearingSTDevices] = useState(false)
  const [clearingInsteonDevices, setClearingInsteonDevices] = useState(false)
  const [resettingSettings, setResettingSettings] = useState(false)
  const [clearingSTIntegration, setClearingSTIntegration] = useState(false)
  const [clearingVoiceHistory, setClearingVoiceHistory] = useState(false)
  const [runningHealthCheck, setRunningHealthCheck] = useState(false)
  const [exportingConfig, setExportingConfig] = useState(false)
  const [healthData, setHealthData] = useState(null)
  const { register, handleSubmit, setValue, watch, reset } = useForm({
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
      smartthingsClientId: "",
      smartthingsClientSecret: "",
      smartthingsRedirectUri: "",
      elevenlabsApiKey: "",
      llmProvider: "openai",
      openaiApiKey: "",
      openaiModel: "gpt-4",
      anthropicApiKey: "",
      anthropicModel: "claude-3-sonnet-20240229",
      localLlmEndpoint: "http://localhost:8080",
      localLlmModel: "llama2-7b",
      enableSecurityMode: false
    }
  })

  // Load settings on component mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        console.log('Loading settings from backend...');
        const response = await getSettings();
        
        if (response.success && response.settings) {
          console.log('Loaded settings:', response.settings);
          
          // Update form values with loaded settings, handle masked sensitive fields
          Object.entries(response.settings).forEach(([key, value]) => {
            if (value !== undefined) {
              // For masked sensitive fields, show a placeholder indicating key is configured
              if ((key === 'elevenlabsApiKey' || key === 'smartthingsToken' || key === 'smartthingsClientSecret' || key === 'openaiApiKey' || key === 'anthropicApiKey') &&
                  typeof value === 'string' && value.includes('*')) {
                console.log(`Found masked field: ${key}, showing placeholder`);
                setValue(key, '••••••••••••••••••••••••••••••••••••••••••••••••••'); // Placeholder to show key is configured
                return;
              }
              setValue(key, value);
            }
          });
          
          toast({
            title: "Settings Loaded",
            description: "Your settings have been loaded successfully"
          });
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
        toast({
          title: "Error",
          description: "Failed to load settings, using defaults",
          variant: "destructive"
        });
      }
    };

    loadSettings();
    loadSmartThingsStatus();
  }, [setValue, toast]);

  // Load SmartThings integration status
  const loadSmartThingsStatus = async () => {
    try {
      console.log('Loading SmartThings integration status...');
      const response = await getSmartThingsStatus();

      if (response.success && response.integration) {
        console.log('SmartThings status loaded:', response.integration);
        setSmartthingsStatus(response.integration);
      }
    } catch (error) {
      console.error('Failed to load SmartThings status:', error);
      // Set default unconfigured state when loading fails
      setSmartthingsStatus({
        isConfigured: false,
        isConnected: false,
        clientId: '',
        clientSecret: '',
        redirectUri: '',
        deviceCount: 0
      });
      // Don't show error toast for status loading as it's not critical
    }
  };

  // Handle OAuth callback from URL parameters
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const smartthingsResult = urlParams.get('smartthings');
    const message = urlParams.get('message');

    if (smartthingsResult === 'success') {
      toast({
        title: "SmartThings Connected",
        description: "SmartThings integration has been successfully configured!"
      });
      // Reload status and settings after successful OAuth
      loadSmartThingsStatus();
      // Clear URL parameters
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (smartthingsResult === 'error') {
      toast({
        title: "SmartThings Connection Failed",
        description: message || "Failed to connect SmartThings integration",
        variant: "destructive"
      });
      // Clear URL parameters
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [toast]);

  const handleSaveSettings = async (data: any) => {
    setLoading(true)
    try {
      console.log('Saving settings:', data)
      
      // Don't send placeholder values to backend - preserve existing sensitive fields
      const settingsToSave = { ...data };
      if (settingsToSave.elevenlabsApiKey && settingsToSave.elevenlabsApiKey.startsWith('••••')) {
        delete settingsToSave.elevenlabsApiKey; // Don't update if it's just the placeholder
      }
      if (settingsToSave.smartthingsToken && settingsToSave.smartthingsToken.startsWith('••••')) {
        delete settingsToSave.smartthingsToken; // Don't update if it's just the placeholder
      }
      if (settingsToSave.smartthingsClientSecret && settingsToSave.smartthingsClientSecret.startsWith('••••')) {
        delete settingsToSave.smartthingsClientSecret; // Don't update if it's just the placeholder
      }
      if (settingsToSave.openaiApiKey && settingsToSave.openaiApiKey.startsWith('••••')) {
        delete settingsToSave.openaiApiKey; // Don't update if it's just the placeholder
      }
      if (settingsToSave.anthropicApiKey && settingsToSave.anthropicApiKey.startsWith('••••')) {
        delete settingsToSave.anthropicApiKey; // Don't update if it's just the placeholder
      }
      
      const response = await updateSettings(settingsToSave);
      
      if (response.success) {
        toast({
          title: "Settings Saved",
          description: response.message || "Your settings have been saved successfully"
        })
      }
    } catch (error) {
      console.error('Failed to save settings:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to save settings",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  const handleTestElevenLabsKey = async () => {
    const formApiKey = watch('elevenlabsApiKey');
    
    // If no API key in form field or it's the placeholder, get the existing one from the backend
    let apiKeyToTest = formApiKey;
    
    if (!apiKeyToTest || apiKeyToTest.trim() === '' || apiKeyToTest.startsWith('••••')) {
      try {
        console.log('No API key in form, fetching existing key from backend...');
        const settingResponse = await getSetting('elevenlabsApiKey');
        
        if (settingResponse.success && settingResponse.value) {
          apiKeyToTest = settingResponse.value;
          console.log('Using existing API key from backend for test');
        } else {
          toast({
            title: "Error", 
            description: "No ElevenLabs API key found. Please enter an API key to test.",
            variant: "destructive"
          });
          return;
        }
      } catch (error) {
        console.error('Failed to fetch existing API key:', error);
        toast({
          title: "Error",
          description: "Please enter an ElevenLabs API key to test",
          variant: "destructive"
        });
        return;
      }
    }

    setTestingApiKey(true);
    try {
      console.log('Testing ElevenLabs API key...');
      
      const response = await testElevenLabsApiKey(apiKeyToTest);
      
      if (response.success) {
        toast({
          title: "API Key Valid",
          description: `Connected successfully! Found ${response.voiceCount || 0} available voices.`
        });
      }
    } catch (error) {
      console.error('ElevenLabs API key test failed:', error);
      toast({
        title: "API Key Invalid",
        description: error.message || "Failed to connect to ElevenLabs API",
        variant: "destructive"
      });
    } finally {
      setTestingApiKey(false);
    }
  }

  const handleTestOpenAIKey = async () => {
    const formApiKey = watch('openaiApiKey');
    const formModel = watch('openaiModel');
    
    // If no API key in form field or it's the placeholder, get the existing one from the backend
    let apiKeyToTest = formApiKey;
    
    if (!apiKeyToTest || apiKeyToTest.trim() === '' || apiKeyToTest.startsWith('••••')) {
      try {
        console.log('No API key in form, fetching existing key from backend...');
        const settingResponse = await getSetting('openaiApiKey');
        
        if (settingResponse.success && settingResponse.value) {
          apiKeyToTest = settingResponse.value;
          console.log('Using existing API key from backend for test');
        } else {
          toast({
            title: "Error", 
            description: "No OpenAI API key found. Please enter an API key to test.",
            variant: "destructive"
          });
          return;
        }
      } catch (error) {
        console.error('Failed to fetch existing API key:', error);
        toast({
          title: "Error",
          description: "Please enter an OpenAI API key to test",
          variant: "destructive"
        });
        return;
      }
    }

    setTestingOpenAI(true);
    try {
      console.log('Testing OpenAI API key...');
      
      const response = await testOpenAIApiKey(apiKeyToTest, formModel);
      
      if (response.success) {
        toast({
          title: "API Key Valid",
          description: `Connected successfully to OpenAI API with model ${response.model || formModel}.`
        });
      }
    } catch (error) {
      console.error('OpenAI API key test failed:', error);
      toast({
        title: "API Key Invalid",
        description: error.message || "Failed to connect to OpenAI API",
        variant: "destructive"
      });
    } finally {
      setTestingOpenAI(false);
    }
  }

  const handleTestAnthropicKey = async () => {
    const formApiKey = watch('anthropicApiKey');
    const formModel = watch('anthropicModel');
    
    // If no API key in form field or it's the placeholder, get the existing one from the backend
    let apiKeyToTest = formApiKey;
    
    if (!apiKeyToTest || apiKeyToTest.trim() === '' || apiKeyToTest.startsWith('••••')) {
      try {
        console.log('No API key in form, fetching existing key from backend...');
        const settingResponse = await getSetting('anthropicApiKey');
        
        if (settingResponse.success && settingResponse.value) {
          apiKeyToTest = settingResponse.value;
          console.log('Using existing API key from backend for test');
        } else {
          toast({
            title: "Error", 
            description: "No Anthropic API key found. Please enter an API key to test.",
            variant: "destructive"
          });
          return;
        }
      } catch (error) {
        console.error('Failed to fetch existing API key:', error);
        toast({
          title: "Error",
          description: "Please enter an Anthropic API key to test",
          variant: "destructive"
        });
        return;
      }
    }

    setTestingAnthropic(true);
    try {
      console.log('Testing Anthropic API key...');
      
      const response = await testAnthropicApiKey(apiKeyToTest, formModel);
      
      if (response.success) {
        toast({
          title: "API Key Valid",
          description: `Connected successfully to Anthropic API with model ${response.model || formModel}.`
        });
      }
    } catch (error) {
      console.error('Anthropic API key test failed:', error);
      toast({
        title: "API Key Invalid",
        description: error.message || "Failed to connect to Anthropic API",
        variant: "destructive"
      });
    } finally {
      setTestingAnthropic(false);
    }
  }

  const handleTestLocalLLM = async () => {
    const formEndpoint = watch('localLlmEndpoint');
    const formModel = watch('localLlmModel');
    
    if (!formEndpoint || formEndpoint.trim() === '') {
      toast({
        title: "Error", 
        description: "Please enter a local LLM endpoint to test.",
        variant: "destructive"
      });
      return;
    }

    setTestingLocalLLM(true);
    try {
      console.log('Testing local LLM endpoint...');
      
      const response = await testLocalLLM(formEndpoint, formModel);
      
      if (response.success) {
        toast({
          title: "Connection Successful",
          description: `Connected successfully to local LLM at ${response.endpoint || formEndpoint}.`
        });
      }
    } catch (error) {
      console.error('Local LLM endpoint test failed:', error);
      toast({
        title: "Connection Failed",
        description: error.message || "Failed to connect to local LLM endpoint",
        variant: "destructive"
      });
    } finally {
      setTestingLocalLLM(false);
    }
  }

  const handleConfigureSmartThings = async () => {
    const clientId = watch('smartthingsClientId');
    const clientSecret = watch('smartthingsClientSecret');
    const redirectUri = watch('smartthingsRedirectUri');

    if (!clientId || !clientSecret) {
      toast({
        title: "Error",
        description: "Client ID and Client Secret are required for SmartThings OAuth",
        variant: "destructive"
      });
      return;
    }

    setConfiguringSmartThings(true);
    try {
      console.log('Configuring SmartThings OAuth...');

      const response = await configureSmartThingsOAuth({
        clientId,
        clientSecret,
        redirectUri: redirectUri || undefined
      });

      if (response.success) {
        toast({
          title: "Configuration Saved",
          description: "SmartThings OAuth configuration has been saved. You can now connect your SmartThings account."
        });
        // Reload status after configuration
        loadSmartThingsStatus();
      }
    } catch (error) {
      console.error('SmartThings OAuth configuration failed:', error);
      toast({
        title: "Configuration Failed",
        description: error.message || "Failed to configure SmartThings OAuth",
        variant: "destructive"
      });
    } finally {
      setConfiguringSmartThings(false);
    }
  };

  const handleConnectSmartThings = async () => {
    try {
      console.log('Getting SmartThings authorization URL...');

      const response = await getSmartThingsAuthUrl();

      if (response.success && response.authUrl) {
        console.log('Redirecting to SmartThings authorization...');
        window.location.href = response.authUrl;
      }
    } catch (error) {
      console.error('Failed to get SmartThings authorization URL:', error);
      toast({
        title: "Connection Failed",
        description: error.message || "Failed to get SmartThings authorization URL. Please ensure OAuth is configured first.",
        variant: "destructive"
      });
    }
  };

  const handleTestSmartThings = async () => {
    setTestingSmartThings(true);
    try {
      console.log('Testing SmartThings connection...');

      const response = await testSmartThingsConnection();

      if (response.success) {
        toast({
          title: "Connection Successful",
          description: `SmartThings connection is working! Found ${response.deviceCount || 0} devices.`
        });
      }
    } catch (error) {
      console.error('SmartThings connection test failed:', error);
      toast({
        title: "Connection Failed",
        description: error.message || "Failed to connect to SmartThings API",
        variant: "destructive"
      });
    } finally {
      setTestingSmartThings(false);
    }
  };

  const handleDisconnectSmartThings = async () => {
    setDisconnectingSmartThings(true);
    try {
      console.log('Disconnecting SmartThings integration...');

      const response = await disconnectSmartThings();

      if (response.success) {
        toast({
          title: "Disconnected",
          description: "SmartThings integration has been disconnected successfully."
        });
        // Reload status after disconnection
        loadSmartThingsStatus();
      }
    } catch (error) {
      console.error('SmartThings disconnection failed:', error);
      toast({
        title: "Disconnection Failed",
        description: error.message || "Failed to disconnect SmartThings integration",
        variant: "destructive"
      });
    } finally {
      setDisconnectingSmartThings(false);
    }
  };

  const getSmartThingsStatusIcon = () => {
    if (!smartthingsStatus) return <AlertCircle className="h-4 w-4 text-gray-500" />;

    if (smartthingsStatus.isConnected) {
      return <CheckCircle className="h-4 w-4 text-green-600" />;
    } else if (smartthingsStatus.isConfigured) {
      return <AlertCircle className="h-4 w-4 text-yellow-600" />;
    } else {
      return <XCircle className="h-4 w-4 text-red-600" />;
    }
  };

  const getSmartThingsStatusText = () => {
    if (!smartthingsStatus) return "Loading...";

    if (smartthingsStatus.isConnected) {
      return "Connected and authenticated";
    } else if (smartthingsStatus.isConfigured) {
      return "Configured but not connected";
    } else {
      return "Not configured";
    }
  };

  // Maintenance handler functions
  const handleClearFakeData = async () => {
    setClearingFakeData(true);
    try {
      console.log('Clearing fake data...');
      const response = await clearAllFakeData();

      if (response.success) {
        toast({
          title: "Data Cleared",
          description: `Successfully cleared ${Object.values(response.results).reduce((a, b) => a + b, 0)} items`
        });
      }
    } catch (error) {
      console.error('Clear fake data failed:', error);
      toast({
        title: "Clear Failed",
        description: error.message || "Failed to clear fake data",
        variant: "destructive"
      });
    } finally {
      setClearingFakeData(false);
    }
  };

  const handleInjectFakeData = async () => {
    setInjectingFakeData(true);
    try {
      console.log('Injecting fake data...');
      const response = await injectFakeData();

      if (response.success) {
        toast({
          title: "Data Injected",
          description: `Successfully injected ${Object.values(response.results).reduce((a, b) => a + b, 0)} items`
        });
      }
    } catch (error) {
      console.error('Inject fake data failed:', error);
      toast({
        title: "Inject Failed",
        description: error.message || "Failed to inject fake data",
        variant: "destructive"
      });
    } finally {
      setInjectingFakeData(false);
    }
  };

  const handleSyncSmartThings = async () => {
    setSyncingSmartThings(true);
    try {
      console.log('Syncing SmartThings devices...');
      const response = await forceSmartThingsSync();

      if (response.success) {
        toast({
          title: "Sync Complete",
          description: `Successfully synced ${response.deviceCount} SmartThings devices`
        });
      }
    } catch (error) {
      console.error('SmartThings sync failed:', error);
      toast({
        title: "Sync Failed",
        description: error.message || "Failed to sync SmartThings devices",
        variant: "destructive"
      });
    } finally {
      setSyncingSmartThings(false);
    }
  };

  const handleSyncInsteon = async () => {
    setSyncingInsteon(true);
    try {
      console.log('Syncing INSTEON devices...');
      const response = await forceInsteonSync();

      if (response.success) {
        toast({
          title: "Sync Complete",
          description: response.message
        });
      }
    } catch (error) {
      console.error('INSTEON sync failed:', error);
      toast({
        title: "Sync Failed",
        description: error.message || "Failed to sync INSTEON devices",
        variant: "destructive"
      });
    } finally {
      setSyncingInsteon(false);
    }
  };

  const handleClearSTDevices = async () => {
    setClearingSTDevices(true);
    try {
      console.log('Clearing SmartThings devices...');
      const response = await clearSmartThingsDevices();

      if (response.success) {
        toast({
          title: "Devices Cleared",
          description: `Successfully cleared ${response.deletedCount} SmartThings devices`
        });
      }
    } catch (error) {
      console.error('Clear SmartThings devices failed:', error);
      toast({
        title: "Clear Failed",
        description: error.message || "Failed to clear SmartThings devices",
        variant: "destructive"
      });
    } finally {
      setClearingSTDevices(false);
    }
  };

  const handleClearInsteonDevices = async () => {
    setClearingInsteonDevices(true);
    try {
      console.log('Clearing INSTEON devices...');
      const response = await clearInsteonDevices();

      if (response.success) {
        toast({
          title: "Devices Cleared",
          description: `Successfully cleared ${response.deletedCount} INSTEON devices`
        });
      }
    } catch (error) {
      console.error('Clear INSTEON devices failed:', error);
      toast({
        title: "Clear Failed",
        description: error.message || "Failed to clear INSTEON devices",
        variant: "destructive"
      });
    } finally {
      setClearingInsteonDevices(false);
    }
  };

  const handleResetSettings = async () => {
    setResettingSettings(true);
    try {
      console.log('Resetting settings to defaults...');
      const response = await resetSettingsToDefaults();

      if (response.success) {
        toast({
          title: "Settings Reset",
          description: "All settings have been reset to defaults"
        });
      }
    } catch (error) {
      console.error('Reset settings failed:', error);
      toast({
        title: "Reset Failed",
        description: error.message || "Failed to reset settings",
        variant: "destructive"
      });
    } finally {
      setResettingSettings(false);
    }
  };

  const handleClearSTIntegration = async () => {
    setClearingSTIntegration(true);
    try {
      console.log('Clearing SmartThings integration...');
      const response = await clearSmartThingsIntegration();

      if (response.success) {
        toast({
          title: "Integration Cleared",
          description: "SmartThings integration configuration cleared"
        });
        loadSmartThingsStatus();
      }
    } catch (error) {
      console.error('Clear SmartThings integration failed:', error);
      toast({
        title: "Clear Failed",
        description: error.message || "Failed to clear SmartThings integration",
        variant: "destructive"
      });
    } finally {
      setClearingSTIntegration(false);
    }
  };

  const handleClearVoiceHistory = async () => {
    setClearingVoiceHistory(true);
    try {
      console.log('Clearing voice command history...');
      const response = await clearVoiceCommandHistory();

      if (response.success) {
        toast({
          title: "History Cleared",
          description: `Successfully cleared ${response.deletedCount} voice commands`
        });
      }
    } catch (error) {
      console.error('Clear voice history failed:', error);
      toast({
        title: "Clear Failed",
        description: error.message || "Failed to clear voice command history",
        variant: "destructive"
      });
    } finally {
      setClearingVoiceHistory(false);
    }
  };

  const handleHealthCheck = async () => {
    setRunningHealthCheck(true);
    try {
      console.log('Running system health check...');
      const response = await performHealthCheck();

      if (response.success) {
        setHealthData(response.health);
        toast({
          title: "Health Check Complete",
          description: "System health check completed successfully"
        });
      }
    } catch (error) {
      console.error('Health check failed:', error);
      toast({
        title: "Health Check Failed",
        description: error.message || "Failed to perform health check",
        variant: "destructive"
      });
    } finally {
      setRunningHealthCheck(false);
    }
  };

  const handleExportConfig = async () => {
    setExportingConfig(true);
    try {
      console.log('Exporting configuration...');
      const response = await exportConfiguration();

      if (response.success) {
        // Download the configuration as JSON file
        const blob = new Blob([JSON.stringify(response.config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `homebrain-config-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        toast({
          title: "Export Complete",
          description: "Configuration exported successfully"
        });
      }
    } catch (error) {
      console.error('Export config failed:', error);
      toast({
        title: "Export Failed",
        description: error.message || "Failed to export configuration",
        variant: "destructive"
      });
    } finally {
      setExportingConfig(false);
    }
  };

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
            <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
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
                    <Select value={watch("timezone")} onValueChange={(value) => setValue("timezone", value)}>
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
                  <Switch checked={watch("enableNotifications")} onCheckedChange={(checked) => setValue("enableNotifications", checked)} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Voice Confirmations</p>
                    <p className="text-sm text-muted-foreground">
                      Hear spoken confirmations for voice commands
                    </p>
                  </div>
                  <Switch checked={watch("enableVoiceConfirmation")} onCheckedChange={(checked) => setValue("enableVoiceConfirmation", checked)} />
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
                <div className="space-y-4">
                  <div className="flex items-center gap-2 p-3 bg-blue-50/50 rounded-lg border">
                    {getSmartThingsStatusIcon()}
                    <div>
                      <p className="font-medium text-sm">SmartThings Integration Status</p>
                      <p className="text-xs text-muted-foreground">{getSmartThingsStatusText()}</p>
                      {smartthingsStatus?.isConnected && smartthingsStatus?.deviceCount && (
                        <p className="text-xs text-green-600">{smartthingsStatus.deviceCount} devices available</p>
                      )}
                    </div>
                  </div>

                  <div className="grid gap-4">
                    <div>
                      <label className="text-sm font-medium">SmartThings Client ID</label>
                      <Input
                        {...register("smartthingsClientId")}
                        placeholder="Enter SmartThings Client ID"
                        className="mt-1"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        OAuth Client ID from your SmartThings Developer app
                      </p>
                    </div>

                    <div>
                      <label className="text-sm font-medium">SmartThings Client Secret</label>
                      <Input
                        {...register("smartthingsClientSecret")}
                        type="password"
                        placeholder={watch("smartthingsClientSecret")?.startsWith('••••') ? "Client secret configured" : "Enter SmartThings Client Secret"}
                        className="mt-1"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        OAuth Client Secret from your SmartThings Developer app
                      </p>
                    </div>

                    <div>
                      <label className="text-sm font-medium">Redirect URI (Optional)</label>
                      <Input
                        {...register("smartthingsRedirectUri")}
                        placeholder="https://yourdomain.com/api/smartthings/callback"
                        className="mt-1"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        Custom redirect URI (defaults to current domain + /api/smartthings/callback)
                      </p>
                    </div>

                    <div className="flex gap-2 flex-wrap">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleConfigureSmartThings}
                        disabled={configuringSmartThings || !watch('smartthingsClientId') || !watch('smartthingsClientSecret')}
                      >
                        {configuringSmartThings ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                            Configuring...
                          </>
                        ) : (
                          <>
                            <Save className="h-4 w-4 mr-2" />
                            Configure OAuth
                          </>
                        )}
                      </Button>

                      {smartthingsStatus?.isConfigured && !smartthingsStatus?.isConnected && (
                        <Button
                          type="button"
                          variant="default"
                          size="sm"
                          onClick={handleConnectSmartThings}
                          className="bg-green-600 hover:bg-green-700"
                        >
                          <ExternalLink className="h-4 w-4 mr-2" />
                          Connect SmartThings
                        </Button>
                      )}

                      {smartthingsStatus?.isConnected && (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={handleTestSmartThings}
                            disabled={testingSmartThings}
                          >
                            {testingSmartThings ? (
                              <>
                                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                                Testing...
                              </>
                            ) : (
                              <>
                                <TestTube className="h-4 w-4 mr-2" />
                                Test Connection
                              </>
                            )}
                          </Button>

                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={handleDisconnectSmartThings}
                            disabled={disconnectingSmartThings}
                          >
                            {disconnectingSmartThings ? (
                              <>
                                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                                Disconnecting...
                              </>
                            ) : (
                              <>
                                <XCircle className="h-4 w-4 mr-2" />
                                Disconnect
                              </>
                            )}
                          </Button>
                        </>
                      )}
                    </div>

                    <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800">
                      <p className="text-sm text-yellow-800 dark:text-yellow-200">
                        <strong>OAuth Setup Required:</strong> To use SmartThings integration, you need to create a
                        Developer Application in the SmartThings Developer Workspace and provide the Client ID and
                        Client Secret above. The old API token method is deprecated.
                      </p>
                    </div>

                    {/* Legacy token field - kept for backward compatibility but marked as deprecated */}
                    <details className="group">
                      <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
                        Legacy Token Configuration (Deprecated)
                      </summary>
                      <div className="mt-2 space-y-2">
                        <div>
                          <label className="text-sm font-medium text-muted-foreground">SmartThings Token (Legacy)</label>
                          <Input
                            {...register("smartthingsToken")}
                            type="password"
                            placeholder="Enter SmartThings API token"
                            className="mt-1 opacity-60"
                            disabled
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                            <strong>Deprecated:</strong> Personal access tokens are no longer supported by SmartThings.
                            Please use OAuth configuration above.
                          </p>
                        </div>
                      </div>
                    </details>
                  </div>
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
                  <div className="flex gap-2 mt-1">
                    <Input
                      {...register("elevenlabsApiKey")}
                      type="password"
                      placeholder={watch("elevenlabsApiKey")?.startsWith('••••') ? "API key configured" : "Enter ElevenLabs API key"}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleTestElevenLabsKey}
                      disabled={testingApiKey}
                      className="shrink-0"
                    >
                      {testingApiKey ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Testing...
                        </>
                      ) : (
                        <>
                          <TestTube className="h-4 w-4 mr-2" />
                          Test
                        </>
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Required for text-to-speech voice responses. If configured, field shows dots for security. Enter a new key to update or click "Test" to verify current key.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Brain className="h-5 w-5 text-purple-600" />
                  AI/LLM Providers
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <label className="text-sm font-medium">AI Provider</label>
                  <Select value={watch("llmProvider")} onValueChange={(value) => setValue("llmProvider", value)}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select AI provider" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI</SelectItem>
                      <SelectItem value="anthropic">Anthropic</SelectItem>
                      <SelectItem value="local">Local LLM</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Choose your preferred AI provider for voice command processing
                  </p>
                </div>

                {/* OpenAI Settings */}
                <div className="space-y-4 p-4 border rounded-lg bg-blue-50/50">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-blue-600" />
                    <h4 className="font-medium text-blue-900">OpenAI Configuration</h4>
                  </div>
                  
                  <div>
                    <label className="text-sm font-medium">OpenAI API Key</label>
                    <div className="flex gap-2 mt-1">
                      <Input
                        {...register("openaiApiKey")}
                        type="password"
                        placeholder={watch("openaiApiKey")?.startsWith('••••') ? "API key configured" : "Enter OpenAI API key"}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleTestOpenAIKey}
                        disabled={testingOpenAI}
                        className="shrink-0"
                      >
                        {testingOpenAI ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                            Testing...
                          </>
                        ) : (
                          <>
                            <TestTube className="h-4 w-4 mr-2" />
                            Test
                          </>
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Required for OpenAI GPT models. Get your API key from OpenAI Platform.
                    </p>
                  </div>
                  
                  <div>
                    <label className="text-sm font-medium">OpenAI Model</label>
                    <Select value={watch("openaiModel")} onValueChange={(value) => setValue("openaiModel", value)}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select OpenAI model" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="gpt-4">GPT-4</SelectItem>
                        <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                        <SelectItem value="gpt-3.5-turbo">GPT-3.5 Turbo</SelectItem>
                        <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Anthropic Settings */}
                <div className="space-y-4 p-4 border rounded-lg bg-orange-50/50">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-orange-600" />
                    <h4 className="font-medium text-orange-900">Anthropic Configuration</h4>
                  </div>
                  
                  <div>
                    <label className="text-sm font-medium">Anthropic API Key</label>
                    <div className="flex gap-2 mt-1">
                      <Input
                        {...register("anthropicApiKey")}
                        type="password"
                        placeholder={watch("anthropicApiKey")?.startsWith('••••') ? "API key configured" : "Enter Anthropic API key"}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleTestAnthropicKey}
                        disabled={testingAnthropic}
                        className="shrink-0"
                      >
                        {testingAnthropic ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                            Testing...
                          </>
                        ) : (
                          <>
                            <TestTube className="h-4 w-4 mr-2" />
                            Test
                          </>
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Required for Anthropic Claude models. Get your API key from Anthropic Console.
                    </p>
                  </div>
                  
                  <div>
                    <label className="text-sm font-medium">Anthropic Model</label>
                    <Select value={watch("anthropicModel")} onValueChange={(value) => setValue("anthropicModel", value)}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select Anthropic model" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="claude-3-sonnet-20240229">Claude 3 Sonnet</SelectItem>
                        <SelectItem value="claude-3-haiku-20240307">Claude 3 Haiku</SelectItem>
                        <SelectItem value="claude-3-opus-20240229">Claude 3 Opus</SelectItem>
                        <SelectItem value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Local LLM Settings */}
                <div className="space-y-4 p-4 border rounded-lg bg-green-50/50">
                  <div className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-green-600" />
                    <h4 className="font-medium text-green-900">Local LLM Configuration</h4>
                  </div>
                  
                  <div>
                    <label className="text-sm font-medium">Local LLM Endpoint</label>
                    <div className="flex gap-2 mt-1">
                      <Input
                        {...register("localLlmEndpoint")}
                        placeholder="http://localhost:8080"
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleTestLocalLLM}
                        disabled={testingLocalLLM}
                        className="shrink-0"
                      >
                        {testingLocalLLM ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                            Testing...
                          </>
                        ) : (
                          <>
                            <TestTube className="h-4 w-4 mr-2" />
                            Test
                          </>
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      URL endpoint for your local LLM server (e.g., llama.cpp, Ollama, etc.)
                    </p>
                  </div>
                  
                  <div>
                    <label className="text-sm font-medium">Local LLM Model</label>
                    <Input
                      {...register("localLlmModel")}
                      placeholder="llama2-7b"
                      className="mt-1"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Name of the model to use on your local LLM server
                    </p>
                  </div>
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
                  <Switch checked={watch("enableSecurityMode")} onCheckedChange={(checked) => setValue("enableSecurityMode", checked)} />
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

          <TabsContent value="maintenance" className="space-y-6">
            {/* Data Management Section */}
            <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="h-5 w-5 text-blue-600" />
                  Data Management
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <h4 className="font-medium">Clear Fake Data</h4>
                    <p className="text-sm text-muted-foreground">
                      Remove all demo/fake data from the system (devices, scenes, automations, etc.)
                    </p>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={handleClearFakeData}
                      disabled={clearingFakeData}
                      className="w-full"
                    >
                      {clearingFakeData ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                          Clearing...
                        </>
                      ) : (
                        <>
                          <Trash2 className="h-4 w-4 mr-2" />
                          Clear All Data
                        </>
                      )}
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <h4 className="font-medium">Inject Fake Data</h4>
                    <p className="text-sm text-muted-foreground">
                      Add demo/fake data for testing and demonstration purposes
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleInjectFakeData}
                      disabled={injectingFakeData}
                      className="w-full"
                    >
                      {injectingFakeData ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Injecting...
                        </>
                      ) : (
                        <>
                          <Database className="h-4 w-4 mr-2" />
                          Inject Demo Data
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Device Integration Management */}
            <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <RefreshCw className="h-5 w-5 text-green-600" />
                  Device Integration Management
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* SmartThings Operations */}
                <div className="space-y-4">
                  <h4 className="font-medium text-blue-600">SmartThings Operations</h4>
                  <div className="grid gap-4 md:grid-cols-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleSyncSmartThings}
                      disabled={syncingSmartThings}
                      className="w-full"
                    >
                      {syncingSmartThings ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Syncing...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Force Sync
                        </>
                      )}
                    </Button>

                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={handleClearSTDevices}
                      disabled={clearingSTDevices}
                      className="w-full"
                    >
                      {clearingSTDevices ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                          Clearing...
                        </>
                      ) : (
                        <>
                          <Trash2 className="h-4 w-4 mr-2" />
                          Clear Devices
                        </>
                      )}
                    </Button>

                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={handleClearSTIntegration}
                      disabled={clearingSTIntegration}
                      className="w-full"
                    >
                      {clearingSTIntegration ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                          Clearing...
                        </>
                      ) : (
                        <>
                          <XCircle className="h-4 w-4 mr-2" />
                          Reset Integration
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {/* INSTEON Operations */}
                <div className="space-y-4">
                  <h4 className="font-medium text-purple-600">INSTEON Operations</h4>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleSyncInsteon}
                      disabled={syncingInsteon}
                      className="w-full"
                    >
                      {syncingInsteon ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Syncing...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Force Sync
                        </>
                      )}
                    </Button>

                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={handleClearInsteonDevices}
                      disabled={clearingInsteonDevices}
                      className="w-full"
                    >
                      {clearingInsteonDevices ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                          Clearing...
                        </>
                      ) : (
                        <>
                          <Trash2 className="h-4 w-4 mr-2" />
                          Clear INSTEON Devices
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* System Maintenance */}
            <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wrench className="h-5 w-5 text-orange-600" />
                  System Maintenance
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <h4 className="font-medium">Reset Settings</h4>
                    <p className="text-sm text-muted-foreground">
                      Reset all system settings to their default values
                    </p>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={handleResetSettings}
                      disabled={resettingSettings}
                      className="w-full"
                    >
                      {resettingSettings ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                          Resetting...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Reset Settings
                        </>
                      )}
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <h4 className="font-medium">Clear Voice History</h4>
                    <p className="text-sm text-muted-foreground">
                      Remove all stored voice command history and logs
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleClearVoiceHistory}
                      disabled={clearingVoiceHistory}
                      className="w-full"
                    >
                      {clearingVoiceHistory ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Clearing...
                        </>
                      ) : (
                        <>
                          <Trash2 className="h-4 w-4 mr-2" />
                          Clear History
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* System Diagnostics */}
            <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-red-600" />
                  System Diagnostics
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <h4 className="font-medium">System Health Check</h4>
                    <p className="text-sm text-muted-foreground">
                      Run comprehensive system health diagnostics
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleHealthCheck}
                      disabled={runningHealthCheck}
                      className="w-full"
                    >
                      {runningHealthCheck ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Checking...
                        </>
                      ) : (
                        <>
                          <Activity className="h-4 w-4 mr-2" />
                          Run Health Check
                        </>
                      )}
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <h4 className="font-medium">Export Configuration</h4>
                    <p className="text-sm text-muted-foreground">
                      Export system configuration as JSON file for backup
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleExportConfig}
                      disabled={exportingConfig}
                      className="w-full"
                    >
                      {exportingConfig ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Exporting...
                        </>
                      ) : (
                        <>
                          <FileDown className="h-4 w-4 mr-2" />
                          Export Config
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {/* Health Data Display */}
                {healthData && (
                  <div className="mt-4 p-4 bg-gray-50 rounded-lg border">
                    <h5 className="font-medium mb-3">System Health Status</h5>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <h6 className="font-medium text-sm text-blue-600">Database</h6>
                        <ul className="text-sm text-muted-foreground mt-1">
                          <li>Devices: {healthData.database?.collections?.devices || 0}</li>
                          <li>Scenes: {healthData.database?.collections?.scenes || 0}</li>
                          <li>Automations: {healthData.database?.collections?.automations || 0}</li>
                          <li>Voice Devices: {healthData.database?.collections?.voiceDevices || 0}</li>
                          <li>User Profiles: {healthData.database?.collections?.userProfiles || 0}</li>
                        </ul>
                      </div>
                      <div>
                        <h6 className="font-medium text-sm text-green-600">System Status</h6>
                        <ul className="text-sm text-muted-foreground mt-1">
                          <li>Total Devices: {healthData.devices?.total || 0}</li>
                          <li>Online Devices: {healthData.devices?.online || 0}</li>
                          <li>Offline Devices: {healthData.devices?.offline || 0}</li>
                          <li>Voice System: {healthData.voiceSystem?.online || 0}/{healthData.voiceSystem?.devices || 0} online</li>
                          <li>SmartThings: {healthData.integrations?.smartthings?.connected ? 'Connected' : 'Disconnected'}</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Warning Notice */}
            <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
              <p className="text-sm text-red-800 dark:text-red-200">
                <strong>⚠️ Warning:</strong> The maintenance operations above can permanently delete data.
                Always export your configuration before performing destructive operations. Use these tools carefully in production environments.
              </p>
            </div>
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