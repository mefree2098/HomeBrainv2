import { useCallback, useEffect, useMemo, useState } from "react";
import { AxiosError } from "axios";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Network,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Terminal,
  Wifi,
  Zap
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/useToast";
import {
  MqttManagementResponse,
  PiholeManagementResponse,
  ensurePiholeRoute,
  getMqttManagement,
  getPiholeManagement,
  publishMqttTest,
  runPiholeGravity,
  updateMqttConfig,
  updatePiholeConfig
} from "@/api/platformServiceManagement";
import {
  PlatformService,
  checkPlatformServiceUpdates,
  getPlatformServices,
  installPlatformService,
  runPlatformServicePolicy,
  updatePlatformService,
  updatePlatformServicePolicy
} from "@/api/platformServices";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

type MqttFormState = {
  mode: string;
  protocol: string;
  host: string;
  port: string;
  topicPrefix: string;
  clientId: string;
  username: string;
  password: string;
  keepaliveSeconds: string;
  connectTimeoutMs: string;
  reconnectMs: string;
};

type PiholeFormState = {
  webPort: string;
  webTlsPort: string;
  adminHostname: string;
  adminRouteEnabled: boolean;
  dynamicDnsEnabled: boolean;
  applyRouteOnSave: boolean;
};

type PolicyFormState = {
  autoCheckEnabled: boolean;
  autoUpdateEnabled: boolean;
  checkIntervalDays: string;
  stabilityDelayDays: string;
};

const emptyMqttForm: MqttFormState = {
  mode: "auto",
  protocol: "mqtt",
  host: "127.0.0.1",
  port: "1883",
  topicPrefix: "homebrain",
  clientId: "",
  username: "",
  password: "",
  keepaliveSeconds: "60",
  connectTimeoutMs: "3000",
  reconnectMs: "15000"
};

