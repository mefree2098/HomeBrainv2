import { useState, useEffect, ChangeEvent } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { WakeWordManager } from "@/components/voice/WakeWordManager"
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
  ArrowUp,
  ArrowDown,
  List,
  CheckCircle,
  XCircle,
  AlertCircle,
  Trash2,
  RefreshCw,
  Database,
  FileDown,
  Activity,
  Copy,
  HardDrive,
  Wrench,
  Tv
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
  getSetting,
  getLLMPriorityList,
  updateLLMPriorityList
} from "@/api/settings"
import {
  getSmartThingsStatus,
  configureSmartThingsOAuth,
  getSmartThingsAuthUrl,
  testSmartThingsConnection,
  disconnectSmartThings,
  configureSmartThingsSthm,
  getSmartThingsDevices,
  getSmartThingsSthmDiagnostics
} from "@/api/smartThings"
import {
  getEcobeeStatus,
  configureEcobeeOAuth,
  getEcobeeAuthUrl,
  testEcobeeConnection,
  disconnectEcobee,
  getEcobeeDevices
} from "@/api/ecobee"
import {
  clearAllFakeData,
  injectFakeData,
  forceSmartThingsSync,
  forceInsteonSync,
  forceHarmonySync,
  clearSmartThingsDevices,
  clearInsteonDevices,
  clearHarmonyDevices,
  resetSettingsToDefaults,
  clearSmartThingsIntegration,
  clearVoiceCommandHistory,
  performHealthCheck,
  exportConfiguration
} from "@/api/maintenance"
import {
  getHarmonyStatus,
  discoverHarmonyHubs,
  getHarmonyHubs,
  syncHarmonyDevices,
  syncHarmonyState,
  startHarmonyActivity,
  turnOffHarmonyHub
} from "@/api/harmony"
import {
  getInsteonSerialPorts,
  testInsteonConnection,
  queryLinkedInsteonDeviceStatus,
  testInsteonISYConnection,
  extractInsteonISYData,
  syncInsteonFromISY,
  startInsteonIsySyncRun,
  getInsteonIsySyncRun,
  type InsteonLinkedDeviceStatusResponse,
  type InsteonIsySyncRunLogEntry
} from "@/api/insteon"
import { useNavigate } from "react-router-dom"
import { SettingsResourceUtilizationTab } from "@/components/system/SystemResourceUtilization"

type InsteonSerialPortCandidate = {
  path?: string;
  stablePath?: string | null;
  aliases?: string[];
  manufacturer?: string | null;
  friendlyName?: string | null;
  vendorId?: string | null;
  productId?: string | null;
  likelyInsteon?: boolean;
}

type InsteonPlmConnectionTestResult = {
  success?: boolean;
  message?: string;
  connected?: boolean;
  transport?: string;
  runtimeTransport?: string;
  runtimeEndpoint?: string;
  port?: string;
  bridge?: {
    host?: string;
    port?: number;
    serialPath?: string;
  };
  plmInfo?: {
    deviceId?: string;
    firmwareVersion?: string | number;
    deviceCategory?: string | number;
    subcategory?: string | number;
  };
}

const CONFIGURED_SECRET_PLACEHOLDER = "••••••••••••••••••••••••••••••••••••••••••••••••••";

const isMaskedSecretPlaceholder = (value: unknown): boolean => {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith("••••") || trimmed.startsWith("****")) {
    return true;
  }

  if (/^[*•]+$/.test(trimmed)) {
    return true;
  }

  return /^[*•]{4,}[^*•\s]+$/.test(trimmed);
}

