import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ChevronDown,
  ChevronUp,
  Clock3,
  Plus,
  Save,
  Trash2,
  Workflow as WorkflowIcon
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import type { DeviceGroupSummary } from "@/api/devices";
import type { Workflow, WorkflowAction, WorkflowActionTarget, WorkflowTriggerType } from "@/api/workflows";

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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialWorkflow?: Workflow | null;
  devices: DeviceLite[];
  deviceGroups?: DeviceGroupSummary[];
  scenes: SceneLite[];
  onSave: (payload: Partial<Workflow>) => Promise<void> | void;
  isSaving?: boolean;
};

const DEFAULT_ACTION: WorkflowAction = {
  type: "device_control",
  target: null,
  parameters: { action: "turn_on" }
};

const TRIGGERING_DEVICE_TARGET_VALUE = "__triggering_device__";
const DEVICE_GROUP_TARGET_PREFIX = "__device_group__:";
const MAX_DELAY_SECONDS = 24 * 60 * 60;

const TRIGGER_LABELS: Record<WorkflowTriggerType, string> = {
  manual: "Manual",
  time: "Time of day",
  schedule: "Schedule",
  device_state: "Device state",
  sensor: "Sensor event",
  security_alarm_status: "Security alarm"
};

const ACTION_LABELS: Record<WorkflowAction["type"], string> = {
  device_control: "Control device",
  scene_activate: "Activate scene",
  notification: "Notification",
  delay: "Delay",
  condition: "Condition gate",
  workflow_control: "Workflow control",
  variable_control: "Variable control",
  repeat: "Repeat",
  isy_network_resource: "ISY network resource",
  http_request: "HTTP request"
};

type TriggerPropertyKind = "boolean" | "number" | "string";

type TriggerPropertyOption = {
  key: string;
  label: string;
  kind: TriggerPropertyKind;
  unit?: string;
  energyMetric?: boolean;
};

const NUMERIC_TRIGGER_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;
const TEXT_TRIGGER_OPERATORS = ["eq", "neq", "contains"] as const;
const TRIGGER_OPERATOR_LABELS: Record<string, string> = {
  eq: "Equals",
  neq: "Does not equal",
  gt: "Greater than",
  gte: "Greater than or equal",
  lt: "Less than",
  lte: "Less than or equal",
  contains: "Contains"
};

function prettifyTriggerSegment(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
}

function formatSmartThingsAttributeLabel(path: string[], unit?: string) {
  const [capability, attribute] = path.slice(-2);
  const suffix = unit ? ` (${unit})` : "";
  const aliasKey = `${capability || ""}.${attribute || ""}`;

  switch (aliasKey) {
    case "powerMeter.power":
      return `Power draw${suffix}`;
    case "energyMeter.energy":
      return `Energy total${suffix}`;
    case "temperatureMeasurement.temperature":
      return `Temperature${suffix}`;
    case "humidityMeasurement.humidity":
      return `Humidity${suffix}`;
    case "switch.switch":
      return "Switch state";
    case "dryerOperatingState.machineState":
      return "Dryer state";
    case "washerOperatingState.machineState":
      return "Washer state";
    default:
      return `${path.map(prettifyTriggerSegment).join(" / ")}${suffix}`;
  }
}

function formatTriggerPropertyLabel(property: string) {
  if (!property) {
    return "Status";
  }

  if (property === "status") {
    return "Status";
  }

  if (property === "isOnline") {
    return "Online state";
  }

  if (property === "brightness") {
    return "Brightness (%)";
  }

  if (property === "temperature") {
    return "Temperature";
  }

  if (property === "targetTemperature") {
    return "Target temperature";
  }

  if (property.startsWith("smartThingsAttributeValues.")) {
    return formatSmartThingsAttributeLabel(property.replace(/^smartThingsAttributeValues\./, "").split("."));
  }

  return prettifyTriggerSegment(property);
}

function isEnergyTriggerProperty(key: string) {
  return key === "smartThingsAttributeValues.powerMeter.power"
    || key === "smartThingsAttributeValues.energyMeter.energy";
}

function getTriggerOperatorOptions(kind: TriggerPropertyKind) {
  const values = kind === "number"
    ? NUMERIC_TRIGGER_OPERATORS
    : kind === "string"
      ? TEXT_TRIGGER_OPERATORS
      : ["eq", "neq"];

  return values.map((value) => ({
    value,
    label: TRIGGER_OPERATOR_LABELS[value] || value
  }));
}

function inferTriggerPropertyKind(value: unknown): TriggerPropertyKind {
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return "number";
  }
  return "string";
}

function getNestedRecordValue(source: unknown, path: string[]): unknown {
  let current = source;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function collectSmartThingsAttributeOptions(
  node: unknown,
  metadataNode: unknown,
  prefix: string[] = []
): TriggerPropertyOption[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return [];
  }

  const options: TriggerPropertyOption[] = [];

  Object.entries(node as Record<string, unknown>).forEach(([key, value]) => {
    if (key === "byComponent") {
      Object.entries((value as Record<string, unknown>) || {}).forEach(([componentId, componentValue]) => {
        if (componentId === "main") {
          return;
        }
        options.push(...collectSmartThingsAttributeOptions(componentValue, getNestedRecordValue(metadataNode, [key, componentId]), [...prefix, key, componentId]));
      });
      return;
    }

    const nextPrefix = [...prefix, key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      options.push(...collectSmartThingsAttributeOptions(value, getNestedRecordValue(metadataNode, [key]), nextPrefix));
      return;
    }

    const metadata = getNestedRecordValue(metadataNode, [key]) as Record<string, unknown> | undefined;
    const unit = typeof metadata?.unit === "string" && metadata.unit.trim() ? metadata.unit.trim() : undefined;
    options.push({
      key: `smartThingsAttributeValues.${nextPrefix.join(".")}`,
      label: formatSmartThingsAttributeLabel(nextPrefix, unit),
      kind: inferTriggerPropertyKind(value),
      unit,
      energyMetric: isEnergyTriggerProperty(`smartThingsAttributeValues.${nextPrefix.join(".")}`)
    });
  });

  return options;
}

function getTriggerPropertyOptions(device: DeviceLite | undefined): TriggerPropertyOption[] {
  const options: TriggerPropertyOption[] = [
    { key: "status", label: "Status", kind: "boolean" },
    { key: "isOnline", label: "Online state", kind: "boolean" }
  ];

  if (typeof device?.brightness === "number") {
    options.push({ key: "brightness", label: "Brightness (%)", kind: "number", unit: "%" });
  }
  if (typeof device?.temperature === "number") {
    options.push({ key: "temperature", label: "Temperature", kind: "number" });
  }
  if (typeof device?.targetTemperature === "number") {
    options.push({ key: "targetTemperature", label: "Target temperature", kind: "number" });
  }

  const attributeValues = (device?.properties as Record<string, unknown> | undefined)?.smartThingsAttributeValues;
  const attributeMetadata = (device?.properties as Record<string, unknown> | undefined)?.smartThingsAttributeMetadata;
  options.push(...collectSmartThingsAttributeOptions(attributeValues, attributeMetadata));

  const unique = new Map<string, TriggerPropertyOption>();
  options.forEach((option) => {
    if (!unique.has(option.key)) {
      unique.set(option.key, option);
    }
  });
  return [...unique.values()];
}

