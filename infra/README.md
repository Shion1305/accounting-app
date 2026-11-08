# Cloudflare インフラ構成

Cloudflare アカウント `0350bf22d3fd4ab2fd9283c6ce8b91dd`（University Accountant Project）を使用する。CI の Terraform は **1.14.9**、Cloudflare provider は **5.27.0** に固定し、各ルートの依存関係を `.terraform.lock.hcl` で管理する。

## 管理単位

| ディレクトリ  | 管理するもの                                                    | 削除方針                 |
| ------------- | --------------------------------------------------------------- | ------------------------ |
| `bootstrap/`  | state 保存用の既存 R2 バケット `accounting-app-terraform-state` | `prevent_destroy` で保護 |
| `cloudflare/` | dev・stg・prd の D1 と非公開の領収書用 R2                       | `prevent_destroy` で保護 |
| `preview/`    | PR ごとの D1 と非公開の領収書用 R2                              | PR を閉じると削除        |

Worker のコード・静的ファイル・bindings・ルート・アプリの Secrets は Wrangler で反映する。Terraform は、その設定生成に必要なリソース名と ID を出力する。D1 と R2 の作成先ヒントは `apac`、R2 のストレージクラスは `Standard`。

`bootstrap/` の state はローカル・gitignore 対象で、アプリ用のリモート state とは分けている。新しい checkout には含まれないため、既存 state を引き継ぐか既存バケットを import してから適用する。すでに存在する state バケットを作り直さない。

## リソース名と state

| 環境        | Worker                 | D1                        | 領収書用 R2               | state のキー                             |
| ----------- | ---------------------- | ------------------------- | ------------------------- | ---------------------------------------- |
| dev         | `accounting-app-dev`   | `accounting-app-dev-d1`   | `accounting-app-dev-r2`   | `accounting-app/dev/terraform.tfstate`   |
| stg         | `accounting-app-stg`   | `accounting-app-stg-d1`   | `accounting-app-stg-r2`   | `accounting-app/stg/terraform.tfstate`   |
| prd         | `accounting-app-prd`   | `accounting-app-prd-d1`   | `accounting-app-prd-r2`   | `accounting-app/prd/terraform.tfstate`   |
| PR #17 の例 | `accounting-app-pr-17` | `accounting-app-pr-17-d1` | `accounting-app-pr-17-r2` | `accounting-app/pr-17/terraform.tfstate` |

アプリ用 state は非公開バケット `accounting-app-terraform-state` に保存する。S3 互換エンドポイントは `https://0350bf22d3fd4ab2fd9283c6ce8b91dd.r2.cloudflarestorage.com`。`terraform init` 時に環境固有のキーを指定し、別環境の state を共有しない。

backend は `region = "auto"`、パス形式のアクセス、R2 に適した AWS 固有チェックの無効化を設定する。認証情報は `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` から渡す。

`use_lockfile = true` により、state の隣に `.tflock` を作成する。plan/apply は最大5分間ロックを待ち、GitHub Actions も環境ごとに処理を直列化する。通常の実行でロックを無効化しない。

## Terraform と Wrangler の接続

`deployment` 出力は、次の6項目を持つオブジェクト。

- `account_id`、`environment`
- `worker_name`
- `database_id`、`database_name`
- `bucket_name`

`scripts/deployment-config.mjs` がこの出力と GitHub Environment の設定を検証し、`apps/server/wrangler.generated.json` を生成する。実環境の D1 ID は Terraform の出力を使い、ローカル開発用 `wrangler.jsonc` に転記しない。`scripts/fixtures/deployment.json` は CI の bundle 検証専用である。

アプリの Secrets と PR ごとの認証シークレットは Terraform の管理外とし、state に保存しない。設定項目やメール通知方式は[デプロイと環境運用](../docs/deployment.md)を参照。

## PR プレビューの削除

`preview/` は `pr-` と正の整数を組み合わせた環境名だけを受け付ける。恒久環境の名前を渡すと plan の段階で失敗する。

クローズ時は Worker を削除して新しいアップロードを止め、専用バケット内のオブジェクトを削除してから、保存した destroy plan を適用する。通信障害や途中まで削除できた場合の再試行では、現在の状態を読み直して plan を作り直す。削除済みリソースへの再実行も可能。

削除に成功しても、空の state は履歴として残す。具体的な再試行回数と失敗時の再開方法は[デプロイと環境運用](../docs/deployment.md#再試行と障害時の対応)に記載する。

## 検証

CI で整形、3ルートの `validate`、モックを使った環境分離・出力・不正な環境名のテストを実行する。インフラ変更を含む信頼済み PR は、恒久3環境のリモート state に対する plan も実行し、環境ごとの結果をコメントする。PR で確認した plan はそのまま適用せず、デプロイ時に最新の plan を生成する。
