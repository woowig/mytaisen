import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { CARD_BY_ID } from "../../shared/cards.ts";
import * as C from "../../shared/constants.ts";
import type { ClientMsg, FenceView, Fx, PlayerIdx, Snapshot, UnitView } from "../../shared/types.ts";
import { ShakeDetector, SWING } from "../shake.ts";
import { artImage, COLOR_HEX, UNIT_GLYPH } from "../art.ts";
import { CardArt } from "./CardArt.tsx";

const CARD_W = 52;
const CARD_H = 74;
// カード中心がこれより上には行かない(カード上端が敵の城壁に接する位置)
const CARD_MIN_Y = C.CASTLE_ZONE_H + CARD_H / 2;
// カード上端が壁にほぼ接していれば壁への攻撃指示にする(余裕分)
const WALL_SNAP = 14;
const CARD_ALPHA = 0.55; // 戦場に重ねるカードの不透明度(選択中・ドラッグ中は1)
const DBLCLICK_MS = 300; // ダブルクリックとみなす間隔
const PIKE_STAB_MS = 350; // 移動中の槍の突き出し周期
const DUST_MIN_SPEED = 20; // 砂煙を出す最低速度(盤面座標のpx/s)
const DUST_STEP = 14; // この距離を走るごとに砂煙を出す
const DUST_MAX = 300; // 砂煙の粒の上限(多数の騎兵でも重くならないように)
const TAP_SLOP = 8; // この距離以内ならカードを動かしていないクリックとみなす(画面のCSS px)
// 兵種ごとのゲージ名(スナップショットの gauge を表示する)
const GAUGE_LABEL: Record<string, string> = { 弓兵: "走射", 剣豪: "斬撃", 鉄砲隊: "チャージ" };
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
  /** 「ひとりで練習」の相手(COM)。人間同士の対戦では null */
  opponent: { name: string; cost: number } | null;
}

