import { describe, expect, test } from "bun:test";
import { CARDS } from "./shared/cards.ts";
import * as C from "./shared/constants.ts";
import { cmdAction, cmdMove, cmdStrat, createGame, snapshotFor, tick, unitOf, validateDeck, type Game } from "./shared/game.ts";
import type { Card, UnitType } from "./shared/types.ts";

const pick = (pred: (c: Card) => boolean, skip = 0) => CARDS.filter(pred)[skip]!;
const mk = (ids: string[]) => {
  const r = validateDeck(ids);
  if (!r.ok) throw new Error(r.error);
  return r.info;
};
const ofType = (unit: UnitType, cost = 1, skip = 0) => pick((c) => c.unit === unit && c.cost === cost && c.skills.length === 0, skip);
const run = (g: Game, sec: number) => {
  for (let i = 0; i < sec * C.TICK_RATE; i++) tick(g);
};

describe("validateDeck", () => {
  test("正常なデッキ", () => {
    const r = validateDeck([ofType("槍兵").id, ofType("騎兵").id]);
    expect(r.ok).toBe(true);
  });
  test("総コスト超過", () => {
    const ids = CARDS.filter((c) => c.cost === 3 && c.skills.length === 0).slice(0, 4);
    const r = validateDeck(ids.map((c) => c.id));
    expect(r.ok).toBe(false);
  });
  test("9枚は不可", () => {
    const r = validateDeck(CARDS.filter((c) => c.cost === 1).slice(0, 9).map((c) => c.id));
    expect(r.ok).toBe(false);
  });
  test("同名武将は不可", () => {
    const byName = new Map<string, Card[]>();
    for (const c of CARDS) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
    const dup = [...byName.values()].find((l) => l.length >= 2 && l[0]!.cost + l[1]!.cost <= 9)!;
    const r = validateDeck([dup[0]!.id, dup[1]!.id]);
    expect(r.ok).toBe(false);
  });
  test("存在しないカード", () => {
    expect(validateDeck(["nope"]).ok).toBe(false);
    expect(validateDeck("x").ok).toBe(false);
  });
  test("最大士気は色数で変わる", () => {
    const one = CARDS.filter((c) => c.color === "蒼" && c.cost === 1 && !c.skills.includes("盟")).slice(0, 2);
    const a = CARDS.find((c) => c.color === "蒼" && c.cost === 1 && !c.skills.includes("盟"))!;
    const b = CARDS.find((c) => c.color === "緋" && c.cost === 1 && !c.skills.includes("盟"))!;
    const d = CARDS.find((c) => c.color === "碧" && c.cost === 1 && !c.skills.includes("盟"))!;
    const e = CARDS.find((c) => c.color === "玄" && c.cost === 1 && !c.skills.includes("盟"))!;
    const m = (cs: Card[]) => (validateDeck(cs.map((c) => c.id)) as any).info.maxMorale as number;
    expect(m([one[0]!])).toBe(12);
    expect(m([a, b])).toBe(10);
    expect(m([a, b, d])).toBe(8);
    expect(m([a, b, d, e])).toBe(6);
  });
});

