import { describe, expect, test } from "bun:test";
import raw from "../data/cards.json";
import { CARDS } from "./shared/cards.ts";
import type { Card } from "./shared/types.ts";
import { COLOR_ORDER, filterCards, normalizeSearch, searchCards, sortCards } from "./web/card-search.ts";

const ids = (cards: Card[]) => cards.map((c) => c.id);
const byName = (name: string) => CARDS.find((c) => c.name === name)!;

describe("カードデータ", () => {
  test("すべてのカードで、name・kana・id が文字列(null がない)", () => {
    for (const c of CARDS) {
      expect(typeof c.name).toBe("string");
      expect(typeof c.kana).toBe("string");
      expect(typeof c.id).toBe("string");
      expect(c.kana.length).toBeGreaterThan(0);
    }
  });

  test("元のデータで読みが null(または空)のカードは、読み込み後は名前が読みになる", () => {
    const rows = raw as { id: string; name: string; kana: string | null }[];
    for (const r of rows.filter((x) => !x.kana)) expect(CARDS.find((c) => c.id === r.id)!.kana).toBe(r.name);
    // 読みがあるカードは、そのまま
    for (const r of rows.filter((x) => x.kana)) expect(CARDS.find((c) => c.id === r.id)!.kana).toBe(r.kana!);
    // 読みが null だったことが知られているカード(名前がひらがな・カタカナの武将)
    expect(byName("ねね").kana).toBe("ねね");
    expect(byName("チンギス・ハン").kana).toBe("チンギス・ハン");
  });
});

describe("カード検索", () => {
  test("条件なしでは、すべてのカードが返り、全勢力のカードが含まれる", () => {
    const all = searchCards(CARDS);
    expect(all.length).toBe(CARDS.length);
    expect(new Set(ids(all)).size).toBe(CARDS.length);
    expect(new Set(all.map((c) => c.color))).toEqual(new Set(COLOR_ORDER));
    expect(filterCards(CARDS).length).toBe(CARDS.length);
    expect(filterCards(CARDS, { query: "   " }).length).toBe(CARDS.length);
  });

  test("並び順は、コストの高い順 → 勢力 → 番号。元の配列は変更しない", () => {
    const before = ids(CARDS);
    const sorted = sortCards(CARDS);
    expect(ids(CARDS)).toEqual(before);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      expect(a.cost).toBeGreaterThanOrEqual(b.cost);
      if (a.cost === b.cost) expect(COLOR_ORDER.indexOf(a.color as never)).toBeLessThanOrEqual(COLOR_ORDER.indexOf(b.color as never));
    }
    // 先頭の数十枚が1つの勢力に偏らない(コストの高い順なので)
    expect(new Set(sorted.slice(0, 48).map((c) => c.color)).size).toBeGreaterThan(1);
  });

  test("読みが null だったカードの名前でも、エラーにならず見つかる", () => {
    for (const name of ["ねね", "チンギス", "チンギス・ハン", "フビライ・ハン"]) {
      const found = filterCards(CARDS, { query: name });
      expect(found.length).toBeGreaterThan(0);
    }
    expect(ids(filterCards(CARDS, { query: "ねね" }))).toContain(byName("ねね").id);
    expect(ids(filterCards(CARDS, { query: "チンギス" }))).toContain(byName("チンギス・ハン").id);
  });

  test("カード側の読みが null でも、検索の処理自体がエラーにならない", () => {
    const broken = [{ ...CARDS[0]!, name: "ねね", kana: null as unknown as string }, CARDS[1]!];
    expect(() => filterCards(broken, { query: "ね" })).not.toThrow();
    expect(filterCards(broken, { query: "ねね" }).length).toBe(1);
    expect(filterCards(broken, { query: "zzz-none" }).length).toBe(0);
  });

  test("ひらがなでもカタカナでも、同じカードが見つかる", () => {
    const hira = ids(filterCards(CARDS, { query: "ちんぎす" }));
    const kata = ids(filterCards(CARDS, { query: "チンギス" }));
    expect(hira.length).toBeGreaterThan(0);
    expect(hira).toEqual(kata);
    expect(ids(filterCards(CARDS, { query: "ねね" }))).toEqual(ids(filterCards(CARDS, { query: "ネネ" })));
  });

  test("名前・読み・番号のどれかに含まれていれば見つかる(漢字・読み・番号)", () => {
    const c = CARDS.find((x) => x.kana && x.kana !== x.name && /[一-龠]/.test(x.name))!;
    expect(ids(filterCards(CARDS, { query: c.name }))).toContain(c.id); // 漢字の名前
    expect(ids(filterCards(CARDS, { query: c.kana }))).toContain(c.id); // 読み
    expect(ids(filterCards(CARDS, { query: c.id }))).toContain(c.id); // 番号
  });

  test("英字の大文字・小文字を区別しない(番号の検索)", () => {
    const c = CARDS.find((x) => /[A-Z]/.test(x.id))!;
    expect(ids(filterCards(CARDS, { query: c.id.toLowerCase() }))).toContain(c.id);
    expect(ids(filterCards(CARDS, { query: c.id.toUpperCase() }))).toContain(c.id);
  });

  test("全角の英数字や半角カナも、通常の文字として検索できる", () => {
    expect(normalizeSearch("ＳＴ００１")).toBe("st001");
    expect(normalizeSearch("ﾁﾝｷﾞｽ")).toBe(normalizeSearch("ちんぎす"));
    const c = CARDS.find((x) => /^[A-Z]+\d+$/.test(x.id))!;
    const full = c.id.replace(/[A-Za-z0-9]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
    expect(ids(filterCards(CARDS, { query: full }))).toContain(c.id);
  });

  test("勢力・兵種・コストの条件で絞り込める(複数の条件はすべて満たす)", () => {
    for (const c of filterCards(CARDS, { colors: ["蒼"] })) expect(c.color).toBe("蒼");
    for (const c of filterCards(CARDS, { units: ["槍兵", "騎兵"] })) expect(["槍兵", "騎兵"]).toContain(c.unit);
    for (const c of filterCards(CARDS, { costs: [1.5, 3] })) expect([1.5, 3]).toContain(c.cost);
    const mixed = filterCards(CARDS, { colors: ["緋", "碧"], units: ["弓兵"], costs: [2] });
    expect(mixed.length).toBeGreaterThan(0);
    for (const c of mixed) {
      expect(["緋", "碧"]).toContain(c.color);
      expect(c.unit).toBe("弓兵");
      expect(c.cost).toBe(2);
    }
    expect(filterCards(CARDS, { colors: ["蒼"] }).length).toBeLessThan(CARDS.length);
  });

  test("「画像ありのみ」は、指定した判定に合うカードだけ", () => {
    const have = new Set(CARDS.slice(0, 5).map((c) => c.id));
    expect(ids(filterCards(CARDS, { hasArt: (id) => have.has(id) })).sort()).toEqual([...have].sort());
  });
});
