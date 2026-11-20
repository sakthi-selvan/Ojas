import type { ServerEvent } from "@ojas/shared";
import type { WebSocket } from "ws";

/**
 * LAN push channel: every reception desk, doctor screen and token display gets updates instantly,
 * so nobody has to press refresh.
 */
export class Realtime {
  private clients = new Set<WebSocket>();

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    this.sendTo(ws, { type: "hello", serverTime: new Date().toISOString() });
  }

  broadcast(event: ServerEvent): void {
    const msg = JSON.stringify(event);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  }

  private sendTo(ws: WebSocket, event: ServerEvent): void {
    ws.send(JSON.stringify(event));
  }

  get size(): number {
    return this.clients.size;
  }
}
