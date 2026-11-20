// codex CLI の画像生成でカード用のオリジナル画像を作る。
//   bun scripts/gen-images.ts --limit 40 --concurrency 3
//   bun scripts/gen-images.ts --ids ST001,蒼001
// 出力: public/cards/<id>.jpg と public/cards/manifest.json（生成済みIDの配列）
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card } from "../src/shared/types.ts";

const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const LIMIT = Number(arg("limit", "40"));
const CONCURRENCY = Number(arg("concurrency", "3"));
const IDS = arg("ids")?.split(",").filter(Boolean);

const OUT = join(import.meta.dir, "..", "public", "cards");
const MANIFEST = join(OUT, "manifest.json");
await mkdir(OUT, { recursive: true });

const cards: Card[] = await Bun.file(join(import.meta.dir, "..", "data", "cards.json")).json();

const UNIT_DESC: Record<string, string> = {
  槍兵: "a spear infantry commander holding a long spear",
  騎兵: "a mounted cavalry commander on a horse",
  弓兵: "an archer commander holding a large bow",
  鉄砲隊: "a matchlock gunner commander holding an arquebus",
  剣豪: "a master swordsman holding a drawn katana",
};
const COLOR_DESC: Record<string, string> = {
  蒼: "deep blue",
  緋: "crimson red",
  碧: "emerald green",
  玄: "black and charcoal",
  紫: "violet purple",
  琥: "amber orange",
  黄: "golden yellow",
};

function prompt(c: Card) {
  return [
    "Use your image generation tool to create ONE original illustration.",
    `Subject: a stylized vertical portrait of a historical warrior inspired by "${c.name}" (era: ${c.period}), ${UNIT_DESC[c.unit]}.`,
    `Color theme of the armor and background: ${COLOR_DESC[c.color]}.`,
    "Style: painterly anime-inspired card art, dramatic lighting, half-body composition, vertical 2:3.",
    "Constraints: completely original design (do NOT imitate any existing card game artwork or character designs), no text, no letters, no logo, no frame or border.",
    "Then copy the generated image file to ./out.png in the current working directory and print the path.",
  ].join(" ");
}

async function readManifest(): Promise<string[]> {
  try {
    return await Bun.file(MANIFEST).json();
  } catch {
    return [];
  }
}
let manifestLock = Promise.resolve();
function addToManifest(id: string) {
  manifestLock = manifestLock.then(async () => {
    const m = new Set(await readManifest());
    m.add(id);
    await Bun.write(MANIFEST, JSON.stringify([...m].sort()));
  });
  return manifestLock;
}

/** 色×兵種を偏りなくカバーし、低コストを優先して選ぶ */
function pickDefault(limit: number): Card[] {
  const chosen: Card[] = [];
  const names = new Set<string>();
  const sorted = [...cards].sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
  const colors = Object.keys(COLOR_DESC);
  const units = Object.keys(UNIT_DESC);
  const take = (pred: (c: Card) => boolean) => {
    const c = sorted.find((x) => !names.has(x.name) && !chosen.includes(x) && pred(x));
    if (c) {
      chosen.push(c);
      names.add(c.name);
    }
  };
  for (const unit of units) for (const color of colors) if (chosen.length < limit) take((c) => c.color === color && c.unit === unit && c.cost <= 2);
  while (chosen.length < limit) {
    const before = chosen.length;
    take(() => true);
    if (chosen.length === before) break;
  }
  return chosen;
}

async function generate(c: Card): Promise<boolean> {
  const dest = join(OUT, `${c.id}.jpg`);
  if (existsSync(dest)) {
    await addToManifest(c.id);
    return true;
  }
  const work = await mkdtemp(join(tmpdir(), "taisen-img-"));
  try {
    const p = Bun.spawn(["codex", "exec", "--skip-git-repo-check", "-s", "workspace-write", "--cd", work, prompt(c)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await p.exited;
    const png = join(work, "out.png");
    if (!existsSync(png)) {
      const files = await readdir(work);
      throw new Error(`no out.png (${files.join(",")})`);
    }
    const conv = Bun.spawn(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "640", png, "--out", dest], { stdout: "ignore", stderr: "ignore" });
    if ((await conv.exited) !== 0 || !existsSync(dest)) throw new Error("sips failed");
    await addToManifest(c.id);
    return true;
  } catch (e) {
    console.error(`FAIL ${c.id} ${c.name}:`, (e as Error).message);
    return false;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const targets = IDS ? cards.filter((c) => IDS.includes(c.id)) : pickDefault(LIMIT);
console.log(`targets: ${targets.length} (concurrency ${CONCURRENCY})`);
let idx = 0;
let ok = 0;
let ng = 0;
async function worker() {
  while (idx < targets.length) {
    const c = targets[idx++]!;
    const t0 = Date.now();
    let done = await generate(c);
    if (!done) done = await generate(c); // 1回リトライ
    done ? ok++ : ng++;
    console.log(`${done ? "OK  " : "NG  "} ${c.id} ${c.name} (${((Date.now() - t0) / 1000).toFixed(0)}s) [${ok + ng}/${targets.length}]`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`done: ok=${ok} ng=${ng}`);
