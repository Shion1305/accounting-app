# システム全体の構成

更新日: 2026-09-27

位置付け: 基準ブランチ `dev` の `ed644e6` で確認した現状と、会計出力に向けた境界。

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

## 会計出力で加える境界

会計の保存と、取得済みデータを帳票へ変換する処理を分離する。大学固有の必要情報を[会計データ](accounting-data.md)へ保存し、[DB取得 → Data Frame → ファイル生成](export-pipeline.md)へ渡す。履歴・認証・HTTPは[実行処理](export-execution.md)が担当する。

`packages/accounting-export` は[PR #2](https://github.com/Shion1305/accounting-app/pull/2)で提案中のモジュールであり、本書の基準コミットにはまだ存在しない。データ保存・実大学定義・Excel/PDF・履歴を含む完成機能ではない。進捗は[実装計画](../plans/accounting-export.md)で管理する。

PDF変換の実行環境は未採用。[ファイル生成](file-generation.md)で候補と検証条件を管理し、Workers内でそのまま実行できると仮定しない。
