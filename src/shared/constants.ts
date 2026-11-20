// ゲームバランス値。公式の数値ではなく仮定義。ここだけ触れば調整できる。
import type { UnitType } from "./types.ts";

export const FIELD_W = 600;
export const FIELD_H = 1000;
export const CASTLE_ZONE_H = 110; // 城エリアの高さ(各自陣の端)
export const GATE_HALF_W = 22; // 城門の半幅(城の中央・カード1枚分の幅。同時に攻撃できるのは1部隊だけ)

export const TICK_RATE = 20;
export const DT = 1 / TICK_RATE;

export const COUNT_SEC = 2.4; // 1カウント
export const GAME_COUNTS = 99;
export const GAME_SEC = COUNT_SEC * GAME_COUNTS; // 237.6s

// デッキ
export const DECK_MAX_CARDS = 8;
export const DECK_MAX_COST = 9;
/** 勢力(色)数 → 最大士気 */
export const MAX_MORALE_BY_COLORS = [12, 12, 10, 8, 6] as const; // index=色数(4以上は6)
export const MAX_MORALE_CAP = 15; // 特技「同盟」で増えても超えない

export const MORALE_START = 5;
export const MORALE_REGEN = 0.3; // /s

export const HP_BASE = 100;
export const UNIT_RADIUS = 22;
export const CONTACT_DIST = UNIT_RADIUS * 2;

export const BASE_SPEED: Record<UnitType, number> = {
  騎兵: 52,
  槍兵: 40,
  弓兵: 38,
  鉄砲隊: 38,
  剣豪: 45,
};
export const SIEGE_BONUS: Record<UnitType, number> = {
  槍兵: 0.5,
  剣豪: 0.35,
  騎兵: 0,
  弓兵: -0.2,
  鉄砲隊: -0.2,
};

export const CASTLE_HP = 100;
export const CASTLE_HEAL_RATE = 0.08; // 城内の回復(最大兵力比/s)
export const RESPAWN_BASE = 8;
export const RESPAWN_PER_COST = 3;
export const RESPAWN_SKILL_MUL = 0.6; // 特技「復活」

export const MELEE_K = 1.4; // 乱戦: 武力 × K  /s
export const MELEE_SLOW = 0.3;

// 騎兵
export const CHARGE_DIST = 150;
export const CHARGE_SPEED_MUL = 1.35;
export const CHARGE_DMG_BASE = 22;
export const CHARGE_DMG_PER_STRONG = 2.2;
export const CHARGED_ARROW_MUL = 0.5;

// 槍兵
export const PIKE_LEN = 70;
export const PIKE_LEN_PER_COST = 8; // 特技「槍術」
export const PIKE_WIDTH = 16;
export const PIKE_DPS_K = 0.5;
export const INTERCEPT_DMG_BASE = 30;
export const INTERCEPT_DMG_PER_STRONG = 1.5;
export const INTERCEPT_SLOW_T = 4;
export const INTERCEPT_SLOW_F = 0.5;
export const INTERCEPT_CD = 2;
export const THRUST_T = 0.5;
export const THRUST_CD = 3;
export const THRUST_LEN_MUL = 1.8;
export const THRUST_DMG_BASE = 10;
export const THRUST_DMG_PER_STRONG = 1;

// 弓兵
export const BOW_RANGE = 230;
export const BOW_CD = 1.3;
export const BOW_DMG_BASE = 4;
export const BOW_DMG_PER_STRONG = 0.7;
export const BOW_STILL_FOR_RUNSHOT = 3;
export const BOW_RUNSHOT_T = 6;
export const BOW_RUNSHOT_SPEED = 1.2;
export const ARROW_SIEGE_BREAK = 0.8; // 攻城ゲージ(秒)

// 剣豪
export const SLASH_RANGE = 80;
export const SLASH_CD = 3.5;
export const SLASH_DMG_BASE = 10;
export const SLASH_DMG_PER_STRONG = 1.2;
export const SLASH_KNOCKBACK = 35;
export const SLASH_SLOW_T = 3;
export const SLASH_SLOW_F = 0.5;

// 鉄砲隊
export const GUN_RANGE = 300;
export const GUN_CD = 3;
export const GUN_DMG_BASE = 10;
export const GUN_DMG_PER_STRONG = 1.4;
export const GUN_LINE_WIDTH = 16;
export const GUN_BREAK = 1.5;
export const SNIPE_LOCK_T = 2;
export const SNIPE_MUL = 1.8;
export const SNIPE_KNOCKBACK = 30;

// 攻城
export const SIEGE_NEED_MAX = 6.5;
export const SIEGE_NEED_PER_INTEL = 0.35;
export const SIEGE_NEED_MIN = 1.6;
export const SIEGE_COST_K = 0.45;
export const SIEGE_STRONG_K = 0.16;
export const SIEGE_GATE_MUL = 3; // 城門攻撃のダメージ倍率(城壁は1倍)
export const SIEGE_REACH = UNIT_RADIUS + 6; // 城壁からこの距離以内で攻城できる

// 特技
export const AMBUSH_SPEED_MUL = 0.7;
export const AMBUSH_DMG_BASE = 8;
export const AMBUSH_DMG_PER_INTEL_DIFF = 4;
export const STEALTH_REVEAL_DIST = 150;
export const STEALTH_RECOVER_T = 5;
export const KI_REGEN_INTERVAL = 2;
export const KI_REGEN_RATIO = 0.3;
export const ONI_HP_RATIO = 0.4;
export const ONI_DMG_MUL = 0.5;
export const SENJIN_T = 20;
export const SENJIN_BONUS = 2;
export const SPEED_SKILL_MUL = 1.2;
export const HEI_PER_COST = 0.06; // 特技「兵」: 同時代の兵持ちコスト合計 × 6%
export const FENCE_W = 70;
export const FENCE_H = 10;
export const FENCE_OFFSET = 130;

// 計略
export const STRAT_SHORT_CD = 25;
export const STRAT_DAMAGE_R = 170;
export const STRAT_DEBUFF_R = 200;
export const STRAT_BUFF_STRONG = 3;
export const STRAT_TEAM_STRONG = 2;
export const STRAT_DEBUFF_STRONG = -2;
export const STRAT_DEBUFF_SPEED = 0.8;
export const STRAT_BUFF_SPEED = 1.1;
export const STRAT_DAMAGE_BASE = 14;
export const STRAT_DAMAGE_PER_INTEL = 2.2;
export const STRAT_DUR_BASE = 3;
export const STRAT_DUR_PER_INTEL = 0.9;
export const STRAT_INSTANT_DUR = 1.5;
export const STRAT_FIXED_DUR = 10;
export const STRAT_SHORT_DUR_MUL = 0.6;
