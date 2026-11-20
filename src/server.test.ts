import { afterAll, beforeAll, expect, test } from "bun:test";
import { CARDS } from "./shared/cards.ts";
import type { ClientMsg, ServerMsg } from "./shared/types.ts";

process.env.TAISEN_TEST = "1";
const { startServer } = await import("./server.ts");

let srv: ReturnType<typeof startServer>;
beforeAll(() => {
  srv = startServer({ port: 0, hostname: "127.0.0.1" });
});
afterAll(() => {
  srv.server.stop(true);
});

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.server.port}/ws`);
  const msgs: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
  ws.onmessage = (e) => {
    const m: ServerMsg = JSON.parse(e.data);
    msgs.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(m)) waiters.splice(i, 1)[0]!.res(m);
    }
  };
  const opened = new Promise<void>((r) => (ws.onopen = () => r()));
  return {
    ws,
    msgs,
    opened,
    send: (m: ClientMsg) => ws.send(JSON.stringify(m)),
    wait: <T extends ServerMsg["type"]>(type: T, extra?: (m: Extract<ServerMsg, { type: T }>) => boolean) =>
      new Promise<Extract<ServerMsg, { type: T }>>((res, rej) => {
        const pred = (m: ServerMsg) => m.type === type && (!extra || extra(m as any));
        const found = msgs.find(pred);
        if (found) return res(found as any);
        const t = setTimeout(() => rej(new Error(`timeout waiting ${type}`)), 4000);
        waiters.push({ pred, res: (m) => (clearTimeout(t), res(m as any)) });
      }),
  };
}

const deckOf = (n: number) => CARDS.filter((c) => c.cost === 1 && c.color === "蒼" && c.skills.length === 0).slice(n, n + 4).map((c) => c.id);
const deckA = deckOf(0);
const deckB = CARDS.filter((c) => c.cost === 1 && c.color === "緋" && c.skills.length === 0).slice(0, 4).map((c) => c.id);

test("2人が部屋に入ると開始し、操作がサーバー経由で反映される", async () => {
  const a = client();
  const b = client();
  await Promise.all([a.opened, b.opened]);
  a.send({ type: "create", deck: deckA });
  const room = await a.wait("room");
  expect(room.room).toHaveLength(4);
  expect(room.waiting).toBe(true);
  b.send({ type: "join", room: room.room.toLowerCase(), deck: deckB });
  const [sa, sb] = await Promise.all([a.wait("start"), b.wait("start")]);
  expect(sa.you).toBe(0);
  expect(sb.you).toBe(1);

  const snapA = await a.wait("snapshot");
  const snapB = await b.wait("snapshot");
  expect(snapA.s.you).toBe(0);
  expect(snapB.s.you).toBe(1);
  // 相手の指示位置(tx)は見えない
  expect(snapA.s.units.filter((u) => u.p === 1).every((u) => u.tx === undefined)).toBe(true);
  expect(snapA.s.units.filter((u) => u.p === 0).every((u) => u.tx !== undefined)).toBe(true);

  // Aが出撃指示 → Bのスナップショットに(遅れて)敵部隊の移動が反映される
  a.send({ type: "move", slot: 0, x: 300, y: 500 });
  const moved = await b.wait("snapshot", (m) => m.s.units.some((u) => u.p === 0 && u.slot === 0 && u.mode === "field" && u.y < 880));
  expect(moved.s.units.find((u) => u.p === 0 && u.slot === 0)!.tx).toBeUndefined();

  // 不正な操作は error で返る (士気不足の計略 or 範囲外)
  b.send({ type: "move", slot: 99, x: 0, y: 0 });
  const err = await b.wait("error");
  expect(err.message).toBeTruthy();

  // 切断で相手の不戦勝
  a.ws.close();
  const ended = await b.wait("ended");
  expect(ended.winner).toBe(1);
  b.ws.close();
});

test("不正なデッキは拒否される", async () => {
  const a = client();
  await a.opened;
  a.send({ type: "create", deck: ["nope"] });
  const e = await a.wait("error");
  expect(e.message).toContain("存在しない");
  a.send({ type: "join", room: "ZZZZ", deck: deckA });
  const e2 = await a.wait("error", (m) => m.message.includes("見つかりません"));
  expect(e2).toBeTruthy();
  a.ws.close();
});

test("同じ部屋に3人目は入れない", async () => {
  const a = client();
  const b = client();
  const c = client();
  await Promise.all([a.opened, b.opened, c.opened]);
  a.send({ type: "create", deck: deckA });
  const room = await a.wait("room");
  b.send({ type: "join", room: room.room, deck: deckB });
  await b.wait("start");
  c.send({ type: "join", room: room.room, deck: deckB });
  const e = await c.wait("error");
  expect(e.message).toContain("対戦中");
  for (const x of [a, b, c]) x.ws.close();
});
