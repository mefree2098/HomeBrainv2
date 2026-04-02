import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Loader2, RefreshCw, Server } from "lucide-react";
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
import {
  InsteonEngineLogEntry,
  getInsteonEngineLogs,
  openInsteonEngineLogStream
} from "@/api/insteon";
import { getDeployHealth } from "@/api/platformDeploy";

const MAX_EVENTS = 250;
const MAX_INSTEON_LOGS = 400;
const MAX_INSTEON_LOG_DETAIL_LENGTH = 320;

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

const mergeInsteonLogs = (
  current: InsteonEngineLogEntry[],
  incoming: InsteonEngineLogEntry[]
) => {
  const indexed = new Map(current.map((entry) => [entry.id, entry]));
  incoming.forEach((entry) => {
    if (!entry?.id) {
      return;
    }
    indexed.set(entry.id, entry);
  });

  return Array.from(indexed.values())
    .sort((left, right) => {
      const leftTime = new Date(left.timestamp).getTime();
      const rightTime = new Date(right.timestamp).getTime();
      if (leftTime === rightTime) {
        return left.id.localeCompare(right.id);
      }
      return leftTime - rightTime;
    })
    .slice(-MAX_INSTEON_LOGS);
};

const formatInsteonLogDetails = (entry: InsteonEngineLogEntry) => {
  const details: Record<string, unknown> = {
    ...(entry.transport ? { transport: entry.transport } : {}),
    ...(entry.target ? { target: entry.target } : {}),
    ...(entry.details && typeof entry.details === "object" ? entry.details : {})
  };

  const serialized = Object.keys(details).length > 0
    ? JSON.stringify(details)
    : "";

  if (!serialized) {
    return "";
  }

  return serialized.length > MAX_INSTEON_LOG_DETAIL_LENGTH
    ? `${serialized.slice(0, MAX_INSTEON_LOG_DETAIL_LENGTH)}...`
    : serialized;
};

const buildInsteonLogClipboardText = (entries: InsteonEngineLogEntry[]) => (
  entries.map((entry) => {
    const parts = [
      formatRelativeTime(entry.timestamp),
      entry.level.toUpperCase(),
      entry.direction ? entry.direction.toUpperCase() : null,
      entry.stage || null,
      entry.operation || null,
      entry.address || null,
      entry.message
    ].filter(Boolean);
    const details = formatInsteonLogDetails(entry);
    return details ? `${parts.join(" | ")} | ${details}` : parts.join(" | ");
  }).join("\n")
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
  const [insteonLogs, setInsteonLogs] = useState<InsteonEngineLogEntry[]>([]);
  const [insteonLogStreamConnected, setInsteonLogStreamConnected] = useState(false);
  const latestSequenceRef = useRef(0);
  const cleanupRef = useRef<null | (() => void)>(null);
  const insteonCleanupRef = useRef<null | (() => void)>(null);
  const insteonLogViewportRef = useRef<HTMLDivElement | null>(null);

  const loadSnapshot = useCallback(async () => {
    const [eventSummary, latest, deployHealth, insteonLogSnapshot] = await Promise.all([
      getEventSummary(60),
      getLatestEvents(200),
      getDeployHealth().catch(() => null),
      getInsteonEngineLogs(200).catch(() => ({ logs: [] }))
    ]);
    const latestEvents = Array.isArray(latest.events) ? latest.events : [];
    setEvents(latestEvents.slice().reverse());
    setInsteonLogs(Array.isArray(insteonLogSnapshot.logs) ? mergeInsteonLogs([], insteonLogSnapshot.logs) : []);
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
      insteonCleanupRef.current?.();
      insteonCleanupRef.current = null;
      setInsteonLogStreamConnected(false);
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
    if (!liveEnabled) {
      insteonCleanupRef.current?.();
      insteonCleanupRef.current = null;
      setInsteonLogStreamConnected(false);
      return;
    }

    insteonCleanupRef.current?.();
    insteonCleanupRef.current = openInsteonEngineLogStream(
      {
        limit: 200
      },
      {
        onLog: (entry) => {
          setInsteonLogs((prev) => mergeInsteonLogs(prev, [entry]));
        },
        onReady: () => {
          setInsteonLogStreamConnected(true);
        },
        onError: () => {
          setInsteonLogStreamConnected(false);
        }
      }
    );

    return () => {
      insteonCleanupRef.current?.();
      insteonCleanupRef.current = null;
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

  useEffect(() => {
    const viewport = insteonLogViewportRef.current;
    if (!viewport) {
      return;
    }

    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom < 160 || viewport.scrollTop === 0) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [insteonLogs]);

  const handleCopyInsteonLogs = useCallback(async () => {
    if (insteonLogs.length === 0) {
      return;
    }

    try {
      await navigator.clipboard.writeText(buildInsteonLogClipboardText(insteonLogs));
      toast({
        title: "INSTEON logs copied",
        description: `Copied ${insteonLogs.length} live engine log entries.`
      });
    } catch (error) {
      toast({
        title: "Copy failed",
        description: toErrorMessage(error, "Unable to copy INSTEON engine logs."),
        variant: "destructive"
      });
    }
  }, [insteonLogs, toast]);

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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Live INSTEON Engine Log</CardTitle>
              <CardDescription>
                Direct PLM lifecycle, outbound commands, inbound runtime messages, retries, and sync activity.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={insteonLogStreamConnected ? "secondary" : "outline"}>
                {liveEnabled ? (insteonLogStreamConnected ? "Connected" : "Waiting") : "Paused"}
              </Badge>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleCopyInsteonLogs()}
                disabled={insteonLogs.length === 0}
              >
                <Copy className="mr-2 h-4 w-4" />
                Copy Logs
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{insteonLogs.length} buffered entries</span>
            <span>Newest live engine activity appears at the bottom.</span>
          </div>

          <div
            ref={insteonLogViewportRef}
            className="max-h-[420px] overflow-auto rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-slate-100"
          >
            {insteonLogs.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-400">
                No live INSTEON engine logs yet.
              </div>
            ) : insteonLogs.map((entry) => {
              const details = formatInsteonLogDetails(entry);
              const levelClassName = entry.level === "error"
                ? "text-rose-300"
                : entry.level === "warn"
                  ? "text-amber-300"
                  : "text-emerald-300";
              const directionLabel = entry.direction === "inbound"
                ? "IN"
                : entry.direction === "outbound"
                  ? "OUT"
                  : entry.direction === "internal"
                    ? "SYS"
                    : null;

              return (
                <div key={entry.id} className="border-b border-slate-800/80 py-2 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                    <span>{formatRelativeTime(entry.timestamp)}</span>
                    <span className={levelClassName}>{entry.level.toUpperCase()}</span>
                    {directionLabel ? <span className="text-sky-300">{directionLabel}</span> : null}
                    {entry.stage ? <span className="text-violet-300">{entry.stage}</span> : null}
                    {entry.operation ? <span className="text-cyan-300">{entry.operation}</span> : null}
                    {entry.address ? <span className="text-amber-300">{entry.address}</span> : null}
                  </div>
                  <div className="mt-1 break-words leading-5 text-slate-100">{entry.message}</div>
                  {details ? (
                    <div className="mt-1 break-all text-[11px] text-slate-400">
                      {details}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
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
