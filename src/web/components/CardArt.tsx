import { useEffect, useState } from "react";
import type { Card } from "../../shared/types.ts";
import { artUrl, COLOR_HEX, hasArt, onManifest, UNIT_GLYPH } from "../art.ts";

export function useManifestTick() {
  const [, set] = useState(0);
  useEffect(() => onManifest(() => set((n) => n + 1)), []);
}

/** 画像があれば画像、なければ色・兵種・名前のCSSカード */
export function CardArt({ card, size = "md", onClick, selected, dim, title }: {
  card: Card;
  size?: "sm" | "md" | "lg";
  onClick?: () => void;
  selected?: boolean;
  dim?: boolean;
  title?: string;
}) {
  useManifestTick();
  const color = COLOR_HEX[card.color] ?? "#555";
  const art = hasArt(card.id);
  return (
    <div
      className={`card card-${size}${selected ? " selected" : ""}${dim ? " dim" : ""}${onClick ? " clickable" : ""}`}
      style={{ ["--c" as any]: color }}
      onClick={onClick}
      title={title ?? `${card.id} ${card.name} / ${card.unit} 武${card.strong} 知${card.intel} / 計略:${card.strat.name}(士気${card.strat.mp})`}
    >
      {art ? <img src={artUrl(card.id)} alt={card.name} loading="lazy" draggable={false} /> : <div className="card-fallback">{UNIT_GLYPH[card.unit]}</div>}
      <div className="card-cost">{card.cost}</div>
      <div className="card-unit">{UNIT_GLYPH[card.unit]}</div>
      <div className="card-name">{card.name}</div>
      <div className="card-stats">
        武{card.strong} 知{card.intel}
      </div>
    </div>
  );
}
