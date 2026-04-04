import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Command, Loader2, RadioTower } from "lucide-react";
import { type AlexaExposureEntityType, type AlexaExposureSummary } from "@/api/alexa";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
  defaultRoomHint = "",
  defaultAliases: string[] = []
) => ({
  enabled: exposure?.enabled === true,
  friendlyName: exposure?.friendlyName || "",
  aliasesInput: normalizeAliasList(exposure?.aliases || defaultAliases).join(", "),
  roomHint: exposure?.roomHint || defaultRoomHint || ""
});

const serializeExposureState = (state: {
  enabled: boolean;
  friendlyName: string;
  aliasesInput: string;
  roomHint: string;
}) => JSON.stringify({
  enabled: state.enabled,
  friendlyName: normalizeName(state.friendlyName),
  aliases: normalizeAliasList(state.aliasesInput),
  roomHint: normalizeName(state.roomHint)
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
  const entityKey = `${entityType}:${entityId}`;
  const initialState = useMemo(
    () => buildInitialState(exposure, defaultRoomHint, defaultAliases),
    [
      defaultAliases,
      defaultRoomHint,
      exposure?.aliases,
      exposure?.enabled,
      exposure?.friendlyName,
      exposure?.roomHint
    ]
  );
  const [baseline, setBaseline] = useState(initialState);
  const [draft, setDraft] = useState(initialState);
  const lastEntityKeyRef = useRef(entityKey);

  const aliases = useMemo(() => normalizeAliasList(draft.aliasesInput), [draft.aliasesInput]);
  const issueCount = (exposure?.validationErrors?.length || 0) + (exposure?.validationWarnings?.length || 0);
  const hasErrors = (exposure?.validationErrors?.length || 0) > 0;
  const effectiveName = draft.friendlyName.trim() || entityName;
  const dirty = useMemo(
    () => serializeExposureState(draft) !== serializeExposureState(baseline),
    [baseline, draft]
  );

  useEffect(() => {
    const entityChanged = lastEntityKeyRef.current !== entityKey;
    lastEntityKeyRef.current = entityKey;

    if (entityChanged || !dirty) {
      setBaseline(initialState);
      setDraft(initialState);
    }
  }, [dirty, entityKey, initialState]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const nextBaseline = {
        enabled: draft.enabled,
        friendlyName: normalizeName(draft.friendlyName),
        aliasesInput: aliases.join(", "),
        roomHint: normalizeName(draft.roomHint)
      };

      await onSave({
        enabled: nextBaseline.enabled,
        friendlyName: nextBaseline.friendlyName,
        aliases,
        roomHint: nextBaseline.roomHint
      });
      setBaseline(nextBaseline);
      setDraft(nextBaseline);
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
    : draft.enabled
      ? "Alexa On"
      : "Alexa Off";

  const controlsDisabled = disabled || loading || saving;

  const editorContent = (
    <>
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

      <div className="space-y-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-3">
        <div className="space-y-1">
          <Label htmlFor={`alexa-enabled-${entityType}-${entityId}`}>Expose in Alexa</Label>
          <p className="text-xs text-muted-foreground">
            Enable discovery for this entity, or disable it without deleting the saved Alexa naming.
          </p>
        </div>
        <RadioGroup
          value={draft.enabled ? "enabled" : "hidden"}
          onValueChange={(value) => setDraft((current) => ({ ...current, enabled: value === "enabled" }))}
          className="gap-2"
          disabled={controlsDisabled}
        >
          <label
            htmlFor={`alexa-enabled-${entityType}-${entityId}`}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-3 transition-colors",
              draft.enabled && "border-cyan-400/40 bg-cyan-500/[0.08]"
            )}
          >
            <RadioGroupItem
              id={`alexa-enabled-${entityType}-${entityId}`}
              value="enabled"
              className="mt-0.5 border-cyan-300 text-cyan-300"
            />
            <div>
              <div className="font-medium text-white">Enable in Alexa</div>
              <p className="mt-1 text-xs text-muted-foreground">Show this device during Alexa discovery.</p>
            </div>
          </label>
          <label
            htmlFor={`alexa-hidden-${entityType}-${entityId}`}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-3 transition-colors",
              !draft.enabled && "border-white/20 bg-white/[0.06]"
            )}
          >
            <RadioGroupItem
              id={`alexa-hidden-${entityType}-${entityId}`}
              value="hidden"
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-white">Keep hidden</div>
              <p className="mt-1 text-xs text-muted-foreground">Preserve naming here without exposing it to Alexa.</p>
            </div>
          </label>
        </RadioGroup>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`alexa-name-${entityType}-${entityId}`}>Friendly name</Label>
        <Input
          id={`alexa-name-${entityType}-${entityId}`}
          value={draft.friendlyName}
          onChange={(event) => setDraft((current) => ({ ...current, friendlyName: event.target.value }))}
          placeholder={entityName}
          disabled={controlsDisabled}
        />
        <p className="text-xs text-muted-foreground">
          Alexa will hear this as <span className="font-medium text-foreground">{effectiveName}</span>.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`alexa-aliases-${entityType}-${entityId}`}>Aliases</Label>
        <Input
          id={`alexa-aliases-${entityType}-${entityId}`}
          value={draft.aliasesInput}
          onChange={(event) => setDraft((current) => ({ ...current, aliasesInput: event.target.value }))}
          placeholder="Movie lights, lounge lights"
          disabled={controlsDisabled}
        />
        <p className="text-xs text-muted-foreground">
          Comma-separated alternate names. Duplicate names are removed automatically.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`alexa-room-${entityType}-${entityId}`}>Room hint</Label>
        <Input
          id={`alexa-room-${entityType}-${entityId}`}
          value={draft.roomHint}
          onChange={(event) => setDraft((current) => ({ ...current, roomHint: event.target.value }))}
          placeholder={defaultRoomHint || "Living Room"}
          disabled={controlsDisabled}
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
        <Button type="button" onClick={() => void handleSave()} disabled={controlsDisabled || !dirty}>
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving
            </>
          ) : "Save Alexa Settings"}
        </Button>
      </div>
    </>
  );

  if (!compact) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={draft.enabled ? "default" : "outline"}
            className={cn(draft.enabled && "bg-cyan-600 text-white hover:bg-cyan-700")}
          >
            {triggerLabel}
          </Badge>
          {loading ? (
            <Badge variant="secondary">
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              Loading
            </Badge>
          ) : null}
          {issueCount > 0 ? (
            <Badge variant={hasErrors ? "destructive" : "secondary"}>
              {issueCount} issue{issueCount === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
        <div className="space-y-4 rounded-2xl border border-white/10 bg-black/20 p-4">
          {editorContent}
        </div>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={draft.enabled ? "default" : "outline"}
          size={compact ? "sm" : "default"}
          disabled={disabled || loading}
          className={cn(
            "gap-2",
            draft.enabled && "bg-cyan-600 hover:bg-cyan-700 text-white",
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
        {editorContent}
      </PopoverContent>
    </Popover>
  );
}
