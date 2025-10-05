import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Zap,
  Plus,
  Clock,
  Sun,
  Moon,
  Shield,
  Play,
  Pause,
  MessageSquare,
  Send,
  History,
  Edit,
  Trash2
} from "lucide-react"
import { getAutomations, createAutomationFromText, toggleAutomation, getAutomationHistory, updateAutomation, deleteAutomation } from "@/api/automations"
import { useToast } from "@/hooks/useToast"
import { useForm } from "react-hook-form"

interface AutomationTrigger {
  type: string
  conditions: any
}

interface Automation {
  _id: string
  name: string
  description: string
  trigger: AutomationTrigger
  actions: any[]
  enabled: boolean
  lastRun?: string
  category: string
  priority: number
}

export function Automations() {
  const { toast } = useToast()
  const [automations, setAutomations] = useState<Automation[]>([])
  const [loading, setLoading] = useState(true)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [selectedAutomation, setSelectedAutomation] = useState<any>(null)
  const [automationHistory, setAutomationHistory] = useState<any[]>([])
  const [isHistoryDialogOpen, setIsHistoryDialogOpen] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const { register, handleSubmit, reset, setValue } = useForm()

  useEffect(() => {
    const fetchAutomations = async () => {
      try {
        console.log('Fetching automations data')
        const data = await getAutomations()
        setAutomations(data.automations)
      } catch (error) {
        console.error('Failed to fetch automations:', error)
        toast({
          title: "Error",
          description: "Failed to load automations",
          variant: "destructive"
        })
      } finally {
        setLoading(false)
      }
    }

    fetchAutomations()
  }, [toast])

  const handleToggleAutomation = async (automationId: string, enabled: boolean) => {
    try {
      console.log('Toggling automation:', { automationId, enabled })
      await toggleAutomation({ automationId, enabled })

      setAutomations(prev => prev.map((automation: Automation) =>
        automation._id === automationId
          ? { ...automation, enabled }
          : automation
      ))

      toast({
        title: enabled ? "Automation Enabled" : "Automation Disabled",
        description: `Automation has been ${enabled ? 'enabled' : 'disabled'} successfully`
      })
    } catch (error) {
      console.error('Failed to toggle automation:', error)
      toast({
        title: "Error",
        description: "Failed to toggle automation",
        variant: "destructive"
      })
    }
  }

  const handleCreateAutomation = async (data: any) => {
    setIsProcessing(true)
    try {
      console.log('Creating automation from text:', data.text)
      const result = await createAutomationFromText({ text: data.text })

      setAutomations(prev => [...prev, result.automation])
      setIsCreateDialogOpen(false)
      reset()

      toast({
        title: "Automation Created",
        description: "Your automation has been created successfully"
      })
    } catch (error) {
      console.error('Failed to create automation:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to create automation",
        variant: "destructive"
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const handleViewHistory = async (automationId: string) => {
    setIsHistoryDialogOpen(true)
    setLoadingHistory(true)

    try {
      console.log('Fetching history for automation:', automationId)
      const result = await getAutomationHistory(automationId, 20)
      setAutomationHistory(result.history || [])
    } catch (error) {
      console.error('Failed to fetch automation history:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to load automation history",
        variant: "destructive"
      })
    } finally {
      setLoadingHistory(false)
    }
  }

  const handleEditAutomation = (automation: Automation) => {
    setSelectedAutomation(automation)
    setValue('editName', automation.name)
    setValue('editDescription', automation.description)
    setIsEditDialogOpen(true)
  }

  const handleUpdateAutomation = async (data: any) => {
    if (!selectedAutomation) return

    try {
      console.log('Updating automation:', selectedAutomation._id, data)
      const result = await updateAutomation(selectedAutomation._id, {
        name: data.editName,
        description: data.editDescription
      })

      setAutomations(prev => prev.map(automation =>
        automation._id === selectedAutomation._id ? result.automation : automation
      ))
      setIsEditDialogOpen(false)
      setSelectedAutomation(null)
      reset()

      toast({
        title: "Automation Updated",
        description: "Automation has been updated successfully"
      })
    } catch (error) {
      console.error('Failed to update automation:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to update automation",
        variant: "destructive"
      })
    }
  }

  const handleDeleteAutomation = async (automationId: string, automationName: string) => {
    if (!confirm(`Are you sure you want to delete the "${automationName}" automation?`)) {
      return
    }

    try {
      console.log('Deleting automation:', automationId)
      await deleteAutomation(automationId)

      setAutomations(prev => prev.filter(automation => automation._id !== automationId))

      toast({
        title: "Automation Deleted",
        description: `"${automationName}" automation has been deleted successfully`
      })
    } catch (error) {
      console.error('Failed to delete automation:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to delete automation",
        variant: "destructive"
      })
    }
  }

  const getTriggerIcon = (trigger: AutomationTrigger | any) => {
    if (!trigger || typeof trigger !== 'object') {
      return <Zap className="h-4 w-4" />
    }

    const triggerType = trigger.type || ''
    const conditions = trigger.conditions || {}
    const conditionsStr = JSON.stringify(conditions).toLowerCase()

    if (triggerType === 'time' || triggerType === 'schedule' || conditionsStr.includes('07:00') || conditionsStr.includes('time')) {
      return <Clock className="h-4 w-4" />
    }
    if (conditionsStr.includes('sunset') || conditionsStr.includes('sunrise') || triggerType === 'weather') {
      return <Sun className="h-4 w-4" />
    }
    if (triggerType === 'sensor' || conditionsStr.includes('motion') || conditionsStr.includes('presence') || triggerType === 'device_state') {
      return <Shield className="h-4 w-4" />
    }
    return <Zap className="h-4 w-4" />
  }

  const formatTrigger = (trigger: AutomationTrigger | any) => {
    if (!trigger || typeof trigger !== 'object') {
      return 'Unknown trigger'
    }

    const triggerType = trigger.type || 'unknown'
    const conditions = trigger.conditions || {}

    switch (triggerType) {
      case 'time':
      case 'schedule':
        if (conditions.time) {
          return `At ${conditions.time}`
        }
        return 'Time-based trigger'
      case 'device_state':
        if (conditions.device && conditions.state) {
          return `When ${conditions.device} is ${conditions.state}`
        }
        return 'Device state change'
      case 'sensor':
        if (conditions.sensor) {
          return `When ${conditions.sensor} detects activity`
        }
        return 'Sensor trigger'
      case 'weather':
        return 'Weather condition'
      case 'location':
        return 'Location-based'
      case 'manual':
        return 'Manual trigger'
      default:
        return triggerType.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())
    }
  }

  const formatLastRun = (lastRun: string | null) => {
    if (!lastRun) return "Never"
    return new Date(lastRun).toLocaleDateString() + " " + new Date(lastRun).toLocaleTimeString()
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
            Smart Automations
          </h1>
          <p className="text-muted-foreground mt-2">
            Create intelligent automations using natural language
          </p>
        </div>

        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white shadow-lg">
              <MessageSquare className="h-4 w-4 mr-2" />
              Create Automation
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-white" aria-describedby="create-automation-description">
            <DialogHeader>
              <DialogTitle>Create Automation with Natural Language</DialogTitle>
              <DialogDescription id="create-automation-description">
                Describe your automation in natural language and let AI convert it into a working automation rule.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit(handleCreateAutomation)} className="space-y-4">
              <div>
                <label className="text-sm font-medium">Describe your automation</label>
                <Textarea
                  {...register("text", { required: true })}
                  placeholder="e.g., Every morning at 7 AM, turn on the kitchen lights and start the coffee maker"
                  className="mt-1 min-h-[100px]"
                />
              </div>
              <div className="text-xs text-muted-foreground bg-blue-50 p-3 rounded">
                <p className="font-medium mb-2">Examples:</p>
                <ul className="space-y-1">
                  <li>• "Turn on porch light when motion is detected after sunset"</li>
                  <li>• "Lock all doors and turn off lights when I say goodnight"</li>
                  <li>• "Set temperature to 72° every weekday at 6 AM"</li>
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
                      Create Automation
                    </>
                  )}
                </Button>
                <Button type="button" variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Automation Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20 border-blue-200 dark:border-blue-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total</CardTitle>
            <Zap className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
              {automations.length}
            </div>
            <p className="text-xs text-blue-600/80 dark:text-blue-400/80">
              Automations created
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-800/20 border-green-200 dark:border-green-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <Play className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-700 dark:text-green-300">
              {automations.filter((a: Automation) => a && a.enabled).length}
            </div>
            <p className="text-xs text-green-600/80 dark:text-green-400/80">
              Currently running
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-orange-50 to-orange-100 dark:from-orange-900/20 dark:to-orange-800/20 border-orange-200 dark:border-orange-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Paused</CardTitle>
            <Pause className="h-4 w-4 text-orange-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-700 dark:text-orange-300">
              {automations.filter((a: Automation) => a && !a.enabled).length}
            </div>
            <p className="text-xs text-orange-600/80 dark:text-orange-400/80">
              Temporarily disabled
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 border-purple-200 dark:border-purple-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">This Week</CardTitle>
            <Clock className="h-4 w-4 text-purple-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-700 dark:text-purple-300">
              {automations.filter((a: Automation) => a && a.lastRun).length}
            </div>
            <p className="text-xs text-purple-600/80 dark:text-purple-400/80">
              Executions this week
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Automations List */}
      <div className="space-y-4">
        {automations.filter((automation) => automation && automation._id).map((automation: Automation) => (
          <Card key={automation._id} className="bg-white/80 backdrop-blur-sm border-0 shadow-lg hover:shadow-xl transition-all duration-300">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-full ${automation.enabled === true ? 'bg-green-500' : 'bg-gray-400'} text-white`}>
                    {getTriggerIcon(automation.trigger)}
                  </div>
                  <div>
                    <CardTitle className="text-lg">{automation.name || 'Unnamed Automation'}</CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">
                      {automation.description || 'No description'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <Badge variant={automation.enabled === true ? "default" : "secondary"}>
                    {automation.enabled === true ? "Active" : "Paused"}
                  </Badge>
                  <Switch
                    checked={automation.enabled === true}
                    onCheckedChange={(enabled) => handleToggleAutomation(automation._id, enabled)}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Trigger</p>
                  <p className="text-sm">{formatTrigger(automation.trigger)}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Actions</p>
                  <p className="text-sm">{automation.actions ? automation.actions.length : 0} actions</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Last Run</p>
                  <p className="text-sm">{formatLastRun(automation.lastRun)}</p>
                </div>
              </div>
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1 text-xs text-muted-foreground bg-gray-50 dark:bg-gray-800 p-2 rounded">
                    <strong>Voice control:</strong> "Hey Anna, {automation.enabled === true ? 'disable' : 'enable'} {automation.name || 'this automation'}"
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleEditAutomation(automation)}
                      className="flex items-center gap-2 hover:bg-blue-50"
                    >
                      <Edit className="h-4 w-4" />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDeleteAutomation(automation._id, automation.name)}
                      className="flex items-center gap-2 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleViewHistory(automation._id)}
                    className="flex items-center gap-2"
                  >
                    <History className="h-4 w-4" />
                    History
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {automations.length === 0 && (
        <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Zap className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Automations Created</h3>
            <p className="text-muted-foreground text-center mb-4">
              Create your first automation using natural language commands
            </p>
            <Button
              onClick={() => setIsCreateDialogOpen(true)}
              className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white"
            >
              <MessageSquare className="h-4 w-4 mr-2" />
              Create Your First Automation
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Edit Automation Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="bg-white" aria-describedby="edit-automation-description">
          <DialogHeader>
            <DialogTitle>Edit Automation</DialogTitle>
            <DialogDescription id="edit-automation-description">
              Update the name and description of your automation.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit(handleUpdateAutomation)} className="space-y-4">
            <div>
              <label className="text-sm font-medium">Automation Name</label>
              <Input
                {...register("editName", { required: true })}
                placeholder="e.g., Morning Routine"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <Textarea
                {...register("editDescription")}
                placeholder="Describe what this automation does..."
                className="mt-1"
              />
            </div>
            <div className="flex gap-2 pt-4">
              <Button type="submit" className="flex-1">Update Automation</Button>
              <Button type="button" variant="outline" onClick={() => {
                setIsEditDialogOpen(false)
                setSelectedAutomation(null)
              }}>
                Cancel
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={isHistoryDialogOpen} onOpenChange={setIsHistoryDialogOpen}>
        <DialogContent className="bg-white max-w-3xl max-h-[80vh] overflow-y-auto" aria-describedby="automation-history-description">
          <DialogHeader>
            <DialogTitle>Automation Execution History</DialogTitle>
            <DialogDescription id="automation-history-description">
              View the execution history and results for this automation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {loadingHistory ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              </div>
            ) : automationHistory.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <History className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>No execution history found for this automation.</p>
              </div>
            ) : (
              automationHistory.map((entry: any, index: number) => (
                <Card key={entry._id || index} className="border-0 shadow">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            entry.status === 'success' ? 'default' :
                            entry.status === 'partial_success' ? 'secondary' :
                            'destructive'
                          }
                        >
                          {entry.status === 'success' ? 'Success' :
                           entry.status === 'partial_success' ? 'Partial Success' :
                           'Failed'}
                        </Badge>
                        <span className="text-sm text-muted-foreground">
                          {new Date(entry.startedAt).toLocaleString()}
                        </span>
                      </div>
                      {entry.durationMs && (
                        <span className="text-xs text-muted-foreground">
                          {entry.durationMs}ms
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-sm">
                      <div>
                        <p className="font-medium text-muted-foreground">Total Actions</p>
                        <p className="text-lg font-semibold">{entry.totalActions}</p>
                      </div>
                      <div>
                        <p className="font-medium text-green-600">Successful</p>
                        <p className="text-lg font-semibold text-green-600">{entry.successfulActions}</p>
                      </div>
                      <div>
                        <p className="font-medium text-red-600">Failed</p>
                        <p className="text-lg font-semibold text-red-600">{entry.failedActions}</p>
                      </div>
                    </div>
                    {entry.error && entry.error.message && (
                      <div className="mt-3 p-2 bg-red-50 dark:bg-red-900/20 rounded text-xs text-red-600">
                        <strong>Error:</strong> {entry.error.message}
                      </div>
                    )}
                    {entry.actionResults && entry.actionResults.length > 0 && (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-sm font-medium text-blue-600 hover:text-blue-700">
                          View Action Details ({entry.actionResults.length} actions)
                        </summary>
                        <div className="mt-2 space-y-2">
                          {entry.actionResults.map((action: any, actionIndex: number) => (
                            <div
                              key={actionIndex}
                              className={`p-2 rounded text-xs ${action.success ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-medium">{action.actionType}</span>
                                <Badge variant={action.success ? 'default' : 'destructive'} className="text-xs">
                                  {action.success ? 'Success' : 'Failed'}
                                </Badge>
                              </div>
                              {action.error && (
                                <p className="mt-1 text-red-600">{action.error}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}