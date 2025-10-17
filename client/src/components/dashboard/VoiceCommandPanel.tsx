import { useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Mic, Send, MessageSquare } from "lucide-react"
import { interpretVoiceCommand, VoiceCommandResult } from "@/api/voice"
import { useToast } from "@/hooks/useToast"

export function VoiceCommandPanel() {
  const [isOpen, setIsOpen] = useState(false)
  const [command, setCommand] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)
  const [lastResult, setLastResult] = useState<VoiceCommandResult | null>(null)
  const { toast } = useToast()

  const handleSubmitCommand = async () => {
    if (!command.trim()) return

    setIsProcessing(true)
    try {
      const result = await interpretVoiceCommand({
        commandText: command,
        wakeWord: "dashboard",
        room: null
      })
      setLastResult(result)
      toast({
        title: "Command Processed",
        description:
          result.responseText ||
          `Intent: ${result.intent?.action ?? "unknown"} (${Math.round((result.intent?.confidence ?? 0) * 100)}%)`
      })
      setCommand("")
    } catch (error) {
      console.error("Failed to process command:", error)
      toast({
        title: "Error",
        description: "Failed to process voice command",
        variant: "destructive"
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const handleClose = () => {
    setIsOpen(false)
    setLastResult(null)
  }

  const confidenceDisplay = useMemo(() => {
    return `${Math.round((lastResult?.intent?.confidence ?? 0) * 100)}%`
  }, [lastResult?.intent?.confidence])

  const llmLabel = useMemo(() => {
    if (lastResult?.llm?.provider) {
      const model = lastResult.llm.model ? ` • ${lastResult.llm.model}` : ""
      return `${lastResult.llm.provider}${model}`
    }
    return "local heuristics"
  }, [lastResult?.llm?.model, lastResult?.llm?.provider])

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
          <Button variant="ghost" size="sm" onClick={handleClose}>
            x
          </Button>
        </div>

        <Textarea
          placeholder="Type your command... e.g., 'Turn on all living room lights when I get home'"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
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

        {lastResult && (
          <div className="rounded-md border border-border/60 bg-muted/40 p-3 text-xs space-y-2">
            <div>
              <span className="font-semibold text-foreground">Response:</span>{" "}
              {lastResult.responseText || "Processed without a spoken reply."}
            </div>
            <div className="grid grid-cols-2 gap-y-1 gap-x-3">
              <div>
                <span className="font-semibold text-foreground">Intent:</span>{" "}
                {lastResult.intent?.action || "unknown"}
              </div>
              <div>
                <span className="font-semibold text-foreground">Confidence:</span>{" "}
                {confidenceDisplay}
              </div>
              <div>
                <span className="font-semibold text-foreground">Execution:</span>{" "}
                {lastResult.execution?.status || "n/a"}
              </div>
              <div>
                <span className="font-semibold text-foreground">LLM:</span>{" "}
                {llmLabel}
              </div>
            </div>
            {lastResult.followUpQuestion && (
              <div>
                <span className="font-semibold text-foreground">Follow-up:</span>{" "}
                {lastResult.followUpQuestion}
              </div>
            )}
            {lastResult.usedFallback && (
              <div className="text-foreground/70">Fallback interpretation was applied.</div>
            )}
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          <p className="font-medium mb-1">Try saying:</p>
          <ul className="space-y-1">
            <li>- "Turn on kitchen lights at sunset"</li>
            <li>- "Lock all doors when I leave"</li>
            <li>- "Set temperature to 72 degrees at 7 AM"</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}
