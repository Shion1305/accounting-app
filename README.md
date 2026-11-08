# サークル会計アプリ

大学生サークル向けの会計アプリ。要件・設計・大学書式の調査・実装計画は[設計ドキュメント](docs/README.md)、
業務用語は[CONTEXT.md](CONTEXT.md)、基本的な製品方針は[方針](note/方針.md)を参照。
このREADMEではセットアップ・開発・デプロイの操作を管理する。

## 構成

pnpm workspace + turborepo によるモノレポ。

- `apps/web`: フロントエンド。Vite + React + React Router (Declarative / HashRouter) + Tailwind CSS + Tanstack Query + shadcn ui
- `apps/server`: バックエンド。Hono（Cloudflare Workers上で動作）。HonoのRPC機能で `apps/web` と型を共有する
- `packages/eslint-config`: 共通ESLint設定
- `packages/typescript-config`: 共通tsconfig
- `experiments/llm-export`: [LLMによる帳票編集の検証](experiments/llm-export/README.md)。Node.js 26以上で動く独立した実験コード

認証（better-auth）、DB（Cloudflare D1 + drizzle）、R2への画像アップロードはいずれも実装済み。

## セットアップ（ローカル開発）

Node.js 22.22.0以上（推奨: 24系）と、`packageManager`で指定したpnpm 9.0.0を使用する。

```sh
pnpm install --frozen-lockfile
```

`apps/server/.dev.vars.example` をコピーして `apps/server/.dev.vars` を作り、`BETTER_AUTH_SECRET` を埋める。
`WEB_ORIGIN` と `BETTER_AUTH_URL` はexampleのlocalhostのままでよい。

```sh
pnpm --filter server db:apply-local   # ローカルD1にマイグレーションを適用（未適用のSQLだけを適用）
```

フロントの `VITE_API_URL` は `apps/web/.env.development` がコミット済みなので用意するものはない。

## 開発

```sh
pnpm dev
```

- `apps/web`: http://localhost:3000
- `apps/server`: http://localhost:8787 (`wrangler dev`)

個別に起動する場合は `turbo dev --filter=web` / `turbo dev --filter=server` のようにフィルタを使う。

## デプロイ・Terraform

| 操作                                       | 反映先               |
| ------------------------------------------ | -------------------- |
| `dev` への push                            | 開発環境 (`dev`)     |
| GitHub prerelease の公開                   | ステージング (`stg`) |
| 正式 release の公開・prerelease からの昇格 | 本番 (`prd`)         |
| Deploy workflow の手動実行                 | 選択した環境         |

CI の成功後、Terraform plan/apply → D1 の未適用マイグレーション → Worker・フロントの配信 → 疎通確認を実行する。
D1・非公開 R2 バケット・Terraform state・認証シークレットを環境ごとに分離する。
Worker は同一オリジンで API とフロントを配信する。
詳細は[デプロイ構成](docs/deployment.md)と[インフラ構成](infra/README.md)を参照。

ローカルの `wrangler.jsonc` は Cloudflare の実リソースやメール送信に接続しない。
過去に SQL を直接適用したローカル DB は移行履歴がないため、スキーマを確認して履歴を整備するか、不要なローカルデータに限りリセットしてから移行する。

## その他のコマンド

```sh
pnpm build        # 全パッケージのビルド
pnpm lint         # 全パッケージのlint
pnpm check-types  # 全パッケージの型チェック
```

ルートの`pnpm build`と`pnpm check-types`は、Wranglerの`Env`型を自動生成してから実行する。
生成ファイル`apps/server/worker-configuration.d.ts`はコミットしない。
実行時のsecretである`BETTER_AUTH_SECRET`の型は`apps/server/src/env.d.ts`で宣言しているため、
これらの検証には`.dev.vars`やCloudflareの認証情報は不要。アプリ起動時は上記のセットアップが必要。

Turboを介さずserverのコマンドを直接実行する場合は、先に`pnpm --filter server typegen`を実行する。
runtime型は既存の`@cloudflare/workers-types`を使い、生成対象は設定から得られるbinding型に限定する。

GitHub Actionsでは`dev`・`main`向けPRと、それらのブランチへのpushで、
型チェック・lint・build・デプロイ設定・D1マイグレーション・Terraformを検証する。LLM編集の検証コードは、別のNode.js 26・Python 3.12ジョブで `pnpm check:llm-export` を実行する。この検証ジョブでは実API呼出しを行わない。

## AIによる会計書類の作成

ダッシュボードの「会計書類の作成」から、大学の書式をアップロードし、登録済みの収支で記入できる部分を埋めた下書きを生成できる。アップロードはPDF、Excel、Word、PowerPoint、CSV（`.pdf`、`.xlsx`、`.doc`、`.docx`、`.pptx`、`.csv`）に対応する。

ローカルでは `apps/server/.dev.vars` に `OPENAI_API_KEY` を設定する。デプロイ先では、GitHub Environment の dev・stg・prd にそれぞれ同名の Secret を登録して再デプロイすると、対象 Worker に反映される。キーがなくても既存の会計管理は動作する。モデルは `wrangler.jsonc` の `ACCOUNTING_MODEL` で指定する。

会計書類の実行履歴テーブルもマイグレーションで作成する。ローカルでは `pnpm --filter server db:apply-local` を実行し、デプロイ先ではパイプラインが未適用の SQL を適用する。

`pnpm --filter server test` でモックAPIとSQLiteによるテストを実行する。生成ファイルは一時的に取得でき、終了操作と毎時の清掃で削除する。仕様と保持期間は[下書き生成の設計](docs/design/ai-accounting-drafts.md)を参照する。
