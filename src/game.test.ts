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
    a.ty = a.y;
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
    a.ty = a.y;
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

  test("弓兵は停止中に掃射ゲージが貯まり、満タンで動き出すと掃射する", () => {
    const { g, a, e } = bowSetup();
    e.maxHp = e.hp = 10000;
    run(g, C.BOW_SWEEP_FILL_T + 0.5);
    expect(a.stillT).toBeGreaterThanOrEqual(C.BOW_SWEEP_FILL_T);
    const before = e.hp;
    a.tx = 300;
    a.ty = 560; // 移動を開始(敵は前方のまま)
    a.cdBow = 99; // 通常攻撃を止めて、掃射だけを見る
    run(g, 0.3);
    expect(before - e.hp).toBeGreaterThan(0); // 掃射の追加ダメージ
    expect(a.stillT).toBe(0); // 掃射後はゲージが空になる
  });

  test("弓兵の掃射ゲージは、移動しても保持される(満タン前)", () => {
    const { g, a, e } = bowSetup();
    e.maxHp = e.hp = 10000;
    e.y = e.ty = 100; // 射程外にして、掃射が起きないようにする
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
    expect(cmdAction(g, 0, 0)).toBe("対象がいません");
    expect(e.hp).toBe(e.maxHp);
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
