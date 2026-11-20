// 純粋なシミュレーション。サーバーが権威として tick を回す。DOM/ネットワーク非依存。
import { CARD_BY_ID, STRAT_LOCK_SEC_BY_ID, STRAT_USE_LIMIT_BY_ID } from "./cards.ts";
import * as C from "./constants.ts";
import type {
  Card,
  FenceView,
  Fx,
  PlayerIdx,
  Snapshot,
  UnitMode,
  UnitType,
  UnitView,
} from "./types.ts";

// ---------- デッキ ----------

export interface DeckInfo {
  cards: Card[];
  colors: number;
  maxMorale: number;
  startMorale: number;
}

export function validateDeck(ids: unknown): { ok: true; info: DeckInfo } | { ok: false; error: string } {
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) return { ok: false, error: "デッキの形式が不正です" };
  if (ids.length < 1) return { ok: false, error: "武将を1枚以上選んでください" };
  if (ids.length > C.DECK_MAX_CARDS) return { ok: false, error: `デッキは${C.DECK_MAX_CARDS}枚以内です` };
  const cards: Card[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const id of ids as string[]) {
    const c = CARD_BY_ID.get(id);
    if (!c) return { ok: false, error: `存在しないカード: ${id}` };
    if (seenIds.has(id)) return { ok: false, error: `同じカードが重複しています: ${c.name}` };
    if (seenNames.has(c.name)) return { ok: false, error: `同名武将は入れられません: ${c.name}` };
    seenIds.add(id);
    seenNames.add(c.name);
    cards.push(c);
  }
  const cost = cards.reduce((s, c) => s + c.cost, 0);
  if (cost > C.DECK_MAX_COST) return { ok: false, error: `総コストが${C.DECK_MAX_COST}を超えています (${cost})` };
  const colors = new Set(cards.map((c) => c.color)).size;
  const baseMorale: number = C.MAX_MORALE_BY_COLORS[Math.min(colors, 4)]!;
  let maxMorale = baseMorale;
  for (const c of cards) if (c.skills.includes("盟")) maxMorale += Math.ceil(c.cost);
  maxMorale = Math.min(maxMorale, Math.max(baseMorale, C.MAX_MORALE_CAP));
  let startMorale = C.MORALE_START;
  for (const c of cards) if (c.skills.includes("昂")) startMorale += Math.ceil(c.cost);
  startMorale = Math.min(startMorale, maxMorale);
  return { ok: true, info: { cards, colors, maxMorale, startMorale } };
}

// ---------- 状態 ----------

interface Buff {
  dStrong: number;
  speedMul: number;
  until: number;
  /** 計略を使った武将の id(「撤退するまで」の計略は、その武将の撤退で味方・敵の効果も消える) */
  src?: number;
}

export interface Unit {
  id: number;
  p: PlayerIdx;
  slot: number;
  card: Card;
  x: number;
  y: number;
  tx: number;
  ty: number;
  fx: number;
  fy: number;
  hp: number;
  maxHp: number;
  mode: UnitMode;
  respawn: number;
  ambush: boolean;
  stealthT: number; // >0: 隠密になれない残り時間
  hidden: boolean;
  charging: boolean;
  stillT: number;
  melee: boolean;
  sieging: boolean;
  siege: number; // 攻城ゲージ(秒)
  cdAction: number;
  cdBow: number;
  cdIntercept: number;
  slowT: number;
  slowF: number;
  thrustHit: Set<number>;
  lockTarget: number; // unit id or -1
  lockT: number;
  buffs: Buff[];
  kiPool: number;
  kiT: number;
  /** 計略の効果が終わる時刻(g.t)。0なら効果中ではない */
  stratEnd: number;
  /** 次に計略を使える時刻(g.t。効果終了後の再使用待ち時間を含む) */
  stratReady: number;
  /** 試合中にあと何回使えるか(制限がなければ Infinity) */
  stratLeft: number;
  stratCd: number;
  lastSpeed: number;
  /** 騎兵の現在速度(加速で上昇する) */
  vel: number;
}

