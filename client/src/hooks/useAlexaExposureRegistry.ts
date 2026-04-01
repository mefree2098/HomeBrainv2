import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getAlexaExposures,
  updateAlexaExposure,
  type AlexaExposureEntityType,
  type AlexaExposureSummary
} from "@/api/alexa";

export const buildAlexaExposureKey = (entityType: AlexaExposureEntityType, entityId: string) =>
  `${entityType}:${entityId}`;

export function useAlexaExposureRegistry(enabled = true) {
  const [exposures, setExposures] = useState<AlexaExposureSummary[]>([]);
  const [loading, setLoading] = useState(Boolean(enabled));

  const refresh = useCallback(async () => {
    if (!enabled) {
      setExposures([]);
      setLoading(false);
      return [];
    }

    setLoading(true);
    try {
      const response = await getAlexaExposures();
      const nextExposures = Array.isArray(response?.exposures) ? response.exposures : [];
      setExposures(nextExposures);
      return nextExposures;
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const exposureMap = useMemo(() => {
    const map = new Map<string, AlexaExposureSummary>();
    exposures.forEach((exposure) => {
      if (!exposure?.entityType || !exposure?.entityId) {
        return;
      }

      map.set(buildAlexaExposureKey(exposure.entityType, exposure.entityId), exposure);
    });
    return map;
  }, [exposures]);

  const getExposure = useCallback((entityType: AlexaExposureEntityType, entityId: string) => {
    return exposureMap.get(buildAlexaExposureKey(entityType, entityId)) || null;
  }, [exposureMap]);

  const saveExposure = useCallback(async (
    entityType: AlexaExposureEntityType,
    entityId: string,
    payload: {
      enabled?: boolean;
      friendlyName?: string;
      aliases?: string[];
      roomHint?: string;
      projectionType?: string;
    }
  ) => {
    const response = await updateAlexaExposure(entityType, entityId, payload);
    const exposure = response?.exposure as AlexaExposureSummary | undefined;
    if (!exposure) {
      return null;
    }

    setExposures((previous) => {
      const key = buildAlexaExposureKey(entityType, entityId);
      const filtered = previous.filter((entry) => buildAlexaExposureKey(entry.entityType, entry.entityId) !== key);
      return [...filtered, exposure];
    });

    return exposure;
  }, []);

  return {
    exposures,
    loading,
    refresh,
    getExposure,
    saveExposure
  };
}
