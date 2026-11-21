// 「ひとりで練習」のCOM(コンピューター)。デッキ作成と、戦況判断による操作。
//
// - プラットフォーム非依存(Bun版サーバーと Cloudflare Worker の両方から使う)。Bun / node の API は使わない
// - 乱数は注入する(Math.random は使わない)。時刻はスナップショットの t を使う
// - COMは人間と同じ操作(cmdMove / cmdStrat / cmdAction)だけでゲームを動かす
// - COMが見られる情報は、人間と同じ snapshotFor(game, p) の内容だけ(隠れている敵・敵城内の敵は見えない)
import { CARD_BY_ID, CARDS } from "./cards.ts";
import * as C from "./constants.ts";
import { cmdAction, cmdMove, cmdStrat, siegeBaseDamage, snapshotFor, type Game } from "./game.ts";
import type { Card, PlayerIdx, Snapshot, UnitType, UnitView } from "./types.ts";

export type Rng = () => number;

/** シード付きの乱数(mulberry32)。同じシードなら同じ列になる */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- デッキ作成 ----------

const SHOOTERS: UnitType[] = ["弓兵", "鉄砲隊"];
const COM_MIN_CARDS = 4;
const COM_MAX_CARDS = C.DECK_MAX_CARDS;
const COM_MIN_COST = C.COM_DECK_MAX_COST - 0.5;
/** 1枚のコストの上限。これにより、総コスト9.5〜10で最低4枚になる */
const COM_CARD_MAX_COST = 3;

const colorsOf = (): string[] => [...new Set(CARDS.map((c) => c.color))];

function pickWeighted<T>(list: T[], weight: (t: T) => number, rand: Rng): T {
  let sum = 0;
  for (const t of list) sum += weight(t);
  let r = rand() * sum;
  for (const t of list) {
    r -= weight(t);
    if (r <= 0) return t;
  }
  return list[list.length - 1]!;
}

/** 武力+知力が高いカードを、少し選ばれやすくする */
const cardWeight = (c: Card) => 1 + (c.strong + c.intel) / 12;

function shuffle<T>(list: T[], rand: Rng): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** pool から、条件(兵種の目安)を満たしつつ総コスト9.5〜10・4〜8枚になるように選ぶ。できなければ null */
function buildDeck(pool: Card[], needs: ((c: Card) => boolean)[], rand: Rng): string[] | null {
  const picked: Card[] = [];
  const names = new Set<string>();
  let total = 0;
  const add = (c: Card) => {
    picked.push(c);
    names.add(c.name);
    total += c.cost;
  };
  for (const need of shuffle(needs, rand)) {
    const cand = pool.filter((c) => need(c) && !names.has(c.name) && total + c.cost <= C.COM_DECK_MAX_COST);
    if (cand.length === 0) return null;
    add(pickWeighted(cand, cardWeight, rand));
  }
  while (total < COM_MIN_COST) {
    const cand = pool.filter((c) => !names.has(c.name) && total + c.cost <= C.COM_DECK_MAX_COST);
    if (cand.length === 0 || picked.length >= COM_MAX_CARDS) return null;
    add(pickWeighted(cand, cardWeight, rand));
  }
  if (picked.length < COM_MIN_CARDS || picked.length > COM_MAX_CARDS) return null;
  return picked.map((c) => c.id);
}

/**
 * COMのデッキ(総コスト9.5〜10・4〜8枚)をランダムに作る。
 * 勢力は1色(60%)か2色(40%)。槍兵・騎兵・射撃系(弓兵か鉄砲隊)を1枚以上入れる。
 * 条件を満たせなかったときは、兵種の条件をゆるめて作る(relaxed = true)。
 */
