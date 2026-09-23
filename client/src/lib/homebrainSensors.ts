export type SensorValue = number | boolean | string | null
export type SensorTelemetryRow = { key: string; label: string; value: string; numeric: boolean; available: boolean; section: string }
export type SensorSnapshot = {
  nodeId?: string; profile?: string; firmwareVersion?: string; hardwareId?: string
  reportingIntervalSeconds?: number; lastReadingAt?: string
  readings?: Record<string, SensorValue>; power?: Record<string, SensorValue>; diagnostics?: Record<string, SensorValue>
}

export const SENSOR_METRICS: Record<string, [string, string]> = {
  temperature_c: ['Temperature', '°C'], temperature_f: ['Temperature', '°F'], humidity_pct: ['Humidity', '%'],
  dew_point_c: ['Dew point', '°C'], dew_point_f: ['Dew point', '°F'], absolute_humidity_gm3: ['Absolute humidity', 'g/m³'],
  pressure_hpa: ['Pressure', 'hPa'], gas_resistance_ohms: ['Gas resistance', 'Ω'],
  air_quality_score: ['Air quality score (estimate)', '/100'], voc_trend_index: ['VOC trend (relative)', ''],
  comfort_score: ['Comfort score (estimate)', '/100'], mold_risk_score: ['Mold risk score (estimate)', '/100'],
  co2_ppm: ['CO₂', 'ppm'], pm1_0_ugm3: ['PM1.0', 'µg/m³'], pm2_5_ugm3: ['PM2.5', 'µg/m³'], pm10_ugm3: ['PM10', 'µg/m³'],
  illuminance_lux: ['Light', 'lux'], presence_present: ['Presence', ''], moving_distance_cm: ['Moving target distance', 'cm'],
  stationary_distance_cm: ['Stationary target distance', 'cm'], moving_energy_pct: ['Moving target energy', '%'],
  stationary_energy_pct: ['Stationary target energy', '%'], battery_volts: ['Battery voltage', 'V'], battery_pct: ['Battery', '%'],
  usb_powered: ['USB powered', ''], signal_rssi_dbm: ['Wi-Fi signal', 'dBm'], uptime_ms: ['Uptime', 'ms'],
  wake_count: ['Wake count', ''], free_heap_bytes: ['Free memory', 'bytes'], ip_address: ['Local IP', ''],
  temperature_source: ['Temperature source', ''], bme680_available: ['BME680', ''], scd41_available: ['SCD41', ''],
  veml7700_available: ['VEML7700', ''], pms5003_available: ['PMS5003', ''], ld2410_available: ['LD2410', ''], dht11_available: ['DHT11', '']
}
const CLIMATE = ['temperature_f', 'temperature_c', 'humidity_pct', 'dew_point_c', 'absolute_humidity_gm3', 'comfort_score', 'mold_risk_score']
export const SENSOR_PROFILE_METRICS: Record<string, string[]> = {
  'air-station': [...CLIMATE, 'co2_ppm', 'pm1_0_ugm3', 'pm2_5_ugm3', 'pm10_ugm3', 'illuminance_lux', 'pressure_hpa', 'gas_resistance_ohms', 'voc_trend_index', 'air_quality_score'],
  presence: [...CLIMATE, 'illuminance_lux', 'presence_present', 'moving_distance_cm', 'stationary_distance_cm', 'moving_energy_pct', 'stationary_energy_pct'],
  climate: CLIMATE
}
export function sensorSnapshot(device: { properties?: Record<string, unknown> } | null | undefined): SensorSnapshot | null {
  const value = device?.properties?.homebrainSensor
  return value && typeof value === 'object' && !Array.isArray(value) ? value as SensorSnapshot : null
}
export function sensorTelemetryRows(sensor: SensorSnapshot): SensorTelemetryRow[] {
  const rows: SensorTelemetryRow[] = []
  for (const [section, values, expected] of [
    ['Measurements', sensor.readings || {}, SENSOR_PROFILE_METRICS[sensor.profile || ''] || []],
    ['Power', sensor.power || {}, []], ['Diagnostics', sensor.diagnostics || {}, []]
  ] as Array<[string, Record<string, SensorValue>, string[]]>) {
    for (const key of new Set([...expected, ...Object.keys(values)])) {
      const value = values[key]
      const available = value !== null && value !== undefined && (typeof value !== 'number' || Number.isFinite(value))
      const [label, unit] = SENSOR_METRICS[key] || [key.replace(/_/g, ' '), '']
      const formatted = !available ? 'Unavailable' : typeof value === 'boolean'
        ? key.endsWith('_available') ? value ? 'Reporting' : 'Not reporting'
          : key === 'presence_present' ? value ? 'Present' : 'Clear' : value ? 'Yes' : 'No'
        : typeof value === 'number' ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: key === 'battery_volts' ? 3 : 2 }).format(value)}${unit ? ` ${unit}` : ''}`
          : String(value)
      rows.push({ key, label, value: formatted, available, numeric: available && (typeof value === 'number' || typeof value === 'boolean'), section })
    }
  }
  return rows
}
export function sensorSummary(sensor: SensorSnapshot): string {
  const preferred = sensor.profile === 'presence' ? ['presence_present', 'temperature_f', 'humidity_pct', 'illuminance_lux']
    : sensor.profile === 'climate' ? ['temperature_f', 'humidity_pct', 'battery_pct'] : ['co2_ppm', 'pm2_5_ugm3', 'humidity_pct', 'illuminance_lux']
  const rows = sensorTelemetryRows(sensor)
  return preferred.map(key => rows.find(row => row.key === key && row.available)).filter(Boolean).map(row => `${row!.label}: ${row!.value}`).join(' · ')
}