interface Fence {
  p: PlayerIdx;
  owner: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Game {
  t: number;
  decks: [DeckInfo, DeckInfo];
  units: Unit[];
  fences: Fence[];
  castle: [number, number];
  /** 城門を攻撃中の部隊id(添字は守る側)。1部隊のみ */
  gate: [number | null, number | null];
  morale: [number, number];
  maxMorale: [number, number];
  /** 送信待ちの演出。tick と操作(斬撃・計略など)が積み、スナップショットを送った後に空にする */
  fx: Fx[];
  over: null | { winner: PlayerIdx | null; reason: string };
}

export const slotHome = (p: PlayerIdx, slot: number, n: number) => ({
  x: (C.FIELD_W * (slot + 0.5)) / Math.max(n, 1),
  y: p === 0 ? C.FIELD_H - C.CASTLE_ZONE_H / 2 : C.CASTLE_ZONE_H / 2,
});

export const inCastleZone = (p: PlayerIdx, y: number) => (p === 0 ? y >= C.FIELD_H - C.CASTLE_ZONE_H : y <= C.CASTLE_ZONE_H);

export function createGame(deckA: DeckInfo, deckB: DeckInfo): Game {
  const decks: [DeckInfo, DeckInfo] = [deckA, deckB];
  const units: Unit[] = [];
  const fences: Fence[] = [];
  for (const p of [0, 1] as PlayerIdx[]) {
    const deck = decks[p];
    const n = deck.cards.length;
    deck.cards.forEach((card, slot) => {
      const home = slotHome(p, slot, n);
      const id = units.length;
      const heiSum = card.skills.includes("兵")
        ? deck.cards.filter((o) => o.skills.includes("兵") && o.period === card.period).reduce((s, o) => s + o.cost, 0)
        : 0;
      const maxHp = Math.round(C.HP_BASE * (1 + C.HEI_PER_COST * heiSum));
      const u: Unit = {
        id,
        p,
        slot,
        card,
        x: home.x,
        y: home.y,
        tx: home.x,
        ty: home.y,
        fx: 0,
        fy: p === 0 ? -1 : 1,
        hp: maxHp,
        maxHp,
        mode: "castle",
        respawn: 0,
        ambush: card.skills.includes("伏"),
        stealthT: 0,
        hidden: false,
        charging: false,
        stillT: 0,
        melee: false,
        sieging: false,
        siege: 0,
        cdAction: card.unit === "剣豪" ? C.SLASH_CD : 0, // 斬撃ゲージは空から貯める
        cdBow: 0,
        cdIntercept: 0,
        slowT: 0,
        slowF: 1,
        thrustHit: new Set(),
        lockTarget: -1,
        lockT: 0,
        buffs: [],
        kiPool: 0,
        kiT: 0,
        stratEnd: 0,
        stratReady: 0,
        stratLeft: STRAT_USE_LIMIT_BY_ID.get(card.id) ?? Infinity,
        stratCd: 0,
        lastSpeed: 0,
        vel: 0,
      };
      u.hidden = u.ambush;
      units.push(u);
      if (card.skills.includes("柵")) addFence(fences, u);
    });
  }
  return {
    t: 0,
    decks,
    units,
    fences,
    castle: [C.CASTLE_HP, C.CASTLE_HP],
    gate: [null, null],
    morale: [deckA.startMorale, deckB.startMorale],
    maxMorale: [deckA.maxMorale, deckB.maxMorale],
    fx: [],
    over: null,
  };
}

function addFence(fences: Fence[], u: Unit) {
  const dir = u.p === 0 ? -1 : 1;
  const home = u.y;
  fences.push({ p: u.p, owner: u.id, x: u.x - C.FENCE_W / 2, y: home + dir * C.FENCE_OFFSET - C.FENCE_H / 2, w: C.FENCE_W, h: C.FENCE_H });
}

// ---------- 補助 ----------

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const has = (u: Unit, s: string) => u.card.skills.includes(s);

function strongOf(g: Game, u: Unit) {
  let s = u.card.strong;
  if (has(u, "先") && g.t < C.SENJIN_T) s += C.SENJIN_BONUS;
  for (const b of u.buffs) s += b.dStrong;
  return Math.max(1, s);
}
function intelOf(g: Game, u: Unit) {
  let s = u.card.intel;
  if (has(u, "先") && g.t < C.SENJIN_T) s += C.SENJIN_BONUS;
  return Math.max(1, s);
}
function buffSpeed(u: Unit) {
  let m = 1;
  for (const b of u.buffs) m *= b.speedMul;
  return m;
}
// 槍撃は、槍兵が移動している間(乱戦・攻城・伏兵中を除く)、常に発動している。攻城の判定は後段なので、城壁への到達で判定する
function canThrust(u: Unit) {
  return u.card.unit === "槍兵" && u.mode === "field" && !u.melee && !u.sieging && !atWall(u) && !u.ambush;
}
// 槍が出ているのは、槍撃の発動中(=移動中)だけ
function pikeLen(u: Unit) {
  if (u.lastSpeed <= 0 || !canThrust(u)) return 0;
  let len = C.PIKE_LEN;
  if (has(u, "槍")) len += C.PIKE_LEN_PER_COST * u.card.cost;
  return len;
}
const enemyOf = (p: PlayerIdx): PlayerIdx => (p === 0 ? 1 : 0);

function emit(g: Game, fx: Fx) {
  g.fx.push(fx);
}

type DmgKind = "melee" | "action" | "arrow" | "strat" | "ambush";

function damage(g: Game, target: Unit, amount: number, kind: DmgKind) {
  if (target.mode === "dead" || amount <= 0) return;
  let a = amount;
  if (has(target, "鬼") && target.hp / target.maxHp < C.ONI_HP_RATIO && (kind === "action" || kind === "melee")) a *= C.ONI_DMG_MUL;
  if (target.charging && kind === "arrow") a *= C.CHARGED_ARROW_MUL;
  target.hp -= a;
  if (kind === "melee" || kind === "action") target.kiPool += a;
  // 忍/伏兵の解除条件
  if (kind === "strat") target.ambush = false;
  if (kind !== "arrow") target.stealthT = C.STEALTH_RECOVER_T;
  if (kind === "melee" || kind === "action" || kind === "strat") target.stealthT = C.STEALTH_RECOVER_T;
}

function fieldEnemies(g: Game, p: PlayerIdx, includeHidden = false) {
  return g.units.filter((u) => u.p !== p && u.mode === "field" && (includeHidden || !u.hidden));
}

function nearest(from: Unit, list: Unit[], maxDist: number): Unit | null {
  let best: Unit | null = null;
  let bd = maxDist;
  for (const u of list) {
    const d = dist(from, u);
    if (d <= bd) {
      bd = d;
      best = u;
    }
  }
  return best;
}

function knockback(from: Unit, target: Unit, amount: number) {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  target.x = clamp(target.x + (dx / d) * amount, 0, C.FIELD_W);
  target.y = clamp(target.y + (dy / d) * amount, 0, C.FIELD_H);
}

// ---------- コマンド ----------

export function unitOf(g: Game, p: PlayerIdx, slot: number): Unit | undefined {
  return g.units.find((u) => u.p === p && u.slot === slot);
}

export function cmdMove(g: Game, p: PlayerIdx, slot: number, x: number, y: number): string | null {
  if (g.over) return "試合は終了しています";
  const u = unitOf(g, p, slot);
  if (!u) return "武将がいません";
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "座標が不正です";
  if (u.mode === "dead") return "撤退中です";
  u.tx = clamp(x, 0, C.FIELD_W);
  // 敵城エリアには入れない
  u.ty = p === 0 ? clamp(y, C.CASTLE_ZONE_H + C.UNIT_RADIUS, C.FIELD_H) : clamp(y, 0, C.FIELD_H - C.CASTLE_ZONE_H - C.UNIT_RADIUS);
  return null;
}

export function cmdAction(g: Game, p: PlayerIdx, slot: number): string | null {
  if (g.over) return "試合は終了しています";
  const u = unitOf(g, p, slot);
  if (!u) return "武将がいません";
  if (u.card.unit !== "剣豪" && u.card.unit !== "鉄砲隊") return "このカードには固有アクションがありません";
  if (u.mode !== "field") return "出城していません";
  if (u.melee || u.sieging) return "乱戦・攻城中は行えません";
  if (u.ambush) return "伏兵中は行えません";
  if (u.cdAction > 0) return u.card.unit === "剣豪" ? "斬撃ゲージが溜まっていません" : u.card.unit === "鉄砲隊" ? "チャージ中です" : "クールダウン中です";
  switch (u.card.unit) {
    case "剣豪": {
      const hits = fieldEnemies(g, p, true).filter((e) => dist(u, e) <= C.SLASH_RANGE);
      u.cdAction = C.SLASH_CD;
      emit(g, { k: "slash", x: u.x, y: u.y, p });
      for (const e of hits) {
        damage(g, e, C.SLASH_DMG_BASE + strongOf(g, u) * C.SLASH_DMG_PER_STRONG, "action");
        knockback(u, e, C.SLASH_KNOCKBACK);
        if (e.charging) {
          e.charging = false;
          e.vel = 0;
          e.slowT = C.SLASH_SLOW_T;
          e.slowF = C.SLASH_SLOW_F;
        }
      }
      return null;
    }
    case "鉄砲隊": {
      // 捕捉している敵(ターゲットライン)に撃つ
      const t = u.lockTarget >= 0 ? g.units[u.lockTarget] : undefined;
      if (!t || t.mode !== "field" || t.hidden || t.p === p) return "捕捉している対象がいません";
      shoot(g, u, t);
      return null;
    }
    default:
      return "このカードには固有アクションがありません";
  }
}

function shoot(g: Game, u: Unit, t: Unit) {
  const snipe = has(u, "狙") && u.lockTarget === t.id && u.lockT >= C.SNIPE_LOCK_T;
  u.cdAction = C.GUN_CD;
  u.hidden = false;
  u.stealthT = C.STEALTH_RECOVER_T;
  emit(g, { k: "shot", x: u.x, y: u.y, x2: t.x, y2: t.y, p: u.p });
  const dmg = (C.GUN_DMG_BASE + strongOf(g, u) * C.GUN_DMG_PER_STRONG) * (snipe ? C.SNIPE_MUL : 1);
  damage(g, t, dmg * (t.charging ? C.CHARGED_ARROW_MUL : 1), "action");
  if (t.sieging) t.siege = Math.max(0, t.siege - C.GUN_BREAK);
  if (snipe) {
    knockback(u, t, C.SNIPE_KNOCKBACK);
    u.lockT = 0;
  }
}

function stratDuration(time: string, intel: number, short: boolean) {
  let d: number;
  switch (time) {
    case "一瞬":
      d = C.STRAT_INSTANT_DUR;
      break;
    case "固定時間":
      d = C.STRAT_FIXED_DUR;
      break;
    case "撤退するまで":
      d = 1e9;
      break;
    default:
      d = C.STRAT_DUR_BASE + intel * C.STRAT_DUR_PER_INTEL;
  }
  return short && d < 1e8 ? d * C.STRAT_SHORT_DUR_MUL : d;
}

export function cmdStrat(g: Game, p: PlayerIdx, slot: number): string | null {
  if (g.over) return "試合は終了しています";
  const u = unitOf(g, p, slot);
  if (!u) return "武将がいません";
  if (u.mode === "dead") return "撤退中です";
  const s = u.card.strat;
  const short = s.categories.includes("短計");
  if (short) {
    if (u.stratCd > 0) return "短計はクールダウン中です";
  } else {
    if (g.t < u.stratEnd) return "計略の効果中です";
    if (g.t < u.stratReady) return `計略はあと${Math.ceil(u.stratReady - g.t)}秒使えません`;
    if (u.stratLeft <= 0) return "計略は使用済みです";
  }
  if (g.morale[p] < s.mp) return "士気が足りません";
  g.morale[p] -= s.mp;
  if (short) u.stratCd = C.STRAT_SHORT_CD;
  u.ambush = false;
  u.hidden = false;
  u.stealthT = C.STEALTH_RECOVER_T;
  emit(g, { k: "strat", x: u.x, y: u.y, p });

  const dur = stratDuration(s.time, intelOf(g, u), short);
  const until = g.t + dur;
  if (!short) {
    u.stratEnd = until;
    u.stratReady = until + (STRAT_LOCK_SEC_BY_ID.get(u.card.id) ?? C.STRAT_LOCK_SEC_DEFAULT);
    u.stratLeft -= 1;
  }
  const cats = s.categories;
  let applied = false;
  const team = g.units.filter((o) => o.p === p && o.mode !== "dead");
  if (cats.includes("全体強化")) {
    for (const o of team) o.buffs.push({ dStrong: C.STRAT_TEAM_STRONG, speedMul: 1, until, src: u.id });
    applied = true;
  }
  if (cats.includes("強化")) {
    u.buffs.push({ dStrong: C.STRAT_BUFF_STRONG, speedMul: C.STRAT_BUFF_SPEED, until, src: u.id });
    applied = true;
  }
  if (cats.includes("妨害")) {
    for (const e of fieldEnemies(g, p, true)) {
      if (dist(u, e) <= C.STRAT_DEBUFF_R) {
        e.buffs.push({ dStrong: C.STRAT_DEBUFF_STRONG, speedMul: C.STRAT_DEBUFF_SPEED, until, src: u.id });
        e.ambush = false;
      }
    }
    applied = true;
  }
  if (cats.includes("ダメージ")) {
    for (const e of fieldEnemies(g, p, true)) {
      if (dist(u, e) <= C.STRAT_DAMAGE_R) {
        damage(g, e, C.STRAT_DAMAGE_BASE + intelOf(g, u) * C.STRAT_DAMAGE_PER_INTEL, "strat");
        emit(g, { k: "hit", x: e.x, y: e.y, p });
      }
    }
    applied = true;
  }
  if (cats.includes("回復")) {
    for (const o of team) {
      if (o === u || dist(u, o) <= 150) o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.25);
    }
    applied = true;
  }
  if (!applied) u.buffs.push({ dStrong: C.STRAT_BUFF_STRONG, speedMul: C.STRAT_BUFF_SPEED, until, src: u.id });
  return null;
}

