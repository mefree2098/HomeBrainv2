import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
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
  Settings
} from "lucide-react"
import { getScenes, activateScene, createScene } from "@/api/scenes"
import { getDevices } from "@/api/devices"
import { useToast } from "@/hooks/useToast"
import { useForm } from "react-hook-form"

export function Scenes() {
  const { toast } = useToast()
  const [scenes, setScenes] = useState([])
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const { register, handleSubmit, reset } = useForm()

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
        
        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white shadow-lg">
              <Plus className="h-4 w-4 mr-2" />
              Create Scene
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-white">
            <DialogHeader>
              <DialogTitle>Create New Scene</DialogTitle>
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
        {scenes.map((scene) => (
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
                {scene.active && (
                  <Badge className="bg-green-500 text-white animate-pulse">
                    Active
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>{scene.deviceActions?.length || scene.devices?.length || 0} devices</span>
                <span>Voice enabled</span>
              </div>
              
              <Button
                onClick={() => handleSceneActivation(scene._id, scene.name)}
                className={`w-full bg-gradient-to-r ${getSceneGradient(scene.name)} hover:shadow-lg transition-all duration-200 text-white border-0`}
                disabled={scene.active}
              >
                <Play className="h-4 w-4 mr-2" />
                {scene.active ? "Scene Active" : "Activate Scene"}
              </Button>
              
              <div className="text-xs text-muted-foreground bg-gray-50 dark:bg-gray-800 p-2 rounded">
                <strong>Voice command:</strong> "Hey Anna, activate {scene.name}"
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

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