export function makeComDeck(rand: Rng): { ids: string[]; relaxed: boolean } {
  const colors = colorsOf();
  const needs = [(c: Card) => c.unit === "槍兵", (c: Card) => c.unit === "騎兵", (c: Card) => SHOOTERS.includes(c.unit)];
  const poolOf = (cs: string[]) => CARDS.filter((c) => cs.includes(c.color) && c.cost <= COM_CARD_MAX_COST);
  const chooseColors = () => shuffle(colors, rand).slice(0, rand() < 0.6 ? 1 : 2);
  for (let i = 0; i < 80; i++) {
    const ids = buildDeck(poolOf(chooseColors()), needs, rand);
    if (ids) return { ids, relaxed: false };
  }
  for (let i = 0; i < 80; i++) {
    const ids = buildDeck(poolOf(chooseColors()), [], rand);
    if (ids) return { ids, relaxed: true };
  }
  // どの色でも作れる最終手段(通常は到達しない)
  for (let i = 0; i < 400; i++) {
    const ids = buildDeck(CARDS.filter((c) => c.cost <= COM_CARD_MAX_COST), [], rand);
    if (ids) return { ids, relaxed: true };
  }
  throw new Error("COMのデッキを作れませんでした");
}

// ---------- 思考 ----------

type Tactic = "open" | "attack" | "defend" | "push" | "hold";

/** COM側から見た座標(自城が y'≈0、敵城が y'≈FIELD_H)の部隊 */
interface L {
  v: UnitView;
  slot: number;
  unit: UnitType;
  card: Card;
  x: number;
  y: number; // 自城からの距離方向の座標 y'
  fx: number;
  fy: number;
  hp: number; // 兵力の割合
}

interface Ctx {
  s: Snapshot;
  mine: L[]; // 出城中の自軍
  foes: L[]; // 見えている出城中の敵
  tactic: Tactic;
  wall: Map<number, number>; // slot → 攻城位置の x
}

const WALL_Y = C.FIELD_H - C.CASTLE_ZONE_H - C.UNIT_RADIUS; // 敵城の城壁に接する位置(y')
const ENGAGE_R = 320; // この距離以内の敵とは戦う
const PUSH_ENGAGE_R = 70; // 押し切りでは、すぐ近くで道をふさぐ敵とだけ戦い、あとは攻城を目指す
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const clampX = (x: number) => Math.min(C.FIELD_W - 10, Math.max(10, x));
const keyOf = (v: { p: PlayerIdx; slot: number }) => `${v.p}:${v.slot}`;

interface Queued {
  at: number;
  run: (g: Game) => void;
}

export class ComPlayer {
  /** 狙った(目的地を決めるのに使った)敵の記録。見えない敵を狙っていないことのテストに使う */
  readonly targeted = new Set<string>();
  private tactic: Tactic = "open";
  private tacticSince = 0;
  private nextThink = 0;
  private queue: Queued[] = [];
  private recovering = new Set<number>();
  private rebound = new Map<number, number>(); // 騎兵: 突撃後に離れ直す期限
  private wiggle = new Map<number, number>(); // 槍兵: 動き続けるための往復の向き
  /** まだゲームに反映していない(遅れて実行する)指示 */
  private pendingMove = new Map<number, { x: number; y: number }>(); // slot → 目的地(COM側の座標)
  private pendingStrat = new Map<number, number>(); // slot → 消費する士気
  private pendingAction = new Set<number>();

  constructor(
    readonly p: PlayerIdx,
    private rand: Rng,
  ) {}

  /** ゲームの tick の直前に呼ぶ */
  update(g: Game) {
    let s = snapshotFor(g, this.p);
    if (s.over) return;
    // 遅れて実行する指示を反映してから判断する(反映後の状態を見る)
    if (this.runQueue(g, s.t)) s = snapshotFor(g, this.p);
    if (s.t < this.nextThink) return;
    this.nextThink = s.t + C.COM_THINK_SEC + (this.rand() * 2 - 1) * C.COM_THINK_JITTER;
    this.think(s);
  }

