import { Camera, DoorOpen, Home, Lightbulb, Lock, Power, Radio, ShieldAlert, Speaker, Thermometer, Wind } from "lucide-react"
import "./device-visuals.css"

/** Shared visual identity; device capabilities still determine available actions. */
export function DeviceSymbol({ type }: { type: string }) {
  const Icon = ({ light: Lightbulb, switch: Power, lock: Lock, thermostat: Thermometer,
    sensor: Radio, camera: Camera, garage: DoorOpen, siren: ShieldAlert,
    speaker: Speaker, fan: Wind } as Record<string, typeof Home>)[type] || Home
  return <span className="hb-device-icon" aria-hidden="true"><Icon /></span>
}
