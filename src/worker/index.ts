// Cloudflare Workers 版エントリ。/ws を部屋コードごとの Durable Object に振り分ける。
import { DurableObject } from "cloudflare:workers";
import { RoomCore, type Peer } from "../shared/room.ts";
import type { ClientMsg, ServerMsg } from "../shared/types.ts";

interface Env {
  ROOM: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/ws") return env.ASSETS.fetch(req);
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });

    const code = url.searchParams.has("create") ? newCode() : (url.searchParams.get("room") ?? "").toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) return new Response("bad room", { status: 400 });
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const headers = new Headers(req.headers);
    headers.set("x-room-code", code);
    return stub.fetch(new Request(req, { headers }));
  },
} satisfies ExportedHandler<Env>;

/** 1部屋 = 1つの Durable Object。ゲームループもここで回す。 */
export class GameRoom extends DurableObject<Env> {
  private core: RoomCore | null = null;
  private sockets = new Set<WebSocket>();

  override async fetch(req: Request): Promise<Response> {
    const code = req.headers.get("x-room-code") ?? "";
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();
    this.sockets.add(server);

    const send = (m: ServerMsg) => {
      try {
        server.send(JSON.stringify(m));
      } catch {}
    };
    const peer: Peer = { idx: 0, room: null, send };
    send({ type: "hello", id: code });

    server.addEventListener("message", (e) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return send({ type: "error", message: "不正なメッセージです" });
      }
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "create": {
          if (this.core) return send({ type: "error", message: "部屋コードが重複しました。もう一度お試しください" });
          this.core = new RoomCore(code, () => {
            this.core = null;
            // 試合終了後、少し待ってから接続を閉じて DO を解放する
            setTimeout(() => this.sockets.forEach((s) => s.close(1000, "done")), 1500);
          });
          const err = this.core.join(peer, msg.deck);
          if (err) {
            this.core = null;
            send({ type: "error", message: err });
          }
          return;
        }
        case "join": {
          if (!this.core) return send({ type: "error", message: "部屋が見つかりません" });
          const err = this.core.join(peer, msg.deck);
          if (err) send({ type: "error", message: err });
          return;
        }
        case "leave":
          peer.room?.leave(peer);
          return;
        default:
          peer.room?.handle(peer, msg);
      }
    });
    const gone = () => {
      this.sockets.delete(server);
      peer.room?.leave(peer);
    };
    server.addEventListener("close", gone);
    server.addEventListener("error", gone);

    return new Response(null, { status: 101, webSocket: client });
  }
}