export function Settings() {
  const { toast } = useToast()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [testingApiKey, setTestingApiKey] = useState(false)
  const [testingOpenAI, setTestingOpenAI] = useState(false)
  const [testingAnthropic, setTestingAnthropic] = useState(false)
  const [testingLocalLLM, setTestingLocalLLM] = useState(false)
  const [smartthingsStatus, setSmartthingsStatus] = useState(null)
  const [testingSmartThings, setTestingSmartThings] = useState(false)
  const [configuringSmartThings, setConfiguringSmartThings] = useState(false)
  const [disconnectingSmartThings, setDisconnectingSmartThings] = useState(false)
  const [smartThingsDevices, setSmartThingsDevices] = useState<any[]>([])
  const [loadingSmartThingsDevices, setLoadingSmartThingsDevices] = useState(false)
  const [ecobeeStatus, setEcobeeStatus] = useState<any>(null)
  const [ecobeeDevices, setEcobeeDevices] = useState<any[]>([])
  const [configuringEcobee, setConfiguringEcobee] = useState(false)
  const [testingEcobee, setTestingEcobee] = useState(false)
  const [disconnectingEcobee, setDisconnectingEcobee] = useState(false)
  const [loadingEcobeeDevices, setLoadingEcobeeDevices] = useState(false)
  const [ecobeeConfig, setEcobeeConfig] = useState({
    clientId: "",
    redirectUri: ""
  })
  const [harmonyStatus, setHarmonyStatus] = useState<any>(null)
  const [harmonyHubs, setHarmonyHubs] = useState<any[]>([])
  const [loadingHarmonyStatus, setLoadingHarmonyStatus] = useState(false)
  const [loadingHarmonyHubs, setLoadingHarmonyHubs] = useState(false)
  const [discoveringHarmony, setDiscoveringHarmony] = useState(false)
  const [syncingHarmonyState, setSyncingHarmonyState] = useState(false)
  const [harmonyQuickActionKey, setHarmonyQuickActionKey] = useState("")
  const [savingSthmConfig, setSavingSthmConfig] = useState(false)
  const [runningSthmDiagnostics, setRunningSthmDiagnostics] = useState(false)
  const [sthmDiagnostics, setSthmDiagnostics] = useState<any>(null)
  const [scanningInsteonPorts, setScanningInsteonPorts] = useState(false)
  const [testingInsteonPlmConnection, setTestingInsteonPlmConnection] = useState(false)
  const [queryingInsteonLinkedStatus, setQueryingInsteonLinkedStatus] = useState(false)
  const [insteonSerialPortCandidates, setInsteonSerialPortCandidates] = useState<InsteonSerialPortCandidate[]>([])
  const [insteonPlmTestResult, setInsteonPlmTestResult] = useState<InsteonPlmConnectionTestResult | null>(null)
  const [insteonLinkedStatusResult, setInsteonLinkedStatusResult] = useState<InsteonLinkedDeviceStatusResponse | null>(null)
  const [testingIsyConnection, setTestingIsyConnection] = useState(false)
  const [extractingIsyData, setExtractingIsyData] = useState(false)
  const [previewingIsyMigration, setPreviewingIsyMigration] = useState(false)
  const [runningIsyMigration, setRunningIsyMigration] = useState(false)
  const [isyTestResult, setIsyTestResult] = useState<any>(null)
  const [isyExtractionResult, setIsyExtractionResult] = useState<any>(null)
  const [isyMigrationResult, setIsyMigrationResult] = useState<any>(null)
  const [isyMigrationRunId, setIsyMigrationRunId] = useState<string | null>(null)
  const [isyMigrationRunStatus, setIsyMigrationRunStatus] = useState<string | null>(null)
  const [isyMigrationRunLogs, setIsyMigrationRunLogs] = useState<InsteonIsySyncRunLogEntry[]>([])
  const [isyPasswordConfigured, setIsyPasswordConfigured] = useState(false)
  const [isyMigrationOptions, setIsyMigrationOptions] = useState<{
    importDevices: boolean;
    importTopology: boolean;
    importPrograms: boolean;
    enableProgramWorkflows: boolean;
    continueOnError: boolean;
    linkMode: "remote" | "manual";
  }>({
    importDevices: true,
    importTopology: true,
    importPrograms: true,
    enableProgramWorkflows: false,
    continueOnError: true,
    linkMode: "remote"
  })
  const [sthmConfig, setSthmConfig] = useState<{
    armAwayDeviceId: string;
    armStayDeviceId: string;
    disarmDeviceId: string;
    locationId: string;
  }>({
    armAwayDeviceId: "",
    armStayDeviceId: "",
    disarmDeviceId: "",
    locationId: ""
  })

  // Maintenance operation states
  const [clearingFakeData, setClearingFakeData] = useState(false)
  const [injectingFakeData, setInjectingFakeData] = useState(false)
  const [syncingSmartThings, setSyncingSmartThings] = useState(false)
  const [syncingInsteon, setSyncingInsteon] = useState(false)
  const [syncingHarmony, setSyncingHarmony] = useState(false)
  const [clearingSTDevices, setClearingSTDevices] = useState(false)
  const [clearingInsteonDevices, setClearingInsteonDevices] = useState(false)
  const [clearingHarmonyDevices, setClearingHarmonyDevices] = useState(false)
  const [resettingSettings, setResettingSettings] = useState(false)
  const [clearingSTIntegration, setClearingSTIntegration] = useState(false)
  const [clearingVoiceHistory, setClearingVoiceHistory] = useState(false)
  const [runningHealthCheck, setRunningHealthCheck] = useState(false)
  const [exportingConfig, setExportingConfig] = useState(false)
  const [healthData, setHealthData] = useState(null)
  const [llmPriorityList, setLlmPriorityList] = useState<string[]>(['local', 'openai', 'anthropic'])
  const [savingPriority, setSavingPriority] = useState(false)
  const { register, handleSubmit, setValue, watch, reset } = useForm({
    defaultValues: {
      location: "New York, NY",
      timezone: "America/New_York",
      wakeWordSensitivity: 0.7,
      voiceVolume: 0.8,
      microphoneSensitivity: 0.6,
      enableVoiceConfirmation: true,
      sttProvider: "openai",
      sttModel: "gpt-4o-mini-transcribe",
      sttLanguage: "en",
      enableNotifications: true,
      insteonPort: "/dev/ttyUSB0",
      isyHost: "",
      isyPort: 443,
      isyUsername: "",
      isyPassword: "",
      isyUseHttps: true,
      isyIgnoreTlsErrors: true,
      smartthingsToken: "",
      smartthingsClientId: "",
      smartthingsClientSecret: "",
      smartthingsRedirectUri: "",
      harmonyHubAddresses: "",
      elevenlabsApiKey: "",
      llmProvider: "openai",
      openaiApiKey: "",
      openaiModel: "gpt-5.2-codex",
      anthropicApiKey: "",
      anthropicModel: "claude-3-sonnet-20240229",
      localLlmEndpoint: "http://localhost:8080",
      localLlmModel: "llama2-7b",
      enableSecurityMode: false
    }
  })

  const getDeviceDisplayName = (device: any) => {
    if (!device) return "Unknown device"
    return device.label || device.name || device.deviceId || "Unnamed device"
  }

  const hasSwitchCapability = (device: any) => {
    if (!device) return false

    const checkCapabilities = (caps: any[]) =>
      Array.isArray(caps) &&
      caps.some((cap: any) => {
        if (!cap) return false
        if (typeof cap === "string") return cap === "switch"
        if (typeof cap === "object" && typeof cap.id === "string") return cap.id === "switch"
        return false
      })

    if (checkCapabilities(device.capabilities)) {
      return true
    }

    if (Array.isArray(device.components)) {
      return device.components.some((component: any) => {
        if (!component) return false
        return checkCapabilities(component.capabilities)
      })
    }

    return false
  }

  const fetchSmartThingsDevices = async (options: { showToast?: boolean; fallbackDevices?: any[]; integration?: any } = {}) => {
    const { showToast = false, fallbackDevices, integration } = options
    const activeIntegration = integration ?? smartthingsStatus

    if (!activeIntegration?.isConnected) {
      if (Array.isArray(fallbackDevices)) {
        setSmartThingsDevices(fallbackDevices)
      } else {
        setSmartThingsDevices([])
      }
      return
    }

    setLoadingSmartThingsDevices(true)
    try {
      const response = await getSmartThingsDevices()
      if (response.success && Array.isArray(response.devices)) {
        const devices = response.devices.slice()
        setSmartThingsDevices(devices)
        if (showToast) {
          toast({
            title: "SmartThings devices refreshed",
            description: `Loaded ${devices.length} devices from SmartThings.`
          })
        }
      } else {
        throw new Error("Unexpected response from SmartThings device list")
      }
    } catch (error: any) {
      console.error("Failed to load SmartThings devices:", error)
      if (Array.isArray(fallbackDevices) && fallbackDevices.length > 0) {
        setSmartThingsDevices(fallbackDevices)
      }
      if (showToast) {
        toast({
          title: "Failed to refresh SmartThings devices",
          description: error?.response?.data?.message || error?.message || "Unable to load devices from SmartThings",
          variant: "destructive"
        })
      }
    } finally {
      setLoadingSmartThingsDevices(false)
    }
  }

  const fetchEcobeeDevices = async (options: { showToast?: boolean; forceRefresh?: boolean; integration?: any } = {}) => {
    const { showToast = false, forceRefresh = false, integration } = options
    const activeIntegration = integration ?? ecobeeStatus

    if (!activeIntegration?.isConnected) {
      setEcobeeDevices([])
      return
    }

    setLoadingEcobeeDevices(true)
    try {
      const response = await getEcobeeDevices({ refresh: forceRefresh })
      if (response.success && Array.isArray(response.devices)) {
        const devices = response.devices.slice()
        setEcobeeDevices(devices)
        if (showToast) {
          const thermostatCount = devices.filter((device: any) => device?.type === "thermostat").length
          const sensorCount = devices.filter((device: any) => device?.type === "sensor").length
          toast({
            title: "Ecobee devices refreshed",
            description: `Loaded ${thermostatCount} thermostat${thermostatCount === 1 ? "" : "s"} and ${sensorCount} sensor${sensorCount === 1 ? "" : "s"}.`
          })
        }
      } else {
        throw new Error("Unexpected response from Ecobee device list")
      }
    } catch (error: any) {
      console.error("Failed to load Ecobee devices:", error)
      if (showToast) {
        toast({
          title: "Failed to refresh Ecobee devices",
          description: error?.response?.data?.message || error?.message || "Unable to load devices from Ecobee",
          variant: "destructive"
        })
      }
    } finally {
      setLoadingEcobeeDevices(false)
    }
  }

  const localWhisperModels = ["tiny", "base", "small", "small.en", "medium"]
  const openaiSttModels = ["gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe-latest"]
  const openaiLlmModelPresets = [
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5-codex",
    "gpt-5.2",
    "gpt-5.1",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-thinking",
    "gpt-5-thinking-mini",
    "gpt-5-thinking-nano"
  ]

  const sttProviderValue = watch("sttProvider") || "openai"
  const sttModelRaw = watch("sttModel")
  const sttModelValue =
    sttProviderValue === "local"
      ? (sttModelRaw && localWhisperModels.includes(sttModelRaw) ? sttModelRaw : "small")
      : (sttModelRaw && openaiSttModels.includes(sttModelRaw) ? sttModelRaw : "gpt-4o-mini-transcribe")
  const sttLanguageValue = watch("sttLanguage") || "en"
  const STHM_NOT_CONFIGURED = "__not_configured__"
  const availableSmartThingsDevices =
    smartThingsDevices.length > 0
      ? smartThingsDevices
      : Array.isArray((smartthingsStatus as any)?.connectedDevices)
        ? (smartthingsStatus as any).connectedDevices
        : []
  const switchDevices = availableSmartThingsDevices
    .filter((device: any) => hasSwitchCapability(device))
    .sort((a: any, b: any) => getDeviceDisplayName(a).localeCompare(getDeviceDisplayName(b)))
  const allSthmSwitchesSelected =
    Boolean(sthmConfig.disarmDeviceId) && Boolean(sthmConfig.armStayDeviceId) && Boolean(sthmConfig.armAwayDeviceId)
  const lastSthmState = smartthingsStatus?.sthm?.lastArmState
  const lastSthmStateUpdatedAt = smartthingsStatus?.sthm?.lastArmStateUpdatedAt
  const lastSthmUpdatedLabel = lastSthmStateUpdatedAt ? new Date(lastSthmStateUpdatedAt).toLocaleString() : null
  const lastSthmCommandResult = smartthingsStatus?.sthm?.lastCommandResult
  const lastSthmCommandAt = smartthingsStatus?.sthm?.lastCommandRequestedAt
  const lastSthmCommandAtLabel = lastSthmCommandAt ? new Date(lastSthmCommandAt).toLocaleString() : null
  const lastSthmCommandState = smartthingsStatus?.sthm?.lastCommandRequestedState
  const lastSthmCommandError = smartthingsStatus?.sthm?.lastCommandError
  const lastSthmCommandDeviceId = smartthingsStatus?.sthm?.lastCommandDeviceId
  const ecobeeThermostatCount = ecobeeDevices.filter((device: any) => device?.type === "thermostat").length
  const ecobeeSensorCount = ecobeeDevices.filter((device: any) => device?.type === "sensor").length
  const disarmSelectValue = sthmConfig.disarmDeviceId || STHM_NOT_CONFIGURED
  const armStaySelectValue = sthmConfig.armStayDeviceId || STHM_NOT_CONFIGURED
  const armAwaySelectValue = sthmConfig.armAwayDeviceId || STHM_NOT_CONFIGURED
  const insteonPortValue = (watch("insteonPort") || "").toString()
  const isyHostValue = (watch("isyHost") || "").toString()
  const isyPortValueRaw = watch("isyPort")
  const isyPortValue = isyPortValueRaw === undefined || isyPortValueRaw === null ? "" : String(isyPortValueRaw)
  const isyUsernameValue = (watch("isyUsername") || "").toString()
  const isyPasswordValue = (watch("isyPassword") || "").toString()
  const isyUseHttpsValue = watch("isyUseHttps") !== false
  const isyIgnoreTlsErrorsValue = watch("isyIgnoreTlsErrors") === true

  // Load settings on component mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        console.log('Loading settings from backend...');
        const response = await getSettings();
        
        if (response.success && response.settings) {
          console.log('Loaded settings:', response.settings);
          setIsyPasswordConfigured(Boolean(
            response.settings.isyPassword && String(response.settings.isyPassword).trim()
          ))
          
          // Update form values with loaded settings, handle masked sensitive fields
          Object.entries(response.settings).forEach(([key, value]) => {
            if (value !== undefined) {
              if (key === 'isyPassword') {
                // Keep the input empty and track configured state separately so typing/saving behaves predictably.
                setValue('isyPassword', '')
                return
              }
              // For masked sensitive fields, show a placeholder indicating key is configured
              if ((key === 'elevenlabsApiKey' || key === 'smartthingsToken' || key === 'smartthingsClientSecret' || key === 'openaiApiKey' || key === 'anthropicApiKey') &&
                  isMaskedSecretPlaceholder(value)) {
                console.log(`Found masked field: ${key}, showing placeholder`);
                setValue(key, CONFIGURED_SECRET_PLACEHOLDER); // Placeholder to show key is configured
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
    loadEcobeeStatus();
    loadHarmonyStatus();
    loadHarmonyHubs({ includeCommands: false });
    loadLLMPriorityList();
  }, [setValue, toast]);

  // Load LLM priority list
  const loadLLMPriorityList = async () => {
    try {
      console.log('Loading LLM priority list...');
      const response = await getLLMPriorityList();

      if (response.success && response.priorityList) {
        console.log('LLM priority list loaded:', response.priorityList);
        setLlmPriorityList(response.priorityList);
      }
    } catch (error) {
      console.error('Failed to load LLM priority list:', error);
      // Use default priority list on error
      setLlmPriorityList(['local', 'openai', 'anthropic']);
    }
  };

  // Load SmartThings integration status
  const loadSmartThingsStatus = async () => {
    try {
      console.log('Loading SmartThings integration status...');
      const response = await getSmartThingsStatus();

      if (response.success && response.integration) {
        console.log('SmartThings status loaded:', response.integration);
        const integration = response.integration;
        setSmartthingsStatus(integration);

        const nextSthm = integration.sthm || {};
        setSthmConfig({
          armAwayDeviceId: nextSthm.armAwayDeviceId || "",
          armStayDeviceId: nextSthm.armStayDeviceId || "",
          disarmDeviceId: nextSthm.disarmDeviceId || "",
          locationId: nextSthm.locationId || ""
        });

        if (Array.isArray(integration.connectedDevices)) {
          setSmartThingsDevices(integration.connectedDevices);
        } else if (!integration.isConnected) {
          setSmartThingsDevices([]);
        }

        if (integration.isConnected) {
          fetchSmartThingsDevices({
            integration,
            fallbackDevices: Array.isArray(integration.connectedDevices) ? integration.connectedDevices : [],
            showToast: false
          });
        }
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
      setSthmConfig({
        armAwayDeviceId: "",
        armStayDeviceId: "",
        disarmDeviceId: "",
        locationId: ""
      });
      setSmartThingsDevices([]);
      // Don't show error toast for status loading as it's not critical
    }
  };

  const loadEcobeeStatus = async () => {
    try {
      console.log('Loading Ecobee integration status...')
      const response = await getEcobeeStatus()

      if (response.success && response.integration) {
        const integration = response.integration
        setEcobeeStatus(integration)
        setEcobeeConfig({
          clientId: integration.clientId || "",
          redirectUri: integration.redirectUri || ""
        })

        if (integration.isConnected) {
          fetchEcobeeDevices({
            integration,
            forceRefresh: false,
            showToast: false
          })
        } else {
          setEcobeeDevices([])
        }
      }
    } catch (error) {
      console.error('Failed to load Ecobee status:', error)
      setEcobeeStatus({
        isConfigured: false,
        isConnected: false,
        clientId: '',
        redirectUri: '',
        connectedDevices: []
      })
      setEcobeeDevices([])
    }
  }

  const loadHarmonyStatus = async () => {
    setLoadingHarmonyStatus(true)
    try {
      const response = await getHarmonyStatus(5000)
      if (response.success) {
        setHarmonyStatus(response)
      }
    } catch (error) {
      console.error('Failed to load Harmony status:', error)
      setHarmonyStatus(null)
    } finally {
      setLoadingHarmonyStatus(false)
    }
  }

  const loadHarmonyHubs = async (options: { includeCommands?: boolean; showToast?: boolean } = {}) => {
    const { includeCommands = false, showToast = false } = options
    setLoadingHarmonyHubs(true)
    try {
      const response = await getHarmonyHubs({ includeCommands, timeoutMs: 5000 })
      if (response.success) {
        const hubs = Array.isArray(response.hubs) ? response.hubs : []
        setHarmonyHubs(hubs)
        if (showToast) {
          toast({
            title: "Harmony Hub list refreshed",
            description: `Loaded ${hubs.length} hub${hubs.length === 1 ? "" : "s"}.`
          })
        }
      }
    } catch (error) {
      console.error('Failed to load Harmony hubs:', error)
      if (showToast) {
        toast({
          title: "Failed to load Harmony hubs",
          description: error.message || "Unable to fetch Harmony hub details.",
          variant: "destructive"
        })
      }
    } finally {
      setLoadingHarmonyHubs(false)
    }
  }

  const handleDiscoverHarmony = async () => {
    setDiscoveringHarmony(true)
    try {
      const response = await discoverHarmonyHubs(5000)
      if (response.success) {
        const hubs = Array.isArray(response.hubs) ? response.hubs : []
        setHarmonyHubs(hubs)
        toast({
          title: "Harmony Hub discovery complete",
          description: `Discovered ${response.count ?? hubs.length} hub${(response.count ?? hubs.length) === 1 ? "" : "s"}.`
        })
      }
      await Promise.all([
        loadHarmonyStatus(),
        loadHarmonyHubs({ includeCommands: false })
      ])
    } catch (error) {
      console.error('Harmony discovery failed:', error)
      toast({
        title: "Harmony discovery failed",
        description: error.message || "Unable to discover Harmony hubs on your network.",
        variant: "destructive"
      })
    } finally {
      setDiscoveringHarmony(false)
    }
  }

  const handleSyncHarmonyState = async () => {
    setSyncingHarmonyState(true)
    try {
      const hubIps = harmonyHubs
        .map((hub: any) => hub?.ip)
        .filter((hubIp: string | undefined) => typeof hubIp === "string" && hubIp.length > 0)
      const response = await syncHarmonyState(hubIps.length > 0 ? hubIps : undefined)
      if (response.success) {
        toast({
          title: "Harmony Hub state refreshed",
          description: `Refreshed ${response.refreshed ?? 0} hub${(response.refreshed ?? 0) === 1 ? "" : "s"}.`
        })
      }
      await Promise.all([
        loadHarmonyStatus(),
        loadHarmonyHubs({ includeCommands: false })
      ])
    } catch (error) {
      console.error('Harmony state sync failed:', error)
      toast({
        title: "Harmony state sync failed",
        description: error.message || "Unable to refresh Harmony hub activity state.",
        variant: "destructive"
      })
    } finally {
      setSyncingHarmonyState(false)
    }
  }

  const handleSyncHarmonyDevices = async () => {
    setSyncingHarmony(true)
    try {
      const response = await syncHarmonyDevices(6000)
      if (response.success) {
        toast({
          title: "Harmony Hub activity devices synced",
          description: `${response.created ?? 0} created, ${response.updated ?? 0} updated, ${response.removed ?? 0} removed.`
        })
      }
      await Promise.all([
        loadHarmonyStatus(),
        loadHarmonyHubs({ includeCommands: false })
      ])
    } catch (error) {
      console.error('Harmony Hub device sync failed:', error)
      toast({
        title: "Harmony Hub sync failed",
        description: error.message || "Unable to sync Harmony Hub activities into activity devices.",
        variant: "destructive"
      })
    } finally {
      setSyncingHarmony(false)
    }
  }

  const handleHarmonyQuickActivityStart = async (hubIp: string, activityId: string) => {
    const key = `${hubIp}:${activityId}`
    setHarmonyQuickActionKey(key)
    try {
      const response = await startHarmonyActivity(hubIp, activityId)
      if (response.success) {
        toast({
          title: "Harmony activity started",
          description: `Started activity ${activityId} on ${hubIp}.`
        })
      }
      await Promise.all([
        loadHarmonyStatus(),
        loadHarmonyHubs({ includeCommands: false })
      ])
    } catch (error) {
      console.error('Failed to start Harmony activity:', error)
      toast({
        title: "Failed to start activity",
        description: error.message || "Unable to start Harmony activity.",
        variant: "destructive"
      })
    } finally {
      setHarmonyQuickActionKey("")
    }
  }

  const handleHarmonyQuickOff = async (hubIp: string) => {
    const key = `${hubIp}:off`
    setHarmonyQuickActionKey(key)
    try {
      const response = await turnOffHarmonyHub(hubIp)
      if (response.success) {
        toast({
          title: "Harmony hub turned off",
          description: `Powered off active activity on ${hubIp}.`
        })
      }
      await Promise.all([
        loadHarmonyStatus(),
        loadHarmonyHubs({ includeCommands: false })
      ])
    } catch (error) {
      console.error('Failed to turn off Harmony hub:', error)
      toast({
        title: "Failed to turn off hub",
        description: error.message || "Unable to power off Harmony activity.",
        variant: "destructive"
      })
    } finally {
      setHarmonyQuickActionKey("")
    }
  }

  // Handle OAuth callback from URL parameters
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const smartthingsResult = urlParams.get('smartthings');
    const ecobeeResult = urlParams.get('ecobee');
    const message = urlParams.get('message');
    let handledOAuthCallback = false

    if (smartthingsResult === 'success') {
      toast({
        title: "SmartThings Connected",
        description: "SmartThings integration has been successfully configured!"
      });
      // Reload status and settings after successful OAuth
      loadSmartThingsStatus();
      handledOAuthCallback = true
    } else if (smartthingsResult === 'error') {
      toast({
        title: "SmartThings Connection Failed",
        description: message || "Failed to connect SmartThings integration",
        variant: "destructive"
      });
      handledOAuthCallback = true
    }

    if (ecobeeResult === 'success') {
      toast({
        title: "Ecobee Connected",
        description: "Ecobee integration has been successfully configured!"
      })
      loadEcobeeStatus()
      handledOAuthCallback = true
    } else if (ecobeeResult === 'error') {
      toast({
        title: "Ecobee Connection Failed",
        description: message || "Failed to connect Ecobee integration",
        variant: "destructive"
      })
      handledOAuthCallback = true
    }

    if (handledOAuthCallback) {
      window.history.replaceState({}, document.title, window.location.pathname)
    }
  }, [toast]);

  const handleSaveSettings = async (data: any) => {
    setLoading(true)
    try {
      console.log('Saving settings:', data)
      
      // Don't send placeholder values to backend - preserve existing sensitive fields
      const settingsToSave = { ...data };
      if (isMaskedSecretPlaceholder(settingsToSave.elevenlabsApiKey)) {
        delete settingsToSave.elevenlabsApiKey; // Don't update if it's just the placeholder
      }
      if (isMaskedSecretPlaceholder(settingsToSave.smartthingsToken)) {
        delete settingsToSave.smartthingsToken; // Don't update if it's just the placeholder
      }
      if (isMaskedSecretPlaceholder(settingsToSave.smartthingsClientSecret)) {
        delete settingsToSave.smartthingsClientSecret; // Don't update if it's just the placeholder
      }
      if (isMaskedSecretPlaceholder(settingsToSave.openaiApiKey)) {
        delete settingsToSave.openaiApiKey; // Don't update if it's just the placeholder
      }
      if (isMaskedSecretPlaceholder(settingsToSave.anthropicApiKey)) {
        delete settingsToSave.anthropicApiKey; // Don't update if it's just the placeholder
      }

      const trimmedIsyPassword = typeof settingsToSave.isyPassword === "string"
        ? settingsToSave.isyPassword.trim()
        : ""
      if (!trimmedIsyPassword || isMaskedSecretPlaceholder(trimmedIsyPassword)) {
        delete settingsToSave.isyPassword // Preserve existing saved password when field is left blank
      } else {
        settingsToSave.isyPassword = trimmedIsyPassword
      }
      
      const response = await updateSettings(settingsToSave);
      
      if (response.success) {
        setIsyPasswordConfigured(Boolean(
          response.settings?.isyPassword && String(response.settings.isyPassword).trim()
        ))
        setValue("isyPassword", "")
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

  const resolveCandidateEndpoint = (candidate: InsteonSerialPortCandidate | null | undefined) => {
    const stablePath = typeof candidate?.stablePath === "string" ? candidate.stablePath.trim() : ""
    const directPath = typeof candidate?.path === "string" ? candidate.path.trim() : ""
    return stablePath || directPath
  }

  const handleUseDetectedInsteonEndpoint = (candidate: InsteonSerialPortCandidate) => {
    const endpoint = resolveCandidateEndpoint(candidate)
    if (!endpoint) {
      return
    }

    setValue("insteonPort", endpoint, { shouldDirty: true, shouldTouch: true })
    setInsteonPlmTestResult(null)
    setInsteonLinkedStatusResult(null)
    toast({
      title: "PLM endpoint selected",
      description: `Using ${endpoint}`
    })
  }

  const handleScanInsteonPlmEndpoints = async () => {
    setScanningInsteonPorts(true)
    try {
      const response = await getInsteonSerialPorts()
      const ports = Array.isArray(response?.ports) ? response.ports : []
      const serialTransportSupported = response?.serialTransportSupported !== false
      const serialTransportError = typeof response?.serialTransportError === "string"
        ? response.serialTransportError
        : ""
      setInsteonSerialPortCandidates(ports)

      if (ports.length === 0) {
        toast({
          title: "No serial endpoints detected",
          description: "Connect the USB PLM and check USB permissions for the HomeBrain service user.",
          variant: "destructive"
        })
        return
      }

      const bestCandidate = ports.find((port: InsteonSerialPortCandidate) => port?.likelyInsteon) || ports[0]
      const bestEndpoint = resolveCandidateEndpoint(bestCandidate)
      const currentEndpoint = insteonPortValue.trim()

      if (!currentEndpoint && bestEndpoint) {
        setValue("insteonPort", bestEndpoint, { shouldDirty: true, shouldTouch: true })
      }

      const likelyCount = ports.filter((port: InsteonSerialPortCandidate) => Boolean(port?.likelyInsteon)).length
      toast({
        title: "PLM scan complete",
        description: likelyCount > 0
          ? `Found ${ports.length} serial endpoint(s), ${likelyCount} likely INSTEON.`
          : `Found ${ports.length} serial endpoint(s).`
      })

      if (!serialTransportSupported) {
        toast({
          title: "Serial module unavailable",
          description: serialTransportError
            ? `HomeBrain will use local TCP bridge fallback. (${serialTransportError})`
            : "HomeBrain will use local TCP bridge fallback for this endpoint."
        })
      }
    } catch (error: any) {
      console.error("INSTEON serial endpoint scan failed:", error)
      toast({
        title: "PLM scan failed",
        description: error?.message || "Unable to list serial endpoints.",
        variant: "destructive"
      })
    } finally {
      setScanningInsteonPorts(false)
    }
  }

  const handleTestInsteonPlm = async () => {
    const endpoint = insteonPortValue.trim()
    if (!endpoint) {
      toast({
        title: "Endpoint required",
        description: "Enter or scan an INSTEON PLM endpoint first.",
        variant: "destructive"
      })
      return
    }

    setTestingInsteonPlmConnection(true)
    try {
      await updateSettings({ insteonPort: endpoint })
      const result = await testInsteonConnection()
      setInsteonPlmTestResult(result || {})

      if (result?.success) {
        const plmId = result?.plmInfo?.deviceId ? ` PLM ID ${result.plmInfo.deviceId}.` : ""
        toast({
          title: "PLM connection successful",
          description: `${result?.message || "Insteon PLM is reachable."}${plmId}`
        })
      } else {
        toast({
          title: "PLM connection failed",
          description: result?.message || "HomeBrain could not talk to the configured PLM endpoint.",
          variant: "destructive"
        })
      }
    } catch (error: any) {
      console.error("INSTEON PLM test failed:", error)
      const message = error?.message || "Unable to test INSTEON PLM connection."
      setInsteonPlmTestResult({
        success: false,
        connected: false,
        message
      })
      toast({
        title: "PLM connection failed",
        description: message,
        variant: "destructive"
      })
    } finally {
      setTestingInsteonPlmConnection(false)
    }
  }

  const handleQueryInsteonLinkedStatus = async () => {
    const endpoint = insteonPortValue.trim()
    if (!endpoint) {
      toast({
        title: "Endpoint required",
        description: "Enter or scan an INSTEON PLM endpoint first.",
        variant: "destructive"
      })
      return
    }

    setQueryingInsteonLinkedStatus(true)
    try {
      await updateSettings({ insteonPort: endpoint })
      const result = await queryLinkedInsteonDeviceStatus()
      setInsteonLinkedStatusResult(result || null)

      const linkedCount = result?.summary?.linkedDevices ?? (Array.isArray(result?.devices) ? result.devices.length : 0)
      const reachable = result?.summary?.reachable ?? 0
      const unreachable = result?.summary?.unreachable ?? 0

      toast({
        title: "PLM query complete",
        description: `Checked ${linkedCount} linked device${linkedCount === 1 ? "" : "s"} (${reachable} reachable, ${unreachable} unreachable).`
      })
    } catch (error: any) {
      const message = error?.message || "Unable to query linked devices from PLM."
      setInsteonLinkedStatusResult({
        success: false,
        message,
        summary: {
          linkedDevices: 0,
          reachable: 0,
          unreachable: 0,
          statusKnown: 0,
          statusUnknown: 0
        },
        devices: []
      })
      toast({
        title: "PLM query failed",
        description: message,
        variant: "destructive"
      })
    } finally {
      setQueryingInsteonLinkedStatus(false)
    }
  }

  const buildIsyConnectionPayload = () => {
    const parsedPort = Number(isyPortValue)
    const normalizedPassword = isyPasswordValue.trim()

    const payload: Record<string, any> = {
      ...(isyHostValue.trim() ? { isyHost: isyHostValue.trim() } : {}),
      ...(Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? { isyPort: parsedPort } : {}),
      ...(isyUsernameValue.trim() ? { isyUsername: isyUsernameValue.trim() } : {}),
      isyUseHttps: isyUseHttpsValue,
      isyIgnoreTlsErrors: isyIgnoreTlsErrorsValue
    }

    if (normalizedPassword) {
      payload.isyPassword = normalizedPassword
    }

    return payload
  }

  const handleTestIsyConnection = async () => {
    if (!isyHostValue.trim() || !isyUsernameValue.trim()) {
      toast({
        title: "ISY host and username required",
        description: "Enter ISY host and username before testing connection.",
        variant: "destructive"
      })
      return
    }

    setTestingIsyConnection(true)
    try {
      const response = await testInsteonISYConnection(buildIsyConnectionPayload())
      setIsyTestResult(response)
      toast({
        title: "ISY connection successful",
        description: response?.message || "HomeBrain can reach your ISY controller."
      })
    } catch (error: any) {
      const message = error?.message || "Failed to connect to ISY."
      setIsyTestResult({
        success: false,
        message
      })
      toast({
        title: "ISY connection failed",
        description: message,
        variant: "destructive"
      })
    } finally {
      setTestingIsyConnection(false)
    }
  }

  const handleExtractIsyData = async () => {
    setExtractingIsyData(true)
    try {
      const response = await extractInsteonISYData(buildIsyConnectionPayload())
      setIsyExtractionResult(response?.extraction || null)
      const counts = response?.extraction?.counts || {}
      toast({
        title: "ISY extraction complete",
        description: `Found ${counts.uniqueDeviceIds ?? 0} devices, ${counts.topologyScenes ?? 0} scenes, ${counts.programs ?? 0} programs.`
      })
    } catch (error: any) {
      const message = error?.message || "ISY extraction failed."
      toast({
        title: "ISY extraction failed",
        description: message,
        variant: "destructive"
      })
    } finally {
      setExtractingIsyData(false)
    }
  }

  const validateIsyMigrationSelection = () => {
    if (!isyMigrationOptions.importDevices && !isyMigrationOptions.importTopology && !isyMigrationOptions.importPrograms) {
      toast({
        title: "Nothing selected to migrate",
        description: "Enable at least one migration option before running preview or apply.",
        variant: "destructive"
      })
      return false
    }
    return true
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const formatIsyRunStatusLabel = (status: string | null | undefined) => {
    switch ((status || "").toLowerCase()) {
      case "running":
        return "Running"
      case "completed":
        return "Completed"
      case "completed_with_errors":
        return "Completed With Errors"
      case "failed":
        return "Failed"
      default:
        return status || "Unknown"
    }
  }

  const formatIsyMigrationLogLine = (entry: InsteonIsySyncRunLogEntry) => {
    const timestampText = entry?.timestamp
      ? new Date(entry.timestamp).toLocaleTimeString()
      : "--:--:--"
    const stageText = entry?.stage ? `[${entry.stage}] ` : ""
    return `[${timestampText}] ${stageText}${entry?.message || "No message"}`
  }

  const buildIsyMigrationLogText = () => {
    const headerLines = [
      `Status: ${formatIsyRunStatusLabel(isyMigrationRunStatus)}`,
      `Run ID: ${isyMigrationRunId || "unknown"}`,
      `Generated: ${new Date().toISOString()}`
    ]

    const logLines = isyMigrationRunLogs.length > 0
      ? isyMigrationRunLogs.map((entry) => formatIsyMigrationLogLine(entry))
      : ["(no log entries)"]

    return [...headerLines, "", ...logLines].join("\n")
  }

  const copyTextToClipboard = async (text: string) => {
    if (!text) {
      return false
    }

    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }

    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    textarea.style.left = "-9999px"
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()

    try {
      const copied = document.execCommand("copy")
      document.body.removeChild(textarea)
      return copied
    } catch (error) {
      document.body.removeChild(textarea)
      return false
    }
  }

  const handleCopyIsyMigrationLogs = async () => {
    if (isyMigrationRunLogs.length === 0) {
      toast({
        title: "No logs to copy",
        description: "Run a migration first or wait for log output.",
        variant: "destructive"
      })
      return
    }

    try {
      const copied = await copyTextToClipboard(buildIsyMigrationLogText())
      if (!copied) {
        throw new Error("Clipboard unavailable")
      }

      toast({
        title: "Migration log copied",
        description: `Copied ${isyMigrationRunLogs.length} log line${isyMigrationRunLogs.length === 1 ? "" : "s"} to clipboard.`
      })
    } catch (error: any) {
      toast({
        title: "Copy failed",
        description: error?.message || "Unable to copy migration logs.",
        variant: "destructive"
      })
    }
  }

  const handlePreviewIsyMigration = async () => {
    if (!validateIsyMigrationSelection()) {
      return
    }

    setPreviewingIsyMigration(true)
    try {
      const response = await syncInsteonFromISY({
        ...buildIsyConnectionPayload(),
        dryRun: true,
        importDevices: isyMigrationOptions.importDevices,
        importTopology: isyMigrationOptions.importTopology,
        importPrograms: isyMigrationOptions.importPrograms,
        enableProgramWorkflows: isyMigrationOptions.enableProgramWorkflows,
        continueOnError: isyMigrationOptions.continueOnError,
        linkMode: isyMigrationOptions.linkMode
      })
      setIsyMigrationResult(response)
      toast({
        title: "Migration preview complete",
        description: response?.message || "Dry run finished. Review results below before applying."
      })
    } catch (error: any) {
      const message = error?.message || "ISY dry run failed."
      toast({
        title: "Migration preview failed",
        description: message,
        variant: "destructive"
      })
    } finally {
      setPreviewingIsyMigration(false)
    }
  }

  const handleRunIsyMigration = async () => {
    if (!validateIsyMigrationSelection()) {
      return
    }

    if (!window.confirm("Run ISY migration now? This writes links/scenes to the connected USB PLM.")) {
      return
    }

    setRunningIsyMigration(true)
    setIsyMigrationRunId(null)
    setIsyMigrationRunStatus("running")
    setIsyMigrationRunLogs([])
    try {
      const startResponse = await startInsteonIsySyncRun({
        ...buildIsyConnectionPayload(),
        dryRun: false,
        importDevices: isyMigrationOptions.importDevices,
        importTopology: isyMigrationOptions.importTopology,
        importPrograms: isyMigrationOptions.importPrograms,
        enableProgramWorkflows: isyMigrationOptions.enableProgramWorkflows,
        continueOnError: isyMigrationOptions.continueOnError,
        linkMode: isyMigrationOptions.linkMode
      })

      const runId = startResponse?.runId || startResponse?.run?.id
      if (!runId) {
        throw new Error("Migration run started but no run id was returned by the server.")
      }

      setIsyMigrationRunId(runId)
      if (Array.isArray(startResponse?.run?.logs)) {
        setIsyMigrationRunLogs(startResponse.run.logs)
      }
      if (startResponse?.run?.status) {
        setIsyMigrationRunStatus(startResponse.run.status)
      }

      const pollingStartedAt = Date.now()
      const maxPollDurationMs = 1000 * 60 * 60 * 4 // 4 hours
      let consecutivePollFailures = 0

      while (true) {
        if (Date.now() - pollingStartedAt > maxPollDurationMs) {
          throw new Error("Migration is still running after 4 hours; polling timed out. You can refresh and continue monitoring with the same run id.")
        }

        try {
          const statusResponse = await getInsteonIsySyncRun(runId)
          const run = statusResponse?.run
          if (!run) {
            throw new Error("Migration run status response did not include a run snapshot.")
          }

          consecutivePollFailures = 0
          setIsyMigrationRunStatus(run.status || null)
          setIsyMigrationRunLogs(Array.isArray(run.logs) ? run.logs : [])

          const isTerminal = run.status === "completed"
            || run.status === "completed_with_errors"
            || run.status === "failed"

          if (isTerminal) {
            if (run.result) {
              setIsyMigrationResult(run.result)
            }

            if (run.status === "failed") {
              toast({
                title: "ISY migration failed",
                description: run.error || "Migration run failed.",
                variant: "destructive"
              })
            } else {
              const result = run.result || {}
              toast({
                title: result?.success ? "ISY migration completed" : "ISY migration completed with errors",
                description: result?.message || "Migration run finished. Review the summary and log below.",
                variant: result?.success ? "default" : "destructive"
              })
            }

            break
          }
        } catch (pollError: any) {
          consecutivePollFailures += 1
          if (consecutivePollFailures >= 5) {
            throw new Error(pollError?.message || "Failed to poll migration log updates.")
          }
        }

        await sleep(1000)
      }
    } catch (error: any) {
      const message = error?.message || "ISY migration failed."
      toast({
        title: "ISY migration failed",
        description: message,
        variant: "destructive"
      })
    } finally {
      setRunningIsyMigration(false)
    }
  }

  const handleTestElevenLabsKey = async () => {
    const formApiKey = watch('elevenlabsApiKey');
    
    // If no API key in form field or it's the placeholder, get the existing one from the backend
    let apiKeyToTest = formApiKey;
    
    if (!apiKeyToTest || apiKeyToTest.trim() === '' || isMaskedSecretPlaceholder(apiKeyToTest)) {
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
    
    if (!apiKeyToTest || apiKeyToTest.trim() === '' || isMaskedSecretPlaceholder(apiKeyToTest)) {
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
    
    if (!apiKeyToTest || apiKeyToTest.trim() === '' || isMaskedSecretPlaceholder(apiKeyToTest)) {
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

        const fallbackDevices = Array.isArray((response as any).devices)
          ? (response as any).devices
          : smartThingsDevices;
        fetchSmartThingsDevices({
          showToast: false,
          fallbackDevices
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

  const handleRefreshSmartThingsDevices = async () => {
    fetchSmartThingsDevices({
      showToast: true,
      fallbackDevices: smartThingsDevices.length > 0
        ? smartThingsDevices
        : Array.isArray((smartthingsStatus as any)?.connectedDevices)
          ? (smartthingsStatus as any).connectedDevices
          : []
    })
  }

  const handleConfigureEcobee = async () => {
    const clientId = ecobeeConfig.clientId?.trim()
    const redirectUri = ecobeeConfig.redirectUri?.trim()

    if (!clientId) {
      toast({
        title: "Error",
        description: "Ecobee App Key is required for OAuth configuration.",
        variant: "destructive"
      })
      return
    }

    setConfiguringEcobee(true)
    try {
      const response = await configureEcobeeOAuth({
        clientId,
        redirectUri: redirectUri || undefined
      })

      if (response.success) {
        toast({
          title: "Configuration Saved",
          description: "Ecobee OAuth configuration has been saved. You can now connect your Ecobee account."
        })
        loadEcobeeStatus()
      }
    } catch (error: any) {
      console.error('Ecobee OAuth configuration failed:', error)
      toast({
        title: "Configuration Failed",
        description: error?.message || "Failed to configure Ecobee OAuth",
        variant: "destructive"
      })
    } finally {
      setConfiguringEcobee(false)
    }
  }

  const handleConnectEcobee = async () => {
    try {
      const response = await getEcobeeAuthUrl()
      if (response.success && response.authUrl) {
        window.location.href = response.authUrl
      }
    } catch (error: any) {
      console.error('Failed to get Ecobee authorization URL:', error)
      toast({
        title: "Connection Failed",
        description: error?.message || "Failed to get Ecobee authorization URL. Configure OAuth first.",
        variant: "destructive"
      })
    }
  }

  const handleTestEcobee = async () => {
    setTestingEcobee(true)
    try {
      const response = await testEcobeeConnection()
      if (response.success) {
        toast({
          title: "Connection Successful",
          description: `Ecobee connection is working! Found ${response.thermostatCount || 0} thermostat${response.thermostatCount === 1 ? "" : "s"}.`
        })
        await Promise.all([
          loadEcobeeStatus(),
          fetchEcobeeDevices({ showToast: false, forceRefresh: true })
        ])
      }
    } catch (error: any) {
      console.error('Ecobee connection test failed:', error)
      toast({
        title: "Connection Failed",
        description: error?.message || "Failed to connect to Ecobee API",
        variant: "destructive"
      })
    } finally {
      setTestingEcobee(false)
    }
  }

  const handleDisconnectEcobee = async () => {
    setDisconnectingEcobee(true)
    try {
      const response = await disconnectEcobee()
      if (response.success) {
        toast({
          title: "Disconnected",
          description: "Ecobee integration has been disconnected successfully."
        })
        setEcobeeDevices([])
        loadEcobeeStatus()
      }
    } catch (error: any) {
      console.error('Ecobee disconnection failed:', error)
      toast({
        title: "Disconnection Failed",
        description: error?.message || "Failed to disconnect Ecobee integration",
        variant: "destructive"
      })
    } finally {
      setDisconnectingEcobee(false)
    }
  }

  const handleRefreshEcobeeDevices = async () => {
    await fetchEcobeeDevices({
      showToast: true,
      forceRefresh: true
    })
  }

  const handleSaveSthmConfig = async () => {
    if (!smartthingsStatus?.isConnected) {
      toast({
        title: "SmartThings Not Connected",
        description: "Connect SmartThings before configuring Home Monitor virtual switches.",
        variant: "destructive"
      })
      return
    }

    const { disarmDeviceId, armStayDeviceId, armAwayDeviceId, locationId } = sthmConfig
    if (!disarmDeviceId || !armStayDeviceId || !armAwayDeviceId) {
      toast({
        title: "Missing Virtual Switches",
        description: "Please assign switches for Disarm, Arm Stay, and Arm Away before saving.",
        variant: "destructive"
      })
      return
    }

    setSavingSthmConfig(true)
    try {
      const payload: {
        disarmDeviceId: string
        armStayDeviceId: string
        armAwayDeviceId: string
        locationId?: string
      } = {
        disarmDeviceId,
        armStayDeviceId,
        armAwayDeviceId
      }
      if (locationId && locationId.trim().length > 0) {
        payload.locationId = locationId.trim()
      }

      const response = await configureSmartThingsSthm(payload)
      if (response.success) {
        toast({
          title: "STHM Mapping Saved",
          description: "SmartThings Home Monitor will now sync via the selected virtual switches."
        })

        if (response.integration) {
          setSmartthingsStatus(response.integration)
          const updated = response.integration.sthm || {}
          setSthmConfig({
            armAwayDeviceId: updated.armAwayDeviceId || "",
            armStayDeviceId: updated.armStayDeviceId || "",
            disarmDeviceId: updated.disarmDeviceId || "",
            locationId: updated.locationId || payload.locationId || ""
          })
          if (Array.isArray(response.integration.connectedDevices)) {
            setSmartThingsDevices(response.integration.connectedDevices)
          }
          fetchSmartThingsDevices({
            integration: response.integration,
            fallbackDevices: Array.isArray(response.integration.connectedDevices)
              ? response.integration.connectedDevices
              : []
          })
        } else {
          await loadSmartThingsStatus()
        }
      }
    } catch (error: any) {
      console.error('SmartThings STHM configuration failed:', error)
      toast({
        title: "Failed to Save STHM Mapping",
        description: error?.response?.data?.message || error?.message || "Unexpected error while saving configuration",
        variant: "destructive"
      })
    } finally {
      setSavingSthmConfig(false)
    }
  }

  const handleRunSthmDiagnostics = async () => {
    if (!smartthingsStatus?.isConnected) {
      toast({
        title: "SmartThings Not Connected",
        description: "Connect SmartThings before running STHM diagnostics.",
        variant: "destructive"
      })
      return
    }

    setRunningSthmDiagnostics(true)
    try {
      const response = await getSmartThingsSthmDiagnostics({ deepProbe: false })
      if (response.diagnostics) {
        setSthmDiagnostics(response.diagnostics)
        if (response.diagnostics.integration) {
          setSmartthingsStatus(response.diagnostics.integration)
        }
        if (response.success) {
          toast({
            title: "STHM Diagnostics Complete",
            description: "Latest SmartThings bridge diagnostics have been loaded below."
          })
        } else {
          toast({
            title: "STHM Diagnostics Partial",
            description: response.message || "Diagnostics completed with warnings."
          })
        }
      } else {
        throw new Error("Unexpected diagnostics response")
      }
    } catch (error: any) {
      console.error('STHM diagnostics failed:', error)
      toast({
        title: "STHM Diagnostics Failed",
        description: error?.response?.data?.message || error?.message || "Unable to run diagnostics",
        variant: "destructive"
      })
    } finally {
      setRunningSthmDiagnostics(false)
    }
  }

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

  const getEcobeeStatusIcon = () => {
    if (!ecobeeStatus) return <AlertCircle className="h-4 w-4 text-gray-500" />

    if (ecobeeStatus.isConnected) {
      return <CheckCircle className="h-4 w-4 text-green-600" />
    } else if (ecobeeStatus.isConfigured) {
      return <AlertCircle className="h-4 w-4 text-yellow-600" />
    }

    return <XCircle className="h-4 w-4 text-red-600" />
  }

  const getEcobeeStatusText = () => {
    if (!ecobeeStatus) return "Loading..."

    if (ecobeeStatus.isConnected) {
      return "Connected and authenticated"
    } else if (ecobeeStatus.isConfigured) {
      return "Configured but not connected"
    }

    return "Not configured"
  }

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
          description: response.message || `Successfully synced ${response.deviceCount ?? 0} SmartThings devices`
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

  const handleSyncHarmonyMaintenance = async () => {
    setSyncingHarmony(true);
    try {
      console.log('Syncing Harmony Hub activity devices...');
      const response = await forceHarmonySync();

      if (response.success) {
        toast({
          title: "Sync Complete",
          description: response.message || `Harmony Hub sync complete (${response.created ?? 0} created, ${response.updated ?? 0} updated)`
        });
      }
      await Promise.all([
        loadHarmonyStatus(),
        loadHarmonyHubs({ includeCommands: false })
      ]);
    } catch (error) {
      console.error('Harmony Hub sync failed:', error);
      toast({
        title: "Sync Failed",
        description: error.message || "Failed to sync Harmony Hub activity devices",
        variant: "destructive"
      });
    } finally {
      setSyncingHarmony(false);
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

  const handleClearHarmonyDevices = async () => {
    setClearingHarmonyDevices(true);
    try {
      console.log('Clearing Harmony Hub activity devices...');
      const response = await clearHarmonyDevices();

      if (response.success) {
        toast({
          title: "Devices Cleared",
          description: `Successfully cleared ${response.deletedCount} Harmony Hub activity devices`
        });
      }
      await Promise.all([
        loadHarmonyStatus(),
        loadHarmonyHubs({ includeCommands: false })
      ]);
    } catch (error) {
      console.error('Clear Harmony Hub activity devices failed:', error);
      toast({
        title: "Clear Failed",
        description: error.message || "Failed to clear Harmony Hub activity devices",
        variant: "destructive"
      });
    } finally {
      setClearingHarmonyDevices(false);
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

  // LLM Priority List handlers
  const movePriorityUp = (index: number) => {
    if (index === 0) return; // Already at top
    const newList = [...llmPriorityList];
    [newList[index - 1], newList[index]] = [newList[index], newList[index - 1]];
    setLlmPriorityList(newList);
  };

  const movePriorityDown = (index: number) => {
    if (index === llmPriorityList.length - 1) return; // Already at bottom
    const newList = [...llmPriorityList];
    [newList[index], newList[index + 1]] = [newList[index + 1], newList[index]];
    setLlmPriorityList(newList);
  };

  const handleSavePriorityList = async () => {
    setSavingPriority(true);
    try {
      console.log('Saving LLM priority list:', llmPriorityList);
      const response = await updateLLMPriorityList(llmPriorityList);

      if (response.success) {
        toast({
          title: "Priority List Saved",
          description: "LLM priority list has been updated successfully"
        });
      }
    } catch (error) {
      console.error('Failed to save LLM priority list:', error);
      toast({
        title: "Error",
        description: error.message || "Failed to save LLM priority list",
        variant: "destructive"
      });
    } finally {
      setSavingPriority(false);
    }
  };

  const getProviderDisplayName = (provider: string) => {
    const names = {
      'openai': 'OpenAI',
      'anthropic': 'Anthropic Claude',
      'local': 'Local LLM'
    };
    return names[provider] || provider;
  };

  const getProviderIcon = (provider: string) => {
    const icons = {
      'openai': <Cpu className="h-4 w-4 text-blue-600" />,
      'anthropic': <Cpu className="h-4 w-4 text-orange-600" />,
      'local': <Server className="h-4 w-4 text-green-600" />
    };
    return icons[provider] || <Brain className="h-4 w-4" />;
  };

  const formatHarmonyTimestamp = (value: string | Date | null | undefined) => {
    if (!value) {
      return "Never";
    }

    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return "Unknown";
    }

    return parsed.toLocaleString();
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
          <TabsList className="h-auto flex-wrap gap-1 bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 p-1">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="voice">Voice & Audio</TabsTrigger>
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
            <TabsTrigger value="resources">System Resources</TabsTrigger>
            <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-6">
            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
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

            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
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
            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
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

            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Cpu className="h-5 w-5 text-indigo-600" />
                  Speech-to-Text Pipeline
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="text-sm font-medium">Provider</label>
                    <Select
                      value={sttProviderValue}
                      onValueChange={(value) => {
                        setValue("sttProvider", value)
                        if (value === "local" && !localWhisperModels.includes(sttModelValue)) {
                          setValue("sttModel", "small")
                        }
                        if (value === "openai" && !openaiSttModels.includes(sttModelValue)) {
                          setValue("sttModel", "gpt-4o-mini-transcribe")
                        }
                      }}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="openai">OpenAI Whisper API (Cloud)</SelectItem>
                        <SelectItem value="local">On-device Whisper (Jetson)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-1">
                      {sttProviderValue === "local"
                        ? "Audio stays on-device and is processed by the Jetson Orin Nano."
                        : "Audio is sent securely to OpenAI for transcription."}
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium">Recognition Language</label>
                    <Select value={sttLanguageValue} onValueChange={(value) => setValue("sttLanguage", value)}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select language" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">English (en)</SelectItem>
                        <SelectItem value="auto">Auto Detect</SelectItem>
                        <SelectItem value="es">Spanish (es)</SelectItem>
                        <SelectItem value="fr">French (fr)</SelectItem>
                        <SelectItem value="de">German (de)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-1">
                      Choose “Auto Detect” to let Whisper determine the spoken language automatically.
                    </p>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="text-sm font-medium">
                      {sttProviderValue === "local" ? "Local Whisper Model" : "Cloud Model"}
                    </label>
                    <Select value={sttModelValue} onValueChange={(value) => setValue("sttModel", value)}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select model" />
                      </SelectTrigger>
                      <SelectContent>
                        {sttProviderValue === "local" ? (
                          <>
                            <SelectItem value="tiny">tiny (fastest, least accurate)</SelectItem>
                            <SelectItem value="base">base (balanced)</SelectItem>
                            <SelectItem value="small">small (recommended)</SelectItem>
                            <SelectItem value="small.en">small.en (English-optimized)</SelectItem>
                            <SelectItem value="medium">medium (highest accuracy)</SelectItem>
                          </>
                        ) : (
                          <>
                            <SelectItem value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe</SelectItem>
                            <SelectItem value="gpt-4o-mini-transcribe-latest">
                              gpt-4o-mini-transcribe-latest
                            </SelectItem>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-1">
                      {sttProviderValue === "local"
                        ? "Manage downloads and GPU settings on the Whisper Management page."
                        : "Uses OpenAI’s managed Whisper models via the Audio Transcriptions API."}
                    </p>
                  </div>
                  <div className="rounded-lg border border-dashed border-indigo-200 bg-indigo-50/60 p-4 text-sm text-indigo-900 dark:border-indigo-800 dark:bg-indigo-900/20 dark:text-indigo-100">
                    {sttProviderValue === "local" ? (
                      <>
                        <p>Keep the on-device service healthy to ensure instant transcription.</p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          onClick={() => navigate("/whisper")}
                        >
                          Open Whisper Management
                        </Button>
                      </>
                    ) : (
                      <>
                        <p>Ensure your OpenAI API key has access to Whisper transcription models.</p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          onClick={() =>
                            window.open("https://platform.openai.com/account/api-keys", "_blank", "noopener")
                          }
                        >
                          Open OpenAI Dashboard
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            <WakeWordManager />

            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
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
            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wifi className="h-5 w-5 text-blue-600" />
                  Device Integrations
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <div>
                    <label className="text-sm font-medium">INSTEON PLM Endpoint</label>
                    <Input
                      {...register("insteonPort")}
                      placeholder="/dev/serial/by-id/... (recommended) or /dev/ttyUSB0 or tcp://192.168.1.50:9761"
                      className="mt-1"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      USB PLM local serial path (prefer /dev/serial/by-id/... for stable naming) or TCP serial bridge (for example tcp://host:9761)
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleScanInsteonPlmEndpoints}
                      disabled={scanningInsteonPorts}
                    >
                      {scanningInsteonPorts ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Scanning...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Scan USB PLMs
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleTestInsteonPlm}
                      disabled={testingInsteonPlmConnection}
                    >
                      {testingInsteonPlmConnection ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Testing...
                        </>
                      ) : (
                        <>
                          <TestTube className="h-4 w-4 mr-2" />
                          Test PLM Connection
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleQueryInsteonLinkedStatus}
                      disabled={queryingInsteonLinkedStatus}
                    >
                      {queryingInsteonLinkedStatus ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Querying...
                        </>
                      ) : (
                        <>
                          <HardDrive className="h-4 w-4 mr-2" />
                          Query Linked Devices
                        </>
                      )}
                    </Button>
                  </div>

                  {insteonSerialPortCandidates.length > 0 && (
                    <div className="rounded-md border border-blue-200/70 bg-blue-50/50 dark:border-blue-900/50 dark:bg-blue-950/10 p-3 space-y-2">
                      <p className="text-xs font-medium text-blue-800 dark:text-blue-300">
                        Detected serial endpoints
                      </p>
                      <div className="space-y-2">
                        {insteonSerialPortCandidates.slice(0, 6).map((candidate, index) => {
                          const endpoint = resolveCandidateEndpoint(candidate)
                          const isSelected = endpoint === insteonPortValue.trim()
                          const aliasList = Array.isArray(candidate?.aliases)
                            ? candidate.aliases.filter((alias) => alias && alias !== candidate.path)
                            : []

                          return (
                            <div
                              key={`${candidate?.path || "port"}-${index}`}
                              className="flex flex-col gap-2 rounded-md border border-blue-200/80 bg-white/80 dark:bg-slate-900/40 p-2 md:flex-row md:items-center md:justify-between"
                            >
                              <div className="space-y-1">
                                <p className="text-xs font-mono break-all">{endpoint || candidate?.path || "Unknown endpoint"}</p>
                                <p className="text-[11px] text-muted-foreground">
                                  {candidate?.likelyInsteon ? "Likely INSTEON PLM" : "Serial device"}
                                  {candidate?.manufacturer ? ` • ${candidate.manufacturer}` : ""}
                                  {candidate?.vendorId && candidate?.productId ? ` • ${candidate.vendorId}:${candidate.productId}` : ""}
                                </p>
                                {aliasList.length > 0 && (
                                  <p className="text-[11px] text-muted-foreground break-all">
                                    Aliases: {aliasList.join(", ")}
                                  </p>
                                )}
                              </div>
                              <Button
                                type="button"
                                variant={isSelected ? "secondary" : "outline"}
                                size="sm"
                                onClick={() => handleUseDetectedInsteonEndpoint(candidate)}
                                disabled={!endpoint}
                              >
                                {isSelected ? "Selected" : "Use endpoint"}
                              </Button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {insteonPlmTestResult && (
                    <div
                      className={`rounded-md border p-3 ${
                        insteonPlmTestResult.success
                          ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/50 dark:bg-emerald-950/10"
                          : "border-red-200 bg-red-50/60 dark:border-red-900/50 dark:bg-red-950/10"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {insteonPlmTestResult.success ? (
                          <CheckCircle className="h-4 w-4 text-emerald-600 mt-0.5" />
                        ) : (
                          <AlertCircle className="h-4 w-4 text-red-600 mt-0.5" />
                        )}
                        <div className="space-y-1">
                          <p className="text-sm font-medium">
                            {insteonPlmTestResult.success ? "PLM reachable" : "PLM connection failed"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {insteonPlmTestResult.message || "No additional details returned."}
                          </p>
                          {insteonPlmTestResult.port && (
                            <p className="text-xs text-muted-foreground">
                              Endpoint: <span className="font-mono">{insteonPlmTestResult.port}</span>
                            </p>
                          )}
                          {insteonPlmTestResult.runtimeEndpoint && (
                            <p className="text-xs text-muted-foreground">
                              Runtime endpoint: <span className="font-mono">{insteonPlmTestResult.runtimeEndpoint}</span>
                            </p>
                          )}
                          {insteonPlmTestResult.plmInfo?.deviceId && (
                            <p className="text-xs text-muted-foreground">
                              PLM ID: <span className="font-mono">{insteonPlmTestResult.plmInfo.deviceId}</span>
                              {insteonPlmTestResult.plmInfo.firmwareVersion !== undefined
                                ? ` • Firmware: ${insteonPlmTestResult.plmInfo.firmwareVersion}`
                                : ""}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {insteonLinkedStatusResult && (
                    <div className="rounded-md border border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/40 p-3 space-y-2">
                      <p className="text-sm font-medium">Linked-device query</p>
                      <p className="text-xs text-muted-foreground">
                        {insteonLinkedStatusResult.message || "No summary returned."}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Linked: {insteonLinkedStatusResult?.summary?.linkedDevices ?? 0} • Reachable: {insteonLinkedStatusResult?.summary?.reachable ?? 0} • Unreachable: {insteonLinkedStatusResult?.summary?.unreachable ?? 0} • Status known: {insteonLinkedStatusResult?.summary?.statusKnown ?? 0}
                      </p>
                      {insteonLinkedStatusResult?.scannedAt && (
                        <p className="text-xs text-muted-foreground">
                          Scanned: {new Date(insteonLinkedStatusResult.scannedAt).toLocaleString()}
                        </p>
                      )}
                      {Array.isArray(insteonLinkedStatusResult?.warnings) && insteonLinkedStatusResult.warnings.length > 0 && (
                        <div className="space-y-1 text-xs text-amber-700 dark:text-amber-300">
                          {insteonLinkedStatusResult.warnings.map((warning, index) => (
                            <p key={`insteon-linked-warning-${index}`}>{warning}</p>
                          ))}
                        </div>
                      )}
                      {Array.isArray(insteonLinkedStatusResult?.devices) && insteonLinkedStatusResult.devices.length > 0 && (
                        <div className="max-h-64 overflow-y-auto rounded border border-slate-200 dark:border-slate-800">
                          {insteonLinkedStatusResult.devices.map((device, index) => {
                            const addressLabel = device.displayAddress || device.address || "Unknown"
                            const reachable = device.reachable === true
                            const statusText = reachable
                              ? (device.status === null || device.status === undefined
                                ? "Reachable (status unavailable)"
                                : (device.status ? `On${typeof device.brightness === "number" ? ` • ${device.brightness}%` : ""}` : "Off"))
                              : "Unreachable"

                            return (
                              <div
                                key={`${device.address || "linked-device"}-${index}`}
                                className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-slate-200/70 px-3 py-2 text-xs last:border-b-0 dark:border-slate-800/80"
                              >
                                <div className="min-w-0 space-y-1">
                                  <p className="truncate font-medium">{device.name || `Insteon Device ${addressLabel}`}</p>
                                  <p className="font-mono text-muted-foreground">{addressLabel}</p>
                                  {device.error && (
                                    <p className="text-red-700 dark:text-red-300">{device.error}</p>
                                  )}
                                </div>
                                <div className="text-right">
                                  <p className={reachable ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>
                                    {statusText}
                                  </p>
                                  <p className="text-muted-foreground">{device.respondedVia || "none"}</p>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="rounded-lg border border-violet-200 bg-violet-50/40 dark:border-violet-900/60 dark:bg-violet-900/10 p-4 space-y-4">
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-violet-700" />
                    <div>
                      <p className="font-medium text-sm">INSTEON Migration from ISY</p>
                      <p className="text-xs text-muted-foreground">
                        Extract from ISY, preview with dry-run, then write devices/scenes to the connected USB PLM.
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="text-sm font-medium">ISY Host</label>
                      <Input
                        {...register("isyHost")}
                        placeholder="isy.local or 192.168.1.100"
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium">ISY Port</label>
                      <Input
                        {...register("isyPort", {
                          setValueAs: (value) => {
                            if (value === "" || value === null || value === undefined) return undefined
                            const parsed = Number(value)
                            return Number.isFinite(parsed) ? parsed : undefined
                          }
                        })}
                        type="number"
                        min={1}
                        max={65535}
                        placeholder="443"
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium">ISY Username</label>
                      <Input
                        {...register("isyUsername")}
                        placeholder="admin"
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium">ISY Password</label>
                      <Input
                        {...register("isyPassword")}
                        type="password"
                        placeholder={isyPasswordConfigured ? "Password saved (leave blank to keep)" : "Enter ISY password"}
                        className="mt-1"
                      />
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-md border border-violet-200/70 bg-white/70 dark:bg-slate-900/40 p-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">Use HTTPS</p>
                        <p className="text-xs text-muted-foreground">Recommended for most ISY setups.</p>
                      </div>
                      <Switch
                        checked={isyUseHttpsValue}
                        onCheckedChange={(checked) => setValue("isyUseHttps", checked)}
                      />
                    </div>
                    <div className="rounded-md border border-violet-200/70 bg-white/70 dark:bg-slate-900/40 p-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">Ignore TLS Errors</p>
                        <p className="text-xs text-muted-foreground">Enable for self-signed ISY certificates.</p>
                      </div>
                      <Switch
                        checked={isyIgnoreTlsErrorsValue}
                        onCheckedChange={(checked) => setValue("isyIgnoreTlsErrors", checked)}
                      />
                    </div>
                  </div>

                  <div className="rounded-md border border-dashed border-violet-300/70 bg-white/70 dark:bg-slate-900/40 p-3 space-y-3">
                    <p className="text-sm font-medium">Migration Scope</p>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">Import devices</p>
                        <Switch
                          checked={isyMigrationOptions.importDevices}
                          onCheckedChange={(checked) =>
                            setIsyMigrationOptions((prev) => ({ ...prev, importDevices: checked }))
                          }
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">Import topology (scenes/links)</p>
                        <Switch
                          checked={isyMigrationOptions.importTopology}
                          onCheckedChange={(checked) =>
                            setIsyMigrationOptions((prev) => ({ ...prev, importTopology: checked }))
                          }
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">Import program stubs</p>
                        <Switch
                          checked={isyMigrationOptions.importPrograms}
                          onCheckedChange={(checked) =>
                            setIsyMigrationOptions((prev) => ({ ...prev, importPrograms: checked }))
                          }
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">Enable imported workflow stubs</p>
                        <Switch
                          checked={isyMigrationOptions.enableProgramWorkflows}
                          onCheckedChange={(checked) =>
                            setIsyMigrationOptions((prev) => ({ ...prev, enableProgramWorkflows: checked }))
                          }
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">Continue on errors</p>
                        <Switch
                          checked={isyMigrationOptions.continueOnError}
                          onCheckedChange={(checked) =>
                            setIsyMigrationOptions((prev) => ({ ...prev, continueOnError: checked }))
                          }
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Device Link Mode</label>
                        <Select
                          value={isyMigrationOptions.linkMode}
                          onValueChange={(value) =>
                            setIsyMigrationOptions((prev) => ({
                              ...prev,
                              linkMode: value === "manual" ? "manual" : "remote"
                            }))
                          }
                        >
                          <SelectTrigger className="mt-1 h-8">
                            <SelectValue placeholder="Select link mode" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="remote">Remote</SelectItem>
                            <SelectItem value="manual">Manual (set-button)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Program import translates ISY IF/THEN/ELSE into executable HomeBrain workflows, including variable math, program-to-program control, repeat/timer logic, and REST/network-resource execution (native HTTP requests when possible). Imported programs run from unified condition edge-change evaluation to keep THEN/ELSE behavior aligned.
                    </p>
                  </div>

                  <div className="flex gap-2 flex-wrap">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleTestIsyConnection}
                      disabled={testingIsyConnection}
                    >
                      {testingIsyConnection ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Testing...
                        </>
                      ) : (
                        <>
                          <TestTube className="h-4 w-4 mr-2" />
                          Test ISY Connection
                        </>
                      )}
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleExtractIsyData}
                      disabled={extractingIsyData}
                    >
                      {extractingIsyData ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Extracting...
                        </>
                      ) : (
                        <>
                          <List className="h-4 w-4 mr-2" />
                          Extract Metadata
                        </>
                      )}
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handlePreviewIsyMigration}
                      disabled={previewingIsyMigration}
                    >
                      {previewingIsyMigration ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Previewing...
                        </>
                      ) : (
                        <>
                          <Activity className="h-4 w-4 mr-2" />
                          Preview Migration (Dry Run)
                        </>
                      )}
                    </Button>

                    <Button
                      type="button"
                      size="sm"
                      onClick={handleRunIsyMigration}
                      disabled={runningIsyMigration}
                      className="bg-violet-600 hover:bg-violet-700 text-white"
                    >
                      {runningIsyMigration ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                          Running...
                        </>
                      ) : (
                        <>
                          <ArrowUp className="h-4 w-4 mr-2" />
                          Run Migration
                        </>
                      )}
                    </Button>
                  </div>

                  {(runningIsyMigration || isyMigrationRunLogs.length > 0) && (
                    <div className="rounded-md border border-violet-200 bg-white/70 dark:bg-slate-900/40 p-3 text-xs space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">Migration run log</p>
                        <div className="flex items-center gap-2">
                          <p className="text-muted-foreground">
                            Status: {formatIsyRunStatusLabel(isyMigrationRunStatus)}
                            {isyMigrationRunId ? ` • Run ${isyMigrationRunId.slice(0, 8)}` : ""}
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={handleCopyIsyMigrationLogs}
                            disabled={isyMigrationRunLogs.length === 0}
                            className="h-7 px-2"
                          >
                            <Copy className="h-3.5 w-3.5 mr-1" />
                            Copy Logs
                          </Button>
                        </div>
                      </div>
                      <div className="max-h-64 overflow-y-auto rounded border border-violet-200/70 bg-slate-950/85 p-2 font-mono text-[11px] leading-5 text-slate-100 dark:border-violet-900/60">
                        {isyMigrationRunLogs.length > 0 ? (
                          isyMigrationRunLogs.map((entry, index) => {
                            const levelClass = entry?.level === "error"
                              ? "text-red-300"
                              : entry?.level === "warn"
                                ? "text-amber-300"
                                : "text-slate-100"

                            return (
                              <p key={`isy-migration-log-${index}`} className={levelClass}>
                                <span className="text-slate-400">
                                  [{entry?.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "--:--:--"}]
                                </span> {entry?.stage ? `[${entry.stage}] ` : ""}{entry?.message || "No message"}
                              </p>
                            )
                          })
                        ) : (
                          <p className="text-slate-400">Waiting for migration log output...</p>
                        )}
                      </div>
                      <p className="text-muted-foreground">
                        Log updates refresh every second while the migration run is active.
                      </p>
                    </div>
                  )}

                  {isyTestResult && (
                    <div className={`rounded-md border p-3 text-xs ${isyTestResult.success ? "border-green-200 bg-green-50/70 dark:border-green-900/60 dark:bg-green-900/20" : "border-red-200 bg-red-50/70 dark:border-red-900/60 dark:bg-red-900/20"}`}>
                      <p className="font-medium">
                        Connection test: {isyTestResult.success ? "success" : "failed"}
                      </p>
                      <p className="mt-1 text-muted-foreground">{isyTestResult.message || "No response message provided."}</p>
                    </div>
                  )}

                  {isyExtractionResult && (
                    <div className="rounded-md border border-violet-200 bg-white/70 dark:bg-slate-900/40 p-3 text-xs space-y-1">
                      <p className="font-medium">Latest extraction</p>
                      <p className="text-muted-foreground">
                        {isyExtractionResult?.counts?.uniqueDeviceIds ?? 0} INSTEON device IDs from {isyExtractionResult?.counts?.nodes ?? 0} ISY nodes, {isyExtractionResult?.counts?.topologyScenes ?? 0} scenes, {isyExtractionResult?.counts?.programs ?? 0} programs.
                      </p>
                      <p className="text-muted-foreground">
                        ISY endpoint: {isyExtractionResult?.connection?.host || "unknown"}:{isyExtractionResult?.connection?.port || "?"} ({isyExtractionResult?.connection?.useHttps ? "https" : "http"})
                      </p>
                    </div>
                  )}

                  {isyMigrationResult && (
                    <div className="rounded-md border border-violet-200 bg-white/70 dark:bg-slate-900/40 p-3 text-xs space-y-1">
                      <p className="font-medium">
                        Latest migration {isyMigrationResult?.dryRun ? "preview" : "run"}: {isyMigrationResult?.success === false ? "completed with errors" : "successful"}
                      </p>
                      <p className="text-muted-foreground">{isyMigrationResult?.message || "No summary message provided."}</p>
                      <p className="text-muted-foreground">
                        Extracted counts: {isyMigrationResult?.extractedCounts?.uniqueDeviceIds ?? 0} INSTEON device IDs from {isyMigrationResult?.extractedCounts?.nodes ?? 0} ISY nodes, {isyMigrationResult?.extractedCounts?.topologyScenes ?? 0} scenes, {isyMigrationResult?.extractedCounts?.programs ?? 0} programs.
                      </p>
                      {isyMigrationResult?.devices && (
                        <p className="text-muted-foreground">
                          Device replay: {isyMigrationResult.devices.accepted ?? 0} accepted, {isyMigrationResult.devices.linked ?? 0} linked, {isyMigrationResult.devices.failed ?? 0} failed.
                        </p>
                      )}
                      {isyMigrationResult?.topology && (
                        <p className="text-muted-foreground">
                          Topology replay: {isyMigrationResult.topology.sceneCount ?? 0} scenes, {isyMigrationResult.topology.appliedScenes ?? 0} applied, {isyMigrationResult.topology.skippedExistingScenes ?? 0} already in desired state, {isyMigrationResult.topology.failedScenes ?? 0} failed.
                        </p>
                      )}
                      {isyMigrationResult?.programs && (
                        <p className="text-muted-foreground">
                          Program stubs: {isyMigrationResult.programs.processed ?? 0} processed, {isyMigrationResult.programs.created ?? 0} created, {isyMigrationResult.programs.updated ?? 0} updated, {isyMigrationResult.programs.failed ?? 0} failed.
                        </p>
                      )}
                      {Array.isArray(isyMigrationResult?.errors) && isyMigrationResult.errors.length > 0 && (
                        <div className="pt-1 text-red-700 dark:text-red-300 space-y-1">
                          {isyMigrationResult.errors.map((error: any, index: number) => (
                            <p key={`isy-migration-error-${index}`}>
                              {(error?.stage || "stage").toString()}: {error?.error || "Unknown error"}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 dark:border-emerald-900/60 dark:bg-emerald-900/10 p-4 space-y-4">
                  <div className="flex items-center gap-2">
                    <Tv className="h-4 w-4 text-emerald-700" />
                    <div>
                      <p className="font-medium text-sm">Logitech Harmony Hub Integration</p>
                      <p className="text-xs text-muted-foreground">
                        {loadingHarmonyStatus
                          ? "Checking Harmony Hub status..."
                          : harmonyStatus
                            ? `${harmonyStatus.knownHubCount ?? harmonyStatus.discoveredCount ?? 0} hubs known, ${harmonyStatus.discoveredCount ?? 0} currently discovered, ${harmonyStatus.trackedDevices ?? 0} Harmony Hub activity devices tracked`
                            : "Status unavailable"}
                      </p>
                    </div>
                  </div>

                  <div>
                    <label className="text-sm font-medium">Configured Harmony Hub IPs/Hosts (optional)</label>
                    <Input
                      {...register("harmonyHubAddresses")}
                      placeholder="192.168.1.20, 192.168.1.21"
                      className="mt-1"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Comma-separated hub addresses to include during sync, useful when discovery is blocked by VLANs/firewalls.
                    </p>
                  </div>

                  <div className="flex gap-2 flex-wrap">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleDiscoverHarmony}
                      disabled={discoveringHarmony}
                    >
                      {discoveringHarmony ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Discovering...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Discover Hubs
                        </>
                      )}
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => loadHarmonyHubs({ includeCommands: false, showToast: true })}
                      disabled={loadingHarmonyHubs}
                    >
                      {loadingHarmonyHubs ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Loading...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Refresh Hub Details
                        </>
                      )}
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleSyncHarmonyDevices}
                      disabled={syncingHarmony}
                    >
                      {syncingHarmony ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Syncing...
                        </>
                      ) : (
                        <>
                          <Database className="h-4 w-4 mr-2" />
                          Sync Activities to Devices
                        </>
                      )}
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleSyncHarmonyState}
                      disabled={syncingHarmonyState}
                    >
                      {syncingHarmonyState ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Refreshing...
                        </>
                      ) : (
                        <>
                          <Activity className="h-4 w-4 mr-2" />
                          Refresh Activity State
                        </>
                      )}
                    </Button>
                  </div>

                  {harmonyHubs.length > 0 ? (
                    <div className="space-y-2">
                      {harmonyHubs.map((hub: any) => (
                        <div key={hub.ip} className="rounded border bg-white/70 dark:bg-slate-900/40 p-3">
                          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                            <div>
                              <p className="text-sm font-medium">{hub.friendlyName || hub.ip}</p>
                              <p className="text-xs text-muted-foreground">
                                {hub.ip}
                                {hub.success === false
                                  ? ` • ${hub.error || "Unavailable"}`
                                  : ` • Current activity: ${hub.currentActivityLabel || (hub.currentActivityId === "-1" ? "Off" : hub.currentActivityId || "Unknown")}`}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Activity devices: {hub.trackedActivityDevices ?? 0} tracked, {hub.onlineActivityDevices ?? 0} online, {hub.activeActivityDevices ?? 0} active
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Device sync: {(hub.lastDeviceSyncStatus || "unknown").toString().toUpperCase()} • {formatHarmonyTimestamp(hub.lastDeviceSyncAt)}
                              </p>
                              {hub.lastDeviceSyncStatus === "failed" && hub.lastDeviceSyncError && (
                                <p className="text-xs text-red-600 dark:text-red-400">
                                  Device sync error: {hub.lastDeviceSyncError}
                                </p>
                              )}
                              <p className="text-xs text-muted-foreground">
                                Activity state sync: {(hub.lastActivitySyncStatus || "unknown").toString().toUpperCase()} • {formatHarmonyTimestamp(hub.lastActivitySyncAt)}
                              </p>
                              {hub.lastActivitySyncStatus === "failed" && hub.lastActivitySyncError && (
                                <p className="text-xs text-red-600 dark:text-red-400">
                                  State sync error: {hub.lastActivitySyncError}
                                </p>
                              )}
                              <p className="text-xs text-muted-foreground">
                                Last seen: {formatHarmonyTimestamp(hub.lastSeenAt || hub.lastSeen)}
                              </p>
                            </div>
                            {hub.success !== false && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => handleHarmonyQuickOff(hub.ip)}
                                disabled={harmonyQuickActionKey === `${hub.ip}:off`}
                              >
                                {harmonyQuickActionKey === `${hub.ip}:off` ? "Turning off..." : "Turn Off"}
                              </Button>
                            )}
                          </div>
                          {hub.success !== false && Array.isArray(hub.activities) && hub.activities.length > 0 && (
                            <div className="mt-2 flex gap-2 flex-wrap">
                              {hub.activities.slice(0, 4).map((activity: any) => {
                                const key = `${hub.ip}:${activity.id}`
                                return (
                                  <Button
                                    key={key}
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => handleHarmonyQuickActivityStart(hub.ip, activity.id)}
                                    disabled={harmonyQuickActionKey === key}
                                  >
                                    {harmonyQuickActionKey === key ? "Starting..." : activity.label}
                                  </Button>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No Harmony Hub records yet. Use “Discover Hubs” to add and persist hubs here.
                    </p>
                  )}
                </div>
                <div className="space-y-4">
                  <div className="flex items-center gap-2 p-3 bg-blue-50/50 dark:bg-blue-950/20 rounded-lg border">
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
                        placeholder={isMaskedSecretPlaceholder(watch("smartthingsClientSecret")) ? "Client secret configured" : "Enter SmartThings Client Secret"}
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

                <div className="rounded-lg border border-dashed border-blue-200 bg-blue-50/40 dark:border-blue-900/50 dark:bg-blue-900/10 p-4 space-y-4">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h4 className="flex items-center gap-2 text-sm font-semibold">
                        <Shield className="h-4 w-4 text-blue-600" />
                        SmartThings Home Monitor Bridge
                      </h4>
                      <p className="text-xs text-muted-foreground mt-1">
                        Map SmartThings virtual switches so HomeBrain can read and control SmartThings Home Monitor (STHM).
                      </p>
                      {lastSthmState && (
                        <p className="text-xs text-muted-foreground mt-2">
                          Last known state:&nbsp;
                          <span className="font-medium text-foreground">{lastSthmState}</span>
                          {lastSthmUpdatedLabel ? ` — ${lastSthmUpdatedLabel}` : ""}
                        </p>
                      )}
                      {lastSthmCommandResult && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Last command:&nbsp;
                          <span className={`font-medium ${lastSthmCommandResult === 'success' ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                            {lastSthmCommandResult.toUpperCase()}
                          </span>
                          {lastSthmCommandState ? ` (${lastSthmCommandState})` : ""}
                          {lastSthmCommandAtLabel ? ` — ${lastSthmCommandAtLabel}` : ""}
                          {lastSthmCommandDeviceId ? ` — device ${lastSthmCommandDeviceId}` : ""}
                          {lastSthmCommandError ? ` — ${lastSthmCommandError}` : ""}
                        </p>
                      )}
                    </div>
                    <div className="mt-2 md:mt-0 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleRefreshSmartThingsDevices}
                        disabled={!smartthingsStatus?.isConnected || loadingSmartThingsDevices}
                      >
                        {loadingSmartThingsDevices ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                            Refreshing...
                          </>
                        ) : (
                          <>
                            <RefreshCw className="h-4 w-4 mr-2" />
                            Refresh Devices
                          </>
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleRunSthmDiagnostics}
                        disabled={!smartthingsStatus?.isConnected || runningSthmDiagnostics}
                      >
                        {runningSthmDiagnostics ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                            Running...
                          </>
                        ) : (
                          "Run Diagnostics"
                        )}
                      </Button>
                    </div>
                  </div>

                  <div className="bg-white/70 dark:bg-slate-900/40 border border-blue-100 dark:border-blue-900 rounded-md p-3 text-xs text-muted-foreground space-y-1">
                    <p className="font-medium text-blue-900 dark:text-blue-200">Setup checklist</p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>Create three SmartThings virtual switches named for Disarm, Arm Stay, and Arm Away.</li>
                      <li>
                        Make routines so changing STHM mode turns on its matching switch and turns the others off.
                      </li>
                      <li>
                        Create inverse routines so switching one of these devices on sets the corresponding STHM mode.
                      </li>
                      <li>Select the switches below and save to let HomeBrain mirror STHM status automatically.</li>
                    </ol>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Disarm Switch</label>
                      <Select
                        value={disarmSelectValue}
                        onValueChange={(value) =>
                          setSthmConfig((prev) => ({
                            ...prev,
                            disarmDeviceId: value === STHM_NOT_CONFIGURED ? "" : value
                          }))
                        }
                        disabled={!smartthingsStatus?.isConnected || loadingSmartThingsDevices || switchDevices.length === 0}
                      >
                        <SelectTrigger className="mt-1">
                          <SelectValue placeholder={smartthingsStatus?.isConnected ? "Select virtual switch" : "Connect SmartThings first"} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={STHM_NOT_CONFIGURED}>Not configured</SelectItem>
                          {switchDevices.map((device: any) => (
                            <SelectItem key={device.deviceId} value={device.deviceId}>
                              {getDeviceDisplayName(device)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Link to the switch that turns on when STHM is disarmed.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">Arm Stay Switch</label>
                      <Select
                        value={armStaySelectValue}
                        onValueChange={(value) =>
                          setSthmConfig((prev) => ({
                            ...prev,
                            armStayDeviceId: value === STHM_NOT_CONFIGURED ? "" : value
                          }))
                        }
                        disabled={!smartthingsStatus?.isConnected || loadingSmartThingsDevices || switchDevices.length === 0}
                      >
                        <SelectTrigger className="mt-1">
                          <SelectValue placeholder={smartthingsStatus?.isConnected ? "Select virtual switch" : "Connect SmartThings first"} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={STHM_NOT_CONFIGURED}>Not configured</SelectItem>
                          {switchDevices.map((device: any) => (
                            <SelectItem key={device.deviceId} value={device.deviceId}>
                              {getDeviceDisplayName(device)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Link to the switch that should be on while STHM is Armed (Stay).
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">Arm Away Switch</label>
                      <Select
                        value={armAwaySelectValue}
                        onValueChange={(value) =>
                          setSthmConfig((prev) => ({
                            ...prev,
                            armAwayDeviceId: value === STHM_NOT_CONFIGURED ? "" : value
                          }))
                        }
                        disabled={!smartthingsStatus?.isConnected || loadingSmartThingsDevices || switchDevices.length === 0}
                      >
                        <SelectTrigger className="mt-1">
                          <SelectValue placeholder={smartthingsStatus?.isConnected ? "Select virtual switch" : "Connect SmartThings first"} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={STHM_NOT_CONFIGURED}>Not configured</SelectItem>
                          {switchDevices.map((device: any) => (
                            <SelectItem key={device.deviceId} value={device.deviceId}>
                              {getDeviceDisplayName(device)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Link to the switch that should be on while STHM is Armed (Away).
                      </p>
                    </div>

                    <div className="space-y-2 md:col-span-2">
                      <label className="text-sm font-medium">SmartThings Location ID (optional)</label>
                      <Input
                        value={sthmConfig.locationId}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                          setSthmConfig((prev) => ({ ...prev, locationId: event.target.value }))
                        }
                        placeholder="Auto-detected from selected switches"
                        disabled={!smartthingsStatus?.isConnected}
                      />
                      <p className="text-xs text-muted-foreground">
                        Leave blank to allow HomeBrain to infer the location from the mapped switches.
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      Save after updating switch mappings so security status stays in sync.
                    </p>
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      onClick={handleSaveSthmConfig}
                      disabled={!smartthingsStatus?.isConnected || !allSthmSwitchesSelected || savingSthmConfig}
                      className="bg-blue-600 hover:bg-blue-700 text-white"
                    >
                      {savingSthmConfig ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <Shield className="h-4 w-4 mr-2" />
                          Save STHM Mapping
                        </>
                      )}
                    </Button>
                  </div>

                  {sthmDiagnostics && (
                    <div className="bg-white/70 dark:bg-slate-900/40 border border-blue-100 dark:border-blue-900 rounded-md p-3 text-xs space-y-2">
                      <p className="font-medium text-blue-900 dark:text-blue-200">Latest diagnostics</p>
                      <p className="text-muted-foreground">
                        Generated: {sthmDiagnostics.generatedAt ? new Date(sthmDiagnostics.generatedAt).toLocaleString() : "Unknown"}
                      </p>
                      {typeof sthmDiagnostics?.tookMs === "number" && (
                        <p className="text-muted-foreground">
                          Diagnostics time: {Math.round(sthmDiagnostics.tookMs)}ms
                        </p>
                      )}
                      {sthmDiagnostics?.fallback && (
                        <p className="text-red-700 dark:text-red-300">
                          Fallback mode: {sthmDiagnostics?.error || "Diagnostics probe failed"}
                        </p>
                      )}
                      <p className="text-muted-foreground">
                        Resolved security state:{" "}
                        <span className="font-medium text-foreground">
                          {sthmDiagnostics?.resolvedSecurityState?.armState || "Unknown"}
                        </span>
                        {sthmDiagnostics?.resolvedSecurityState?.source ? ` via ${sthmDiagnostics.resolvedSecurityState.source}` : ""}
                        {sthmDiagnostics?.resolvedSecurityState?.error ? ` (error: ${sthmDiagnostics.resolvedSecurityState.error})` : ""}
                      </p>
                      <p className="text-muted-foreground">
                        Auth mode:{" "}
                        <span className="font-medium text-foreground">{sthmDiagnostics?.auth?.mode || "unknown"}</span>
                        {typeof sthmDiagnostics?.auth?.canIssueCommands === "boolean"
                          ? ` (${sthmDiagnostics.auth.canIssueCommands ? "commands enabled" : "commands blocked"})`
                          : ""}
                      </p>
                      <div className="space-y-1 text-muted-foreground">
                        <p>
                          Disarm switch:{" "}
                          <span className="font-medium text-foreground">
                            {sthmDiagnostics?.switchStatuses?.disarm?.switchState || "unknown"}
                          </span>
                          {sthmDiagnostics?.switchStatuses?.disarm?.error ? ` (error: ${sthmDiagnostics.switchStatuses.disarm.error})` : ""}
                        </p>
                        <p>
                          Arm Stay switch:{" "}
                          <span className="font-medium text-foreground">
                            {sthmDiagnostics?.switchStatuses?.armStay?.switchState || "unknown"}
                          </span>
                          {sthmDiagnostics?.switchStatuses?.armStay?.error ? ` (error: ${sthmDiagnostics.switchStatuses.armStay.error})` : ""}
                        </p>
                        <p>
                          Arm Away switch:{" "}
                          <span className="font-medium text-foreground">
                            {sthmDiagnostics?.switchStatuses?.armAway?.switchState || "unknown"}
                          </span>
                          {sthmDiagnostics?.switchStatuses?.armAway?.error ? ` (error: ${sthmDiagnostics.switchStatuses.armAway.error})` : ""}
                        </p>
                      </div>
                      {Array.isArray(sthmDiagnostics?.trace) && sthmDiagnostics.trace.length > 0 && (
                        <div className="pt-1 space-y-1 text-[11px] text-muted-foreground">
                          <p className="font-medium text-blue-900 dark:text-blue-200">Trace</p>
                          {sthmDiagnostics.trace.slice(-8).map((entry: any, index: number) => {
                            const details = Object.entries(entry || {})
                              .filter(([key]) => key !== "at" && key !== "event")
                              .map(([key, value]) => `${key}=${String(value)}`)
                              .join(" ");
                            return (
                              <p key={`sthm-trace-${index}`}>
                                [{entry?.at ? new Date(entry.at).toLocaleTimeString() : "?"}] {entry?.event || "event"}
                                {details ? ` ${details}` : ""}
                              </p>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {!smartthingsStatus?.isConnected && (
                    <p className="text-xs text-muted-foreground">
                      Connect SmartThings and run a device sync to populate available virtual switches.
                    </p>
                  )}
                  {smartthingsStatus?.isConnected && switchDevices.length === 0 && !loadingSmartThingsDevices && (
                    <p className="text-xs text-yellow-700 dark:text-yellow-300">
                      No switch-capable devices found yet. Create your virtual switches in SmartThings and click “Refresh Devices”.
                    </p>
                  )}
                </div>

              </div>
            </div>
          </CardContent>
        </Card>

            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Home className="h-5 w-5 text-orange-600" />
                  Ecobee Integration
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-2 p-3 bg-orange-50/50 dark:bg-orange-950/20 rounded-lg border">
                  {getEcobeeStatusIcon()}
                  <div>
                    <p className="font-medium text-sm">Ecobee Integration Status</p>
                    <p className="text-xs text-muted-foreground">{getEcobeeStatusText()}</p>
                    {ecobeeStatus?.isConnected && (
                      <p className="text-xs text-green-600">
                        {ecobeeThermostatCount} thermostat{ecobeeThermostatCount === 1 ? "" : "s"} and {ecobeeSensorCount} sensor{ecobeeSensorCount === 1 ? "" : "s"} synced
                      </p>
                    )}
                  </div>
                </div>

                <div className="grid gap-4">
                  <div>
                    <label className="text-sm font-medium">Ecobee App Key</label>
                    <Input
                      value={ecobeeConfig.clientId}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        setEcobeeConfig((prev) => ({ ...prev, clientId: event.target.value }))
                      }
                      placeholder="Enter Ecobee App Key"
                      className="mt-1"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      App Key from your Ecobee developer application.
                    </p>
                  </div>

                  <div>
                    <label className="text-sm font-medium">Redirect URI (Optional)</label>
                    <Input
                      value={ecobeeConfig.redirectUri}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        setEcobeeConfig((prev) => ({ ...prev, redirectUri: event.target.value }))
                      }
                      placeholder="https://yourdomain.com/api/ecobee/callback"
                      className="mt-1"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Custom redirect URI (defaults to current domain + /api/ecobee/callback).
                    </p>
                  </div>

                  <div className="flex gap-2 flex-wrap">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleConfigureEcobee}
                      disabled={configuringEcobee || !ecobeeConfig.clientId.trim()}
                    >
                      {configuringEcobee ? (
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

                    {ecobeeStatus?.isConfigured && !ecobeeStatus?.isConnected && (
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={handleConnectEcobee}
                        className="bg-green-600 hover:bg-green-700"
                      >
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Connect Ecobee
                      </Button>
                    )}

                    {ecobeeStatus?.isConnected && (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleTestEcobee}
                          disabled={testingEcobee}
                        >
                          {testingEcobee ? (
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
                          variant="outline"
                          size="sm"
                          onClick={handleRefreshEcobeeDevices}
                          disabled={loadingEcobeeDevices}
                        >
                          {loadingEcobeeDevices ? (
                            <>
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                              Refreshing...
                            </>
                          ) : (
                            <>
                              <RefreshCw className="h-4 w-4 mr-2" />
                              Refresh Devices
                            </>
                          )}
                        </Button>

                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={handleDisconnectEcobee}
                          disabled={disconnectingEcobee}
                        >
                          {disconnectingEcobee ? (
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
                      <strong>OAuth Setup Required:</strong> Create an Ecobee developer application, enter the App Key above, configure the redirect URI to this server callback, then connect your account.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
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
                      placeholder={isMaskedSecretPlaceholder(watch("elevenlabsApiKey")) ? "API key configured" : "Enter ElevenLabs API key"}
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

            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
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
                <div className="space-y-4 p-4 border rounded-lg bg-blue-50/50 dark:bg-blue-950/20">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-blue-600" />
                    <h4 className="font-medium text-blue-900 dark:text-blue-100">OpenAI Configuration</h4>
                  </div>
                  
                  <div>
                    <label className="text-sm font-medium">OpenAI API Key</label>
                    <div className="flex gap-2 mt-1">
                      <Input
                        {...register("openaiApiKey")}
                        type="password"
                        placeholder={isMaskedSecretPlaceholder(watch("openaiApiKey")) ? "API key configured" : "Enter OpenAI API key"}
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
                        {openaiLlmModelPresets.map((modelName) => (
                          <SelectItem key={modelName} value={modelName}>{modelName}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      className="mt-2"
                      value={watch("openaiModel") || ""}
                      onChange={(event) => setValue("openaiModel", event.target.value)}
                      placeholder="Or enter any OpenAI model ID (e.g., gpt-5.2-codex)"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Pick a preset or type any OpenAI model ID for newer releases.
                    </p>
                  </div>
                </div>

                {/* Anthropic Settings */}
                <div className="space-y-4 p-4 border rounded-lg bg-orange-50/50 dark:bg-orange-950/20">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-orange-600" />
                    <h4 className="font-medium text-orange-900 dark:text-orange-100">Anthropic Configuration</h4>
                  </div>
                  
                  <div>
                    <label className="text-sm font-medium">Anthropic API Key</label>
                    <div className="flex gap-2 mt-1">
                      <Input
                        {...register("anthropicApiKey")}
                        type="password"
                        placeholder={isMaskedSecretPlaceholder(watch("anthropicApiKey")) ? "API key configured" : "Enter Anthropic API key"}
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
                <div className="space-y-4 p-4 border rounded-lg bg-green-50/50 dark:bg-green-950/20">
                  <div className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-green-600" />
                    <h4 className="font-medium text-green-900 dark:text-green-100">Local LLM Configuration</h4>
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

            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <List className="h-5 w-5 text-indigo-600" />
                  LLM Priority List
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Configure the order in which LLM providers are tried when processing voice commands.
                  The system will attempt to use providers from top to bottom. If a provider fails or is not configured,
                  it will automatically fall back to the next one in the list.
                </p>

                <div className="space-y-2">
                  {llmPriorityList.map((provider, index) => (
                    <div
                      key={provider}
                      className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-white dark:bg-gray-700 border-2 border-gray-300 dark:border-gray-600">
                          <span className="text-sm font-bold text-gray-600 dark:text-gray-300">{index + 1}</span>
                        </div>
                        {getProviderIcon(provider)}
                        <div>
                          <p className="font-medium">{getProviderDisplayName(provider)}</p>
                          <p className="text-xs text-muted-foreground">
                            {index === 0 ? 'Primary provider' : index === 1 ? 'First fallback' : 'Second fallback'}
                          </p>
                        </div>
                      </div>

                      <div className="flex gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => movePriorityUp(index)}
                          disabled={index === 0}
                          className="h-8 w-8 p-0"
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => movePriorityDown(index)}
                          disabled={index === llmPriorityList.length - 1}
                          className="h-8 w-8 p-0"
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex justify-end pt-4">
                  <Button
                    type="button"
                    onClick={handleSavePriorityList}
                    disabled={savingPriority}
                    variant="outline"
                    className="gap-2"
                  >
                    {savingPriority ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="h-4 w-4" />
                        Save Priority List
                      </>
                    )}
                  </Button>
                </div>

                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                  <p className="text-sm text-blue-800 dark:text-blue-200">
                    <strong>How it works:</strong> When processing a voice command or automation, the system will try each
                    provider in order. If the primary provider is unavailable or returns an error, it automatically falls
                    back to the next provider in the list. This ensures your system remains operational even if one provider
                    has issues.
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="security" className="space-y-6">
            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
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

          <TabsContent value="resources" className="space-y-6">
            <SettingsResourceUtilizationTab />
          </TabsContent>

          <TabsContent value="maintenance" className="space-y-6">
            {/* Data Management Section */}
            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
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
            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
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

                {/* Harmony Operations */}
                <div className="space-y-4">
                  <h4 className="font-medium text-emerald-600">Harmony Hub Operations</h4>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleSyncHarmonyMaintenance}
                      disabled={syncingHarmony}
                      className="w-full"
                    >
                      {syncingHarmony ? (
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
                      onClick={handleClearHarmonyDevices}
                      disabled={clearingHarmonyDevices}
                      className="w-full"
                    >
                      {clearingHarmonyDevices ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                          Clearing...
                        </>
                      ) : (
                        <>
                          <Trash2 className="h-4 w-4 mr-2" />
                          Clear Harmony Activity Devices
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
            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
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
            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
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
                  <div className="mt-4 p-4 bg-gray-50 dark:bg-gray-900/30 rounded-lg border">
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
                          <li>Harmony: {healthData.integrations?.harmony?.trackedDevices || 0} tracked activity devices</li>
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
