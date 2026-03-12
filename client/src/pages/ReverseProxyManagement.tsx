import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Globe2,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Waypoints
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/useToast";
import {
  applyReverseProxyConfig,
  createReverseProxyRoute,
  deleteReverseProxyRoute,
  getReverseProxyCertificates,
  getReverseProxyRoutes,
  getReverseProxyStatus,
  ReverseProxyCertificateRecord,
  ReverseProxyRoute,
  ReverseProxySettings,
  ReverseProxyStatusResponse,
  updateReverseProxyRoute,
  updateReverseProxySettings,
  validateReverseProxyRoutes
} from "@/api/reverseProxy";
import { AxiosError } from "axios";

type RouteFormState = {
  hostname: string;
  platformKey: string;
  displayName: string;
  upstreamProtocol: "http" | "https";
  upstreamHost: string;
  upstreamPort: string;
  enabled: boolean;
  tlsMode: "automatic" | "internal" | "manual" | "on_demand";
  allowOnDemandTls: boolean;
  healthCheckPath: string;
  websocketSupport: boolean;
  stripPrefix: string;
  notes: string;
  ownershipVerified: boolean;
  adminApproved: boolean;
};

const PRESET_DEFAULTS: Record<string, Partial<RouteFormState>> = {
  homebrain: {
    platformKey: "homebrain",
    displayName: "HomeBrain",
    upstreamProtocol: "http",
    upstreamHost: "127.0.0.1",
    upstreamPort: "3000",
    healthCheckPath: "/ping",
    websocketSupport: true,
    tlsMode: "automatic"
  },
  axiom: {
    platformKey: "axiom",
    displayName: "Axiom",
    upstreamProtocol: "http",
    upstreamHost: "127.0.0.1",
    upstreamPort: "3001",
    healthCheckPath: "/",
    websocketSupport: true,
    tlsMode: "automatic"
  }
};

const EMPTY_FORM: RouteFormState = {
  hostname: "",
  platformKey: "custom",
  displayName: "",
  upstreamProtocol: "http",
  upstreamHost: "127.0.0.1",
  upstreamPort: "3000",
  enabled: false,
  tlsMode: "automatic",
  allowOnDemandTls: false,
  healthCheckPath: "/",
  websocketSupport: true,
  stripPrefix: "",
  notes: "",
  ownershipVerified: false,
  adminApproved: false
};

const SETTINGS_DEFAULTS: ReverseProxySettings = {
  caddyAdminUrl: "http://127.0.0.1:2019",
  caddyStorageRoot: "/var/lib/caddy",
  acmeEnv: "staging",
  acmeEmail: "",
  expectedPublicIp: "",
  expectedPublicIpv6: "",
  onDemandTlsEnabled: false,
  accessLogsEnabled: true,
  adminApiEnabled: true
};

function getErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object") {
    const axiosError = error as AxiosError<{ message?: string }>;
    const message = axiosError.response?.data?.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

function getStatusBadgeVariant(status: string) {
  if (status === "issued" || status === "valid" || status === "applied" || status === "success") {
    return "secondary" as const;
  }
  if (status === "error" || status === "invalid" || status === "failed") {
    return "destructive" as const;
  }
  return "outline" as const;
}

function formatDate(value?: string | null) {
  if (!value) {
    return "n/a";
  }

  return new Date(value).toLocaleString();
}