// ---------- tick ----------

export function tick(g: Game, dt: number = C.DT) {
  if (g.over) return;
  g.t += dt;

  for (const p of [0, 1] as PlayerIdx[]) g.morale[p] = Math.min(g.maxMorale[p], g.morale[p] + C.MORALE_REGEN * dt);

  for (const u of g.units) {
    u.buffs = u.buffs.filter((b) => b.until > g.t);
    u.cdAction = Math.max(0, u.cdAction - dt);
    u.cdBow = Math.max(0, u.cdBow - dt);
    u.cdIntercept = Math.max(0, u.cdIntercept - dt);
    u.stratCd = Math.max(0, u.stratCd - dt);
    u.slowT = Math.max(0, u.slowT - dt);
    if (u.slowT === 0) u.slowF = 1;
    u.melee = false;
    u.sieging = false;
    if (u.mode === "dead") {
      u.respawn -= dt;
      if (u.respawn <= 0) respawn(g, u);
    }
  }

  // モード遷移と移動
  for (const u of g.units) {
    if (u.mode === "dead") continue;
    const own = inCastleZone(u.p, u.y);
    const cardInCastle = inCastleZone(u.p, u.ty);
    if (u.mode === "castle" && !cardInCastle) u.mode = "field";
    else if (u.mode === "field" && cardInCastle && own) {
      u.mode = "castle";
      u.charging = false;
      u.vel = 0;
      u.siege = 0;
      if (u.card.skills.includes("伏")) u.ambush = true;
    }
    if (u.mode === "castle") u.hp = Math.min(u.maxHp, u.hp + u.maxHp * C.CASTLE_HEAL_RATE * dt);
  }

  // 近接判定のために先に「誰と接触しているか」を求める(乱戦)
  const contacts = new Map<number, number[]>();
  for (const a of g.units) {
    if (a.mode !== "field") continue;
    for (const b of g.units) {
      if (b.p === a.p || b.mode !== "field" || b.id < a.id) continue;
      if (dist(a, b) <= C.CONTACT_DIST) {
        (contacts.get(a.id) ?? contacts.set(a.id, []).get(a.id)!).push(b.id);
        (contacts.get(b.id) ?? contacts.set(b.id, []).get(b.id)!).push(a.id);
      }
    }
  }

  for (const u of g.units) {
    if (u.mode === "dead") continue;
    stepUnit(g, u, dt, contacts);
  }

  resolveContacts(g, dt);
  updatePikes(g, dt);
  updateRanged(g, dt);
  keepOutOfEnemyCastle(g);
  updateSiege(g, dt);
  updateStealth(g);
  updateRegen(g, dt);

  // 撤退
  for (const u of g.units) {
    if (u.mode !== "dead" && u.hp <= 0) retire(g, u);
  }

  if (g.castle[0] <= 0 || g.castle[1] <= 0) {
    if (g.castle[0] <= 0 && g.castle[1] <= 0) g.over = { winner: null, reason: "両軍の城が同時に落ちました" };
    else g.over = { winner: g.castle[0] <= 0 ? 1 : 0, reason: "城ゲージが0になりました" };
  } else if (g.t >= C.GAME_SEC) {
    const [a, b] = g.castle;
    g.over = { winner: a === b ? null : a > b ? 0 : 1, reason: "時間切れ（城ゲージ比較）" };
  }
}

