import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  CalendarClock,
  CheckCircle,
  Database,
  ExternalLink,
  Loader2,
  RefreshCw
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  getDeviceCatalogSummary,
  getDeviceCatalogUpdateStatus,
  runDeviceCatalogUpdate,
  type DeviceCatalogProtocol,
  type DeviceCatalogProtocolSummary,
  type DeviceCatalogSummary,
  type DeviceCatalogUpdateSource,
  type DeviceCatalogUpdateStatus,
  type DeviceLibraryUpdateServiceStatus
} from "@/api/directRadios"
import { useToast } from "@/hooks/useToast"
import { cn } from "@/lib/utils"

const CATALOG_PROTOCOLS: Array<{
  key: DeviceCatalogProtocol;
  label: string;
  className: string;
}> = [
  { key: "zigbee", label: "Zigbee", className: "border-emerald-500/30 bg-emerald-500/10" },
  { key: "zwave", label: "Z-Wave", className: "border-sky-500/30 bg-sky-500/10" },
  { key: "matter", label: "Matter", className: "border-violet-500/30 bg-violet-500/10" },
  { key: "thread", label: "Thread", className: "border-teal-500/30 bg-teal-500/10" },
  { key: "insteon", label: "INSTEON", className: "border-amber-500/30 bg-amber-500/10" }
]

const EXTERNAL_UPDATE_PROTOCOLS: DeviceCatalogProtocol[] = ["matter", "thread", "insteon"]

const toErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (typeof error === "string" && error.trim()) {
    return error
  }
  return fallback
}

const formatDateTime = (value?: string | null) => {
  if (!value) return "Never"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  })
}

const formatCount = (value?: number | null) => (
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "0"
)

const protocolSummary = (
  summary: DeviceCatalogSummary | null,
  protocol: DeviceCatalogProtocol
): DeviceCatalogProtocolSummary | undefined => summary?.[protocol]

const primaryProtocolCount = (protocol: DeviceCatalogProtocol, summary?: DeviceCatalogProtocolSummary) => {
  if (!summary) return 0
  if (protocol === "zigbee") return summary.definitionCount || 0
  if (protocol === "zwave") return summary.deviceConfigCount || 0
  if (protocol === "matter") return summary.certifiedProductCount || 0
  if (protocol === "thread") return summary.certifiedProductCount || 0
  if (protocol === "insteon") return summary.productEntryCount || summary.entryCount || 0
  return 0
}

const protocolSubtitle = (protocol: DeviceCatalogProtocol, summary?: DeviceCatalogProtocolSummary) => {
  if (!summary) return "No catalog loaded"
  if (protocol === "zigbee") {
    return `${formatCount(summary.vendorCount)} vendors, ${formatCount(summary.exposesCount)} exposes`
  }
  if (protocol === "zwave") {
    return `${formatCount(summary.manufacturerCount)} manufacturers`
  }
  if (protocol === "matter") {
    return `${formatCount(summary.standardDeviceTypeCount)} standard types, ${formatCount(summary.vendorProductCount)} vendors`
  }
  if (protocol === "thread") {
    return summary.snapshot?.updatedAt ? `Snapshot ${formatDateTime(summary.snapshot.updatedAt)}` : "Matter-over-Thread enrichment"
  }
  return `${formatCount(summary.categoryCount)} categories, ${formatCount(summary.entryCount)} profiles`
}

const updateSourceFor = (
  updateStatus: DeviceCatalogUpdateStatus | null,
  protocol: DeviceCatalogProtocol
): DeviceCatalogUpdateSource | undefined => updateStatus?.sources?.[protocol]

const sumAddedCount = (updateStatus: DeviceCatalogUpdateStatus | null) => (
  EXTERNAL_UPDATE_PROTOCOLS.reduce((sum, protocol) => (
    sum + (updateSourceFor(updateStatus, protocol)?.addedCount || 0)
  ), 0)
)

