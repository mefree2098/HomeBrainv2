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
  favoriteSceneIds: Set<string>
  onToggleFavorite: (sceneId: string, nextValue: boolean) => void
  canModifyFavorites: boolean
  pendingSceneIds?: Set<string>
}

export function QuickActions({ scenes, onSceneActivate, favoriteSceneIds, onToggleFavorite, canModifyFavorites, pendingSceneIds }: QuickActionsProps) {
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

  const sortedScenes = [...scenes].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  const favoriteScenes = sortedScenes.filter(scene => favoriteSceneIds.has(scene._id))
  const availableScenes = sortedScenes.filter(scene => !favoriteSceneIds.has(scene._id))
  const sceneIsPending = (sceneId: string) => pendingSceneIds?.has(sceneId)

  return (
    <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Play className="h-5 w-5 text-blue-600" />
          Quick Scene Actions
        </CardTitle>
      </CardHeader>
      <CardContent>
        {favoriteScenes.length > 0 ? (
          <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {favoriteScenes.map((scene) => (
              <div key={scene._id} className="relative">
                <Button
                  onClick={() => onSceneActivate(scene._id)}
                  className={`h-16 w-full p-2 flex flex-col items-center justify-center gap-1 bg-gradient-to-r ${getSceneColor(scene.name)} hover:shadow-lg transition-all duration-200 text-white border-0`}
                  title={scene.description}
                >
                  {getSceneIcon(scene.name)}
                  <div className="font-medium text-xs text-center leading-tight truncate max-w-full">
                    {scene.name}
                  </div>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-1 right-1 h-7 w-7 text-white/90 hover:text-red-500"
                  onClick={(event) => {
                    event.stopPropagation()
                    onToggleFavorite(scene._id, false)
                  }}
                  disabled={!canModifyFavorites || !!sceneIsPending(scene._id)}
                  aria-label={`Remove ${scene.name} from quick actions`}
                >
                  <Heart className="h-3.5 w-3.5" fill="currentColor" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-muted-foreground/30 bg-white/60 py-8 text-center text-sm text-muted-foreground">
            <Heart className="h-5 w-5 text-muted-foreground" />
            <p className="max-w-xs">
              {canModifyFavorites
                ? 'No favorite scenes yet. Use the list below to pin your most-used automations.'
                : 'Create an active user profile to enable scene favorites.'}
            </p>
          </div>
        )}

        {availableScenes.length > 0 && (
          <div className="mt-4 space-y-2 border-t border-muted/40 pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {favoriteScenes.length > 0 ? 'Add More Scenes' : 'Start Your Quick Actions'}
            </p>
            <div className="flex flex-wrap gap-2">
              {availableScenes.map(scene => (
                <Button
                  key={scene._id}
                  variant="outline"
                  size="sm"
                  className="flex items-center gap-2"
                  disabled={!canModifyFavorites || !!sceneIsPending(scene._id)}
                  onClick={() => onToggleFavorite(scene._id, true)}
                  title={scene.description}
                >
                  <Heart className="h-3.5 w-3.5 text-red-500" />
                  <span className="text-xs font-medium">{scene.name}</span>
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 text-xs text-muted-foreground text-center">
          Say: "Hey Anna, activate [scene name]" to control with voice
        </div>
      </CardContent>
    </Card>
  )
}
