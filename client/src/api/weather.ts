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

export interface DashboardWeatherPayload {
  fetchedAt: string
  location: DashboardWeatherLocation
  current: DashboardWeatherCurrent
  today: DashboardWeatherToday
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
