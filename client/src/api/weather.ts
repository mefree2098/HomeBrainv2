import api from "./api"

export interface DashboardWeatherLocation {
  name: string
  latitude: number
  longitude: number
  timezone: string
  source: "saved" | "custom" | "auto"
}

export interface DashboardWeatherCurrent {
  temperatureF: number | null
  apparentTemperatureF: number | null
  humidity: number | null
  windSpeedMph: number | null
  precipitationIn: number | null
  airQualityIndex: number | null
  isDay: boolean
  weatherCode: number | null
  condition: string
  icon: string
}

export interface DashboardWeatherToday {
  highF: number | null
  lowF: number | null
  precipitationChance: number | null
  sunrise: string | null
  sunset: string | null
  weatherCode: number | null
  condition: string
  icon: string
}

export interface WeatherHourlyForecastPoint {
  time: string
  temperatureF: number | null
  precipitationChance: number | null
  windSpeedMph: number | null
  weatherCode: number | null
  condition: string
  icon: string
}

export interface TempestStationMetrics {
  temperatureF: number | null
  feelsLikeF: number | null
  dewPointF: number | null
  humidityPct: number | null
  windLullMph: number | null
  windAvgMph: number | null
  windGustMph: number | null
  windRapidMph: number | null
  windDirectionDeg: number | null
  pressureMb: number | null
  pressureInHg: number | null
  pressureTrend: string
  rainLastMinuteIn: number | null
  rainTodayIn: number | null
  rainRateInPerHr: number | null
  illuminanceLux: number | null
  uvIndex: number | null
  solarRadiationWm2: number | null
  lightningAvgDistanceKm: number | null
  lightningAvgDistanceMiles: number | null
  lightningCount: number | null
  batteryVolts: number | null
}

export interface TempestStationSummary {
  id: string | null
  stationId: number | null
  name: string
  room: string
  model: string
  brand: string
  isOnline: boolean
  observedAt: string | null
  lastEventAt: string | null
  location: {
    latitude: number | null
    longitude: number | null
    timezone: string
  }
  metrics: TempestStationMetrics
  status: {
    sensorStatusFlags: string[]
    firmwareRevision: string
    hubFirmwareRevision: string
    signalRssi: number | null
    hubRssi: number | null
    websocketConnected: boolean
    udpListening: boolean
  }
}

export interface TempestObservationPoint {
  stationId: number
  deviceId: number
  observationType: string
  source: "rest" | "udp" | "ws"
  observedAt: string
  metrics: Record<string, number | null>
  derived: Record<string, number | null | string>
}

export interface TempestEventRecord {
  stationId: number
  deviceId: number
  eventType: "lightning_strike" | "precip_start"
  source: "rest" | "udp" | "ws"
  eventAt: string
  payload: Record<string, number | null>
}

export interface TempestWidgetData {
  available: boolean
  station: TempestStationSummary | null
}

export interface DashboardWeatherPayload {
  fetchedAt: string
  location: DashboardWeatherLocation
  current: DashboardWeatherCurrent
  today: DashboardWeatherToday
  hourlyForecast: WeatherHourlyForecastPoint[]
  tempest: TempestWidgetData
}

export interface WeatherDashboardPayload {
  fetchedAt: string
  forecast: DashboardWeatherPayload
  hourlyForecast: WeatherHourlyForecastPoint[]
  tempest: {
    available: boolean
    station: TempestStationSummary | null
    observations: TempestObservationPoint[]
    events: TempestEventRecord[]
  }
}

interface GetDashboardWeatherOptions {
  address?: string
  latitude?: number
  longitude?: number
  label?: string
}

export const getDashboardWeather = async (options: GetDashboardWeatherOptions = {}) => {
  try {
    const response = await api.get("/api/weather/current", {
      params: options
    })

    return response.data as { success: boolean; weather: DashboardWeatherPayload }
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const getWeatherDashboard = async (options: GetDashboardWeatherOptions & { tempestHistoryHours?: number } = {}) => {
  try {
    const response = await api.get("/api/weather/dashboard", {
      params: options
    })

    return response.data as { success: boolean; dashboard: WeatherDashboardPayload }
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}
