import { describe, expect, it } from 'vitest'
import { SENSOR_PROFILE_METRICS, sensorSnapshot, sensorSummary, sensorTelemetryRows } from './homebrainSensors'

describe('HomeBrain sensor telemetry', () => {
  it.each(['air-station', 'presence', 'climate'])('shows every expected %s measurement, without inventing missing values', profile => {
    const rows = sensorTelemetryRows({ profile, readings: { temperature_f: 0, humidity_pct: 0 } })
    expect(rows.map(row => row.key)).toEqual(SENSOR_PROFILE_METRICS[profile])
    expect(rows.find(row => row.key === 'temperature_f')).toMatchObject({ available: true, value: '0 °F', numeric: true })
    expect(rows.find(row => row.key === 'dew_point_c')).toMatchObject({ available: false, value: 'Unavailable', numeric: false })
  })
  it('distinguishes missing, false, zero, and module failure; exposes all extra telemetry', () => {
    const rows = sensorTelemetryRows({ profile: 'presence', readings: { presence_present: false, illuminance_lux: 0, pressure_hpa: null },
      power: { battery_pct: 0, battery_volts: 3.205, usb_powered: false },
      diagnostics: { dht11_available: false, ld2410_available: true, ip_address: '192.0.2.1', uptime_ms: 0, free_heap_bytes: Number.NaN } })
    const values = Object.fromEntries(rows.map(row => [row.key, row]))
    expect(values.presence_present.value).toBe('Clear')
    expect(values.illuminance_lux.value).toBe('0 lux')
    expect(values.battery_pct.value).toBe('0 %')
    expect(values.usb_powered.value).toBe('No')
    expect(values.dht11_available).toMatchObject({ value: 'Not reporting', numeric: true })
    expect(values.ld2410_available.value).toBe('Reporting')
    expect(values.ip_address.numeric).toBe(false)
    expect(values.free_heap_bytes.available).toBe(false)
    expect(values.pressure_hpa.available).toBe(false)
  })
  it('identifies custom devices and offers profile-specific card summaries', () => {
    expect(sensorSnapshot({ properties: { homebrainSensor: [] } })).toBeNull()
    expect(sensorSnapshot({ properties: { source: 'tempest' } })).toBeNull()
    expect(sensorSummary({ profile: 'climate', readings: { temperature_f: 70, humidity_pct: 45 }, power: { battery_pct: 90 } }))
      .toBe('Temperature: 70 °F · Humidity: 45 % · Battery: 90 %')
    expect(sensorSummary({ profile: 'air-station', readings: { co2_ppm: 800, pm2_5_ugm3: 0 } })).toContain('PM2.5: 0 µg/m³')
  })
})
