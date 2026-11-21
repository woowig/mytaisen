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
/** 「ひとりで練習」のCOMのデッキの総コストの上限(人間より有利) */
export const COM_DECK_MAX_COST = 10;

// COM(「ひとりで練習」の相手)の思考
export const COM_THINK_SEC = 0.3; // 判断の間隔
export const COM_THINK_JITTER = 0.1; // 間隔のゆらぎ(±)
export const COM_DELAY_MIN = 0.2; // 判断してから操作が反映されるまでの遅れ
export const COM_DELAY_MAX = 0.5;
export const COM_AIM_JITTER = 10; // 目的地のずれ(±)
export const COM_MIN_RETARGET = 25; // 目的地がこれ以上変わったときだけ再指示する
export const COM_OPEN_SEC = 10; // 開幕の作戦の長さ
export const COM_ENDGAME_SEC = 30; // 残りがこの秒数以下なら、押し切り・逃げ切り
export const COM_TACTIC_HOLD_SEC = 3; // 一度決めた作戦を続ける最低秒数
export const COM_RETREAT_HP = 0.3; // 兵力がこの割合以下なら城に戻って回復
export const COM_RETURN_HP = 0.8; // 兵力がこの割合以上に戻ったら再び出城
/** 勢力(色)数 → 最大士気 */
export const MAX_MORALE_BY_COLORS = [12, 12, 10, 8, 6] as const; // index=色数(4以上は6)
export const MAX_MORALE_CAP = 15; // 特技「同盟」で増えても超えない

export const MORALE_START = 5;
export const MORALE_COUNTS_PER_POINT = 4.2; // 士気1が溜まるまでのカウント数
export const MORALE_REGEN = 1 / (MORALE_COUNTS_PER_POINT * COUNT_SEC); // /s

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

export const CASTLE_HP = 100;
export const CASTLE_HEAL_RATE = 0.08; // 城内の回復(最大兵力比/s)
export const RESPAWN_BASE = 8;
export const RESPAWN_PER_COST = 3;
export const RESPAWN_SKILL_MUL = 0.6; // 特技「復活」

export const MELEE_K = 1.4; // 乱戦: 武力 × K  /s
export const MELEE_SLOW = 0.3;

// 騎兵
// 加速度・突撃発動速度は仮値(イシュー#1: 数値は別途定義)
export const CAV_INIT_SPEED_RATIO = 0.2; // 移動開始時の初速(基本速度比)
export const CAV_ACCEL = 10; // 加速度(px/s^2)
export const CHARGE_TRIGGER_RATIO = 0.85; // 突撃発動速度(基本速度比)。これ以上で突撃可能状態
export const CHARGE_KEEP_RATIO = 0.6; // 突撃可能状態を保てる下限(基本速度比)。これを下回ると解除
export const CAV_TURN_KEEP = 0.9; // 進行方向が大きく変わると速度が落ちる(cos がこれ未満のとき)
export const CHARGE_SPEED_MUL = 1.35;
export const CHARGE_DMG_BASE = 22;
export const CHARGE_DMG_PER_STRONG = 2.2;
export const CHARGED_ARROW_MUL = 0.5;

// 槍兵
export const PIKE_LEN = 70;
export const PIKE_LEN_PER_COST = 8; // 特技「槍術」
export const PIKE_COS = 0.8; // 槍撃の有効角度(移動方向からのずれ。cos 0.8 は約37度)
export const PIKE_SLOW_T = 1.5; // 槍撃が騎兵に当たったときの減速時間
export const PIKE_DPS_K = 0.5;
export const INTERCEPT_DMG_BASE = 30;
export const INTERCEPT_DMG_PER_STRONG = 1.5;
export const INTERCEPT_SLOW_T = 4;
export const INTERCEPT_SLOW_F = 0.5;
export const INTERCEPT_CD = 2;
export const INTERCEPT_COS = 0.5; // 迎撃の角度条件(槍の向きと相手の進行方向が向かい合う度合い。cos 0.5 は60度)
export const THRUST_DMG_BASE = 10;
export const THRUST_DMG_PER_STRONG = 1;

