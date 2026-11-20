import { join } from "node:path";
import index from "./web/index.html";
import { RoomCore, type Peer } from "./shared/room.ts";
import { CARD_BY_ID } from "./shared/cards.ts";
import type { ClientMsg, ServerMsg } from "./shared/types.ts";

interface WsData extends Peer {
  id: string;
  ws: Bun.ServerWebSocket<WsData> | null;
}
type Sock = Bun.ServerWebSocket<WsData>;

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeData(): WsData {
  const d: WsData = {
    id: crypto.randomUUID(),
    idx: 0,
    room: null,
    ws: null,
    send(msg) {
      try {
        d.ws?.send(JSON.stringify(msg));
      } catch {}
    },
  };
  return d;
}

export function startServer(opts: { port?: number; hostname?: string } = {}) {
  const rooms = new Map<string, RoomCore>();

  const send = (ws: Sock, msg: ServerMsg) => {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  };

  const newCode = () => {
    for (;;) {
      let c = "";
      for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!rooms.has(c)) return c;
    }
  };

  const handle = (ws: Sock, msg: ClientMsg) => {
    const peer = ws.data;
    switch (msg.type) {
      case "create": {
        if (peer.room) return send(ws, { type: "error", message: "すでに部屋に入っています" });
        const code = newCode();
        const room = new RoomCore(code, () => rooms.delete(code));
        rooms.set(code, room);
        const err = room.join(peer, msg.deck);
        if (err) {
          rooms.delete(code);
          send(ws, { type: "error", message: err });
        }
        return;
      }
      case "join": {
        const room = rooms.get(String(msg.room ?? "").toUpperCase());
        if (!room) return send(ws, { type: "error", message: "部屋が見つかりません" });
        const err = room.join(peer, msg.deck);
        if (err) send(ws, { type: "error", message: err });
        return;
      }
      case "leave":
        peer.room?.leave(peer);
        return;
      default:
        peer.room?.handle(peer, msg);
    }
  };

  const server = Bun.serve<WsData>({
    port: opts.port ?? Number(process.env.PORT ?? 3000),
    hostname: opts.hostname ?? "0.0.0.0",
    routes: {
      "/": index,
      "/cards/:file": async (req: Bun.BunRequest<"/cards/:file">) => {
        let name: string;
        try {
          name = decodeURIComponent(req.params.file);
        } catch {
          return new Response("bad request", { status: 400 });
        }
        // 許可するのは manifest.json と、実在するカードIDの .jpg だけ（パストラバーサル対策）
        const ok = name === "manifest.json" || (name.endsWith(".jpg") && CARD_BY_ID.has(name.slice(0, -4)));
        if (!ok) return new Response("bad request", { status: 400 });
        const f = Bun.file(join(PUBLIC_DIR, "cards", name));
        if (!(await f.exists())) return new Response("not found", { status: 404 });
        return new Response(f, { headers: { "cache-control": "public, max-age=3600" } });
      },
      "/api/cards": () => Response.json([...CARD_BY_ID.values()]),
    },
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(req, { data: makeData() })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.data.ws = ws;
        send(ws, { type: "hello", id: ws.data.id });
      },
      message(ws, raw) {
        let msg: ClientMsg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return send(ws, { type: "error", message: "不正なメッセージです" });
        }
        if (!msg || typeof msg !== "object" || typeof (msg as any).type !== "string") return;
        handle(ws, msg);
      },
      close(ws) {
        ws.data.room?.leave(ws.data);
      },
    },
    development: process.env.NODE_ENV !== "production" && !process.env.TAISEN_TEST ? { hmr: true, console: false } : false,
  });
  return { server, rooms };
}

if (import.meta.main) {
  const { server } = startServer();
  console.log(`mytaisen: http://localhost:${server.port}`);
}
