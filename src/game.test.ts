import { describe, expect, test } from "bun:test";
import { ComPlayer, makeComDeck, makeRng } from "./shared/ai.ts";
import { CARDS, parseStratUseLimit, STRAT_LOCK_SEC_BY_ID, STRAT_USE_LIMIT_BY_ID } from "./shared/cards.ts";
import * as C from "./shared/constants.ts";
import { cmdAction, cmdMove, cmdStrat, createGame, retire, nextSiegeDamage, siegeBaseDamage, siegeCostCoef, siegeNeedSec, snapshotFor, tick, unitOf, validateDeck, type Game, type Unit } from "./shared/game.ts";
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

describe("城内の移動", () => {
  /** 自軍(先攻)の1部隊だけのゲーム。先攻の城エリアは y が大きい側 */
  const solo = (unit: UnitType = "槍兵") => {
    const g = createGame(mk([ofType(unit).id]), mk([ofType("弓兵").id]));
    return { g, u: unitOf(g, 0, 0)! };
  };
  const castleY = C.FIELD_H - 40; // 先攻の城エリア内

  test("城内の部隊は、城内の別の位置へ移動を指示すると、次のtickでその位置にいる", () => {
    const { g, u } = solo();
    expect(cmdMove(g, 0, 0, 100, castleY)).toBeNull();
    tick(g);
    expect(u.mode).toBe("castle");
    expect(u.x).toBe(100);
    expect(u.y).toBe(castleY);
    // ドラッグ中のように、続けて別の位置を指示しても、そのたびに一瞬で移動する
    cmdMove(g, 0, 0, 500, castleY - 20);
    tick(g);
    expect(u.x).toBe(500);
    expect(u.y).toBe(castleY - 20);
  });

  test("向きは移動した方向に合わせ、移動距離が0のときは変えない", () => {
    const { g, u } = solo();
    cmdMove(g, 0, 0, u.x + 120, u.y);
    tick(g);
    expect(u.fx).toBeCloseTo(1, 5);
    expect(u.fy).toBeCloseTo(0, 5);
    cmdMove(g, 0, 0, u.x, u.y); // 同じ位置
    tick(g);
    expect(u.fx).toBeCloseTo(1, 5);
    expect(u.fy).toBeCloseTo(0, 5);
  });

  test("城内の騎兵は、一瞬で移動しても、速度が上がらず突撃可能状態にならない", () => {
    const { g, u } = solo("騎兵");
    for (let i = 0; i < 40; i++) {
      cmdMove(g, 0, 0, i % 2 ? 80 : 520, castleY);
      tick(g);
      expect(u.mode).toBe("castle");
      expect(u.vel).toBe(0);
      expect(u.charging).toBe(false);
      expect(u.lastSpeed).toBe(0);
    }
  });

  test("城内で位置を動かしてから城の外へ指示すると、城内で最後にいた位置から歩き出す", () => {
    const { g, u } = solo();
    cmdMove(g, 0, 0, 200, castleY);
    tick(g);
    cmdMove(g, 0, 0, 200, C.FIELD_H / 2); // 城の外(遠く)
    tick(g);
    expect(u.mode as string).toBe("field");
    expect(Math.abs(u.y - castleY)).toBeLessThan(10); // 一瞬で城の外へは出ない
    expect(u.x).toBeCloseTo(200, 0);
    run(g, 1);
    expect(castleY - u.y).toBeGreaterThan(20); // 歩いている
  });

  test("カードを城内から戦場の遠くへ一度に置くと、城内の今の位置から歩き出す", () => {
    const { g, u } = solo();
    const y0 = u.y;
    const x0 = u.x;
    cmdMove(g, 0, 0, 300, 400);
    tick(g);
    expect(u.mode as string).toBe("field");
    expect(Math.hypot(u.x - x0, u.y - y0)).toBeLessThan(10);
  });

  test("出城中の部隊のカードを自城エリアへ戻すと、着くまでは歩き、着いた後は一瞬で移動する", () => {
    const { g, u } = solo();
    cmdMove(g, 0, 0, 300, C.FIELD_H - 400);
    run(g, 6);
    expect(u.mode as string).toBe("field");
    cmdMove(g, 0, 0, 120, castleY); // カードを自城エリアへ戻す
    tick(g);
    expect(u.mode as string).toBe("field"); // まだ城エリアに着いていない
    expect(Math.abs(u.x - 120) + Math.abs(u.y - castleY)).toBeGreaterThan(50); // 一瞬では着かない
    for (let i = 0; i < 20 * 30 && u.mode !== "castle"; i++) tick(g);
    expect(u.mode as string).toBe("castle");
    cmdMove(g, 0, 0, 540, castleY - 10);
    tick(g);
    expect(u.x).toBe(540);
    expect(u.y).toBe(castleY - 10);
  });

  test("出城している間の移動(歩く速さ)は変わらない", () => {
    const { g, u } = solo();
    cmdMove(g, 0, 0, 300, C.FIELD_H / 2);
    run(g, 2);
    const speed = C.BASE_SPEED["槍兵"];
    expect(u.mode as string).toBe("field");
    expect(Math.hypot(u.x - 300, u.y - C.FIELD_H / 2)).toBeGreaterThan(50);
    expect(u.lastSpeed).toBeLessThanOrEqual(speed + 1e-6);
    expect(u.lastSpeed).toBeGreaterThan(0);
  });
});

