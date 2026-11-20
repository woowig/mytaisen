import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { CARD_BY_ID } from "../../shared/cards.ts";
import * as C from "../../shared/constants.ts";
import type { ClientMsg, Fx, PlayerIdx, Snapshot, UnitView } from "../../shared/types.ts";
import { artImage, COLOR_HEX, UNIT_GLYPH } from "../art.ts";
import { CardArt } from "./CardArt.tsx";

const CARD_W = 52;
const CARD_H = 74;
// カード中心がこれより上には行かない(カード上端が敵の城壁に接する位置)
const CARD_MIN_Y = C.CASTLE_ZONE_H + CARD_H / 2;
// カード上端が壁にほぼ接していれば壁への攻撃指示にする(余裕分)
const WALL_SNAP = 14;
// 兵種ごとのゲージ名(スナップショットの gauge を表示する)
const GAUGE_LABEL: Record<string, string> = { 弓兵: "掃射" };
const ME_COLOR = "#4aa3ff";
const EN_COLOR = "#ff5a5a";

interface FxLive extends Fx {
  born: number;
  ttl: number;
}

interface Props {
  you: PlayerIdx;
  snap: Snapshot;
  snapRef: MutableRefObject<Snapshot | null>;
  fxQueue: MutableRefObject<Fx[]>;
  send: (m: ClientMsg) => void;
  selected: number;
  setSelected: (s: number) => void;
  toast: string;
}