// 弓兵
export const BOW_RANGE = 230;
export const BOW_CD = 1.3;
export const BOW_DMG_BASE = 4;
export const BOW_DMG_PER_STRONG = 0.7;
export const BOW_COS = 0.5; // 攻撃対象を選べる角度(移動方向からのずれ。cos 0.5 は60度)
export const BOW_SWEEP_FILL_T = 3; // 停止して走射ゲージが満ちるまでの秒数
export const BOW_SWEEP_MUL = 0.6; // 走射のダメージ(通常攻撃1発に対する倍率)
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
export const GUN_COS = 0.5; // 捕捉できる角度(移動方向からのずれ。cos 0.5 は60度)
export const GUN_CD = 3;
export const GUN_DMG_BASE = 10;
export const GUN_DMG_PER_STRONG = 1.4;
export const GUN_BREAK = 1.5;
export const SNIPE_LOCK_T = 2;
export const SNIPE_MUL = 1.8;
export const SNIPE_KNOCKBACK = 30;

// 攻城
/** 攻城速度(秒): 知力0以下・1〜19・20以上の順。整数でない知力は前後から直線補間する */
export const SIEGE_TIME_BY_INTEL: readonly number[] = [
  5.67, 5.53, 5.42, 5.28, 5.15, 5.01, 4.87, 4.73, 4.6, 4.46, 4.33, 4.19, 4.05, 3.92, 3.78, 3.64, 3.51, 3.37, 3.23, 3.09, 3.0,
];
/** 兵種基礎値(攻城ダメージ) */
export const SIEGE_UNIT_BASE: Record<UnitType, number> = {
  騎兵: 0.56,
  弓兵: 1.3,
  鉄砲隊: 1.3,
  剣豪: 1.5,
  槍兵: 2,
};
export const SIEGE_STRONG_K = 0.02; // 武力1あたりの値
/** コスト → コスト係数(表にないコストは前後から直線補間する) */
export const SIEGE_COST_COEF: readonly (readonly [number, number])[] = [
  [1, 1],
  [1.5, 2.5],
  [2, 3.75],
  [2.5, 4.7],
  [3, 5.65],
  [3.5, 6.55],
  [4, 7.5],
];
export const SIEGE_GATE_MUL = 1.65; // 城門攻撃のダメージ倍率(城壁は1倍)
export const SIEGE_MARK_YELLOW = 6; // 次の攻城ダメージがこの値以上なら攻城ゲージの枠が黄色
export const SIEGE_MARK_EFFECT = 13; // この値以上なら黄色の枠 + エフェクト
export const SIEGE_REACH = UNIT_RADIUS + 6; // 城壁からこの距離以内で攻城できる

// 特技
export const AMBUSH_SPEED_MUL = 0.7;
/** 伏兵ダメージ(相手の最大兵力に対する%) = (自分の知力 ÷ 相手の知力) × AMBUSH_DMG_RATIO_K + AMBUSH_DMG_BASE_PCT */
export const AMBUSH_DMG_RATIO_K = 30;
export const AMBUSH_DMG_BASE_PCT = 10;
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
export const FENCE_HP = 100; // 柵の耐久値(最大)
export const FENCE_BREAK_SEC = 6; // 敵1部隊が接し続けたとき、満タンの柵が壊れるまでの秒数
export const FENCE_TOUCH = UNIT_RADIUS; // 柵の当たり判定の外側、この距離以内の敵部隊は柵に接している

// 計略
export const STRAT_SHORT_CD = 25;
/** 効果終了後に同じ武将の計略を使えない時間(秒)のデフォルト。計略(カード)ごとに設定できる */
export const STRAT_LOCK_SEC_DEFAULT = 0;
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
