import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  Bot,
  Copy,
  Download,
  History,
  MessageSquareText,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Upload,
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
  WorkflowAction,
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
import { useAuth } from "@/contexts/AuthContext";

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

type WorkflowTemplateDefinition = {
  id: string;
  name: string;
  description: string;
  build: (context: {
    firstDeviceId: string | null;
    firstSceneId: string | null;
  }) => Partial<Workflow>;
};

const TEMPLATE_DEFINITIONS: WorkflowTemplateDefinition[] = [
  {
    id: "goodnight",
    name: "Goodnight Routine",
    description: "Run a night shutdown manually by voice/chat or button.",
    build: ({ firstSceneId }) => ({
      name: "Goodnight Routine",
      description: "Night shutdown routine for lights and household status.",
      source: "manual",
      enabled: true,
      category: "comfort",
      trigger: { type: "manual", conditions: {} },
      actions: firstSceneId
        ? [{ type: "scene_activate", target: firstSceneId, parameters: {} }]
        : [{ type: "notification", target: "system", parameters: { message: "Goodnight routine executed." } }]
    })
  },
  {
    id: "morning-weekday",
    name: "Weekday Morning Start",
    description: "Weekday schedule to start a morning workflow.",
    build: ({ firstSceneId, firstDeviceId }) => ({
      name: "Weekday Morning Start",
      description: "Starts key systems on weekdays at 6:30 AM.",
      source: "manual",
      enabled: true,
      category: "convenience",
      trigger: { type: "schedule", conditions: { cron: "30 6 * * 1-5" } },
      actions: firstSceneId
        ? [{ type: "scene_activate", target: firstSceneId, parameters: {} }]
        : firstDeviceId
          ? [{ type: "device_control", target: firstDeviceId, parameters: { action: "turn_on" } }]
          : [{ type: "notification", target: "system", parameters: { message: "Morning routine triggered." } }]
    })
  },
  {
    id: "away-alert",
    name: "Away Motion Alert",
    description: "When motion is detected, send a security notification.",
    build: () => ({
      name: "Away Motion Alert",
      description: "Alerts when motion is detected while away mode is active.",
      source: "manual",
      enabled: true,
      category: "security",
      trigger: { type: "sensor", conditions: { sensorType: "motion", condition: "detected" } },
      actions: [
        {
          type: "notification",
          target: "system",
          parameters: { message: "Motion detected while away." }
        }
      ]
    })
  },
  {
    id: "night-energy",
    name: "Night Energy Saver",
    description: "Turn off one key device nightly (customize after creation).",
    build: ({ firstDeviceId }) => ({
      name: "Night Energy Saver",
      description: "Turns off devices nightly to reduce idle energy use.",
      source: "manual",
      enabled: true,
      category: "energy",
      trigger: { type: "time", conditions: { hour: 23, minute: 0 } },
      actions: firstDeviceId
        ? [{ type: "device_control", target: firstDeviceId, parameters: { action: "turn_off" } }]
        : [{ type: "notification", target: "system", parameters: { message: "Night energy saver executed." } }]
    })
  }
];

const sanitizeWorkflowPayload = (workflow: Partial<Workflow>): Partial<Workflow> => {
  const actions = (Array.isArray(workflow.actions) ? workflow.actions : [])
    .filter((action): action is WorkflowAction => Boolean(action && action.type))
    .map((action) => ({
      type: action.type,
      target: action.target ?? null,
      parameters: action.parameters || {}
    }));

  return {
    name: workflow.name?.trim() || "Imported Workflow",
    description: workflow.description || "",
    source: workflow.source || "import",
    enabled: typeof workflow.enabled === "boolean" ? workflow.enabled : true,
    category: workflow.category || "custom",
    priority: typeof workflow.priority === "number" ? workflow.priority : 5,
    cooldown: typeof workflow.cooldown === "number" ? workflow.cooldown : 0,
    trigger: workflow.trigger || { type: "manual", conditions: {} },
    actions,
    graph: workflow.graph,
    voiceAliases: Array.isArray(workflow.voiceAliases) ? workflow.voiceAliases : []
  };
};