  // ---- 座標変換(COM側の座標 ⇄ 盤面) ----
  private flip = (y: number) => (this.p === 0 ? C.FIELD_H - y : y);
  private view(v: UnitView): L {
    const card = CARD_BY_ID.get(v.cardId)!;
    return { v, slot: v.slot, unit: card.unit as UnitType, card, x: v.x, y: this.flip(v.y), fx: v.fx, fy: this.p === 0 ? -v.fy : v.fy, hp: v.hp / v.maxHp };
  }

  /** 時刻が来た指示を実行する。1つでも実行したら true */
  private runQueue(g: Game, t: number): boolean {
    const due = this.queue.filter((q) => q.at <= t);
    if (due.length === 0) return false;
    this.queue = this.queue.filter((q) => q.at > t);
    for (const q of due) q.run(g);
    return true;
  }

  private later(s: Snapshot, run: (g: Game) => void) {
    this.queue.push({ at: s.t + C.COM_DELAY_MIN + this.rand() * (C.COM_DELAY_MAX - C.COM_DELAY_MIN), run });
  }

  private order(s: Snapshot, slot: number, x: number, y: number) {
    const jx = (this.rand() * 2 - 1) * C.COM_AIM_JITTER;
    const jy = (this.rand() * 2 - 1) * C.COM_AIM_JITTER;
    const wx = clampX(x + jx);
    const ly = Math.min(C.FIELD_H, Math.max(0, y + jy));
    const wy = this.flip(ly);
    this.pendingMove.set(slot, { x: wx, y: ly });
    this.later(s, (g) => {
      this.pendingMove.delete(slot);
      if (g.units.find((u) => u.p === this.p && u.slot === slot)?.mode === "dead") return; // 撤退した部隊には指示しない
      cmdMove(g, this.p, slot, wx, wy);
    });
  }

  private think(s: Snapshot) {
    const all = s.units.filter((u) => u.p === this.p).map((u) => this.view(u));
    const mine = all.filter((u) => u.v.mode === "field");
    const foes = s.units.filter((u) => u.p !== this.p && u.mode === "field").map((u) => this.view(u));
    this.pickTactic(s, mine, foes);
    const ctx: Ctx = { s, mine, foes, tactic: this.tactic, wall: this.wallSlots(mine) };

    // 部隊ごとの目的地
    const wants: { u: L; x: number; y: number; urgent: boolean }[] = [];
    for (const u of all) {
      if (u.v.mode === "dead") {
        this.recovering.delete(u.slot);
        continue;
      }
      const ratio = u.hp;
      if (!this.recovering.has(u.slot) && u.v.mode === "field" && ratio <= C.COM_RETREAT_HP && !u.v.melee && !u.v.sieging) this.recovering.add(u.slot);
      if (this.recovering.has(u.slot) && u.v.mode === "castle" && ratio >= C.COM_RETURN_HP) this.recovering.delete(u.slot);
      let dest: { x: number; y: number };
      let urgent = false;
      if (this.recovering.has(u.slot)) {
        dest = { x: u.x, y: C.CASTLE_ZONE_H * 0.3 };
        urgent = true;
      } else dest = this.plan(u, ctx);
      wants.push({ u, x: dest.x, y: dest.y, urgent: urgent || (this.tactic === "open" && u.v.mode === "castle") });
    }
    // 現在の目的地から離れているものだけ、最大2〜3部隊に指示する(開幕と撤退は全部隊)
    const cur = (u: L) => this.pendingMove.get(u.slot) ?? { x: u.v.tx ?? u.x, y: this.flip(u.v.ty ?? u.v.y) };
    const changed = wants.filter((w) => w.u.hp > 0 && dist(cur(w.u), w) > C.COM_MIN_RETARGET);
    const urgent = changed.filter((w) => w.urgent);
    const rest = shuffle(changed.filter((w) => !w.urgent), this.rand).slice(0, this.rand() < 0.5 ? 2 : 3);
    for (const w of [...urgent, ...rest]) this.order(s, w.u.slot, w.x, w.y);

    this.actions(s, ctx);
    this.strats(s, ctx);
  }

