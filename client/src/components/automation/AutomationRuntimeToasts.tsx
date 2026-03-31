import { useEffect, useRef } from "react";
import { getLatestEvents, openEventStream, type PlatformEvent } from "@/api/events";
import { useToast } from "@/hooks/useToast";

const AUTOMATION_TOAST_TYPES = [
  "automation.execution.started",
  "automation.execution.completed"
];

const getEventName = (event: PlatformEvent) => {
  const payload = event.payload || {};
  const workflowName = typeof payload.workflowName === "string" && payload.workflowName.trim()
    ? payload.workflowName.trim()
    : "";
  const automationName = typeof payload.automationName === "string" && payload.automationName.trim()
    ? payload.automationName.trim()
    : "";
  return workflowName || automationName || "Automation";
};

const getTriggerLabel = (event: PlatformEvent) => {
  const payload = event.payload || {};
  const triggerSource = typeof payload.triggerSource === "string" ? payload.triggerSource.trim() : "";
  const triggerType = typeof payload.triggerType === "string" ? payload.triggerType.trim() : "";
  return triggerSource || triggerType || "automation event";
};

export function AutomationRuntimeToasts() {
  const { toast } = useToast();
  const latestSequenceRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let cleanup: null | (() => void) = null;

    const handleEvent = (event: PlatformEvent) => {
      latestSequenceRef.current = Math.max(latestSequenceRef.current, Number(event.sequence) || 0);

      if (event.type === "automation.execution.started") {
        const name = getEventName(event);
        toast({
          title: "Automation running",
          description: `${name} triggered from ${getTriggerLabel(event)}.`
        });
        return;
      }

      if (event.type === "automation.execution.completed") {
        const payload = event.payload || {};
        const status = typeof payload.status === "string" ? payload.status : "";
        if (status === "success") {
          return;
        }

        const name = getEventName(event);
        toast({
          title: status === "partial_success" ? "Automation finished with issues" : "Automation failed",
          description: typeof payload.message === "string" && payload.message.trim()
            ? payload.message
            : `${name} did not complete cleanly.`,
          variant: "destructive"
        });
      }
    };

    void getLatestEvents({
      limit: 1,
      category: "automation",
      types: AUTOMATION_TOAST_TYPES
    })
      .then((snapshot) => {
        if (cancelled) {
          return;
        }

        latestSequenceRef.current = snapshot.lastSequence || 0;
        cleanup = openEventStream(
          {
            sinceSequence: latestSequenceRef.current,
            limit: 50,
            category: "automation",
            types: AUTOMATION_TOAST_TYPES
          },
          {
            onEvent: handleEvent,
            onReady: (sinceSequence) => {
              latestSequenceRef.current = Math.max(latestSequenceRef.current, sinceSequence || 0);
            },
            onError: () => {
              // The next mount or page refresh will reconnect. Keep this silent for ambient toasts.
            }
          }
        );
      })
      .catch(() => {
        // No-op. Missing ambient toasts should not disrupt the rest of the app.
      });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [toast]);

  return null;
}
