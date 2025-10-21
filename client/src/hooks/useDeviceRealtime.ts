import { useCallback, useEffect } from "react";

type DevicePayload = any[] | { devices?: any[] };

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

const getHostname = () => window.location.hostname || "localhost";

const sanitizeHostname = (value: string) => {
  if (!value) {
    return getHostname();
  }
  const current = getHostname();
  if (loopbackHosts.has(value) && current && current !== "localhost") {
    return current;
  }
  return value;
};

const inferPort = () => {
  const port = window.location.port;
  if (!port || port === "80" || port === "443") {
    return undefined;
  }
  if (port === "5173") {
    return "3000";
  }
  return port;
};

export function useDeviceRealtime(applyIncomingDevices: (devices: any[]) => void) {
  const resolveDeviceWebSocketUrl = useCallback(() => {
    const override = import.meta.env.VITE_DEVICE_WS_URL;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const hostname = getHostname();
    const token = localStorage.getItem("accessToken");
    const inferredPort = inferPort();

    if (override && typeof override === "string") {
      try {
        const parsedUrl = /^wss?:\/\//i.test(override)
          ? new URL(override)
          : new URL(override, `${protocol}//${hostname}`);

        parsedUrl.protocol = protocol;
        const overrideHostname = parsedUrl.hostname;
        parsedUrl.hostname = sanitizeHostname(parsedUrl.hostname);
        const hostChanged = overrideHostname !== parsedUrl.hostname;
        if (hostChanged && loopbackHosts.has(overrideHostname)) {
          parsedUrl.port = "";
        }

        const explicitPort = import.meta.env.VITE_DEVICE_WS_PORT;
        if (explicitPort) {
          parsedUrl.port = explicitPort;
        } else if (!parsedUrl.port && inferredPort) {
          parsedUrl.port = inferredPort;
        }

        if (token) {
          parsedUrl.searchParams.set("token", token);
        } else {
          parsedUrl.searchParams.delete("token");
        }

        return parsedUrl.toString();
      } catch (error) {
        console.warn("Failed to parse VITE_DEVICE_WS_URL, falling back to inferred URL", error);
      }
    }

    const explicitPort = import.meta.env.VITE_DEVICE_WS_PORT;
    if (explicitPort) {
      const base = `${protocol}//${hostname}:${explicitPort}/ws/devices`;
      return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    }

    if (inferredPort) {
      const base = `${protocol}//${hostname}:${inferredPort}/ws/devices`;
      return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    }

    const base = `${protocol}//${hostname}/ws/devices`;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }, []);

  const resolveDeviceStreamUrl = useCallback(() => {
    const override = import.meta.env.VITE_DEVICE_WS_URL;
    const protocol = window.location.protocol === "https:" ? "https:" : "http:";
    const hostname = getHostname();
    const token = localStorage.getItem("accessToken");
    const inferredPort = inferPort();

    if (override && typeof override === "string") {
      try {
        const parsedUrl = /^wss?:\/\//i.test(override)
          ? new URL(override)
          : new URL(override, `${protocol}//${hostname}`);

        parsedUrl.protocol = protocol;
        const overrideHostname = parsedUrl.hostname;
        parsedUrl.hostname = sanitizeHostname(parsedUrl.hostname);
        const hostChanged = overrideHostname !== parsedUrl.hostname;
        if (hostChanged && loopbackHosts.has(overrideHostname)) {
          parsedUrl.port = "";
        }
        parsedUrl.pathname = "/api/devices/stream";
        parsedUrl.search = "";

        const explicitPort = import.meta.env.VITE_DEVICE_WS_PORT;
        if (explicitPort) {
          parsedUrl.port = explicitPort;
        } else if (!parsedUrl.port && inferredPort) {
          parsedUrl.port = inferredPort;
        }

        if (token) {
          parsedUrl.searchParams.set("token", token);
        }

        return parsedUrl.toString();
      } catch (error) {
        console.warn("Failed to derive devices stream URL from VITE_DEVICE_WS_URL override", error);
      }
    }

    if (token) {
      return `/api/devices/stream?token=${encodeURIComponent(token)}`;
    }

    return "/api/devices/stream";
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let manuallyClosed = false;
    let websocketFailures = 0;

    const handleIncomingPayload = (payload: DevicePayload) => {
      if (!payload) {
        return;
      }
      if (Array.isArray(payload)) {
        applyIncomingDevices(payload);
        return;
      }
      if (Array.isArray(payload.devices)) {
        applyIncomingDevices(payload.devices);
      }
    };

    const connectEventSource = () => {
      if (manuallyClosed || eventSource) {
        return;
      }

      console.log("Device updates: falling back to SSE stream");
      const streamUrl = resolveDeviceStreamUrl();
      const source = new EventSource(streamUrl);
      eventSource = source;

      source.onopen = () => {
        console.log("Device updates SSE connected");
        websocketFailures = 0;
      };

      source.onmessage = (event) => {
        if (!event.data) {
          return;
        }

        try {
          const payload = JSON.parse(event.data);
          handleIncomingPayload(payload);
        } catch (error) {
          console.warn("Device updates SSE parse error", error);
        }
      };

      source.onerror = (event) => {
        console.warn("Device updates SSE error", event);
        source.close();
        eventSource = null;
        if (!manuallyClosed) {
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          reconnectTimer = setTimeout(connectEventSource, 5000);
        }
      };
    };

    const connectWebSocket = () => {
      if (manuallyClosed) {
        return;
      }

      const socketUrl = resolveDeviceWebSocketUrl();

      try {
        socket = new WebSocket(socketUrl);
      } catch (error) {
        console.warn("Device updates websocket constructor failed", error);
        connectEventSource();
        return;
      }

      socket.onopen = () => {
        console.log("Device updates websocket connected", socketUrl);
        websocketFailures = 0;
      };

      socket.onerror = (event) => {
        console.warn("Device updates websocket error", event);
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          handleIncomingPayload(payload);
        } catch (error) {
          console.warn("Failed to parse device update payload", error);
        }
      };

      socket.onclose = () => {
        if (manuallyClosed) {
          return;
        }

        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        websocketFailures += 1;

        if (websocketFailures >= 3) {
          console.warn("Device updates websocket unavailable, switching to SSE");
          connectEventSource();
          return;
        }

        reconnectTimer = setTimeout(connectWebSocket, 5000);
      };
    };

    const cleanup = () => {
      manuallyClosed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      if (socket && socket.readyState !== WebSocket.CLOSED) {
        try {
          socket.close();
        } catch (error) {
          console.warn("Device updates websocket close error", error);
        }
      }
      socket = null;

      if (eventSource) {
        try {
          eventSource.close();
        } catch (error) {
          console.warn("Device updates SSE close error", error);
        }
      }
      eventSource = null;
    };

    connectWebSocket();

    return cleanup;
  }, [applyIncomingDevices, resolveDeviceStreamUrl, resolveDeviceWebSocketUrl]);
}