const emptyPiholeForm: PiholeFormState = {
  webPort: "8081",
  webTlsPort: "8444",
  adminHostname: "",
  adminRouteEnabled: false,
  dynamicDnsEnabled: true,
  applyRouteOnSave: false
};

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error && typeof error === "object") {
    const axiosError = error as AxiosError<{ message?: string }>;
    const responseMessage = axiosError.response?.data?.message;
    if (typeof responseMessage === "string" && responseMessage.trim()) {
      return responseMessage;
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
};

const formatTimestamp = (value?: string | null) => {
  if (!value) {
    return "unknown";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString();
};

const toInputNumber = (value: string, fallback: number) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const getStatusVariant = (value?: string | boolean | null): BadgeVariant => {
  if (value === true) {
    return "secondary";
  }
  if (value === false) {
    return "destructive";
  }
  const normalized = String(value || "").toLowerCase();
  if (["healthy", "active", "success", "valid", "configured", "connected", "enabled", "ready"].includes(normalized)) {
    return "secondary";
  }
  if (["degraded", "failed", "missing", "error", "inactive", "disabled", "unavailable"].includes(normalized)) {
    return "destructive";
  }
  return "outline";
};

const hydrateMqttForm = (data: MqttManagementResponse | null): MqttFormState => {
  const config = data?.config;
  if (!config) {
    return emptyMqttForm;
  }
  return {
    mode: config.mode || "auto",
    protocol: config.protocol || "mqtt",
    host: config.host || "127.0.0.1",
    port: String(config.port || 1883),
    topicPrefix: config.topicPrefix || "homebrain",
    clientId: config.clientId || "",
    username: config.username || "",
    password: "",
    keepaliveSeconds: String(config.keepaliveSeconds || 60),
    connectTimeoutMs: String(config.connectTimeoutMs || 3000),
    reconnectMs: String(config.reconnectMs || 15000)
  };
};

const hydratePiholeForm = (data: PiholeManagementResponse | null): PiholeFormState => {
  const config = data?.config;
  if (!config) {
    return emptyPiholeForm;
  }
  return {
    webPort: String(config.webPort || 8081),
    webTlsPort: String(config.webTlsPort || 8444),
    adminHostname: config.adminHostname || config.suggestedAdminHostname || "",
    adminRouteEnabled: config.adminRouteEnabled === true,
    dynamicDnsEnabled: config.dynamicDnsEnabled !== false,
    applyRouteOnSave: config.applyRouteOnSave === true
  };
};

const hydratePolicies = (services: PlatformService[]) => {
  return services.reduce<Record<string, PolicyFormState>>((acc, service) => {
    acc[service.serviceId] = {
      autoCheckEnabled: service.policy.autoCheckEnabled !== false,
      autoUpdateEnabled: service.policy.autoUpdateEnabled === true,
      checkIntervalDays: String(service.policy.checkIntervalDays || 7),
      stabilityDelayDays: String(service.policy.stabilityDelayDays || 30)
    };
    return acc;
  }, {});
};

const summarizeValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") {
    return "none";
  }
  if (typeof value === "number") {
    return value.toLocaleString();
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
};

export function PlatformServices() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("updates");
  const [services, setServices] = useState<PlatformService[]>([]);
  const [mqtt, setMqtt] = useState<MqttManagementResponse | null>(null);
  const [pihole, setPihole] = useState<PiholeManagementResponse | null>(null);
  const [mqttForm, setMqttForm] = useState<MqttFormState>(emptyMqttForm);
  const [piholeForm, setPiholeForm] = useState<PiholeFormState>(emptyPiholeForm);
  const [policyForms, setPolicyForms] = useState<Record<string, PolicyFormState>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [serviceAction, setServiceAction] = useState("");
  const [savingMqtt, setSavingMqtt] = useState(false);
  const [publishingMqtt, setPublishingMqtt] = useState(false);
  const [savingPihole, setSavingPihole] = useState(false);
  const [ensuringRoute, setEnsuringRoute] = useState("");
  const [updatingGravity, setUpdatingGravity] = useState(false);
  const [testTopic, setTestTopic] = useState("diagnostics/test");
  const [testMessage, setTestMessage] = useState("HomeBrain MQTT test");
  const [testQos, setTestQos] = useState("0");
  const [testRetain, setTestRetain] = useState(false);

  const refreshAll = useCallback(async (silent = false) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const [serviceResult, mqttResult, piholeResult] = await Promise.all([
        getPlatformServices(),
        getMqttManagement(),
        getPiholeManagement()
      ]);
      setServices(serviceResult.services);
      setPolicyForms(hydratePolicies(serviceResult.services));
      setMqtt(mqttResult);
      setMqttForm(hydrateMqttForm(mqttResult));
      setPihole(piholeResult);
      setPiholeForm(hydratePiholeForm(piholeResult));
    } catch (error) {
      toast({
        title: "Platform services unavailable",
        description: getErrorMessage(error, "Unable to load managed service state."),
        variant: "destructive"
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    void refreshAll(false);
  }, [refreshAll]);

  const summaryStats = useMemo(() => {
    const installed = services.filter((service) => service.installed).length;
    const active = services.filter((service) => service.active).length;
    const updates = services.filter((service) => service.updateAvailable).length;
    return { installed, active, updates };
  }, [services]);

  const updateServiceInState = (nextService: PlatformService) => {
    setServices((current) => current.map((service) => (
      service.serviceId === nextService.serviceId ? nextService : service
    )));
    setPolicyForms((current) => ({
      ...current,
      ...hydratePolicies([nextService])
    }));
  };

  const runServiceAction = async (
    actionKey: string,
    fallback: string,
    action: () => Promise<{ service: PlatformService }>
  ) => {
    setServiceAction(actionKey);
    try {
      const result = await action();
      updateServiceInState(result.service);
      toast({
        title: "Service updated",
        description: `${result.service.displayName} is current in HomeBrain.`
      });
    } catch (error) {
      toast({
        title: "Service action failed",
        description: getErrorMessage(error, fallback),
        variant: "destructive"
      });
    } finally {
      setServiceAction("");
    }
  };

  const handleRunPolicy = async () => {
    setServiceAction("policy:run");
    try {
      const result = await runPlatformServicePolicy();
      await refreshAll(true);
      toast({
        title: "Update policy checked",
        description: `Checked ${result.checked.length} service(s); updated ${result.updated.length}.`
      });
    } catch (error) {
      toast({
        title: "Policy run failed",
        description: getErrorMessage(error, "Unable to run platform service update policy."),
        variant: "destructive"
      });
    } finally {
      setServiceAction("");
    }
  };

  const handleSavePolicy = async (service: PlatformService) => {
    const form = policyForms[service.serviceId];
    if (!form) {
      return;
    }
    await runServiceAction(
      `${service.serviceId}:policy`,
      `Unable to save ${service.displayName} update policy.`,
      async () => updatePlatformServicePolicy(service.serviceId, {
        autoCheckEnabled: form.autoCheckEnabled,
        autoUpdateEnabled: form.autoUpdateEnabled,
        checkIntervalDays: toInputNumber(form.checkIntervalDays, service.policy.checkIntervalDays || 7),
        stabilityDelayDays: toInputNumber(form.stabilityDelayDays, service.policy.stabilityDelayDays || 30)
      })
    );
  };

  const handleSaveMqtt = async () => {
    setSavingMqtt(true);
    try {
      const payload: Parameters<typeof updateMqttConfig>[0] = {
        mode: mqttForm.mode,
        protocol: mqttForm.protocol,
        host: mqttForm.host,
        port: toInputNumber(mqttForm.port, 1883),
        topicPrefix: mqttForm.topicPrefix,
        clientId: mqttForm.clientId,
        username: mqttForm.username,
        keepaliveSeconds: toInputNumber(mqttForm.keepaliveSeconds, 60),
        connectTimeoutMs: toInputNumber(mqttForm.connectTimeoutMs, 3000),
        reconnectMs: toInputNumber(mqttForm.reconnectMs, 15000)
      };
      if (mqttForm.password.trim()) {
        payload.password = mqttForm.password;
      }
      const result = await updateMqttConfig(payload);
      setMqtt(result);
      setMqttForm(hydrateMqttForm(result));
      toast({
        title: "MQTT settings saved",
        description: "HomeBrain reloaded the broker bridge configuration."
      });
    } catch (error) {
      toast({
        title: "MQTT settings failed",
        description: getErrorMessage(error, "Unable to save MQTT broker settings."),
        variant: "destructive"
      });
    } finally {
      setSavingMqtt(false);
    }
  };

  const handlePublishMqtt = async () => {
    setPublishingMqtt(true);
    try {
      const result = await publishMqttTest({
        topic: testTopic,
        message: testMessage,
        qos: testQos === "1" ? 1 : 0,
        retain: testRetain
      });
      const nextMqtt = await getMqttManagement();
      setMqtt(nextMqtt);
      setMqttForm(hydrateMqttForm(nextMqtt));
      toast({
        title: result.result.success ? "MQTT test published" : "MQTT test skipped",
        description: result.result.success ? result.result.topic : (result.result.reason || result.result.error || "Broker is not connected.")
      });
    } catch (error) {
      toast({
        title: "MQTT publish failed",
        description: getErrorMessage(error, "Unable to publish a test message."),
        variant: "destructive"
      });
    } finally {
      setPublishingMqtt(false);
    }
  };

  const handleSavePihole = async () => {
    setSavingPihole(true);
    try {
      const result = await updatePiholeConfig({
        webPort: toInputNumber(piholeForm.webPort, 8081),
        webTlsPort: toInputNumber(piholeForm.webTlsPort, 8444),
        adminHostname: piholeForm.adminHostname,
        adminRouteEnabled: piholeForm.adminRouteEnabled,
        dynamicDnsEnabled: piholeForm.dynamicDnsEnabled,
        applyRouteOnSave: piholeForm.applyRouteOnSave
      });
      setPihole(result);
      setPiholeForm(hydratePiholeForm(result));
      toast({
        title: "Pi-hole settings saved",
        description: "HomeBrain refreshed the managed admin route state."
      });
    } catch (error) {
      toast({
        title: "Pi-hole settings failed",
        description: getErrorMessage(error, "Unable to save Pi-hole management settings."),
        variant: "destructive"
      });
    } finally {
      setSavingPihole(false);
    }
  };

  const handleEnsurePiholeRoute = async (apply: boolean) => {
    setEnsuringRoute(apply ? "apply" : "ensure");
    try {
      await ensurePiholeRoute({ apply });
      const result = await getPiholeManagement();
      setPihole(result);
      setPiholeForm(hydratePiholeForm(result));
      toast({
        title: apply ? "Pi-hole route applied" : "Pi-hole route saved",
        description: result.route?.hostname || "Managed route state refreshed."
      });
    } catch (error) {
      toast({
        title: "Pi-hole route failed",
        description: getErrorMessage(error, "Unable to ensure the Pi-hole reverse proxy route."),
        variant: "destructive"
      });
    } finally {
      setEnsuringRoute("");
    }
  };

  const handleRunGravity = async () => {
    setUpdatingGravity(true);
    try {
      const result = await runPiholeGravity();
      setPihole(result);
      setPiholeForm(hydratePiholeForm(result));
      toast({
        title: "Pi-hole gravity updated",
        description: "Pi-hole refreshed its blocklist database."
      });
    } catch (error) {
      toast({
        title: "Gravity update failed",
        description: getErrorMessage(error, "Unable to update Pi-hole gravity."),
        variant: "destructive"
      });
    } finally {
      setUpdatingGravity(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading platform services
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="section-kicker">Platform Services</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Managed Third-Party Services</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Caddy, Mosquitto MQTT, and Pi-hole lifecycle controls with service-specific runtime management.
          </p>
        </div>
        <Button variant="outline" onClick={() => refreshAll(true)} disabled={refreshing}>
          {refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4" />
              Installed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{summaryStats.installed}/{services.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="h-4 w-4" />
              Active
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{summaryStats.active}/{services.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Wifi className="h-4 w-4" />
              MQTT
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={getStatusVariant(mqtt?.status.status)}>{mqtt?.status.status || "unknown"}</Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Network className="h-4 w-4" />
              Pi-hole Route
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={getStatusVariant(pihole?.routing.routeStatus)}>{pihole?.routing.routeStatus || "missing"}</Badge>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex flex-wrap justify-start">
          <TabsTrigger value="updates">Updates</TabsTrigger>
          <TabsTrigger value="mqtt">MQTT Broker</TabsTrigger>
          <TabsTrigger value="pihole">Pi-hole DNS</TabsTrigger>
        </TabsList>

        <TabsContent value="updates" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <CardTitle>Service Updates</CardTitle>
                <CardDescription>
                  Check, stage, and apply managed package updates with per-service stability windows.
                </CardDescription>
              </div>
              <Button onClick={handleRunPolicy} disabled={serviceAction === "policy:run"}>
                {serviceAction === "policy:run" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Zap className="mr-2 h-4 w-4" />}
                Run Policy
              </Button>
            </CardHeader>
            <CardContent>
              <Table className="min-w-[76rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Service</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Update</TableHead>
                    <TableHead>Auto Check</TableHead>
                    <TableHead>Auto Deploy</TableHead>
                    <TableHead>Cadence</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {services.map((service) => {
                    const policyForm = policyForms[service.serviceId];
                    const busyPrefix = `${service.serviceId}:`;
                    const isBusy = serviceAction.startsWith(busyPrefix);
                    return (
                      <TableRow key={service.serviceId}>
                        <TableCell className="min-w-56">
                          <div className="font-medium">{service.displayName}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{service.managementNotes}</div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Badge variant={getStatusVariant(service.installed)}>
                              {service.installed ? "installed" : "missing"}
                            </Badge>
                            <Badge variant={getStatusVariant(service.active)}>
                              {service.active ? "active" : "inactive"}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell className="min-w-52">
                          <div className="font-mono text-xs">{service.currentVersion || "unknown"}</div>
                          {service.latestVersion ? (
                            <div className="mt-1 text-xs text-muted-foreground">Latest: {service.latestVersion}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="min-w-52">
                          <Badge variant={service.updateAvailable ? "default" : "outline"}>
                            {service.updateAvailable ? "available" : "current"}
                          </Badge>
                          {service.eligibleForAutoUpdateAt ? (
                            <div className="mt-2 text-xs text-muted-foreground">
                              Eligible {formatTimestamp(service.eligibleForAutoUpdateAt)}
                            </div>
                          ) : null}
                          {service.lastError ? (
                            <div className="mt-2 text-xs text-red-600">{service.lastError}</div>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={policyForm?.autoCheckEnabled ?? true}
                            onCheckedChange={(checked) => setPolicyForms((current) => ({
                              ...current,
                              [service.serviceId]: {
                                ...(current[service.serviceId] || hydratePolicies([service])[service.serviceId]),
                                autoCheckEnabled: checked
                              }
                            }))}
                            aria-label={`Toggle automatic update checks for ${service.displayName}`}
                          />
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={policyForm?.autoUpdateEnabled ?? false}
                            onCheckedChange={(checked) => setPolicyForms((current) => ({
                              ...current,
                              [service.serviceId]: {
                                ...(current[service.serviceId] || hydratePolicies([service])[service.serviceId]),
                                autoUpdateEnabled: checked
                              }
                            }))}
                            aria-label={`Toggle automatic update deployment for ${service.displayName}`}
                          />
                        </TableCell>
                        <TableCell className="min-w-56">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <Label htmlFor={`${service.serviceId}-check-days`} className="text-xs">Check days</Label>
                              <Input
                                id={`${service.serviceId}-check-days`}
                                value={policyForm?.checkIntervalDays || "7"}
                                onChange={(event) => setPolicyForms((current) => ({
                                  ...current,
                                  [service.serviceId]: {
                                    ...(current[service.serviceId] || hydratePolicies([service])[service.serviceId]),
                                    checkIntervalDays: event.target.value
                                  }
                                }))}
                                inputMode="numeric"
                              />
                            </div>
                            <div>
                              <Label htmlFor={`${service.serviceId}-stable-days`} className="text-xs">Stable days</Label>
                              <Input
                                id={`${service.serviceId}-stable-days`}
                                value={policyForm?.stabilityDelayDays || "30"}
                                onChange={(event) => setPolicyForms((current) => ({
                                  ...current,
                                  [service.serviceId]: {
                                    ...(current[service.serviceId] || hydratePolicies([service])[service.serviceId]),
                                    stabilityDelayDays: event.target.value
                                  }
                                }))}
                                inputMode="numeric"
                              />
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="min-w-72 text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            {!service.installed ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => runServiceAction(
                                  `${service.serviceId}:install`,
                                  `Unable to install ${service.displayName}.`,
                                  async () => installPlatformService(service.serviceId)
                                )}
                                disabled={isBusy}
                              >
                                {serviceAction === `${service.serviceId}:install` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                                Install
                              </Button>
                            ) : null}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => runServiceAction(
                                `${service.serviceId}:check`,
                                `Unable to check ${service.displayName} updates.`,
                                async () => checkPlatformServiceUpdates(service.serviceId)
                              )}
                              disabled={isBusy}
                            >
                              {serviceAction === `${service.serviceId}:check` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                              Check
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleSavePolicy(service)}
                              disabled={isBusy}
                            >
                              {serviceAction === `${service.serviceId}:policy` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                              Save
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => runServiceAction(
                                `${service.serviceId}:update`,
                                `Unable to update ${service.displayName}.`,
                                async () => updatePlatformService(service.serviceId)
                              )}
                              disabled={isBusy || !service.installed}
                            >
                              {serviceAction === `${service.serviceId}:update` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Zap className="mr-2 h-4 w-4" />}
                              Update
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="mqtt" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <Card>
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Wifi className="h-5 w-5" />
                      MQTT Broker
                    </CardTitle>
                    <CardDescription>{mqtt?.status.message || "MQTT runtime status is unavailable."}</CardDescription>
                  </div>
                  <Badge variant={getStatusVariant(mqtt?.status.status)}>{mqtt?.status.status || "unknown"}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="mqtt-mode">Mode</Label>
                    <Select value={mqttForm.mode} onValueChange={(value) => setMqttForm((current) => ({ ...current, mode: value }))}>
                      <SelectTrigger id="mqtt-mode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto</SelectItem>
                        <SelectItem value="enabled">Enabled</SelectItem>
                        <SelectItem value="disabled">Disabled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="mqtt-protocol">Protocol</Label>
                    <Select value={mqttForm.protocol} onValueChange={(value) => setMqttForm((current) => ({ ...current, protocol: value }))}>
                      <SelectTrigger id="mqtt-protocol">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="mqtt">mqtt</SelectItem>
                        <SelectItem value="mqtts">mqtts</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="mqtt-host">Host</Label>
                    <Input id="mqtt-host" value={mqttForm.host} onChange={(event) => setMqttForm((current) => ({ ...current, host: event.target.value }))} />
                  </div>
                  <div>
                    <Label htmlFor="mqtt-port">Port</Label>
                    <Input id="mqtt-port" value={mqttForm.port} onChange={(event) => setMqttForm((current) => ({ ...current, port: event.target.value }))} inputMode="numeric" />
                  </div>
                  <div>
                    <Label htmlFor="mqtt-topic-prefix">Topic Prefix</Label>
                    <Input id="mqtt-topic-prefix" value={mqttForm.topicPrefix} onChange={(event) => setMqttForm((current) => ({ ...current, topicPrefix: event.target.value }))} />
                  </div>
                  <div>
                    <Label htmlFor="mqtt-client-id">Client ID</Label>
                    <Input id="mqtt-client-id" value={mqttForm.clientId} onChange={(event) => setMqttForm((current) => ({ ...current, clientId: event.target.value }))} />
                  </div>
                  <div>
                    <Label htmlFor="mqtt-username">Username</Label>
                    <Input id="mqtt-username" value={mqttForm.username} onChange={(event) => setMqttForm((current) => ({ ...current, username: event.target.value }))} />
                  </div>
                  <div>
                    <Label htmlFor="mqtt-password">Password</Label>
                    <Input id="mqtt-password" type="password" placeholder={mqtt?.config.passwordConfigured ? "configured" : "optional"} value={mqttForm.password} onChange={(event) => setMqttForm((current) => ({ ...current, password: event.target.value }))} />
                  </div>
                  <div>
                    <Label htmlFor="mqtt-keepalive">Keepalive Seconds</Label>
                    <Input id="mqtt-keepalive" value={mqttForm.keepaliveSeconds} onChange={(event) => setMqttForm((current) => ({ ...current, keepaliveSeconds: event.target.value }))} inputMode="numeric" />
                  </div>
                  <div>
                    <Label htmlFor="mqtt-timeout">Connect Timeout MS</Label>
                    <Input id="mqtt-timeout" value={mqttForm.connectTimeoutMs} onChange={(event) => setMqttForm((current) => ({ ...current, connectTimeoutMs: event.target.value }))} inputMode="numeric" />
                  </div>
                  <div>
                    <Label htmlFor="mqtt-reconnect">Reconnect MS</Label>
                    <Input id="mqtt-reconnect" value={mqttForm.reconnectMs} onChange={(event) => setMqttForm((current) => ({ ...current, reconnectMs: event.target.value }))} inputMode="numeric" />
                  </div>
                </div>
                <div className="grid gap-3 border-t border-border/60 pt-4 sm:grid-cols-2">
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Broker URL</div>
                    <div className="mt-1 break-all font-mono text-sm">{mqtt?.status.brokerUrl || "unknown"}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Reachability</div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Badge variant={getStatusVariant(mqtt?.status.connected)}>{mqtt?.status.connected ? "connected" : "not connected"}</Badge>
                      <Badge variant={getStatusVariant(mqtt?.status.reachable)}>{mqtt?.status.reachable ? "reachable" : "not reachable"}</Badge>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Last Connected</div>
                    <div className="mt-1 text-sm">{formatTimestamp(mqtt?.status.lastConnectedAt)}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Last Published</div>
                    <div className="mt-1 text-sm">{formatTimestamp(mqtt?.status.lastPublishedAt)}</div>
                  </div>
                </div>
                <div className="rounded-lg border border-border/60 p-3 text-sm text-muted-foreground">
                  {mqtt?.routing.reason}
                </div>
                <div className="flex justify-end">
                  <Button onClick={handleSaveMqtt} disabled={savingMqtt}>
                    {savingMqtt ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save MQTT
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Terminal className="h-5 w-5" />
                  MQTT Traffic
                </CardTitle>
                <CardDescription>Publish a diagnostic message and inspect recent HomeBrain topics.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <div>
                    <Label htmlFor="mqtt-test-topic">Test Topic</Label>
                    <Input id="mqtt-test-topic" value={testTopic} onChange={(event) => setTestTopic(event.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="mqtt-test-qos">QoS</Label>
                    <Select value={testQos} onValueChange={setTestQos}>
                      <SelectTrigger id="mqtt-test-qos">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">0</SelectItem>
                        <SelectItem value="1">1</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="md:col-span-2">
                    <Label htmlFor="mqtt-test-message">Message</Label>
                    <Textarea id="mqtt-test-message" value={testMessage} onChange={(event) => setTestMessage(event.target.value)} rows={3} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={testRetain} onCheckedChange={(checked) => setTestRetain(checked === true)} />
                    Retain message
                  </label>
                  <Button onClick={handlePublishMqtt} disabled={publishingMqtt}>
                    {publishingMqtt ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                    Publish Test
                  </Button>
                </div>
                <Table className="min-w-[48rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Received</TableHead>
                      <TableHead>Topic</TableHead>
                      <TableHead>QoS</TableHead>
                      <TableHead>Payload</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(mqtt?.recentMessages || []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-muted-foreground">No recent MQTT messages.</TableCell>
                      </TableRow>
                    ) : null}
                    {(mqtt?.recentMessages || []).map((message) => (
                      <TableRow key={`${message.receivedAt}-${message.topic}`}>
                        <TableCell className="whitespace-nowrap text-xs">{formatTimestamp(message.receivedAt)}</TableCell>
                        <TableCell className="font-mono text-xs">{message.topic}</TableCell>
                        <TableCell>{message.qos ?? "n/a"}</TableCell>
                        <TableCell className="max-w-[28rem] truncate font-mono text-xs">{message.payload}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="pihole" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <Card>
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Network className="h-5 w-5" />
                      Pi-hole Management
                    </CardTitle>
                    <CardDescription>DNS filtering status, admin route, and maintenance controls.</CardDescription>
                  </div>
                  <Badge variant={getStatusVariant(pihole?.service.active)}>{pihole?.service.active ? "active" : "inactive"}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="pihole-web-port">Web Port</Label>
                    <Input id="pihole-web-port" value={piholeForm.webPort} onChange={(event) => setPiholeForm((current) => ({ ...current, webPort: event.target.value }))} inputMode="numeric" />
                  </div>
                  <div>
                    <Label htmlFor="pihole-web-tls-port">TLS Web Port</Label>
                    <Input id="pihole-web-tls-port" value={piholeForm.webTlsPort} onChange={(event) => setPiholeForm((current) => ({ ...current, webTlsPort: event.target.value }))} inputMode="numeric" />
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor="pihole-admin-hostname">Admin Hostname</Label>
                    <Input id="pihole-admin-hostname" value={piholeForm.adminHostname} onChange={(event) => setPiholeForm((current) => ({ ...current, adminHostname: event.target.value }))} />
                    {pihole?.config.suggestedAdminHostname && !pihole?.config.adminHostnameConfigured ? (
                      <div className="mt-2 text-xs text-muted-foreground">Suggested: {pihole.config.suggestedAdminHostname}</div>
                    ) : null}
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <label className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3 text-sm">
                    Public route
                    <Switch checked={piholeForm.adminRouteEnabled} onCheckedChange={(checked) => setPiholeForm((current) => ({ ...current, adminRouteEnabled: checked }))} />
                  </label>
                  <label className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3 text-sm">
                    Dynamic DNS
                    <Switch checked={piholeForm.dynamicDnsEnabled} onCheckedChange={(checked) => setPiholeForm((current) => ({ ...current, dynamicDnsEnabled: checked }))} />
                  </label>
                  <label className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3 text-sm">
                    Apply on save
                    <Switch checked={piholeForm.applyRouteOnSave} onCheckedChange={(checked) => setPiholeForm((current) => ({ ...current, applyRouteOnSave: checked }))} />
                  </label>
                </div>
                <div className="grid gap-3 border-t border-border/60 pt-4 sm:grid-cols-2">
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Local Admin</div>
                    <a className="mt-1 inline-flex items-center gap-1 break-all text-sm text-primary" href={pihole?.adminUrls.local || "#"} target="_blank" rel="noreferrer">
                      {pihole?.adminUrls.local || "unknown"}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Public Admin</div>
                    {pihole?.adminUrls.public ? (
                      <a className="mt-1 inline-flex items-center gap-1 break-all text-sm text-primary" href={pihole.adminUrls.public} target="_blank" rel="noreferrer">
                        {pihole.adminUrls.public}
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    ) : (
                      <div className="mt-1 text-sm text-muted-foreground">not enabled</div>
                    )}
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Route</div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Badge variant={pihole?.routing.routePresent ? "secondary" : "outline"}>
                        {pihole?.routing.routePresent ? "present" : "missing"}
                      </Badge>
                      <Badge variant={pihole?.routing.routeEnabled ? "secondary" : "outline"}>
                        {pihole?.routing.routeEnabled ? "enabled" : "disabled"}
                      </Badge>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Upstream</div>
                    <div className="mt-1 font-mono text-sm">127.0.0.1:{piholeForm.webPort}</div>
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" onClick={() => handleEnsurePiholeRoute(false)} disabled={Boolean(ensuringRoute)}>
                    {ensuringRoute === "ensure" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                    Ensure Route
                  </Button>
                  <Button variant="outline" onClick={() => handleEnsurePiholeRoute(true)} disabled={Boolean(ensuringRoute)}>
                    {ensuringRoute === "apply" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                    Apply Route
                  </Button>
                  <Button onClick={handleSavePihole} disabled={savingPihole}>
                    {savingPihole ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save Pi-hole
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Activity className="h-5 w-5" />
                      DNS Activity
                    </CardTitle>
                    <CardDescription>Live Pi-hole command output, summary counters, and blocklist maintenance.</CardDescription>
                  </div>
                  <Button variant="outline" onClick={handleRunGravity} disabled={updatingGravity}>
                    {updatingGravity ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    Update Gravity
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {pihole?.service.lastError ? (
                  <div className="flex gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    {pihole.service.lastError}
                  </div>
                ) : null}
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {Object.entries(pihole?.summary || {}).slice(0, 9).map(([key, value]) => (
                    <div key={key} className="rounded-lg border border-border/60 p-3">
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{key.replace(/_/g, " ")}</div>
                      <div className="mt-1 truncate text-lg font-semibold">{summarizeValue(value)}</div>
                    </div>
                  ))}
                  {Object.keys(pihole?.summary || {}).length === 0 ? (
                    <div className="rounded-lg border border-border/60 p-3 text-sm text-muted-foreground">No Pi-hole summary counters returned.</div>
                  ) : null}
                </div>
                <div>
                  <div className="mb-2 text-sm font-medium">Status Output</div>
                  <pre className="max-h-48 overflow-auto rounded-lg border border-border/60 bg-black/80 p-3 text-xs text-slate-100">
                    {pihole?.statusText || "No status output returned."}
                  </pre>
                </div>
                <div>
                  <div className="mb-2 text-sm font-medium">Adlists</div>
                  <Table className="min-w-[44rem]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Address</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Comment</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(pihole?.adlists || []).length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={3} className="text-center text-muted-foreground">No adlists returned.</TableCell>
                        </TableRow>
                      ) : null}
                      {(pihole?.adlists || []).map((adlist) => (
                        <TableRow key={adlist.address}>
                          <TableCell className="max-w-[28rem] truncate font-mono text-xs">{adlist.address}</TableCell>
                          <TableCell>
                            <Badge variant={adlist.enabled ? "secondary" : "outline"}>{adlist.enabled ? "enabled" : "disabled"}</Badge>
                          </TableCell>
                          <TableCell>{adlist.comment || "none"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Pi-hole Query Log</CardTitle>
              <CardDescription>Newest entries from the host Pi-hole log.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table className="min-w-[54rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Line</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(pihole?.queryLog || []).length === 0 ? (
                    <TableRow>
                      <TableCell className="text-center text-muted-foreground">No query log entries returned.</TableCell>
                    </TableRow>
                  ) : null}
                  {(pihole?.queryLog || []).map((entry, index) => (
                    <TableRow key={`${index}-${entry.line}`}>
                      <TableCell className="font-mono text-xs">{entry.line}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default PlatformServices;