function normalizeTriggerOperator(value: unknown, kind: TriggerPropertyKind) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  const allowed = kind === "number" ? NUMERIC_TRIGGER_OPERATORS : kind === "string" ? TEXT_TRIGGER_OPERATORS : ["eq", "neq"];
  return allowed.includes(normalized as any) ? normalized : "eq";
}

function getDefaultTriggerOperator(option: TriggerPropertyOption, previousOperator: unknown) {
  const normalizedPrevious = normalizeTriggerOperator(previousOperator, option.kind);
  if (option.kind === "number" && option.energyMetric && normalizedPrevious === "eq") {
    return "gt";
  }
  return normalizedPrevious;
}

function normalizeSolarScheduleEvent(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "sunrise" || normalized === "sunset" ? normalized : null;
}

function isSolarScheduleTrigger(conditions: Record<string, unknown>) {
  return Boolean(normalizeSolarScheduleEvent(conditions.event));
}

function getScheduleMode(conditions: Record<string, unknown>) {
  return isSolarScheduleTrigger(conditions) ? "solar" : "cron";
}

function isTriggeringDeviceTarget(target: WorkflowActionTarget | undefined) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return false;
  }

  const kind = typeof target.kind === "string" ? target.kind : target.type;
  const key = typeof target.key === "string" ? target.key : target.contextKey;
  return String(kind || "").toLowerCase() === "context" && key === "triggeringDeviceId";
}

function buildTriggeringDeviceTarget(): WorkflowActionTarget {
  return { kind: "context", key: "triggeringDeviceId" };
}

function normalizeDeviceGroups(groups: unknown): string[] {
  const values = Array.isArray(groups)
    ? groups
    : typeof groups === "string"
      ? groups.split(",")
      : [];

  const seen = new Set<string>();
  const normalized: string[] = [];

  values.forEach((entry) => {
    const trimmed = String(entry || "").trim();
    if (!trimmed) {
      return;
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    normalized.push(trimmed);
  });

  return normalized;
}

function isDeviceGroupTarget(target: WorkflowActionTarget | undefined) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return false;
  }

  const kind = String(target.kind || target.type || "").toLowerCase();
  const group = String(target.group || target.name || target.label || target.value || "").trim();
  return (kind === "device_group" || kind === "group") && Boolean(group);
}

function buildDeviceGroupTarget(group: string): WorkflowActionTarget {
  return {
    kind: "device_group",
    group
  };
}

function getDeviceGroupName(target: WorkflowActionTarget | undefined) {
  if (!isDeviceGroupTarget(target)) {
    return null;
  }

  const group = String((target as Record<string, unknown>).group
    || (target as Record<string, unknown>).name
    || (target as Record<string, unknown>).label
    || (target as Record<string, unknown>).value
    || "").trim();
  return group || null;
}

function getDeviceGroupTargetSelectValue(group: string) {
  return `${DEVICE_GROUP_TARGET_PREFIX}${group}`;
}

function parseDeviceGroupSelectValue(value: string) {
  return value.startsWith(DEVICE_GROUP_TARGET_PREFIX)
    ? value.slice(DEVICE_GROUP_TARGET_PREFIX.length)
    : null;
}

function getDefaultDeviceTarget(triggerType: WorkflowTriggerType, devices: DeviceLite[]): WorkflowActionTarget {
  if (triggerType === "device_state") {
    return buildTriggeringDeviceTarget();
  }

  return devices[0]?._id || null;
}

function buildDefaultAction(triggerType: WorkflowTriggerType, devices: DeviceLite[]): WorkflowAction {
  return {
    type: "device_control",
    target: getDefaultDeviceTarget(triggerType, devices),
    parameters: { action: "turn_on" }
  };
}

function getActionTargetSelectValue(target: WorkflowActionTarget | undefined) {
  if (isTriggeringDeviceTarget(target)) {
    return TRIGGERING_DEVICE_TARGET_VALUE;
  }

  if (isDeviceGroupTarget(target)) {
    return getDeviceGroupTargetSelectValue(getDeviceGroupName(target) || "");
  }

  return typeof target === "string" ? target : "";
}

function getDefaultTriggerConditions(type: WorkflowTriggerType) {
  if (type === "time") {
    return { hour: 7, minute: 0, days: ["monday", "tuesday", "wednesday", "thursday", "friday"] };
  }
  if (type === "schedule") {
    return { cron: "0 7 * * 1-5" };
  }
  if (type === "device_state") {
    return { deviceId: "", state: "on", property: "status", operator: "eq", value: true };
  }
  if (type === "sensor") {
    return { sensorType: "motion", condition: "detected" };
  }
  if (type === "security_alarm_status") {
    return { states: ["armedStay", "armedAway"] };
  }
  return {};
}

function buildGraph(triggerType: WorkflowTriggerType, actions: WorkflowAction[]) {
  const nodes = [
    {
      id: "trigger-1",
      type: "trigger",
      label: `Trigger: ${triggerType}`,
      data: { triggerType },
      position: { x: 60, y: 48 }
    }
  ];
  const edges = [];
  let previous = "trigger-1";
  actions.forEach((action, index) => {
    const id = `action-${index + 1}`;
    const visualType =
      action.type === "device_control"
        ? "device_action"
        : action.type === "scene_activate"
          ? "scene_action"
          : action.type;
    nodes.push({
      id,
      type: visualType,
      label: `${index + 1}. ${action.type.replace(/_/g, " ")}`,
      data: {
        actionType: action.type,
        target: action.target,
        parameters: action.parameters || {}
      },
      position: { x: 60, y: 160 + index * 120 }
    });
    edges.push({
      id: `edge-${previous}-${id}`,
      source: previous,
      target: id,
      label: ""
    });
    previous = id;
  });
  return { nodes, edges };
}

function getDeviceActionChoices(deviceType: string, source: string = "local") {
  if ((source || "").toLowerCase() === "harmony") {
    return ["turn_on", "turn_off", "toggle"];
  }

  switch ((deviceType || "").toLowerCase()) {
    case "light":
      return ["turn_on", "turn_off", "set_brightness", "set_color"];
    case "thermostat":
      return ["turn_on", "turn_off", "set_temperature"];
    case "lock":
      return ["lock", "unlock"];
    case "garage":
      return ["open", "close"];
    case "switch":
      return ["turn_on", "turn_off", "toggle"];
    case "speaker":
      return ["turn_on", "turn_off", "toggle"];
    default:
      return ["turn_on", "turn_off"];
  }
}

