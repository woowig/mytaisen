// デッキ編成画面のカード検索(絞り込みと並び順)。DOM に依存しない純粋な関数だけを置く
import type { Card } from "../shared/types.ts";

/** 勢力の並び順(一覧の並び順に使う) */
export const COLOR_ORDER = ["蒼", "緋", "碧", "玄", "紫", "琥", "黄"] as const;

/**
 * 検索用に文字を正規化する。
 * - NFKC: 全角英数・半角カナなどを通常の文字にそろえる
 * - カタカナをひらがなにそろえる(「ちんぎす」でも「チンギス」でも同じに扱う)。長音記号(ー)や中黒(・)は、そのまま比べる
 * - 英字の大文字・小文字を区別しない
 */
export function normalizeSearch(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFKC")
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .toLowerCase();
}

export interface CardFilter {
  /** 名前・読み・番号の検索文字(空なら条件なし) */
  query?: string;
  colors?: readonly string[];
  units?: readonly string[];
  costs?: readonly number[];
  /** 「画像ありのみ」。指定があれば、画像のあるカードだけ */
  hasArt?: (id: string) => boolean;
}

/** 条件に合うカードを返す。条件がなければ、すべてのカード。`cards` は変更しない */
export function filterCards(cards: readonly Card[], f: CardFilter = {}): Card[] {
  const q = normalizeSearch(f.query?.trim());
  return cards.filter((c) => {
    if (q && !(normalizeSearch(c.name).includes(q) || normalizeSearch(c.kana).includes(q) || normalizeSearch(c.id).includes(q))) return false;
    if (f.colors?.length && !f.colors.includes(c.color)) return false;
    if (f.units?.length && !f.units.includes(c.unit)) return false;
    if (f.costs?.length && !f.costs.includes(c.cost)) return false;
    if (f.hasArt && !f.hasArt(c.id)) return false;
    return true;
  });
}

const colorRank = (color: string) => {
  const i = (COLOR_ORDER as readonly string[]).indexOf(color);
  return i < 0 ? COLOR_ORDER.length : i;
};

/** 一覧の並び順: コストの高い順 → 勢力 → 番号。新しい配列を返し、`cards` は変更しない */
export function sortCards(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => b.cost - a.cost || colorRank(a.color) - colorRank(b.color) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 絞り込んで並べ替える */
export function searchCards(cards: readonly Card[], f: CardFilter = {}): Card[] {
  return sortCards(filterCards(cards, f));
}
