# Cloudflare へのデプロイと環境運用

リポジトリは [University-Accountant-Project/accounting-app](https://github.com/University-Accountant-Project/accounting-app) で管理する。通常の開発先とデフォルトブランチは `dev`。Cloudflare は専用アカウント **University Accountant Project**（`0350bf22d3fd4ab2fd9283c6ce8b91dd`）を使用する。

## 環境とデプロイのタイミング

| 操作                                               | 反映先             | URL                                                                     |
| -------------------------------------------------- | ------------------ | ----------------------------------------------------------------------- |
| `dev` への push                                    | 開発環境 `dev`     | https://accounting-app-dev.university-accountant-project.workers.dev    |
| プレリリースの公開                                 | ステージング `stg` | https://accounting-app-stg.university-accountant-project.workers.dev    |
| 正式リリースの公開、またはプレリリースからの昇格   | 本番 `prd`         | https://accounting-app-prd.university-accountant-project.workers.dev    |
| `dev` 向け PR の作成・更新・再オープン・draft 解除 | PR ごとの `pr-N`   | `https://accounting-app-pr-N.university-accountant-project.workers.dev` |

GitHub Actions の **Deploy → Run workflow** から、`dev` ブランチの内容を選択した恒久環境へ手動デプロイすることもできる。リリース時はタグが指すコミットを使う。プレリリースでは `published`、正式リリースでは `released` イベントを処理し、正式版への昇格時に二重デプロイしない。タグを付けただけの場合やリリース説明の編集ではデプロイしない。

Worker、D1、領収書用 R2、Terraform state、認証シークレットは環境ごとに分離する。Web と API は同じ Worker・同じオリジンで配信する。dev・stg・PR は公開 URL を持つテスト環境であり、検索対象にしないため `X-Robots-Tag: noindex, nofollow` を返す。実際の個人情報や会計資料は持ち込まず、テストデータを使用する。

## ドメインなしで一通り試す

送信ドメインを用意するまでは、dev・stg・PR で `EMAIL_MODE=log` を使う。確認メールの内容を **Worker のログと Discord のデバッグ用チャンネル**へ通知し、実際のメールは送信しない。メール確認を省略する仕組みではなく、通知に含まれる確認リンクで通常どおり登録を完了する。

1. テスト環境で新規登録する。メールアドレスには `tester@example.invalid` など、テスト用の値を使う。
2. Discord の通知から、対象環境と送信先が一致するメッセージを選び、確認リンクを開く。
3. ログインし、サークルの共有 URL から立替申請と領収書アップロードを試す。
4. 管理画面で承認・精算、手動の収入・支出登録、領収書の閲覧、収支集計を確認する。
5. パスワード再設定を申請し、新しい通知のリンクから変更する。変更前のセッションが失効することも確認する。

Discord に届かない場合は、Cloudflare の **Workers & Pages → 対象 Worker → Logs → Live** を開き、もう一度操作する。`test_email` というログに同じ本文とリンクが残る。Cloudflare にログインした端末からは、次のようにメールのログだけを表示できる。

```sh
pnpm --filter server exec wrangler tail accounting-app-dev --format json --search test_email
```

通知にはメール確認・パスワード再設定に使えるリンクが含まれる。ログを参照できる Cloudflare 管理者と、通知先 Discord チャンネルの参加者だけで扱い、公開の issue や PR には転載しない。Webhook URL は `DEBUG_EMAIL_DISCORD_WEBHOOK` に保存し、コード・Terraform state・ログには出力しない。

### 本番で実メールを使うまで

prd は `EMAIL_MODE=disabled` とし、フロントエンドとヘルスチェックは配信するが、アカウント操作には HTTP 503 を返す。送信設定が済むまでは利用者向けの本番運用を開始しない。prd でのログ送信は設定生成時と実行時の両方で拒否し、Discord の Secret も本番へ渡さない。

実メールを使うときは、[Cloudflare Email Service の手順](https://developers.cloudflare.com/email-service/get-started/send-emails/)でドメインを登録・検証し、GitHub Environment に `EMAIL_FROM_ADDRESS` と `EMAIL_MODE=cloudflare` を設定して再デプロイする。任意の宛先への送信には対応する有料プランも必要となる。まず stg で実際の配信を確認してから prd に適用する。

## PR プレビュー

対象は、このリポジトリ内のブランチから `dev` に送られた非 draft PR。fork と Dependabot の PR では、Secrets を使わない CI のみ実行する。

PR 番号が 17 なら、環境名は `pr-17`、Worker 名は `accounting-app-pr-17` になる。PR の変更をベースブランチへ統合した状態を検証・デプロイする。URL は GitHub のデプロイ情報から開ける。更新時は同じ URL とデータを維持し、PR ごとに異なる認証シークレットを使う。

PR を閉じるかマージすると、次の順に削除する。

1. Worker を削除し、新しいアップロードを止める。
2. その PR 専用の R2 バケットから領収書を削除する。
3. Terraform で専用の D1 と R2 バケットを削除する。

削除処理は信頼済みのデフォルトブランチから実行する。`pull_request_target` はこの後片付けにだけ使用し、PR 側のコードを実行しない。空の Terraform state と GitHub のデプロイ履歴は残る。恒久環境には削除防止設定を設け、プレビュー用の Terraform と削除スクリプトは `dev`・`stg`・`prd` を受け付けない。

この workflow の導入前から開いている PR は、次の更新または再オープン時にプレビューを作成する。

## 再試行と障害時の対応

同じ環境へのデプロイ・削除は直列に処理し、実行中の処理を新しい更新で中断しない。dev の古いコミット、更新済み・クローズ済み PR の古い実行は、変更を加える前に停止する。

| 処理                                                            | 再試行の方針（初回を含む）                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| デプロイ時の Terraform 初期化、D1 マイグレーション、Worker 配信 | 最大3回。待ち時間を増やしながら再試行する                                                               |
| インフラの plan/apply                                           | 最大3回。途中まで反映された状態を読み直し、毎回新しい plan を作る                                       |
| 疎通確認                                                        | HTTP エラー・接続エラーを待って再試行する                                                               |
| cleanup の Cloudflare API 呼び出し                              | 通信失敗・429・一時的なサーバーエラー等で最大8回。`curl` が `Retry-After` と待ち時間の増加を扱う。API ごとの再試行時間は最大5分、1回の通信は最大30秒           |
| cleanup 全体                                                    | 最大5回。削除済みリソースは成功扱いとし、残ったものだけ削除する。ジョブ全体の上限は60分                 |
| Discord 通知                                                    | 通信失敗・429・サーバーエラーで最大3回。送信できなくても認証処理は止めず、Worker のログに失敗を記録する |

デプロイと cleanup 全体の再試行は workflow 内のシェルで行い、待ち時間にばらつきを加える。API 呼び出しには `curl` の再試行機能を使う。Terraform は保存した plan を適用するが、失敗後の再試行では同じ古い plan を使い回さない。D1 は適用済み SQL を追跡するため、再実行しても同じマイグレーションを重ねて適用しない。Discord は応答が失われた場合に通知が重複する可能性がある。

上限まで失敗した場合は workflow を失敗状態で残す。原因を解消した後、GitHub Actions の **Re-run failed jobs** から再開できる。特に cleanup が失敗した場合は、専用リソースが残っていないか確認する。恒久環境のデータを削除して復旧しようとしない。

## Workflows と設定

| Workflow             | 役割                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`             | 型チェック・lint・ビルド、デプロイ/メール/削除/再試行のテスト、D1 の繰り返し適用、Worker bundle、Terraform、LLM のオフライン検証 |
| `terraform-plan.yml` | インフラ変更を含む信頼済み PR で恒久3環境を plan し、tfcmt が環境ごとのコメントを更新                                            |
| `deploy.yml`         | 恒久環境を検証・構築・デプロイし、API と Web の応答を確認                                                                        |
| `pr-preview.yml`     | PR のプレビュー作成・更新と、クローズ時の削除                                                                                    |

| 設定先     | 種類     | 名前                                                    | 用途                                        |
| ---------- | -------- | ------------------------------------------------------- | ------------------------------------------- |
| リポジトリ | Secret   | `CLOUDFLARE_API_TOKEN`                                  | Cloudflare のリソース操作と Worker 配信     |
| リポジトリ | Secret   | `TF_STATE_ACCESS_KEY_ID` / `TF_STATE_SECRET_ACCESS_KEY` | R2 上の state とロックへのアクセス          |
| リポジトリ | Secret   | `PREVIEW_AUTH_SECRET`                                   | PR ごとの認証シークレットを生成する元の鍵   |
| リポジトリ | Secret   | `DEBUG_EMAIL_DISCORD_WEBHOOK`                           | dev・stg・PR のテストメール通知             |
| 各恒久環境 | Secret   | `BETTER_AUTH_SECRET`                                    | 環境固有の認証用の鍵                        |
| 各恒久環境 | Variable | `APP_ORIGIN`                                            | 末尾の `/` を含まない HTTPS のオリジン      |
| 各恒久環境 | Variable | `EMAIL_MODE`                                            | 現在は dev/stg が `log`、prd が `disabled`  |
| 各恒久環境 | Variable | `EMAIL_FROM_ADDRESS`                                    | `cloudflare` モードで使用する検証済み送信元 |

Worker の Secrets は `--secrets-file` で渡し、一時ファイルをジョブ終了時に削除する。Terraform state には含めない。認証用の鍵を変更すると既存のセッションやトークンに影響するため、理由なく再生成しない。

## デプロイの順序と管理範囲

Terraform は D1・非公開 R2 を管理し、Wrangler は Worker のコード・静的ファイル・bindings・ルート・アプリの Secrets を管理する。state の分割とリソース名は[インフラ構成](../infra/README.md)にまとめる。

各デプロイでは CI、ビルド、Terraform plan/apply、設定生成、Worker bundle の検証、D1 の未適用マイグレーション、配信、疎通確認の順に進む。`scripts/deployment-config.mjs` は Terraform の出力を使って設定を生成し、環境・アカウント・URL・メール方式の不整合を拒否する。

適用済みの SQL は変更せず、新しい変更は別のマイグレーションとして追加する。移行は新しい Worker の配信より先に行うため、稼働中のコードとの互換性にも注意する。疎通確認に失敗しても、コード・DB・インフラを自動で巻き戻すことはない。
