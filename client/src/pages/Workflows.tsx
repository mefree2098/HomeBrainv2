import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  Activity,
  Bot,
  Copy,
  Download,
  History,
  Loader2,
  MessageSquareText,
  Play,
  Plus,
  RefreshCw,
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/useToast";
import { WorkflowBuilderDialog } from "@/components/workflows/WorkflowBuilderDialog";
import {
  Workflow,
  WorkflowAction,
  WorkflowExecutionHistoryEntry,
  createWorkflow,
  createWorkflowFromText,
  deleteWorkflow,
  executeWorkflow,
  reviseWorkflowFromText,
  getRunningWorkflowExecutions,
  getWorkflowRuntimeHistory,
  getWorkflows,
  toggleWorkflow,
  updateWorkflow
} from "@/api/workflows";
import { PlatformEvent, getLatestEvents, openEventStream } from "@/api/events";
import { getDeviceGroups, getDevices, type DeviceGroupSummary } from "@/api/devices";
import { getScenes } from "@/api/scenes";
import { interpretVoiceCommand } from "@/api/voice";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

type DeviceLite = {
  _id: string;
  name: string;
  type: string;
  room: string;
  groups?: string[];
  brightness?: number;
  temperature?: number;
  targetTemperature?: number;
  properties?: Record<string, unknown>;
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

const AUTOMATION_ACTIVITY_LIMIT = 80;

const formatDateTime = (value?: string | null) => {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
};

const formatDuration = (value?: number | null) => {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) {
    return "In progress";
  }

  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }

  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
};

const formatRunningSince = (value?: string | null) => {
  if (!value) {
    return "Just now";
  }

  const date = new Date(value);
  const startedAt = date.getTime();
  if (Number.isNaN(startedAt)) {
    return "Just now";
  }

  return formatDuration(Date.now() - startedAt);
};

const runtimeStatusLabel = (status: WorkflowExecutionHistoryEntry["status"]) => {
  switch (status) {
    case "success":
      return "Success";
    case "partial_success":
      return "Partial";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
    case "running":
    default:
      return "Running";
  }
};

const runtimeStatusClassName = (status: WorkflowExecutionHistoryEntry["status"]) => {
  switch (status) {
    case "success":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200";
    case "partial_success":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200";
    case "failed":
      return "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200";
    case "cancelled":
      return "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-500/30 dark:bg-slate-500/10 dark:text-slate-200";
    case "running":
    default:
      return "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-200";
  }
};

const activitySeverityClassName = (severity: PlatformEvent["severity"]) => {
  switch (severity) {
    case "error":
      return "border-red-200/80 bg-red-50/80 dark:border-red-500/20 dark:bg-red-500/10";
    case "warn":
      return "border-amber-200/80 bg-amber-50/80 dark:border-amber-500/20 dark:bg-amber-500/10";
    case "info":
    default:
      return "border-border/70 bg-background/70";
  }
};

const activitySummary = (event: PlatformEvent) => {
  const payload = event.payload || {};
  const workflowName = typeof payload.workflowName === "string" && payload.workflowName.trim()
    ? payload.workflowName.trim()
    : "";
  const automationName = typeof payload.automationName === "string" && payload.automationName.trim()
    ? payload.automationName.trim()
    : "";
  const name = workflowName || automationName || "Automation";

  switch (event.type) {
    case "automation.trigger.security_alarm_evaluated": {
      const currentState = typeof payload.currentState === "string" ? payload.currentState : "unknown";
      const configuredStates = Array.isArray(payload.configuredStates)
        ? payload.configuredStates.join(", ")
        : "none";
      return `${name}: alarm state ${currentState}, watching ${configuredStates}`;
    }
    case "automation.trigger.skipped":
      return `${name}: trigger skipped`;
    case "automation.trigger.matched":
      return `${name}: trigger matched`;
    case "automation.execution.started":
      return `${name}: execution started`;
    case "automation.execution.completed":
      return `${name}: execution ${typeof payload.status === "string" ? payload.status.replace(/_/g, " ") : "finished"}`;
    case "automation.action.started":
    case "automation.action.completed":
    case "automation.action.failed": {
      const actionType = typeof payload.actionType === "string" ? payload.actionType.replace(/_/g, " ") : "action";
      return `${name}: ${actionType}`;
    }
    default:
      return `${name}: ${event.type}`;
  }
};

