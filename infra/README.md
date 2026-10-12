# Cloudflare infrastructure

The infrastructure targets Cloudflare account `0350bf22d3fd4ab2fd9283c6ce8b91dd`. CI uses Terraform **1.14.9**; both roots pin the Cloudflare provider to **5.27.0** and commit their dependency lockfiles.

## Resource ownership

- `bootstrap/` manages the existing private R2 state bucket, `accounting-app-terraform-state`. The bucket has been imported into local Terraform state at `infra/bootstrap/terraform.tfstate`; that file is gitignored and remains local, separate from the environment state in R2.
- `cloudflare/` manages one D1 database and one private R2 receipt bucket per environment. D1 and R2 use the `apac` creation hint; R2 uses the `Standard` storage class.
- Wrangler manages Worker code, static assets, bindings, custom-domain routes, and application secrets. Terraform supplies the resource identifiers used by Wrangler.

All Terraform-managed databases and buckets have `prevent_destroy = true`.

| Environment | Worker               | D1 database             | R2 bucket               | State key                              |
| ----------- | -------------------- | ----------------------- | ----------------------- | -------------------------------------- |
| `dev`       | `accounting-app-dev` | `accounting-app-dev-d1` | `accounting-app-dev-r2` | `accounting-app/dev/terraform.tfstate` |
| `stg`       | `accounting-app-stg` | `accounting-app-stg-d1` | `accounting-app-stg-r2` | `accounting-app/stg/terraform.tfstate` |
| `prd`       | `accounting-app-prd` | `accounting-app-prd-d1` | `accounting-app-prd-r2` | `accounting-app/prd/terraform.tfstate` |

## State and CI

The environment root uses Terraform's S3 backend with bucket `accounting-app-terraform-state` and endpoint `https://0350bf22d3fd4ab2fd9283c6ce8b91dd.r2.cloudflarestorage.com`. Its configuration sets `region = "auto"`, enables path-style access, and skips AWS-specific credential, metadata, region, account-ID, and checksum checks for R2 compatibility.

`use_lockfile = true` stores a `.tflock` object beside each environment's state. Both deployment and PR plans use these state keys and a five-minute lock timeout. GitHub Actions also serializes deployments per environment.

Infrastructure PRs from repository branches, excluding Dependabot, plan all three environments and update a separate tfcmt comment for each. PR plans do not apply changes or save plan files. The bootstrap root remains outside the remote plan/apply workflow; CI validates its configuration locally. See [deployment configuration](../docs/deployment.md) for workflow triggers and credentials.

## Terraform-to-Wrangler output

The `deployment` output is an object with six string fields: `account_id`, `environment`, `worker_name`, `database_id`, `database_name`, and `bucket_name`. The database ID comes from the managed D1 resource.

`scripts/deployment-config.mjs` consumes these names and identifiers verbatim, checks the environment against `TF_VAR_environment` and the account against the base Wrangler config, then generates `apps/server/wrangler.generated.json`. The committed deployment fixture is used only for bundle validation.

CI checks Terraform formatting and validation and runs mocked tests for the output contract, environment isolation, and invalid environment rejection.
