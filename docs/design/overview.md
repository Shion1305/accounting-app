# システム全体の構成

更新日: 2026-11-08

現行システムと、AIによる会計書類の下書き作成の責務をまとめる。

[ドキュメント一覧](../README.md)

## 現行システム

大学生サークルの収支と立替を管理する。一般メンバーはサークルの共有URLから立替を申請し、管理者が承認・却下、精算、手動の収入・支出登録を行う。[製品方針](../../note/方針.md)と[用語](../../CONTEXT.md)を参照する。

| 部分         | 役割・採用技術                                                                               | コードの入口                                    |
| ------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Web          | Vite / React、React RouterのDeclarative・HashRouter、TanStack Query、Tailwind CSS、shadcn ui | `apps/web/src/App.tsx`、`apps/web/src/main.tsx` |
| API          | Hono / Cloudflare Workers。Hono RPCの型をWebと共有                                           | `apps/server/src/index.ts`                      |
| 認証         | better-auth。メール・パスワード、メール確認、再設定                                          | `apps/server/src/auth.ts`                       |
| 所属・会計DB | Cloudflare D1 / Drizzle。サークル、申請、収入、支出                                          | `apps/server/src/db/schema.ts`                  |
| 領収書画像   | R2へ保存し、Workerでアクセスを制限                                                           | `apps/server/src/lib/receipt.ts`                |
| メール       | Cloudflareのsend_emailバインディング                                                         | `apps/server/src/auth.ts`                       |
| 配信         | WorkerがAPIとビルド済みWebを配信                                                             | `apps/server/wrangler.jsonc`                    |
| 開発基盤     | pnpm workspace / Turborepo。型チェック・lint・buildをCIで実行                                | `package.json`、`.github/workflows/ci.yml`      |

バージョン・実行コマンド・環境設定は[ルートREADME](../../README.md)と各package.jsonを参照する。デザインは担当者からの仕様に合わせて反映し、現行の仮UIを最終デザインと扱わない。

## 境界と維持する振る舞い

- サークルがデータの所有単位。管理者APIはセッションと所属を確認し、本文のcircleIdを認可の根拠にしない。
- 公開URLは立替の投稿入口。管理者用の分類補完、提出確認、判定、履歴参照は公開しない。
- 立替は承認時に支出へ反映する。精算済みへの変更は支出を追加しない。購入日と申請日の差は[保存設計](accounting-data.md)で扱う。
- Honoルートは認証・HTTP検証・応答を担当し、会計の変換ロジックをルートへ分散させない。Webはサーバーで確定する会計結果を独自再計算して出力元にしない。
- 認証テーブルはbetter-authの生成元設定を通して変更する。会計の大学別プロフィールを認証ユーザーの必須属性へ混ぜない。
- サブスクリプションの実課金は未実装。現行のactive仮設定を大学帳票の入力・出力設計のために変更しない。

認証やRPCの実装上の注意は[CLAUDE.md](../../CLAUDE.md)にある。履歴資料の古い状態と矛盾した場合は、基準コミットのコードを確認して正本を更新する。

## 会計書類の作成

[AIによる下書き作成](ai-accounting-drafts.md)を本体へ追加した。既存の認証とサークルの取引を使い、利用者がアップロードした書式をCode Interpreterで編集する。生成API、実行状態と一時ファイルの管理はWorkerで行い、アプリ内ではPythonやLibreOfficeを動かさない。

大学別Data Frameやセル配置を使う設計は従来方式の記録として残す。現在の取得・生成・受け取りの責務と、設定・移行手順は上記の設計書で管理する。