const stringifyClipboardValue = (value: unknown) => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const sortEventsChronologically = (events: PlatformEvent[]) => {
  return events.slice().sort((left, right) => {
    const leftSequence = Number(left.sequence) || 0;
    const rightSequence = Number(right.sequence) || 0;
    if (leftSequence !== rightSequence) {
      return leftSequence - rightSequence;
    }

    const leftTime = new Date(left.createdAt).getTime();
    const rightTime = new Date(right.createdAt).getTime();
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      return leftTime - rightTime;
    }

    return 0;
  });
};

const buildExecutionLogClipboardText = ({
  execution,
  executionName,
  events
}: {
  execution: WorkflowExecutionHistoryEntry;
  executionName: string;
  events: PlatformEvent[];
}) => {
  const lines: string[] = [
    "HomeBrain Automation Runtime Logs",
    `Copied: ${new Date().toLocaleString()}`,
    "",
    "Execution Summary",
    `Workflow: ${executionName}`,
    `Automation: ${execution.automationName || "Unknown"}`,
    `Execution ID: ${execution._id}`,
    `Status: ${runtimeStatusLabel(execution.status)}`,
    `Trigger Type: ${execution.triggerType.replace(/_/g, " ")}`,
    `Trigger Source: ${execution.triggerSource.replace(/_/g, " ")}`,
    `Started: ${formatDateTime(execution.startedAt)}`,
    `Completed: ${formatDateTime(execution.completedAt)}`,
    `Duration: ${execution.status === "running" ? formatRunningSince(execution.startedAt) : formatDuration(execution.durationMs)}`,
    `Successful Actions: ${execution.successfulActions || 0}`,
    `Failed Actions: ${execution.failedActions || 0}`,
    `Total Actions: ${execution.totalActions || 0}`
  ];

  if (execution.workflowId) {
    lines.push(`Workflow ID: ${execution.workflowId}`);
  }
  if (execution.correlationId) {
    lines.push(`Correlation ID: ${execution.correlationId}`);
  }
  if (execution.lastEvent?.message) {
    lines.push(`Last Event: ${execution.lastEvent.message}`);
  }

  if (execution.currentAction) {
    lines.push("", "Current Action", stringifyClipboardValue(execution.currentAction));
  }

  if (execution.triggerContext && Object.keys(execution.triggerContext).length > 0) {
    lines.push("", "Trigger Context", stringifyClipboardValue(execution.triggerContext));
  }

  if (execution.error) {
    lines.push("", "Execution Error", stringifyClipboardValue(execution.error));
  }

  if (Array.isArray(execution.actionResults) && execution.actionResults.length > 0) {
    lines.push("", "Action Results", stringifyClipboardValue(execution.actionResults));
  }

  if (Array.isArray(execution.runtimeEvents) && execution.runtimeEvents.length > 0) {
    lines.push("", "Persisted Runtime Event Summaries", stringifyClipboardValue(execution.runtimeEvents));
  }

  const sortedEvents = sortEventsChronologically(events);
  lines.push("", `Event Stream Logs (${sortedEvents.length})`);
  if (sortedEvents.length === 0) {
    lines.push("No detailed runtime events were recorded for this execution.");
  } else {
    sortedEvents.forEach((event, index) => {
      lines.push(
        "",
        `#${index + 1} ${event.type}`,
        `Created: ${formatDateTime(event.createdAt)}`,
        `Severity: ${event.severity}`,
        `Source: ${event.source}`,
        `Category: ${event.category}`,
        `Sequence: ${event.sequence}`,
        `Correlation ID: ${event.correlationId || "None"}`,
        `Tags: ${Array.isArray(event.tags) && event.tags.length > 0 ? event.tags.join(", ") : "None"}`,
        `Summary: ${activitySummary(event)}`,
        "Payload:",
        stringifyClipboardValue(event.payload || {})
      );
    });
  }

  lines.push("", "Raw Execution Record JSON", stringifyClipboardValue(execution));

  return `${lines.join("\n")}\n`;
};

