import { Link } from 'react-router'
import { sensorTelemetryRows, type SensorSnapshot } from '@/lib/homebrainSensors'

export function HomeBrainSensorTelemetry({ sensor, deviceId, isOnline }: { sensor: SensorSnapshot; deviceId?: string | null; isOnline?: boolean }) {
  const rows = sensorTelemetryRows(sensor)
  return <section className="space-y-4" aria-label="HomeBrain sensor telemetry">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-semibold">Sensor suite telemetry</h3>
        <p className="text-xs text-muted-foreground">Firmware {sensor.firmwareVersion || 'unknown'} · {sensor.hardwareId || sensor.profile}</p>
        <p className="text-xs text-muted-foreground">{isOnline === false ? 'Offline · Last reported values' : 'Latest report'}{sensor.lastReadingAt ? ` · ${new Date(sensor.lastReadingAt).toLocaleString()}` : ' · Awaiting timestamp'}</p></div>
      {deviceId && <Link className="text-sm font-medium text-primary underline" to={`/data-platform?sourceKey=${encodeURIComponent(`device:${deviceId}`)}`}>View all history graphs</Link>}
    </div>
    {['Measurements', 'Power', 'Diagnostics'].map(section => <div key={section} className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section}</h4>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{rows.filter(row => row.section === section).map(row => {
        const contents = <><span className="block text-xs text-muted-foreground">{row.label}</span><span className={`block break-words font-semibold ${!row.available || row.value === 'Not reporting' ? 'text-amber-600 dark:text-amber-400' : ''}`}>{row.value}</span></>
        const style = 'rounded-lg border border-border/60 p-3'
        return row.numeric && deviceId ? <Link key={row.key} className={`${style} hover:bg-muted/50`} title={`View ${row.label} history`} to={`/data-platform?sourceKey=${encodeURIComponent(`device:${deviceId}`)}&metric=${encodeURIComponent(row.key)}`}>{contents}</Link>
          : <div key={row.key} className={style}>{contents}</div>
      })}</div>
    </div>)}
    <p className="text-xs text-muted-foreground">Unavailable is not zero. Online means connected, not that every module is healthy. Air, comfort, mold-risk and VOC-trend scores are estimates, not certified measurements.</p>
  </section>
}