export function Workflows() {
  const { toast } = useToast();
  const { isAdmin } = useAuth();
  const importInputRef = useRef<HTMLInputElement | null>(null);
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

  const createTemplateWorkflow = async (templateId: string) => {
    const template = TEMPLATE_DEFINITIONS.find((entry) => entry.id === templateId);
    if (!template) {
      return;
    }

    const payload = sanitizeWorkflowPayload(template.build({
      firstDeviceId: devices[0]?._id || null,
      firstSceneId: scenes[0]?._id || null
    }));

    if (!payload.actions || payload.actions.length === 0) {
      toast({
        title: "Template unavailable",
        description: "No valid actions could be generated for this template.",
        variant: "destructive"
      });
      return;
    }

    try {
      const response = await createWorkflow(payload);
      setWorkflows((prev) => [response.workflow, ...prev]);
      toast({
        title: "Template created",
        description: `${response.workflow.name} is ready.`
      });
    } catch (error) {
      toast({
        title: "Template failed",
        description: errorMessage(error, "Unable to create template workflow."),
        variant: "destructive"
      });
    }
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

  const handleCloneWorkflow = async (workflow: Workflow) => {
    const cloned = sanitizeWorkflowPayload({
      ...workflow,
      name: `${workflow.name} Copy`,
      source: "import"
    });

    try {
      const response = await createWorkflow(cloned);
      setWorkflows((prev) => [response.workflow, ...prev]);
      toast({
        title: "Workflow cloned",
        description: `${workflow.name} copied successfully.`
      });
    } catch (error) {
      toast({
        title: "Clone failed",
        description: errorMessage(error, "Unable to clone workflow."),
        variant: "destructive"
      });
    }
  };

  const handleExportWorkflow = (workflow: Workflow) => {
    const payload = {
      format: "homebrain.workflow.v1",
      exportedAt: new Date().toISOString(),
      workflow: sanitizeWorkflowPayload(workflow)
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const safeName = workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    anchor.href = url;
    anchor.download = `${safeName || "workflow"}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const handleImportClick = () => {
    importInputRef.current?.click();
  };

  const handleImportWorkflows = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as unknown;
      const candidates = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === "object" && "workflow" in parsed)
          ? [(parsed as { workflow: unknown }).workflow]
          : [parsed];

      const created: Workflow[] = [];
      for (const candidate of candidates) {
        const payload = sanitizeWorkflowPayload(candidate as Partial<Workflow>);
        if (!payload.actions || payload.actions.length === 0) {
          continue;
        }
        const response = await createWorkflow(payload);
        created.push(response.workflow);
      }

      if (created.length === 0) {
        throw new Error("No valid workflow definitions found in file.");
      }

      setWorkflows((prev) => [...created, ...prev]);
      toast({
        title: "Import complete",
        description: `Imported ${created.length} workflow(s).`
      });
    } catch (error) {
      toast({
        title: "Import failed",
        description: errorMessage(error, "Unable to import workflows from file."),
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
      } else {
        const createdWorkflows = Array.isArray(result.workflows) && result.workflows.length
          ? result.workflows
          : result.workflow
            ? [result.workflow]
            : [];

        if (createdWorkflows.length > 0) {
          setWorkflows((prev) => [...createdWorkflows, ...prev]);
        }

        toast({
          title: createdWorkflows.length > 1 ? "Workflows created" : "Workflow created",
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
            {isAdmin
              ? "Build workflows visually, create them with AI chat, and trigger them by voice."
              : "Review and run existing workflows without editing their runtime records directly."}
          </p>
        </div>
        {isAdmin ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleImportClick}>
              <Upload className="mr-2 h-4 w-4" />
              Import JSON
            </Button>
            <Button onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              New Workflow
            </Button>
          </div>
        ) : null}
      </div>
      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => void handleImportWorkflows(event)}
      />

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

      {isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              Quick Templates
            </CardTitle>
            <CardDescription>
              Start from a proven template, then customize in the visual builder.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {TEMPLATE_DEFINITIONS.map((template) => (
              <button
                key={template.id}
                type="button"
                className="rounded-md border p-3 text-left transition hover:border-blue-300 hover:bg-blue-50/60 dark:hover:bg-blue-950/20"
                onClick={() => void createTemplateWorkflow(template.id)}
              >
                <div className="mb-1 font-medium">{template.name}</div>
                <p className="text-xs text-muted-foreground">{template.description}</p>
              </button>
            ))}
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-[1.5rem] border border-border/70 bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Standard users can run workflows and use command chat, but only admins can create or reconfigure workflow templates.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {isAdmin ? (
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
        ) : null}

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
              placeholder={isAdmin
                ? 'Try: "create a workflow that turns off lights at 11 PM"'
                : 'Try: "turn on the living room lights"'}
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
                  <Switch
                    checked={workflow.enabled}
                    disabled={!isAdmin}
                    onCheckedChange={(value) => void handleToggleWorkflow(workflow, value)}
                  />
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
                <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-700 dark:text-red-300">
                  Last error: {workflow.lastError.message}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void handleRunWorkflow(workflow)}>
                  <Play className="mr-2 h-4 w-4" />
                  Run Now
                </Button>
                {isAdmin ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => openEditDialog(workflow)}>
                      <History className="mr-2 h-4 w-4" />
                      Edit Flow
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void handleCloneWorkflow(workflow)}>
                      <Copy className="mr-2 h-4 w-4" />
                      Clone
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => handleExportWorkflow(workflow)}>
                      <Download className="mr-2 h-4 w-4" />
                      Export
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void handleDeleteWorkflow(workflow)}>
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </Button>
                  </>
                ) : null}
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
              {isAdmin
                ? "Start by generating one with AI text or creating one manually in the visual builder."
                : "No workflows are available to run yet."}
            </p>
            {isAdmin ? (
              <Button onClick={openCreateDialog}>
                <Plus className="mr-2 h-4 w-4" />
                Create First Workflow
              </Button>
            ) : null}
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
