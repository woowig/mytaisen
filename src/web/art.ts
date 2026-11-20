// カード画像(生成済みのみ)と色テーマ
export const COLOR_HEX: Record<string, string> = {
  蒼: "#2f6fd0",
  緋: "#d0392f",
  碧: "#2e9e6a",
  玄: "#4d4d5c",
  紫: "#8a4fc7",
  琥: "#c98a1b",
  黄: "#d6c21f",
};
export const UNIT_GLYPH: Record<string, string> = { 槍兵: "槍", 騎兵: "騎", 弓兵: "弓", 鉄砲隊: "砲", 剣豪: "剣" };

let manifest = new Set<string>();
const listeners = new Set<() => void>();

export async function loadManifest() {
  try {
    const r = await fetch("/cards/manifest.json", { cache: "no-store" });
    if (r.ok) manifest = new Set<string>(await r.json());
  } catch {}
  listeners.forEach((l) => l());
}
export const onManifest = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const hasArt = (id: string) => manifest.has(id);
export const artUrl = (id: string) => `/cards/${encodeURIComponent(id)}.jpg`;

const imgCache = new Map<string, HTMLImageElement>();
/** canvas用。未ロード/無しは null */
export function artImage(id: string): HTMLImageElement | null {
  if (!hasArt(id)) return null;
  let img = imgCache.get(id);
  if (!img) {
    img = new Image();
    img.src = artUrl(id);
    imgCache.set(id, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}
