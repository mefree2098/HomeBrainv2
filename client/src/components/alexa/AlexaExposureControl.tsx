import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Command, Loader2, RadioTower } from "lucide-react";
import { type AlexaExposureEntityType, type AlexaExposureSummary } from "@/api/alexa";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";

type Props = {
  entityType: AlexaExposureEntityType;
  entityId: string;
  entityName: string;
  exposure?: AlexaExposureSummary | null;
  defaultRoomHint?: string;
  defaultAliases?: string[];
  compact?: boolean;
  loading?: boolean;
  disabled?: boolean;
  onSave: (payload: {
    enabled: boolean;
    friendlyName: string;
    aliases: string[];
    roomHint: string;
  }) => Promise<AlexaExposureSummary | null | undefined>;
};

const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ");

const normalizeAliasList = (value: string | string[]) => {
  const entries = Array.isArray(value) ? value : String(value || "").split(",");
  const seen = new Set<string>();
  const normalized: string[] = [];

  entries.forEach((entry) => {
    const trimmed = normalizeName(String(entry || ""));
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
};

const buildInitialState = (
  exposure: AlexaExposureSummary | null | undefined,
  entityName: string,
  defaultRoomHint = "",
  defaultAliases: string[] = []
) => ({
  enabled: exposure?.enabled === true,
  friendlyName: exposure?.friendlyName || "",
  aliasesInput: normalizeAliasList(exposure?.aliases || defaultAliases).join(", "),
  roomHint: exposure?.roomHint || defaultRoomHint || "",
  fallbackName: entityName
});

export function AlexaExposureControl({
  entityType,
  entityId,
  entityName,
  exposure,
  defaultRoomHint = "",
  defaultAliases = [],
  compact = false,
  loading = false,
  disabled = false,
  onSave
}: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [friendlyName, setFriendlyName] = useState("");
  const [aliasesInput, setAliasesInput] = useState("");
  const [roomHint, setRoomHint] = useState("");

  useEffect(() => {
    const next = buildInitialState(exposure, entityName, defaultRoomHint, defaultAliases);
    setEnabled(next.enabled);
    setFriendlyName(next.friendlyName);
    setAliasesInput(next.aliasesInput);
    setRoomHint(next.roomHint);
  }, [defaultAliases, defaultRoomHint, entityName, exposure?.aliases, exposure?.enabled, exposure?.friendlyName, exposure?.roomHint, entityId, entityType]);

  const aliases = useMemo(() => normalizeAliasList(aliasesInput), [aliasesInput]);
  const issueCount = (exposure?.validationErrors?.length || 0) + (exposure?.validationWarnings?.length || 0);
  const hasErrors = (exposure?.validationErrors?.length || 0) > 0;
  const effectiveName = friendlyName.trim() || entityName;
  const dirty = useMemo(() => {
    const initial = buildInitialState(exposure, entityName, defaultRoomHint, defaultAliases);
    return (
      enabled !== initial.enabled
      || normalizeName(friendlyName) !== normalizeName(initial.friendlyName)
      || JSON.stringify(aliases) !== JSON.stringify(normalizeAliasList(initial.aliasesInput))
      || normalizeName(roomHint) !== normalizeName(initial.roomHint)
    );
  }, [aliases, defaultAliases, defaultRoomHint, enabled, entityName, exposure, friendlyName, roomHint]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        enabled,
        friendlyName: normalizeName(friendlyName),
        aliases,
        roomHint: normalizeName(roomHint)
      });
      setOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save Alexa settings.";
      toast({
        title: "Alexa update failed",
        description: message,
        variant: "destructive"
      });
    } finally {
      setSaving(false);
    }
  };

  const triggerLabel = loading
    ? "Alexa"
    : enabled
      ? "Alexa On"
      : "Alexa Off";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={enabled ? "default" : "outline"}
          size={compact ? "sm" : "default"}
          disabled={disabled || loading}
          className={cn(
            "gap-2",
            enabled && "bg-cyan-600 hover:bg-cyan-700 text-white",
            hasErrors && "border-amber-300 text-amber-700 hover:text-amber-800 dark:border-amber-500/40 dark:text-amber-200"
          )}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Command className="h-4 w-4" />}
          <span>{triggerLabel}</span>
          {issueCount > 0 ? (
            <Badge
              variant="secondary"
              className={cn(
                "ml-1 px-1.5 py-0 text-[10px]",
                hasErrors && "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-100"
              )}
            >
              {issueCount}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[360px] space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <RadioTower className="h-4 w-4 text-cyan-600" />
            <div className="text-sm font-semibold">Alexa Exposure</div>
            <Badge variant="outline" className="ml-auto">
              {entityType.replace("_", " ")}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Configure how <span className="font-medium text-foreground">{entityName}</span> appears to Alexa.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
          <div className="space-y-1">
            <Label htmlFor={`alexa-enabled-${entityType}-${entityId}`}>Expose in Alexa</Label>
            <p className="text-xs text-muted-foreground">
              Disable this to hide the entity from discovery without deleting the configuration.
            </p>
          </div>
          <Switch
            id={`alexa-enabled-${entityType}-${entityId}`}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor={`alexa-name-${entityType}-${entityId}`}>Friendly name</Label>
          <Input
            id={`alexa-name-${entityType}-${entityId}`}
            value={friendlyName}
            onChange={(event) => setFriendlyName(event.target.value)}
            placeholder={entityName}
          />
          <p className="text-xs text-muted-foreground">
            Alexa will hear this as <span className="font-medium text-foreground">{effectiveName}</span>.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`alexa-aliases-${entityType}-${entityId}`}>Aliases</Label>
          <Input
            id={`alexa-aliases-${entityType}-${entityId}`}
            value={aliasesInput}
            onChange={(event) => setAliasesInput(event.target.value)}
            placeholder="Movie lights, lounge lights"
          />
          <p className="text-xs text-muted-foreground">
            Comma-separated alternate names. Duplicate names are removed automatically.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`alexa-room-${entityType}-${entityId}`}>Room hint</Label>
          <Input
            id={`alexa-room-${entityType}-${entityId}`}
            value={roomHint}
            onChange={(event) => setRoomHint(event.target.value)}
            placeholder={defaultRoomHint || "Living Room"}
          />
        </div>

        {exposure?.endpointId ? (
          <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Endpoint ID</div>
            <div className="mt-1 break-all font-mono text-xs">{exposure.endpointId}</div>
          </div>
        ) : null}

        {(exposure?.validationErrors?.length || 0) > 0 ? (
          <div className="space-y-2 rounded-lg border border-amber-300/80 bg-amber-50/80 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-100">
              <AlertCircle className="h-4 w-4" />
              Validation errors
            </div>
            <div className="space-y-1 text-xs text-amber-800/90 dark:text-amber-100/90">
              {(exposure?.validationErrors || []).map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          </div>
        ) : null}

        {(exposure?.validationWarnings?.length || 0) > 0 ? (
          <div className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3">
            <div className="text-sm font-medium">Warnings</div>
            <div className="space-y-1 text-xs text-muted-foreground">
              {(exposure?.validationWarnings || []).map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button type="button" onClick={() => void handleSave()} disabled={saving || !dirty}>
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving
              </>
            ) : "Save Alexa Settings"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
