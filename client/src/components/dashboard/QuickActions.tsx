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
    <Card className="rounded-[1.85rem]">
      <CardHeader>
        <p className="section-kicker">Scene Launchpad</p>
        <CardTitle className="mt-2 flex items-center gap-2 text-2xl">
          <Play className="h-5 w-5 text-cyan-600 dark:text-cyan-300" />
          Quick Scene Actions
        </CardTitle>
      </CardHeader>
      <CardContent>
        {favoriteScenes.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {favoriteScenes.map((scene) => (
              <div key={scene._id} className="relative">
                <Button
                  onClick={() => onSceneActivate(scene._id)}
                  className={`h-24 w-full rounded-[1.35rem] p-3 flex-col items-start justify-between border-0 bg-gradient-to-br ${getSceneColor(scene.name)} text-left text-white shadow-lg shadow-black/10`}
                  title={scene.description}
                >
                  <div className="flex w-full items-center justify-between">
                    <span className="rounded-full bg-white/15 p-2">
                      {getSceneIcon(scene.name)}
                    </span>
                    <span className="text-[10px] uppercase tracking-[0.22em] text-white/80">Launch</span>
                  </div>
                  <div className="w-full">
                    <div className="font-medium text-sm leading-tight">{scene.name}</div>
                    <div className="mt-1 line-clamp-1 text-xs text-white/75">
                      {scene.description || "Instantly orchestrate this scene."}
                    </div>
                  </div>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-2 h-8 w-8 text-white/90 hover:bg-white/15 hover:text-white"
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
          <div className="flex flex-col items-center justify-center gap-2 rounded-[1.5rem] border border-dashed border-white/20 bg-white/10 py-8 text-center text-sm text-muted-foreground dark:bg-slate-950/20">
            <Heart className="h-5 w-5 text-muted-foreground" />
            <p className="max-w-xs">
              {canModifyFavorites
                ? 'No favorite scenes yet. Use the list below to pin your most-used automations.'
                : 'Create an active user profile to enable scene favorites.'}
            </p>
          </div>
        )}

        {availableScenes.length > 0 && (
          <div className="mt-5 space-y-3 border-t border-white/10 pt-5 dark:border-cyan-200/10">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
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

        <div className="mt-5 text-xs text-muted-foreground">
          Say: "Hey Anna, activate [scene name]" to trigger any scene by voice.
        </div>
      </CardContent>
    </Card>
  )
}
