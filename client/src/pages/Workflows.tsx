import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  History,
  MessageSquareText,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Wand2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/useToast";
import { WorkflowBuilderDialog } from "@/components/workflows/WorkflowBuilderDialog";
import {
  Workflow,
  createWorkflow,
  createWorkflowFromText,
  deleteWorkflow,
  executeWorkflow,
  getWorkflows,
  toggleWorkflow,
  updateWorkflow
} from "@/api/workflows";
import { getDevices } from "@/api/devices";
import { getScenes } from "@/api/scenes";
import { interpretVoiceCommand } from "@/api/voice";

type DeviceLite = {
  _id: string;
  name: string;
  type: string;
  room: string;
};

type SceneLite = {
  _id: string;
  name: string;
};

const errorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return fallback;
};

const formatLastRun = (value?: string | null) => {
  if (!value) {
    return "Never";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
};

export function Workflows() {
  const { toast } = useToast();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [devices, setDevices] = useState<DeviceLite[]>([]);
  const [scenes, setScenes] = useState<SceneLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [nlPrompt, setNlPrompt] = useState("");
  const [creatingFromText, setCreatingFromText] = useState(false);
  const [chatCommand, setChatCommand] = useState("");
  const [runningChatCommand, setRunningChatCommand] = useState(false);
  const [lastChatResult, setLastChatResult] = useState<string>("");

  const fetchData = async () => {
    try {
      const [workflowResponse, devicesResponse, scenesResponse] = await Promise.all([
        getWorkflows(),
        getDevices(),
        getScenes()
      ]);
      setWorkflows(workflowResponse.workflows || []);
      setDevices(devicesResponse.devices || []);
      setScenes(scenesResponse.scenes || []);
    } catch (error) {
      toast({
        title: "Failed to load workflows",
        description: errorMessage(error, "Unable to load workflow data."),
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchData();
  }, []);

  const stats = useMemo(() => {
    const enabled = workflows.filter((workflow) => workflow.enabled).length;
    const withVoiceAliases = workflows.filter((workflow) => (workflow.voiceAliases || []).length > 0).length;
    return {
      total: workflows.length,
      enabled,
      disabled: workflows.length - enabled,
      withVoiceAliases
    };
  }, [workflows]);

  const openCreateDialog = () => {
    setSelectedWorkflow(null);
    setDialogOpen(true);
  };

  const openEditDialog = (workflow: Workflow) => {
    setSelectedWorkflow(workflow);
    setDialogOpen(true);
  };

  const handleSaveWorkflow = async (payload: Partial<Workflow>) => {
    setSavingWorkflow(true);
    try {
      if (selectedWorkflow?._id) {
        const response = await updateWorkflow(selectedWorkflow._id, payload);
        setWorkflows((prev) => prev.map((workflow) => (
          workflow._id === selectedWorkflow._id ? response.workflow : workflow
        )));
        toast({
          title: "Workflow updated",
          description: response.message
        });
      } else {
        const response = await createWorkflow(payload);
        setWorkflows((prev) => [response.workflow, ...prev]);
        toast({
          title: "Workflow created",
          description: response.message
        });
      }
      setDialogOpen(false);
      setSelectedWorkflow(null);
    } catch (error) {
      toast({
        title: "Save failed",
        description: errorMessage(error, "Unable to save workflow."),
        variant: "destructive"
      });
    } finally {
      setSavingWorkflow(false);
    }
  };

  const handleToggleWorkflow = async (workflow: Workflow, enabled: boolean) => {
    try {
      const response = await toggleWorkflow(workflow._id, enabled);
      setWorkflows((prev) => prev.map((entry) => (
        entry._id === workflow._id ? response.workflow : entry
      )));
    } catch (error) {
      toast({
        title: "Toggle failed",
        description: errorMessage(error, "Unable to toggle workflow."),
        variant: "destructive"
      });
    }
  };

  const handleRunWorkflow = async (workflow: Workflow) => {
    try {
      const response = await executeWorkflow(workflow._id);
      const nextWorkflow = response.workflow;
      if (nextWorkflow) {
        setWorkflows((prev) => prev.map((entry) => (entry._id === workflow._id ? nextWorkflow : entry)));
      }
      toast({
        title: response.success ? "Workflow executed" : "Workflow executed with issues",
        description: response.message || `${workflow.name} run complete.`
      });
    } catch (error) {
      toast({
        title: "Run failed",
        description: errorMessage(error, "Unable to execute workflow."),
        variant: "destructive"
      });
    }
  };

  const handleDeleteWorkflow = async (workflow: Workflow) => {
    const confirmed = window.confirm(`Delete workflow "${workflow.name}"?`);
    if (!confirmed) {
      return;
    }

    try {
      await deleteWorkflow(workflow._id);
      setWorkflows((prev) => prev.filter((entry) => entry._id !== workflow._id));
      toast({
        title: "Workflow deleted",
        description: `${workflow.name} has been removed.`
      });
    } catch (error) {
      toast({
        title: "Delete failed",
        description: errorMessage(error, "Unable to delete workflow."),
        variant: "destructive"
      });
    }
  };

  const handleCreateFromText = async () => {
    const text = nlPrompt.trim();
    if (!text) {
      return;
    }

    setCreatingFromText(true);
    try {
      const result = await createWorkflowFromText({ text, source: "chat" });
      if (result.handledDirectCommand) {
        toast({
          title: "Executed directly",
          description: result.message
        });
      } else if (result.workflow) {
        setWorkflows((prev) => [result.workflow as Workflow, ...prev]);
        toast({
          title: "Workflow created",
          description: result.message
        });
      }
      setNlPrompt("");
    } catch (error) {
      toast({
        title: "AI create failed",
        description: errorMessage(error, "Unable to create workflow from text."),
        variant: "destructive"
      });
    } finally {
      setCreatingFromText(false);
    }
  };

  const handleRunChatCommand = async () => {
    const text = chatCommand.trim();
    if (!text) {
      return;
    }
    setRunningChatCommand(true);
    try {
      const result = await interpretVoiceCommand({
        commandText: text,
        wakeWord: "dashboard",
        room: null
      });
      setLastChatResult(result.responseText || "Command processed.");
      setChatCommand("");
      await fetchData();
    } catch (error) {
      toast({
        title: "Command failed",
        description: errorMessage(error, "Unable to process command."),
        variant: "destructive"
      });
    } finally {
      setRunningChatCommand(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Workflow Studio</h1>
          <p className="mt-1 text-muted-foreground">
            Build automations visually, create them with AI chat, and trigger them by voice.
          </p>
        </div>
        <Button onClick={openCreateDialog}>
          <Plus className="mr-2 h-4 w-4" />
          New Workflow
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Total</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{stats.total}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Enabled</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{stats.enabled}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Disabled</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{stats.disabled}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Voice Ready</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{stats.withVoiceAliases}</CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              Create with AI
            </CardTitle>
            <CardDescription>
              Describe the workflow in plain English. HomeBrain will generate trigger + action steps automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={nlPrompt}
              onChange={(event) => setNlPrompt(event.target.value)}
              placeholder="Every weekday at 6:30 AM, turn on kitchen lights and set thermostat to 71."
            />
            <Button onClick={() => void handleCreateFromText()} disabled={creatingFromText || !nlPrompt.trim()}>
              <Wand2 className="mr-2 h-4 w-4" />
              {creatingFromText ? "Creating..." : "Generate Workflow"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquareText className="h-4 w-4" />
              Chat/Voice Command
            </CardTitle>
            <CardDescription>
              Use the same command parser as remote voice devices to create or run workflows from text.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              value={chatCommand}
              onChange={(event) => setChatCommand(event.target.value)}
              placeholder='Try: "create a workflow that turns off lights at 11 PM"'
            />
            <Button onClick={() => void handleRunChatCommand()} disabled={runningChatCommand || !chatCommand.trim()}>
              <Bot className="mr-2 h-4 w-4" />
              {runningChatCommand ? "Processing..." : "Send Command"}
            </Button>
            {lastChatResult ? (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">{lastChatResult}</div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        {workflows.map((workflow) => (
          <Card key={workflow._id}>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-lg">{workflow.name}</CardTitle>
                  <CardDescription>{workflow.description || "No description provided."}</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={workflow.enabled ? "secondary" : "outline"}>
                    {workflow.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <Switch checked={workflow.enabled} onCheckedChange={(value) => void handleToggleWorkflow(workflow, value)} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 text-sm md:grid-cols-4">
                <div>
                  <div className="text-muted-foreground">Trigger</div>
                  <div className="font-medium">{workflow.trigger?.type || "manual"}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Steps</div>
                  <div className="font-medium">{workflow.actions?.length || 0}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Last Run</div>
                  <div className="font-medium">{formatLastRun(workflow.lastRun)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Runs</div>
                  <div className="font-medium">{workflow.executionCount || 0}</div>
                </div>
              </div>

              {(workflow.voiceAliases || []).length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {(workflow.voiceAliases || []).map((alias) => (
                    <Badge key={alias} variant="outline">
                      {alias}
                    </Badge>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  No voice alias set yet.
                </div>
              )}

              {workflow.lastError?.message ? (
                <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700">
                  Last error: {workflow.lastError.message}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void handleRunWorkflow(workflow)}>
                  <Play className="mr-2 h-4 w-4" />
                  Run Now
                </Button>
                <Button size="sm" variant="outline" onClick={() => openEditDialog(workflow)}>
                  <History className="mr-2 h-4 w-4" />
                  Edit Flow
                </Button>
                <Button size="sm" variant="outline" onClick={() => void handleDeleteWorkflow(workflow)}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {workflows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="mb-3 text-lg font-semibold">No workflows yet</div>
            <p className="mb-4 text-sm text-muted-foreground">
              Start by generating one with AI text or creating one manually in the visual builder.
            </p>
            <Button onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              Create First Workflow
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <WorkflowBuilderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialWorkflow={selectedWorkflow}
        devices={devices}
        scenes={scenes}
        onSave={handleSaveWorkflow}
        isSaving={savingWorkflow}
      />
    </div>
  );
}