  // ---- 作戦 ----
  private pickTactic(s: Snapshot, mine: L[], foes: L[]) {
    const timeLeft = C.GAME_SEC - s.t;
    const myCastle = s.castle[this.p];
    const enCastle = s.castle[this.p === 0 ? 1 : 0];
    let next: Tactic;
    if (s.t < C.COM_OPEN_SEC) next = "open";
    else if (timeLeft <= C.COM_ENDGAME_SEC) next = myCastle > enCastle ? "hold" : "push";
    else if (foes.some((f) => f.v.sieging || f.y < C.CASTLE_ZONE_H + 120)) next = "defend";
    else {
      const power = (l: L[]) => l.reduce((a, u) => a + u.v.hp, 0);
      // 戦場の敵が少ない(撤退している)ときは攻城の好機
      next = foes.length <= 1 || power(mine) >= power(foes) * 0.9 ? "attack" : "defend";
    }
    const urgent = next === "open" || next === "push" || next === "hold" || this.tactic === "open";
    if (next !== this.tactic && (urgent || s.t - this.tacticSince >= C.COM_TACTIC_HOLD_SEC)) {
      this.tactic = next;
      this.tacticSince = s.t;
    }
  }

  /** 攻城ダメージが大きい部隊から城門に近い位置を割り当てる */
  private wallSlots(mine: L[]): Map<number, number> {
    const m = new Map<number, number>();
    const ranked = mine.slice().sort((a, b) => siegeBaseDamage(b.unit, b.card.cost, b.card.strong) - siegeBaseDamage(a.unit, a.card.cost, a.card.strong));
    const step = C.GATE_HALF_W * 2 + C.UNIT_RADIUS * 2 + 4;
    ranked.forEach((u, i) => {
      const k = Math.ceil(i / 2);
      m.set(u.slot, C.FIELD_W / 2 + (i === 0 ? 0 : i % 2 ? -k * step : k * step));
    });
    return m;
  }

  // ---- 部隊ごとの動き ----
  private plan(u: L, ctx: Ctx): { x: number; y: number } {
    const slotX = (u.slot + 1) * (C.FIELD_W / (ctx.mine.length + 2));
    const wall = { x: ctx.wall.get(u.slot) ?? C.FIELD_W / 2, y: WALL_Y };
    const formY: Record<UnitType, number> = { 槍兵: 330, 剣豪: 320, 騎兵: 280, 弓兵: 240, 鉄砲隊: 230 };
    switch (ctx.tactic) {
      case "open":
        return { x: clampX((u.slot + 1) * (C.FIELD_W / 9)), y: formY[u.unit] };
      case "push":
        return this.engageOr(u, ctx, wall, ctx.foes.filter((f) => dist(u, f) <= PUSH_ENGAGE_R));
      case "hold": {
        const near = ctx.foes.filter((f) => dist(u, f) <= 300);
        return this.engageOr(u, ctx, { x: clampX(slotX), y: SHOOTERS.includes(u.unit) ? 170 : 250 }, near);
      }
      case "defend": {
        const threats = ctx.foes.filter((f) => f.v.sieging || f.y < 450);
        return this.engageOr(u, ctx, { x: clampX(slotX), y: SHOOTERS.includes(u.unit) ? 190 : 260 }, threats.length ? threats : ctx.foes.filter((f) => dist(u, f) <= ENGAGE_R));
      }
      default:
        return this.engageOr(u, ctx, wall, ctx.foes.filter((f) => dist(u, f) <= ENGAGE_R));
    }
  }

  private engageOr(u: L, ctx: Ctx, fallback: { x: number; y: number }, foes: L[]) {
    if (foes.length === 0) return fallback;
    return this.engage(u, ctx, foes);
  }

  private pick(foes: L[], from: L, score: (f: L) => number): L {
    let best = foes[0]!;
    let bs = Infinity;
    for (const f of foes) {
      const sc = dist(from, f) - score(f);
      if (sc < bs) {
        bs = sc;
        best = f;
      }
    }
    this.targeted.add(keyOf(best.v));
    return best;
  }

