import { useEffect, useMemo, useState } from "react";
import { ArrowDown, Clock3, Plus, Save, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import type { Workflow, WorkflowAction, WorkflowTriggerType } from "@/api/workflows";

type DeviceLite = {
  _id: string;
  name: string;
  type: string;
  room: string;
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
  scenes: SceneLite[];
  onSave: (payload: Partial<Workflow>) => Promise<void> | void;
  isSaving?: boolean;
};

const DEFAULT_ACTION: WorkflowAction = {
  type: "device_control",
  target: null,
  parameters: { action: "turn_on" }
};

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
    default:
      return ["turn_on", "turn_off"];
  }
}

export function WorkflowBuilderDialog({
  open,
  onOpenChange,
  initialWorkflow,
  devices,
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
      setActions(initialWorkflow.actions?.length ? initialWorkflow.actions : [DEFAULT_ACTION]);
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
    setActions([DEFAULT_ACTION]);
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

  const addAction = () => {
    setActions((prev) => [...prev, DEFAULT_ACTION]);
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
  };

  const onSubmit = async () => {
    if (!name.trim()) {
      return;
    }
    if (!actions.length) {
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
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initialWorkflow ? "Edit Workflow" : "Create Workflow"}</DialogTitle>
          <DialogDescription>
            Build a workflow visually. These workflows can be voice-triggered, chat-created, or scheduled.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="space-y-4">
            <Card>
              <CardContent className="space-y-3 pt-5">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Workflow Name</Label>
                    <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Morning startup" />
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
                    placeholder="What should this workflow do?"
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
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
                </div>
                <div className="space-y-2">
                  <Label>Voice Aliases (comma separated)</Label>
                  <Input
                    value={voiceAliasesText}
                    onChange={(event) => setVoiceAliasesText(event.target.value)}
                    placeholder="goodnight routine, bedtime flow"
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-3 pt-5">
                <div className="flex items-center justify-between">
                  <Label>Trigger</Label>
                  <Clock3 className="h-4 w-4 text-muted-foreground" />
                </div>
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

                {triggerType === "time" && (
                  <div className="grid gap-3 md:grid-cols-3">
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
                  <div className="space-y-2">
                    <Label>Cron</Label>
                    <Input
                      value={String(triggerConditions.cron || "0 7 * * 1-5")}
                      onChange={(event) => setTriggerConditions((prev) => ({ ...prev, cron: event.target.value }))}
                      placeholder="0 7 * * 1-5"
                    />
                  </div>
                )}

                {triggerType === "device_state" && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Device</Label>
                      <Select
                        value={String(triggerConditions.deviceId || "")}
                        onValueChange={(value) => setTriggerConditions((prev) => ({ ...prev, deviceId: value }))}
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
                      <Label>State</Label>
                      <Select
                        value={String(triggerConditions.state || "on")}
                        onValueChange={(value) => setTriggerConditions((prev) => ({ ...prev, state: value }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="on">On</SelectItem>
                          <SelectItem value="off">Off</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
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
              <CardContent className="space-y-3 pt-5">
                <div className="flex items-center justify-between">
                  <Label>Actions</Label>
                  <Button size="sm" variant="outline" onClick={addAction}>
                    <Plus className="mr-1 h-4 w-4" />
                    Add Action
                  </Button>
                </div>

                {actions.map((action, index) => {
                  const targetDevice = devices.find((device) => device._id === action.target);
                  const actionChoices = getDeviceActionChoices(
                    targetDevice?.type || "switch",
                    ((targetDevice?.properties as Record<string, unknown> | undefined)?.source as string | undefined) || "local"
                  );
                  const actionValue = String(action.parameters?.action || actionChoices[0]);

                  return (
                    <Card key={`${action.type}-${index}`}>
                      <CardContent className="space-y-3 pt-4">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">Step {index + 1}</span>
                          <div className="flex items-center gap-2">
                            <Button size="sm" variant="ghost" onClick={() => moveAction(index, -1)} disabled={index === 0}>
                              ↑
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => moveAction(index, 1)} disabled={index === actions.length - 1}>
                              ↓
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => removeAction(index)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>

                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="space-y-2">
                            <Label>Action Type</Label>
                            <Select
                              value={action.type}
                              onValueChange={(value) => {
                                const nextType = value as WorkflowAction["type"];
                                const nextAction: WorkflowAction = {
                                  type: nextType,
                                  target: nextType === "scene_activate" ? scenes[0]?._id || null : devices[0]?._id || null,
                                  parameters: nextType === "delay" ? { seconds: 3 } : nextType === "notification" ? { message: "" } : { action: "turn_on" }
                                };
                                setActions((prev) => prev.map((item, actionIndex) => actionIndex === index ? nextAction : item));
                              }}
                            >
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

                          {action.type === "device_control" && (
                            <div className="space-y-2">
                              <Label>Device</Label>
                              <Select
                                value={String(action.target || "")}
                                onValueChange={(value) => {
                                  const updatedDevice = devices.find((device) => device._id === value);
                                  const choices = getDeviceActionChoices(
                                    updatedDevice?.type || "switch",
                                    ((updatedDevice?.properties as Record<string, unknown> | undefined)?.source as string | undefined) || "local"
                                  );
                                  updateAction(index, {
                                    target: value,
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
                          )}

                          {action.type === "scene_activate" && (
                            <div className="space-y-2">
                              <Label>Scene</Label>
                              <Select
                                value={String(action.target || "")}
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
                          )}
                        </div>

                        {action.type === "device_control" && (
                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label>Device Action</Label>
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
                            {(actionValue === "set_brightness" || actionValue === "set_temperature" || actionValue === "turn_on") && (
                              <div className="space-y-2">
                                <Label>
                                  {actionValue === "set_temperature" ? "Temperature" : "Value"}
                                </Label>
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
                            )}
                          </div>
                        )}

                        {action.type === "delay" && (
                          <div className="space-y-2">
                            <Label>Delay (seconds)</Label>
                            <Input
                              type="number"
                              min={0}
                              max={600}
                              value={String(action.parameters?.seconds ?? 3)}
                              onChange={(event) => updateAction(index, { parameters: { ...action.parameters, seconds: Number(event.target.value) } })}
                            />
                          </div>
                        )}

                        {action.type === "notification" && (
                          <div className="space-y-2">
                            <Label>Notification Message</Label>
                            <Textarea
                              value={String(action.parameters?.message || "")}
                              onChange={(event) => updateAction(index, { parameters: { ...action.parameters, message: event.target.value } })}
                            />
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardContent className="pt-5">
                <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <WorkflowIcon className="h-4 w-4" />
                  Visual Flow
                </div>
                <div className="space-y-2">
                  {visualGraph.nodes.map((node, index) => (
                    <div key={node.id} className="space-y-2">
                      <div className="rounded-md border bg-muted/40 p-3 text-xs">
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

            <div className="rounded-md border bg-blue-50/70 dark:bg-blue-900/20 p-3 text-xs text-blue-900 dark:text-blue-100">
              Tip: once saved, this workflow can be triggered by voice or chat, including commands like
              {" "}
              <span className="font-semibold">"run {name || "this workflow"}"</span>.
            </div>
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <Button onClick={() => void onSubmit()} disabled={isSaving || !name.trim() || actions.length === 0} className="flex-1">
            <Save className="mr-2 h-4 w-4" />
            {isSaving ? "Saving..." : "Save Workflow"}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