function StatusMetric({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/55 p-3">
      <p className="text-[11px] font-medium uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  )
}

function ProtocolTile({
  protocol,
  summary,
  updateSource
}: {
  protocol: typeof CATALOG_PROTOCOLS[number];
  summary?: DeviceCatalogProtocolSummary;
  updateSource?: DeviceCatalogUpdateSource;
}) {
  const errors = Array.isArray(summary?.errors) ? summary.errors.length : 0
  const added = updateSource?.addedCount || 0
  return (
    <div className={cn("rounded-lg border p-3", protocol.className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-normal">{protocol.label}</p>
        {errors > 0 ? (
          <Badge variant="destructive">{errors} errors</Badge>
        ) : (
          <Badge variant="outline">Ready</Badge>
        )}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{formatCount(primaryProtocolCount(protocol.key, summary))}</p>
      <p className="mt-1 min-h-8 text-xs text-muted-foreground">{protocolSubtitle(protocol.key, summary)}</p>
      {EXTERNAL_UPDATE_PROTOCOLS.includes(protocol.key) ? (
        <p className="mt-2 text-xs font-medium text-foreground">
          {formatCount(added)} new last check
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Package backed
        </p>
      )}
    </div>
  )
}

function SourceRow({
  protocol,
  source
}: {
  protocol: DeviceCatalogProtocol;
  source?: DeviceCatalogUpdateSource;
}) {
  const label = CATALOG_PROTOCOLS.find((entry) => entry.key === protocol)?.label || protocol
  const success = source?.success !== false && !source?.error
  return (
    <div className="grid gap-3 rounded-lg border border-border/60 bg-background/45 p-3 md:grid-cols-[1fr_0.8fr_0.8fr_0.8fr_auto] md:items-center">
      <div>
        <div className="flex items-center gap-2">
          {success ? <CheckCircle className="h-4 w-4 text-emerald-500" /> : <AlertCircle className="h-4 w-4 text-red-500" />}
          <p className="text-sm font-medium">{label}</p>
        </div>
        {source?.sourceUrl ? (
          <a
            href={source.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            <span className="truncate">{source.sourceUrl}</span>
          </a>
        ) : null}
        {source?.error ? <p className="mt-1 text-xs text-red-600 dark:text-red-300">{source.error}</p> : null}
      </div>
      <StatusMetric label="Added" value={formatCount(source?.addedCount)} />
      <StatusMetric label="Fetched" value={formatCount(source?.fetchedCount)} />
      <StatusMetric label="Total" value={formatCount(source?.totalCount)} />
      <Badge variant={success ? "secondary" : "destructive"} className="w-fit">
        {success ? "Successful" : "Failed"}
      </Badge>
    </div>
  )
}

export function DeviceCatalogUpdateCard() {
  const { toast } = useToast()
  const [summary, setSummary] = useState<DeviceCatalogSummary | null>(null)
  const [updateStatus, setUpdateStatus] = useState<DeviceCatalogUpdateStatus | null>(null)
  const [updateService, setUpdateService] = useState<DeviceLibraryUpdateServiceStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [checkingNow, setCheckingNow] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const loadCatalogState = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!quiet) {
      setLoading(true)
    }
    setErrorMessage(null)
    try {
      const [statusResponse, summaryResponse] = await Promise.all([
        getDeviceCatalogUpdateStatus(),
        getDeviceCatalogSummary()
      ])
      setUpdateStatus(statusResponse.status || statusResponse.update?.catalogUpdate || null)
      setUpdateService(statusResponse.update || null)
      setSummary(summaryResponse.summary || null)
    } catch (error) {
      const message = toErrorMessage(error, "Unable to load the device catalog update status.")
      setErrorMessage(message)
      if (!quiet) {
        toast({
          title: "Device catalog status unavailable",
          description: message,
          variant: "destructive"
        })
      }
    } finally {
      if (!quiet) {
        setLoading(false)
      }
    }
  }, [toast])

  useEffect(() => {
    void loadCatalogState()
  }, [loadCatalogState])

  useEffect(() => {
    if (!updateService?.running && !checkingNow) {
      return undefined
    }
    const timer = window.setInterval(() => {
      void loadCatalogState({ quiet: true })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [checkingNow, loadCatalogState, updateService?.running])

  const handleCheckNow = async () => {
    setCheckingNow(true)
    setErrorMessage(null)
    try {
      const response = await runDeviceCatalogUpdate({ force: true })
      const resultStatus = response.result?.status || response.update?.catalogUpdate || updateStatus
      const addedCount = sumAddedCount(resultStatus || null)
      toast({
        title: response.success ? "Device catalog check complete" : "Device catalog check finished with errors",
        description: `${formatCount(addedCount)} new external device record${addedCount === 1 ? "" : "s"} added.`
      })
      await loadCatalogState({ quiet: true })
    } catch (error) {
      toast({
        title: "Device catalog check failed",
        description: toErrorMessage(error, "Unable to refresh the device catalog sources."),
        variant: "destructive"
      })
    } finally {
      setCheckingNow(false)
    }
  }

  const isBusy = checkingNow || updateService?.running
  const updateErrors = updateStatus?.errors || []
  const addedCount = useMemo(() => sumAddedCount(updateStatus), [updateStatus])
  const statusLabel = isBusy
    ? "Checking now"
    : updateErrors.length > 0
      ? "Last check failed"
      : updateStatus?.lastSuccessAt
        ? "Last check successful"
        : "Not checked yet"

  return (
    <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
      <CardHeader className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5 text-violet-600" />
              Device Catalog Library
            </CardTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              Catalog coverage, source refresh status, new external records, and the monthly update schedule.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={updateService?.scheduled ? "secondary" : "outline"} className="gap-1">
              <CalendarClock className="h-3 w-3" />
              {updateService?.scheduled ? "Monthly job active" : "Scheduler inactive"}
            </Badge>
            <Badge variant={updateErrors.length > 0 ? "destructive" : "secondary"} className="gap-1">
              {updateErrors.length > 0 ? <AlertCircle className="h-3 w-3" /> : <CheckCircle className="h-3 w-3" />}
              {statusLabel}
            </Badge>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void loadCatalogState()} disabled={loading || isBusy}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh Status
          </Button>
          <Button type="button" size="sm" onClick={() => void handleCheckNow()} disabled={loading || isBusy}>
            {isBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Check Now
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {errorMessage ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-200">
            {errorMessage}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatusMetric label="Last Run" value={formatDateTime(updateStatus?.lastRunAt)} />
          <StatusMetric label="Last Success" value={formatDateTime(updateStatus?.lastSuccessAt)} />
          <StatusMetric label="Next Scheduled" value={formatDateTime(updateStatus?.nextDueAt)} detail={updateStatus?.due ? "Due now" : "Monthly cadence"} />
          <StatusMetric label="New Last Check" value={formatCount(addedCount)} detail="Matter, Thread, INSTEON sources" />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {CATALOG_PROTOCOLS.map((protocol) => (
            <ProtocolTile
              key={protocol.key}
              protocol={protocol}
              summary={protocolSummary(summary, protocol.key)}
              updateSource={updateSourceFor(updateStatus, protocol.key)}
            />
          ))}
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h4 className="text-sm font-semibold">External Source Updates</h4>
            <Badge variant="outline">
              Generated {formatDateTime(summary?.generatedAt)}
            </Badge>
          </div>
          {EXTERNAL_UPDATE_PROTOCOLS.map((protocol) => (
            <SourceRow
              key={protocol}
              protocol={protocol}
              source={updateSourceFor(updateStatus, protocol)}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export default DeviceCatalogUpdateCard