describe("柵", () => {
  const fenceCard = (unit: UnitType = "槍兵") => pick((c) => c.skills.includes("柵") && c.unit === unit && c.cost === 1);
  const setup = (enemyCount = 1) => {
    const f = fenceCard();
    const enemies = [ofType("槍兵", 1, 0), ofType("槍兵", 1, 1)].slice(0, enemyCount);
    const g = createGame(mk([f.id]), mk(enemies.map((c) => c.id)));
    const fence = g.fences[0]!;
    return { g, fence, enemies: g.units.filter((u) => u.p === 1) };
  };
  /** 敵部隊を柵のすぐ手前(敵側)に置く */
  const touch = (g: Game, u: Unit, fence: Game["fences"][number], dx = 0) => {
    u.mode = "field";
    u.x = fence.x + fence.w / 2 + dx;
    u.y = fence.y + fence.h / 2 - C.UNIT_RADIUS; // 自陣(上側)から見て敵側へ
    u.tx = u.x;
    u.ty = u.y;
  };

  test("柵は開戦時に耐久値が満タンで置かれる", () => {
    const { g, fence } = setup();
    expect(fence.hp).toBe(C.FENCE_HP);
    const v = snapshotFor(g, 0).fences[0]!;
    expect(v.hp).toBe(1);
    expect(v.breaking).toBe(false);
    expect(typeof v.id).toBe("number");
  });

  test("敵1部隊が接し続けると約6秒で壊れて消える", () => {
    const { g, fence, enemies } = setup();
    touch(g, enemies[0]!, fence);
    run(g, C.FENCE_BREAK_SEC - 0.5);
    expect(g.fences.length).toBe(1);
    expect(snapshotFor(g, 1).fences[0]!.breaking).toBe(true);
    expect(snapshotFor(g, 1).fences[0]!.hp).toBeLessThan(0.2);
    run(g, 1);
    expect(g.fences.length).toBe(0);
    expect(g.fx.some((x) => x.k === "fence")).toBe(true);
  });

  test("敵2部隊が接すると約3秒で壊れる", () => {
    const { g, fence, enemies } = setup(2);
    touch(g, enemies[0]!, fence, -10);
    touch(g, enemies[1]!, fence, 10);
    run(g, C.FENCE_BREAK_SEC / 2 - 0.3);
    expect(g.fences.length).toBe(1);
    run(g, 0.6);
    expect(g.fences.length).toBe(0);
  });

  test("敵部隊が離れると減らなくなり、時間でも回復しない", () => {
    const { g, fence, enemies } = setup();
    const e = enemies[0]!;
    touch(g, e, fence);
    run(g, 2);
    const hp = fence.hp;
    expect(hp).toBeLessThan(C.FENCE_HP);
    e.y = fence.y - 200;
    e.ty = e.y;
    run(g, 5);
    expect(fence.breaking).toBe(false);
    expect(fence.hp).toBe(hp);
  });

  test("城内・撤退中の敵部隊は柵を壊せない", () => {
    const { g, fence, enemies } = setup();
    const e = enemies[0]!;
    touch(g, e, fence);
    e.mode = "castle";
    e.ty = 20; // カードが城内にあるので、出城しない(城内では、カードの位置へ一瞬で移動する)
    run(g, 0.1);
    expect(e.mode).toBe("castle");
    expect(e.y).toBe(20);
    expect(fence.hp).toBe(C.FENCE_HP);
    touch(g, e, fence);
    e.mode = "dead";
    e.respawn = 100;
    run(g, 3);
    expect(fence.hp).toBe(C.FENCE_HP);
  });

  test("持ち主の軍の部隊は自軍の柵を壊さない", () => {
    const f = fenceCard();
    const mate = ofType("槍兵", 1, 1);
    const g = createGame(mk([f.id, mate.id]), mk([ofType("弓兵").id]));
    const fence = g.fences[0]!;
    const ally = unitOf(g, 0, 1)!;
    touch(g, ally, fence);
    run(g, 3);
    expect(fence.hp).toBe(C.FENCE_HP);
  });

  test("壊している最中も、敵部隊は柵を通り抜けられない", () => {
    const { g, fence, enemies } = setup();
    const e = enemies[0]!;
    touch(g, e, fence);
    cmdMove(g, 1, e.slot, e.x, fence.y + fence.h + 300); // 柵の向こう(持ち主の陣)へ進ませる
    run(g, 3);
    expect(g.fences.length).toBe(1);
    expect(e.y).toBeLessThan(fence.y);
  });

  test("柵が壊れた後は通れる", () => {
    const { g, fence, enemies } = setup();
    const e = enemies[0]!;
    touch(g, e, fence);
    const goalY = fence.y + fence.h + 300;
    cmdMove(g, 1, e.slot, e.x, goalY);
    run(g, C.FENCE_BREAK_SEC + 0.5);
    expect(g.fences.length).toBe(0);
    run(g, 3);
    expect(e.y).toBeGreaterThan(fence.y + fence.h);
  });

  test("持ち主が撤退して復活すると、耐久値が満タンの柵が置かれる", () => {
    const { g, fence, enemies } = setup();
    touch(g, enemies[0]!, fence);
    run(g, 3);
    expect(fence.hp).toBeLessThan(C.FENCE_HP);
    const owner = unitOf(g, 0, 0)!;
    owner.mode = "field";
    retire(g, owner);
    expect(g.fences.length).toBe(0);
    owner.respawn = 0.01;
    enemies[0]!.x = 10;
    enemies[0]!.y = C.FIELD_H / 2;
    run(g, 1);
    expect(g.fences.length).toBe(1);
    expect(g.fences[0]!.hp).toBe(C.FENCE_HP);
  });

  test("壊れた柵は、持ち主が撤退していなければ置き直されない", () => {
    const { g, fence, enemies } = setup();
    touch(g, enemies[0]!, fence);
    run(g, C.FENCE_BREAK_SEC + 1);
    expect(g.fences.length).toBe(0);
    run(g, 20);
    expect(g.fences.length).toBe(0);
  });
});

