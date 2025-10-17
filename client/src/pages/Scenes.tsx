import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Play,
  Plus,
  Moon,
  Sun,
  Shield,
  Heart,
  Palette,
  Settings,
  MessageSquare,
  Send,
  Edit,
  Trash2
} from "lucide-react"
import { getScenes, activateScene, createScene, createSceneFromNaturalLanguage, updateScene, deleteScene } from "@/api/scenes"
import { getDevices } from "@/api/devices"
import { useToast } from "@/hooks/useToast"
import { useForm } from "react-hook-form"
import { SceneEditDialog } from "@/components/scenes/SceneEditDialog"
import { useFavorites } from "@/hooks/useFavorites"

export function Scenes() {
  const { toast } = useToast()
  const [scenes, setScenes] = useState([])
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isNaturalLanguageDialogOpen, setIsNaturalLanguageDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [selectedScene, setSelectedScene] = useState<any>(null)
  const { register, handleSubmit, reset, setValue } = useForm()
  const {
    favoriteSceneIds,
    toggleSceneFavorite,
    hasProfile,
    pendingSceneIds
  } = useFavorites()

  useEffect(() => {
    const fetchData = async () => {
      try {
        console.log('Fetching scenes and devices data')
        const [scenesData, devicesData] = await Promise.all([
          getScenes(),
          getDevices()
        ])
        
        setScenes(scenesData.scenes)
        setDevices(devicesData.devices)
      } catch (error) {
        console.error('Failed to fetch data:', error)
        toast({
          title: "Error",
          description: error.message || "Failed to load scenes data",
          variant: "destructive"
        })
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [toast])

  const handleSceneActivation = async (sceneId: string, sceneName: string) => {
    try {
      console.log('Activating scene:', { sceneId, sceneName })
      await activateScene({ sceneId })
      toast({
        title: "Scene Activated",
        description: `${sceneName} scene has been activated successfully`
      })
      
      // Update scene state locally
      setScenes(prev => prev.map(scene => 
        scene._id === sceneId 
          ? { ...scene, active: true }
          : { ...scene, active: false }
      ))
    } catch (error) {
      console.error('Failed to activate scene:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to activate scene",
        variant: "destructive"
      })
    }
  }

  const handleCreateScene = async (data: any) => {
    try {
      console.log('Creating new scene:', data)
      const result = await createScene({
        name: data.name,
        description: data.description,
        devices: [] // In a real app, this would be selected devices
      })

      setScenes(prev => [...prev, result.scene])
      setIsCreateDialogOpen(false)
      reset()

      toast({
        title: "Scene Created",
        description: "New scene has been created successfully"
      })
    } catch (error) {
      console.error('Failed to create scene:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to create scene",
        variant: "destructive"
      })
    }
  }

  const handleCreateSceneFromNaturalLanguage = async (data: any) => {
    setIsProcessing(true)
    try {
      console.log('Creating scene from natural language:', data.description)
      const result = await createSceneFromNaturalLanguage({ description: data.description })

      setScenes(prev => [...prev, result.scene])
      setIsNaturalLanguageDialogOpen(false)
      reset()

      toast({
        title: "Scene Created",
        description: "Your scene has been created successfully from natural language"
      })
    } catch (error) {
      console.error('Failed to create scene from natural language:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to create scene from natural language",
        variant: "destructive"
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const handleEditScene = (scene: any) => {
    setSelectedScene(scene)
    setIsEditDialogOpen(true)
  }

  const handleUpdateScene = async (sceneData: any) => {
    if (!selectedScene) return

    try {
      console.log('Updating scene:', selectedScene._id, sceneData)
      const result = await updateScene(selectedScene._id, sceneData)

      setScenes(prev => prev.map(scene =>
        scene._id === selectedScene._id ? result.scene : scene
      ))
      setIsEditDialogOpen(false)
      setSelectedScene(null)

      toast({
        title: "Scene Updated",
        description: "Scene has been updated successfully"
      })
    } catch (error) {
      console.error('Failed to update scene:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to update scene",
        variant: "destructive"
      })
    }
  }

  const handleDeleteScene = async (sceneId: string, sceneName: string) => {
    if (!confirm(`Are you sure you want to delete the "${sceneName}" scene?`)) {
      return
    }

    try {
      console.log('Deleting scene:', sceneId)
      await deleteScene(sceneId)

      setScenes(prev => prev.filter(scene => scene._id !== sceneId))

      toast({
        title: "Scene Deleted",
        description: `"${sceneName}" scene has been deleted successfully`
      })
    } catch (error) {
      console.error('Failed to delete scene:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to delete scene",
        variant: "destructive"
      })
    }
  }

  const getSceneIcon = (name: string) => {
    const lowerName = name.toLowerCase()
    if (lowerName.includes('movie') || lowerName.includes('night')) return <Moon className="h-6 w-6" />
    if (lowerName.includes('morning') || lowerName.includes('good morning')) return <Sun className="h-6 w-6" />
    if (lowerName.includes('away') || lowerName.includes('security')) return <Shield className="h-6 w-6" />
    if (lowerName.includes('romantic') || lowerName.includes('dinner')) return <Heart className="h-6 w-6" />
    return <Palette className="h-6 w-6" />
  }

  const getSceneGradient = (name: string) => {
    const lowerName = name.toLowerCase()
    if (lowerName.includes('movie') || lowerName.includes('night')) return "from-purple-500 to-indigo-600"
    if (lowerName.includes('morning') || lowerName.includes('good morning')) return "from-yellow-500 to-orange-600"
    if (lowerName.includes('away') || lowerName.includes('security')) return "from-red-500 to-pink-600"
    if (lowerName.includes('romantic') || lowerName.includes('dinner')) return "from-pink-500 to-rose-600"
    return "from-blue-500 to-purple-600"
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            Smart Scenes
          </h1>
          <p className="text-muted-foreground mt-2">
            Create and manage scenes for different occasions
          </p>
        </div>

        <div className="flex gap-2">
          <Dialog open={isNaturalLanguageDialogOpen} onOpenChange={setIsNaturalLanguageDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700 text-white shadow-lg">
                <MessageSquare className="h-4 w-4 mr-2" />
                Natural Language
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-white" aria-describedby="natural-language-scene-description">
              <DialogHeader>
                <DialogTitle>Create Scene with Natural Language</DialogTitle>
                <DialogDescription id="natural-language-scene-description">
                  Describe your scene in natural language and let AI convert it into a working scene.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit(handleCreateSceneFromNaturalLanguage)} className="space-y-4">
                <div>
                  <label className="text-sm font-medium">Describe your scene</label>
                  <Textarea
                    {...register("description", { required: true })}
                    placeholder="e.g., Movie night scene: dim living room lights to 20%, turn off kitchen lights, and close the living room blinds"
                    className="mt-1 min-h-[100px]"
                  />
                </div>
                <div className="text-xs text-muted-foreground bg-blue-50 p-3 rounded">
                  <p className="font-medium mb-2">Examples:</p>
                  <ul className="space-y-1">
                    <li>• "Create a romantic dinner scene with bedroom lights at 50% and soft music"</li>
                    <li>• "Good morning scene: open all blinds and turn on kitchen lights"</li>
                    <li>• "Away mode: turn off all lights, lock all doors, and set thermostat to 68°"</li>
                  </ul>
                </div>
                <div className="flex gap-2 pt-4">
                  <Button type="submit" className="flex-1" disabled={isProcessing}>
                    {isProcessing ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                        Processing...
                      </>
                    ) : (
                      <>
                        <Send className="h-4 w-4 mr-2" />
                        Create Scene
                      </>
                    )}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setIsNaturalLanguageDialogOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white shadow-lg">
                <Plus className="h-4 w-4 mr-2" />
                Create Scene
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-white" aria-describedby="create-scene-description">
              <DialogHeader>
                <DialogTitle>Create New Scene</DialogTitle>
                <DialogDescription id="create-scene-description">
                  Create a new scene to control multiple devices with a single command or action.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit(handleCreateScene)} className="space-y-4">
                <div>
                  <label className="text-sm font-medium">Scene Name</label>
                  <Input
                    {...register("name", { required: true })}
                    placeholder="e.g., Cozy Evening"
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Description</label>
                  <Textarea
                    {...register("description")}
                    placeholder="Describe what this scene does..."
                    className="mt-1"
                  />
                </div>
                <div className="flex gap-2 pt-4">
                  <Button type="submit" className="flex-1">Create Scene</Button>
                  <Button type="button" variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Scene Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20 border-blue-200 dark:border-blue-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Scenes</CardTitle>
            <Palette className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
              {scenes.length}
            </div>
            <p className="text-xs text-blue-600/80 dark:text-blue-400/80">
              Available scenes
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-800/20 border-green-200 dark:border-green-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Scene</CardTitle>
            <Play className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-700 dark:text-green-300">
              {scenes.filter(scene => scene.active).length}
            </div>
            <p className="text-xs text-green-600/80 dark:text-green-400/80">
              Currently running
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 border-purple-200 dark:border-purple-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Devices</CardTitle>
            <Settings className="h-4 w-4 text-purple-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-700 dark:text-purple-300">
              {devices.length}
            </div>
            <p className="text-xs text-purple-600/80 dark:text-purple-400/80">
              Available for scenes
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Scenes Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {scenes.map((scene) => {
          const isFavorite = favoriteSceneIds.has(scene._id)
          const isPendingFavorite = pendingSceneIds.has(scene._id)

          return (
            <Card key={scene._id} className="bg-white/80 backdrop-blur-sm border-0 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105 overflow-hidden">
              <div className={`h-2 bg-gradient-to-r ${getSceneGradient(scene.name)}`} />
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`p-3 rounded-full bg-gradient-to-r ${getSceneGradient(scene.name)} text-white`}>
                      {getSceneIcon(scene.name)}
                    </div>
                    <div>
                      <CardTitle className="text-lg">{scene.name}</CardTitle>
                      <p className="text-sm text-muted-foreground mt-1">
                        {scene.description}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className={`h-8 w-8 ${isFavorite ? 'text-red-500 hover:text-red-500' : 'text-muted-foreground hover:text-red-500'}`}
                      onClick={() => toggleSceneFavorite(scene._id, !isFavorite)}
                      disabled={!hasProfile || isPendingFavorite}
                      aria-label={isFavorite ? `Remove ${scene.name} from favorites` : `Add ${scene.name} to favorites`}
                    >
                      <Heart className="h-4 w-4" fill={isFavorite ? 'currentColor' : 'none'} />
                    </Button>
                    {scene.active && (
                      <Badge className="bg-green-500 text-white animate-pulse">
                        Active
                      </Badge>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{scene.deviceActions?.length || scene.devices?.length || 0} devices</span>
                  <span>Voice enabled</span>
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={() => handleSceneActivation(scene._id, scene.name)}
                    className={`flex-1 bg-gradient-to-r ${getSceneGradient(scene.name)} hover:shadow-lg transition-all duration-200 text-white border-0`}
                    disabled={scene.active}
                  >
                    <Play className="h-4 w-4 mr-2" />
                    {scene.active ? "Scene Active" : "Activate Scene"}
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => handleEditScene(scene)}
                    className="hover:bg-blue-50"
                  >
                    <Edit className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => handleDeleteScene(scene._id, scene.name)}
                    className="hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <div className="text-xs text-muted-foreground bg-gray-50 dark:bg-gray-800 p-2 rounded">
                  <strong>Voice command:</strong> "Hey Anna, activate {scene.name}"
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Edit Scene Dialog */}
      <SceneEditDialog
        open={isEditDialogOpen}
        onOpenChange={setIsEditDialogOpen}
        scene={selectedScene}
        devices={devices}
        onSave={handleUpdateScene}
      />

      {scenes.length === 0 && (
        <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Palette className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Scenes Created</h3>
            <p className="text-muted-foreground text-center mb-4">
              Create your first scene to control multiple devices with a single command
            </p>
            <Button
              onClick={() => setIsCreateDialogOpen(true)}
              className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Your First Scene
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
