// datalist.json (公式データ) → data/cards.json (ゲームで使う項目だけ、画像URLは捨てる)
import type { Card } from "../src/shared/types.ts";

const SRC = process.argv[2] ?? "/Users/joe/src/booty/lib/cards/datalist.json";
const raw: any[] = await Bun.file(SRC).json();

const cards: Card[] = raw.map((r) => ({
  id: String(r.number),
  name: r.name,
  kana: r.kana || r.name, // 読みがないカード(名前がひらがな・カタカナなど)は、名前を読みにする
  color: r.color,
  period: r.period,
  rarity: r.rarity,
  cost: Number(r.cost),
  unit: r.unit_type,
  strong: Number(r.strong),
  intel: Number(r.intelligence),
  skills: r.skills ?? [],
  strat: {
    name: r.strat.name,
    categories: String(r.strat.category).split(/,\s*/),
    mp: Number(r.strat.mp),
    time: r.strat.time,
    text: r.strat.full,
  },
}));

// 検証
const ids = new Set<string>();
for (const c of cards) {
  if (ids.has(c.id)) throw new Error(`duplicate id ${c.id}`);
  ids.add(c.id);
  if (!(c.cost > 0) || !(c.strong > 0) || !(c.intel > 0)) throw new Error(`bad stats ${c.id}`);
  if (typeof c.name !== "string" || typeof c.kana !== "string") throw new Error(`bad name/kana ${c.id}`);
  if (!["槍兵", "騎兵", "弓兵", "鉄砲隊", "剣豪"].includes(c.unit)) throw new Error(`bad unit ${c.id} ${c.unit}`);
}
await Bun.write(new URL("../data/cards.json", import.meta.url), JSON.stringify(cards));
console.log(`wrote ${cards.length} cards`);
