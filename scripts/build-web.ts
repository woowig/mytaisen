// フロントを静的ファイルにまとめて dist/web に出力し、カード画像をコピーする（Cloudflare Workers の assets 用）
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist", "web");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const r = await Bun.build({
  entrypoints: [join(root, "src/web/index.html")],
  outdir: out,
  minify: true,
  splitting: false,
});
if (!r.success) {
  for (const l of r.logs) console.error(l);
  process.exit(1);
}
await cp(join(root, "public", "cards"), join(out, "cards"), { recursive: true });
console.log(`built: ${r.outputs.length} files -> dist/web`);