  private engage(u: L, ctx: Ctx, foes: L[]): { x: number; y: number } {
    const away = (t: L, d: number) => {
      const dx = u.x - t.x;
      const dy = u.y - t.y;
      const n = Math.hypot(dx, dy) || 1;
      return { x: clampX(u.x + (dx / n) * d), y: Math.max(40, u.y + (dy / n) * d) };
    };
    const toward = (t: L, keep: number) => {
      const dx = t.x - u.x;
      const dy = t.y - u.y;
      const n = Math.hypot(dx, dy) || 1;
      return { x: clampX(t.x - (dx / n) * keep), y: Math.min(WALL_Y, t.y - (dy / n) * keep) };
    };
    switch (u.unit) {
      case "槍兵": {
        // 突撃可能状態の騎兵の方へ。動き続けて槍を出したままにする
        const t = this.pick(foes, u, (f) => (f.unit === "騎兵" ? (f.v.charging ? 220 : 90) : 0));
        const d = dist(u, t);
        if (d < 36) {
          const dir = ((this.wiggle.get(u.slot) ?? 1) * -1) as 1 | -1;
          this.wiggle.set(u.slot, dir);
          return { x: clampX(t.x + dir * 30), y: Math.min(WALL_Y, t.y + 40) };
        }
        return { x: t.x, y: t.y };
      }
      case "騎兵": {
        const until = this.rebound.get(u.slot) ?? 0;
        if (u.v.melee) this.rebound.set(u.slot, ctx.s.t + 2.5);
        if (until > ctx.s.t || u.v.melee) return { x: u.x, y: Math.max(60, u.y - 260) };
        const t = this.pick(foes, u, (f) => (SHOOTERS.includes(f.unit) || f.v.sieging ? 200 : 0));
        const d = dist(u, t);
        // 突撃可能状態の槍の正面には入らない: 槍の向きから外れた側から回り込む
        const dx = u.x - t.x;
        const dy = u.y - t.y;
        const n = Math.hypot(dx, dy) || 1;
        const inFront = t.v.pike > 0 && (t.fx * dx + t.fy * dy) / n > 0.75;
        if (d > 280 || inFront) {
          const side = t.x < C.FIELD_W / 2 ? 1 : -1;
          return { x: clampX(t.x + side * 200), y: Math.max(60, t.y - 220) };
        }
        return { x: t.x, y: t.y };
      }
      case "弓兵":
      case "鉄砲隊": {
        const range = u.unit === "弓兵" ? 230 : 300;
        const t = this.pick(foes, u, (f) => (f.v.sieging ? 150 : 0) + (1 - f.hp) * 60);
        const d = dist(u, t);
        if (d < range * 0.55) return away(t, range * 0.35);
        if (d > range * 0.92) return toward(t, range * 0.8);
        // 射程内: ほぼ止まる。弓は走射ゲージが満タンなら少し動いて走射、鉄砲は撃つ向きに少しだけ向く
        if (u.unit === "弓兵") return (u.v.gauge ?? 0) >= 1 ? toward(t, d - 40) : { x: u.x, y: u.y };
        return toward(t, d - 12);
      }
      case "剣豪": {
        // 敵が固まっている所へ。ゲージが貯まっていない間は射撃系を狙う
        const cluster = (f: L) => foes.filter((o) => dist(o, f) <= C.SLASH_RANGE).length;
        const gaugeFull = (u.v.gauge ?? 0) >= 1;
        const t = this.pick(foes, u, (f) => (gaugeFull ? cluster(f) * 90 : SHOOTERS.includes(f.unit) ? 160 : 0));
        return { x: t.x, y: t.y };
      }
    }
  }

  // ---- 兵種アクション ----
  private queueAction(s: Snapshot, slot: number) {
    if (this.pendingAction.has(slot)) return;
    this.pendingAction.add(slot);
    this.later(s, (g) => {
      this.pendingAction.delete(slot);
      cmdAction(g, this.p, slot);
    });
  }

