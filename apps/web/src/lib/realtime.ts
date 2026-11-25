import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerEvent } from "@ojas/shared";

export type Connection = "connecting" | "online" | "offline";

/**
 * Keeps one WebSocket to the server open and turns pushed events into cache invalidations, so every
 * screen on the LAN updates live. Reconnects with backoff after a cable pull or a server restart.
 */
export function useServerEvents(): Connection {
  const qc = useQueryClient();
  const [state, setState] = useState<Connection>("connecting");

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/events`);
      ws.onopen = () => {
        retry = 0;
        setState("online");
        // Catch up on anything missed while disconnected.
        void qc.invalidateQueries();
      };
      ws.onmessage = (m) => {
        const ev = JSON.parse(String(m.data)) as ServerEvent;
        if (ev.type === "queue.changed") {
          void qc.invalidateQueries({ queryKey: ["queue"] });
          void qc.invalidateQueries({ queryKey: ["slots"] });
        } else if (ev.type === "consult.changed") {
          void qc.invalidateQueries({ queryKey: ["consult", ev.appointmentId] });
        } else if (ev.type === "lab.changed") {
          void qc.invalidateQueries({ queryKey: ["lab-orders"] });
          void qc.invalidateQueries({ queryKey: ["lab-order", ev.orderId] });
          void qc.invalidateQueries({ queryKey: ["lab-requests"] });
          void qc.invalidateQueries({ queryKey: ["lab-results"] });
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setState("offline");
        timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [qc]);

  return state;
}