const copyTextToClipboard = async (value: string) => {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard access is unavailable in this environment.");
  }

  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  const copied = document.execCommand("copy");
  document.body.removeChild(textArea);

  if (!copied) {
    throw new Error("Unable to copy logs to the clipboard.");
  }
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
  const activityCleanupRef = useRef<null | (() => void)>(null);
  const latestActivitySequenceRef = useRef(0);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [devices, setDevices] = useState<DeviceLite[]>([]);
  const [deviceGroups, setDeviceGroups] = useState<DeviceGroupSummary[]>([]);
  const [scenes, setScenes] = useState<SceneLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [runtimeRefreshing, setRuntimeRefreshing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [nlPrompt, setNlPrompt] = useState("");
  const [creatingFromText, setCreatingFromText] = useState(false);
  const [reviseDialogOpen, setReviseDialogOpen] = useState(false);
  const [workflowToRevise, setWorkflowToRevise] = useState<Workflow | null>(null);
  const [revisePrompt, setRevisePrompt] = useState("");
  const [revisingWorkflow, setRevisingWorkflow] = useState(false);
  const [chatCommand, setChatCommand] = useState("");
  const [runningChatCommand, setRunningChatCommand] = useState(false);
  const [lastChatResult, setLastChatResult] = useState<string>("");
  const [runningExecutions, setRunningExecutions] = useState<WorkflowExecutionHistoryEntry[]>([]);
  const [runtimeHistory, setRuntimeHistory] = useState<WorkflowExecutionHistoryEntry[]>([]);
  const [activityEvents, setActivityEvents] = useState<PlatformEvent[]>([]);
  const [activityConnected, setActivityConnected] = useState(false);
  const [selectedExecution, setSelectedExecution] = useState<WorkflowExecutionHistoryEntry | null>(null);
  const [selectedExecutionEvents, setSelectedExecutionEvents] = useState<PlatformEvent[]>([]);
  const [loadingExecutionEvents, setLoadingExecutionEvents] = useState(false);

  const loadRuntimeData = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setRuntimeRefreshing(true);
    }

    try {
      const [runningResponse, historyResponse, eventsResponse] = await Promise.all([
        getRunningWorkflowExecutions(20),
        getWorkflowRuntimeHistory(null, 50),
        getLatestEvents({
          limit: AUTOMATION_ACTIVITY_LIMIT,
          category: "automation"
        })
      ]);

      setRunningExecutions(runningResponse.executions || []);
      setRuntimeHistory(historyResponse.history || []);
      const latestEvents = Array.isArray(eventsResponse.events) ? eventsResponse.events : [];
      setActivityEvents(latestEvents.slice().reverse());
      latestActivitySequenceRef.current = eventsResponse.lastSequence || 0;
    } catch (error) {
      if (!options.silent) {
        toast({
          title: "Failed to load automation runtime",
          description: errorMessage(error, "Unable to load automation runtime activity."),
          variant: "destructive"
        });
      }
    } finally {
      if (!options.silent) {
        setRuntimeRefreshing(false);
      }
    }
  }, [toast]);

  const fetchData = useCallback(async () => {
    try {
      const [workflowResponse, devicesResponse, deviceGroupsResponse, scenesResponse] = await Promise.all([
        getWorkflows(),
        getDevices(),
        getDeviceGroups(),
        getScenes()
      ]);
      setWorkflows(workflowResponse.workflows || []);
      setDevices(devicesResponse.devices || []);
      setDeviceGroups(deviceGroupsResponse.groups || []);
      setScenes(scenesResponse.scenes || []);
      await loadRuntimeData({ silent: true });
    } catch (error) {
      toast({
        title: "Failed to load workflows",
        description: errorMessage(error, "Unable to load workflow data."),
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  }, [loadRuntimeData, toast]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

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

  const workflowNameLookup = useMemo(() => {
    return new Map(workflows.map((workflow) => [workflow._id, workflow.name]));
  }, [workflows]);

  const runningWorkflowIds = useMemo(() => {
    return new Set(runningExecutions
      .map((entry) => entry.workflowId)
      .filter((value): value is string => typeof value === "string" && value.length > 0));
  }, [runningExecutions]);

  const resolveExecutionName = useCallback((entry: Partial<WorkflowExecutionHistoryEntry> | null | undefined) => {
    if (!entry) {
      return "Workflow";
    }
    if (entry.workflowId && workflowNameLookup.has(entry.workflowId)) {
      return workflowNameLookup.get(entry.workflowId) || "Workflow";
    }
    return entry.workflowName || entry.automationName || "Workflow";
  }, [workflowNameLookup]);

  const openExecutionLogs = useCallback(async (entry: WorkflowExecutionHistoryEntry) => {
    setSelectedExecution(entry);
    setLoadingExecutionEvents(true);

    try {
      if (!entry.correlationId) {
        setSelectedExecutionEvents([]);
        return;
      }

      const response = await getLatestEvents({
        limit: 200,
        category: "automation",
        correlationId: entry.correlationId
      });
      setSelectedExecutionEvents(Array.isArray(response.events) ? response.events : []);
    } catch (error) {
      toast({
        title: "Failed to load execution logs",
        description: errorMessage(error, "Unable to load runtime logs for this workflow."),
        variant: "destructive"
      });
      setSelectedExecutionEvents([]);
    } finally {
      setLoadingExecutionEvents(false);
    }
  }, [toast]);

  const handleCopyExecutionLogs = useCallback(async () => {
    if (!selectedExecution) {
      return;
    }

    try {
      const clipboardText = buildExecutionLogClipboardText({
        execution: selectedExecution,
        executionName: resolveExecutionName(selectedExecution),
        events: selectedExecutionEvents
      });
      await copyTextToClipboard(clipboardText);
      toast({
        title: "Logs copied",
        description: "Execution logs are ready to paste."
      });
    } catch (error) {
      toast({
        title: "Copy failed",
        description: errorMessage(error, "Unable to copy execution logs."),
        variant: "destructive"
      });
    }
  }, [resolveExecutionName, selectedExecution, selectedExecutionEvents, toast]);

  const handleAutomationEvent = useCallback((event: PlatformEvent) => {
    latestActivitySequenceRef.current = Math.max(latestActivitySequenceRef.current, Number(event.sequence) || 0);
    setActivityEvents((prev) => [event, ...prev].slice(0, AUTOMATION_ACTIVITY_LIMIT));

    if (selectedExecution?.correlationId && event.correlationId === selectedExecution.correlationId) {
      setSelectedExecutionEvents((prev) => {
        if (prev.some((entry) => entry.id === event.id)) {
          return prev;
        }
        return [...prev, event];
      });
    }

    if (event.type === "automation.action.started" || event.type === "automation.action.completed" || event.type === "automation.action.failed") {
      const payload = event.payload || {};
      const correlationId = typeof payload.correlationId === "string" && payload.correlationId.trim()
        ? payload.correlationId.trim()
        : event.correlationId || "";

      if (correlationId) {
        setRunningExecutions((prev) => prev.map((entry) => (
          entry.correlationId === correlationId
            ? {
                ...entry,
                currentAction: event.type === "automation.action.started"
                  ? {
                      actionIndex: typeof payload.actionIndex === "number" ? payload.actionIndex : undefined,
                      parentActionIndex: typeof payload.parentActionIndex === "number" ? payload.parentActionIndex : null,
                      actionType: typeof payload.actionType === "string" ? payload.actionType : undefined,
                      target: payload.target,
                      startedAt: event.createdAt,
                      updatedAt: event.createdAt,
                      message: typeof payload.message === "string" ? payload.message : "Action running"
                    }
                  : event.type === "automation.action.failed"
                    ? {
                        actionIndex: typeof payload.actionIndex === "number" ? payload.actionIndex : undefined,
                        parentActionIndex: typeof payload.parentActionIndex === "number" ? payload.parentActionIndex : null,
                        actionType: typeof payload.actionType === "string" ? payload.actionType : undefined,
                        target: payload.target,
                        updatedAt: event.createdAt,
                        message: typeof payload.message === "string" ? payload.message : "Action failed"
                      }
                    : null,
                lastEvent: {
                  type: event.type,
                  level: event.severity,
                  message: typeof payload.message === "string" ? payload.message : activitySummary(event),
                  details: payload,
                  createdAt: event.createdAt
                }
              }
            : entry
        )));
      }
    }

    if (event.type === "automation.execution.started" || event.type === "automation.execution.completed") {
      void loadRuntimeData({ silent: true });
    }
  }, [loadRuntimeData, selectedExecution]);

  useEffect(() => {
    if (loading) {
      return;
    }

    activityCleanupRef.current?.();
    activityCleanupRef.current = openEventStream(
      {
        sinceSequence: latestActivitySequenceRef.current || 0,
        limit: AUTOMATION_ACTIVITY_LIMIT,
        category: "automation"
      },
      {
        onEvent: handleAutomationEvent,
        onReady: (sinceSequence) => {
          setActivityConnected(true);
          latestActivitySequenceRef.current = Math.max(latestActivitySequenceRef.current, sinceSequence || 0);
        },
        onError: () => {
          setActivityConnected(false);
        }
      }
    );

    return () => {
      activityCleanupRef.current?.();
      activityCleanupRef.current = null;
      setActivityConnected(false);
    };
  }, [handleAutomationEvent, loading]);

  const openCreateDialog = () => {
    setSelectedWorkflow(null);
    setDialogOpen(true);
  };

  const openEditDialog = (workflow: Workflow) => {
    setSelectedWorkflow(workflow);
    setDialogOpen(true);
  };

  const openReviseDialog = (workflow: Workflow) => {
    setWorkflowToRevise(workflow);
    setRevisePrompt("");
    setReviseDialogOpen(true);
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
      void loadRuntimeData({ silent: true });
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

  const handleReviseWorkflow = async () => {
    const text = revisePrompt.trim();
    if (!workflowToRevise?._id || !text) {
      return;
    }

    setRevisingWorkflow(true);
    try {
      const result = await reviseWorkflowFromText(workflowToRevise._id, {
        text,
        source: "chat"
      });

      setWorkflows((prev) => prev.map((workflow) => (
        workflow._id === workflowToRevise._id ? result.workflow : workflow
      )));
      setReviseDialogOpen(false);
      setWorkflowToRevise(null);
      setRevisePrompt("");
      toast({
        title: "Workflow revised",
        description: result.message
      });
    } catch (error) {
      toast({
        title: "AI revise failed",
        description: errorMessage(error, "Unable to revise the workflow from text."),
        variant: "destructive"
      });
    } finally {
      setRevisingWorkflow(false);
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
                Describe a new workflow in plain English. For existing workflows, use the AI revise action on that workflow card.
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
              Use the same command parser as remote voice devices to create, revise, or run workflows from text.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                value={chatCommand}
                onChange={(event) => setChatCommand(event.target.value)}
                placeholder={isAdmin
                ? 'Try: "fix the Alarm Armed workflow so it uses the Interior Lights group"'
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

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-4 w-4" />
                Automation Runtime
              </CardTitle>
              <CardDescription>
                Live execution state, recent trigger evaluations, and runtime logs for workflow-backed automations.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn(activityConnected && "border-cyan-300 text-cyan-700 dark:text-cyan-200")}>
                {activityConnected ? "Live connected" : "Live reconnecting"}
              </Badge>
              <Button variant="outline" size="sm" onClick={() => void loadRuntimeData()} disabled={runtimeRefreshing}>
                {runtimeRefreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Refresh Runtime
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-foreground">Running Now</div>
                <Badge variant="outline">{runningExecutions.length}</Badge>
              </div>
              {runningExecutions.length > 0 ? (
                <div className="grid gap-3">
                  {runningExecutions.map((execution) => (
                    <div
                      key={execution._id}
                      className="rounded-2xl border border-cyan-200/60 bg-cyan-50/50 p-4 dark:border-cyan-500/20 dark:bg-cyan-500/10"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold">{resolveExecutionName(execution)}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            Trigger: {execution.triggerType.replace(/_/g, " ")} via {execution.triggerSource.replace(/_/g, " ")}
                          </div>
                        </div>
                        <span className="rounded-full border border-cyan-200 bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-200">
                          Running
                        </span>
                      </div>

                      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Started</div>
                          <div className="mt-1 font-medium">{formatDateTime(execution.startedAt)}</div>
                        </div>
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Elapsed</div>
                          <div className="mt-1 font-medium">{formatRunningSince(execution.startedAt)}</div>
                        </div>
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Current Step</div>
                          <div className="mt-1 font-medium">
                            {execution.currentAction?.message || execution.lastEvent?.message || "Waiting for next action"}
                          </div>
                        </div>
                      </div>

                      {execution.lastEvent?.message ? (
                        <div className="mt-3 rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
                          Latest update: {execution.lastEvent.message}
                        </div>
                      ) : null}

                      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          Progress: {execution.successfulActions || 0}/{execution.totalActions || 0} steps finished
                        </span>
                        <Button size="sm" variant="outline" onClick={() => void openExecutionLogs(execution)}>
                          View Logs
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-border/70 bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
                  No workflow-backed automations are running right now.
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-foreground">Live Activity</div>
                <Badge variant="outline">{activityEvents.length}</Badge>
              </div>
              <ScrollArea className="h-[360px] rounded-2xl border border-border/70 bg-background/70">
                <div className="space-y-3 p-3">
                  {activityEvents.length > 0 ? activityEvents.map((event) => (
                    <div
                      key={event.id}
                      className={cn("rounded-xl border px-3 py-3 text-sm", activitySeverityClassName(event.severity))}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium">{activitySummary(event)}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{formatDateTime(event.createdAt)}</div>
                        </div>
                        <Badge variant="outline" className="text-[10px] uppercase tracking-[0.16em]">
                          {event.severity}
                        </Badge>
                      </div>
                      {typeof event.payload?.message === "string" && event.payload.message.trim() ? (
                        <div className="mt-2 text-xs text-muted-foreground">{event.payload.message}</div>
                      ) : null}
                    </div>
                  )) : (
                    <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
                      Automation activity will appear here as workflows trigger and run.
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-foreground">Recent Executions</div>
              <div className="text-xs text-muted-foreground">
                Shows the latest persisted runtime records for workflow-backed automations.
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead className="text-right">Logs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runtimeHistory.length > 0 ? runtimeHistory.map((entry) => (
                    <TableRow key={entry._id}>
                      <TableCell>
                        <div className="font-medium">{resolveExecutionName(entry)}</div>
                        <div className="text-xs text-muted-foreground">{entry.automationName}</div>
                      </TableCell>
                      <TableCell>
                        <span className={cn("inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold", runtimeStatusClassName(entry.status))}>
                          {runtimeStatusLabel(entry.status)}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {entry.triggerType.replace(/_/g, " ")}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateTime(entry.startedAt)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {entry.status === "running" ? formatRunningSince(entry.startedAt) : formatDuration(entry.durationMs)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {entry.lastEvent?.message || (entry.failedActions > 0
                          ? `${entry.failedActions} step(s) failed`
                          : `${entry.successfulActions || 0} step(s) succeeded`)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" onClick={() => void openExecutionLogs(entry)}>
                          View Logs
                        </Button>
                      </TableCell>
                    </TableRow>
                  )) : (
                    <TableRow>
                      <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                        No workflow execution history has been recorded yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {workflows.map((workflow) => (
          <Card
            key={workflow._id}
            className={cn(
              "transition-all duration-200",
              workflow.enabled && "border-cyan-300/35 shadow-[0_0_0_1px_rgba(103,232,249,0.18),0_20px_48px_rgba(34,211,238,0.08)]"
            )}
          >
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-lg">{workflow.name}</CardTitle>
                  <CardDescription>{workflow.description || "No description provided."}</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {runningWorkflowIds.has(workflow._id) ? (
                    <div className="flex min-w-[96px] items-center justify-center rounded-full border border-cyan-200/90 bg-cyan-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-200">
                      Running
                    </div>
                  ) : null}
                  <div
                    className={cn(
                      "flex min-w-[112px] items-center justify-center rounded-full border px-4 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] transition-all",
                      workflow.enabled
                        ? "border-cyan-200/90 bg-[linear-gradient(135deg,rgba(86,234,255,0.98),rgba(40,208,255,0.94))] text-white shadow-[0_12px_30px_rgba(34,211,238,0.3)]"
                        : "border-white/15 bg-transparent text-muted-foreground"
                    )}
                  >
                    {workflow.enabled ? "Enabled" : "Disabled"}
                  </div>
                  <Switch
                    className={cn(
                      workflow.enabled
                        ? "border-cyan-200/90 data-[state=checked]:!bg-cyan-400 data-[state=checked]:shadow-[0_0_0_1px_rgba(165,243,252,0.5),0_12px_28px_rgba(34,211,238,0.3)]"
                        : "border-white/20 data-[state=unchecked]:!bg-white/10"
                    )}
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
                    <Button size="sm" variant="outline" onClick={() => openReviseDialog(workflow)}>
                      <Wand2 className="mr-2 h-4 w-4" />
                      AI Revise
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

      <Dialog open={reviseDialogOpen} onOpenChange={(open) => {
        setReviseDialogOpen(open);
        if (!open) {
          setWorkflowToRevise(null);
          setRevisePrompt("");
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Revise Workflow with AI</DialogTitle>
            <DialogDescription>
              {workflowToRevise
                ? `Tell HomeBrain how to change "${workflowToRevise.name}". It will rewrite the existing workflow instead of creating a new one.`
                : "Describe the changes you want for the selected workflow."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {workflowToRevise ? (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <div className="font-medium">{workflowToRevise.name}</div>
                <div className="mt-1 text-muted-foreground">
                  {workflowToRevise.description || "No description provided."}
                </div>
              </div>
            ) : null}
            <Textarea
              value={revisePrompt}
              onChange={(event) => setRevisePrompt(event.target.value)}
              placeholder='Example: Fix this workflow so it turns off all interior Insteon lights, not just a few of them. Use the "Interior Lights" device group when possible.'
              className="min-h-[140px]"
            />
            <div className="flex justify-end">
              <Button onClick={() => void handleReviseWorkflow()} disabled={revisingWorkflow || !revisePrompt.trim() || !workflowToRevise}>
                <Wand2 className="mr-2 h-4 w-4" />
                {revisingWorkflow ? "Revising..." : "Revise Workflow"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(selectedExecution)} onOpenChange={(open) => {
        if (!open) {
          setSelectedExecution(null);
          setSelectedExecutionEvents([]);
        }
      }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1.5">
                <DialogTitle>
                  {selectedExecution ? resolveExecutionName(selectedExecution) : "Execution Logs"}
                </DialogTitle>
                <DialogDescription>
                  {selectedExecution
                    ? `Started ${formatDateTime(selectedExecution.startedAt)} from ${selectedExecution.triggerType.replace(/_/g, " ")}.`
                    : "Detailed runtime logs for the selected workflow execution."}
                </DialogDescription>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleCopyExecutionLogs()}
                disabled={!selectedExecution || loadingExecutionEvents}
              >
                <Copy className="mr-2 h-4 w-4" />
                Copy Logs
              </Button>
            </div>
          </DialogHeader>

          {selectedExecution ? (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-xl border bg-muted/30 p-3">
                  <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Status</div>
                  <div className="mt-2">
                    <span className={cn("inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold", runtimeStatusClassName(selectedExecution.status))}>
                      {runtimeStatusLabel(selectedExecution.status)}
                    </span>
                  </div>
                </div>
                <div className="rounded-xl border bg-muted/30 p-3">
                  <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Started</div>
                  <div className="mt-2 text-sm font-medium">{formatDateTime(selectedExecution.startedAt)}</div>
                </div>
                <div className="rounded-xl border bg-muted/30 p-3">
                  <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Duration</div>
                  <div className="mt-2 text-sm font-medium">
                    {selectedExecution.status === "running"
                      ? formatRunningSince(selectedExecution.startedAt)
                      : formatDuration(selectedExecution.durationMs)}
                  </div>
                </div>
                <div className="rounded-xl border bg-muted/30 p-3">
                  <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Result</div>
                  <div className="mt-2 text-sm font-medium">
                    {selectedExecution.failedActions > 0
                      ? `${selectedExecution.failedActions} failed`
                      : `${selectedExecution.successfulActions || 0} succeeded`}
                  </div>
                </div>
              </div>

              <ScrollArea className="h-[420px] rounded-2xl border border-border/70 bg-background/70">
                <div className="space-y-3 p-4">
                  {loadingExecutionEvents ? (
                    <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading runtime logs...
                    </div>
                  ) : selectedExecutionEvents.length > 0 ? selectedExecutionEvents.map((event) => (
                    <div
                      key={event.id}
                      className={cn("rounded-xl border px-3 py-3", activitySeverityClassName(event.severity))}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium">{activitySummary(event)}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{formatDateTime(event.createdAt)}</div>
                        </div>
                        <Badge variant="outline" className="text-[10px] uppercase tracking-[0.16em]">
                          {event.type.replace("automation.", "")}
                        </Badge>
                      </div>
                      {typeof event.payload?.message === "string" && event.payload.message.trim() ? (
                        <div className="mt-2 text-sm text-muted-foreground">{event.payload.message}</div>
                      ) : null}
                    </div>
                  )) : (
                    <div className="rounded-xl border border-dashed border-border/70 px-4 py-12 text-center text-sm text-muted-foreground">
                      No detailed runtime events were recorded for this execution.
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <WorkflowBuilderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialWorkflow={selectedWorkflow}
        devices={devices}
        deviceGroups={deviceGroups}
        scenes={scenes}
        onSave={handleSaveWorkflow}
        isSaving={savingWorkflow}
      />
    </div>
  );
}