export function retire(g: Game, u: Unit) {
  u.mode = "dead";
  u.hp = 0;
  const base = C.RESPAWN_BASE + C.RESPAWN_PER_COST * u.card.cost;
  u.respawn = base * (has(u, "活") ? C.RESPAWN_SKILL_MUL : 1);
  u.charging = false;
  u.vel = 0;
  u.siege = 0;
  // 「撤退するまで」の計略が味方・敵に与えた効果は、使用者の撤退で消える
  for (const o of g.units) o.buffs = o.buffs.filter((b) => !(b.src === u.id && b.until >= 1e8));
  u.buffs = [];
  // 撤退で計略の効果は終わる(「撤退するまで」の計略も)
  if (g.t < u.stratEnd) {
    u.stratEnd = g.t;
    u.stratReady = g.t + (STRAT_LOCK_SEC_BY_ID.get(u.card.id) ?? C.STRAT_LOCK_SEC_DEFAULT);
  }
  u.hidden = false;
  u.lockTarget = -1;
  g.fences = g.fences.filter((f) => f.owner !== u.id);
  const home = slotHome(u.p, u.slot, g.decks[u.p].cards.length);
  u.x = home.x;
  u.y = home.y;
  u.tx = home.x;
  u.ty = home.y;
}

function respawn(g: Game, u: Unit) {
  u.mode = "castle";
  u.hp = u.maxHp;
  u.ambush = has(u, "伏");
  u.hidden = u.ambush;
  u.kiPool = 0;
  if (u.card.unit === "剣豪") u.cdAction = C.SLASH_CD;
  if (has(u, "柵")) addFence(g.fences, u);
  emit(g, { k: "reveal", x: u.x, y: u.y, p: u.p });
}

