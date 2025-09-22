import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Play, Moon, Sun, Shield, Heart } from "lucide-react"

interface Scene {
  _id: string
  name: string
  description: string
  devices: Array<string>
  active: boolean
}

interface QuickActionsProps {
  scenes: Scene[]
  onSceneActivate: (sceneId: string) => void
}

export function QuickActions({ scenes, onSceneActivate }: QuickActionsProps) {
  const getSceneIcon = (name: string) => {
    const lowerName = name.toLowerCase()
    if (lowerName.includes('movie') || lowerName.includes('night')) return <Moon className="h-4 w-4" />
    if (lowerName.includes('morning') || lowerName.includes('good morning')) return <Sun className="h-4 w-4" />
    if (lowerName.includes('away') || lowerName.includes('security')) return <Shield className="h-4 w-4" />
    if (lowerName.includes('romantic') || lowerName.includes('dinner')) return <Heart className="h-4 w-4" />
    return <Play className="h-4 w-4" />
  }

  const getSceneColor = (name: string) => {
    const lowerName = name.toLowerCase()
    if (lowerName.includes('movie') || lowerName.includes('night')) return "from-purple-500 to-indigo-600"
    if (lowerName.includes('morning') || lowerName.includes('good morning')) return "from-yellow-500 to-orange-600"
    if (lowerName.includes('away') || lowerName.includes('security')) return "from-red-500 to-pink-600"
    if (lowerName.includes('romantic') || lowerName.includes('dinner')) return "from-pink-500 to-rose-600"
    return "from-blue-500 to-purple-600"
  }

  return (
    <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Play className="h-5 w-5 text-blue-600" />
          Quick Scene Actions
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {scenes.slice(0, 5).map((scene) => (
            <Button
              key={scene._id}
              onClick={() => onSceneActivate(scene._id)}
              className={`h-16 p-2 flex flex-col items-center justify-center gap-1 bg-gradient-to-r ${getSceneColor(scene.name)} hover:shadow-lg transition-all duration-200 text-white border-0`}
              title={scene.description} // Show full description on hover
            >
              {getSceneIcon(scene.name)}
              <div className="font-medium text-xs text-center leading-tight truncate max-w-full">
                {scene.name}
              </div>
            </Button>
          ))}
        </div>
        <div className="mt-3 text-xs text-muted-foreground text-center">
          Say: "Hey Anna, activate [scene name]" to control with voice
        </div>
      </CardContent>
    </Card>
  )
}