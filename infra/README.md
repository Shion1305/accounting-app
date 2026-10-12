# Cloudflare infrastructure

Use Terraform 1.14.9 (the CI version). Both roots pin Cloudflare provider 5.27.0 and commit its dependency lockfile.

- `bootstrap/` owns the private R2 bucket `accounting-app-terraform-state`. It uses local state because the remote backend does not exist before bootstrap.
- `cloudflare/` owns one environment's D1 database and private R2 bucket. Initialize it with a separate state key for each environment.
- Wrangler owns the Worker code, static assets, bindings, and secrets. Terraform exports resource identifiers for Wrangler and does not manage the Worker itself.

| Environment | Worker               | D1 database             | R2 bucket               | State key                              |
| ----------- | -------------------- | ----------------------- | ----------------------- | -------------------------------------- |
| `dev`       | `accounting-app-dev` | `accounting-app-dev-d1` | `accounting-app-dev-r2` | `accounting-app/dev/terraform.tfstate` |
| `stg`       | `accounting-app-stg` | `accounting-app-stg-d1` | `accounting-app-stg-r2` | `accounting-app/stg/terraform.tfstate` |
| `prd`       | `accounting-app-prd` | `accounting-app-prd-d1` | `accounting-app-prd-r2` | `accounting-app/prd/terraform.tfstate` |

The configured Cloudflare account is `0350bf22d3fd4ab2fd9283c6ce8b91dd`. The `apac` location values are creation hints, not data residency guarantees.

## Bootstrap

1. Enable R2 for the account if it has not been enabled.
2. Supply `CLOUDFLARE_API_TOKEN` through the environment. Bootstrap needs account-scoped **Workers R2 Storage: Edit** permission. Application infrastructure also needs **D1: Edit** permission.
3. Review and apply the bootstrap plan:

   ```sh
   terraform -chdir=infra/bootstrap init -input=false -lockfile=readonly
   terraform -chdir=infra/bootstrap plan -out=bootstrap.tfplan
   terraform -chdir=infra/bootstrap apply bootstrap.tfplan
   ```

4. Preserve `infra/bootstrap/terraform.tfstate` in a private backup. Never commit state or saved plans. Do not delete the state bucket after application environments have been initialized.
5. Create R2 S3 credentials with **Object Read & Write** permission restricted to `accounting-app-terraform-state`. Supply them as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` to Terraform. These credentials are distinct from `CLOUDFLARE_API_TOKEN`.

If the bucket already exists, import it before planning instead of creating another owner for it:

```sh
terraform -chdir=infra/bootstrap import cloudflare_r2_bucket.terraform_state \
  '0350bf22d3fd4ab2fd9283c6ce8b91dd/accounting-app-terraform-state/default'
```

## Environment state

CI supplies only the environment and its state key. For manual operations, use a separate Terraform data directory as well so switching environments cannot reuse another environment's initialized backend:

```sh
export TF_VAR_environment=dev
export TF_DATA_DIR="$PWD/infra/cloudflare/.terraform-data-${TF_VAR_environment}"
terraform -chdir=infra/cloudflare init -input=false -lockfile=readonly \
  -backend-config="key=accounting-app/${TF_VAR_environment}/terraform.tfstate"
terraform -chdir=infra/cloudflare plan -lock-timeout=5m -out=deploy.tfplan
terraform -chdir=infra/cloudflare apply -lock-timeout=5m deploy.tfplan
terraform -chdir=infra/cloudflare output -json deployment
```

Replace `dev` with `stg` or `prd` for the other environments. Never reuse a state key for a different environment. Changing accounts requires changing the backend endpoint and account input together, bootstrapping that account's state bucket, and deliberately selecting new state.

The S3 backend enables `use_lockfile`, which creates a `.tflock` object next to the state. HashiCorp's S3 backend uses conditional object creation, and R2 documents support for the required `PutObject` `If-None-Match` operation. GitHub Actions additionally serializes deployments per environment. The lock mechanism has not been exercised against this account until the first authenticated deployment; never use `-lock=false` to bypass a failure. R2's unsupported S3 **Object Lock** retention feature is separate from Terraform's lockfile mechanism. See the [S3 backend locking documentation](https://developer.hashicorp.com/terraform/language/backend/s3#state-locking), [R2 S3 compatibility table](https://developers.cloudflare.com/r2/api/s3/api/), and [Cloudflare backend configuration](https://developers.cloudflare.com/terraform/advanced-topics/remote-backend/).

D1, application R2, and the state bucket have `prevent_destroy = true`. Terraform rejects plans that replace or delete these resources while that lifecycle rule remains in configuration. It cannot protect resources from direct dashboard/API deletion or from removing their resource blocks. Keep private state backups before manual maintenance; `prevent_destroy` is not a data backup.

For an existing application resource with the expected name, initialize the correct environment backend and import it before the first plan:

```sh
terraform -chdir=infra/cloudflare import cloudflare_d1_database.app \
  '0350bf22d3fd4ab2fd9283c6ce8b91dd/<database-id>'
terraform -chdir=infra/cloudflare import cloudflare_r2_bucket.app \
  '0350bf22d3fd4ab2fd9283c6ce8b91dd/accounting-app-dev-r2/default'
```

Use the matching environment's bucket and retain `TF_VAR_environment` and `TF_DATA_DIR` from initialization. Do not import an existing database into more than one environment.

## Deployment output contract

`terraform -chdir=infra/cloudflare output -json deployment` returns the following direct object. Every field is a string; the UUID below is illustrative.

```json
{
  "account_id": "0350bf22d3fd4ab2fd9283c6ce8b91dd",
  "environment": "dev",
  "worker_name": "accounting-app-dev",
  "database_id": "12345678-1234-1234-1234-123456789abc",
  "database_name": "accounting-app-dev-d1",
  "bucket_name": "accounting-app-dev-r2"
}
```

`database_id` comes from the managed D1 resource. `scripts/deployment-config.mjs` uses this output's resource names and identifiers verbatim instead of duplicating Terraform's naming rules. It checks the output's `environment` against `TF_VAR_environment` and its `account_id` against the base Wrangler config before writing the deployment config. No credentials or application secrets are stored in this output.

The non-secret `scripts/fixtures/deployment.json` is only for CI and local bundle validation. Actual deployments generate a fresh output from the selected environment's Terraform state.

## Local validation

These checks install the pinned provider and use mocks without requiring Cloudflare or R2 credentials or touching remote resources:

```sh
terraform fmt -check -recursive infra
terraform -chdir=infra/bootstrap init -backend=false -input=false -lockfile=readonly
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/cloudflare init -backend=false -input=false -lockfile=readonly
terraform -chdir=infra/cloudflare validate
terraform -chdir=infra/cloudflare test
```

The native tests verify the Wrangler output contract, environment isolation, and rejection of unknown environments.