describe("シミュレーション", () => {
  test("開戦時は全員が自城にいる", () => {
    const g = createGame(mk([ofType("槍兵").id, ofType("騎兵").id]), mk([ofType("弓兵").id]));
    for (const u of g.units) expect(u.mode).toBe("castle");
    expect(g.units.filter((u) => u.p === 0).every((u) => u.y > C.FIELD_H - C.CASTLE_ZONE_H)).toBe(true);
    expect(g.units.filter((u) => u.p === 1).every((u) => u.y < C.CASTLE_ZONE_H)).toBe(true);
  });

  test("カードを城外へ動かすと出城し、部隊は遅れて追従する", () => {
    const g = createGame(mk([ofType("槍兵").id]), mk([ofType("槍兵").id]));
    expect(cmdMove(g, 0, 0, 300, 500)).toBeNull();
    run(g, 0.5);
    const u = unitOf(g, 0, 0)!;
    expect(u.mode).toBe("field");
    expect(u.y).toBeLessThan(C.FIELD_H - C.CASTLE_ZONE_H / 2);
    expect(u.y).toBeGreaterThan(500); // まだ到達していない
    run(g, 30);
    expect(Math.abs(u.y - 500)).toBeLessThan(5);
  });

  test("城へ戻すと帰城して回復", () => {
    const g = createGame(mk([ofType("槍兵").id]), mk([ofType("槍兵").id]));
    cmdMove(g, 0, 0, 300, 600);
    run(g, 20);
    const u = unitOf(g, 0, 0)!;
    u.hp = 10;
    cmdMove(g, 0, 0, 300, C.FIELD_H - 50);
    run(g, 20);
    expect(u.mode).toBe("castle");
    expect(u.hp).toBeGreaterThan(50);
  });

  test("範囲外座標はクランプ、不正値は拒否", () => {
    const g = createGame(mk([ofType("槍兵").id]), mk([ofType("槍兵").id]));
    cmdMove(g, 0, 0, -50, 99999);
    const u = unitOf(g, 0, 0)!;
    expect(u.tx).toBe(0);
    expect(u.ty).toBe(C.FIELD_H);
    expect(cmdMove(g, 0, 0, NaN, 0)).not.toBeNull();
    expect(cmdMove(g, 0, 5, 0, 0)).not.toBeNull();
  });

  test("乱戦でHPが減り、撤退して復活する", () => {
    const strongCard = CARDS.filter((c) => c.unit === "槍兵" && c.cost <= 2 && c.skills.length === 0).sort((x, y) => y.strong - x.strong)[0]!;
    const weakCard = CARDS.filter((c) => c.unit === "剣豪" && c.cost === 1 && c.skills.length === 0).sort((x, y) => x.strong - y.strong)[0]!;
    const g = createGame(mk([strongCard.id]), mk([weakCard.id]));
    const a = unitOf(g, 0, 0)!;
    const b = unitOf(g, 1, 0)!;
    a.mode = b.mode = "field";
    a.x = b.x = 300;
    a.y = 500;
    b.y = 520;
    a.tx = a.x;
    a.ty = a.y;
    b.tx = b.x;
    b.ty = b.y;
    for (let i = 0; i < 20 * 60 && (b.mode as string) !== "dead"; i++) tick(g);
    expect(b.mode as string).toBe("dead");
    expect(a.hp).toBeGreaterThan(0);
    run(g, 30);
    expect(b.mode as string).toBe("castle");
    expect(b.hp).toBe(b.maxHp);
  });

  test("計略で士気を消費し、使用後は使用済みになる", () => {
    const card = pick((c) => c.strat.categories.includes("強化") && !c.strat.categories.includes("短計") && c.strat.mp <= 5 && c.skills.length === 0 && c.cost === 1);
    const g = createGame(mk([card.id]), mk([ofType("槍兵").id]));
    g.morale[0] = 10;
    expect(cmdStrat(g, 0, 0)).toBeNull();
    expect(g.morale[0]).toBeCloseTo(10 - card.strat.mp, 5);
    expect(cmdStrat(g, 0, 0)).not.toBeNull();
    expect(unitOf(g, 0, 0)!.buffs.length).toBeGreaterThan(0);
  });

  test("士気が足りなければ計略は失敗", () => {
    const card = pick((c) => c.strat.mp >= 6 && !c.strat.categories.includes("短計") && c.cost === 1);
    const g = createGame(mk([card.id]), mk([ofType("槍兵").id]));
    g.morale[0] = 1;
    expect(cmdStrat(g, 0, 0)).not.toBeNull();
    expect(g.morale[0]).toBe(1);
  });

  test("士気は上限まで回復して止まる", () => {
    const g = createGame(mk([ofType("槍兵").id]), mk([ofType("槍兵").id]));
    run(g, 120);
    expect(g.morale[0]).toBe(g.maxMorale[0]);
  });

  test("攻城で敵城ゲージが減り、0で勝敗がつく", () => {
    const card = pick((c) => c.unit === "槍兵" && c.cost === 3 && c.skills.length === 0 && c.strong >= 9);
    const g = createGame(mk([card.id]), mk([ofType("弓兵").id]));
    cmdMove(g, 0, 0, C.FIELD_W / 2, 40);
    run(g, 50);
    expect(g.castle[1]).toBeLessThan(C.CASTLE_HP);
    for (let i = 0; i < 20 * 600 && !g.over; i++) tick(g);
    expect(g.over?.winner).toBe(0);
  });

  test("敵城エリアには入れず、城壁で止まる", () => {
    const g = createGame(mk([ofType("槍兵").id]), mk([ofType("弓兵").id]));
    cmdMove(g, 0, 0, 100, 10);
    run(g, 40);
    expect(g.units[0]!.y).toBeGreaterThanOrEqual(C.CASTLE_ZONE_H + C.UNIT_RADIUS - 0.001);
    expect(g.castle[1]).toBeLessThan(C.CASTLE_HP); // 城壁への攻撃は通る
  });

  test("城門を攻撃できるのは1部隊だけで、城壁より大きなダメージ", () => {
    const a = pick((c) => c.unit === "槍兵" && c.cost === 1 && c.skills.length === 0);
    const b = pick((c) => c.unit === "槍兵" && c.cost === 1 && c.skills.length === 0 && c.id !== a.id);
    const g = createGame(mk([a.id, b.id]), mk([ofType("弓兵").id]));
    cmdMove(g, 0, 0, C.FIELD_W / 2, 10);
    cmdMove(g, 0, 1, C.FIELD_W / 2 + 10, 10);
    run(g, 50);
    const holders = g.units.filter((u) => u.p === 0 && g.gate[1] === u.id);
    expect(holders.length).toBe(1);
    const other = g.units.find((u) => u.p === 0 && u.id !== g.gate[1])!;
    expect(other.sieging).toBe(true);
  });

  test("時間切れは城ゲージの多い方が勝ち", () => {
    const g = createGame(mk([ofType("槍兵").id]), mk([ofType("槍兵").id]));
    g.castle = [80, 50];
    run(g, C.GAME_SEC + 1);
    expect(g.over?.winner).toBe(0);
  });

  test("騎兵は十分走ると突撃可能になり、槍に迎撃される", () => {
    const cav = pick((c) => c.unit === "騎兵" && c.cost === 1 && c.skills.length === 0);
    const pike = pick((c) => c.unit === "槍兵" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([cav.id]), mk([pike.id]));
    const a = unitOf(g, 0, 0)!;
    const b = unitOf(g, 1, 0)!;
    cmdMove(g, 0, 0, 300, 300);
    b.mode = "field";
    b.x = 300;
    b.y = 300;
    b.tx = 300;
    b.ty = 300;
    b.fx = 0;
    b.fy = 1; // 下(P0側)向きに槍
    b.hp = b.maxHp;
    let charged = false;
    let intercepted = false;
    for (let i = 0; i < 20 * 40; i++) {
      tick(g);
      if (a.charging) charged = true;
      if (g.fx.some((f) => f.k === "intercept")) intercepted = true;
      if (intercepted) break;
    }
    expect(charged).toBe(true);
    expect(intercepted).toBe(true);
    expect(a.charging).toBe(false);
    expect(a.hp).toBeLessThan(a.maxHp);
  });

  test("鉄砲隊の射撃は射線上に当たりクールダウンする", () => {
    const gun = pick((c) => c.unit === "鉄砲隊" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([gun.id]), mk([ofType("槍兵").id]));
    const a = unitOf(g, 0, 0)!;
    const b = unitOf(g, 1, 0)!;
    a.mode = b.mode = "field";
    a.x = 300;
    a.y = 600;
    a.tx = a.x;
    a.ty = a.y;
    b.x = 300;
    b.y = 450;
    b.tx = b.x;
    b.ty = b.y;
    expect(cmdAction(g, 0, 0)).toBeNull();
    expect(b.hp).toBeLessThan(b.maxHp);
    expect(cmdAction(g, 0, 0)).not.toBeNull(); // CD中
  });

  test("相手には見えない情報が漏れない", () => {
    const g = createGame(mk([ofType("槍兵").id]), mk([ofType("槍兵").id]));
    expect(snapshotFor(g, 1).units.some((u) => u.p === 0)).toBe(false); // 城内の敵は見えない
    const e0 = unitOf(g, 0, 0)!;
    e0.mode = "field"; // 出城した直後でも、まだ城エリア内なら見えない
    expect(snapshotFor(g, 1).units.some((u) => u.p === 0)).toBe(false);
    e0.y = C.FIELD_H / 2;
    const s = snapshotFor(g, 1);
    const enemy = s.units.find((u) => u.p === 0)!;
    expect(enemy.tx).toBeUndefined();
    expect(enemy.ty).toBeUndefined();
    const mine = s.units.find((u) => u.p === 1)!;
    expect(mine.tx).toBeDefined();
  });

  test("伏兵は敵から見えず、接触で解除される", () => {
    const amb = pick((c) => c.skills.includes("伏") && c.cost === 1 && c.unit === "槍兵");
    const g = createGame(mk([amb.id]), mk([ofType("槍兵").id]));
    const a = unitOf(g, 0, 0)!;
    cmdMove(g, 0, 0, 300, 700);
    run(g, 10);
    expect(a.hidden).toBe(true);
    expect(snapshotFor(g, 1).units.some((u) => u.p === 0)).toBe(false);
    const b = unitOf(g, 1, 0)!;
    b.mode = "field";
    b.x = a.x;
    b.y = a.y - 20;
    b.tx = b.x;
    b.ty = b.y;
    run(g, 0.2);
    expect(a.ambush).toBe(false);
  });
});
