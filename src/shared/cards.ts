import raw from "../../data/cards.json";
import type { Card } from "./types.ts";

export const CARDS = raw as Card[];
export const CARD_BY_ID: ReadonlyMap<string, Card> = new Map(CARDS.map((c) => [c.id, c]));