function getCommonDeviceActionChoices(devices: DeviceLite[]) {
  if (!Array.isArray(devices) || devices.length === 0) {
    return ["turn_on", "turn_off"];
  }

  const choiceSets = devices.map((device) =>
    getDeviceActionChoices(
      device?.type || "switch",
      ((device?.properties as Record<string, unknown> | undefined)?.source as string | undefined) || "local"
    )
  );

  const [firstChoices, ...remainingChoices] = choiceSets;
  const sharedChoices = firstChoices.filter((choice) =>
    remainingChoices.every((choices) => choices.includes(choice))
  );

  return sharedChoices.length > 0 ? sharedChoices : firstChoices;
}

function formatActionVerb(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return "turn on";
  }

  return value.replace(/_/g, " ").trim();
}

function formatDuration(secondsValue: unknown) {
  const seconds = Math.max(0, Number(secondsValue) || 0);
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const remainderSeconds = seconds % 60;
    return remainderSeconds > 0 ? `${minutes} min ${remainderSeconds} sec` : `${minutes} min`;
  }
  return `${seconds} sec`;
}

function formatOffsetMinutes(offsetValue: unknown) {
  const offset = Math.round(Number(offsetValue) || 0);
  if (offset === 0) {
    return "at the event";
  }

  const absolute = Math.abs(offset);
  const durationLabel = absolute === 1 ? "1 minute" : `${absolute} minutes`;
  return offset > 0 ? `${durationLabel} after` : `${durationLabel} before`;
}

function getDeviceLabel(devices: DeviceLite[], deviceId: string | null | undefined) {
  if (!deviceId) {
    return "No device selected";
  }

  const device = devices.find((entry) => entry._id === deviceId);
  return device ? device.name : "Selected device";
}

function getDeviceGroupLabel(groupName: string | null | undefined) {
  return groupName ? `Group: ${groupName}` : "No group selected";
}

function getSceneLabel(scenes: SceneLite[], sceneId: string | null | undefined) {
  if (!sceneId) {
    return "No scene selected";
  }

  const scene = scenes.find((entry) => entry._id === sceneId);
  return scene ? scene.name : "Selected scene";
}

function describeTrigger(
  triggerType: WorkflowTriggerType,
  triggerConditions: Record<string, unknown>,
  devices: DeviceLite[]
) {
  switch (triggerType) {
    case "manual":
      return "Runs manually or from a voice/chat command.";
    case "time": {
      const hour = Number(triggerConditions.hour ?? 0);
      const minute = Number(triggerConditions.minute ?? 0);
      const days = Array.isArray(triggerConditions.days) ? triggerConditions.days.join(", ") : "";
      const timeLabel = `${String(Math.max(0, Math.min(23, hour))).padStart(2, "0")}:${String(Math.max(0, Math.min(59, minute))).padStart(2, "0")}`;
      return days ? `Runs at ${timeLabel} on ${days}.` : `Runs at ${timeLabel}.`;
    }
    case "schedule":
      if (isSolarScheduleTrigger(triggerConditions)) {
        const event = normalizeSolarScheduleEvent(triggerConditions.event) || "sunset";
        const offset = Math.round(Number(triggerConditions.offset) || 0);
        if (offset === 0) {
          return `Runs at ${event}.`;
        }
        return `Runs ${formatOffsetMinutes(triggerConditions.offset)} ${event}.`;
      }
      return `Runs on cron schedule "${String(triggerConditions.cron || "")}".`;
    case "device_state": {
      const deviceName = getDeviceLabel(
        devices,
        typeof triggerConditions.deviceId === "string" ? triggerConditions.deviceId : null
      );
      const property = typeof triggerConditions.property === "string" && triggerConditions.property.trim()
        ? triggerConditions.property
        : "status";
      const operator = typeof triggerConditions.operator === "string" && triggerConditions.operator.trim()
        ? triggerConditions.operator
        : "eq";
      const value = Object.prototype.hasOwnProperty.call(triggerConditions, "value")
        ? triggerConditions.value
        : triggerConditions.state ?? true;
      const forSeconds = Math.max(0, Number(triggerConditions.forSeconds) || 0);
      const propertyLabel = formatTriggerPropertyLabel(property).toLowerCase();
      const normalizedOperator = normalizeTriggerOperator(operator, inferTriggerPropertyKind(value));
      const operatorLabel = (TRIGGER_OPERATOR_LABELS[normalizedOperator] || normalizedOperator).toLowerCase();
      const conditionText = `${propertyLabel} ${operatorLabel} ${String(value)}`;
      if (forSeconds > 0) {
        return `${deviceName} keeps ${conditionText} for ${formatDuration(forSeconds)}.`;
      }
      return `${deviceName} reaches ${conditionText}.`;
    }
    case "sensor":
      return `Runs when ${String(triggerConditions.sensorType || "sensor")} is ${String(triggerConditions.condition || "triggered")}.`;
    case "security_alarm_status": {
      const states = Array.isArray(triggerConditions.states)
        ? triggerConditions.states.filter(Boolean).join(", ")
        : "";
      return states ? `Runs when the alarm enters ${states}.` : "Runs when the security alarm state changes.";
    }
    default:
      return "Trigger configuration ready.";
  }
}

function describeAction(
  action: WorkflowAction,
  devices: DeviceLite[],
  scenes: SceneLite[],
  triggerDeviceId: string | null
) {
  switch (action.type) {
    case "device_control": {
      const targetLabel = isTriggeringDeviceTarget(action.target)
        ? getDeviceLabel(devices, triggerDeviceId) === "No device selected"
          ? "the triggering device"
          : getDeviceLabel(devices, triggerDeviceId)
        : isDeviceGroupTarget(action.target)
          ? getDeviceGroupLabel(getDeviceGroupName(action.target))
          : getDeviceLabel(devices, typeof action.target === "string" ? action.target : null);
      const verb = formatActionVerb(action.parameters?.action);
      if (verb === "set brightness") {
        return `${targetLabel} -> ${verb} to ${String(action.parameters?.brightness ?? action.parameters?.value ?? 100)}.`;
      }
      if (verb === "set temperature") {
        return `${targetLabel} -> ${verb} to ${String(action.parameters?.temperature ?? 72)}.`;
      }
      return `${targetLabel} -> ${verb}.`;
    }
    case "scene_activate":
      return `Activate ${getSceneLabel(scenes, typeof action.target === "string" ? action.target : null)}.`;
    case "delay":
      return `Wait ${formatDuration(action.parameters?.seconds ?? 0)}.`;
    case "notification": {
      const message = String(action.parameters?.message || "").trim();
      return message ? `Send "${message}".` : "Send a notification.";
    }
    case "condition":
      return "Only continue when the condition evaluates as true.";
    default:
      return ACTION_LABELS[action.type] || action.type;
  }
}