export function Battle({ you, snap, snapRef, fxQueue, send, selected, setSelected, toast }: Props) {
  const cardCv = useRef<HTMLCanvasElement>(null);
  const fieldCv = useRef<HTMLCanvasElement>(null);
  const disp = useRef(new Map<string, { x: number; y: number }>());
  const fxLive = useRef<FxLive[]>([]);
  const drag = useRef<{ slot: number; dx: number; dy: number; x: number; y: number; lastSent: number } | null>(null);
  const selRef = useRef(selected);
  selRef.current = selected;

  const flip = you === 1;
  const toView = (x: number, y: number): [number, number] => (flip ? [C.FIELD_W - x, C.FIELD_H - y] : [x, y]);

  // ---- 描画ループ ----
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const fit = (cv: HTMLCanvasElement) => {
      const dpr = window.devicePixelRatio || 1;
      const r = cv.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr));
      const h = Math.max(1, Math.round(r.height * dpr));
      if (cv.width !== w || cv.height !== h) {
        cv.width = w;
        cv.height = h;
      }
      return cv.getContext("2d")!;
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const s = snapRef.current;
      if (!s) return;
      for (const f of fxQueue.current.splice(0)) fxLive.current.push({ ...f, born: now, ttl: f.k === "strat" ? 900 : f.k === "shot" ? 250 : 450 });
      fxLive.current = fxLive.current.filter((f) => now - f.born < f.ttl);
      // 補間
      const k = 1 - Math.exp(-dt * 16);
      for (const u of s.units) {
        const key = `${u.p}:${u.slot}`;
        const d = disp.current.get(key);
        if (!d || Math.hypot(d.x - u.x, d.y - u.y) > 200) disp.current.set(key, { x: u.x, y: u.y });
        else {
          d.x += (u.x - d.x) * k;
          d.y += (u.y - d.y) * k;
        }
      }
      if (cardCv.current) drawCardField(fit(cardCv.current), cardCv.current, s);
      if (fieldCv.current) drawBattleField(fit(fieldCv.current), fieldCv.current, s, now);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  const sc = (cv: HTMLCanvasElement) => cv.width / C.FIELD_W;

  /** 敵城の城門位置(表示範囲の上端・中央)。幅はカード1枚分 */
  function drawEnemyGate(ctx: CanvasRenderingContext2D) {
    const x = C.FIELD_W / 2;
    const y = C.CASTLE_ZONE_H;
    ctx.fillStyle = "rgba(255,90,90,0.35)";
    ctx.fillRect(x - C.GATE_HALF_W, y, C.GATE_HALF_W * 2, C.UNIT_RADIUS * 2);
    ctx.fillStyle = EN_COLOR;
    ctx.fillRect(x - C.GATE_HALF_W, y, C.GATE_HALF_W * 2, 5);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("城門", x, y + 24);
  }

  function drawCardField(ctx: CanvasRenderingContext2D, cv: HTMLCanvasElement, s: Snapshot) {
    const k = sc(cv);
    ctx.setTransform(k, 0, 0, k, 0, -C.CASTLE_ZONE_H * k); // 敵城エリア分は表示しない
    const W = C.FIELD_W;
    const H = C.FIELD_H;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#2a2118");
    g.addColorStop(1, "#3a2d20");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // 木目風の罫線
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let y = 0; y < H; y += 50) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    // 自城エリアのみ。敵城エリアは表示しない
    ctx.fillStyle = "rgba(74,163,255,0.14)";
    ctx.fillRect(0, H - C.CASTLE_ZONE_H, W, C.CASTLE_ZONE_H);
    drawEnemyGate(ctx);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "bold 22px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("自城", W / 2, H - 10);

    const mine = s.units.filter((u) => u.p === you);
    // 部隊の実位置(ゴースト)と指示線
    for (const u of mine) {
      if (u.mode === "dead") continue;
      const d = disp.current.get(`${u.p}:${u.slot}`);
      const [cx, cy] = cardPos(u);
      if (d) {
        const [ux, uy] = toView(d.x, d.y);
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.setLineDash([5, 6]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ux, uy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(74,163,255,0.5)";
        ctx.beginPath();
        ctx.arc(ux, uy, 8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const u of [...mine].sort((a, b) => (a.slot === selRef.current ? 1 : 0) - (b.slot === selRef.current ? 1 : 0))) drawToken(ctx, u);
  }

  function cardPos(u: UnitView): [number, number] {
    const dr = drag.current;
    if (dr && dr.slot === u.slot) return [dr.x, dr.y];
    const [x, y] = toView(u.tx ?? u.x, u.ty ?? u.y);
    return [x, Math.max(y, CARD_MIN_Y)];
  }

  function drawToken(ctx: CanvasRenderingContext2D, u: UnitView) {
    const card = CARD_BY_ID.get(u.cardId)!;
    const [cx, cy] = cardPos(u);
    const x = cx - CARD_W / 2;
    const y = cy - CARD_H / 2;
    const col = COLOR_HEX[card.color] ?? "#666";
    ctx.save();
    if (u.mode === "dead") ctx.globalAlpha = 0.45;
    ctx.fillStyle = "#111";
    roundRect(ctx, x - 2, y - 2, CARD_W + 4, CARD_H + 4, 6);
    ctx.fill();
    ctx.fillStyle = col;
    roundRect(ctx, x, y, CARD_W, CARD_H, 5);
    ctx.fill();
    const img = artImage(card.id);
    ctx.save();
    roundRect(ctx, x + 3, y + 3, CARD_W - 6, CARD_H - 6, 4);
    ctx.clip();
    if (img) {
      const r = Math.max((CARD_W - 6) / img.width, (CARD_H - 6) / img.height);
      ctx.drawImage(img, x + CARD_W / 2 - (img.width * r) / 2, y + CARD_H / 2 - (img.height * r) / 2, img.width * r, img.height * r);
    } else {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(x, y, CARD_W, CARD_H);
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.font = "bold 30px serif";
      ctx.textAlign = "center";
      ctx.fillText(UNIT_GLYPH[card.unit] ?? "", cx, cy + 4);
    }
    ctx.restore();
    // 名前帯
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(x + 3, y + CARD_H - 20, CARD_W - 6, 17);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(card.name.length > 5 ? card.name.slice(0, 5) : card.name, cx, y + CARD_H - 8);
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(x + 3, y + 3, 16, 14);
    ctx.fillStyle = "#ffd96b";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText(String(card.cost), x + 11, y + 14);
    // HPバー
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y - 8, CARD_W, 5);
    ctx.fillStyle = u.hp / u.maxHp > 0.4 ? "#59d36b" : "#e6554b";
    ctx.fillRect(x, y - 8, (CARD_W * Math.max(0, u.hp)) / u.maxHp, 5);
    // 計略状態
    if (u.buffed) {
      ctx.fillStyle = "#ffd96b";
      ctx.fillRect(x + CARD_W - 12, y + 3, 9, 9);
    }
    if (u.mode === "dead") {
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      roundRect(ctx, x, y, CARD_W, CARD_H, 5);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 20px sans-serif";
      ctx.fillText(String(Math.ceil(u.respawn ?? 0)), cx, cy + 6);
    }
    if (u.slot === selRef.current) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#ffe36b";
      ctx.lineWidth = 3;
      roundRect(ctx, x - 3, y - 3, CARD_W + 6, CARD_H + 6, 7);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawBattleField(ctx: CanvasRenderingContext2D, cv: HTMLCanvasElement, s: Snapshot, now: number) {
    const k = sc(cv);
    ctx.setTransform(k, 0, 0, k, 0, -C.CASTLE_ZONE_H * k); // 敵城エリア分は表示しない
    const W = C.FIELD_W;
    const H = C.FIELD_H;
    const z = C.CASTLE_ZONE_H;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#35603a");
    g.addColorStop(0.5, "#4a7a3f");
    g.addColorStop(1, "#35603a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // 川
    ctx.fillStyle = "rgba(80,140,200,0.35)";
    ctx.fillRect(0, H / 2 - 18, W, 36);
    // 自城のみ描く(敵城は見せない)
    ctx.fillStyle = "rgba(74,163,255,0.22)";
    ctx.fillRect(0, H - z, W, z);
    drawEnemyGate(ctx);
    // 城
    drawCastle(ctx, W / 2, H - z, ME_COLOR);
    // 柵
    for (const f of s.fences) {
      const [x1, y1] = toView(f.x, f.y);
      const [x2, y2] = toView(f.x + f.w, f.y + f.h);
      ctx.fillStyle = "#6b4a2b";
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.max(6, Math.abs(y2 - y1)));
    }
    // 部隊(奥から)
    const list = [...s.units].filter((u) => !(u.p !== you && u.mode === "dead")).sort((a, b) => (disp.current.get(`${a.p}:${a.slot}`)?.y ?? 0) - (disp.current.get(`${b.p}:${b.slot}`)?.y ?? 0));
    const ordered = flipOrder(list);
    for (const u of ordered) drawUnit(ctx, u, now);
    // エフェクト
    for (const f of fxLive.current) drawFx(ctx, f, now);
  }

  function flipOrder(list: UnitView[]) {
    if (!flip) return list;
    return [...list].reverse();
  }

  /** 自城の城門。城壁の位置(城エリアの上端)に、判定幅=カード1枚分だけ描く */
  function drawCastle(ctx: CanvasRenderingContext2D, cx: number, wallY: number, col: string) {
    ctx.fillStyle = col;
    ctx.fillRect(cx - C.GATE_HALF_W, wallY, C.GATE_HALF_W * 2, 5);
    ctx.fillStyle = "rgba(20,20,30,0.75)";
    ctx.fillRect(cx - C.GATE_HALF_W, wallY + 5, C.GATE_HALF_W * 2, 16);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("城門", cx, wallY + 17);
  }

  function drawUnit(ctx: CanvasRenderingContext2D, u: UnitView, now: number) {
    const d = disp.current.get(`${u.p}:${u.slot}`);
    if (!d) return;
    const card = CARD_BY_ID.get(u.cardId)!;
    const [x, y] = toView(d.x, d.y);
    const [fx, fy] = flip ? [-u.fx, -u.fy] : [u.fx, u.fy];
    const mine = u.p === you;
    const col = mine ? ME_COLOR : EN_COLOR;
    const r = u.mode === "castle" ? C.UNIT_RADIUS * 0.8 : C.UNIT_RADIUS;
    ctx.save();
    if (u.mode === "castle") ctx.globalAlpha = 0.7;
    if (u.hidden) ctx.globalAlpha = 0.4;
    // 槍
    if (u.pike > 0) {
      ctx.strokeStyle = "#e8e0c8";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + fx * u.pike, y + fy * u.pike);
      ctx.stroke();
    }
    if (u.charging) {
      ctx.fillStyle = "rgba(255,170,60,0.35)";
      ctx.beginPath();
      ctx.arc(x, y, r + 9 + Math.sin(now / 80) * 2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (u.sieging) {
      ctx.strokeStyle = "#ffe36b";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, y, r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * u.siegeRatio);
      ctx.stroke();
    }
    ctx.fillStyle = COLOR_HEX[card.color] ?? "#666";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    const img = artImage(card.id);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r - 2, 0, Math.PI * 2);
    ctx.clip();
    if (img) {
      const sz = (r - 2) * 2;
      const rr = Math.max(sz / img.width, sz / img.height);
      // 顔を狙って上寄せ
      ctx.drawImage(img, x - (img.width * rr) / 2, y - sz / 2 - 2, img.width * rr, img.height * rr);
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = `bold ${Math.round(r)}px serif`;
      ctx.textAlign = "center";
      ctx.fillText(UNIT_GLYPH[card.unit] ?? "", x, y + r * 0.35);
    }
    ctx.restore();
    ctx.strokeStyle = col;
    ctx.lineWidth = u.melee ? 5 : 3;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    // HP
    ctx.fillStyle = "#000";
    ctx.fillRect(x - r, y - r - 9, r * 2, 5);
    ctx.fillStyle = u.hp / u.maxHp > 0.4 ? "#59d36b" : "#e6554b";
    ctx.fillRect(x - r, y - r - 9, (r * 2 * Math.max(0, u.hp)) / u.maxHp, 5);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 3;
    ctx.fillText(card.name, x, y + r + 12);
    if (mine && u.slot === selRef.current) {
      ctx.strokeStyle = "#ffe36b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFx(ctx: CanvasRenderingContext2D, f: FxLive, now: number) {
    const t = (now - f.born) / f.ttl;
    const [x, y] = toView(f.x, f.y);
    ctx.save();
    ctx.globalAlpha = 1 - t;
    switch (f.k) {
      case "shot":
      case "arrow": {
        const [x2, y2] = toView(f.x2 ?? f.x, f.y2 ?? f.y);
        ctx.strokeStyle = f.k === "shot" ? "#fff2a8" : "#e9e3c8";
        ctx.lineWidth = f.k === "shot" ? 4 : 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        break;
      }
      case "slash":
        ctx.strokeStyle = "#b8e6ff";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(x, y, C.SLASH_RANGE * (0.4 + t * 0.6), 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "strat":
        ctx.strokeStyle = "#ffe36b";
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.arc(x, y, 30 + t * 140, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "charge":
      case "intercept":
        ctx.fillStyle = f.k === "charge" ? "#ffb347" : "#ff7ab8";
        ctx.beginPath();
        ctx.arc(x, y, 14 + t * 30, 0, Math.PI * 2);
        ctx.fill();
        break;
      case "castle":
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(x, y, 20 + t * 40, 0, Math.PI * 2);
        ctx.fill();
        break;
      case "reveal":
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, 10 + t * 30, 0, Math.PI * 2);
        ctx.stroke();
        break;
      default:
        ctx.fillStyle = "#ff6b4a";
        ctx.beginPath();
        ctx.arc(x, y, 6 + t * 10, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
  }

  // ---- 入力(カードフィールド) ----
  const toLogical = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    // 敵城エリアはカードフィールドに無いので、その手前までに制限
    const y = Math.max(C.CASTLE_ZONE_H + ((e.clientY - r.top) / r.height) * (C.FIELD_H - C.CASTLE_ZONE_H), C.CASTLE_ZONE_H + C.UNIT_RADIUS);
    return [((e.clientX - r.left) / r.width) * C.FIELD_W, y] as const;
  };
  const sendMove = (slot: number, vx: number, vy: number) => {
    // カード上端が城壁に接したら、城壁(城門)への攻撃になる
    const [x, y] = toView(vx, vy <= CARD_MIN_Y + WALL_SNAP ? C.CASTLE_ZONE_H : vy); // 反転は自己逆変換
    send({ type: "move", slot, x, y });
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = snapRef.current;
    if (!s) return;
    const [px, py] = toLogical(e);
    const mine = s.units.filter((u) => u.p === you && u.mode !== "dead");
    const hit = [...mine].reverse().find((u) => {
      const [cx, cy] = cardPos(u);
      return Math.abs(px - cx) <= CARD_W / 2 + 4 && Math.abs(py - cy) <= CARD_H / 2 + 4;
    });
    e.currentTarget.setPointerCapture(e.pointerId);
    if (hit) {
      const [cx, cy] = cardPos(hit);
      setSelected(hit.slot);
      selRef.current = hit.slot;
      drag.current = { slot: hit.slot, dx: px - cx, dy: py - cy, x: cx, y: cy, lastSent: 0 };
    } else if (selRef.current >= 0) {
      // 空きをクリックで選択中カードを移動指示
      sendMove(selRef.current, px, py);
    }
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const [px, py] = toLogical(e);
    d.x = Math.min(C.FIELD_W, Math.max(0, px - d.dx));
    d.y = Math.min(C.FIELD_H, Math.max(CARD_MIN_Y, py - d.dy));
    const now = performance.now();
    if (now - d.lastSent > 50) {
      d.lastSent = now;
      sendMove(d.slot, d.x, d.y);
    }
  };
  const onUp = () => {
    const d = drag.current;
    if (d) sendMove(d.slot, d.x, d.y);
    drag.current = null;
  };

  // ---- キー操作 ----
  const selfActions = useRef({ strat: () => {}, action: () => {} });
  selfActions.current = {
    strat: () => selRef.current >= 0 && send({ type: "strat", slot: selRef.current }),
    action: () => selRef.current >= 0 && send({ type: "action", slot: selRef.current }),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "q" || e.key === "Q") selfActions.current.strat();
      else if (e.key === " " || e.key === "e" || e.key === "E") {
        e.preventDefault();
        selfActions.current.action();
      } else if (/^[1-8]$/.test(e.key)) {
        const slot = Number(e.key) - 1;
        if (snapRef.current?.units.some((u) => u.p === you && u.slot === slot)) setSelected(slot);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [you]);

  // ---- HUD ----
  const mineUnits = useMemo(() => snap.units.filter((u) => u.p === you).sort((a, b) => a.slot - b.slot), [snap, you]);
  const sel = mineUnits.find((u) => u.slot === selected);
  const selCard = sel ? CARD_BY_ID.get(sel.cardId) : undefined;
  const enemy: PlayerIdx = you === 0 ? 1 : 0;
  const short = selCard?.strat.categories.includes("短計");
  const stratDisabled = !sel || sel.mode === "dead" || (short ? (sel.stratCd ?? 0) > 0 : !!sel.stratUsed) || snap.morale < (selCard?.strat.mp ?? 99);

  return (
    <div className="battle">
      <div className="hud">
        <Gauge label="自城" v={snap.castle[you]} max={C.CASTLE_HP} color={ME_COLOR} />
        <div className="count" title="1カウント=2.4秒">
          <div className="count-n">{snap.countLeft}</div>
          <div className="muted">COUNT</div>
        </div>
        <Gauge label="敵城" v={snap.castle[enemy]} max={C.CASTLE_HP} color={EN_COLOR} right />
      </div>
      <div className="fields">
        <div className="pane">
          <div className="pane-title">カードフィールド（ここでカードを動かす）</div>
          <canvas ref={cardCv} className="cv" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
        </div>
        <div className="pane">
          <div className="pane-title">バトルフィールド（反映される戦場）</div>
          <canvas ref={fieldCv} className="cv" />
        </div>
        <aside className="side">
          <div className="morale">
            <div className="muted">士気 {snap.morale.toFixed(1)} / {snap.maxMorale}</div>
            <div className="morale-bar">
              {Array.from({ length: snap.maxMorale }, (_, i) => (
                <i key={i} className={snap.morale >= i + 1 ? "on" : snap.morale > i ? "part" : ""} />
              ))}
            </div>
          </div>
          <div className="hand">
            {mineUnits.map((u) => {
              const c = CARD_BY_ID.get(u.cardId)!;
              return (
                <div key={u.slot} className={`hand-row${u.slot === selected ? " sel" : ""}${u.mode === "dead" ? " dead" : ""}`} onClick={() => setSelected(u.slot)}>
                  <CardArt card={c} size="sm" dim={u.mode === "dead"} />
                  <div className="hand-info">
                    <div>
                      <b>{u.slot + 1}</b> {c.name}
                    </div>
                    <div className="bar">
                      <i style={{ width: `${(100 * u.hp) / u.maxHp}%` }} />
                    </div>
                    {GAUGE_LABEL[c.unit] && u.mode !== "dead" && (
                      <div className="gauge-row" title={GAUGE_LABEL[c.unit]}>
                        <span>{GAUGE_LABEL[c.unit]}</span>
                        <div className="bar gauge">
                          <i className={(u.gauge ?? 0) >= 1 ? "full" : ""} style={{ width: `${100 * Math.min(1, u.gauge ?? 0)}%` }} />
                        </div>
                      </div>
                    )}
                    <div className="muted">
                      {u.mode === "dead" ? `復活まで ${Math.ceil(u.respawn ?? 0)}s` : u.mode === "castle" ? "城内" : "出城中"}
                      {c.skills.length ? ` / ${c.skills.join("")}` : ""}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="controls">
            <div className="muted">
              {selCard ? `選択: ${selCard.name}（${selCard.unit}）` : "カードを選んでください"}
            </div>
            <button className="btn primary" disabled={stratDisabled} onClick={selfActions.current.strat}>
              計略 [Q]
              {selCard ? ` ${selCard.strat.name}（士気${selCard.strat.mp}）` : ""}
            </button>
            {selCard && <div className="muted small">{selCard.strat.text}</div>}
            <button className="btn" disabled={!sel || sel.mode !== "field" || (sel.actionCd ?? 0) > 0 || !["槍兵", "剣豪", "鉄砲隊"].includes(selCard?.unit ?? "")} onClick={selfActions.current.action}>
              {selCard?.unit === "槍兵" ? "槍撃" : selCard?.unit === "剣豪" ? "斬撃" : selCard?.unit === "鉄砲隊" ? "射撃" : "アクション"} [Space]
              {sel && (sel.actionCd ?? 0) > 0 ? ` ${sel.actionCd}s` : ""}
            </button>
            <div className="muted small">騎兵は走り続けると突撃、弓兵は止まると掃射ゲージが貯まり、満タンで動き出すと掃射します。</div>
          </div>
        </aside>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Gauge({ label, v, max, color, right }: { label: string; v: number; max: number; color: string; right?: boolean }) {
  return (
    <div className={`gauge${right ? " right" : ""}`}>
      <span>
        {label} {Math.ceil(v)}
      </span>
      <div className="gauge-bar">
        <i style={{ width: `${(100 * Math.max(0, v)) / max}%`, background: color }} />
      </div>
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
