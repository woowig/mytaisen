import { useMemo, useState } from "react";
import { CARDS, CARD_BY_ID } from "../../shared/cards.ts";
import { DECK_MAX_CARDS, DECK_MAX_COST } from "../../shared/constants.ts";
import { validateDeck } from "../../shared/game.ts";
import type { Card, UnitType } from "../../shared/types.ts";
import { COLOR_HEX, hasArt } from "../art.ts";
import { searchCards } from "../card-search.ts";
import { CardArt } from "./CardArt.tsx";

const COLORS = Object.keys(COLOR_HEX);
const UNITS: UnitType[] = ["槍兵", "騎兵", "弓兵", "鉄砲隊", "剣豪"];
const COSTS = [1, 1.5, 2, 2.5, 3, 3.5, 4];

export function DeckBuilder({ deck, setDeck }: { deck: string[]; setDeck: (d: string[]) => void }) {
  const [q, setQ] = useState("");
  const [colors, setColors] = useState<string[]>([]);
  const [units, setUnits] = useState<string[]>([]);
  const [costs, setCosts] = useState<number[]>([]);
  const [artOnly, setArtOnly] = useState(false);

  const toggle = <T,>(list: T[], v: T, set: (l: T[]) => void) => {
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  };

  // 条件に合うカードをすべて(コストの高い順 → 勢力 → 番号の順で)表示する
  const filtered = useMemo(() => searchCards(CARDS, { query: q, colors, units, costs, hasArt: artOnly ? hasArt : undefined }), [q, colors, units, costs, artOnly]);

  const cards = deck.map((id) => CARD_BY_ID.get(id)).filter((c): c is Card => !!c);
  const cost = cards.reduce((s, c) => s + c.cost, 0);
  const v = validateDeck(deck);
  const colorSet = new Set(cards.map((c) => c.color));

  const add = (c: Card) => {
    if (deck.includes(c.id)) return;
    setDeck([...deck, c.id]);
  };
  const remove = (id: string) => setDeck(deck.filter((x) => x !== id));

  const randomDeck = () => {
    const pool = CARDS.filter((c) => hasArt(c.id));
    const src = pool.length >= 6 ? pool : CARDS;
    for (let tries = 0; tries < 200; tries++) {
      const picked: Card[] = [];
      let total = 0;
      const sorted = [...src].sort(() => Math.random() - 0.5);
      for (const c of sorted) {
        if (picked.length >= DECK_MAX_CARDS) break;
        if (total + c.cost > DECK_MAX_COST) continue;
        if (picked.some((p) => p.name === c.name)) continue;
        // 1〜2色に寄せる
        const cs = new Set(picked.map((p) => p.color));
        if (cs.size >= 2 && !cs.has(c.color)) continue;
        picked.push(c);
        total += c.cost;
      }
      if (picked.length >= 4) return setDeck(picked.map((c) => c.id));
    }
  };

  return (
    <div className="deckbuilder">
      <section className="db-pool">
        <div className="filters">
          <input placeholder="名前・読み・番号で検索" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="chips">
            {COLORS.map((c) => (
              <button key={c} className={`chip${colors.includes(c) ? " on" : ""}`} style={{ ["--c" as any]: COLOR_HEX[c] }} onClick={() => toggle(colors, c, setColors)}>
                {c}
              </button>
            ))}
          </div>
          <div className="chips">
            {UNITS.map((u) => (
              <button key={u} className={`chip${units.includes(u) ? " on" : ""}`} onClick={() => toggle(units, u, setUnits)}>
                {u}
              </button>
            ))}
          </div>
          <div className="chips">
            {COSTS.map((c) => (
              <button key={c} className={`chip${costs.includes(c) ? " on" : ""}`} onClick={() => toggle(costs, c, setCosts)}>
                {c}
              </button>
            ))}
            <label className="chip-check">
              <input type="checkbox" checked={artOnly} onChange={(e) => setArtOnly(e.target.checked)} />
              画像ありのみ
            </label>
          </div>
          <div className="muted">{filtered.length} 枚</div>
        </div>
        <div className="pool-grid">
          {filtered.map((c) => (
            <CardArt key={c.id} card={c} size="md" onClick={() => add(c)} dim={deck.includes(c.id)} />
          ))}
        </div>
      </section>

      <aside className="db-deck">
        <h3>デッキ</h3>
        <div className="deck-meta">
          <span className={cost > DECK_MAX_COST ? "bad" : ""}>
            コスト {cost}/{DECK_MAX_COST}
          </span>
          <span className={cards.length > DECK_MAX_CARDS ? "bad" : ""}>
            {cards.length}/{DECK_MAX_CARDS}枚
          </span>
          <span>{colorSet.size}色</span>
          {v.ok && <span>最大士気 {v.info.maxMorale}</span>}
        </div>
        <div className="deck-list">
          {cards.map((c) => (
            <div key={c.id} className="deck-row" onClick={() => remove(c.id)} title="クリックで外す">
              <CardArt card={c} size="sm" />
              <div>
                <div className="deck-name">
                  {c.name} <span className="muted">{c.id}</span>
                </div>
                <div className="muted">
                  {c.unit} 武{c.strong} 知{c.intel} {c.skills.join("")}
                </div>
                <div className="muted">
                  計略「{c.strat.name}」士気{c.strat.mp} — {c.strat.text}
                </div>
              </div>
            </div>
          ))}
          {cards.length === 0 && <div className="muted">左の一覧からカードを選んでください</div>}
        </div>
        {!v.ok && cards.length > 0 && <div className="bad">{v.error}</div>}
        <div className="row">
          <button className="btn" onClick={randomDeck}>
            ランダム編成
          </button>
          <button className="btn" onClick={() => setDeck([])}>
            クリア
          </button>
        </div>
      </aside>
    </div>
  );
}
