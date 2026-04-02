import api from "./api"

export interface TelemetryMetricDescriptor {
  key: string
  label: string
  unit: string
  binary: boolean
}

export interface TelemetrySourceSummary {
  sourceKey: string
  sourceType: "device" | "tempest_station"
  sourceId: string
  name: string
  category: string
  room: string
  origin: string
  streamType: "device_state" | "tempest_observation"
  sampleCount: number
  metricCount: number
  lastSampleAt: string | null
  availableMetrics: TelemetryMetricDescriptor[]
  featuredMetricKeys: string[]
  lastValues: Record<string, number | null>
}

export interface TelemetryOverviewPayload {
  retentionDays: number
  totalSamples: number
  sourceCount: number
  lastSampleAt: string | null
  streamCounts: Record<string, number>
  sourceTypeCounts: Record<string, number>
  sources: TelemetrySourceSummary[]
}

export interface TelemetrySeriesPoint {
  observedAt: string
  values: Record<string, number | null>
}

export interface TelemetryMetricStats {
  key: string
  latest: number | null
  min: number | null
  max: number | null
  average: number | null
}

export interface TelemetrySeriesPayload {
  source: TelemetrySourceSummary
  metrics: TelemetryMetricDescriptor[]
  range: {
    hours: number
    startAt: string
    endAt: string
    rawPointCount: number
    pointCount: number
    maxPoints: number
  }
  points: TelemetrySeriesPoint[]
  stats: TelemetryMetricStats[]
}

export const getTelemetryOverview = async () => {
  try {
    const response = await api.get("/api/telemetry/overview")
    return response.data as { success: boolean; data: TelemetryOverviewPayload }
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const getTelemetrySeries = async (options: {
  sourceKey: string
  metricKeys?: string[]
  hours?: number
  maxPoints?: number
}) => {
  try {
    const response = await api.get("/api/telemetry/series", {
      params: {
        ...options,
        metricKeys: Array.isArray(options.metricKeys) ? options.metricKeys.join(",") : undefined
      }
    })

    return response.data as { success: boolean; data: TelemetrySeriesPayload }
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const clearTelemetryData = async (options: {
  sourceKey?: string
}) => {
  try {
    const response = await api.delete("/api/telemetry", {
      params: options
    })

    return response.data as {
      success: boolean
      message: string
      data: {
        scope: string
        telemetryDeleted: number
        energyDeleted: number
        tempestObservationsDeleted: number
        tempestEventsDeleted: number
      }
    }
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}