function stepUnit(g: Game, u: Unit, dt: number, contacts: Map<number, number[]>) {
  const inMelee = (contacts.get(u.id)?.length ?? 0) > 0;
  u.melee = inMelee && u.mode === "field";
  let speed = C.BASE_SPEED[u.card.unit];
  if (has(u, "疾")) speed *= C.SPEED_SKILL_MUL;
  speed *= buffSpeed(u) * u.slowF;
  if (u.ambush) speed *= C.AMBUSH_SPEED_MUL;
  if (u.charging) speed *= C.CHARGE_SPEED_MUL;
  if (u.melee) speed *= C.MELEE_SLOW;
  const dx = u.tx - u.x;
  const dy = u.ty - u.y;
  const d = Math.hypot(dx, dy);
  let moved = 0;
  if (u.card.unit === "騎兵") {
    // 騎兵は初速から加速して最高速度に達する。止まる・向きが大きく変わると速度を失う
    if (d > 1.5 && u.mode === "field") {
      const cos = u.fx * (dx / d) + u.fy * (dy / d);
      if (u.vel > 0 && cos < C.CAV_TURN_KEEP) u.vel *= Math.max(0.3, cos);
      u.vel = Math.max(u.vel, C.BASE_SPEED["騎兵"] * C.CAV_INIT_SPEED_RATIO);
      u.vel = Math.min(speed, u.vel + C.CAV_ACCEL * dt);
      speed = u.vel;
    } else u.vel = 0;
  }
  if (d > 1.5) {
    const step = Math.min(d, speed * dt);
    let nx = u.x + (dx / d) * step;
    let ny = u.y + (dy / d) * step;
    // 柵は敵部隊の進路を阻む
    let blocked = false;
    for (const f of g.fences) {
      if (f.p === u.p) continue;
      if (nx > f.x - C.UNIT_RADIUS * 0.6 && nx < f.x + f.w + C.UNIT_RADIUS * 0.6 && ny > f.y - C.UNIT_RADIUS * 0.6 && ny < f.y + f.h + C.UNIT_RADIUS * 0.6) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      nx = u.x;
      ny = u.y;
      u.vel = 0;
      if (u.charging) {
        u.charging = false;
        u.vel = 0;
      }
    }
    moved = Math.hypot(nx - u.x, ny - u.y);
    u.x = nx;
    u.y = ny;
    u.fx = dx / d;
    u.fy = dy / d;
  }
  u.lastSpeed = moved / dt;

  // 騎兵の突撃可能状態: 速度が突撃発動速度に達したら移行(突撃オーラ)。速度が落ちるか乱戦で解除
  if (u.card.unit === "騎兵" && u.mode === "field") {
    const trigger = C.BASE_SPEED["騎兵"] * C.CHARGE_TRIGGER_RATIO;
    if (!u.charging) {
      if (u.vel >= trigger && !u.melee) u.charging = true;
    } else if (u.vel < C.BASE_SPEED["騎兵"] * C.CHARGE_KEEP_RATIO || u.melee) {
      u.charging = false;
      u.vel = Math.min(u.vel, trigger * 0.5);
    }
  }

  // 弓兵の走射ゲージ: 停止している間だけ蓄積する(移動中は保持)
  if (u.card.unit === "弓兵" && u.mode === "field" && moved < 0.2 && !u.melee) {
    u.stillT = Math.min(C.BOW_SWEEP_FILL_T, u.stillT + dt);
  }
}

function resolveContacts(g: Game, dt: number) {
  const done = new Set<string>();
  for (const a of g.units) {
    if (a.mode !== "field") continue;
    for (const b of g.units) {
      if (b.p === a.p || b.mode !== "field") continue;
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      if (done.has(key)) continue;
      if (dist(a, b) > C.CONTACT_DIST) continue;
      done.add(key);
      engage(g, a, b, dt);
    }
  }
}

