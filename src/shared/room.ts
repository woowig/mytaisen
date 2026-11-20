// プラットフォーム非依存の部屋ロジック。Bun版サーバーと Cloudflare Durable Object の両方から使う。
import * as C from "./constants.ts";
import { cmdAction, cmdMove, cmdStrat, createGame, snapshotFor, tick, validateDeck, type DeckInfo, type Game } from "./game.ts";
import type { ClientMsg, PlayerIdx, ServerMsg } from "./types.ts";

export interface Peer {
  send(msg: ServerMsg): void;
  idx: PlayerIdx;
  room: RoomCore | null;
}

export class RoomCore {
  players: [Peer | null, Peer | null] = [null, null];
  private decks: [DeckInfo | null, DeckInfo | null] = [null, null];
  private deckIds: [string[], string[]] = [[], []];
  game: Game | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly code: string,
    private onClose: () => void = () => {},
  ) {}

  get isEmpty() {
    return !this.players[0] && !this.players[1];
  }

  /** 入室。失敗時はエラーメッセージを返す */
  /** solo=true: 相手なしの練習。相手側は動かない無人の陣(城内にいて見えない) */
  join(peer: Peer, deck: unknown, solo = false): string | null {
    if (peer.room) return "すでに部屋に入っています";
    const v = validateDeck(deck);
    if (!v.ok) return v.error;
    if (this.game) return "すでに対戦中です";
    if (solo) {
      if (this.players[0] || this.players[1]) return "部屋が満員です";
      this.players[0] = peer;
      this.decks = [v.info, v.info];
      this.deckIds = [(deck as string[]).slice(), (deck as string[]).slice()];
      peer.room = this;
      peer.idx = 0;
      peer.send({ type: "room", room: this.code, you: 0, waiting: false });
      this.start();
      return null;
    }
    const idx: PlayerIdx = this.players[0] ? 1 : 0;
    if (this.players[idx]) return "部屋が満員です";
    this.players[idx] = peer;
    this.decks[idx] = v.info;
    this.deckIds[idx] = (deck as string[]).slice();
    peer.room = this;
    peer.idx = idx;
    const full = !!(this.players[0] && this.players[1]);
    for (const p of this.players) if (p) p.send({ type: "room", room: this.code, you: p.idx, waiting: !full });
    if (full) this.start();
    return null;
  }

  private start() {
    const [da, db] = this.decks;
    if (!da || !db) return;
    const game = createGame(da, db);
    this.game = game;
    this.players.forEach((p, i) => p?.send({ type: "start", you: i as PlayerIdx, decks: this.deckIds, maxMorale: game.maxMorale[i as PlayerIdx] }));
    this.timer = setInterval(() => {
      tick(game);
      this.players.forEach((p, i) => p?.send({ type: "snapshot", s: snapshotFor(game, i as PlayerIdx) }));
      if (game.over) {
        const over = game.over;
        for (const p of this.players) p?.send({ type: "ended", winner: over.winner, reason: over.reason });
        this.close();
      }
    }, 1000 / C.TICK_RATE);
  }

  /** 切断・退出 */
  leave(peer: Peer) {
    if (peer.room !== this) return;
    peer.room = null;
    const idx = peer.idx;
    this.players[idx] = null;
    const other = this.players[idx === 0 ? 1 : 0];
    if (this.game && !this.game.over) {
      other?.send({ type: "ended", winner: idx === 0 ? 1 : 0, reason: "相手が切断しました" });
      this.close();
    } else if (!this.game) {
      if (!other) this.close();
      else other.send({ type: "room", room: this.code, you: idx === 0 ? 1 : 0, waiting: true });
    }
  }

  /** 対戦中の操作 */
  handle(peer: Peer, msg: ClientMsg) {
    const g = this.game;
    if (!g) return;
    let err: string | null = null;
    switch (msg.type) {
      case "move":
        err = cmdMove(g, peer.idx, Number(msg.slot), Number(msg.x), Number(msg.y));
        break;
      case "strat":
        err = cmdStrat(g, peer.idx, Number(msg.slot));
        break;
      case "action":
        err = cmdAction(g, peer.idx, Number(msg.slot));
        break;
    }
    if (err) peer.send({ type: "error", message: err });
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onClose();
  }
}
