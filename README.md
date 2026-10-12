# サークル会計アプリ

大学生サークル向けの会計アプリ。詳細な方針は `note/方針.md`、技術スタックの決定事項は `note/技術スタック.md` を参照。

## 構成

pnpm workspace + turborepo によるモノレポ。

- `apps/web`: フロントエンド。Vite + React + React Router (Declarative) + Tailwind CSS + Tanstack Query + shadcn ui
- `apps/server`: バックエンド。Hono（Cloudflare Workers）。HonoのRPC機能で `apps/web` と型を共有し、デプロイ時は同じ Worker がフロントエンドも配信する
- `packages/eslint-config`: 共通ESLint設定
- `packages/typescript-config`: 共通tsconfig

認証（better-auth）、DB（Cloudflare D1 + drizzle）、R2への画像保存を実装済み。

## セットアップ

Node.js 22.22.0 以上（CI は 24）と pnpm 9.0.0 を使用する。

```sh
pnpm install --frozen-lockfile
cp apps/server/.dev.vars.example apps/server/.dev.vars
# .dev.vars の BETTER_AUTH_SECRET に32文字以上のランダムな値を設定する
pnpm --filter server db:apply-local
```

フロントの開発用 API 接続先は `apps/web/.env.development` に設定済み。
`apps/server/wrangler.jsonc` はローカル専用で、メール送信もローカルモックを使う。
実メールの確認には検証済み送信元と Cloudflare 認証を用意し、ローカル設定の `send_email.remote` を変更する。

## 開発

```sh
pnpm dev
```

- `apps/web`: http://localhost:3000
- `apps/server`: http://localhost:8787 (`wrangler dev`)

個別に起動する場合は `turbo dev --filter=web` / `turbo dev --filter=server` のようにフィルタを使う。

## その他のコマンド

```sh
pnpm build        # 全パッケージのビルド
pnpm lint         # 全パッケージのlint
pnpm check-types  # 全パッケージの型チェック
pnpm test:deployment # 環境選択・デプロイ設定の検証
pnpm test:migrations # ローカルD1でマイグレーションを2回適用して検証
```

`build` と `check-types` は Wrangler の binding 型を自動生成する。CI の検証に Cloudflare 認証や `.dev.vars` は不要。

## CI/CD・Terraform

| 操作 | 反映先 |
| --- | --- |
| `main` への push | Dev (`dev`) |
| GitHub prerelease の公開 | Staging (`stg`) |
| GitHub release の公開、または prerelease から正式版への昇格 | Production (`prd`) |

PR では lint・型チェック・ビルド・デプロイ設定・ローカルDB・Terraformを検証する。
デプロイ時は同じ検証を通したコミットに対して、Terraform plan/apply → D1マイグレーション → Workerとフロントの配信 → 疎通確認を実行する。

初回設定、必要な Secrets / Variables、リリースと復旧手順は [デプロイガイド](docs/deployment.md) を参照。
Terraformの所有範囲、state、既存リソースの import は [infra/README.md](infra/README.md) を参照。
