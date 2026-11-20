export type UnitType = "槍兵" | "騎兵" | "弓兵" | "鉄砲隊" | "剣豪";
export type PlayerIdx = 0 | 1;

export interface Strat {
  name: string;
  categories: string[];
  mp: number;
  time: string;
  text: string;
}

export interface Card {
  id: string;
  name: string;
  kana: string;
  color: string;
  period: string;
  rarity: string;
  cost: number;
  unit: UnitType;
  strong: number;
  intel: number;
  skills: string[];
  strat: Strat;
}

export type FxKind = "hit" | "slash" | "shot" | "charge" | "intercept" | "siege" | "strat" | "castle" | "arrow" | "reveal";
export interface Fx {
  k: FxKind;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  p?: PlayerIdx;
}

export type UnitMode = "castle" | "field" | "dead";

/** クライアントへ送る部隊情報。tx/ty/… は自軍のみ。 */
export interface UnitView {
  p: PlayerIdx;
  slot: number;
  cardId: string;
  x: number;
  y: number;
  fx: number;
  fy: number;
  hp: number;
  maxHp: number;
  mode: UnitMode;
  hidden: boolean;
  charging: boolean;
  pike: number; // 槍の長さ(0なら槍なし)
  melee: boolean;
  sieging: boolean;
  siegeRatio: number;
  // 自軍のみ
  tx?: number;
  ty?: number;
  respawn?: number;
  stratUsed?: boolean;
  stratCd?: number;
  actionCd?: number;
  /** 兵種ゲージ(0〜1)。弓兵=走射、剣豪=斬撃、鉄砲隊=チャージ */
  gauge?: number;
  /** 鉄砲隊が捕捉している敵の slot(ターゲットライン) */
  lock?: number;
  buffed?: boolean;
  debuffed?: boolean;
}

export interface FenceView {
  p: PlayerIdx;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Snapshot {
  t: number;
  countLeft: number;
  you: PlayerIdx;
  castle: [number, number];
  morale: number;
  maxMorale: number;
  units: UnitView[];
  fences: FenceView[];
  fx: Fx[];
  over: null | { winner: PlayerIdx | null; reason: string };
}

export type ClientMsg =
  | { type: "create"; deck: string[]; solo?: boolean }
  | { type: "join"; room: string; deck: string[] }
  | { type: "move"; slot: number; x: number; y: number }
  | { type: "strat"; slot: number }
  | { type: "action"; slot: number }
  | { type: "leave" };

export type ServerMsg =
  | { type: "hello"; id: string }
  | { type: "room"; room: string; you: PlayerIdx; waiting: boolean }
  | { type: "start"; you: PlayerIdx; decks: [string[], string[]]; maxMorale: number }
  | { type: "snapshot"; s: Snapshot }
  | { type: "error"; message: string }
  | { type: "ended"; winner: PlayerIdx | null; reason: string };
