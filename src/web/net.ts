import type { ClientMsg, ServerMsg } from "../shared/types.ts";

export class Conn {
  ws: WebSocket;
  private queue: string[] = [];
  constructor(onMsg: (m: ServerMsg) => void, onClose: () => void) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      for (const q of this.queue) this.ws.send(q);
      this.queue = [];
    };
    this.ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    this.ws.onclose = onClose;
  }
  send(m: ClientMsg) {
    const s = JSON.stringify(m);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(s);
  }
  close() {
    this.ws.close();
  }
}
