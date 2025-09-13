import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Mic, Send, MessageSquare } from "lucide-react"
import { createAutomationFromText } from "@/api/automations"
import { useToast } from "@/hooks/useToast"

export function VoiceCommandPanel() {
  const [isOpen, setIsOpen] = useState(false)
  const [command, setCommand] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)
  const { toast } = useToast()

  const handleSubmitCommand = async () => {
    if (!command.trim()) return

    setIsProcessing(true)
    try {
      console.log('Processing voice command:', command)
      await createAutomationFromText({ text: command })
      toast({
        title: "Command Processed",
        description: "Your voice command has been processed successfully"
      })
      setCommand("")
      setIsOpen(false)
    } catch (error) {
      console.error('Failed to process command:', error)
      toast({
        title: "Error",
        description: "Failed to process voice command",
        variant: "destructive"
      })
    } finally {
      setIsProcessing(false)
    }
  }

  if (!isOpen) {
    return (
      <Button
        onClick={() => setIsOpen(true)}
        className="bg-gradient-to-r from-green-500 to-blue-600 hover:from-green-600 hover:to-blue-700 text-white shadow-lg hover:shadow-xl transition-all duration-200"
      >
        <MessageSquare className="h-4 w-4 mr-2" />
        Voice Commands
      </Button>
    )
  }

  return (
    <Card className="w-80 bg-white/95 backdrop-blur-sm border-0 shadow-xl">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm">Natural Language Commands</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsOpen(false)}
          >
            ×
          </Button>
        </div>
        
        <Textarea
          placeholder="Type your command... e.g., 'Turn on all living room lights when I get home'"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          className="min-h-[80px] resize-none"
        />
        
        <div className="flex gap-2">
          <Button
            onClick={handleSubmitCommand}
            disabled={!command.trim() || isProcessing}
            className="flex-1 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700"
          >
            {isProcessing ? (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            Process
          </Button>
          
          <Button variant="outline" size="icon">
            <Mic className="h-4 w-4" />
          </Button>
        </div>
        
        <div className="text-xs text-muted-foreground">
          <p className="font-medium mb-1">Try saying:</p>
          <ul className="space-y-1">
            <li>• "Turn on kitchen lights at sunset"</li>
            <li>• "Lock all doors when I leave"</li>
            <li>• "Set temperature to 72° at 7 AM"</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}