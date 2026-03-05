import { useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Mic, Send, MessageSquare, X } from "lucide-react"
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
      <Card className="rounded-[1.75rem]">
        <CardContent className="space-y-5 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <p className="section-kicker">Voice Command Surface</p>
              <h3 className="text-xl font-semibold text-foreground">Launch a natural-language control pass</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Type or speak a request and HomeBrain interprets the intent, confidence, and execution path.
              </p>
            </div>
            <div className="rounded-[1rem] border border-white/20 bg-white/10 p-3 text-cyan-700 dark:text-cyan-300">
              <MessageSquare className="h-5 w-5" />
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {[
              "Turn on the patio lights at sunset",
              "Set the upstairs thermostat to 70",
              "Run movie night in the living room",
              "Create a workflow for bedtime shutdown"
            ].map((sample) => (
              <div key={sample} className="rounded-[1rem] border border-white/10 bg-white/10 px-3 py-2 text-sm text-muted-foreground dark:bg-slate-950/20">
                {sample}
              </div>
            ))}
          </div>

          <Button onClick={() => setIsOpen(true)} className="w-full">
            <MessageSquare className="h-4 w-4" />
            Open Voice Console
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="w-full rounded-[1.75rem]">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="section-kicker">Natural Language Console</p>
            <h3 className="mt-1 text-lg font-semibold text-foreground">Live command parsing</h3>
          </div>
          <Button variant="ghost" size="icon" onClick={handleClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <Textarea
          placeholder="Type your command... e.g. 'Turn on all living room lights when I get home'"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          className="min-h-[80px] resize-none"
        />

        <div className="flex gap-2">
          <Button
            onClick={handleSubmitCommand}
            disabled={!command.trim() || isProcessing}
            className="flex-1"
          >
            {isProcessing ? (
              <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white/25 border-t-white" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Process
          </Button>

          <Button variant="outline" size="icon">
            <Mic className="h-4 w-4" />
          </Button>
        </div>

        {lastResult && (
          <div className="card-shell rounded-[1.25rem] space-y-3 p-4 text-xs">
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

        <div className="space-y-2 text-xs text-muted-foreground">
          <p className="font-medium">Try saying:</p>
          <div className="grid gap-2">
            <div className="rounded-[0.9rem] border border-white/10 bg-white/10 px-3 py-2 dark:bg-slate-950/20">
              Turn on kitchen lights at sunset
            </div>
            <div className="rounded-[0.9rem] border border-white/10 bg-white/10 px-3 py-2 dark:bg-slate-950/20">
              Lock all doors when I leave
            </div>
            <div className="rounded-[0.9rem] border border-white/10 bg-white/10 px-3 py-2 dark:bg-slate-950/20">
              Create a workflow to turn lights off at 11 PM
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