describe("攻城", () => {
  test("攻城ダメージの計算例(小数第3位切り捨て)", () => {
    expect(siegeBaseDamage("槍兵", 2, 7)).toBe(8.02);
    expect(siegeBaseDamage("騎兵", 1, 5)).toBe(0.66);
    expect(siegeBaseDamage("弓兵", 3, 8)).toBe(8.24);
  });
  test("城門の担当は城壁の1.65倍(13.23)で、相手には目安が送られない", () => {
    const card = pick((c) => c.unit === "槍兵" && c.cost === 2 && c.skills.length === 0);
    const g = createGame(mk([card.id]), mk([ofType("弓兵").id]));
    const u = g.units[0]!;
    u.card = { ...u.card, strong: 7 };
    u.mode = "field";
    u.x = C.FIELD_W / 2;
    u.y = C.FIELD_H / 2;
    u.sieging = true;
    g.gate[1] = -1;
    expect(nextSiegeDamage(g, u)).toBe(8.02);
    g.gate[1] = u.id;
    expect(nextSiegeDamage(g, u)).toBe(13.23);
    const mine = snapshotFor(g, 0).units.find((v) => v.p === 0 && v.slot === 0)!;
    const theirs = snapshotFor(g, 1).units.find((v) => v.p === 0 && v.slot === 0)!;
    expect(mine.siegeDmg).toBe(13.23);
    expect(theirs.siegeDmg).toBeUndefined();
  });
  test("兵種の順は 槍兵 > 剣豪 > 弓兵 = 鉄砲隊 > 騎兵", () => {
    for (const cost of [1, 2, 3, 4]) {
      const d = (u: UnitType) => siegeBaseDamage(u, cost, 7);
      expect(d("槍兵")).toBeGreaterThan(d("剣豪"));
      expect(d("剣豪")).toBeGreaterThan(d("弓兵"));
      expect(d("弓兵")).toBe(d("鉄砲隊"));
      expect(d("弓兵")).toBeGreaterThan(d("騎兵"));
    }
  });
  test("コスト係数は表のとおりで、表にないコストは補間される", () => {
    const tbl: [number, number][] = [[1, 1], [1.5, 2.5], [2, 3.75], [2.5, 4.7], [3, 5.65], [3.5, 6.55], [4, 7.5]];
    for (const [c, k] of tbl) expect(siegeCostCoef(c)).toBeCloseTo(k, 10);
    expect(siegeCostCoef(1.25)).toBeCloseTo(1.75, 10);
  });
  test("城門倍率は1.65倍", () => {
    expect(C.SIEGE_GATE_MUL).toBe(1.65);
  });
  test("攻城速度は知力の表で決まり、20以上は3.0秒", () => {
    expect(siegeNeedSec(1)).toBe(5.53);
    expect(siegeNeedSec(10)).toBe(4.33);
    expect(siegeNeedSec(19)).toBe(3.09);
    expect(siegeNeedSec(20)).toBe(3.0);
    expect(siegeNeedSec(25)).toBe(3.0);
    expect(siegeNeedSec(0)).toBe(5.67);
    expect(siegeNeedSec(1.5)).toBeCloseTo((5.53 + 5.42) / 2, 10);
  });
  test("計略で武力が上がっていると、上がった武力で計算される", () => {
    const card = pick((c) => c.unit === "槍兵" && c.cost === 2 && c.skills.length === 0);
    const g = createGame(mk([card.id]), mk([ofType("弓兵").id]));
    cmdMove(g, 0, 0, 100, 10);
    for (let i = 0; i < 20 * 60 && !g.units[0]!.sieging; i++) tick(g);
    const u = g.units[0]!;
    expect(u.sieging).toBe(true);
    const before = snapshotFor(g, 0).units.find((v) => v.p === 0 && v.slot === 0)!.siegeDmg!;
    u.buffs.push({ dStrong: 3, speedMul: 1, until: g.t + 100 });
    const after = snapshotFor(g, 0).units.find((v) => v.p === 0 && v.slot === 0)!.siegeDmg!;
    expect(before).toBe(siegeBaseDamage("槍兵", 2, card.strong));
    expect(after).toBe(siegeBaseDamage("槍兵", 2, card.strong + 3));
    expect(after).toBeGreaterThan(before);
  });
  test("実際の攻城で、城壁と城門のダメージが式どおり入る", () => {
    const card = pick((c) => c.unit === "槍兵" && c.cost === 2 && c.skills.length === 0);
    const g = createGame(mk([card.id]), mk([ofType("弓兵").id]));
    cmdMove(g, 0, 0, C.FIELD_W / 2, 10);
    let first = 0;
    for (let i = 0; i < 20 * 60 && g.castle[1] === C.CASTLE_HP; i++) tick(g);
    first = C.CASTLE_HP - g.castle[1];
    const u = g.units[0]!;
    const expectedBase = siegeBaseDamage("槍兵", 2, card.strong);
    const gate = g.gate[1] === u.id;
    expect(first).toBeCloseTo(gate ? Math.floor(expectedBase * C.SIEGE_GATE_MUL * 100 + 1e-6) / 100 : expectedBase, 5);
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

  test("撤退中も目的地を指示でき、部隊は復活するまで動かず、復活したらその目的地へ向かう", () => {
    const g = createGame(mk([ofType("槍兵").id]), mk([ofType("槍兵").id]));
    const a = unitOf(g, 0, 0)!;
    a.mode = "dead";
    a.respawn = 3;
    const x0 = a.x;
    const y0 = a.y;
    expect(cmdMove(g, 0, 0, 300, 400)).toBeNull();
    run(g, 2);
    expect(a.mode as string).toBe("dead");
    expect(a.x).toBe(x0);
    expect(a.y).toBe(y0); // 撤退中は動かない
    run(g, 3);
    expect(a.mode as string).not.toBe("dead"); // 復活
    run(g, 5);
    expect(a.y).toBeLessThan(y0 - 20); // 指示した目的地(上)へ向かっている
  });

  test("計略で士気を消費し、効果中は再度使えない", () => {
    const card = pick((c) => c.strat.categories.includes("強化") && !c.strat.categories.includes("短計") && c.strat.mp <= 5 && c.skills.length === 0 && c.cost === 1);
    const g = createGame(mk([card.id]), mk([ofType("槍兵").id]));
    g.morale[0] = 10;
    expect(cmdStrat(g, 0, 0)).toBeNull();
    expect(g.morale[0]).toBeCloseTo(10 - card.strat.mp, 5);
    expect(cmdStrat(g, 0, 0)).not.toBeNull();
    expect(unitOf(g, 0, 0)!.buffs.length).toBeGreaterThan(0);
  });

  const normalStrat = (pred: (c: Card) => boolean) => pick((c) => !c.strat.categories.includes("短計") && c.strat.time === "知力時間" && !STRAT_USE_LIMIT_BY_ID.has(c.id) && c.cost === 1 && pred(c));
  const afterEffect = (g: Game, slot = 0) => {
    const u = unitOf(g, 0, slot)!;
    g.t = u.stratEnd + 0.01;
  };

  test("計略は効果が終われば、士気が足りている限り何度でも使える", () => {
    const card = normalStrat((c) => c.strat.mp <= 4);
    const g = createGame(mk([card.id]), mk([ofType("槍兵").id]));
    for (let i = 0; i < 3; i++) {
      g.morale[0] = 10;
      expect(cmdStrat(g, 0, 0)).toBeNull();
      expect(g.morale[0]).toBeCloseTo(10 - card.strat.mp, 5);
      afterEffect(g);
    }
  });

  test("効果中は同じ武将の計略を使えない", () => {
    const card = normalStrat((c) => c.strat.mp <= 4);
    const g = createGame(mk([card.id]), mk([ofType("槍兵").id]));
    g.morale[0] = 12;
    expect(cmdStrat(g, 0, 0)).toBeNull();
    const m = g.morale[0];
    expect(cmdStrat(g, 0, 0)).not.toBeNull();
    expect(g.morale[0]).toBe(m);
    const v = snapshotFor(g, 0).units.find((x) => x.p === 0 && x.slot === 0)!;
    expect(v.stratActive).toBe(true);
    afterEffect(g);
    expect(snapshotFor(g, 0).units.find((x) => x.p === 0 && x.slot === 0)!.stratActive).toBe(false);
  });

  test("「戦闘中一度しか使用できない」の読み取りと、2回目が使えないこと(撤退・復活後も)", () => {
    expect(parseStratUseLimit("この計略は戦闘中一度しか使用できない")).toBe(1);
    expect(parseStratUseLimit("この計略は戦闘中二度しか使用できない")).toBe(2);
    expect(parseStratUseLimit("この計略は戦闘中三度しか使用できない")).toBe(3);
    expect(parseStratUseLimit("武力が上がる")).toBeNull();
    // 前に別の条件が書かれていても、「戦闘中N度しか使用できない」は読み取る
    expect(parseStratUseLimit("この計略は一定回数自身の斬撃を敵に当てた時のみ使用でき、戦闘中一度しか使用できない")).toBe(1);
    expect(STRAT_USE_LIMIT_BY_ID.get("PL107")).toBe(1);
    expect(STRAT_USE_LIMIT_BY_ID.get("EX028")).toBe(3);
    expect(STRAT_USE_LIMIT_BY_ID.size).toBe(6);
    const card = pick((c) => !c.strat.categories.includes("短計") && STRAT_USE_LIMIT_BY_ID.get(c.id) === 1 && c.cost <= 3);
    const g = createGame(mk([card.id]), mk([ofType("槍兵").id]));
    g.morale[0] = 15;
    expect(cmdStrat(g, 0, 0)).toBeNull();
    expect(snapshotFor(g, 0).units.find((x) => x.p === 0 && x.slot === 0)!.stratLeft).toBe(0);
    afterEffect(g);
    expect(cmdStrat(g, 0, 0)).not.toBeNull();
    // 撤退して復活しても回数は戻らない
    const u = unitOf(g, 0, 0)!;
    u.mode = "field";
    retire(g, u);
    u.respawn = 0.01;
    run(g, 1);
    expect(u.mode as string).toBe("castle");
    g.morale[0] = 15;
    expect(cmdStrat(g, 0, 0)).not.toBeNull();
  });

  test("再使用待ち時間は0がデフォルトで、設定した計略は効果終了後その時間だけ使えない", () => {
    expect(C.STRAT_LOCK_SEC_DEFAULT).toBe(0);
    const card = normalStrat((c) => c.strat.mp <= 4);
    const g = createGame(mk([card.id]), mk([ofType("槍兵").id]));
    g.morale[0] = 15;
    expect(cmdStrat(g, 0, 0)).toBeNull();
    afterEffect(g);
    expect(cmdStrat(g, 0, 0)).toBeNull(); // 待ち時間0なら効果終了後すぐに使える
    STRAT_LOCK_SEC_BY_ID.set(card.id, 5);
    try {
      g.morale[0] = 15;
      afterEffect(g);
      expect(cmdStrat(g, 0, 0)).toBeNull();
      afterEffect(g);
      g.morale[0] = 15;
      expect(cmdStrat(g, 0, 0)).not.toBeNull(); // 効果終了直後は待ち時間中
      const v = snapshotFor(g, 0).units.find((x) => x.p === 0 && x.slot === 0)!;
      expect(v.stratLock).toBeGreaterThan(4);
      g.t = unitOf(g, 0, 0)!.stratReady + 0.01;
      expect(cmdStrat(g, 0, 0)).toBeNull();
    } finally {
      STRAT_LOCK_SEC_BY_ID.delete(card.id);
    }
  });

  test("効果時間が「撤退するまで」の計略は、撤退するまで2回目が使えず、復活後は使える", () => {
    const card = pick((c) => !c.strat.categories.includes("短計") && c.strat.time === "撤退するまで" && !STRAT_USE_LIMIT_BY_ID.has(c.id) && c.cost <= 2 && c.strat.mp <= 6);
    const g = createGame(mk([card.id]), mk([ofType("槍兵").id]));
    g.morale[0] = 15;
    expect(cmdStrat(g, 0, 0)).toBeNull();
    run(g, 60);
    g.morale[0] = 15;
    expect(cmdStrat(g, 0, 0)).not.toBeNull();
    const u = unitOf(g, 0, 0)!;
    u.mode = "field";
    retire(g, u);
    u.respawn = 0.01;
    run(g, 1);
    g.morale[0] = 15;
    expect(cmdStrat(g, 0, 0)).toBeNull();
  });

  test("「撤退するまで」の全体強化は、使用者が撤退すると味方の効果も消え、再使用待ち時間が始まる", () => {
    const card = pick((c) => c.strat.categories.includes("全体強化") && c.strat.time === "撤退するまで" && !STRAT_USE_LIMIT_BY_ID.has(c.id) && c.cost <= 2 && c.strat.mp <= 6);
    const mate = ofType("槍兵");
    const g = createGame(mk([card.id, mate.id]), mk([ofType("槍兵").id]));
    const caster = unitOf(g, 0, 0)!;
    const ally = unitOf(g, 0, 1)!;
    STRAT_LOCK_SEC_BY_ID.set(card.id, 7);
    try {
      g.morale[0] = 15;
      expect(cmdStrat(g, 0, 0)).toBeNull();
      expect(ally.buffs.length).toBeGreaterThan(0);
      caster.mode = "field";
      retire(g, caster);
      expect(ally.buffs.length).toBe(0);
      expect(snapshotFor(g, 0).units.find((x) => x.p === 0 && x.slot === 0)!.stratActive).toBe(false);
      expect(caster.stratReady).toBeCloseTo(g.t + 7, 5);
    } finally {
      STRAT_LOCK_SEC_BY_ID.delete(card.id);
    }
  });

  test("短計は25秒のクールダウンで、効果中でも使える", () => {
    const card = pick((c) => c.strat.categories.includes("短計") && c.cost === 1 && c.strat.mp <= 2);
    const g = createGame(mk([card.id]), mk([ofType("槍兵").id]));
    g.morale[0] = 15;
    expect(cmdStrat(g, 0, 0)).toBeNull();
    expect(cmdStrat(g, 0, 0)).not.toBeNull();
    run(g, C.STRAT_SHORT_CD + 1);
    g.morale[0] = 15;
    expect(cmdStrat(g, 0, 0)).toBeNull();
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
    g.morale[0] = g.maxMorale[0] - 0.5;
    run(g, 20);
    expect(g.morale[0]).toBe(g.maxMorale[0]);
  });

  test("士気は4.2カウント(約10.1秒)で1溜まる", () => {
    const g = createGame(mk([ofType("槍兵").id]), mk([ofType("槍兵").id]));
    g.morale[0] = 0;
    run(g, 4.2 * C.COUNT_SEC);
    expect(g.morale[0]).toBeCloseTo(1, 1);
  });

  test("特技「同盟」でも最大士気は15を超えない", () => {
    const allies = CARDS.filter((c) => c.skills.includes("盟")).sort((a, b) => b.cost - a.cost);
    const ids: string[] = [];
    const names = new Set<string>();
    let cost = 0;
    for (const c of allies) {
      if (names.has(c.name) || cost + c.cost > C.DECK_MAX_COST) continue;
      names.add(c.name);
      ids.push(c.id);
      cost += c.cost;
    }
    expect(mk(ids).maxMorale).toBeLessThanOrEqual(C.MAX_MORALE_CAP);
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
    b.ty = 900; // 騎兵に向かってゆっくり進みながら槍を出す
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

  test("騎兵は加速して徐々に速くなり、突撃発動速度に達して突撃可能になる(イシュー#1)", () => {
    const cav = pick((c) => c.unit === "騎兵" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([cav.id]), mk([ofType("槍兵").id]));
    const a = unitOf(g, 0, 0)!;
    cmdMove(g, 0, 0, 300, 100);
    const speeds: number[] = [];
    let chargeAt = -1;
    let velAtCharge = 0;
    for (let i = 0; i < 20 * 20; i++) {
      tick(g);
      speeds.push(a.lastSpeed);
      if (a.charging && chargeAt < 0) {
        chargeAt = i;
        velAtCharge = a.vel;
      }
    }
    // 開始直後は最高速でなく、その後に速くなる
    expect(speeds[2]!).toBeLessThan(C.BASE_SPEED["騎兵"] * 0.5);
    expect(speeds[40]!).toBeGreaterThan(speeds[2]!);
    // 加速時間が必要なので、移動開始直後には突撃可能にならない
    expect(chargeAt).toBeGreaterThan(20 * 2);
    expect(velAtCharge).toBeGreaterThanOrEqual(C.BASE_SPEED["騎兵"] * C.CHARGE_TRIGGER_RATIO);
  });

  test("騎兵は止まると速度を失い、突撃可能状態が解除される", () => {
    const cav = pick((c) => c.unit === "騎兵" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([cav.id]), mk([ofType("槍兵").id]));
    const a = unitOf(g, 0, 0)!;
    cmdMove(g, 0, 0, 300, 100);
    run(g, 8);
    expect(a.charging).toBe(true);
    cmdMove(g, 0, 0, a.x, a.y);
    run(g, 1);
    expect(a.vel).toBe(0);
    expect(a.charging).toBe(false);
  });

  test("槍撃は移動方向の前方の角度内だけに当たる", () => {
    const pike = pick((c) => c.unit === "槍兵" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([pike.id]), mk([ofType("弓兵").id, ofType("弓兵").id].slice(0, 1)));
    const a = unitOf(g, 0, 0)!;
    const e = unitOf(g, 1, 0)!;
    a.mode = "field";
    a.x = 300;
    a.y = 500;
    a.tx = a.x;
    a.ty = a.y - 200; // 上へ進みながら槍を出す
    a.fx = 0;
    a.fy = -1; // 上向きに槍
    e.mode = "field";
    e.tx = e.x = 300 + 50; // 真横
    e.ty = e.y = 500;
    e.hp = e.maxHp;
    e.hidden = false;
    e.ambush = false;
    tick(g);
    expect(e.hp).toBe(e.maxHp); // 横は当たらない
    e.tx = e.x = 300;
    e.ty = e.y = 500 - 50; // 前方
    tick(g);
    expect(e.hp).toBeLessThan(e.maxHp);
  });

  test("槍撃が騎兵に当たると、槍兵と同等の速度まで落ちる", () => {
    const cav = pick((c) => c.unit === "騎兵" && c.cost === 1 && c.skills.length === 0);
    const pike = pick((c) => c.unit === "槍兵" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([pike.id]), mk([cav.id]));
    const a = unitOf(g, 0, 0)!;
    const e = unitOf(g, 1, 0)!;
    a.mode = "field";
    a.x = 300;
    a.y = 500;
    a.tx = a.x;
    a.ty = a.y;
    a.fx = 0;
    a.fy = -1;
    e.mode = "field";
    e.x = 300;
    e.y = 450;
    e.tx = 300;
    e.ty = 480; // 槍兵へ向かって走る(向かい合うが、速度は突撃発動速度未満なので迎撃にならない)
    e.vel = C.BASE_SPEED["騎兵"] * 0.6;
    e.fx = 0;
    e.fy = 1;
    e.hidden = false;
    e.ambush = false;
    tick(g);
    expect(e.vel).toBeLessThanOrEqual(C.BASE_SPEED["槍兵"]);
    expect(e.charging).toBe(false);
  });

  test("迎撃は騎兵以外でも、突撃発動速度以上で向かい合って接近すれば成立する", () => {
    const pike = pick((c) => c.unit === "槍兵" && c.cost === 1 && c.skills.length === 0);
    const sword = pick((c) => c.unit === "剣豪" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([pike.id]), mk([sword.id]));
    const a = unitOf(g, 0, 0)!;
    const e = unitOf(g, 1, 0)!;
    a.mode = "field";
    a.x = 300;
    a.y = 500;
    a.tx = a.x;
    a.ty = a.y - 200; // 上へ進みながら槍を出す
    a.fx = 0;
    a.fy = -1;
    e.mode = "field";
    e.x = 300;
    e.y = 300;
    e.tx = 300;
    e.ty = 520; // 槍兵に向かって走る(剣豪の基本速度45は突撃発動速度44.2以上)
    e.hidden = false;
    e.ambush = false;
    let intercepted = false;
    for (let i = 0; i < 20 * 15 && !intercepted; i++) {
      tick(g);
      if (g.fx.some((f) => f.k === "intercept")) intercepted = true;
    }
    expect(intercepted).toBe(true);
  });

  const bowSetup = () => {
    const bow = pick((c) => c.unit === "弓兵" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([bow.id]), mk([ofType("槍兵").id]));
    const a = unitOf(g, 0, 0)!;
    const e = unitOf(g, 1, 0)!;
    a.mode = "field";
    a.x = a.tx = 300;
    a.y = a.ty = 600;
    a.fx = 0;
    a.fy = -1; // 上向き
    e.mode = "field";
    e.hp = e.maxHp;
    e.hidden = false;
    e.ambush = false;
    e.x = e.tx = 300;
    e.y = e.ty = 450; // 前方150(射程内)
    return { g, a, e };
  };

  test("弓兵は移動方向の前方・射程内の敵だけを撃つ", () => {
    const { g, a, e } = bowSetup();
    tick(g);
    expect(e.hp).toBeLessThan(e.maxHp);
    e.hp = e.maxHp;
    e.x = e.tx = 300;
    e.y = e.ty = 750; // 真後ろ
    a.cdBow = 0;
    tick(g);
    expect(e.hp).toBe(e.maxHp);
    e.x = e.tx = 300;
    e.y = e.ty = 600 - C.BOW_RANGE - 50; // 射程外
    a.cdBow = 0;
    tick(g);
    expect(e.hp).toBe(e.maxHp);
  });

  test("弓兵は停止中に走射ゲージが貯まり、満タンで動き出すと走射する", () => {
    const { g, a, e } = bowSetup();
    e.maxHp = e.hp = 10000;
    run(g, C.BOW_SWEEP_FILL_T + 0.5);
    expect(a.stillT).toBeGreaterThanOrEqual(C.BOW_SWEEP_FILL_T);
    const before = e.hp;
    a.tx = 300;
    a.ty = 560; // 移動を開始(敵は前方のまま)
    a.cdBow = 99; // 通常攻撃を止めて、走射だけを見る
    run(g, 0.3);
    expect(before - e.hp).toBeGreaterThan(0); // 走射の追加ダメージ
    expect(a.stillT).toBe(0); // 走射後はゲージが空になる
  });

  test("弓兵の走射ゲージは、移動しても保持される(満タン前)", () => {
    const { g, a, e } = bowSetup();
    e.maxHp = e.hp = 10000;
    e.y = e.ty = 100; // 射程外にして、走射が起きないようにする
    run(g, 1.5);
    const gauge = a.stillT;
    expect(gauge).toBeGreaterThan(1);
    a.tx = 200;
    a.ty = 600;
    run(g, 1);
    expect(a.stillT).toBe(gauge);
  });

  test("剣豪の斬撃ゲージは時間で貯まり、満タンのときだけ斬撃できる。斬撃後は空に戻る", () => {
    const sword = pick((c) => c.unit === "剣豪" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([sword.id]), mk([ofType("槍兵").id]));
    const a = unitOf(g, 0, 0)!;
    const e = unitOf(g, 1, 0)!;
    a.mode = "field";
    a.x = a.tx = 300;
    a.y = a.ty = 500;
    e.mode = "field";
    e.hp = e.maxHp;
    e.hidden = false;
    e.ambush = false;
    e.x = e.tx = 300 + 60;
    e.y = e.ty = 500; // 範囲内
    expect(snapshotFor(g, 0).units.find((u) => u.p === 0)!.gauge).toBe(0);
    expect(cmdAction(g, 0, 0)).toBe("斬撃ゲージが溜まっていません");
    run(g, C.SLASH_CD / 2);
    const half = snapshotFor(g, 0).units.find((u) => u.p === 0)!.gauge!;
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
    expect(cmdAction(g, 0, 0)).not.toBeNull(); // まだ満タンではない
    run(g, C.SLASH_CD / 2 + 0.2);
    const hp = e.hp;
    expect(cmdAction(g, 0, 0)).toBeNull(); // 満タンで成立
    expect(e.hp).toBeLessThan(hp);
    expect(snapshotFor(g, 0).units.find((u) => u.p === 0)!.gauge).toBe(0); // リセット
  });

  test("斬撃は範囲内の敵すべてに当たり、範囲外には当たらない", () => {
    const sword = pick((c) => c.unit === "剣豪" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([sword.id]), mk([ofType("槍兵").id, ofType("槍兵").id].slice(0, 1)));
    const a = unitOf(g, 0, 0)!;
    const e = unitOf(g, 1, 0)!;
    a.mode = "field";
    a.x = a.tx = 300;
    a.y = a.ty = 500;
    a.cdAction = 0;
    e.mode = "field";
    e.hp = e.maxHp;
    e.hidden = false;
    e.ambush = false;
    e.x = e.tx = 300 + C.SLASH_RANGE + 40; // 範囲外
    e.y = e.ty = 500;
    expect(cmdAction(g, 0, 0)).toBeNull(); // 周りに敵がいなくても斬撃できる(空振り)
    expect(e.hp).toBe(e.maxHp);
    expect(snapshotFor(g, 0).units.find((u) => u.p === 0)!.gauge).toBe(0); // ゲージは消費する
  });

  const pikeOf = (g: Game) => snapshotFor(g, 0).units.find((u) => u.p === 0)!.pike;

  test("槍兵は移動している間は槍撃が常に発動し(クールダウンなし)、止まると槍が消える", () => {
    const pike = pick((c) => c.unit === "槍兵" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([pike.id]), mk([ofType("弓兵").id]));
    const a = unitOf(g, 0, 0)!;
    a.mode = "field";
    a.x = a.tx = 300;
    a.y = a.ty = 700;
    run(g, 0.2);
    expect(pikeOf(g)).toBe(0); // 止まっている間は槍が出ない
    a.ty = 300; // 移動開始
    for (let i = 0; i < 20 * 8; i++) {
      tick(g);
      expect(pikeOf(g)).toBeGreaterThan(0); // 移動中は常に出ている
    }
    expect(cmdAction(g, 0, 0)).toBe("このカードには固有アクションがありません"); // 手動の槍撃はない
    a.tx = a.x;
    a.ty = a.y; // 止まる
    run(g, 0.2);
    expect(pikeOf(g)).toBe(0);
  });

  test("槍撃は乱戦中・攻城中・伏兵中には自動発動しない", () => {
    const pike = pick((c) => c.unit === "槍兵" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([pike.id]), mk([ofType("弓兵").id]));
    const a = unitOf(g, 0, 0)!;
    a.mode = "field";
    a.x = a.tx = 300;
    a.y = 700;
    a.ty = 300;
    a.cdAction = 0;
    a.ambush = true;
    tick(g);
    expect(pikeOf(g)).toBe(0); // 伏兵中
    a.ambush = false;
    const e = unitOf(g, 1, 0)!;
    e.mode = "field";
    e.hidden = false;
    e.ambush = false;
    e.x = e.tx = 300;
    e.y = e.ty = 690; // 接触(乱戦)
    tick(g);
    expect(a.melee).toBe(true);
    expect(pikeOf(g)).toBe(0); // 乱戦中は槍が出ていない
  });

  test("槍は移動中だけ出ていて、止まっていると当たらない・迎撃しない", () => {
    const pike = pick((c) => c.unit === "槍兵" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([pike.id]), mk([ofType("弓兵").id]));
    const a = unitOf(g, 0, 0)!;
    const e = unitOf(g, 1, 0)!;
    a.mode = "field";
    a.x = a.tx = 300;
    a.y = a.ty = 500; // 止まっている
    a.fx = 0;
    a.fy = -1;
    e.mode = "field";
    e.tx = e.x = 300;
    e.ty = e.y = 500 - 60; // 前方の槍の範囲内(接触はしない距離)
    e.hp = e.maxHp;
    e.hidden = false;
    e.ambush = false;
    tick(g);
    expect(pikeOf(g)).toBe(0);
    expect(e.hp).toBe(e.maxHp);
    a.ty = 100; // 移動開始
    tick(g);
    expect(pikeOf(g)).toBeGreaterThan(0);
    expect(e.hp).toBeLessThan(e.maxHp);
  });

  test("槍撃は攻城中(城壁に到達)には自動発動せず、槍も出ない", () => {
    const pike = pick((c) => c.unit === "槍兵" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([pike.id]), mk([ofType("弓兵").id]));
    const a = unitOf(g, 0, 0)!;
    a.mode = "field";
    a.x = a.tx = 100;
    a.y = C.CASTLE_ZONE_H + C.SIEGE_REACH - 1; // 城壁に到達済み
    a.ty = C.CASTLE_ZONE_H + C.UNIT_RADIUS; // 城壁へ向かう
    a.cdAction = 0;
    let sawSiege = false;
    for (let i = 0; i < 60; i++) {
      tick(g);
      if (a.sieging) sawSiege = true;
      expect(pikeOf(g)).toBe(0);
    }
    expect(sawSiege).toBe(true);
    expect(snapshotFor(g, 0).units.find((u) => u.p === 0)!.pike).toBe(0);
  });

  const gunSetup = () => {
    const gun = pick((c) => c.unit === "鉄砲隊" && c.cost === 1 && c.skills.length === 0);
    const g = createGame(mk([gun.id]), mk([ofType("槍兵").id, ofType("槍兵").id].slice(0, 1)));
    const a = unitOf(g, 0, 0)!;
    const b = unitOf(g, 1, 0)!;
    a.mode = b.mode = "field";
    a.x = a.tx = 300;
    a.y = a.ty = 600;
    a.fx = 0;
    a.fy = -1; // 上向き(移動方向)
    b.hp = b.maxHp;
    b.hidden = false;
    b.ambush = false;
    b.x = b.tx = 300;
    b.y = b.ty = 450; // 前方150
    return { g, a, b };
  };

  test("鉄砲隊は移動方向の最も近い敵を捕捉し、ターゲットラインで示す", () => {
    const { g, a, b } = gunSetup();
    tick(g);
    expect(a.lockTarget).toBe(b.id);
    expect(snapshotFor(g, 0).units.find((u) => u.p === 0)!.lock).toBe(b.slot);
    expect(snapshotFor(g, 1).units.find((u) => u.p === 1)!.lock).toBeUndefined(); // 相手には送らない
    // 真後ろに移動すると、前方の敵は捕捉から外れる
    a.fy = 1;
    tick(g);
    expect(a.lockTarget).toBe(-1);
  });

  test("鉄砲隊の射撃は捕捉している敵にだけ当たり、チャージが終わるまで撃てない", () => {
    const { g, a, b } = gunSetup();
    tick(g);
    expect(cmdAction(g, 0, 0)).toBeNull();
    expect(b.hp).toBeLessThan(b.maxHp);
    expect(snapshotFor(g, 0).units.find((u) => u.p === 0)!.gauge).toBe(0); // 撃った直後はチャージが空
    expect(cmdAction(g, 0, 0)).toBe("チャージ中です");
    run(g, C.GUN_CD / 2);
    const half = snapshotFor(g, 0).units.find((u) => u.p === 0)!.gauge!;
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
    b.hp = b.maxHp;
    run(g, C.GUN_CD / 2 + 0.2);
    expect(cmdAction(g, 0, 0)).toBeNull(); // チャージ完了で再び撃てる
    expect(b.hp).toBeLessThan(b.maxHp);
  });

  test("鉄砲隊は捕捉していないと撃てず、射線上の別の敵には当たらない", () => {
    const gun = pick((c) => c.unit === "鉄砲隊" && c.cost === 1 && c.skills.length === 0);
    const p1 = pick((c) => c.unit === "槍兵" && c.cost === 1 && c.skills.length === 0);
    const p2 = pick((c) => c.unit === "槍兵" && c.cost === 1 && c.skills.length === 0 && c.id !== p1.id);
    const g = createGame(mk([gun.id]), mk([p1.id, p2.id]));
    const a = unitOf(g, 0, 0)!;
    const near = unitOf(g, 1, 0)!;
    const far = unitOf(g, 1, 1)!;
    a.mode = near.mode = far.mode = "field";
    a.x = a.tx = 300;
    a.y = a.ty = 700;
    a.fx = 0;
    a.fy = -1;
    for (const e of [near, far]) {
      e.hp = e.maxHp;
      e.hidden = false;
      e.ambush = false;
      e.x = e.tx = 300;
    }
    near.y = near.ty = 560; // 近い敵
    far.y = far.ty = 450; // 射線上のさらに奥(射程内)
    expect(cmdAction(g, 0, 0)).toBe("捕捉している対象がいません");
    tick(g);
    expect(a.lockTarget).toBe(near.id);
    expect(cmdAction(g, 0, 0)).toBeNull();
    expect(near.hp).toBeLessThan(near.maxHp);
    expect(far.hp).toBe(far.maxHp);
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


describe("COM(ひとりで練習)", () => {
  const comInfo = (seed: number) => {
    const d = makeComDeck(makeRng(seed));
    const v = validateDeck(d.ids, C.COM_DECK_MAX_COST);
    if (!v.ok) throw new Error(v.error);
    return { ...d, info: v.info };
  };
  /** COM(1つ以上)を動かしながら、sec 秒進める */
  const runWith = (g: Game, coms: ComPlayer[], sec: number) => {
    for (let i = 0; i < sec * C.TICK_RATE && !g.over; i++) {
      for (const c of coms) c.update(g);
      tick(g);
    }
  };

  test("COMのデッキは、シードを変えても条件を満たす", () => {
    let relaxedCount = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const { ids, relaxed, info } = comInfo(seed);
      const cards = ids.map((id) => CARDS.find((c) => c.id === id)!);
      const cost = cards.reduce((a, c) => a + c.cost, 0);
      expect(cost).toBeGreaterThanOrEqual(9.5);
      expect(cost).toBeLessThanOrEqual(C.COM_DECK_MAX_COST);
      expect(ids.length).toBeGreaterThanOrEqual(4);
      expect(ids.length).toBeLessThanOrEqual(8);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(cards.map((c) => c.name)).size).toBe(ids.length);
      expect(info.cards.length).toBe(ids.length);
      if (relaxed) relaxedCount++;
      else {
        expect(cards.some((c) => c.unit === "槍兵")).toBe(true);
        expect(cards.some((c) => c.unit === "騎兵")).toBe(true);
        expect(cards.some((c) => c.unit === "弓兵" || c.unit === "鉄砲隊")).toBe(true);
        expect(info.colors).toBeLessThanOrEqual(2);
      }
    }
    expect(relaxedCount).toBeLessThan(10);
  });

  test("同じシードなら、同じデッキになる", () => {
    expect(makeComDeck(makeRng(7)).ids).toEqual(makeComDeck(makeRng(7)).ids);
  });

  test("人間のデッキの総コストの上限は9のまま(COMの上限は10)", () => {
    expect(C.DECK_MAX_COST).toBe(9);
    const ids = [...CARDS.filter((c) => c.cost === 2.5)].slice(0, 4).map((c) => c.id); // 10
    expect(validateDeck(ids).ok).toBe(false);
    expect(validateDeck(ids, C.COM_DECK_MAX_COST).ok).toBe(true);
  });

  test("COMは出城して攻城し、動かない相手の城ゲージを減らす", () => {
    const human = mk([ofType("槍兵").id, ofType("弓兵").id]);
    const com = comInfo(3).info;
    const g = createGame(human, com);
    const c = new ComPlayer(1, makeRng(11));
    runWith(g, [c], 120);
    expect(g.units.some((u) => u.p === 1 && u.mode === "field")).toBe(true);
    expect(g.castle[0]).toBeLessThan(C.CASTLE_HP);
  });

  test("COMどうしの試合は、最後までエラーなく進み、勝敗が決まる", () => {
    for (const seed of [1, 2, 3]) {
      const g = createGame(comInfo(seed * 2).info, comInfo(seed * 2 + 1).info);
      runWith(g, [new ComPlayer(0, makeRng(seed)), new ComPlayer(1, makeRng(seed + 100))], C.GAME_SEC + 5);
      expect(g.over).not.toBeNull();
    }
  });

  test("COMは、見えない敵(伏兵・敵城内)を狙わない", () => {
    const hiddenCard = pick((c) => c.skills.includes("伏") && c.unit === "槍兵" && c.cost === 1);
    const seen = ofType("槍兵", 1, 3);
    const g = createGame(mk([hiddenCard.id, seen.id]), comInfo(5).info);
    const c = new ComPlayer(1, makeRng(21));
    const hidden = unitOf(g, 0, 0)!;
    const visible = unitOf(g, 0, 1)!;
    // 伏兵を戦場の中央(COMのすぐ近く)に隠して置き、もう1部隊は見える位置に置く
    hidden.mode = "field";
    hidden.ambush = true;
    hidden.hidden = true;
    hidden.x = C.FIELD_W / 2;
    hidden.y = 300;
    hidden.tx = hidden.x;
    hidden.ty = hidden.y;
    visible.mode = "field";
    visible.x = 80;
    visible.y = 520;
    visible.tx = visible.x;
    visible.ty = visible.y;
    let ticks = 0;
    for (; ticks < 20 * 30 && !g.over; ticks++) {
      hidden.hidden = true; // 伏兵のまま動かない
      hidden.x = C.FIELD_W / 2;
      hidden.y = 300;
      if (snapshotFor(g, 1).units.some((u) => u.p === 0 && u.slot === 0)) break; // 接触で見えるようになったら、そこまで
      c.update(g);
      tick(g);
    }
    expect(ticks).toBeGreaterThan(100); // 見えない間、COMはしばらく動いていた
    expect(c.targeted.has("0:0")).toBe(false);
    expect(c.targeted.has("0:1")).toBe(true);
  });
});
