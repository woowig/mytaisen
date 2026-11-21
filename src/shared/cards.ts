import raw from "../../data/cards.json";
import type { Card } from "./types.ts";

/** データ上の読み(`kana`)は、名前がひらがな・カタカナの武将などで `null` になっていることがある */
type RawCard = Omit<Card, "kana"> & { kana: string | null };

/** 読みが `null` または空のカードは、名前を読みとして使い、`kana` が必ず文字列になるようにする */
export const CARDS: Card[] = (raw as RawCard[]).map((c) => ({ ...c, kana: c.kana || c.name }));
export const CARD_BY_ID: ReadonlyMap<string, Card> = new Map(CARDS.map((c) => [c.id, c]));

const KANJI_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };

/** 計略の説明文から「戦闘中N度しか使用できない」の回数を読み取る(制限がなければ null) */
export function parseStratUseLimit(text: string): number | null {
  const m = /戦闘中([一二三四五])度しか使用できない/.exec(text);
  return m ? KANJI_NUM[m[1]!]! : null;
}

/** カードごとの計略の使用回数の制限(試合中の合計。撤退して復活しても戻らない)。制限のない計略は含まない。読み込み時に1回だけ作る */
export const STRAT_USE_LIMIT_BY_ID: ReadonlyMap<string, number> = new Map(
  CARDS.flatMap((c) => {
    const n = parseStratUseLimit(c.strat.text);
    return n === null ? [] : [[c.id, n] as const];
  }),
);

/** 効果終了後の再使用待ち時間(秒)をカードごとに上書きする。ないカードは STRAT_LOCK_SEC_DEFAULT */
export const STRAT_LOCK_SEC_BY_ID: Map<string, number> = new Map();