  private actions(s: Snapshot, ctx: Ctx) {
    for (const u of ctx.mine) {
      if (u.v.melee || u.v.sieging) continue;
      if (u.unit === "剣豪" && (u.v.gauge ?? 0) >= 1) {
        const near = ctx.foes.filter((f) => dist(u, f) <= C.SLASH_RANGE);
        if (near.length >= 2 || near.some((f) => f.unit === "騎兵" && f.v.charging)) {
          for (const f of near) this.targeted.add(keyOf(f.v));
          this.queueAction(s, u.slot);
        }
      }
      if (u.unit === "鉄砲隊" && (u.v.actionCd ?? 1) <= 0) {
        const inRange = ctx.foes.filter((f) => dist(u, f) <= 300);
        if (inRange.length > 0) {
          for (const f of inRange) this.targeted.add(keyOf(f.v));
          this.queueAction(s, u.slot);
        }
      }
    }
  }

  // ---- 計略 ----
  private strats(s: Snapshot, ctx: Ctx) {
    // 指示済み(まだ反映されていない)計略の分の士気は、使えないものとして数える
    let queuedMp = 0;
    for (const mp of this.pendingStrat.values()) queuedMp += mp;
    const morale = s.morale - queuedMp;
    const ready = ctx.mine.filter((u) => {
      const st = u.card.strat;
      if (this.pendingStrat.has(u.slot)) return false;
      if (u.v.stratActive || (u.v.stratLock ?? 0) > 0 || u.v.stratLeft === 0) return false;
      if (st.categories.includes("短計") && (u.v.stratCd ?? 0) > 0) return false;
      return true;
    });
    if (ready.length === 0) return;
    // 大きな計略のために士気を貯める(最大士気に近いか、押し切りのときは使い切る)
    const big = Math.max(...ready.map((u) => u.card.strat.mp));
    const spend = morale >= s.maxMorale - 0.5 || ctx.tactic === "push";
    const relaxed = spend;
    for (const u of ready.slice().sort((a, b) => b.card.strat.mp - a.card.strat.mp)) {
      const mp = u.card.strat.mp;
      if (morale < mp) continue;
      if (!spend && mp < big && morale - mp < big) continue;
      if (!this.stratFits(u, ctx, relaxed)) continue;
      this.pendingStrat.set(u.slot, mp);
      this.later(s, (g) => {
        this.pendingStrat.delete(u.slot);
        cmdStrat(g, this.p, u.slot);
      });
      return; // 1回の判断で使う計略は1つ
    }
  }

  private stratFits(u: L, ctx: Ctx, relaxed: boolean): boolean {
    const cats = u.card.strat.categories;
    const within = (r: number) => ctx.foes.filter((f) => dist(u, f) <= r);
    const fighting = u.v.melee || u.v.sieging;
    let known = false;
    let ok = false;
    if (cats.includes("全体強化")) {
      known = true;
      ok ||= ctx.mine.length >= 3 && ctx.mine.some((a) => a.v.melee || a.v.sieging);
    }
    if (cats.includes("強化")) {
      known = true;
      ok ||= fighting;
    }
    if (cats.includes("妨害")) {
      known = true;
      ok ||= within(C.STRAT_DEBUFF_R).length >= 2;
    }
    if (cats.includes("ダメージ")) {
      known = true;
      const dmg = C.STRAT_DAMAGE_BASE + u.card.intel * C.STRAT_DAMAGE_PER_INTEL;
      ok ||= within(C.STRAT_DAMAGE_R).length >= 2 || within(C.STRAT_DAMAGE_R).some((f) => f.v.hp <= dmg);
    }
    if (cats.includes("回復")) {
      known = true;
      ok ||= ctx.mine.filter((a) => a.hp <= 0.5 && dist(u, a) <= 150).length >= 2;
    }
    if (!known) ok = fighting; // その他: 敵と戦っているとき
    if (!ok && relaxed) ok = fighting || within(C.STRAT_DEBUFF_R).length >= 1;
    return ok;
  }
}

