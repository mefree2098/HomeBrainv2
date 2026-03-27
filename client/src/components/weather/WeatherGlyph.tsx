import {
  Cloud,
  CloudFog,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  MoonStar,
  ThermometerSun,
  Zap
} from "lucide-react"

export function WeatherGlyph({ icon, isDay, className }: { icon: string; isDay: boolean; className?: string }) {
  switch (icon) {
    case "sunny":
      return isDay ? <ThermometerSun className={className} /> : <MoonStar className={className} />
    case "partly-cloudy":
      return isDay ? <CloudSun className={className} /> : <CloudMoon className={className} />
    case "fog":
      return <CloudFog className={className} />
    case "drizzle":
    case "rain":
      return <CloudRain className={className} />
    case "sleet":
    case "snow":
      return <CloudSnow className={className} />
    case "storm":
      return <Zap className={className} />
    default:
      return <Cloud className={className} />
  }
}
