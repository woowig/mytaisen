import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { validateDeck } from "../shared/game.ts";
import type { ClientMsg, Fx, PlayerIdx, ServerMsg, Snapshot } from "../shared/types.ts";
import { loadManifest } from "./art.ts";
import { Battle } from "./components/Battle.tsx";
import { DeckBuilder } from "./components/DeckBuilder.tsx";
import { Conn } from "./net.ts";

type Phase =
  | { k: "menu" }
  | { k: "waiting"; room: string }
  | { k: "battle"; you: PlayerIdx }
  | { k: "ended"; you: PlayerIdx; winner: PlayerIdx | null; reason: string };

const DECK_KEY = "mytaisen.deck.v1";

function loadDeck(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DECK_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function App() {
  const [phase, setPhase] = useState<Phase>({ k: "menu" });
  const [deck, setDeckState] = useState<string[]>(loadDeck);
  const [joinCode, setJoinCode] = useState("");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState(0);
  const [toast, setToast] = useState("");
  const conn = useRef<Conn | null>(null);
  const snapRef = useRef<Snapshot | null>(null);
  const fxQueue = useRef<Fx[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const youRef = useRef<PlayerIdx>(0);

  useEffect(() => void loadManifest(), []);

  const setDeck = (d: string[]) => {
    setDeckState(d);
    try {
      localStorage.setItem(DECK_KEY, JSON.stringify(d));
    } catch {}
  };

  const showToast = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2500);
  }, []);

  const onMsg = useCallback(
    (m: ServerMsg) => {
      switch (m.type) {
        case "room":
          youRef.current = m.you;
          if (m.waiting) setPhase({ k: "waiting", room: m.room });
          break;
        case "start":
          youRef.current = m.you;
          snapRef.current = null;
          fxQueue.current = [];
          setSnap(null);
          setSelected(0);
          setPhase({ k: "battle", you: m.you });
          break;
        case "snapshot":
          snapRef.current = m.s;
          fxQueue.current.push(...m.s.fx);
          setSnap(m.s);
          break;
        case "error":
          showToast(m.message);
          break;
        case "ended":
          setPhase({ k: "ended", you: youRef.current, winner: m.winner, reason: m.reason });
          break;
      }
    },
    [showToast],
  );

  const connect = (first: ClientMsg) => {
    conn.current?.close();
    const query = first.type === "create" ? "?create=1" : first.type === "join" ? `?room=${encodeURIComponent(first.room)}` : "";
    conn.current = new Conn(query, onMsg, () => {
      conn.current = null;
      setPhase((p) => (p.k === "battle" || p.k === "waiting" ? (showToast("接続が切れました"), { k: "menu" }) : p));
    });
    conn.current.send(first);
  };

  const send = useCallback((m: ClientMsg) => conn.current?.send(m), []);

  const leave = () => {
    conn.current?.send({ type: "leave" });
    conn.current?.close();
    conn.current = null;
    snapRef.current = null;
    setSnap(null);
    setPhase({ k: "menu" });
  };

  const v = validateDeck(deck);

  if (phase.k === "battle" || phase.k === "ended") {
    return (
      <div className="app">
        <header className="top">
          <b>mytaisen</b>
          <span className="muted">操作: ドラッグでカード移動 / Q 計略 / ダブルクリック アクション / 1-8 選択</span>
          <button className="btn" onClick={leave}>
            退出
          </button>
        </header>
        {snap && <Battle you={phase.you} snap={snap} snapRef={snapRef} fxQueue={fxQueue} send={send} selected={selected} setSelected={setSelected} toast={toast} />}
        {!snap && <div className="center">接続中…</div>}
        {phase.k === "ended" && (
          <div className="overlay">
            <div className="result">
              <h2>{phase.winner === null ? "引き分け" : phase.winner === phase.you ? "勝利！" : "敗北…"}</h2>
              <p>{phase.reason}</p>
              <button className="btn primary" onClick={leave}>
                メニューへ
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="top">
        <b>mytaisen</b>
        <span className="muted">英傑大戦風 ネット対戦（2人）</span>
      </header>
      <section className="lobby">
        <div className="lobby-box">
          <h3>対戦</h3>
          {phase.k === "waiting" ? (
            <div>
              <div className="muted">この部屋コードを対戦相手に伝えてください</div>
              <div className="roomcode">{phase.room}</div>
              <div className="muted">相手の参加を待っています…</div>
              <button className="btn" onClick={leave}>
                キャンセル
              </button>
            </div>
          ) : (
            <div className="row">
              <button className="btn primary" disabled={!v.ok} onClick={() => connect({ type: "create", deck })}>
                部屋を作る
              </button>
              <button className="btn" disabled={!v.ok} onClick={() => connect({ type: "create", deck, solo: true })}>
                ひとりで練習
              </button>
              <span className="muted">または</span>
              <input className="code" placeholder="部屋コード" maxLength={4} value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} />
              <button className="btn primary" disabled={!v.ok || joinCode.length !== 4} onClick={() => connect({ type: "join", room: joinCode, deck })}>
                参加する
              </button>
            </div>
          )}
          {!v.ok && <div className="bad">{deck.length ? v.error : "デッキを編成してください（総コスト9以内・8枚以内・同名不可）"}</div>}
          {toast && <div className="bad">{toast}</div>}
        </div>
      </section>
      <DeckBuilder deck={deck} setDeck={setDeck} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
