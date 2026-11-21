Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Type checking

Use `bun check` to type check the project. It reads `tsconfig.json` and reports the same errors as `tsc`.

- `bun check src/index.ts` checks one file and what it imports
- `bun --check src/index.ts`, `bun test --check` and `bun build --check` type check first, and do nothing else if there is an error

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## ドキュメント

- ゲーム仕様は `docs/game-rules.md` に書く。ゲームのルール・数値・挙動を変えたら、同じ変更の中でこのファイルも更新する。
- `docs/game-rules.md` には**今の仕様だけ**を書く。変更の理由・経緯・以前との比較・イシューやPRの番号は書かない（それらはコミットメッセージやPRに書く）。
- 数値の正は `src/shared/constants.ts`、ロジックの正は `src/shared/game.ts`。ドキュメントはコードと食い違わせない。

## コミットメッセージ

コミットメッセージ(PRのタイトルと、スカッシュマージ時のコミットタイトルも同じ)は [Conventional Commits](https://www.conventionalcommits.org/ja/v1.0.0/) に従う。

```
<type>[(scope)][!]: <説明>

[本文]

[フッター]
```

- `type` は変更の内容で選ぶ。複数に当てはまるときは、主な目的で選ぶ。
  - `feat`: ユーザーから見える機能の追加・変更(ゲームのルール・数値・挙動、画面の変更を含む)
  - `fix`: 不具合の修正
  - `docs`: ドキュメントだけの変更
  - `refactor`: 挙動を変えないコードの整理
  - `perf`: 性能の改善
  - `test`: テストだけの追加・修正
  - `build`: ビルド・依存関係の変更
  - `ci`: CI・デプロイ設定の変更
  - `style`: 挙動に影響しない書式の変更
  - `chore`: 上のどれにも当たらない雑務
- `scope` は任意。変更の範囲が分かるときに付ける(例: `feat(ai):`)。
- 説明は、変更内容を1行で書く(日本語でよい)。末尾に句点は付けない。
- 互換性を壊す変更は、`type` の後に `!` を付けるか、フッターに `BREAKING CHANGE: ...` を書く。
- 関連するissueは、タイトルの末尾か本文・フッターに `Closes #N` と書く。PRの番号は、スカッシュマージ時にタイトルの末尾へ `(#N)` と付く。