export function Battle({ you, snap, snapRef, fxQueue, send, selected, setSelected, toast, opponent }: Props) {
  const fieldCv = useRef<HTMLCanvasElement>(null);
  const disp = useRef(new Map<string, { x: number; y: number }>());
  // 表示位置から求めた部隊ごとの移動速度(px/s、なめらかにしたもの)。槍の移動中エフェクトの判定に使う
  const speed = useRef(new Map<string, number>());
  // 突撃中の騎兵が走った跡の砂煙(盤面座標。部隊についていかず、その場で広がって消える)
  type Dust = { x: number; y: number; vx: number; vy: number; born: number; life: number; r0: number; tone: number };
  const dust = useRef<Dust[]>([]);
  const dustLast = useRef(new Map<string, { x: number; y: number }>());
  const wasCharging = useRef(new Map<string, boolean>());
  const fxLive = useRef<FxLive[]>([]);
  // カードを振る操作(剣豪の斬撃)の検出
  const swing = useRef(new ShakeDetector(SWING));
  const gunShake = useRef(new ShakeDetector(SWING, "vertical")); // 鉄砲隊: カードを前後に揺らす
  const drag = useRef<{ slot: number; dx: number; dy: number; x: number; y: number; lastSent: number; sx: number; sy: number; moved: boolean; consumed: boolean } | null>(null);
  // ダブルクリック判定用: 直前にほぼ動かさずに離したカードの slot / 時刻 / 位置
  const lastTap = useRef<{ slot: number; t: number; x: number; y: number } | null>(null);
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
      for (const f of fxQueue.current.splice(0)) fxLive.current.push({ ...f, born: now, ttl: f.k === "strat" ? 900 : f.k === "shot" ? 250 : f.k === "fence" ? 500 : 450 });
      fxLive.current = fxLive.current.filter((f) => now - f.born < f.ttl);
      // 補間
      const k = 1 - Math.exp(-dt * 16);
      for (const u of s.units) {
        const key = `${u.p}:${u.slot}`;
        const d = disp.current.get(key);
        if (u.mode === "castle") {
          // 城内の部隊は、カードの位置へ一瞬で移動するので、補間せずすぐ表示する(速度もなし)
          disp.current.set(key, { x: u.x, y: u.y });
          speed.current.set(key, 0);
          dustLast.current.delete(key);
        } else if (!d || Math.hypot(d.x - u.x, d.y - u.y) > 200) {
          disp.current.set(key, { x: u.x, y: u.y });
          dustLast.current.delete(key); // 飛んだ先で砂煙の筋がつながらないように
        } else {
          const ox = d.x;
          const oy = d.y;
          d.x += (u.x - d.x) * k;
          d.y += (u.y - d.y) * k;
          const v = Math.hypot(d.x - ox, d.y - oy) / Math.max(dt, 0.001);
          const prev = speed.current.get(key) ?? 0;
          speed.current.set(key, prev + (v - prev) * (1 - Math.exp(-dt * 10)));
        }
      }
      updateDust(s, now);
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

  // 自分のカード: 部隊の実位置から指示位置(カード)への点線と、半透明のカード。選択中・ドラッグ中は不透明
  function drawCards(ctx: CanvasRenderingContext2D, s: Snapshot) {
    const mine = s.units.filter((u) => u.p === you);
    for (const u of mine) {
      if (u.mode === "dead") continue;
      const d = disp.current.get(`${u.p}:${u.slot}`);
      if (!d) continue;
      const [cx, cy] = cardPos(u);
      const [ux, uy] = toView(d.x, d.y);
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 6]);
      ctx.beginPath();
      ctx.moveTo(ux, uy);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 選択中のカードを最前面に
    for (const u of [...mine].sort((a, b) => (a.slot === selRef.current ? 1 : 0) - (b.slot === selRef.current ? 1 : 0))) {
      drawToken(ctx, u, u.slot === selRef.current || drag.current?.slot === u.slot ? 1 : CARD_ALPHA);
    }
  }

  function cardPos(u: UnitView): [number, number] {
    const dr = drag.current;
    if (dr && dr.slot === u.slot) return [dr.x, dr.y];
    const [x, y] = toView(u.tx ?? u.x, u.ty ?? u.y);
    return [x, Math.max(y, CARD_MIN_Y)];
  }

  function drawToken(ctx: CanvasRenderingContext2D, u: UnitView, alpha = 1) {
    const card = CARD_BY_ID.get(u.cardId)!;
    const [cx, cy] = cardPos(u);
    const x = cx - CARD_W / 2;
    const y = cy - CARD_H / 2;
    const col = COLOR_HEX[card.color] ?? "#666";
    ctx.save();
    ctx.globalAlpha = u.mode === "dead" ? Math.max(alpha, 0.85) : alpha;
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
      // 撤退中: 暗く沈め、赤い枠と「撤退中」+復活までの秒数を出す
      ctx.globalAlpha = Math.max(alpha, 0.85);
      ctx.fillStyle = "rgba(0,0,0,0.68)";
      roundRect(ctx, x, y, CARD_W, CARD_H, 5);
      ctx.fill();
      ctx.strokeStyle = "#e6554b";
      ctx.lineWidth = 2;
      roundRect(ctx, x, y, CARD_W, CARD_H, 5);
      ctx.stroke();
      ctx.fillStyle = "#ff8a80";
      ctx.font = "bold 13px sans-serif";
      ctx.fillText("撤退中", cx, cy - 6);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 22px sans-serif";
      ctx.fillText(`${Math.ceil(u.respawn ?? 0)}`, cx, cy + 18);
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
    for (const f of s.fences) drawFence(ctx, f, now);
    // 鉄砲隊のターゲットライン(捕捉している敵へ)
    for (const u of s.units) {
      if (u.p !== you || u.lock === undefined) continue;
      const me = disp.current.get(`${u.p}:${u.slot}`);
      const en = disp.current.get(`${you === 0 ? 1 : 0}:${u.lock}`);
      if (!me || !en) continue;
      const [x1, y1] = toView(me.x, me.y);
      const [x2, y2] = toView(en.x, en.y);
      ctx.strokeStyle = "rgba(255,80,80,0.85)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x2, y2, C.UNIT_RADIUS + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 砂煙(部隊の下)
    drawDust(ctx, now);
    // 自分のカード(指示位置)。部隊より下に、半透明で重ねる
    drawCards(ctx, s);
    // 部隊(奥から)
    const list = [...s.units].filter((u) => u.mode !== "dead").sort((a, b) => (disp.current.get(`${a.p}:${a.slot}`)?.y ?? 0) - (disp.current.get(`${b.p}:${b.slot}`)?.y ?? 0));
    const ordered = flipOrder(list);
    for (const u of ordered) drawUnit(ctx, u, now);
    // エフェクト
    for (const f of fxLive.current) drawFx(ctx, f, now);
  }

  function updateDust(s: Snapshot, now: number) {
    const list = dust.current;
    const puff = (x: number, y: number, vx: number, vy: number, r0: number) => {
      list.push({ x, y, vx, vy, born: now, life: 600 + Math.random() * 400, r0, tone: Math.random() });
    };
    const alive = new Set(s.units.map((u) => `${u.p}:${u.slot}`));
    for (const key of dustLast.current.keys()) if (!alive.has(key)) dustLast.current.delete(key);
    for (const key of wasCharging.current.keys()) if (!alive.has(key)) wasCharging.current.delete(key);
    for (const u of s.units) {
      const key = `${u.p}:${u.slot}`;
      const d = disp.current.get(key);
      if (!d) continue;
      const visible = u.mode === "field" && !u.hidden;
      // 突撃可能になった瞬間は、周囲に一度だけぶわっと広がる
      if (u.charging && visible && wasCharging.current.get(key) === false) {
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
          const sp = 25 + Math.random() * 35;
          puff(d.x + Math.cos(a) * C.UNIT_RADIUS * 0.6, d.y + Math.sin(a) * C.UNIT_RADIUS * 0.6, Math.cos(a) * sp, Math.sin(a) * sp, 6 + Math.random() * 5);
        }
      }
      wasCharging.current.set(key, u.charging);
      const running = u.charging && visible && (speed.current.get(key) ?? 0) > DUST_MIN_SPEED;
      if (!running) {
        dustLast.current.delete(key);
        continue;
      }
      const last = dustLast.current.get(key);
      if (!last) {
        dustLast.current.set(key, { x: d.x, y: d.y });
        continue;
      }
      if (Math.hypot(d.x - last.x, d.y - last.y) < DUST_STEP) continue;
      dustLast.current.set(key, { x: d.x, y: d.y });
      // 足元(部隊の後方)から、位置・大きさ・広がる向きを少しずつばらつかせて出す
      for (let i = 0; i < 2; i++) {
        const lat = (Math.random() - 0.5) * C.UNIT_RADIUS;
        const back = C.UNIT_RADIUS * (0.5 + Math.random() * 0.4);
        puff(d.x - u.fx * back - u.fy * lat, d.y - u.fy * back + u.fx * lat, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30 - 6, 5 + Math.random() * 4);
      }
    }
    dust.current = list.filter((p) => now - p.born < p.life);
    if (dust.current.length > DUST_MAX) dust.current.splice(0, dust.current.length - DUST_MAX);
  }

  function drawDust(ctx: CanvasRenderingContext2D, now: number) {
    for (const p of dust.current) {
      const t = (now - p.born) / p.life;
      const [x, y] = toView(p.x + (p.vx * (now - p.born)) / 1000, p.y + (p.vy * (now - p.born)) / 1000);
      ctx.fillStyle = p.tone < 0.5 ? `rgba(168,136,96,${0.5 * (1 - t)})` : `rgba(226,206,168,${0.45 * (1 - t)})`;
      ctx.beginPath();
      ctx.arc(x, y, p.r0 * (1 + 1.8 * t), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 突撃オーラ: 進行方向に尖り、後方へ尾を引く炎の形と、後方へ流れる速度線
  function drawChargeAura(ctx: CanvasRenderingContext2D, x: number, y: number, fx: number, fy: number, r: number, now: number) {
    const L = r * 4; // 尾の長さ
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(fy, fx)); // +x が進行方向
    const grad = ctx.createLinearGradient(r * 1.2, 0, -L, 0);
    grad.addColorStop(0, "rgba(255,226,130,0.95)");
    grad.addColorStop(0.45, "rgba(255,150,50,0.65)");
    grad.addColorStop(1, "rgba(255,90,20,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(r * 1.25, 0); // 先端(前方)
    const N = 6;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const w = r * 1.05 * Math.sin(Math.PI * Math.pow(t, 0.55)) * (1 - 0.35 * t) + Math.sin(now / 45 + i * 1.7) * r * 0.08 * t;
      ctx.lineTo(r * 1.25 - t * (r * 1.25 + L), -w);
    }
    for (let i = N - 1; i >= 1; i--) {
      const t = i / N;
      const w = r * 1.05 * Math.sin(Math.PI * Math.pow(t, 0.55)) * (1 - 0.35 * t) + Math.sin(now / 45 + i * 2.3 + 1) * r * 0.08 * t;
      ctx.lineTo(r * 1.25 - t * (r * 1.25 + L), w);
    }
    ctx.closePath();
    ctx.fill();
    // 速度線
    for (let i = 0; i < 5; i++) {
      const p = (now / 420 + i * 0.37) % 1;
      const lat = (i - 2) * r * 0.5 + Math.sin(i * 12.9) * r * 0.1;
      const len = 8 + ((i * 7) % 3) * 5;
      const sx = -r * 0.7 - p * L * 1.2;
      ctx.strokeStyle = `rgba(255,236,190,${0.8 * (1 - p)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx, lat);
      ctx.lineTo(sx - len, lat);
      ctx.stroke();
    }
    ctx.restore();
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

  // 槍: 移動方向へ扇形に並ぶ4本の矢印。外側の2本は槍撃の有効角度のすぐ内側
  function drawPikes(ctx: CanvasRenderingContext2D, u: UnitView, x: number, y: number, fx: number, fy: number, r: number, now: number) {
    const edge = Math.acos(C.PIKE_COS) * 0.85;
    const angles = [-edge, -edge / 3, edge / 3, edge];
    // 槍が出ているのは槍撃の発動中だけ。4本が少しずつ位相をずらして突き出す
    for (let i = 0; i < 4; i++) {
      const phase = (now / PIKE_STAB_MS + i * 0.23) % 1;
      const len = u.pike * (1 + 0.1 * Math.sin(phase * Math.PI * 2));
      const c = Math.cos(angles[i]!);
      const s = Math.sin(angles[i]!);
      const dx = fx * c - fy * s;
      const dy = fx * s + fy * c;
      const head = 8;
      const sx = x + dx * r;
      const sy = y + dy * r;
      const tx = x + dx * len;
      const ty = y + dy * len;
      ctx.strokeStyle = "#e8e0c8";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx - dx * head, ty - dy * head);
      ctx.stroke();
      ctx.fillStyle = "#fff8e0";
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - dx * head - dy * 3.5, ty - dy * head + dx * 3.5);
      ctx.lineTo(tx - dx * head + dy * 3.5, ty - dy * head - dx * 3.5);
      ctx.closePath();
      ctx.fill();
      // 突き出した瞬間(最も伸びたとき)に、矢じりの先へ小さな光
      const flash = 1 - Math.abs(phase - 0.25) / 0.06;
      if (flash > 0) {
        ctx.strokeStyle = `rgba(255,255,255,${flash})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx + dx * 7, ty + dy * 7);
        ctx.stroke();
      }
    }
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
    if (u.charging) drawChargeAura(ctx, x, y, fx, fy, r, now);
    if (u.pike > 0) drawPikes(ctx, u, x, y, fx, fy, r, now);
    if (u.sieging) {
      // 次の攻城ダメージの目安(自軍のみ): 白 / 黄 / 黄+エフェクト
      const dmg = u.siegeDmg ?? 0;
      const yellow = dmg >= C.SIEGE_MARK_YELLOW;
      const strong = dmg >= C.SIEGE_MARK_EFFECT;
      ctx.save();
      if (strong) {
        ctx.shadowColor = "#ffe36b";
        ctx.shadowBlur = 8 + 6 * Math.abs(Math.sin(now / 160));
      }
      ctx.strokeStyle = mine && yellow ? "#ffe36b" : "#fff";
      ctx.lineWidth = mine && strong ? 5 : 4;
      ctx.beginPath();
      ctx.arc(x, y, r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * u.siegeRatio);
      ctx.stroke();
      ctx.restore();
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

  /** 馬防柵: 横木2本と杭7本。杭の先は敵の方(自軍は上、敵は下)。耐久が減ると杭が傾き・折れ、ゲージが出る */
  function drawFence(ctx: CanvasRenderingContext2D, f: FenceView, now: number) {
    const [ax, ay] = toView(f.x, f.y);
    const [bx, by] = toView(f.x + f.w, f.y + f.h);
    const x0 = Math.min(ax, bx);
    const w = Math.abs(bx - ax);
    const h = Math.max(6, Math.abs(by - ay));
    const cy = Math.min(ay, by) + h / 2;
    const mine = f.p === you;
    const tip = mine ? -1 : 1;
    const base = cy - tip * (h / 2 + 2);
    const tipEnd = cy + tip * (h / 2 + 9);
    const r = f.hp;
    const N = 7;
    const WOOD = "#9a6a36";
    const EDGE = "#3d2711";
    ctx.save();
    if (f.breaking) ctx.translate(Math.sin(now / 35 + f.id) * 1.6, 0);
    // 足元に軍の色の線
    ctx.strokeStyle = mine ? ME_COLOR : EN_COLOR;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x0 - 2, base - tip * 3);
    ctx.lineTo(x0 + w + 2, base - tip * 3);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // 杭
    for (let i = 0; i < N; i++) {
      const sx = x0 + 3 + (i * (w - 6)) / (N - 1);
      const broken = r < 0.33 && i % 3 === 2;
      const tilted = r < 0.66 && i % 3 === 1;
      const end = broken ? base + (tipEnd - base) * 0.45 : tipEnd;
      ctx.save();
      ctx.translate(sx, base);
      if (tilted) ctx.rotate((i % 2 ? 1 : -1) * (r < 0.33 ? 0.42 : 0.26));
      ctx.translate(-sx, -base);
      ctx.beginPath();
      ctx.moveTo(sx - 2.6, base);
      ctx.lineTo(sx + 2.6, base);
      if (broken) {
        ctx.lineTo(sx + 2.6, end);
        ctx.lineTo(sx + 0.6, end + tip * 3);
        ctx.lineTo(sx - 0.8, end - tip * 1);
        ctx.lineTo(sx - 2.6, end + tip * 2);
      } else {
        ctx.lineTo(sx + 2.6, end - tip * 6);
        ctx.lineTo(sx, end);
        ctx.lineTo(sx - 2.6, end - tip * 6);
      }
      ctx.closePath();
      ctx.fillStyle = WOOD;
      ctx.fill();
      ctx.strokeStyle = EDGE;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }
    // 横木2本(耐久が3割を切ると傾く)
    for (let j = 0; j < 2; j++) {
      const ry = cy + (j === 0 ? -1 : 1) * tip * (h * 0.22 + 1);
      const sag = r < 0.33 ? (j === 0 ? -3 : 3) : 0;
      ctx.beginPath();
      ctx.moveTo(x0 - 1, ry + sag);
      ctx.lineTo(x0 + w + 1, ry - sag);
      ctx.lineWidth = 3.4;
      ctx.strokeStyle = EDGE;
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = WOOD;
      ctx.stroke();
      if (r < 0.66) {
        // ひび
        ctx.strokeStyle = EDGE;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const fx of [0.3, 0.7]) {
          const cx = x0 + w * fx;
          ctx.moveTo(cx - 3, ry - 2);
          ctx.lineTo(cx, ry + 1);
          ctx.lineTo(cx + 3, ry - 2);
        }
        ctx.stroke();
      }
    }
    // 壊されている最中は木くずが少しずつ飛ぶ
    if (f.breaking) {
      ctx.fillStyle = "#b07b42";
      for (let i = 0; i < 5; i++) {
        const t = (now / 420 + i / 5) % 1;
        const px = x0 + ((i * 37 + f.id * 11) % 100) * (w / 100);
        ctx.globalAlpha = 1 - t;
        ctx.fillRect(px, cy + tip * (4 + t * 10) - 1, 2.4, 2.4);
      }
      ctx.globalAlpha = 1;
    }
    // 耐久ゲージ(減ったら表示)
    if (r < 1) {
      const gy = tipEnd + tip * 5 - 2;
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(x0 - 1, gy - 1, w + 2, 6);
      ctx.fillStyle = r > 0.5 ? "#59d36b" : r > 0.3 ? "#ffd24a" : "#e6554b";
      ctx.fillRect(x0, gy, w * Math.max(0, r), 4);
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
      case "fence": {
        // 木の破片が飛び散る
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2 + i * 0.7;
          const sp = 18 + (i % 3) * 12;
          const px = x + Math.cos(a) * sp * t * 1.6;
          const py = y + Math.sin(a) * sp * t * 1.6 + t * t * 26;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(a + t * 7);
          ctx.fillStyle = "#9a6a36";
          ctx.strokeStyle = "#3d2711";
          ctx.lineWidth = 1;
          ctx.fillRect(-4, -1.5, 8, 3);
          ctx.strokeRect(-4, -1.5, 8, 3);
          ctx.restore();
        }
        break;
      }
      case "castle":
        ctx.fillStyle = f.big ? "#ffe36b" : "#fff";
        ctx.beginPath();
        ctx.arc(x, y, (f.big ? 32 : 20) + t * (f.big ? 80 : 40), 0, Math.PI * 2);
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

  // ---- 入力(フィールド上のカード) ----
  const toLogical = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    // 敵城エリアは表示していないので、その手前までに制限
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
    const mine = s.units.filter((u) => u.p === you); // 撤退中のカードも選択・ドラッグできる
    const hit = [...mine].reverse().find((u) => {
      const [cx, cy] = cardPos(u);
      return Math.abs(px - cx) <= CARD_W / 2 + 4 && Math.abs(py - cy) <= CARD_H / 2 + 4;
    });
    e.currentTarget.setPointerCapture(e.pointerId);
    if (hit) {
      const [cx, cy] = cardPos(hit);
      setSelected(hit.slot);
      selRef.current = hit.slot;
      // 直前のクリックと同じカード・時間内・ほぼ同じ位置ならダブルクリック → そのカードの兵種アクション
      const lt = lastTap.current;
      const now = performance.now();
      const dbl = !!lt && lt.slot === hit.slot && now - lt.t <= DBLCLICK_MS && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) <= TAP_SLOP;
      // 槍兵の槍撃は自動発動なので、固有アクションを持つ剣豪・鉄砲隊だけ送る
      const hu = CARD_BY_ID.get(hit.cardId)?.unit;
      if (dbl && hit.mode === "field" && (hu === "剣豪" || hu === "鉄砲隊")) send({ type: "action", slot: hit.slot });
      lastTap.current = null;
      drag.current = { slot: hit.slot, dx: px - cx, dy: py - cy, x: cx, y: cy, lastSent: 0, sx: e.clientX, sy: e.clientY, moved: false, consumed: dbl };
      swing.current.reset();
      gunShake.current.reset();
    } else {
      // カード以外(空き地・部隊)のクリックでは、移動指示を出さず、選択も変えない。カードの移動はドラッグだけ
      lastTap.current = null;
    }
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const [px, py] = toLogical(e);
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > TAP_SLOP) d.moved = true;
    d.x = Math.min(C.FIELD_W, Math.max(0, px - d.dx));
    d.y = Math.min(C.FIELD_H, Math.max(CARD_MIN_Y, py - d.dy));
    const now = performance.now();
    // 剣豪はカードを振ると斬撃(ゲージが満タンのときだけサーバーが受け付ける)
    const du = snapRef.current?.units.find((u) => u.p === you && u.slot === d.slot);
    const unit = du && CARD_BY_ID.get(du.cardId)?.unit;
    if (du?.mode === "field" && unit === "剣豪" && swing.current.push(now, px, py)) send({ type: "action", slot: d.slot });
    if (du?.mode === "field" && unit === "鉄砲隊" && gunShake.current.push(now, px, py)) send({ type: "action", slot: d.slot });
    if (now - d.lastSent > 50) {
      d.lastSent = now;
      sendMove(d.slot, d.x, d.y);
    }
  };
  const onUp = () => {
    const d = drag.current;
    // 動かしていないクリックでは移動指示を出さない(走行中の騎兵などを止めない)
    if (d && (d.moved || d.lastSent > 0)) sendMove(d.slot, d.x, d.y);
    // ほとんど動かさずに離したら、ダブルクリック判定の1回目として記録(ダブルクリックで使った押下は記録しない)
    lastTap.current = d && !d.moved && !d.consumed ? { slot: d.slot, t: performance.now(), x: d.sx, y: d.sy } : null;
    drag.current = null;
  };
  const onCancel = () => {
    lastTap.current = null;
    drag.current = null;
  };

  // ---- キー操作 ----
  const selfActions = useRef({ strat: () => {}, action: () => {} });
  selfActions.current = {
    strat: () => {
      const su = snapRef.current?.units.find((u) => u.p === you && u.slot === selRef.current);
      if (su && su.mode !== "dead") send({ type: "strat", slot: selRef.current });
    },
    action: () => selRef.current >= 0 && send({ type: "action", slot: selRef.current }),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "q" || e.key === "Q") selfActions.current.strat();
      else if (/^[1-8]$/.test(e.key)) {
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
  // 計略を使えない理由(通常の計略のみ。短計はクールダウン、士気不足は別扱い)
  const stratBlock = !sel || short ? "" : sel.stratActive ? "効果中" : (sel.stratLock ?? 0) > 0 ? `あと${Math.ceil(sel.stratLock ?? 0)}秒` : sel.stratLeft === 0 ? "使用済み" : "";
  const stratDisabled = !sel || sel.mode === "dead" || (short ? (sel.stratCd ?? 0) > 0 : stratBlock !== "") || snap.morale < (selCard?.strat.mp ?? 99);

  return (
    <div className="battle">
      <div className="hud">
        <Gauge label="自城" v={snap.castle[you]} max={C.CASTLE_HP} color={ME_COLOR} />
        <div className="count" title="1カウント=2.4秒">
          <div className="count-n">{snap.countLeft}</div>
          <div className="muted">COUNT</div>
        </div>
        <Gauge label={opponent ? `${opponent.name} コスト${opponent.cost} 城` : "敵城"} v={snap.castle[enemy]} max={C.CASTLE_HP} color={EN_COLOR} right />
      </div>
      <div className="fields">
        <div className="pane">
          <div className="pane-title">フィールド（カードをドラッグして指示。部隊は指示位置へ遅れて向かう）</div>
          <canvas ref={fieldCv} className="cv" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel} />
        </div>
        <aside className="side">
          <div className="morale">
            <div className="muted">士気 {snap.morale.toFixed(1)} / {snap.maxMorale}</div>
            <div className="morale-bar">
              {Array.from({ length: C.MAX_MORALE_CAP }, (_, i) => (
                <i key={i} className={i >= snap.maxMorale ? "locked" : snap.morale >= i + 1 ? "on" : snap.morale > i ? "part" : ""} />
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
              {stratBlock ? ` ${stratBlock}` : ""}
              {sel && !stratBlock && (sel.stratLeft ?? 0) > 0 ? ` あと${sel.stratLeft}回` : ""}
            </button>
            {selCard && <div className="muted small">{selCard.strat.text}</div>}
            <button className="btn" disabled={!sel || sel.mode !== "field" || (sel.actionCd ?? 0) > 0 || !["剣豪", "鉄砲隊"].includes(selCard?.unit ?? "")} onClick={selfActions.current.action}>
              {selCard?.unit === "剣豪" ? "斬撃" : selCard?.unit === "鉄砲隊" ? "射撃" : "アクション"} [ダブルクリック]
              {sel && (sel.actionCd ?? 0) > 0 ? ` ${sel.actionCd}s` : ""}
            </button>
            <div className="muted small">騎兵は走り続けると突撃、弓兵は止まると走射ゲージが貯まり、満タンで動き出すと走射します。剣豪は斬撃ゲージが満タンのときにカードを振る(短く素早く往復)と斬撃、鉄砲隊はターゲットラインが出ている間にカードを前後に揺らすと射撃します。</div>
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