export function WorkflowBuilderDialog({
  open,
  onOpenChange,
  initialWorkflow,
  devices,
  deviceGroups: availableDeviceGroups = [],
  scenes,
  onSave,
  isSaving = false
}: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<Workflow["category"]>("custom");
  const [priority, setPriority] = useState(5);
  const [cooldown, setCooldown] = useState(0);
  const [voiceAliasesText, setVoiceAliasesText] = useState("");
  const [triggerType, setTriggerType] = useState<WorkflowTriggerType>("manual");
  const [triggerConditions, setTriggerConditions] = useState<Record<string, unknown>>({});
  const [actions, setActions] = useState<WorkflowAction[]>([DEFAULT_ACTION]);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (initialWorkflow) {
      setName(initialWorkflow.name || "");
      setDescription(initialWorkflow.description || "");
      setCategory(initialWorkflow.category || "custom");
      setPriority(initialWorkflow.priority || 5);
      setCooldown(initialWorkflow.cooldown || 0);
      setVoiceAliasesText((initialWorkflow.voiceAliases || []).join(", "));
      setTriggerType((initialWorkflow.trigger?.type as WorkflowTriggerType) || "manual");
      setTriggerConditions(initialWorkflow.trigger?.conditions || {});
      setActions(initialWorkflow.actions?.length ? initialWorkflow.actions : [buildDefaultAction("manual", devices)]);
      return;
    }

    setName("");
    setDescription("");
    setCategory("custom");
    setPriority(5);
    setCooldown(0);
    setVoiceAliasesText("");
    setTriggerType("manual");
    setTriggerConditions({});
    setActions([buildDefaultAction("manual", devices)]);
  }, [initialWorkflow, open]);

  const visualGraph = useMemo(() => buildGraph(triggerType, actions), [triggerType, actions]);

  const devicesByRoom = useMemo(() => {
    return devices.reduce<Record<string, DeviceLite[]>>((acc, device) => {
      const room = device.room || "Unassigned";
      if (!acc[room]) {
        acc[room] = [];
      }
      acc[room].push(device);
      return acc;
    }, {});
  }, [devices]);

  const deviceGroups = useMemo(() => {
    const groups = new Map<string, {
      name: string;
      description?: string;
      devices: DeviceLite[];
    }>();

    const ensureGroup = (groupName: string, description?: string) => {
      const trimmed = String(groupName || "").trim();
      if (!trimmed) {
        return null;
      }

      const key = trimmed.toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, {
          name: trimmed,
          description: typeof description === "string" ? description.trim() : "",
          devices: []
        });
      } else if (description && !groups.get(key)?.description) {
        groups.get(key)!.description = description.trim();
      }

      return groups.get(key) || null;
    };

    availableDeviceGroups.forEach((group) => {
      ensureGroup(group.name, group.description);
    });

    devices.forEach((device) => {
      normalizeDeviceGroups(device.groups).forEach((groupName) => {
        ensureGroup(groupName)?.devices.push(device);
      });
    });

    return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [availableDeviceGroups, devices]);

  const deviceGroupsByName = useMemo(() => {
    return deviceGroups.reduce<Map<string, {
      name: string;
      description?: string;
      devices: DeviceLite[];
    }>>((acc, group) => {
      acc.set(group.name.toLowerCase(), group);
      return acc;
    }, new Map());
  }, [deviceGroups]);

  const triggerDeviceId = typeof triggerConditions.deviceId === "string" ? triggerConditions.deviceId : null;
  const triggerDevice = useMemo(
    () => devices.find((device) => device._id === triggerDeviceId),
    [devices, triggerDeviceId]
  );
  const triggerPropertyOptions = useMemo(
    () => getTriggerPropertyOptions(triggerDevice),
    [triggerDevice]
  );
  const selectedTriggerProperty = typeof triggerConditions.property === "string" && triggerConditions.property.trim()
    ? triggerConditions.property
    : "status";
  const selectedTriggerPropertyOption = triggerPropertyOptions.find((option) => option.key === selectedTriggerProperty)
    || {
      key: selectedTriggerProperty,
      label: formatTriggerPropertyLabel(selectedTriggerProperty),
      kind: inferTriggerPropertyKind(triggerConditions.value)
    };
  const selectedTriggerOperator = normalizeTriggerOperator(triggerConditions.operator, selectedTriggerPropertyOption.kind);
  const selectedTriggerOperatorOptions = getTriggerOperatorOptions(selectedTriggerPropertyOption.kind);
  const energyThresholdTrigger = Boolean(selectedTriggerPropertyOption.energyMetric);
  const triggerValueLabel = selectedTriggerPropertyOption.kind === "number"
    ? `${energyThresholdTrigger ? "Threshold" : "Value"}${selectedTriggerPropertyOption.unit ? ` (${selectedTriggerPropertyOption.unit})` : ""}`
    : "Value";
  const triggerSummary = useMemo(
    () => describeTrigger(triggerType, triggerConditions, devices),
    [devices, triggerConditions, triggerType]
  );
  const actionSummaries = useMemo(
    () => actions.map((action) => describeAction(action, devices, scenes, triggerDeviceId)),
    [actions, devices, scenes, triggerDeviceId]
  );

  const addAction = () => {
    setActions((prev) => [...prev, buildDefaultAction(triggerType, devices)]);
  };

  const removeAction = (index: number) => {
    setActions((prev) => prev.filter((_, actionIndex) => actionIndex !== index));
  };

  const updateAction = (index: number, patch: Partial<WorkflowAction>) => {
    setActions((prev) => prev.map((action, actionIndex) => {
      if (actionIndex !== index) {
        return action;
      }
      return {
        ...action,
        ...patch,
        parameters: {
          ...(action.parameters || {}),
          ...(patch.parameters || {})
        }
      };
    }));
  };

  const moveAction = (from: number, direction: -1 | 1) => {
    const to = from + direction;
    setActions((prev) => {
      if (to < 0 || to >= prev.length) {
        return prev;
      }
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const handleTriggerTypeChange = (value: WorkflowTriggerType) => {
    setTriggerType(value);
    setTriggerConditions(getDefaultTriggerConditions(value));
    if (value !== "device_state") {
      setActions((prev) => prev.map((action) => {
        if (action.type !== "device_control" || !isTriggeringDeviceTarget(action.target)) {
          return action;
        }

        return {
          ...action,
          target: devices[0]?._id || null
        };
      }));
    }
  };

  const handleScheduleModeChange = (value: "cron" | "solar") => {
    if (value === "solar") {
      setTriggerConditions({ event: "sunset", offset: 0 });
      return;
    }

    setTriggerConditions({ cron: "0 7 * * 1-5" });
  };

  const handleActionTypeChange = (index: number, nextType: WorkflowAction["type"]) => {
    const nextAction: WorkflowAction = {
      type: nextType,
      target: nextType === "scene_activate"
        ? scenes[0]?._id || null
        : nextType === "device_control"
          ? getDefaultDeviceTarget(triggerType, devices)
          : null,
      parameters: nextType === "delay"
        ? { seconds: 3 }
        : nextType === "notification"
          ? { message: "" }
          : nextType === "condition"
            ? {}
            : { action: "turn_on" }
    };
    setActions((prev) => prev.map((item, actionIndex) => actionIndex === index ? nextAction : item));
  };

  const onSubmit = async () => {
    if (!name.trim() || actions.length === 0) {
      return;
    }

    const workflowPayload: Partial<Workflow> = {
      name: name.trim(),
      description: description.trim(),
      category,
      priority,
      cooldown,
      trigger: {
        type: triggerType,
        conditions: triggerConditions
      },
      actions,
      voiceAliases: voiceAliasesText
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      graph: visualGraph
    };

    await onSave(workflowPayload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(94vh,960px)] max-h-[94vh] w-[min(96vw,1280px)] max-w-[1280px] flex-col overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 bg-background/95 px-5 py-5 sm:px-7">
          <div className="pr-10">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{initialWorkflow ? "Editing workflow" : "New workflow"}</Badge>
              <Badge variant="outline">{TRIGGER_LABELS[triggerType]}</Badge>
              <Badge variant="outline">{actions.length} {actions.length === 1 ? "step" : "steps"}</Badge>
            </div>
            <DialogTitle>{initialWorkflow ? "Edit Workflow" : "Create Workflow"}</DialogTitle>
            <DialogDescription>
              Tune the trigger and steps first. The right rail now keeps the summary visible so you can edit without losing the overall flow.
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1.7fr)_360px]">
          <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
            <div className="mx-auto max-w-5xl space-y-5">
              <Card>
                <CardContent className="space-y-5 p-5 pt-5 sm:p-6 sm:pt-6">
                  <div className="space-y-1">
                    <div className="text-base font-semibold">Workflow details</div>
                    <p className="text-sm text-muted-foreground">
                      Name it clearly, choose the category, and set any voice aliases you want people to use.
                    </p>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_280px]">
                    <div className="space-y-2">
                      <Label>Workflow Name</Label>
                      <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Bathroom fan auto off" />
                    </div>
                    <div className="space-y-2">
                      <Label>Category</Label>
                      <Select value={category} onValueChange={(value) => setCategory(value as Workflow["category"])}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="security">Security</SelectItem>
                          <SelectItem value="comfort">Comfort</SelectItem>
                          <SelectItem value="energy">Energy</SelectItem>
                          <SelectItem value="convenience">Convenience</SelectItem>
                          <SelectItem value="custom">Custom</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Description</Label>
                    <Textarea
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder="Explain what this workflow should do."
                      className="min-h-[110px]"
                    />
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px_220px]">
                    <div className="space-y-3">
                      <Label>Priority: {priority}</Label>
                      <Slider value={[priority]} min={1} max={10} step={1} onValueChange={(value) => setPriority(value[0])} />
                    </div>
                    <div className="space-y-2">
                      <Label>Cooldown (minutes)</Label>
                      <Input
                        type="number"
                        min={0}
                        value={cooldown}
                        onChange={(event) => setCooldown(Math.max(0, Number(event.target.value) || 0))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Voice aliases</Label>
                      <Input
                        value={voiceAliasesText}
                        onChange={(event) => setVoiceAliasesText(event.target.value)}
                        placeholder="bath fan timer"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="space-y-5 p-5 pt-5 sm:p-6 sm:pt-6">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-base font-semibold">
                        <Clock3 className="h-4 w-4 text-muted-foreground" />
                        Trigger
                      </div>
                      <p className="text-sm text-muted-foreground">{triggerSummary}</p>
                    </div>
                    <Badge variant="outline">{TRIGGER_LABELS[triggerType]}</Badge>
                  </div>

                  <div className="space-y-2">
                    <Label>Trigger type</Label>
                    <Select value={triggerType} onValueChange={(value) => handleTriggerTypeChange(value as WorkflowTriggerType)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="manual">Manual</SelectItem>
                        <SelectItem value="time">Time of day</SelectItem>
                        <SelectItem value="schedule">Cron schedule</SelectItem>
                        <SelectItem value="device_state">Device state</SelectItem>
                        <SelectItem value="sensor">Sensor event</SelectItem>
                        <SelectItem value="security_alarm_status">Security alarm status</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {triggerType === "time" && (
                    <div className="grid gap-4 md:grid-cols-3">
                      <div className="space-y-2">
                        <Label>Hour</Label>
                        <Input
                          type="number"
                          min={0}
                          max={23}
                          value={Number(triggerConditions.hour ?? 7)}
                          onChange={(event) => setTriggerConditions((prev) => ({ ...prev, hour: Number(event.target.value) }))}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Minute</Label>
                        <Input
                          type="number"
                          min={0}
                          max={59}
                          value={Number(triggerConditions.minute ?? 0)}
                          onChange={(event) => setTriggerConditions((prev) => ({ ...prev, minute: Number(event.target.value) }))}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Days</Label>
                        <Input
                          value={Array.isArray(triggerConditions.days) ? (triggerConditions.days as string[]).join(", ") : ""}
                          onChange={(event) => {
                            const days = event.target.value.split(",").map((value) => value.trim()).filter(Boolean);
                            setTriggerConditions((prev) => ({ ...prev, days }));
                          }}
                          placeholder="monday, tuesday, friday"
                        />
                      </div>
                    </div>
                  )}

                  {triggerType === "schedule" && (
                    <div className="space-y-4">
                      <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
                        <div className="space-y-2">
                          <Label>Schedule mode</Label>
                          <Select
                            value={getScheduleMode(triggerConditions)}
                            onValueChange={(value) => handleScheduleModeChange(value as "cron" | "solar")}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="cron">Cron schedule</SelectItem>
                              <SelectItem value="solar">Sunrise / sunset</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {getScheduleMode(triggerConditions) === "cron" ? (
                          <div className="space-y-2">
                            <Label>Cron</Label>
                            <Input
                              value={String(triggerConditions.cron || "0 7 * * 1-5")}
                              onChange={(event) => setTriggerConditions({ cron: event.target.value })}
                              placeholder="0 7 * * 1-5"
                            />
                          </div>
                        ) : (
                          <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
                            <div className="space-y-2">
                              <Label>Solar event</Label>
                              <Select
                                value={normalizeSolarScheduleEvent(triggerConditions.event) || "sunset"}
                                onValueChange={(value) => setTriggerConditions((prev) => ({
                                  ...prev,
                                  event: value,
                                  offset: Number.isFinite(Number(prev.offset)) ? Math.round(Number(prev.offset)) : 0
                                }))}
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="sunrise">Sunrise</SelectItem>
                                  <SelectItem value="sunset">Sunset</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>

                            <div className="space-y-2">
                              <Label>Offset (minutes)</Label>
                              <Input
                                type="number"
                                value={String(Number.isFinite(Number(triggerConditions.offset)) ? Math.round(Number(triggerConditions.offset)) : 0)}
                                onChange={(event) => setTriggerConditions((prev) => ({
                                  ...prev,
                                  event: normalizeSolarScheduleEvent(prev.event) || "sunset",
                                  offset: Math.round(Number(event.target.value) || 0)
                                }))}
                                placeholder="0"
                              />
                              <p className="text-xs text-muted-foreground">
                                Use a negative number for before the event and a positive number for after it.
                              </p>
                            </div>
                          </div>
                        )}
                      </div>

                      {getScheduleMode(triggerConditions) === "solar" && (
                        <p className="text-xs text-muted-foreground">
                          Solar schedules use the HomeBrain weather location from Settings to resolve that day&apos;s sunrise and sunset times.
                        </p>
                      )}
                    </div>
                  )}

                  {triggerType === "device_state" && (
                    <div className="space-y-4">
                      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
                        <div className="space-y-2">
                          <Label>Device</Label>
                          <Select
                            value={String(triggerConditions.deviceId || "")}
                            onValueChange={(value) => setTriggerConditions((prev) => ({
                              ...prev,
                              deviceId: value,
                              property: "status",
                              operator: "eq",
                              value: true,
                              state: "on",
                              forSeconds: Number(prev.forSeconds) || 0
                            }))}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select device" />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.entries(devicesByRoom).map(([room, roomDevices]) => (
                                <div key={room}>
                                  <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">{room}</div>
                                  {roomDevices.map((device) => (
                                    <SelectItem key={device._id} value={device._id}>
                                      {device.name} ({device.type})
                                    </SelectItem>
                                  ))}
                                </div>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label>Property</Label>
                          <Select
                            value={selectedTriggerProperty}
                            onValueChange={(value) => {
                              const option = triggerPropertyOptions.find((entry) => entry.key === value)
                                || {
                                  key: value,
                                  label: formatTriggerPropertyLabel(value),
                                  kind: "string" as TriggerPropertyKind
                                };
                              setTriggerConditions((prev) => ({
                                ...prev,
                                property: value,
                                operator: getDefaultTriggerOperator(option, prev.operator),
                                value: option.kind === "boolean"
                                  ? true
                                  : option.kind === "number"
                                    ? Number(prev.value ?? 0) || 0
                                    : String(prev.value ?? ""),
                                state: option.kind === "boolean" && value === "status" ? "on" : undefined
                              }));
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select property" />
                            </SelectTrigger>
                            <SelectContent>
                              {!triggerPropertyOptions.some((option) => option.key === selectedTriggerProperty) && (
                                <SelectItem value={selectedTriggerProperty}>
                                  {selectedTriggerProperty}
                                </SelectItem>
                              )}
                              {triggerPropertyOptions.map((option) => (
                                <SelectItem key={option.key} value={option.key}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <div className="grid gap-4 lg:grid-cols-[180px_minmax(0,1fr)_220px]">
                        <div className="space-y-2">
                          <Label>Operator</Label>
                          <Select
                            value={selectedTriggerOperator}
                            onValueChange={(value) => setTriggerConditions((prev) => ({
                              ...prev,
                              operator: normalizeTriggerOperator(value, selectedTriggerPropertyOption.kind)
                            }))}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {selectedTriggerOperatorOptions.map((operator) => (
                                <SelectItem key={operator.value} value={operator.value}>
                                  {operator.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label>{triggerValueLabel}</Label>
                          {selectedTriggerPropertyOption.kind === "boolean" ? (
                            <Select
                              value={String(Boolean(triggerConditions.value ?? true))}
                              onValueChange={(value) => setTriggerConditions((prev) => ({
                                ...prev,
                                value: value === "true",
                                state: selectedTriggerProperty === "status"
                                  ? (value === "true" ? "on" : "off")
                                  : undefined
                              }))}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="true">{selectedTriggerProperty === "status" ? "On" : "True"}</SelectItem>
                                <SelectItem value="false">{selectedTriggerProperty === "status" ? "Off" : "False"}</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : selectedTriggerPropertyOption.kind === "number" ? (
                            <Input
                              type="number"
                              value={String(Number(triggerConditions.value ?? 0))}
                              onChange={(event) => setTriggerConditions((prev) => ({
                                ...prev,
                                value: Number(event.target.value) || 0
                              }))}
                              placeholder="25"
                            />
                          ) : (
                            <Input
                              value={String(triggerConditions.value ?? "")}
                              onChange={(event) => setTriggerConditions((prev) => ({
                                ...prev,
                                value: event.target.value
                              }))}
                              placeholder="running"
                            />
                          )}
                        </div>

                        <div className="space-y-2">
                          <Label>Hold Time (seconds)</Label>
                          <Input
                            type="number"
                            min={0}
                            value={String(Math.max(0, Number(triggerConditions.forSeconds) || 0))}
                            onChange={(event) => setTriggerConditions((prev) => ({
                              ...prev,
                              forSeconds: Math.max(0, Math.round(Number(event.target.value) || 0))
                            }))}
                            placeholder="0"
                          />
                        </div>
                      </div>

                      {energyThresholdTrigger && (
                        <p className="text-xs text-muted-foreground">
                          Use <span className="font-medium text-foreground">Greater than</span> for turn-on thresholds, or <span className="font-medium text-foreground">Less than</span> with hold time to detect when an appliance has really finished.
                        </p>
                      )}

                      {triggerPropertyOptions.some((option) => option.key.startsWith("smartThingsAttributeValues.")) && (
                        <p className="text-xs text-muted-foreground">
                          SmartThings readings such as power, energy, humidity, and washer or dryer state appear here after sync as imported trigger properties.
                        </p>
                      )}
                    </div>
                  )}

                  {triggerType === "security_alarm_status" && (
                    <div className="space-y-2">
                      <Label>Alarm states</Label>
                      <Input
                        value={Array.isArray(triggerConditions.states) ? (triggerConditions.states as string[]).join(", ") : ""}
                        onChange={(event) => {
                          const states = event.target.value
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean);
                          setTriggerConditions((prev) => ({ ...prev, states }));
                        }}
                        placeholder="armedStay, armedAway"
                      />
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="space-y-4 p-5 pt-5 sm:p-6 sm:pt-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <div className="text-base font-semibold">Actions</div>
                      <p className="text-sm text-muted-foreground">
                        Reorder steps, adjust targets, and keep each action focused on one clear outcome.
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={addAction}>
                      <Plus className="h-4 w-4" />
                      Add action
                    </Button>
                  </div>

                  <Separator />

                  <div className="space-y-4">
                    {actions.map((action, index) => {
                      const targetGroupName = getDeviceGroupName(action.target);
                      const targetGroup = targetGroupName ? deviceGroupsByName.get(targetGroupName.toLowerCase()) : undefined;
                      const targetDeviceId = isTriggeringDeviceTarget(action.target)
                        ? triggerDeviceId || ""
                        : (typeof action.target === "string" ? action.target : "");
                      const targetDevice = devices.find((device) => device._id === targetDeviceId);
                      const actionChoices = targetGroup
                        ? getCommonDeviceActionChoices(targetGroup.devices)
                        : getDeviceActionChoices(
                            targetDevice?.type || "switch",
                            ((targetDevice?.properties as Record<string, unknown> | undefined)?.source as string | undefined) || "local"
                          );
                      const actionValue = String(action.parameters?.action || actionChoices[0]);
                      const showNumericValue = action.type === "device_control"
                        && (actionValue === "set_brightness" || actionValue === "set_temperature" || actionValue === "turn_on");

                      return (
                        <Card key={`${action.type}-${index}`} className="overflow-hidden">
                          <CardContent className="space-y-4 p-5 pt-5 sm:p-6 sm:pt-6">
                            <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                              <div className="space-y-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge variant="secondary">Step {index + 1}</Badge>
                                  <span className="text-base font-semibold">{ACTION_LABELS[action.type] || action.type}</span>
                                </div>
                                <p className="text-sm text-muted-foreground">{actionSummaries[index]}</p>
                              </div>

                              <div className="flex items-center gap-2 self-start">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => moveAction(index, -1)}
                                  disabled={index === 0}
                                  aria-label={`Move step ${index + 1} up`}
                                >
                                  <ChevronUp className="h-4 w-4" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => moveAction(index, 1)}
                                  disabled={index === actions.length - 1}
                                  aria-label={`Move step ${index + 1} down`}
                                >
                                  <ChevronDown className="h-4 w-4" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => removeAction(index)}
                                  aria-label={`Delete step ${index + 1}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>

                            {action.type === "device_control" && (
                              <>
                                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[260px_minmax(0,1.4fr)_minmax(0,1fr)]">
                                  <div className="space-y-2">
                                    <Label>Action type</Label>
                                    <Select value={action.type} onValueChange={(value) => handleActionTypeChange(index, value as WorkflowAction["type"])}>
                                      <SelectTrigger>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="device_control">Control device</SelectItem>
                                        <SelectItem value="scene_activate">Activate scene</SelectItem>
                                        <SelectItem value="delay">Delay</SelectItem>
                                        <SelectItem value="notification">Notification</SelectItem>
                                        <SelectItem value="condition">Condition gate</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>

                                  <div className="space-y-2">
                                    <Label>Device or group</Label>
                                    <Select
                                      value={getActionTargetSelectValue(action.target)}
                                      onValueChange={(value) => {
                                        const usesTriggeringDevice = value === TRIGGERING_DEVICE_TARGET_VALUE;
                                        const selectedGroup = parseDeviceGroupSelectValue(value);
                                        const updatedDeviceId = usesTriggeringDevice
                                          ? (typeof triggerConditions.deviceId === "string" ? triggerConditions.deviceId : "")
                                          : selectedGroup
                                            ? ""
                                            : value;
                                        const updatedDevice = devices.find((device) => device._id === updatedDeviceId);
                                        const updatedGroup = selectedGroup ? deviceGroupsByName.get(selectedGroup.toLowerCase()) : undefined;
                                        const choices = updatedGroup
                                          ? getCommonDeviceActionChoices(updatedGroup.devices)
                                          : getDeviceActionChoices(
                                              updatedDevice?.type || "switch",
                                              ((updatedDevice?.properties as Record<string, unknown> | undefined)?.source as string | undefined) || "local"
                                            );
                                        updateAction(index, {
                                          target: usesTriggeringDevice
                                            ? buildTriggeringDeviceTarget()
                                            : selectedGroup
                                              ? buildDeviceGroupTarget(selectedGroup)
                                              : value,
                                          parameters: {
                                            ...action.parameters,
                                            action: choices[0]
                                          }
                                        });
                                      }}
                                    >
                                      <SelectTrigger>
                                        <SelectValue placeholder="Select device" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {(triggerType === "device_state" || isTriggeringDeviceTarget(action.target)) && (
                                          <SelectItem value={TRIGGERING_DEVICE_TARGET_VALUE}>
                                            Triggering device
                                          </SelectItem>
                                        )}
                                        {deviceGroups.length > 0 ? (
                                          <>
                                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">Groups</div>
                                            {deviceGroups.map((group) => (
                                              <SelectItem key={group.name} value={getDeviceGroupTargetSelectValue(group.name)}>
                                                {group.name} ({group.devices.length} device{group.devices.length === 1 ? "" : "s"})
                                              </SelectItem>
                                            ))}
                                          </>
                                        ) : null}
                                        {Object.entries(devicesByRoom).map(([room, roomDevices]) => (
                                          <div key={room}>
                                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">{room}</div>
                                            {roomDevices.map((device) => (
                                              <SelectItem key={device._id} value={device._id}>
                                                {device.name} ({device.type})
                                              </SelectItem>
                                            ))}
                                          </div>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    {isTriggeringDeviceTarget(action.target) && (
                                      <p className="text-xs text-muted-foreground">
                                        Uses whichever device matched the trigger.
                                      </p>
                                    )}
                                    {isDeviceGroupTarget(action.target) && (
                                      <p className="text-xs text-muted-foreground">
                                        Applies this action to every device in the selected group{targetGroup?.description ? `: ${targetGroup.description}` : "."}
                                      </p>
                                    )}
                                  </div>

                                  <div className="space-y-2">
                                    <Label>Device action</Label>
                                    <Select
                                      value={actionValue}
                                      onValueChange={(value) => updateAction(index, { parameters: { ...action.parameters, action: value } })}
                                    >
                                      <SelectTrigger>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {actionChoices.map((choice) => (
                                          <SelectItem key={choice} value={choice}>
                                            {choice.replace(/_/g, " ")}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                </div>

                                {showNumericValue && (
                                  <div className="grid gap-4 md:max-w-[320px]">
                                    <div className="space-y-2">
                                      <Label>{actionValue === "set_temperature" ? "Temperature" : "Value"}</Label>
                                      <Input
                                        type="number"
                                        value={String(
                                          actionValue === "set_temperature"
                                            ? action.parameters?.temperature ?? 72
                                            : action.parameters?.brightness ?? action.parameters?.value ?? 100
                                        )}
                                        onChange={(event) => {
                                          const numeric = Number(event.target.value);
                                          if (actionValue === "set_temperature") {
                                            updateAction(index, { parameters: { ...action.parameters, temperature: numeric } });
                                          } else {
                                            updateAction(index, { parameters: { ...action.parameters, brightness: numeric, value: numeric } });
                                          }
                                        }}
                                      />
                                    </div>
                                  </div>
                                )}
                              </>
                            )}

                            {action.type === "scene_activate" && (
                              <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
                                <div className="space-y-2">
                                  <Label>Action type</Label>
                                  <Select value={action.type} onValueChange={(value) => handleActionTypeChange(index, value as WorkflowAction["type"])}>
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="device_control">Control device</SelectItem>
                                      <SelectItem value="scene_activate">Activate scene</SelectItem>
                                      <SelectItem value="delay">Delay</SelectItem>
                                      <SelectItem value="notification">Notification</SelectItem>
                                      <SelectItem value="condition">Condition gate</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div className="space-y-2">
                                  <Label>Scene</Label>
                                  <Select
                                    value={typeof action.target === "string" ? action.target : ""}
                                    onValueChange={(value) => updateAction(index, { target: value })}
                                  >
                                    <SelectTrigger>
                                      <SelectValue placeholder="Select scene" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {scenes.map((scene) => (
                                        <SelectItem key={scene._id} value={scene._id}>
                                          {scene.name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              </div>
                            )}

                            {action.type === "delay" && (
                              <div className="grid gap-4 md:grid-cols-[260px_220px]">
                                <div className="space-y-2">
                                  <Label>Action type</Label>
                                  <Select value={action.type} onValueChange={(value) => handleActionTypeChange(index, value as WorkflowAction["type"])}>
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="device_control">Control device</SelectItem>
                                      <SelectItem value="scene_activate">Activate scene</SelectItem>
                                      <SelectItem value="delay">Delay</SelectItem>
                                      <SelectItem value="notification">Notification</SelectItem>
                                      <SelectItem value="condition">Condition gate</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div className="space-y-2">
                                  <Label>Delay (seconds)</Label>
                                  <Input
                                    type="number"
                                    min={0}
                                    max={MAX_DELAY_SECONDS}
                                    value={String(action.parameters?.seconds ?? 3)}
                                    onChange={(event) => updateAction(index, { parameters: { ...action.parameters, seconds: Number(event.target.value) } })}
                                  />
                                  <p className="text-xs text-muted-foreground">
                                    Current delay: {formatDuration(action.parameters?.seconds ?? 0)}
                                  </p>
                                </div>
                              </div>
                            )}

                            {action.type === "notification" && (
                              <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
                                <div className="space-y-2">
                                  <Label>Action type</Label>
                                  <Select value={action.type} onValueChange={(value) => handleActionTypeChange(index, value as WorkflowAction["type"])}>
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="device_control">Control device</SelectItem>
                                      <SelectItem value="scene_activate">Activate scene</SelectItem>
                                      <SelectItem value="delay">Delay</SelectItem>
                                      <SelectItem value="notification">Notification</SelectItem>
                                      <SelectItem value="condition">Condition gate</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div className="space-y-2">
                                  <Label>Notification message</Label>
                                  <Textarea
                                    value={String(action.parameters?.message || "")}
                                    onChange={(event) => updateAction(index, { parameters: { ...action.parameters, message: event.target.value } })}
                                    className="min-h-[110px]"
                                  />
                                </div>
                              </div>
                            )}

                            {action.type === "condition" && (
                              <div className="space-y-4">
                                <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
                                  <div className="space-y-2">
                                    <Label>Action type</Label>
                                    <Select value={action.type} onValueChange={(value) => handleActionTypeChange(index, value as WorkflowAction["type"])}>
                                      <SelectTrigger>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="device_control">Control device</SelectItem>
                                        <SelectItem value="scene_activate">Activate scene</SelectItem>
                                        <SelectItem value="delay">Delay</SelectItem>
                                        <SelectItem value="notification">Notification</SelectItem>
                                        <SelectItem value="condition">Condition gate</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>

                                  <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
                                    Condition steps are supported at runtime, but the visual editor does not yet expose every condition parameter. If you need a deeply custom gate, exporting and re-importing the workflow JSON is still the best path for now.
                                  </div>
                                </div>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <aside className="hidden min-h-0 border-l border-border/60 bg-muted/10 xl:block">
            <div className="h-full overflow-y-auto px-5 py-6">
              <div className="space-y-4">
                <Card>
                  <CardContent className="space-y-4 p-5 pt-5">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <WorkflowIcon className="h-4 w-4 text-muted-foreground" />
                      Workflow summary
                    </div>

                    <div className="rounded-2xl border border-border/70 bg-background/40 p-4">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Trigger</div>
                      <div className="mt-2 text-sm font-medium">{triggerSummary}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-2xl border border-border/70 bg-background/40 p-3">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Category</div>
                        <div className="mt-2 text-sm font-medium">{category}</div>
                      </div>
                      <div className="rounded-2xl border border-border/70 bg-background/40 p-3">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Priority</div>
                        <div className="mt-2 text-sm font-medium">{priority}/10</div>
                      </div>
                      <div className="rounded-2xl border border-border/70 bg-background/40 p-3">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Cooldown</div>
                        <div className="mt-2 text-sm font-medium">{cooldown} min</div>
                      </div>
                      <div className="rounded-2xl border border-border/70 bg-background/40 p-3">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Voice aliases</div>
                        <div className="mt-2 text-sm font-medium">{voiceAliasesText.trim() ? voiceAliasesText.split(",").filter(Boolean).length : 0}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="space-y-4 p-5 pt-5">
                    <div className="text-sm font-semibold">Step outline</div>
                    <div className="space-y-3">
                      {actionSummaries.map((summary, index) => (
                        <div key={`${actions[index]?.type}-${index}`} className="rounded-2xl border border-border/70 bg-background/40 p-4">
                          <div className="mb-2 flex items-center gap-2">
                            <Badge variant="outline">Step {index + 1}</Badge>
                            <span className="text-sm font-medium">{ACTION_LABELS[actions[index]?.type] || actions[index]?.type}</span>
                          </div>
                          <p className="text-sm text-muted-foreground">{summary}</p>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="pt-5">
                    <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                      <WorkflowIcon className="h-4 w-4" />
                      Visual flow
                    </div>
                    <div className="space-y-2">
                      {visualGraph.nodes.map((node, index) => (
                        <div key={node.id} className="space-y-2">
                          <div className="rounded-2xl border border-border/70 bg-background/40 p-3 text-xs">
                            <div className="font-semibold">{node.label}</div>
                            <div className="text-muted-foreground">{node.type.replace(/_/g, " ")}</div>
                          </div>
                          {index < visualGraph.nodes.length - 1 && (
                            <div className="flex justify-center text-muted-foreground">
                              <ArrowDown className="h-4 w-4" />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </aside>
        </div>

        <DialogFooter className="items-center gap-3 border-t border-border/60 bg-background/95 px-5 py-4 sm:justify-between sm:space-x-0 sm:px-7">
          <p className="text-xs text-muted-foreground">
            Changes here update the workflow and its linked automation runtime behavior.
          </p>
          <div className="flex w-full flex-col-reverse gap-3 sm:w-auto sm:flex-row">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => void onSubmit()} disabled={isSaving || !name.trim() || actions.length === 0} className="sm:min-w-[220px]">
              <Save className="h-4 w-4" />
              {isSaving ? "Saving..." : "Save Workflow"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
