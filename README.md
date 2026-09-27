# サークル会計アプリ

大学生サークル向けの会計アプリ。詳細な方針は `note/方針.md`、技術スタックの決定事項は `note/技術スタック.md`、
プロジェクト全体の引き継ぎ内容は `会計アプリ 引継ぎ資料.md` を参照。

## 構成

pnpm workspace + turborepo によるモノレポ。

- `apps/web`: フロントエンド。Vite + React + React Router (Declarative / HashRouter) + Tailwind CSS + Tanstack Query + shadcn ui
- `apps/server`: バックエンド。Hono（Cloudflare Workers上で動作）。HonoのRPC機能で `apps/web` と型を共有する
- `packages/eslint-config`: 共通ESLint設定
- `packages/typescript-config`: 共通tsconfig
- `packages/accounting-export`: DBから独立した会計出力データの変換

認証（better-auth）、DB（Cloudflare D1 + drizzle）、R2への画像アップロードはいずれも実装済み。

## 引き継いだ人が最初にやること

このリポジトリには**前任者のCloudflareアカウント固有の値が含まれていない**。
`TODO_` / `TODO-` で始まる値が残っているうちは本番デプロイができないので、自分のアカウントの値に差し替える。

なお `wrangler.jsonc` の `account_id` は**ローカル開発（`pnpm dev`）にも必要**。
`send_email` バインディングが `remote: true` で、ローカルでもメール送信だけはCloudflare経由になるため、
`wrangler dev` が起動時にリモート接続を張りにいく。TODOのままだと
`Failed to start the remote proxy session` で起動に失敗する。
まずはメール無しで動かしたいなら、`send_email` を一時的に `remote: false` にすれば起動はできる。

### 1. Cloudflare側のリソースを作る

```sh
pnpm dlx wrangler login
pnpm dlx wrangler d1 create accounting-app-d1     # 出力される database_id を控える
pnpm dlx wrangler r2 bucket create accounting-app-r2
```

送信元ドメインをCloudflareのEmail Routingに登録し、検証を済ませておく。
検証していないドメインを使うと、確認メールの送信が `E_SENDER_NOT_VERIFIED` で失敗する。

### 2. 設定ファイルの TODO を埋める

| ファイル | 項目 | 入れる値 |
| --- | --- | --- |
| `apps/server/wrangler.jsonc` | `account_id` | `wrangler whoami` で表示されるAccount ID |
| `apps/server/wrangler.jsonc` | `d1_databases[0].database_id` | 手順1で控えた database_id |
| `apps/server/wrangler.jsonc` | `vars.WEB_ORIGIN` / `vars.BETTER_AUTH_URL` | デプロイ後に発行されるWorkerのURL |
| `apps/server/wrangler.jsonc` | `vars.EMAIL_FROM_ADDRESS` | 検証済みドメインの送信元アドレス |
| `apps/web/.env.production` | `VITE_API_URL` | `WEB_ORIGIN` と同じURL |

WorkerのURLは初回デプロイまで確定しない。先に一度デプロイして払い出されたURLを確認し、
上の4箇所に反映してから、もう一度デプロイするとよい。

### 3. 本番のシークレットとDBを用意する

```sh
pnpm dlx wrangler secret put BETTER_AUTH_SECRET   # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" などで生成
pnpm dlx wrangler d1 execute accounting-app-d1 --remote --file=apps/server/drizzle/0000_heavy_fantastic_four.sql
```

マイグレーションは `apps/server/drizzle/` のSQLを**番号順に1ファイルずつ**当てる。
適用済みかを記録する仕組みは無いので、どこまで当てたかは自分で管理する。

## セットアップ（ローカル開発）

Node.js 22.22.0以上（推奨: 24系）と、`packageManager`で指定したpnpm 9.0.0を使用する。

```sh
pnpm install --frozen-lockfile
```

`apps/server/.dev.vars.example` をコピーして `apps/server/.dev.vars` を作り、`BETTER_AUTH_SECRET` を埋める。
`WEB_ORIGIN` と `BETTER_AUTH_URL` はexampleのlocalhostのままでよい。

```sh
pnpm --filter server db:apply-local   # ローカルD1にマイグレーションを適用（空のDBにのみ使える）
```

フロントの `VITE_API_URL` は `apps/web/.env.development` がコミット済みなので用意するものはない。

## 開発

```sh
pnpm dev
```

- `apps/web`: http://localhost:3000
- `apps/server`: http://localhost:8787 (`wrangler dev`)

個別に起動する場合は `turbo dev --filter=web` / `turbo dev --filter=server` のようにフィルタを使う。

## デプロイ

```sh
pnpm run deploy
```

フロントのビルド → `wrangler deploy` の順に走る。同じWorkerが `apps/web/dist` を配信するため、この順番である必要がある。

## その他のコマンド

```sh
pnpm build        # 全パッケージのビルド
pnpm lint         # 全パッケージのlint
pnpm test         # テストを持つパッケージのテスト
pnpm check-types  # 全パッケージの型チェック
```

ルートの`pnpm build`と`pnpm check-types`は、Wranglerの`Env`型を自動生成してから実行する。
生成ファイル`apps/server/worker-configuration.d.ts`はコミットしない。
実行時のsecretである`BETTER_AUTH_SECRET`の型は`apps/server/src/env.d.ts`で宣言しているため、
これらの検証には`.dev.vars`やCloudflareの認証情報は不要。アプリ起動時は上記のセットアップが必要。

Turboを介さずserverのコマンドを直接実行する場合は、先に`pnpm --filter server typegen`を実行する。
runtime型は既存の`@cloudflare/workers-types`を使い、生成対象は設定から得られるbinding型に限定する。

GitHub Actionsでは`dev`・`main`向けPRと、それらのブランチへのpushで、
型チェック・lint・test・buildを実行する。デプロイは行わない。