function RouteEditor({
  open,
  form,
  editingRoute,
  saving,
  onOpenChange,
  onChange,
  onSubmit
}: {
  open: boolean;
  form: RouteFormState;
  editingRoute: ReverseProxyRoute | null;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (next: Partial<RouteFormState>) => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editingRoute ? "Edit Route" : "Create Route"}</DialogTitle>
          <DialogDescription>
            Manage a hostname, its upstream target, TLS policy, and domain approval state.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="route-hostname">Hostname</Label>
              <Input
                id="route-hostname"
                placeholder="freestonefamily.com"
                value={form.hostname}
                onChange={(event) => onChange({ hostname: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="route-display-name">Display Name</Label>
              <Input
                id="route-display-name"
                placeholder="HomeBrain"
                value={form.displayName}
                onChange={(event) => onChange({ displayName: event.target.value })}
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            <div className="space-y-2">
              <Label>Platform</Label>
              <Select value={form.platformKey} onValueChange={(value) => onChange({ ...PRESET_DEFAULTS[value], platformKey: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="homebrain">HomeBrain</SelectItem>
                  <SelectItem value="axiom">Axiom</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Upstream Protocol</Label>
              <Select value={form.upstreamProtocol} onValueChange={(value: "http" | "https") => onChange({ upstreamProtocol: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="https">HTTPS</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="route-upstream-host">Upstream Host</Label>
              <Input
                id="route-upstream-host"
                value={form.upstreamHost}
                onChange={(event) => onChange({ upstreamHost: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="route-upstream-port">Upstream Port</Label>
              <Input
                id="route-upstream-port"
                value={form.upstreamPort}
                onChange={(event) => onChange({ upstreamPort: event.target.value })}
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            <div className="space-y-2">
              <Label>TLS Mode</Label>
              <Select value={form.tlsMode} onValueChange={(value: RouteFormState["tlsMode"]) => onChange({ tlsMode: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="automatic">Automatic</SelectItem>
                  <SelectItem value="internal">Internal CA</SelectItem>
                  <SelectItem value="manual">Manual Cert Files</SelectItem>
                  <SelectItem value="on_demand">On-Demand</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="route-health-path">Health Check Path</Label>
              <Input
                id="route-health-path"
                value={form.healthCheckPath}
                onChange={(event) => onChange({ healthCheckPath: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="route-strip-prefix">Strip Prefix</Label>
              <Input
                id="route-strip-prefix"
                placeholder="/api"
                value={form.stripPrefix}
                onChange={(event) => onChange({ stripPrefix: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>WebSocket Support</Label>
              <div className="flex h-10 items-center rounded-md border px-3">
                <Switch checked={form.websocketSupport} onCheckedChange={(checked) => onChange({ websocketSupport: checked })} />
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              Enable Route
              <Switch checked={form.enabled} onCheckedChange={(checked) => onChange({ enabled: checked })} />
            </label>
            <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              Allow On-Demand TLS
              <Switch checked={form.allowOnDemandTls} onCheckedChange={(checked) => onChange({ allowOnDemandTls: checked })} />
            </label>
            <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              Ownership Verified
              <Switch checked={form.ownershipVerified} onCheckedChange={(checked) => onChange({ ownershipVerified: checked })} />
            </label>
            <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              Admin Approved
              <Switch checked={form.adminApproved} onCheckedChange={(checked) => onChange({ adminApproved: checked })} />
            </label>
          </div>

          <div className="space-y-2">
            <Label htmlFor="route-notes">Notes</Label>
            <Textarea
              id="route-notes"
              rows={4}
              value={form.notes}
              onChange={(event) => onChange({ notes: event.target.value })}
            />
          </div>

          {form.tlsMode === "manual" ? (
            <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-900 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-100">
              Manual TLS uses the current certificate files written by HomeBrain at `server/certificates/active-chain.pem` and `server/certificates/active-key.pem`.
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={onSubmit} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {editingRoute ? "Save Route" : "Create Route"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ReverseProxyManagement() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [routes, setRoutes] = useState<ReverseProxyRoute[]>([]);
  const [status, setStatus] = useState<ReverseProxyStatusResponse | null>(null);
  const [certificates, setCertificates] = useState<ReverseProxyCertificateRecord[]>([]);
  const [settingsForm, setSettingsForm] = useState<ReverseProxySettings>(SETTINGS_DEFAULTS);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<ReverseProxyRoute | null>(null);
  const [routeForm, setRouteForm] = useState<RouteFormState>(EMPTY_FORM);
  const [savingRoute, setSavingRoute] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [applyingConfig, setApplyingConfig] = useState(false);
  const [validatingRoutes, setValidatingRoutes] = useState(false);

  const onDemandRows = useMemo(
    () => routes.filter((route) => route.tlsMode === "on_demand" || route.allowOnDemandTls || route.certificateStatus?.adminApproved || route.certificateStatus?.ownershipVerified),
    [routes]
  );
  const activeAcmeMode = status?.settings?.acmeEnv || settingsForm.acmeEnv;
  const usingStagingAcme = activeAcmeMode === "staging";

  const refresh = async () => {
    const [statusResponse, routesResponse, certificateResponse] = await Promise.all([
      getReverseProxyStatus(),
      getReverseProxyRoutes(),
      getReverseProxyCertificates()
    ]);

    setStatus(statusResponse);
    setRoutes(routesResponse.routes || []);
    setCertificates(certificateResponse.certificates || []);
    setSettingsForm(statusResponse.settings || SETTINGS_DEFAULTS);
  };

  useEffect(() => {
    void (async () => {
      try {
        await refresh();
      } catch (error) {
        toast({
          title: "Reverse proxy unavailable",
          description: getErrorMessage(error, "Failed to load reverse proxy data."),
          variant: "destructive"
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [toast]);

  const openCreateDialog = (presetKey?: string) => {
    setEditingRoute(null);
    setRouteForm({
      ...EMPTY_FORM,
      ...(presetKey ? PRESET_DEFAULTS[presetKey] : {})
    });
    setDialogOpen(true);
  };

  const openEditDialog = (route: ReverseProxyRoute) => {
    setEditingRoute(route);
    setRouteForm({
      hostname: route.hostname,
      platformKey: route.platformKey,
      displayName: route.displayName,
      upstreamProtocol: route.upstreamProtocol,
      upstreamHost: route.upstreamHost,
      upstreamPort: String(route.upstreamPort),
      enabled: route.enabled,
      tlsMode: route.tlsMode,
      allowOnDemandTls: Boolean(route.allowOnDemandTls),
      healthCheckPath: route.healthCheckPath || "/",
      websocketSupport: Boolean(route.websocketSupport),
      stripPrefix: route.stripPrefix || "",
      notes: route.notes || "",
      ownershipVerified: Boolean(route.certificateStatus?.ownershipVerified),
      adminApproved: Boolean(route.certificateStatus?.adminApproved)
    });
    setDialogOpen(true);
  };

  const handleSaveRoute = async () => {
    setSavingRoute(true);
    try {
      const payload = {
        ...routeForm,
        upstreamPort: Number(routeForm.upstreamPort)
      };

      if (editingRoute) {
        await updateReverseProxyRoute(editingRoute._id, payload);
      } else {
        await createReverseProxyRoute(payload);
      }

      await refresh();
      setDialogOpen(false);
      toast({
        title: editingRoute ? "Route updated" : "Route created",
        description: routeForm.hostname
      });
    } catch (error) {
      toast({
        title: editingRoute ? "Route update failed" : "Route creation failed",
        description: getErrorMessage(error, "Unable to save route."),
        variant: "destructive"
      });
    } finally {
      setSavingRoute(false);
    }
  };

  const handleDeleteRoute = async (route: ReverseProxyRoute) => {
    if (!window.confirm(`Delete reverse-proxy route for ${route.hostname}?`)) {
      return;
    }

    try {
      await deleteReverseProxyRoute(route._id);
      await refresh();
      toast({
        title: "Route deleted",
        description: route.hostname
      });
    } catch (error) {
      toast({
        title: "Delete failed",
        description: getErrorMessage(error, "Unable to delete route."),
        variant: "destructive"
      });
    }
  };

  const handleValidateRoutes = async () => {
    setValidatingRoutes(true);
    try {
      await validateReverseProxyRoutes();
      await refresh();
      toast({
        title: "Validation complete",
        description: "DNS, upstream, and edge checks were refreshed."
      });
    } catch (error) {
      toast({
        title: "Validation failed",
        description: getErrorMessage(error, "Unable to validate routes."),
        variant: "destructive"
      });
    } finally {
      setValidatingRoutes(false);
    }
  };

  const handleApplyConfig = async () => {
    if (!window.confirm("Apply the current HomeBrain-managed Caddy configuration?")) {
      return;
    }

    setApplyingConfig(true);
    try {
      await applyReverseProxyConfig();
      await refresh();
      toast({
        title: "Caddy config applied",
        description: "The managed reverse-proxy configuration is now live."
      });
    } catch (error) {
      toast({
        title: "Apply failed",
        description: getErrorMessage(error, "Unable to apply Caddy config."),
        variant: "destructive"
      });
    } finally {
      setApplyingConfig(false);
    }
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const currentAcmeMode = status?.settings?.acmeEnv || "staging";
      const confirmProductionSwitch = currentAcmeMode === "staging" && settingsForm.acmeEnv === "production"
        ? window.confirm("Switch ACME mode from staging to production?")
        : false;

      if (currentAcmeMode === "staging" && settingsForm.acmeEnv === "production" && !confirmProductionSwitch) {
        setSavingSettings(false);
        return;
      }

      await updateReverseProxySettings({
        ...settingsForm,
        confirmProductionSwitch
      });
      await refresh();
      toast({
        title: "Settings saved",
        description: `ACME mode: ${settingsForm.acmeEnv}`
      });
    } catch (error) {
      toast({
        title: "Settings save failed",
        description: getErrorMessage(error, "Unable to save reverse proxy settings."),
        variant: "destructive"
      });
    } finally {
      setSavingSettings(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="bg-gradient-to-r from-cyan-600 to-emerald-600 bg-clip-text text-3xl font-bold text-transparent">
            Reverse Proxy / Domains
          </h1>
          <p className="mt-2 text-muted-foreground">
            HomeBrain-managed Caddy ingress for domains, TLS, and upstream routing.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void refresh()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button variant="outline" onClick={handleValidateRoutes} disabled={validatingRoutes}>
            {validatingRoutes ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
            Validate
          </Button>
          <Button onClick={handleApplyConfig} disabled={applyingConfig}>
            {applyingConfig ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Waypoints className="mr-2 h-4 w-4" />}
            Apply Caddy Config
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Caddy Admin</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={status?.caddy.adminReachable ? "secondary" : "destructive"}>
              {status?.caddy.adminReachable ? "Reachable" : "Unavailable"}
            </Badge>
            <p className="mt-3 text-xs text-muted-foreground">{status?.settings.caddyAdminUrl}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">ACME Mode</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={status?.settings.acmeEnv === "production" ? "destructive" : "outline"}>
              {status?.settings.acmeEnv}
            </Badge>
            <p className="mt-3 text-xs text-muted-foreground">
              Production issuance requires explicit confirmation.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Route Inventory</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{status?.summary.totalRoutes || 0}</p>
            <p className="text-xs text-muted-foreground">
              Enabled: {status?.summary.enabledRoutes || 0} | Invalid: {status?.summary.invalidRoutes || 0}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Config Drift</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={status?.config.changed ? "destructive" : "secondary"}>
              {status?.config.changed ? "Changes Pending" : "In Sync"}
            </Badge>
            <p className="mt-3 text-xs text-muted-foreground">
              Last apply: {formatDate(status?.settings.lastAppliedAt)}
            </p>
          </CardContent>
        </Card>
      </div>

      {usingStagingAcme ? (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-950 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-100">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">ACME staging is active.</p>
              <p>
                Browser certificate warnings and a &quot;Not Secure&quot; label are expected while staging certificates are in use.
                Switch ACME mode to <span className="font-semibold">production</span>, save, validate, and apply again when you are ready for a browser-trusted certificate.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Reverse Proxy Settings</CardTitle>
          <CardDescription>
            Local Caddy admin address, ACME environment, expected public IPs, and on-demand TLS policy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="caddy-admin-url">Caddy Admin URL</Label>
              <Input
                id="caddy-admin-url"
                value={settingsForm.caddyAdminUrl}
                onChange={(event) => setSettingsForm((prev) => ({ ...prev, caddyAdminUrl: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="caddy-storage-root">Caddy Storage Root</Label>
              <Input
                id="caddy-storage-root"
                value={settingsForm.caddyStorageRoot}
                onChange={(event) => setSettingsForm((prev) => ({ ...prev, caddyStorageRoot: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="acme-email">ACME Email</Label>
              <Input
                id="acme-email"
                value={settingsForm.acmeEmail}
                onChange={(event) => setSettingsForm((prev) => ({ ...prev, acmeEmail: event.target.value }))}
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            <div className="space-y-2">
              <Label>ACME Mode</Label>
              <Select value={settingsForm.acmeEnv} onValueChange={(value: "staging" | "production") => setSettingsForm((prev) => ({ ...prev, acmeEnv: value }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="staging">staging</SelectItem>
                  <SelectItem value="production">production</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="expected-ip">Expected Public IPv4</Label>
              <Input
                id="expected-ip"
                value={settingsForm.expectedPublicIp}
                onChange={(event) => setSettingsForm((prev) => ({ ...prev, expectedPublicIp: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="expected-ipv6">Expected Public IPv6</Label>
              <Input
                id="expected-ipv6"
                value={settingsForm.expectedPublicIpv6}
                onChange={(event) => setSettingsForm((prev) => ({ ...prev, expectedPublicIpv6: event.target.value }))}
              />
            </div>
            <div className="grid gap-3">
              <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                On-Demand TLS
                <Switch
                  checked={settingsForm.onDemandTlsEnabled}
                  onCheckedChange={(checked) => setSettingsForm((prev) => ({ ...prev, onDemandTlsEnabled: checked }))}
                />
              </label>
              <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                Access Logs
                <Switch
                  checked={settingsForm.accessLogsEnabled}
                  onCheckedChange={(checked) => setSettingsForm((prev) => ({ ...prev, accessLogsEnabled: checked }))}
                />
              </label>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSaveSettings} disabled={savingSettings}>
              {savingSettings ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save Settings
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Managed Routes</CardTitle>
              <CardDescription>
                Hostname-to-upstream mappings managed by HomeBrain and applied to Caddy through the admin API.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => openCreateDialog("homebrain")}>
                <Plus className="mr-2 h-4 w-4" />
                Add HomeBrain Route
              </Button>
              <Button variant="outline" onClick={() => openCreateDialog("axiom")}>
                <Network className="mr-2 h-4 w-4" />
                Add Axiom Route
              </Button>
              <Button onClick={() => openCreateDialog()}>
                <Globe2 className="mr-2 h-4 w-4" />
                New Custom Route
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hostname</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Upstream</TableHead>
                <TableHead>TLS</TableHead>
                <TableHead>Certificate</TableHead>
                <TableHead>Validation</TableHead>
                <TableHead>Last Apply</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {routes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No managed routes yet.
                  </TableCell>
                </TableRow>
              ) : null}
              {routes.map((route) => (
                <TableRow key={route._id}>
                  <TableCell>
                    <div className="font-medium">{route.hostname}</div>
                    <div className="text-xs text-muted-foreground">
                      {route.enabled ? "Enabled" : "Disabled"}
                    </div>
                  </TableCell>
                  <TableCell>{route.displayName || route.platformKey}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {route.upstreamProtocol}://{route.upstreamHost}:{route.upstreamPort}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{route.tlsMode}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={getStatusBadgeVariant(route.certificateStatus?.status || "unknown")}>
                      {route.certificateStatus?.status || "unknown"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={getStatusBadgeVariant(route.validationStatus || "unknown")}>
                      {route.validationStatus}
                    </Badge>
                    <div className="mt-2 text-xs text-muted-foreground">
                      DNS: {route.validation?.dnsReady ? "ready" : "missing"} | IP: {route.validation?.publicIpMatches === null || route.validation?.publicIpMatches === undefined ? "unchecked" : route.validation.publicIpMatches ? "match" : "mismatch"} | Upstream: {route.validation?.upstreamReachable ? "reachable" : "down"}
                    </div>
                    {route.validation?.blockingErrors?.length ? (
                      <div className="mt-2 text-xs text-red-600">
                        {route.validation.blockingErrors[0]}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={getStatusBadgeVariant(route.lastApplyStatus)}>
                      {route.lastApplyStatus}
                    </Badge>
                    {route.lastApplyError ? (
                      <div className="mt-2 text-xs text-red-600">{route.lastApplyError}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => openEditDialog(route)}>
                        Edit
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => void handleDeleteRoute(route)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Config Preview</CardTitle>
            <CardDescription>Desired HomeBrain-managed Caddyfile preview.</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-[28rem] overflow-auto rounded-md bg-slate-950 p-4 text-xs text-slate-100">
              {status?.config.desired || "No desired config generated yet."}
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Last Applied Config</CardTitle>
            <CardDescription>
              Stored copy of the last configuration successfully applied through the Caddy admin API.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-[28rem] overflow-auto rounded-md bg-slate-950 p-4 text-xs text-slate-100">
              {status?.config.lastApplied || "No config has been applied yet."}
            </pre>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Certificate Status</CardTitle>
            <CardDescription>
              TLS issuance readiness and the currently served certificate state per hostname.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Hostname</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Eligibility</TableHead>
                  <TableHead>Renewal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {certificates.map((certificate) => (
                  <TableRow key={certificate.id}>
                    <TableCell>
                      <div className="font-medium">{certificate.hostname}</div>
                      <div className="text-xs text-muted-foreground">
                        Last checked: {formatDate(certificate.lastCheckedAt)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={getStatusBadgeVariant(certificate.certStatus)}>
                        {certificate.certStatus}
                      </Badge>
                      {certificate.lastError ? (
                        <div className="mt-2 text-xs text-red-600">{certificate.lastError}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{certificate.automaticTlsEligible ? "Automatic TLS ready" : "Needs validation"}</div>
                      <div className="text-xs text-muted-foreground">
                        DNS ready: {certificate.dnsReady ? "yes" : "no"}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{certificate.renewalState}</div>
                      <div className="text-xs text-muted-foreground">
                        Expires: {formatDate(certificate.servedNotAfter)}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>On-Demand Domain Approval</CardTitle>
            <CardDescription>
              Approval state for routes that participate in future on-demand TLS issuance.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {onDemandRows.length === 0 ? (
              <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                No routes currently use on-demand TLS approval.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hostname</TableHead>
                    <TableHead>Allowed</TableHead>
                    <TableHead>Ownership</TableHead>
                    <TableHead>Approval</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {onDemandRows.map((route) => (
                    <TableRow key={route._id}>
                      <TableCell>{route.hostname}</TableCell>
                      <TableCell>{route.allowOnDemandTls ? "yes" : "no"}</TableCell>
                      <TableCell>{route.certificateStatus?.ownershipVerified ? "verified" : "pending"}</TableCell>
                      <TableCell>{route.certificateStatus?.adminApproved ? "approved" : "pending"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Audit Trail</CardTitle>
          <CardDescription>
            Route changes, validations, settings updates, and config apply activity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Hostname</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(status?.auditLogs || []).map((entry) => (
                <TableRow key={entry._id}>
                  <TableCell>{formatDate(entry.createdAt)}</TableCell>
                  <TableCell>{entry.actor}</TableCell>
                  <TableCell>{entry.action}</TableCell>
                  <TableCell>{entry.hostname || "global"}</TableCell>
                  <TableCell>
                    <Badge variant={getStatusBadgeVariant(entry.status)}>{entry.status}</Badge>
                    {entry.error ? (
                      <div className="mt-2 text-xs text-red-600">{entry.error}</div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {(status?.caddy.error || status?.summary.invalidRoutes) ? (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-900 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-100">
          <div className="mb-2 flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" />
            Reverse proxy attention required
          </div>
          <p>
            {status?.caddy.error
              ? `Caddy admin issue: ${status.caddy.error}`
              : `${status?.summary.invalidRoutes || 0} route(s) still have blocking validation errors.`}
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
          <div className="mb-2 flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-4 w-4" />
            Reverse proxy control plane is healthy
          </div>
          <p>Caddy is reachable and there are no currently invalid managed routes.</p>
        </div>
      )}

      <RouteEditor
        open={dialogOpen}
        form={routeForm}
        editingRoute={editingRoute}
        saving={savingRoute}
        onOpenChange={setDialogOpen}
        onChange={(next) => setRouteForm((prev) => ({ ...prev, ...next }))}
        onSubmit={handleSaveRoute}
      />
    </div>
  );
}

export default ReverseProxyManagement;
