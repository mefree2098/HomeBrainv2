import { useEffect, useState } from "react"
import { controlDevice } from "@/api/devices"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type ApplianceDevice = {
  _id?: string; id?: string; name: string; status?: boolean; isOnline?: boolean;
  temperature?: number; targetTemperature?: number; properties?: Record<string, any>;
}

export function ApplianceControls({ device: input }: { device: ApplianceDevice }) {
  const [device, setDevice] = useState(input)
  const [target, setTarget] = useState(String(input.targetTemperature ?? ""))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => { setDevice(input); setTarget(String(input.targetTemperature ?? "")) }, [input])
  const state = device.properties?.appliance || {}
  const caps = state.capabilities || {}
  const heater = device.properties?.source === "econet"
  const send = async (action: string, value?: unknown) => {
    setBusy(true); setError("")
    try {
      const result = await controlDevice({ deviceId: String(device._id || device.id), action, value })
      if (result.device) { setDevice(result.device); setTarget(String(result.device.targetTemperature ?? "")) }
    } catch (err) { setError(err instanceof Error ? err.message : "Command failed") }
    finally { setBusy(false) }
  }
  const select = (title: string, current: string | number, choices: string[], action: string) => choices?.length ? (
    <Label className="grid gap-1" key={action}>{title}
      <select aria-label={`${device.name} ${title}`} className="rounded-md border bg-background p-2" disabled={busy} value={String(current ?? "")} onChange={(event) => void send(action, event.target.value)}>
        {!choices.includes(String(current)) && <option value={String(current ?? "")}>{String(current ?? "Choose")}</option>}
        {choices.map((choice) => <option key={choice} value={choice}>{choice.replaceAll("_", " ")}</option>)}
      </select>
    </Label>
  ) : null

  return <div className="space-y-3" onClick={(event) => event.stopPropagation()}>
    <p className="text-sm text-muted-foreground">{device.isOnline ? "Connected" : "Offline — last known readings"}{state.observedAt ? ` · ${new Date(state.observedAt).toLocaleTimeString()}` : ""}</p>
    {heater ? <dl className="grid grid-cols-2 gap-2 text-sm">
      {Object.entries({ "Setpoint": device.targetTemperature == null ? null : `${device.targetTemperature}°F`, "State": state.runningState, "Mode": state.mode, "Active alerts": state.alertCount, "Wi-Fi signal": state.wifiSignal == null ? null : `${state.wifiSignal} dBm`, "Water today": state.waterUsageToday == null ? null : `${state.waterUsageToday} gal`, "Energy today": state.energyUsageToday == null ? null : `${state.energyUsageToday} ${state.energyType || ""}`, "Leak sensor installed": state.leakSensorInstalled, "Shutoff valve open": state.shutoffValveOpen }).filter(([, value]) => value !== null && value !== undefined && value !== "").map(([key, value]) => <div key={key}><dt className="text-muted-foreground">{key}</dt><dd>{typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}</dd></div>)}
    </dl> : <>
      <p>{device.temperature == null ? "Room temperature unavailable" : `${device.temperature}°F in the room`} · {state.mode || "Unknown mode"}</p>
      <Button className="w-full" disabled={busy} onClick={() => void send(device.status ? "turn_off" : "turn_on")}>{busy ? "Waiting for AC confirmation…" : device.status ? "Turn Off" : "Turn On"}</Button>
      <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void send("set_temperature", Number(target)) }}>
        <Label className="grid flex-1 gap-1">Target °F<Input type="number" required step="0.1" min={caps.minTemperature} max={caps.maxTemperature} value={target} onChange={(event) => setTarget(event.target.value)} disabled={busy} /></Label>
        <Button disabled={busy} type="submit">Set</Button>
      </form>
      <p className="text-xs text-muted-foreground">Range {caps.minTemperature}–{caps.maxTemperature}°F. The AC rounds to its supported temperature increments.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {select("Mode", state.mode, caps.modes, "set_mode")}
        {select("Fan speed", state.fanSpeed, caps.fanSpeeds, "set_fan_speed")}
        {select("Swing", state.swing, caps.swings, "set_swing")}
      </div>
      <div className="flex flex-wrap gap-2">{["eco", "turbo", "sleep"].filter((key) => caps[key]).map((key) => <Button key={key} variant={state[key] ? "default" : "outline"} aria-pressed={Boolean(state[key])} disabled={busy} onClick={() => void send(`set_${key}`, !state[key])}>{key}</Button>)}</div>
      {state.errorCode ? <p role="alert">AC reports error code {state.errorCode}.</p> : null}
      {state.filterAlert ? <p role="status">The AC reports a filter maintenance reminder.</p> : null}
    </>}
    {error || state.lastError ? <p role="alert" className="text-sm text-destructive">{error || state.lastError}</p> : null}
  </div>
}