function ambushHit(g: Game, amb: Unit, other: Unit) {
  const diff = Math.max(0, intelOf(g, amb) - intelOf(g, other));
  damage(g, other, C.AMBUSH_DMG_BASE + diff * C.AMBUSH_DMG_PER_INTEL_DIFF, "ambush");
  amb.ambush = false;
  amb.hidden = false;
  emit(g, { k: "reveal", x: amb.x, y: amb.y, p: amb.p });
}

function engage(g: Game, a: Unit, b: Unit, dt: number) {
  // 伏兵との接触
  if (a.ambush && !b.ambush) ambushHit(g, a, b);
  if (b.ambush && !a.ambush) ambushHit(g, b, a);
  a.hidden = a.ambush;
  b.hidden = b.ambush;
  if (a.ambush || b.ambush) return;

  // 騎兵の突撃
  for (const [x, y] of [[a, b], [b, a]] as [Unit, Unit][]) {
    if (x.charging) {
      damage(g, y, C.CHARGE_DMG_BASE + strongOf(g, x) * C.CHARGE_DMG_PER_STRONG, "action");
      emit(g, { k: "charge", x: y.x, y: y.y, p: x.p });
      x.charging = false;
      x.vel = 0;
    }
  }

  a.stealthT = b.stealthT = C.STEALTH_RECOVER_T;
  // 乱戦ダメージ
  damage(g, b, strongOf(g, a) * C.MELEE_K * dt, "melee");
  damage(g, a, strongOf(g, b) * C.MELEE_K * dt, "melee");
  if (g.fx.length < 40 && Math.random() < 0.15) emit(g, { k: "hit", x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
}

function updatePikes(g: Game, dt: number) {
  const interceptSpeed = C.BASE_SPEED["騎兵"] * C.CHARGE_TRIGGER_RATIO; // 騎兵の突撃発動速度
  for (const u of g.units) {
    const len = pikeLen(u);
    if (len <= 0) {
      u.thrustHit.clear();
      continue;
    }
    const inRange = new Set<number>();
    for (const e of fieldEnemies(g, u.p, false)) {
      // 槍撃の範囲: 移動方向の前方、短い距離と一定の角度
      const dx = e.x - u.x;
      const dy = e.y - u.y;
      const d = Math.hypot(dx, dy);
      if (d > len + C.UNIT_RADIUS) continue;
      if (d > C.UNIT_RADIUS && (dx * u.fx + dy * u.fy) / d < C.PIKE_COS) continue;
      // 迎撃: 突撃発動速度以上で、槍と向かい合う方向から接近している
      const facing = e.fx * -u.fx + e.fy * -u.fy >= C.INTERCEPT_COS;
      const fast = e.lastSpeed >= interceptSpeed;
      inRange.add(e.id);
      if (!u.thrustHit.has(e.id)) {
        // 槍の範囲に入ったときに1回、追加のダメージ
        u.thrustHit.add(e.id);
        damage(g, e, C.THRUST_DMG_BASE + strongOf(g, u) * C.THRUST_DMG_PER_STRONG, "action");
        emit(g, { k: "hit", x: e.x, y: e.y, p: u.p });
      }
      if (facing && fast && u.cdIntercept <= 0) {
        u.cdIntercept = C.INTERCEPT_CD;
        damage(g, e, C.INTERCEPT_DMG_BASE + strongOf(g, u) * C.INTERCEPT_DMG_PER_STRONG, "action");
        e.charging = false;
        e.vel = 0;
        e.slowT = C.INTERCEPT_SLOW_T;
        e.slowF = C.INTERCEPT_SLOW_F;
        emit(g, { k: "intercept", x: e.x, y: e.y, p: u.p });
      } else {
        damage(g, e, strongOf(g, u) * C.PIKE_DPS_K * dt, "action");
      }
      // 騎兵に命中すると、槍兵と同等の速度まで落ちる
      if (e.card.unit === "騎兵") {
        const f = C.BASE_SPEED[u.card.unit] / C.BASE_SPEED["騎兵"];
        e.charging = false;
        e.vel = Math.min(e.vel, C.BASE_SPEED[u.card.unit]);
        if (e.slowT <= C.PIKE_SLOW_T) {
          e.slowT = C.PIKE_SLOW_T;
          e.slowF = Math.min(e.slowF, f);
        }
      }
      u.stealthT = C.STEALTH_RECOVER_T;
    }
    for (const id of u.thrustHit) if (!inRange.has(id)) u.thrustHit.delete(id);
  }
}

function updateRanged(g: Game, dt: number) {
  for (const u of g.units) {
    if (u.mode !== "field" || u.melee || u.ambush) continue;
    if (u.card.unit === "弓兵") {
      if (u.sieging) continue;
      // 攻撃対象: 移動方向を基準に、射程内で最も近い敵(一定の角度内)
      const t = nearest(u, fieldEnemies(g, u.p).filter((e) => {
        const dx = e.x - u.x;
        const dy = e.y - u.y;
        const d = Math.hypot(dx, dy) || 1;
        return d <= C.UNIT_RADIUS || (dx * u.fx + dy * u.fy) / d >= C.BOW_COS;
      }), C.BOW_RANGE);
      if (!t) continue;
      const dmg = C.BOW_DMG_BASE + strongOf(g, u) * C.BOW_DMG_PER_STRONG;
      // 走射: ゲージが満ちた状態で移動を始めると、現在の対象に追加ダメージ
      if (u.stillT >= C.BOW_SWEEP_FILL_T && u.lastSpeed >= 1) {
        u.stillT = 0;
        u.hidden = false;
        u.stealthT = C.STEALTH_RECOVER_T;
        damage(g, t, dmg * C.BOW_SWEEP_MUL, "arrow");
        emit(g, { k: "arrow", x: u.x, y: u.y, x2: t.x, y2: t.y, p: u.p });
      }
      if (u.cdBow > 0) continue;
      u.cdBow = C.BOW_CD;
      u.hidden = false;
      u.stealthT = C.STEALTH_RECOVER_T;
      damage(g, t, dmg, "arrow");
      if (t.sieging) t.siege = Math.max(0, t.siege - C.ARROW_SIEGE_BREAK);
      emit(g, { k: "arrow", x: u.x, y: u.y, x2: t.x, y2: t.y, p: u.p });
    } else if (u.card.unit === "鉄砲隊") {
      // 捕捉: 移動方向を基準に、射程内かつ一定の角度内で最も近い敵。いまの対象が範囲内なら維持する
      const inView = (e: Unit) => {
        const dx = e.x - u.x;
        const dy = e.y - u.y;
        const d = Math.hypot(dx, dy) || 1;
        return e.mode === "field" && !e.hidden && d <= C.GUN_RANGE && (d <= C.UNIT_RADIUS || (dx * u.fx + dy * u.fy) / d >= C.GUN_COS);
      };
      const cur = u.lockTarget >= 0 ? g.units[u.lockTarget] : undefined;
      if (cur && cur.p !== u.p && inView(cur)) {
        u.lockT += dt;
      } else {
        const n = nearest(u, fieldEnemies(g, u.p).filter(inView), C.GUN_RANGE);
        u.lockTarget = n ? n.id : -1;
        u.lockT = 0;
      }
    }
  }
}

/** 敵城エリアには入れない。城壁(城エリアの境界)で止まる */
function keepOutOfEnemyCastle(g: Game) {
  for (const u of g.units) {
    if (u.mode !== "field") continue;
    if (u.p === 0) u.y = Math.max(u.y, C.CASTLE_ZONE_H + C.UNIT_RADIUS);
    else u.y = Math.min(u.y, C.FIELD_H - C.CASTLE_ZONE_H - C.UNIT_RADIUS);
  }
}

function atWall(u: Unit) {
  return u.p === 0 ? u.y - C.CASTLE_ZONE_H <= C.SIEGE_REACH : C.FIELD_H - C.CASTLE_ZONE_H - u.y <= C.SIEGE_REACH;
}

/** 小数第3位を切り捨てて小数第2位までにする(浮動小数点の誤差で桁が落ちないよう微小値を足す) */
const floor2 = (v: number) => Math.floor(v * 100 + 1e-6) / 100;

/** 攻城ゲージが満タンになるまでの秒数(知力ごとの表。整数でない知力は直線補間) */
export function siegeNeedSec(intel: number): number {
  const t = C.SIEGE_TIME_BY_INTEL;
  const last = t.length - 1;
  if (intel <= 0) return t[0]!;
  if (intel >= last) return t[last]!;
  const i = Math.floor(intel);
  return t[i]! + (t[i + 1]! - t[i]!) * (intel - i);
}

/** コスト係数(表にないコストは前後から直線補間) */
export function siegeCostCoef(cost: number): number {
  const tbl = C.SIEGE_COST_COEF;
  if (cost <= tbl[0]![0]) return tbl[0]![1];
  for (let i = 1; i < tbl.length; i++) {
    const [c1, k1] = tbl[i]!;
    if (cost <= c1) {
      const [c0, k0] = tbl[i - 1]!;
      return k0 + ((k1 - k0) * (cost - c0)) / (c1 - c0);
    }
  }
  return tbl[tbl.length - 1]![1];
}

/** 攻城ダメージ(基本) = (兵種基礎値 + 0.02×武力) × コスト係数 */
export function siegeBaseDamage(unit: UnitType, cost: number, strong: number): number {
  return floor2((C.SIEGE_UNIT_BASE[unit] + C.SIEGE_STRONG_K * strong) * siegeCostCoef(cost));
}

/** その部隊が次に攻城を入れたときのダメージ(城門倍率込み) */
export function nextSiegeDamage(g: Game, u: Unit): number {
  const base = siegeBaseDamage(u.card.unit as UnitType, u.card.cost, strongOf(g, u));
  const gate = g.gate[enemyOf(u.p)] === u.id ? C.SIEGE_GATE_MUL : 1;
  return floor2(base * gate);
}

function updateSiege(g: Game, dt: number) {
  const cand = (u: Unit) => u.mode === "field" && !u.melee && atWall(u);
  // 城門担当(守る側ごとに1部隊)。続投できなければ中央に近い部隊へ交代
  for (const e of [0, 1] as PlayerIdx[]) {
    const inGate = (u: Unit) => u.p !== e && cand(u) && Math.abs(u.x - C.FIELD_W / 2) <= C.GATE_HALF_W;
    const cur = g.gate[e] === null ? undefined : g.units.find((u) => u.id === g.gate[e]);
    if (cur && inGate(cur)) continue;
    let best: Unit | null = null;
    for (const u of g.units) if (inGate(u) && (!best || Math.abs(u.x - C.FIELD_W / 2) < Math.abs(best.x - C.FIELD_W / 2))) best = u;
    g.gate[e] = best ? best.id : null;
  }
  for (const u of g.units) {
    if (!cand(u)) {
      u.siege = 0;
      continue;
    }
    u.sieging = true;
    u.ambush = false;
    u.hidden = false;
    u.stealthT = C.STEALTH_RECOVER_T;
    u.charging = false;
    u.vel = 0;
    u.siege += dt;
    const need = siegeNeedSec(intelOf(g, u));
    if (u.siege >= need) {
      u.siege = 0;
      const e = enemyOf(u.p);
      const dmg = nextSiegeDamage(g, u);
      g.castle[e] = Math.max(0, g.castle[e] - dmg);
      emit(g, { k: "castle", x: u.x, y: u.y, p: u.p, big: dmg >= C.SIEGE_MARK_EFFECT });
    }
  }
}

function updateStealth(g: Game) {
  for (const u of g.units) {
    if (u.mode === "dead") {
      u.hidden = false;
      continue;
    }
    u.stealthT = Math.max(0, u.stealthT - C.DT);
    if (u.ambush) {
      u.hidden = u.mode === "field" ? !u.sieging : true;
      continue;
    }
    if (has(u, "忍") && u.mode === "field") {
      const near = g.units.some((e) => e.p !== u.p && e.mode === "field" && dist(u, e) <= C.STEALTH_REVEAL_DIST);
      if (near || u.sieging) u.stealthT = Math.max(u.stealthT, 1);
      u.hidden = u.stealthT <= 0;
    } else u.hidden = false;
  }
}

function updateRegen(g: Game, dt: number) {
  for (const u of g.units) {
    if (!has(u, "気") || u.mode !== "field") continue;
    u.kiT += dt;
    if (u.kiT >= C.KI_REGEN_INTERVAL) {
      u.kiT = 0;
      const heal = Math.min(u.kiPool * C.KI_REGEN_RATIO, u.maxHp - u.hp);
      if (heal > 0) u.hp += heal;
      u.kiPool = Math.max(0, u.kiPool - heal);
    }
  }
}

// ---------- スナップショット ----------

/** 兵種ごとのゲージ(0〜1)。画面に表示する */
function gaugeOf(u: Unit): number {
  if (u.card.unit === "弓兵") return u.stillT / C.BOW_SWEEP_FILL_T;
  if (u.card.unit === "剣豪") return 1 - u.cdAction / C.SLASH_CD;
  if (u.card.unit === "鉄砲隊") return 1 - u.cdAction / C.GUN_CD;
  return 0;
}

export function snapshotFor(g: Game, me: PlayerIdx): Snapshot {
  const units: UnitView[] = [];
  for (const u of g.units) {
    const mine = u.p === me;
    if (!mine) {
      if (u.mode === "dead" || u.mode === "castle" || inCastleZone(u.p, u.y)) continue; // 敵城内部(出入り中の部隊を含む)は見えない
      if (u.hidden && u.mode === "field") continue;
    }
    const v: UnitView = {
      p: u.p,
      slot: u.slot,
      cardId: u.card.id,
      x: round(u.x),
      y: round(u.y),
      fx: round(u.fx, 2),
      fy: round(u.fy, 2),
      hp: round(u.hp, 1),
      maxHp: u.maxHp,
      mode: u.mode,
      hidden: u.hidden,
      charging: u.charging,
      pike: round(pikeLen(u)),
      melee: u.melee,
      sieging: u.sieging,
      siegeRatio: 0,
    };
    if (u.sieging) {
      v.siegeRatio = round(Math.min(1, u.siege / siegeNeedSec(intelOf(g, u))), 2);
    }
    if (mine) {
      v.tx = round(u.tx);
      v.ty = round(u.ty);
      v.respawn = round(Math.max(0, u.respawn), 1);
      v.stratActive = g.t < u.stratEnd;
      v.stratLock = g.t < u.stratEnd ? 0 : round(Math.max(0, u.stratReady - g.t), 1);
      if (Number.isFinite(u.stratLeft)) v.stratLeft = u.stratLeft;
      if (u.sieging) v.siegeDmg = nextSiegeDamage(g, u);
      v.stratCd = round(u.stratCd, 1);
      v.actionCd = round(u.cdAction, 1);
      v.gauge = round(gaugeOf(u), 2);
      if (u.card.unit === "鉄砲隊" && u.lockTarget >= 0 && u.mode === "field") v.lock = g.units[u.lockTarget]?.slot;
      v.buffed = u.buffs.some((b) => b.dStrong > 0 || b.speedMul > 1);
      v.debuffed = u.buffs.some((b) => b.dStrong < 0 || b.speedMul < 1);
    }
    units.push(v);
  }
  const fences: FenceView[] = g.fences.map((f) => ({ p: f.p, x: f.x, y: f.y, w: f.w, h: f.h }));
  return {
    t: round(g.t, 2),
    countLeft: Math.max(0, Math.ceil((C.GAME_SEC - g.t) / C.COUNT_SEC)),
    you: me,
    castle: [round(g.castle[0], 1), round(g.castle[1], 1)],
    morale: round(g.morale[me], 2),
    maxMorale: g.maxMorale[me],
    units,
    fences,
    fx: g.fx,
    over: g.over,
  };
}

function round(v: number, d = 0) {
  const m = 10 ** d;
  return Math.round(v * m) / m;
}
