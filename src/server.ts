import { join } from "node:path";
import index from "./web/index.html";
import * as C from "./shared/constants.ts";
import { cmdAction, cmdMove, cmdStrat, createGame, snapshotFor, tick, validateDeck, type DeckInfo, type Game } from "./shared/game.ts";
import { CARD_BY_ID } from "./shared/cards.ts";
import type { ClientMsg, PlayerIdx, ServerMsg } from "./shared/types.ts";

interface WsData {
  id: string;
  room: Room | null;
  idx: PlayerIdx;
}
type Sock = Bun.ServerWebSocket<WsData>;

interface Room {
  code: string;
  players: [Sock | null, Sock | null];
  decks: [DeckInfo | null, DeckInfo | null];
  deckIds: [string[], string[]];
  game: Game | null;
  timer: ReturnType<typeof setInterval> | null;
}

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function startServer(opts: { port?: number; hostname?: string } = {}) {
  const rooms = new Map<string, Room>();

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

  const closeRoom = (room: Room) => {
    if (room.timer) clearInterval(room.timer);
    room.timer = null;
    rooms.delete(room.code);
  };

  const startGame = (room: Room) => {
    const [da, db] = room.decks;
    if (!da || !db) return;
    room.game = createGame(da, db);
    room.players.forEach((ws, i) => {
      if (ws) send(ws, { type: "start", you: i as PlayerIdx, decks: room.deckIds, maxMorale: room.game!.maxMorale[i as PlayerIdx] });
    });
    room.timer = setInterval(() => {
      const g = room.game!;
      tick(g);
      room.players.forEach((ws, i) => {
        if (ws) send(ws, { type: "snapshot", s: snapshotFor(g, i as PlayerIdx) });
      });
      if (g.over) {
        const over = g.over;
        for (const ws of room.players) if (ws) send(ws, { type: "ended", winner: over.winner, reason: over.reason });
        closeRoom(room);
      }
    }, 1000 / C.TICK_RATE);
  };

  const leave = (ws: Sock) => {
    const room = ws.data.room;
    if (!room) return;
    ws.data.room = null;
    const idx = ws.data.idx;
    room.players[idx] = null;
    const other = room.players[idx === 0 ? 1 : 0];
    if (room.game && !room.game.over) {
      if (other) send(other, { type: "ended", winner: idx === 0 ? 1 : 0, reason: "相手が切断しました" });
      closeRoom(room);
    } else if (!room.game) {
      if (!other) closeRoom(room);
      else send(other, { type: "room", room: room.code, you: idx === 0 ? 1 : 0, waiting: true });
    }
  };

  const handle = (ws: Sock, msg: ClientMsg) => {
    switch (msg.type) {
      case "create":
      case "join": {
        if (ws.data.room) return send(ws, { type: "error", message: "すでに部屋に入っています" });
        const v = validateDeck(msg.deck);
        if (!v.ok) return send(ws, { type: "error", message: v.error });
        let room: Room | undefined;
        let idx: PlayerIdx = 0;
        if (msg.type === "create") {
          room = { code: newCode(), players: [null, null], decks: [null, null], deckIds: [[], []], game: null, timer: null };
          rooms.set(room.code, room);
        } else {
          room = rooms.get(String(msg.room ?? "").toUpperCase());
          if (!room) return send(ws, { type: "error", message: "部屋が見つかりません" });
          if (room.game) return send(ws, { type: "error", message: "すでに対戦中です" });
          idx = room.players[0] ? 1 : 0;
          if (room.players[idx]) return send(ws, { type: "error", message: "部屋が満員です" });
        }
        room.players[idx] = ws;
        room.decks[idx] = v.info;
        room.deckIds[idx] = (msg.deck as string[]).slice();
        ws.data.room = room;
        ws.data.idx = idx;
        const full = !!(room.players[0] && room.players[1]);
        for (const p of room.players) if (p) send(p, { type: "room", room: room.code, you: p.data.idx, waiting: !full });
        if (full) startGame(room);
        return;
      }
      case "move": {
        const g = ws.data.room?.game;
        if (!g) return;
        const err = cmdMove(g, ws.data.idx, Number(msg.slot), Number(msg.x), Number(msg.y));
        if (err) send(ws, { type: "error", message: err });
        return;
      }
      case "strat": {
        const g = ws.data.room?.game;
        if (!g) return;
        const err = cmdStrat(g, ws.data.idx, Number(msg.slot));
        if (err) send(ws, { type: "error", message: err });
        return;
      }
      case "action": {
        const g = ws.data.room?.game;
        if (!g) return;
        const err = cmdAction(g, ws.data.idx, Number(msg.slot));
        if (err) send(ws, { type: "error", message: err });
        return;
      }
      case "leave":
        return leave(ws);
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
        if (server.upgrade(req, { data: { id: crypto.randomUUID(), room: null, idx: 0 } satisfies WsData })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
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
        leave(ws);
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
