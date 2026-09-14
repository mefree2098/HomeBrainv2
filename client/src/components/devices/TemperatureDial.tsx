import "./device-visuals.css"
/** Decorative gauge; temperature controls and accessible values remain real DOM. */
export function TemperatureDial({ temperature, mode }: { temperature: number; mode: string }) {
  const fraction = Math.max(0, Math.min(1, (temperature - 55) / 35))
  return (
    <div className="hb-temperature-dial" aria-label={`Target ${temperature} degrees Fahrenheit`}>
      <svg viewBox="0 0 200 170" aria-hidden="true">
        <path d="M 35 143 A 80 80 0 1 1 165 143" fill="none" stroke="currentColor" strokeOpacity="0.08" strokeWidth="10" strokeLinecap="round" />
        <path d="M 35 143 A 80 80 0 1 1 165 143" fill="none" stroke="hsl(var(--device-accent))" opacity={mode === "off" ? 0.35 : 1} strokeWidth="10" strokeLinecap="round" pathLength="100" strokeDasharray={`${fraction * 100} 100`} />
      </svg>
      <div className="hb-temperature-dial-copy"><span className="hb-temperature-dial-value">{temperature}°</span><span className="hb-device-caption">Target · °F</span></div>
    </div>
  )
}
