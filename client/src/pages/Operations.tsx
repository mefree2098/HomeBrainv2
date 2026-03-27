import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/useToast";
import {
  PlatformEvent,
  getEventSummary,
  getLatestEvents,
  openEventStream
} from "@/api/events";
import { getDeployHealth } from "@/api/platformDeploy";

const MAX_EVENTS = 250;

const toErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return fallback;
};

const formatRelativeTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleString();
};

const severityVariant = (severity: string) => {
  if (severity === "error") {
    return "destructive" as const;
  }
  if (severity === "warn") {
    return "outline" as const;
  }
  return "secondary" as const;
};

const healthVariant = (status: "healthy" | "degraded" | undefined) => (
  status === "healthy" ? "secondary" : "destructive"
);

export function Operations() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<PlatformEvent[]>([]);
  const [summary, setSummary] = useState<{
    windowMinutes: number;
    total: number;
    bySeverity: Record<string, number>;
    byType: Record<string, number>;
  } | null>(null);
  const [health, setHealth] = useState<any>(null);
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [sourceFilter, setSourceFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [streamConnected, setStreamConnected] = useState(false);
  const latestSequenceRef = useRef(0);
  const cleanupRef = useRef<null | (() => void)>(null);

  const loadSnapshot = useCallback(async () => {
    const [eventSummary, latest, deployHealth] = await Promise.all([
      getEventSummary(60),
      getLatestEvents(200),
      getDeployHealth().catch(() => null)
    ]);
    const latestEvents = Array.isArray(latest.events) ? latest.events : [];
    setEvents(latestEvents.slice().reverse());
    latestSequenceRef.current = latest.lastSequence || 0;
    setSummary({
      windowMinutes: eventSummary.windowMinutes,
      total: eventSummary.total,
      bySeverity: eventSummary.bySeverity || {},
      byType: eventSummary.byType || {}
    });
    setHealth(deployHealth);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      await loadSnapshot();
    } catch (error) {
      toast({
        title: "Operations refresh failed",
        description: toErrorMessage(error, "Unable to load operations data."),
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  }, [loadSnapshot, toast]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!liveEnabled) {
      cleanupRef.current?.();
      cleanupRef.current = null;
      setStreamConnected(false);
      return;
    }

    cleanupRef.current?.();
    cleanupRef.current = openEventStream(
      {
        sinceSequence: latestSequenceRef.current || 0,
        limit: 200
      },
      {
        onEvent: (event) => {
          latestSequenceRef.current = Math.max(latestSequenceRef.current, Number(event.sequence) || 0);
          setEvents((prev) => {
            const next = [event, ...prev];
            return next.slice(0, MAX_EVENTS);
          });
        },
        onReady: () => {
          setStreamConnected(true);
        },
        onError: () => {
          setStreamConnected(false);
        }
      }
    );

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [liveEnabled]);

  useEffect(() => {
    const interval = setInterval(() => {
      void getEventSummary(60)
        .then((eventSummary) => {
          setSummary({
            windowMinutes: eventSummary.windowMinutes,
            total: eventSummary.total,
            bySeverity: eventSummary.bySeverity || {},
            byType: eventSummary.byType || {}
          });
        })
        .catch(() => {});
    }, 20_000);
    return () => clearInterval(interval);
  }, []);

  const filteredEvents = useMemo(() => {
    const sourceNeedle = sourceFilter.trim().toLowerCase();
    const typeNeedle = typeFilter.trim().toLowerCase();
    return events.filter((event) => {
      const sourceOk = !sourceNeedle || event.source.toLowerCase().includes(sourceNeedle);
      const typeOk = !typeNeedle || event.type.toLowerCase().includes(typeNeedle);
      return sourceOk && typeOk;
    });
  }, [events, sourceFilter, typeFilter]);

  const topTypes = useMemo(() => {
    if (!summary?.byType) {
      return [];
    }
    return Object.entries(summary.byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
  }, [summary]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const healthItems = [
    {
      key: "api",
      title: "API",
      status: health?.checks?.api?.status as "healthy" | "degraded" | undefined,
      message: health?.checks?.api?.message || "Unknown"
    },
    {
      key: "websocket",
      title: "WebSocket",
      status: health?.checks?.websocket?.status as "healthy" | "degraded" | undefined,
      message: health?.checks?.websocket?.message || "Unknown"
    },
    {
      key: "database",
      title: "Database",
      status: health?.checks?.database?.status as "healthy" | "degraded" | undefined,
      message: health?.checks?.database?.message || "Unknown"
    },
    {
      key: "wakeword",
      title: "Wake-Word Worker",
      status: health?.checks?.wakeWordWorker?.status as "healthy" | "degraded" | undefined,
      message: health?.checks?.wakeWordWorker?.message || "Unknown"
    }
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="bg-gradient-to-r from-slate-700 to-blue-700 bg-clip-text text-3xl font-bold text-transparent">
            Operations Center
          </h1>
          <p className="mt-1 text-muted-foreground">
            Live platform events, service health, and workflow activity in one place.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            Live stream
            <Switch checked={liveEnabled} onCheckedChange={setLiveEnabled} />
          </label>
          <Button variant="outline" onClick={() => void refreshAll()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Events (60m)</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{summary?.total || 0}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Errors</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold text-red-600">
            {summary?.bySeverity?.error || 0}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Warnings</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold text-amber-600">
            {summary?.bySeverity?.warn || 0}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Live Stream</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-sm font-medium">
            {streamConnected ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                Connected
              </>
            ) : (
              <>
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                Waiting
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-4 w-4" />
            Service Health
          </CardTitle>
          <CardDescription>Post-deploy health indicators from API/WebSocket/DB/wake-word worker.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {healthItems.map((item) => (
            <div key={item.key} className="rounded-md border p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium">{item.title}</span>
                <Badge variant={healthVariant(item.status)}>
                  {item.status || "unknown"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{item.message}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Event Load</CardTitle>
          <CardDescription>Top event types in the last 60 minutes.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {topTypes.length === 0 ? (
            <span className="text-sm text-muted-foreground">No events yet.</span>
          ) : topTypes.map(([type, count]) => (
            <Badge key={type} variant="outline">
              {type}: {count}
            </Badge>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Live Event Feed</CardTitle>
          <CardDescription>Newest events first. Filter by source/type for faster triage.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <Input
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value)}
              placeholder="Filter source (e.g., workflow, remote_update, platform_deploy)"
            />
            <Input
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
              placeholder="Filter type (e.g., workflow.executed)"
            />
          </div>

          <div className="max-h-[560px] space-y-2 overflow-auto rounded-md border p-3">
            {filteredEvents.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No events match current filters.
              </div>
            ) : filteredEvents.map((event) => (
              <div key={event.id} className="rounded-md border bg-muted/20 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={severityVariant(event.severity)}>{event.severity}</Badge>
                    <Badge variant="outline">{event.source}</Badge>
                    <Badge variant="outline">{event.type}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    #{event.sequence} • {formatRelativeTime(event.createdAt)}
                  </div>
                </div>
                <pre className="overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">
                  {JSON.stringify(event.payload || {}, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
