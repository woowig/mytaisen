// カードを「振る」操作の検出。短い距離を素早く往復させたときに成立する。
// ドラッグ中のポインタ位置(論理座標)を渡して使う。

export interface ShakeOptions {
  /** 判定に使う直近の時間(ms) */
  windowMs: number;
  /** 往復と数える最小の動き(px)。これ未満の揺れは無視 */
  minStep: number;
  /** 向きの反転がこの回数以上で成立 */
  reversals: number;
  /** 振る範囲の最大(px)。これを超える大きな移動は、振るのではなく移動とみなす */
  maxExtent: number;
  /** 成立後、次の判定を始めるまでの待ち(ms) */
  cooldownMs: number;
}

/** 斬撃: どの方向でもよいので、短い距離を素早く振る */
export const SWING: ShakeOptions = { windowMs: 700, minStep: 6, reversals: 3, maxExtent: 140, cooldownMs: 800 };

interface Sample {
  t: number;
  x: number;
  y: number;
}

export class ShakeDetector {
  private samples: Sample[] = [];
  private lockUntil = 0;

  constructor(
    private opt: ShakeOptions,
    /** "any": 縦横どちらかの往復 / "vertical": 前後(縦)の往復だけ */
    private axis: "any" | "vertical" = "any",
  ) {}

  reset() {
    this.samples = [];
  }

  /** 位置を追加する。振る操作が成立したら true */
  push(t: number, x: number, y: number): boolean {
    if (t < this.lockUntil) return false;
    this.samples.push({ t, x, y });
    while (this.samples.length > 1 && t - this.samples[0]!.t > this.opt.windowMs) this.samples.shift();
    if (this.samples.length < 4) return false;
    const xs = this.samples.map((s) => s.x);
    const ys = this.samples.map((s) => s.y);
    const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if (extent > this.opt.maxExtent) return false;
    const rev = this.axis === "vertical" ? reversalsOf(ys, this.opt.minStep) : Math.max(reversalsOf(xs, this.opt.minStep), reversalsOf(ys, this.opt.minStep));
    if (rev < this.opt.reversals) return false;
    this.samples = [];
    this.lockUntil = t + this.opt.cooldownMs;
    return true;
  }
}

/** 値の列で、向きが反転した回数。minStep 未満の小さな動きは無視する */
export function reversalsOf(values: number[], minStep: number): number {
  let dir = 0;
  let anchor = values[0]!;
  let count = 0;
  for (const v of values) {
    const d = v - anchor;
    if (Math.abs(d) < minStep) continue;
    const nd = d > 0 ? 1 : -1;
    if (dir !== 0 && nd !== dir) count++;
    dir = nd;
    anchor = v;
  }
  return count;
}
